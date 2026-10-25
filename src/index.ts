/**
 * Hash Wallet price aggregator.
 *
 * One Cloudflare Worker that:
 *  - Fetches USD spot prices from Kraken for majors (BTC/XMR/LTC/DOGE/ETH/BCH/XNO).
 *  - Prices WOW from the cexswap.cc AMM pools and GRIN from Gate.io (too small
 *    for major CEX listings). A pool always has a price, and moving it costs a
 *    trade against the whole reserve, so the deep pools carry the weight.
 *    Nonlogs was a WOW source until 2026-10-19; NICHE_TICKERS says why it is
 *    not one now. This feed is what Hash Bags, Smirk and wowlet display.
 *  - Caches results in KV every 60s via cron, then serves from KV on request.
 *
 * Endpoints:
 *  - GET /v2/rates?base=BTC&quote=USD  → { "results": { "BTC_USD": 67342.5 } }
 *      (Drop-in shape compatible with the wallet's existing fiat_conversion_service.dart.)
 *  - GET /v1/prices                    → { "rates": { ... }, "fetched_at": "..." }
 *      (Preferred future shape — single call returns everything.)
 *  - GET /v1/markets                   → market listing: price, 1h/24h/7d change,
 *      circulating supply, market cap and a 7-day sparkline per coin (D1).
 *  - GET /v1/history?coin=BTC&interval=5m|1h&from=&to=  → one coin's series.
 *  - GET /v1/history/export?since=     → every point after `since`, paged, so
 *      neroswap-site can keep its own copy.
 *
 * USD only. The wallet's other fiat currencies will see price=0 and degrade
 * gracefully via existing fallback logic.
 */

import { MARKET_SYMBOLS, buildMarkets, prunePoints, readExport, readHistory, readMarketInputs, recordPrices, recordSupply, type Interval } from "./markets.ts";
import { fetchAllSupply } from "./supply.ts";

export interface Env {
  PRICES: KVNamespace;
  /** Market history (see migrations/). Optional so the spot feed keeps
   *  working on a deploy that has no D1 binding yet; the history endpoints
   *  answer 503 until it exists. */
  HISTORY?: D1Database;
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
  ETC: "ETCUSD",
  DAI: "DAIUSD",
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
 * Tickers priced from the cexswap.cc AMM pools whose base they are.
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
 * USD value of the quote-side reserve a pool must hold before it votes. Depth
 * is what it costs to move a pool, so a pool under this is dust that a few
 * dollars can push anywhere.
 *
 * On 2026-10-20 the WOW pools held, on the quote side: WOW-XMR $1,810,
 * WOW-BTC $947, WOW-DOGE $410, WOW-LTC $140, WOW-USDT $64, WOW-ETH $24. $25
 * keeps the five with real liquidity and drops WOW-ETH, which no one had traded
 * that day. It is also the floor used everywhere else in this feed and on the
 * desk, for the same reason: a pool nobody can trade size against is not a
 * second opinion.
 */
const MIN_POOL_DEPTH_USD = 25;

/**
 * A qualifying pool further than this from the depth-weighted median is
 * dropped before the average. Pools only reprice when someone trades against
 * them, so a quiet one can sit at a stale ratio, and a shallow one can be
 * pushed. On 2026-10-20 every WOW pool sat within 6% of the median, so 25%
 * removes nothing on an ordinary day and stops one stuck or pushed pool from
 * dragging the rest. Against the median rather than the mean, because the mean
 * already includes the pool being judged.
 */
const MAX_POOL_DEVIATION_PCT = 25;

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

/** One cexswap AMM pool, as much of it as pricing needs. */
interface Pool {
  base: string;
  quote: string;
  /** Quote per base: the pool's reserve ratio. */
  price: number;
  reserveQuote: number;
}

/**
 * Read the cexswap AMM pools for every niche ticker. Unlike a spot last trade,
 * a pool always has a current price, its reserve ratio, and that ratio only
 * moves when somebody trades against the reserve. On 2026-10-20 every WOW spot
 * print but one had passed its 12-hour expiry, and the survivor, WOW-XMR, was
 * an 85% spike off a one-cent trade. The pools at the same moment agreed with
 * each other to within 6%.
 *
 * Only pools whose base is the ticker are kept: in BAN-WOW or GRIN-WOW, WOW is
 * the quote, and that pool prices BAN or GRIN, not WOW.
 */
async function fetchCexswapPools(): Promise<Pool[]> {
  const out: Pool[] = [];
  for (const ticker of NICHE_TICKERS) {
    const res = await fetch(
      `https://cexswap.cc/api/amm/public/pairs?search=${ticker}&limit=50`,
      { headers: { accept: "application/json" }, cf: { cacheTtl: 30, cacheEverything: true } },
    );
    if (!res.ok) throw new Error(`cexswap pools http ${res.status}`);
    type PoolRow = {
      base?: string;
      quote?: string;
      pool_price?: number | string;
      reserve_quote?: number | string;
    };
    const body = (await res.json()) as { items?: PoolRow[] };
    for (const row of body.items ?? []) {
      const base = (row.base ?? "").toUpperCase();
      const quote = (row.quote ?? "").toUpperCase();
      const price = Number(row.pool_price);
      const reserveQuote = Number(row.reserve_quote);
      if (base !== ticker || !quote) continue;
      if (!(price > 0) || !(reserveQuote > 0)) continue;
      out.push({ base, quote, price, reserveQuote });
    }
  }
  return out;
}

/**
 * USD price of `ticker` from its pools: each pool's price times its quote
 * asset's USD rate from this same feed, weighted by the USD value of the quote
 * reserve. A pool whose quote has no USD rate here cannot be converted and is
 * skipped; a pool under MIN_POOL_DEPTH_USD does not vote; a pool more than
 * MAX_POOL_DEVIATION_PCT from the depth-weighted median is dropped. Returns
 * undefined when nothing qualifies, so the ticker is omitted rather than
 * guessed.
 */
function priceFromPools(
  ticker: string,
  pools: Pool[],
  usd: Record<string, number>,
): number | undefined {
  const votes: Array<{ usd: number; depth: number }> = [];
  for (const p of pools) {
    const quoteUsd = usd[p.quote];
    if (p.base !== ticker || !(quoteUsd > 0)) continue;
    const depth = p.reserveQuote * quoteUsd;
    if (depth < MIN_POOL_DEPTH_USD) continue;
    votes.push({ usd: p.price * quoteUsd, depth });
  }
  if (votes.length === 0) return undefined;

  votes.sort((a, b) => a.usd - b.usd);
  const total = votes.reduce((a, v) => a + v.depth, 0);
  let seen = 0;
  let median = votes[votes.length - 1].usd;
  for (const v of votes) {
    seen += v.depth;
    if (seen >= total / 2) {
      median = v.usd;
      break;
    }
  }

  const kept = votes.filter(
    (v) => (Math.abs(v.usd - median) / median) * 100 <= MAX_POOL_DEVIATION_PCT,
  );
  const weight = kept.reduce((a, v) => a + v.depth, 0);
  return kept.reduce((a, v) => a + v.usd * v.depth, 0) / weight;
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
  // The pools are converted to USD afterwards, from the rates computed here.
  const [kraken, pools, gateio] = await Promise.all([
    fetchKraken().catch((e) => {
      console.error("kraken failed", e);
      return {} as Record<string, number>;
    }),
    fetchCexswapPools().catch((e) => {
      console.error("cexswap pools failed", e);
      return [] as Pool[];
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
  // desk trades on, and an oracle that reads back our own quotes is exactly
  // the circularity the desk's divergence rail exists to catch. Kraken still
  // wins wherever it lists the coin.
  for (const [ticker, px] of Object.entries(gateio)) {
    if (rates[ticker]) continue;
    rates[ticker] = px;
    sources[ticker] = "gateio";
  }

  // Stables Kraken does not quote are pinned to 1.0; DAI has a real Kraken
  // market, so it keeps that price. Pinned before the pools are priced,
  // because a WOW-USDT pool needs USDT's rate to convert.
  for (const stable of ["USDT", "USDC", "DAI"]) {
    if (rates[stable]) continue;
    rates[stable] = 1.0;
    sources[stable] = "pinned";
  }

  // Niche coins come from the cexswap pools alone since Nonlogs was dropped
  // (see NICHE_TICKERS). With no qualifying pool the ticker is left out, so
  // the wallet shows the price as unavailable instead of a guess.
  for (const ticker of NICHE_TICKERS) {
    const px = priceFromPools(ticker, pools, rates);
    if (px === undefined) continue;
    rates[ticker] = px;
    sources[ticker] = "cexswap-pools";
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

const HISTORY_INTERVALS: Record<Interval, { maxSpanSec: number }> = {
  "5m": { maxSpanSec: 90 * 86_400 },
  "1h": { maxSpanSec: 10 * 365 * 86_400 },
};

/** Edge-cache a history answer for a minute; the data only changes every five. */
async function cachedJson(req: URL, build: () => Promise<unknown>): Promise<Response> {
  const cache = typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : undefined;
  const key = new Request(req.toString());
  const hit = await cache?.match(key);
  if (hit) return hit;
  const res = new Response(JSON.stringify(await build()), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=60",
      "access-control-allow-origin": "*",
    },
  });
  await cache?.put(key, res.clone());
  return res;
}

async function historyResponse(url: URL, env: Env, db: D1Database): Promise<Response> {
  const nowSec = Math.floor(Date.now() / 1000);

  if (url.pathname === "/v1/markets") {
    return cachedJson(url, async () => {
      const [payload, stored] = await Promise.all([loadRates(env), readMarketInputs(db, nowSec)]);
      return {
        coins: buildMarkets({ rates: payload.rates, sources: payload.sources, ...stored }, nowSec),
        fetched_at: payload.fetched_at,
      };
    });
  }

  if (url.pathname === "/v1/history") {
    const coin = (url.searchParams.get("coin") ?? "").toUpperCase();
    const interval = (url.searchParams.get("interval") ?? "1h") as Interval;
    if (!MARKET_SYMBOLS.includes(coin)) return jsonResponse({ error: "unknown coin" }, 400);
    if (!(interval in HISTORY_INTERVALS)) return jsonResponse({ error: "interval must be 5m or 1h" }, 400);
    const to = parseInt(url.searchParams.get("to") ?? "", 10) || nowSec;
    const defaultFrom = to - (interval === "5m" ? 86_400 : 30 * 86_400);
    const from = Math.max(parseInt(url.searchParams.get("from") ?? "", 10) || defaultFrom, to - HISTORY_INTERVALS[interval].maxSpanSec);
    return cachedJson(url, async () => ({
      coin,
      interval,
      columns: interval === "5m" ? ["ts", "price"] : ["ts", "open", "high", "low", "close"],
      points: await readHistory(db, coin, interval, from, to, 10_000),
    }));
  }

  if (url.pathname === "/v1/history/export") {
    const since = parseInt(url.searchParams.get("since") ?? "0", 10) || 0;
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "5000", 10) || 5000, 100), 10_000);
    return jsonResponse(await readExport(db, since, limit));
  }

  return jsonResponse({ error: "not found" }, 404);
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
          "Gate.io book midpoint where Gate lists them. Niche tickers come from " +
          "the CexSwap AMM pools whose base they are: each pool's price times " +
          "its quote asset's USD rate from this feed, weighted by the USD value " +
          "of the quote reserve, after dropping shallow pools and pools far " +
          "from the depth-weighted median. Nonlogs is not read; see excluded.",
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
            covers: "niche tickers, every AMM pool whose base is the ticker",
            price_basis:
              "pool price (reserve ratio) times the quote asset's USD rate, " +
              "weighted by the USD value of the quote reserve",
            why:
              "A pool always has a current price, and moving it costs a trade " +
              "against the whole reserve. A spot last trade can be one cent of " +
              "volume many hours old: on 2026-10-20 every WOW spot print but " +
              "one had expired, and the survivor was an 85% spike.",
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
          min_pool_depth_usd: MIN_POOL_DEPTH_USD,
          max_pool_deviation_pct: MAX_POOL_DEVIATION_PCT,
          pools_without_a_usd_quote: "skipped",
          pools_where_the_ticker_is_the_quote: "ignored",
        },
        known_limits: [
          "A venue midpoint is not a depth-weighted price: it says where the " +
            "touch is, not what size can trade there.",
          "A pool reprices only when someone trades against it, so a quiet " +
            "pool can lag the wider market; depth weighting lets the deep pools " +
            "dominate and the deviation guard drops one that has drifted far.",
          "The owner of this feed is a liquidity provider in the WOW-XMR and " +
            "WOW-BTC pools. Adding or removing liquidity at the pool ratio does " +
            "not move the price; only trades do.",
          "WOW has one venue. When no CexSwap WOW pool qualifies, WOW is " +
            "omitted rather than estimated.",
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

    if (url.pathname === "/v1/markets" || url.pathname.startsWith("/v1/history")) {
      if (!env.HISTORY) return jsonResponse({ error: "market history is not configured" }, 503);
      return historyResponse(url, env, env.HISTORY);
    }

    return jsonResponse({ error: "not found" }, 404);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const nowSec = Math.floor(event.scheduledTime / 1000);
    const minute = Math.floor(nowSec / 60) % 60;
    const db = env.HISTORY;

    ctx.waitUntil(
      refreshPrices(env).then(
        async (p) => {
          console.log(`refreshed ${Object.keys(p.rates).length} coins`);
          // A history failure must never cost the wallet its spot prices, which
          // are already in KV by the time this runs.
          if (db && minute % 5 === 0) {
            await recordPrices(db, p.rates, p.sources, nowSec).then(
              (n) => console.log(`recorded ${n} market prices`),
              (e) => console.error("record prices failed", e),
            );
          }
        },
        (e) => console.error("refresh failed", e),
      ),
    );

    // Supply moves slowly, so once an hour, off the five-minute marks.
    if (db && minute === 7) {
      ctx.waitUntil(
        fetchAllSupply(MARKET_SYMBOLS)
          .then((supply) => recordSupply(db, supply, nowSec))
          .then(
            (n) => console.log(`recorded supply for ${n} coins`),
            (e) => console.error("record supply failed", e),
          ),
      );
    }

    if (db && minute === 17 && Math.floor(nowSec / 3600) % 24 === 0) {
      ctx.waitUntil(prunePoints(db, nowSec).catch((e) => console.error("prune failed", e)));
    }
  },
};
