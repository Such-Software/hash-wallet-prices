// Runs on Node's built-in test runner with type stripping (Node 22.18 or
// later), so the repo needs no test framework: `npm test`.
//
// Every upstream is stubbed. Nonlogs gets a stub too, quoting WOW at three
// times the pool price, so a regression that reads it again shows up both as a
// request and as a moved price. Each stubbed pool also carries a last trade at
// three times its pool price, for the same reason.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";

type Payload = {
  rates: Record<string, number>;
  sources: Record<string, string>;
};

// Kraken's majors in the stub: BTC $80,000, XMR $300, DOGE $0.10.
function pool(base: string, quote: string, price: number, reserveQuote: number) {
  return {
    code: `${base}-${quote}`,
    base,
    quote,
    price: String(price),
    pool_price: String(price),
    price_source: "pool",
    last_trade_price: String(price * 3),
    reserve_base: String(reserveQuote / price),
    reserve_quote: String(reserveQuote),
  };
}

// Three healthy pools: [usd price, quote-side depth in USD].
const HEALTHY = [
  pool("WOW", "XMR", 0.00003, 3),        // $0.0090, $900 deep
  pool("WOW", "BTC", 1.15e-7, 0.01),     // $0.0092, $800 deep
  pool("WOW", "USDT", 0.0089, 60),       // $0.0089, $60 deep
];
const HEALTHY_WOW = (0.009 * 900 + 0.0092 * 800 + 0.0089 * 60) / (900 + 800 + 60);

function memoryKV() {
  const store = new Map<string, string>();
  return {
    async get(key: string, type?: string) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub every upstream; returns the hosts the worker asked for. */
function stubUpstreams(pools: object[] = HEALTHY): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    asked.push(url.hostname);
    switch (url.hostname) {
      case "api.kraken.com":
        return json({
          error: [],
          result: {
            XXBTZUSD: { c: ["80000.0", "1"] },
            XXMRZUSD: { c: ["300.0", "1"] },
            XDGUSD: { c: ["0.10", "1"] },
          },
        });
      case "cexswap.cc":
        if (url.pathname === "/api/amm/public/pairs") return json({ items: pools });
        return json({ items: [{ base: "WOW", last_usd: 0.03, volume7d_usd: 5000, last_trade_at_unix: Date.now() / 1000 }] });
      case "api.gateio.ws":
        return json([{ last: "0.0121", highest_bid: "0.0120", lowest_ask: "0.0122" }]);
      case "www.ecb.europa.eu":
        return new Response("<Cube currency='USD' rate='1.10'/><Cube currency='GBP' rate='0.85'/>");
      case "api.nonlogs.io":
        return json({
          markets: {
            "WOW-USDT": { last_price: "0.0261", highest_bid: "0.025", lowest_ask: "0.027", quote_volume: "5000" },
            "WOW-BTC": { last_price: "0.00000033", highest_bid: "0.00000032", lowest_ask: "0.00000034", quote_volume: "0.05" },
          },
        });
      default:
        return new Response("not stubbed", { status: 404 });
    }
  }) as typeof fetch;
  return asked;
}

async function get(path: string, env: { PRICES: ReturnType<typeof memoryKV> }) {
  const res = await worker.fetch(new Request(`https://prices.test${path}`), env as never);
  return res.json() as Promise<any>;
}

async function wow(pools: object[]): Promise<Payload> {
  stubUpstreams(pools);
  return (await get("/v1/prices", { PRICES: memoryKV() })) as Payload;
}

function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}

test("a refresh never asks nonlogs for anything", async () => {
  const asked = stubUpstreams();
  await get("/v1/prices", { PRICES: memoryKV() });
  assert.ok(asked.length > 0, "the refresh should have reached its upstreams");
  assert.ok(!asked.some((h) => h.includes("nonlogs")), `asked: ${asked.join(", ")}`);
});

test("WOW is the depth-weighted price of its pools", async () => {
  const payload = await wow(HEALTHY);
  near(payload.rates.WOW, HEALTHY_WOW);
  for (const source of Object.values(payload.sources)) {
    assert.ok(!source.includes("nonlogs"), source);
  }
});

test("a dust pool does not move the price", async () => {
  // $0.0110, inside the deviation band, so only the depth floor can stop it;
  // $5 of quote reserve.
  const payload = await wow([...HEALTHY, pool("WOW", "USDC", 0.011, 5)]);
  near(payload.rates.WOW, HEALTHY_WOW);
});

test("a deep enough pool far from the median is dropped", async () => {
  // $0.015 against a $0.009 cluster, $200 of DOGE behind it.
  const payload = await wow([...HEALTHY, pool("WOW", "DOGE", 0.15, 2000)]);
  near(payload.rates.WOW, HEALTHY_WOW);
});

test("pools where WOW is the quote, or whose quote has no USD rate, do not vote", async () => {
  const payload = await wow([
    ...HEALTHY,
    pool("BAN", "WOW", 0.0556, 5_000_000),
    pool("WOW", "WRKZ", 15605, 1e9),
  ]);
  near(payload.rates.WOW, HEALTHY_WOW);
});

test("with no qualifying pool, WOW is omitted rather than guessed", async () => {
  stubUpstreams([pool("WOW", "USDT", 0.0089, 10)]);
  const env = { PRICES: memoryKV() };
  const payload = (await get("/v1/prices", env)) as Payload;
  assert.equal(payload.rates.WOW, undefined);
  const v2 = await get("/v2/rates?base=WOW&quote=USD", env);
  assert.equal(v2.results.WOW_USD, 0);
  assert.ok(payload.rates.BTC > 0, "majors still price");
});

test("the oracle does not list nonlogs among the venues it prices from", async () => {
  stubUpstreams();
  const oracle = await get("/v1/oracle", { PRICES: memoryKV() });
  const venues = (oracle.sources as Array<{ venue: string }>).map((s) => s.venue);
  assert.ok(venues.length > 0);
  assert.ok(!venues.includes("nonlogs"), venues.join(", "));
});
