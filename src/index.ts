/**
 * Hash Wallet price aggregator.
 *
 * One Cloudflare Worker that:
 *  - Fetches USD spot prices from Kraken for majors (BTC/XMR/LTC/DOGE/ETH/BCH/XNO).
 *  - Fetches WOW from cexswap.cc and GRIN from Gate.io (too small for major
 *    CEX listings). A last print needs volume behind it and expires, because a
 *    trade nobody has made recently is not a price. Nonlogs was a WOW source
 *    until 2026-10-19; NICHE_TICKERS says why it is not one now. This feed is
 *    what Hash Bags, Smirk and wowlet display.
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
 * Map of wallet-side ticker → Gate.io spot pair. Gate.io carries coins that
 * never made it onto Kraken but still have a real two-sided book. GRIN is the
 * current case: Gate lists only GRIN_USDT, so a BTC cross has to be derived
 * downstream from USD rather than quoted here.
 */
const GATEIO_PAIRS: Record<string, string> = {
  GRIN: "GRIN_USDT",
};

/**
 * Tickers we look up on cexswap.cc.
 * Wownero is the obvious one (delisted from major CEXes); add others here if
 * they're not on Kraken either.
 *
 * Nonlogs was the other half of this blend until 2026-10-19 and is no longer
 * read. Its BTC, USDT, GRIN and XMR withdrawals had stopped completing for over
 * a week and its operator had stopped answering, so its books priced balances
 * that could not leave the venue. WOW, the one coin that still withdrew, traded
 * there at two to three times its price elsewhere, and as half the blend it
 * marked WOW at $0.0105 against about $0.0087 on every other venue. Bringing it
 * back is a decision to make on evidence, not a switch left in the code.
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

/**
 * A cexswap `last` print older than this is not evidence of the current price.
 * Its summary carries no book, only the last trade, so staleness is the only
 * guard available on that source.
 */
const MAX_LAST_TRADE_AGE_HOURS = 12;

/**
 * 7d USD volume a niche pool must clear before its last trade is evidence of a
 * price. Matches consensus_min_venue_vol_usd on the desk, which exists because
 * a $24/day pool once carried 86% of a consensus.
 */
const MIN_NICHE_VOL_USD = 25;

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
 * Pull all spot markets from cexswap.cc. Endpoint already returns `last_usd`
 * per pair so no BTC conversion is needed. Prices are volume-weighted across
 * the base ticker's pairs by 7-day USD volume, and pairs with no 7-day volume
 * are ignored entirely — a stale `last` print on a dead pair (WOW-ETH's
 * ancient $0.000087, for example) must never drag the average. If every pair
 * is dead the ticker is simply omitted, and consumers show the price as
 * unavailable rather than a wrong one.
 */
async function fetchCexswap(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const res = await fetch("https://cexswap.cc/api/public/markets/summary", {
    headers: { accept: "application/json" },
    cf: { cacheTtl: 30, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`cexswap http ${res.status}`);
  type CexswapRow = {
    base?: string;
    last_usd?: number | string;
    volume7d_usd?: number | string;
    last_trade_at_unix?: number | string;
  };
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
    // cexswap publishes no book, so the last trade is all we get and staleness
    // is the only guard we can apply. Seven days of volume can be a single old
    // fill, and on 2026-09-06 WOW-XMR's last print was the 24h LOW while the
    // pool itself had moved 13% above it. An old print is not evidence of the
    // current price, and for WOW this is now the only source, so it must expire.
    //
    // A volume floor as well, because "recent" and "meaningful" are different
    // questions. On 2026-09-17 WOW-XMR carried $1,064 of 7d volume and was
    // 18.2h old, so staleness dropped it; WOW-DOGE carried ONE CENT and was
    // 3.7h old, so it survived alone and priced WOW at $0.00041 while its real
    // book sat at $0.00805. A pool nobody trades is not a second opinion. Same
    // reasoning, and the same number, as the desk's consensus_min_venue_vol_usd.
    const tradedAt = num(m.last_trade_at_unix as string | undefined);
    const ageHours = tradedAt > 0 ? (Date.now() / 1000 - tradedAt) / 3600 : Infinity;
    if (usd > 0 && weight >= MIN_NICHE_VOL_USD
        && ageHours <= MAX_LAST_TRADE_AGE_HOURS) {
      (buckets[base] ??= []).push({ usd, weight });
    }
  }
  for (const [ticker, samples] of Object.entries(buckets)) {
    const totalWeight = samples.reduce((a, s) => a + s.weight, 0);
    out[ticker] = samples.reduce((a, s) => a + s.usd * s.weight, 0) / totalWeight;
  }
  return out;
}

async function fetchGateio(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const settled = await Promise.allSettled(
    Object.entries(GATEIO_PAIRS).map(async ([ticker, pair]) => {
      const res = await fetch(
        `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${pair}`,
        { headers: { accept: "application/json" }, cf: { cacheTtl: 30, cacheEverything: true } },
      );
      if (!res.ok) throw new Error(`gateio http ${res.status} for ${pair}`);
      const rows = (await res.json()) as Array<{
        last?: string;
        highest_bid?: string;
        lowest_ask?: string;
      }>;
      const row = rows?.[0];
      if (!row) throw new Error(`gateio empty ticker for ${pair}`);
      const last = parseFloat(row.last ?? "");
      const bid = parseFloat(row.highest_bid ?? "");
      const ask = parseFloat(row.lowest_ask ?? "");
      // Prefer the book mid. `last` is a print, and on a thin market it can sit
      // outside the current spread; bid and ask are live quotes, which is what
      // a fair value wants. Fall back to the print only if a side is missing.
      const mid = bid > 0 && ask > 0 && ask >= bid ? (bid + ask) / 2 : NaN;
      const px = Number.isFinite(mid) ? mid : last;
      if (!Number.isFinite(px) || px <= 0) {
        throw new Error(`gateio no usable price for ${pair}`);
      }
      return [ticker, px] as const;
    }),
  );
  for (const r of settled) {
    if (r.status === "fulfilled") out[r.value[0]] = r.value[1];
    else console.error("gateio pair failed", r.reason);
  }
  return out;
}

async function refreshPrices(env: Env): Promise<RatesPayload> {
  // No source depends on another's price any more (Kraken's BTC/USD only ever
  // converted the Nonlogs WOW-BTC route), so all of them are fetched at once.
  const [kraken, cexswap, gateio] = await Promise.all([
    fetchKraken().catch((e) => {
      console.error("kraken failed", e);
      return {} as Record<string, number>;
    }),
    fetchCexswap().catch((e) => {
      console.error("cexswap failed", e);
      return {} as Record<string, number>;
    }),
    fetchGateio().catch((e) => {
      console.error("gateio failed", e);
      return {} as Record<string, number>;
    }),
  ]);

  const rates: Record<string, number> = { ...kraken };
  const sources: Record<string, string> = {};
  for (const k of Object.keys(kraken)) sources[k] = "kraken";

  // Gate.io fills the gap between Kraken and the niche venues. Deliberately
  // NOT folded into NICHE_TICKERS: that path reads cexswap, a venue our own
  // desk quotes into, and an oracle that reads back our own quotes is exactly
  // the circularity the desk's divergence rail exists to catch. Kraken still
  // wins wherever it lists the coin.
  for (const [ticker, px] of Object.entries(gateio)) {
    if (rates[ticker]) continue;
    rates[ticker] = px;
    sources[ticker] = "gateio";
  }

  // Niche coins come from cexswap alone since Nonlogs was dropped (see
  // NICHE_TICKERS). With no qualifying pair the ticker is left out, so the
  // wallet shows the price as unavailable instead of a guess.
  for (const ticker of NICHE_TICKERS) {
    if (!cexswap[ticker]) continue;
    rates[ticker] = cexswap[ticker];
    sources[ticker] = "cexswap";
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

    // The oracle, described by the thing that implements it. A price feed that
    // cannot say how it arrived at a number is asking to be trusted rather than
    // checked, and this one gates real quoting decisions.
    if (url.pathname === "/v1/oracle") {
      const payload = await loadRates(env);
      return jsonResponse({
        schema: "wow-oracle/v1",
        fetched_at: payload.fetched_at,
        method:
          "Majors are Kraken spot. Coins Kraken does not list come from the " +
          "Gate.io book midpoint where Gate lists them. Niche tickers are " +
          "CexSwap's last trades, weighted by 7-day volume; it publishes no " +
          "book, so a trade must carry volume and expires. Nonlogs is not " +
          "read; see excluded.",
        sources: [
          {
            venue: "kraken",
            covers: "majors",
            price_basis: "spot ticker",
          },
          {
            venue: "gateio",
            covers: "coins Kraken does not list, starting with GRIN",
            price_basis:
              "midpoint of best bid and best ask; the last trade only when a " +
              "side is missing",
          },
          {
            venue: "cexswap",
            covers: "niche tickers, all quote routes",
            price_basis: "last trade in USD, weighted by 7-day USD volume",
            expiry_hours: MAX_LAST_TRADE_AGE_HOURS,
            why:
              "This summary carries no order book, so staleness is the only " +
              "guard available. Seven days of volume can be one old fill, and " +
              "this is the only niche source, so an old print expires rather " +
              "than anchoring the feed.",
          },
        ],
        excluded: [
          {
            venue: "nonlogs",
            since: "2026-10-19",
            why:
              "Its BTC, USDT, GRIN and XMR withdrawals had stopped completing " +
              "and its operator had stopped answering, so its books priced " +
              "balances that could not leave the venue. WOW, which still " +
              "withdrew, traded there at two to three times its price elsewhere.",
          },
        ],
        guards: {
          max_last_trade_age_hours: MAX_LAST_TRADE_AGE_HOURS,
          min_niche_7d_volume_usd: MIN_NICHE_VOL_USD,
          zero_volume_pairs: "ignored entirely",
        },
        known_limits: [
          "A venue midpoint is not a depth-weighted price: it says where the " +
            "touch is, not what size can trade there.",
          "CexSwap pool prices are not read directly; only its last trade is " +
            "available without an authenticated quote, so between trades this " +
            "source lags the pool it describes.",
          "WOW has one source. When no CexSwap WOW pair has a qualifying trade " +
            "inside the expiry window, WOW is omitted rather than estimated.",
          "No source is excluded for being one we ourselves quote on.",
        ],
        rates: payload.rates,
      });
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
