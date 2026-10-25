/**
 * Market history in D1: what the cron records and what /v1/markets and
 * /v1/history serve. Spot prices stay in KV for the wallet; this is the
 * long-term record behind neroswap.com/markets and its charts.
 *
 * Write budget, for the plan's included D1 quota: one row per coin every five
 * minutes, the same sample folded into its hourly candle, and one supply row
 * per coin per hour. Ten coins come to roughly 6,000 rows a day.
 */

import type { Supply } from "./supply.ts";

/** The listing, in display order before ranking. Edit here to add a coin. */
export const MARKET_COINS = [
  { symbol: "BTC", name: "Bitcoin" },
  { symbol: "ETH", name: "Ethereum" },
  { symbol: "XMR", name: "Monero" },
  { symbol: "DOGE", name: "Dogecoin" },
  { symbol: "BCH", name: "Bitcoin Cash" },
  { symbol: "LTC", name: "Litecoin" },
  { symbol: "ETC", name: "Ethereum Classic" },
  { symbol: "DAI", name: "Dai" },
  { symbol: "GRIN", name: "Grin" },
  { symbol: "WOW", name: "Wownero" },
] as const;

export const MARKET_SYMBOLS: readonly string[] = MARKET_COINS.map((c) => c.symbol);

export const POINT_INTERVAL = 300; // seconds between price_points rows
export const POINT_RETENTION = 90 * 86_400; // price_points older than this are pruned
const HOUR = 3_600;
const DAY = 86_400;

export type Point = [ts: number, price: number];

export interface MarketRow {
  rank: number;
  symbol: string;
  name: string;
  price: number | null;
  price_source: string | null;
  change_1h: number | null;
  change_24h: number | null;
  change_7d: number | null;
  circulating_supply: number | null;
  supply_source: string | null;
  supply_at: string | null;
  market_cap: number | null;
  /** Hourly closes over the last seven days, oldest first. */
  sparkline_7d: Point[];
}

// ── writes ──────────────────────────────────────────────────────────────────

/** Record one sample per listed coin, into the five-minute series and its hourly candle. */
export async function recordPrices(
  db: D1Database,
  rates: Record<string, number>,
  sources: Record<string, string>,
  nowSec: number,
): Promise<number> {
  const bucket = nowSec - (nowSec % POINT_INTERVAL);
  const hour = nowSec - (nowSec % HOUR);
  const point = db.prepare("INSERT OR REPLACE INTO price_points (coin, ts, price, source) VALUES (?, ?, ?, ?)");
  const candle = db.prepare(
    `INSERT INTO price_hourly (coin, ts, open, high, low, close, samples) VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT (coin, ts) DO UPDATE SET
       high = MAX(high, excluded.high), low = MIN(low, excluded.low),
       close = excluded.close, samples = samples + 1`,
  );
  const statements: D1PreparedStatement[] = [];
  for (const coin of MARKET_SYMBOLS) {
    const price = rates[coin];
    if (!(Number.isFinite(price) && price > 0)) continue;
    statements.push(point.bind(coin, bucket, price, sources[coin] ?? "unknown"));
    statements.push(candle.bind(coin, hour, price, price, price, price));
  }
  if (statements.length) await db.batch(statements);
  return statements.length / 2;
}

/** Largest move between two hourly supply readings we accept as real. */
export const MAX_SUPPLY_STEP = 0.02;

/**
 * Whether a new supply figure is believable next to the last one recorded.
 * No real coin on the list issues or burns 2% of its supply in a few hours,
 * while a bad upstream answer (wrong chain, wrong units, a stale node) easily
 * does. A refused figure is logged, and the listing keeps the old one.
 */
export function plausibleSupply(previous: number | undefined, next: number): boolean {
  if (!(next > 0)) return false;
  if (previous === undefined || !(previous > 0)) return true;
  return Math.abs(next / previous - 1) <= MAX_SUPPLY_STEP;
}

export async function recordSupply(db: D1Database, supply: Record<string, Supply>, nowSec: number): Promise<number> {
  const hour = nowSec - (nowSec % HOUR);
  const latest = await db
    .prepare(
      `SELECT s.coin, s.circulating FROM supply_points s
       JOIN (SELECT coin, MAX(ts) AS ts FROM supply_points GROUP BY coin) l ON l.coin = s.coin AND l.ts = s.ts`,
    )
    .all<{ coin: string; circulating: number }>();
  const previous = new Map((latest.results ?? []).map((r) => [r.coin, r.circulating]));
  const insert = db.prepare("INSERT OR REPLACE INTO supply_points (coin, ts, circulating, source) VALUES (?, ?, ?, ?)");
  const accepted = Object.entries(supply).filter(([coin, s]) => {
    const ok = plausibleSupply(previous.get(coin), s.circulating);
    if (!ok) console.error(`supply ${coin} refused: ${s.circulating} from ${s.source}, last recorded ${previous.get(coin)}`);
    return ok;
  });
  const statements = accepted.map(([coin, s]) => insert.bind(coin, hour, s.circulating, s.source));
  if (statements.length) await db.batch(statements);
  return statements.length;
}

export async function prunePoints(db: D1Database, nowSec: number): Promise<void> {
  await db.prepare("DELETE FROM price_points WHERE ts < ?").bind(nowSec - POINT_RETENTION).run();
}

// ── reads ───────────────────────────────────────────────────────────────────

/**
 * Relative change from the last point at or before `targetTs`, or null when
 * there is no point within `maxAgeSec` of the target. A coin with two days of
 * history has no seven-day change, and says so, rather than reporting the
 * change since whenever recording began.
 */
export function changeSince(points: readonly Point[], targetTs: number, maxAgeSec: number, price: number | null): number | null {
  if (price === null) return null;
  let ref: Point | undefined;
  for (const p of points) {
    if (p[0] > targetTs) break;
    ref = p;
  }
  if (!ref || targetTs - ref[0] > maxAgeSec || !(ref[1] > 0)) return null;
  return price / ref[1] - 1;
}

export interface MarketInputs {
  rates: Record<string, number>;
  sources: Record<string, string>;
  /** price_points rows for the last ~75 minutes, by coin, oldest first */
  recent: Record<string, Point[]>;
  /** hourly closes for the last ~7 days, by coin, oldest first */
  hourly: Record<string, Point[]>;
  supply: Record<string, { circulating: number; source: string; ts: number }>;
}

/** Assemble the listing; pure, so it is tested without a database. */
export function buildMarkets(inputs: MarketInputs, nowSec: number): MarketRow[] {
  const rows = MARKET_COINS.map(({ symbol, name }) => {
    const live = inputs.rates[symbol];
    const recent = inputs.recent[symbol] ?? [];
    const hourly = inputs.hourly[symbol] ?? [];
    const price = Number.isFinite(live) && live > 0 ? live : (recent.at(-1)?.[1] ?? null);
    const supply = inputs.supply[symbol];
    const circulating = supply?.circulating ?? null;
    return {
      rank: 0,
      symbol,
      name,
      price,
      price_source: Number.isFinite(live) && live > 0 ? (inputs.sources[symbol] ?? null) : recent.length ? "history" : null,
      change_1h: changeSince(recent, nowSec - HOUR, 15 * 60, price),
      change_24h: changeSince(hourly, nowSec - DAY, 2 * HOUR, price),
      change_7d: changeSince(hourly, nowSec - 7 * DAY, 2 * HOUR, price),
      circulating_supply: circulating,
      supply_source: supply?.source ?? null,
      supply_at: supply ? new Date(supply.ts * 1000).toISOString() : null,
      market_cap: price !== null && circulating !== null ? price * circulating : null,
      sparkline_7d: hourly.filter(([ts]) => ts >= nowSec - 7 * DAY),
    };
  });
  // Market cap descending; coins without one keep their listed order after.
  const ranked = [...rows].sort((a, b) => (b.market_cap ?? -1) - (a.market_cap ?? -1));
  ranked.forEach((r, i) => (r.rank = i + 1));
  return ranked;
}

function groupPoints(rows: { coin: string; ts: number; value: number }[]): Record<string, Point[]> {
  const out: Record<string, Point[]> = {};
  for (const r of rows) (out[r.coin] ??= []).push([r.ts, r.value]);
  return out;
}

export async function readMarketInputs(
  db: D1Database,
  nowSec: number,
): Promise<Pick<MarketInputs, "recent" | "hourly" | "supply">> {
  const [recent, hourly, supply] = await db.batch([
    db
      .prepare("SELECT coin, ts, price AS value FROM price_points WHERE ts >= ? ORDER BY coin, ts")
      .bind(nowSec - HOUR - 15 * 60),
    db
      .prepare("SELECT coin, ts, close AS value FROM price_hourly WHERE ts >= ? ORDER BY coin, ts")
      .bind(nowSec - 7 * DAY - 3 * HOUR),
    db.prepare(
      `SELECT s.coin, s.ts, s.circulating, s.source FROM supply_points s
       JOIN (SELECT coin, MAX(ts) AS ts FROM supply_points GROUP BY coin) latest
         ON latest.coin = s.coin AND latest.ts = s.ts`,
    ),
  ]);
  const supplyByCoin: MarketInputs["supply"] = {};
  for (const r of (supply.results ?? []) as { coin: string; ts: number; circulating: number; source: string }[]) {
    supplyByCoin[r.coin] = { circulating: r.circulating, source: r.source, ts: r.ts };
  }
  return {
    recent: groupPoints((recent.results ?? []) as { coin: string; ts: number; value: number }[]),
    hourly: groupPoints((hourly.results ?? []) as { coin: string; ts: number; value: number }[]),
    supply: supplyByCoin,
  };
}

export type Interval = "5m" | "1h";

/** One coin's series. 5m comes from price_points (90 days), 1h from the candles (all time). */
export async function readHistory(
  db: D1Database,
  coin: string,
  interval: Interval,
  fromSec: number,
  toSec: number,
  limit: number,
): Promise<unknown[]> {
  if (interval === "5m") {
    const res = await db
      .prepare("SELECT ts, price FROM price_points WHERE coin = ? AND ts >= ? AND ts <= ? ORDER BY ts LIMIT ?")
      .bind(coin, fromSec, toSec, limit)
      .all<{ ts: number; price: number }>();
    return (res.results ?? []).map((r) => [r.ts, r.price]);
  }
  const res = await db
    .prepare(
      "SELECT ts, open, high, low, close FROM price_hourly WHERE coin = ? AND ts >= ? AND ts <= ? ORDER BY ts LIMIT ?",
    )
    .bind(coin, fromSec, toSec, limit)
    .all<{ ts: number; open: number; high: number; low: number; close: number }>();
  return (res.results ?? []).map((r) => [r.ts, r.open, r.high, r.low, r.close]);
}

/**
 * Everything recorded after `sinceSec`, for neroswap-site to keep its own copy
 * in history.db. Paged by timestamp: the caller passes back `next_since` until
 * a page comes back short.
 */
export async function readExport(db: D1Database, sinceSec: number, limit: number) {
  const [points, supply] = await db.batch([
    db
      .prepare("SELECT coin, ts, price, source FROM price_points WHERE ts > ? ORDER BY ts, coin LIMIT ?")
      .bind(sinceSec, limit),
    db
      .prepare("SELECT coin, ts, circulating, source FROM supply_points WHERE ts > ? ORDER BY ts, coin LIMIT ?")
      .bind(sinceSec, limit),
  ]);
  const p = (points.results ?? []) as { coin: string; ts: number; price: number; source: string }[];
  const s = (supply.results ?? []) as { coin: string; ts: number; circulating: number; source: string }[];
  // A page that hit the limit may have cut a timestamp in half; the next page
  // restarts from the last complete one, and the site inserts idempotently.
  const full = p.length === limit;
  const lastTs = p.at(-1)?.ts ?? sinceSec;
  const next = full ? Math.max(sinceSec, lastTs - 1) : lastTs;
  return { points: p, supply: s, next_since: next, complete: !full };
}
