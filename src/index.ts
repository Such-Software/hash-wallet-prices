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
 * Wallet-side ticker → NonKYC market symbol.
 * NonKYC quotes WOW only against USDT, which we treat as ≈ USD for spot pricing.
 */
const NONKYC_MARKETS: Record<string, string> = {
  WOW: "WOW_USDT",
};

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

async function fetchNonkyc(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [ticker, market] of Object.entries(NONKYC_MARKETS)) {
    try {
      const res = await fetch(`https://api.nonkyc.io/api/v2/ticker/${market}`, {
        cf: { cacheTtl: 30, cacheEverything: true },
      });
      if (!res.ok) continue;
      // NonKYC ticker shape: { "last_price": "0.0234", ... }. Field name has been
      // both `last_price` and `last` historically — accept either.
      const body = (await res.json()) as { last_price?: string; last?: string };
      const last = body.last_price ?? body.last;
      if (last) out[ticker] = parseFloat(last);
    } catch {
      // Skip — WOW just won't be in this refresh cycle. Stale KV value will be
      // returned to clients until the next successful refresh.
    }
  }
  return out;
}

async function refreshPrices(env: Env): Promise<RatesPayload> {
  const [kraken, nonkyc] = await Promise.all([
    fetchKraken().catch((e) => {
      console.error("kraken failed", e);
      return {};
    }),
    fetchNonkyc().catch((e) => {
      console.error("nonkyc failed", e);
      return {};
    }),
  ]);

  const rates: Record<string, number> = { ...kraken, ...nonkyc };
  const sources: Record<string, string> = {};
  for (const k of Object.keys(kraken)) sources[k] = "kraken";
  for (const k of Object.keys(nonkyc)) sources[k] = "nonkyc";

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
