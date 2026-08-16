/**
 * Hash Wallet price aggregator.
 *
 * One Cloudflare Worker that:
 *  - Fetches USD spot prices from Kraken for majors (BTC/XMR/LTC/DOGE/ETH/BCH/XNO).
 *  - Fetches WOW from NonKYC (Wownero is too small for major CEX listings).
 *  - Caches results in KV every 60s via cron, then serves from KV on request.
 *
 * Endpoints:
 *  - GET /v2/rates?base=BTC&quote=USD  → { "results": { "BTC_USD": 67342.5 } }
 *      (Drop-in shape compatible with the wallet's existing fiat_conversion_service.dart.)
 *  - GET /v1/prices                    → { "rates": { ... }, "fetched_at": "..." }
 *      (Preferred future shape — single call returns everything.)
 *
 * USD only. The wallet's other fiat currencies will see price=0 and degrade
 * gracefully via existing fallback logic.
 */

export interface Env {
  PRICES: KVNamespace;
}

const KV_KEY = "rates:v1";
const KV_TTL_SECONDS = 600; // soft expiry; cron writes fresh values every 60s

// Sparkline history — one append per UTC hour, capped to a week per coin.
const HISTORY_MAX_POINTS = 168;

// Trade status cache lifetime. Trocador deletes trade data after 14 days
// (per their API docs), so anything longer is wasted KV.
const TRADE_TTL_SECONDS = 60 * 60 * 24 * 14;

/**
 * Map of wallet-side ticker → Kraken pair name (USD quote).
 * Kraken uses some legacy "X"/"Z" prefixes for older assets; the public Ticker
 * endpoint normalizes these in the response, but we send the modern names.
 */
const KRAKEN_PAIRS: Record<string, string> = {
  BTC: "XBTUSD",
  XMR: "XMRUSD",
  LTC: "LTCUSD",
  DOGE: "XDGUSD",
  ETH: "ETHUSD",
  BCH: "BCHUSD",
  XNO: "NANOUSD",
};

/**
 * Tickers we look up on Nonlogs and cexswap.cc.
 * Wownero is the obvious one (delisted from major CEXes); add others here if
 * they're not on Kraken either.
 */
const NICHE_TICKERS = ["WOW"] as const;

interface RatesPayload {
  rates: Record<string, number>;
  sources: Record<string, string>;
  fetched_at: string;
  /** USD -> fiat multipliers from the ECB daily reference rates, so
   *  COIN_EUR = COIN_USD * fiat.EUR. Absent on payloads cached before the
   *  forex feature shipped; /v2/rates then falls back to USD-only. */
  fiat?: Record<string, number>;
}

/**
 * ECB daily reference rates (keyless XML, EUR-based). Converted to USD-based
 * multipliers: usd_to_X = (X per EUR) / (USD per EUR); EUR itself is
 * 1 / (USD per EUR). Updated by the ECB each business day around 16:00 CET —
 * more than fresh enough for wallet display prices.
 */
async function fetchEcbFiat(): Promise<Record<string, number>> {
  const res = await fetch(
    "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
    { cf: { cacheTtl: 3600, cacheEverything: true } },
  );
  if (!res.ok) throw new Error(`ecb http ${res.status}`);
  const xml = await res.text();
  const perEur: Record<string, number> = {};
  for (const m of xml.matchAll(/currency='([A-Z]{3})'\s+rate='([\d.]+)'/g)) {
    const rate = parseFloat(m[2]);
    if (rate > 0) perEur[m[1]] = rate;
  }
  const usdPerEur = perEur["USD"];
  if (!usdPerEur) throw new Error("ecb: no USD rate in feed");
  const out: Record<string, number> = { USD: 1, EUR: 1 / usdPerEur };
  for (const [cur, rate] of Object.entries(perEur)) {
    if (cur !== "USD") out[cur] = rate / usdPerEur;
  }
  return out;
}

async function fetchKraken(): Promise<Record<string, number>> {
  const pairs = Object.values(KRAKEN_PAIRS).join(",");
  const url = `https://api.kraken.com/0/public/Ticker?pair=${pairs}`;
  const res = await fetch(url, { cf: { cacheTtl: 30, cacheEverything: true } });
  if (!res.ok) throw new Error(`kraken http ${res.status}`);
  const body = (await res.json()) as { error: string[]; result: Record<string, { c: string[] }> };
  if (body.error?.length) throw new Error(`kraken err ${body.error.join(",")}`);

  // Kraken's response keys can include legacy X/Z prefixes (e.g. "XXBTZUSD" for "XBTUSD").
  // Match by suffix instead of exact key.
  const out: Record<string, number> = {};
  for (const [ticker, pair] of Object.entries(KRAKEN_PAIRS)) {
    const matchKey = Object.keys(body.result).find((k) => k.endsWith(pair) || k.endsWith(pair.replace("USD", "ZUSD")));
    if (!matchKey) continue;
    const last = body.result[matchKey]?.c?.[0];
    if (last) out[ticker] = parseFloat(last);
  }
  return out;
}

/**
 * Pull all markets from Nonlogs in one call. Returns per-ticker USD price
 * by averaging the (TICKER-BTC × BTC/USD) and (TICKER-USDT) routes when both
 * exist. Algorithm taken from ~/src/smirk-backend/src/infra/prices.rs.
 */
async function fetchNonlogs(btcUsd: number): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (btcUsd <= 0) return out;

  const res = await fetch("https://api.nonlogs.io/api/markets", {
    headers: { "user-agent": "hash-wallet-prices/0.1" },
    cf: { cacheTtl: 30, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`nonlogs http ${res.status}`);
  const body = (await res.json()) as { markets?: Record<string, { last_price?: string }> };
  const markets = body.markets ?? {};

  for (const ticker of NICHE_TICKERS) {
    const sources: number[] = [];
    const btcPair = markets[`${ticker}-BTC`]?.last_price;
    if (btcPair) {
      const p = parseFloat(btcPair);
      if (p > 0) sources.push(p * btcUsd);
    }
    const usdtPair = markets[`${ticker}-USDT`]?.last_price;
    if (usdtPair) {
      const p = parseFloat(usdtPair);
      if (p > 0) sources.push(p);
    }
    if (sources.length) {
      out[ticker] = sources.reduce((a, b) => a + b, 0) / sources.length;
    }
  }
  return out;
}

/**
 * Pull all spot markets from cexswap.cc. Endpoint already returns `last_usd`
 * per pair so no BTC conversion is needed. Prices are volume-weighted across
 * the base ticker's pairs by 7-day USD volume, and pairs with no 7-day volume
 * are ignored entirely — a stale `last` print on a dead pair (WOW-ETH's
 * ancient $0.000087, for example) must never drag the average. If every pair
 * is dead the ticker is simply omitted and the Nonlogs sample stands alone.
 */
async function fetchCexswap(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const res = await fetch("https://cexswap.cc/api/public/markets/summary", {
    headers: { accept: "application/json" },
    cf: { cacheTtl: 30, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`cexswap http ${res.status}`);
  type CexswapRow = { base?: string; last_usd?: number | string; volume7d_usd?: number | string };
  const body = (await res.json()) as { items?: CexswapRow[] } | CexswapRow[];
  const items = Array.isArray(body) ? body : (body.items ?? []);

  const num = (v: number | string | undefined): number =>
    typeof v === "string" ? parseFloat(v) : (v ?? 0);

  const buckets: Record<string, Array<{ usd: number; weight: number }>> = {};
  for (const m of items) {
    const base = (m.base ?? "").toUpperCase();
    if (!NICHE_TICKERS.includes(base as (typeof NICHE_TICKERS)[number])) continue;
    const usd = num(m.last_usd);
    const weight = num(m.volume7d_usd);
    if (usd > 0 && weight > 0) {
      (buckets[base] ??= []).push({ usd, weight });
    }
  }
  for (const [ticker, samples] of Object.entries(buckets)) {
    const totalWeight = samples.reduce((a, s) => a + s.weight, 0);
    out[ticker] = samples.reduce((a, s) => a + s.usd * s.weight, 0) / totalWeight;
  }
  return out;
}

async function refreshPrices(env: Env): Promise<RatesPayload> {
  // Kraken first — its BTC/USD is needed by the Nonlogs WOW conversion.
  const kraken = await fetchKraken().catch((e) => {
    console.error("kraken failed", e);
    return {} as Record<string, number>;
  });

  const btcUsd = kraken.BTC ?? 0;

  const [nonlogs, cexswap] = await Promise.all([
    fetchNonlogs(btcUsd).catch((e) => {
      console.error("nonlogs failed", e);
      return {} as Record<string, number>;
    }),
    fetchCexswap().catch((e) => {
      console.error("cexswap failed", e);
      return {} as Record<string, number>;
    }),
  ]);

  const rates: Record<string, number> = { ...kraken };
  const sources: Record<string, string> = {};
  for (const k of Object.keys(kraken)) sources[k] = "kraken";

  // For niche coins, average across whichever sources returned a price.
  for (const ticker of NICHE_TICKERS) {
    const samples: Array<[string, number]> = [];
    if (nonlogs[ticker]) samples.push(["nonlogs", nonlogs[ticker]]);
    if (cexswap[ticker]) samples.push(["cexswap", cexswap[ticker]]);
    if (samples.length === 0) continue;
    rates[ticker] = samples.reduce((a, [, p]) => a + p, 0) / samples.length;
    sources[ticker] = samples.map(([s]) => s).join("+");
  }

  // Stables — we don't quote them upstream, just pin to 1.0.
  for (const stable of ["USDT", "USDC", "DAI"]) {
    rates[stable] = 1.0;
    sources[stable] = "pinned";
  }

  // Fiat multipliers for non-USD display. A feed failure degrades to
  // USD-only (the pre-forex behavior), never to a stale-wrong number: the
  // wallet shows "price unavailable" for missing quotes.
  let fiat: Record<string, number> | undefined;
  try {
    fiat = await fetchEcbFiat();
    sources["_fiat"] = "ecb";
  } catch (e) {
    console.error("ecb fiat failed", e);
  }

  const payload: RatesPayload = {
    rates,
    sources,
    fetched_at: new Date().toISOString(),
    ...(fiat ? { fiat } : {}),
  };

  await env.PRICES.put(KV_KEY, JSON.stringify(payload), { expirationTtl: KV_TTL_SECONDS });
  await appendHistory(env, rates);
  return payload;
}

/**
 * Append the latest price to per-coin history KV — but only once per UTC hour.
 * The cron fires every minute; we coalesce so each coin gets ~24 entries/day,
 * staying well under KV value-size limits and giving a clean sparkline.
 */
async function appendHistory(env: Env, rates: Record<string, number>): Promise<void> {
  const now = Date.now();
  const currentHour = Math.floor(now / 3_600_000);
  for (const [coin, price] of Object.entries(rates)) {
    if (!Number.isFinite(price) || price <= 0) continue;
    const key = `history:hourly:${coin}`;
    const existing = ((await env.PRICES.get(key, "json")) ?? []) as Array<[number, number]>;
    const lastEntry = existing[existing.length - 1];
    const lastHour = lastEntry ? Math.floor(lastEntry[0] / 3_600_000) : -1;
    if (lastHour >= currentHour) continue;
    existing.push([now, price]);
    while (existing.length > HISTORY_MAX_POINTS) existing.shift();
    await env.PRICES.put(key, JSON.stringify(existing));
  }
}

async function loadRates(env: Env): Promise<RatesPayload> {
  const cached = await env.PRICES.get(KV_KEY, "json");
  if (cached) return cached as RatesPayload;
  // Cold start / KV miss — fall back to a live fetch so the first user request
  // after deploy doesn't return empty data.
  return refreshPrices(env);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // Edge-cache for 30s so a thundering herd of identical requests gets coalesced.
      "cache-control": "public, max-age=30",
      "access-control-allow-origin": "*",
    },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/v1/prices") {
      const payload = await loadRates(env);
      return jsonResponse(payload);
    }

    if (url.pathname === "/v2/rates") {
      // Drop-in compatibility with Cake Wallet's API shape so the wallet client
      // change is minimal. Wallet sends ?base=BTC&quote=USD, expects
      // { "results": { "<KEY>": <price as number> } }.
      const base = (url.searchParams.get("base") ?? "").toUpperCase();
      const quote = (url.searchParams.get("quote") ?? "").toUpperCase();
      if (!base) return jsonResponse({ results: {} }, 400);

      const payload = await loadRates(env);
      const usdPrice = payload.rates[base] ?? 0;
      // Non-USD quotes convert through the ECB fiat table. Unknown quote
      // currency, or a payload without fiat data, returns 0 — the wallet
      // treats that as "price unavailable" and shows a placeholder.
      let price = 0;
      if (quote === "USD") {
        price = usdPrice;
      } else if (payload.fiat && payload.fiat[quote]) {
        price = usdPrice * payload.fiat[quote];
      }
      return jsonResponse({ results: { [`${base}_${quote}`]: price } });
    }

    // Sparkline / history. ?coin=BTC&hours=24 returns hourly points for the
    // last N hours (capped at HISTORY_MAX_POINTS = 168 = 7 days).
    if (url.pathname === "/v1/sparkline") {
      const coin = (url.searchParams.get("coin") ?? "").toUpperCase();
      const hours = Math.min(
        Math.max(parseInt(url.searchParams.get("hours") ?? "24", 10) || 24, 1),
        HISTORY_MAX_POINTS,
      );
      if (!coin) return jsonResponse({ error: "missing coin" }, 400);
      const all = ((await env.PRICES.get(`history:hourly:${coin}`, "json")) ?? []) as Array<
        [number, number]
      >;
      const cutoff = Date.now() - hours * 3_600_000;
      const points = all.filter(([t]) => t >= cutoff);
      return jsonResponse({ coin, hours, points });
    }

    // Trocador webhook receiver. They POST the full trade body on every status
    // change; we stash it under trade:<id> for the wallet to read.
    if (url.pathname === "/v1/trocador-webhook" && req.method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return jsonResponse({ error: "bad json" }, 400);
      }
      const tradeId = (body.trade_id ?? body.id) as string | undefined;
      if (!tradeId) return jsonResponse({ error: "missing trade_id" }, 400);
      const stored = { ...body, received_at: new Date().toISOString() };
      await env.PRICES.put(`trade:${tradeId}`, JSON.stringify(stored), {
        expirationTtl: TRADE_TTL_SECONDS,
      });
      return jsonResponse({ ok: true, trade_id: tradeId });
    }

    // Read cached trade status. Wallet polls this instead of Trocador directly,
    // letting us aggregate webhook updates across multiple devices and reduce
    // load on Trocador per their request.
    const tradeMatch = url.pathname.match(/^\/v1\/trade\/(.+)$/);
    if (tradeMatch && req.method === "GET") {
      const cached = await env.PRICES.get(`trade:${tradeMatch[1]}`, "json");
      if (cached) return jsonResponse(cached);
      return jsonResponse({ error: "not found" }, 404);
    }

    if (url.pathname === "/" || url.pathname === "/healthz") {
      const payload = await loadRates(env);
      return jsonResponse({
        ok: true,
        coins: Object.keys(payload.rates).length,
        fetched_at: payload.fetched_at,
      });
    }

    return jsonResponse({ error: "not found" }, 404);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(refreshPrices(env).then(
      (p) => console.log(`refreshed ${Object.keys(p.rates).length} coins`),
      (e) => console.error("refresh failed", e),
    ));
  },
};
