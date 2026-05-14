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
 * per pair so no BTC conversion is needed. We average across all spot pairs
 * for the same base ticker (e.g. WOW/USDT, WOW/BTC, WOW/XMR all converted to
 * USD by cexswap upstream) for robustness.
 */
async function fetchCexswap(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const res = await fetch("https://cexswap.cc/api/public/markets/summary", {
    headers: { accept: "application/json" },
    cf: { cacheTtl: 30, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`cexswap http ${res.status}`);
  const body = (await res.json()) as
    | { items?: Array<{ base?: string; last_usd?: number | string }> }
    | Array<{ base?: string; last_usd?: number | string }>;
  const items = Array.isArray(body) ? body : (body.items ?? []);

  const buckets: Record<string, number[]> = {};
  for (const m of items) {
    const base = (m.base ?? "").toUpperCase();
    if (!NICHE_TICKERS.includes(base as (typeof NICHE_TICKERS)[number])) continue;
    const usd = typeof m.last_usd === "string" ? parseFloat(m.last_usd) : m.last_usd;
    if (usd && usd > 0) {
      (buckets[base] ??= []).push(usd);
    }
  }
  for (const [ticker, prices] of Object.entries(buckets)) {
    out[ticker] = prices.reduce((a, b) => a + b, 0) / prices.length;
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

  const payload: RatesPayload = {
    rates,
    sources,
    fetched_at: new Date().toISOString(),
  };

  await env.PRICES.put(KV_KEY, JSON.stringify(payload), { expirationTtl: KV_TTL_SECONDS });
  return payload;
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
      // USD-only for now. Other quotes silently return 0 — wallet treats as
      // "price unavailable" and shows a placeholder.
      if (quote !== "USD") return jsonResponse({ results: { [`${base}_${quote}`]: 0 } });

      const payload = await loadRates(env);
      const price = payload.rates[base] ?? 0;
      return jsonResponse({ results: { [`${base}_${quote}`]: price } });
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
