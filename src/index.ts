/**
 * Hash Wallet price aggregator.
 *
 * One Cloudflare Worker that:
 *  - Fetches USD spot prices from Kraken for majors (BTC/XMR/LTC/DOGE/ETH/BCH/XNO).
 *  - Fetches WOW from Nonlogs + cexswap.cc (too small for major CEX listings).
 *    Both legs ignore markets with no 24h volume: a stale last print is not a
 *    price, and this feed is what Hash Bags, Smirk and wowlet display.
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

/**
 * A book wider than this has no meaningful midpoint, so we use the last trade
 * instead. 60% is deliberately loose: these are thin markets and a 30% spread
 * is a normal Tuesday, but the 1000%+ books that appear on dead pairs must
 * never set a price.
 */
const MAX_BOOK_SPREAD_PCT = 60;

/**
 * A cexswap `last` print older than this is not evidence of the current price.
 * Its summary carries no book, only the last trade, so staleness is the only
 * guard available on that source.
 */
const MAX_LAST_TRADE_AGE_HOURS = 12;

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
 * Pull all markets from Nonlogs in one call. Returns a per-ticker USD price,
 * volume-weighting the (TICKER-BTC × BTC/USD) and (TICKER-USDT) routes by
 * their 24h quote volume.
 *
 * Routes with no 24h volume are ignored, for the same reason the cexswap
 * function ignores them: `last_price` on a market nobody has traded is
 * whatever the last person paid, whenever that was, and averaging it against
 * a live route drags the published price. WOW-USDT here is the live example —
 * a 0.00723 print with null volume against a WOW-BTC route trading at the
 * equivalent of 0.00816, which pulled the Nonlogs leg about 6% low and, since
 * the leg is half the WOW blend, every product's displayed price with it.
 *
 * If no route on this venue has volume, the ticker is omitted entirely and
 * the cexswap sample stands alone.
 */
async function fetchNonlogs(btcUsd: number): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (btcUsd <= 0) return out;

  const res = await fetch("https://api.nonlogs.io/api/markets", {
    headers: { "user-agent": "hash-wallet-prices/0.1" },
    cf: { cacheTtl: 30, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`nonlogs http ${res.status}`);
  type NonlogsRow = {
    last_price?: string | null;
    quote_volume?: string | null;
    highest_bid?: string | null;
    lowest_ask?: string | null;
  };
  const body = (await res.json()) as { markets?: Record<string, NonlogsRow> };
  const markets = body.markets ?? {};

  const num = (v: string | null | undefined): number => {
    const n = parseFloat(v ?? "");
    return Number.isFinite(n) ? n : 0;
  };

  /**
   * Prefer the live book midpoint over the last trade.
   *
   * A last print says where somebody traded once; on a market doing a few
   * hundred dollars a day that can be hours old and sitting at the day's low.
   * The midpoint of the current best bid and ask says where you could trade
   * now, which is what a price feed is asked for. WOW-BTC on 2026-09-06 is the
   * case in point: last 10 sat, book 10 bid / 13 ask, mid 11.5.
   *
   * Guards, because a midpoint is only meaningful across a real two-sided
   * book: both sides must exist, the ask must be above the bid, and the spread
   * must be under MAX_BOOK_SPREAD_PCT. A 1000%-wide book has a midpoint that
   * means nothing, and on these venues that is common. When any guard fails we
   * fall back to the last trade rather than dropping the market.
   */
  const liveOrLast = (row: NonlogsRow | undefined): number => {
    const bid = num(row?.highest_bid);
    const ask = num(row?.lowest_ask);
    const last = num(row?.last_price);
    if (bid > 0 && ask > bid) {
      const mid = (bid + ask) / 2;
      if (((ask - bid) / mid) * 100 <= MAX_BOOK_SPREAD_PCT) return mid;
    }
    return last;
  };

  for (const ticker of NICHE_TICKERS) {
    // [usd price, weight in USD] per route.
    const samples: Array<[number, number]> = [];

    const btcRow = markets[`${ticker}-BTC`];
    const btcPrice = liveOrLast(btcRow);
    const btcVol = num(btcRow?.quote_volume);          // volume in BTC
    if (btcPrice > 0 && btcVol > 0) {
      samples.push([btcPrice * btcUsd, btcVol * btcUsd]);
    }

    const usdtRow = markets[`${ticker}-USDT`];
    const usdtPrice = liveOrLast(usdtRow);
    const usdtVol = num(usdtRow?.quote_volume);        // volume in USDT ≈ USD
    if (usdtPrice > 0 && usdtVol > 0) {
      samples.push([usdtPrice, usdtVol]);
    }

    if (samples.length) {
      const weight = samples.reduce((a, [, w]) => a + w, 0);
      out[ticker] = samples.reduce((a, [p, w]) => a + p * w, 0) / weight;
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
    // current price, and this source outweighs every other, so it must expire.
    const tradedAt = num(m.last_trade_at_unix as string | undefined);
    const ageHours = tradedAt > 0 ? (Date.now() / 1000 - tradedAt) / 3600 : Infinity;
    if (usd > 0 && weight > 0 && ageHours <= MAX_LAST_TRADE_AGE_HOURS) {
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
  // Kraken first — its BTC/USD is needed by the Nonlogs WOW conversion.
  const kraken = await fetchKraken().catch((e) => {
    console.error("kraken failed", e);
    return {} as Record<string, number>;
  });

  const btcUsd = kraken.BTC ?? 0;

  const [nonlogs, cexswap, gateio] = await Promise.all([
    fetchNonlogs(btcUsd).catch((e) => {
      console.error("nonlogs failed", e);
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
  // NOT folded into NICHE_TICKERS: that path averages nonlogs and cexswap, the
  // same venues our own desk quotes into, and an oracle that reads back our
  // own quotes is exactly the circularity the desk's divergence rail exists to
  // catch. Kraken still wins wherever it lists the coin.
  for (const [ticker, px] of Object.entries(gateio)) {
    if (rates[ticker]) continue;
    rates[ticker] = px;
    sources[ticker] = "gateio";
  }

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

    // The oracle, described by the thing that implements it. A price feed that
    // cannot say how it arrived at a number is asking to be trusted rather than
    // checked, and this one gates real quoting decisions.
    if (url.pathname === "/v1/oracle") {
      const payload = await loadRates(env);
      return jsonResponse({
        schema: "wow-oracle/v1",
        fetched_at: payload.fetched_at,
        method:
          "Majors are Kraken spot. Niche tickers are volume-weighted across " +
          "Nonlogs and CexSwap. Nonlogs prefers the live book midpoint over " +
          "the last trade; CexSwap publishes no book, so its last trade is " +
          "used and expires.",
        sources: [
          {
            venue: "kraken",
            covers: "majors",
            price_basis: "spot ticker",
          },
          {
            venue: "nonlogs",
            covers: "niche tickers, BTC and USDT routes",
            price_basis:
              "midpoint of best bid and best ask when both sides exist, the " +
              "ask is above the bid, and the spread is at or under " +
              `${MAX_BOOK_SPREAD_PCT}%; otherwise the last trade`,
            why:
              "A last print says where somebody traded once. On a market doing " +
              "a few hundred dollars a day that can be hours old and sitting at " +
              "the day's low. The midpoint says where you could trade now.",
          },
          {
            venue: "cexswap",
            covers: "niche tickers, all quote routes",
            price_basis: "last trade in USD, weighted by 7-day USD volume",
            expiry_hours: MAX_LAST_TRADE_AGE_HOURS,
            why:
              "This summary carries no order book, so staleness is the only " +
              "guard available. Seven days of volume can be one old fill, and " +
              "this source can outweigh every other, so an old print expires " +
              "rather than anchoring the feed.",
          },
        ],
        guards: {
          max_book_spread_pct: MAX_BOOK_SPREAD_PCT,
          max_last_trade_age_hours: MAX_LAST_TRADE_AGE_HOURS,
          zero_volume_pairs: "ignored entirely",
        },
        known_limits: [
          "A venue midpoint is not a depth-weighted price: it says where the " +
            "touch is, not what size can trade there.",
          "CexSwap pool prices are not read directly; only its last trade is " +
            "available without an authenticated quote, so between trades this " +
            "source lags the pool it describes.",
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
