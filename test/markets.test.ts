// Market history against a real SQLite: node:sqlite stands in for D1, running
// the shipped migration, so the candle upsert and the ranking queries are the
// ones production executes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.ts";
import {
  POINT_RETENTION,
  buildMarkets,
  changeSince,
  prunePoints,
  readExport,
  readHistory,
  readMarketInputs,
  recordPrices,
  recordSupply,
} from "../src/markets.ts";
import { dogeSupply, grinSupply, halvingSupply, uint256ToNumber } from "../src/supply.ts";

class Statement {
  db: DatabaseSync;
  sql: string;
  args: unknown[];
  constructor(db: DatabaseSync, sql: string, args: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args: unknown[]) {
    return new Statement(this.db, this.sql, args);
  }
  isRead() {
    return /^\s*SELECT/i.test(this.sql);
  }
  execute() {
    const stmt = this.db.prepare(this.sql);
    if (this.isRead()) return { results: stmt.all(...(this.args as never[])) };
    stmt.run(...(this.args as never[]));
    return { results: [] };
  }
  async all() {
    return this.execute();
  }
  async run() {
    return this.execute();
  }
}

function memoryD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_market_history.sql", import.meta.url), "utf8"));
  return {
    raw: db,
    prepare: (sql: string) => new Statement(db, sql),
    async batch(statements: Statement[]) {
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => s.execute());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

const D = 86_400;
const NOW = Math.floor(Date.UTC(2026, 9, 25, 12, 0, 0) / 1000);

test("halving schedules match the chains' own arithmetic", () => {
  // Bitcoin: four full eras end at block 839,999 with exactly 19,687,500 BTC.
  assert.equal(halvingSupply(839_999, 50n * 100_000_000n, 210_000), 19_687_500);
  assert.equal(halvingSupply(840_000, 50n * 100_000_000n, 210_000), 19_687_503.125);
  // Litecoin at a recent tip, cross-checked against Blockchair (77,756,798.6):
  // the gap is coinbase that miners never claimed, under 0.003%.
  const ltc = halvingSupply(3_201_397, 50n * 100_000_000n, 840_000);
  assert.equal(ltc, 77_758_737.5);
  assert.ok(Math.abs(ltc - 77_756_798.6) / ltc < 3e-5);
});

test("grin and erc-20 supply decoding", () => {
  assert.equal(grinSupply(0), 60);
  assert.equal(grinSupply(4_077_817), 244_669_080);
  assert.equal(uint256ToNumber("0x" + (5_000_000n * 10n ** 18n).toString(16).padStart(64, "0"), 18), 5_000_000);
});

test("a change needs history that reaches back far enough", () => {
  const points: [number, number][] = [
    [NOW - 2 * D, 100],
    [NOW - D - 1800, 110],
    [NOW - 3600, 120],
  ];
  assert.equal(changeSince(points, NOW - D, 7200, 132), 132 / 110 - 1);
  assert.equal(changeSince(points, NOW - 7 * D, 7200, 132), null); // starts 2 days back
  assert.equal(changeSince(points, NOW - D, 600, 132), null); // nearest point too old
  assert.equal(changeSince(points, NOW - D, 7200, null), null);
});

test("recorded samples become a ranked listing with candles and changes", async () => {
  const db = memoryD1();
  // Eight days of five-minute samples: BTC climbs a dollar a sample, XMR is flat.
  for (let ts = NOW - 8 * D; ts <= NOW; ts += 300) {
    const i = (ts - (NOW - 8 * D)) / 300;
    await recordPrices(
      db as never,
      { BTC: 50_000 + i, XMR: 300, WOW: 0.009, USDT: 1 },
      { BTC: "kraken", XMR: "kraken", WOW: "cexswap-pools" },
      ts,
    );
  }
  await recordSupply(db as never, { BTC: { circulating: 20_000_000, source: "test" }, XMR: { circulating: 18_700_000, source: "test" } }, NOW);

  // Only listed coins are stored; USDT is priced but not on the listing.
  const coins = db.raw.prepare("SELECT DISTINCT coin FROM price_points ORDER BY coin").all().map((r: any) => r.coin);
  assert.deepEqual(coins, ["BTC", "WOW", "XMR"]);

  // The hourly candle folds its twelve samples.
  const [candle] = (await readHistory(db as never, "BTC", "1h", NOW - 3600, NOW - 3600, 10)) as number[][];
  const first = 50_000 + (8 * D - 3600) / 300;
  assert.deepEqual(candle, [NOW - 3600, first, first + 11, first, first + 11]);

  const stored = await readMarketInputs(db as never, NOW);
  const btcNow = 50_000 + (8 * D) / 300;
  const rows = buildMarkets({ rates: { BTC: btcNow, XMR: 300, WOW: 0.009 }, sources: { BTC: "kraken" }, ...stored }, NOW);

  assert.deepEqual(rows.map((r) => r.symbol).slice(0, 2), ["BTC", "XMR"]); // ranked by market cap
  const btc = rows.find((r) => r.symbol === "BTC")!;
  assert.equal(btc.rank, 1);
  assert.equal(btc.market_cap, btcNow * 20_000_000);
  assert.equal(btc.change_1h, btcNow / (btcNow - 12) - 1);
  // 24h and 7d compare against the hourly close at or before the target.
  const closeAt = (hourTs: number) => 50_000 + (hourTs + 3300 - (NOW - 8 * D)) / 300;
  assert.equal(btc.change_24h, btcNow / closeAt(NOW - D) - 1);
  assert.equal(btc.change_7d, btcNow / closeAt(NOW - 7 * D) - 1);
  assert.ok(btc.sparkline_7d.length >= 168 && btc.sparkline_7d.length <= 170);

  const wow = rows.find((r) => r.symbol === "WOW")!;
  assert.equal(wow.market_cap, null); // no supply source, so no market cap
  assert.equal(wow.price, 0.009);
  const dai = rows.find((r) => r.symbol === "DAI")!;
  assert.equal(dai.price, null); // never recorded, never priced
  assert.equal(rows.at(-1)!.rank, rows.length);
});

test("export pages forward and prune keeps 90 days", async () => {
  const db = memoryD1();
  for (let ts = NOW - 100 * D; ts <= NOW; ts += 6 * 3600) {
    await recordPrices(db as never, { BTC: 1, ETH: 2 }, {}, ts);
  }
  let since = 0;
  let seen = 0;
  for (let page = 0; page < 100; page++) {
    const out = await readExport(db as never, since, 100);
    seen += out.points.length;
    since = out.next_since;
    if (out.complete) break;
  }
  const total = (db.raw.prepare("SELECT COUNT(*) AS n FROM price_points").get() as any).n;
  assert.ok(seen >= total, `export saw ${seen} of ${total}`);

  await prunePoints(db as never, NOW);
  const oldest = (db.raw.prepare("SELECT MIN(ts) AS ts FROM price_points").get() as any).ts;
  assert.ok(oldest >= NOW - POINT_RETENTION);
  // Hourly candles are never pruned.
  const candles = (db.raw.prepare("SELECT MIN(ts) AS ts FROM price_hourly").get() as any).ts;
  assert.ok(candles < NOW - 90 * D);
});

test("history endpoints refuse cleanly without a D1 binding", async () => {
  const res = await worker.fetch(new Request("https://prices.test/v1/markets"), { PRICES: {} } as never);
  assert.equal(res.status, 503);
});

test("history endpoint validates its query", async () => {
  const env = { PRICES: {}, HISTORY: memoryD1() } as never;
  assert.equal((await worker.fetch(new Request("https://prices.test/v1/history?coin=SHIB"), env)).status, 400);
  assert.equal((await worker.fetch(new Request("https://prices.test/v1/history?coin=BTC&interval=1m"), env)).status, 400);
  const ok = await worker.fetch(new Request("https://prices.test/v1/history?coin=BTC&interval=5m"), env);
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json() as any).points, []);
});

test("dogecoin carries forward from its anchor, and implausible supply is refused", async () => {
  assert.equal(dogeSupply(6_430_020), 156_472_702_863.23425);
  assert.equal(dogeSupply(6_430_021), 156_472_712_863.23425);

  const db = memoryD1();
  await recordSupply(db as never, { DOGE: { circulating: 156e9, source: "a" } }, NOW - 3600);
  // A Blockchair-style bad answer, 10% high, is not recorded.
  assert.equal(await recordSupply(db as never, { DOGE: { circulating: 172e9, source: "b" } }, NOW), 0);
  assert.equal(await recordSupply(db as never, { DOGE: { circulating: 156.01e9, source: "c" } }, NOW), 1);
  const rows = db.raw.prepare("SELECT circulating FROM supply_points ORDER BY ts").all().map((r: any) => r.circulating);
  assert.deepEqual(rows, [156e9, 156.01e9]);
});
