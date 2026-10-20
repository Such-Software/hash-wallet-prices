// Runs on Node's built-in test runner with type stripping (Node 22.18 or
// later), so the repo needs no test framework: `npm test`.
//
// Every upstream is stubbed. Nonlogs gets a stub too, quoting WOW at three
// times the cexswap price, so a regression that reads it again shows up both as
// a request and as a moved price.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";

type Payload = {
  rates: Record<string, number>;
  sources: Record<string, string>;
};

const CEXSWAP_WOW = 0.0087;

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
function stubUpstreams(opts: { cexswapWowAgeHours?: number } = {}): string[] {
  const asked: string[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    asked.push(url.hostname);
    switch (url.hostname) {
      case "api.kraken.com":
        return json({ error: [], result: { XXBTZUSD: { c: ["80000.0", "1"] }, XXMRZUSD: { c: ["300.0", "1"] } } });
      case "cexswap.cc":
        return json({
          items: [{
            base: "WOW",
            last_usd: CEXSWAP_WOW,
            volume7d_usd: 500,
            last_trade_at_unix: nowSec - (opts.cexswapWowAgeHours ?? 1) * 3600,
          }],
        });
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

test("a refresh never asks nonlogs for anything", async () => {
  const asked = stubUpstreams();
  await get("/v1/prices", { PRICES: memoryKV() });
  assert.ok(asked.length > 0, "the refresh should have reached its upstreams");
  assert.ok(!asked.some((h) => h.includes("nonlogs")), `asked: ${asked.join(", ")}`);
});

test("WOW is priced from the sources still trusted, untouched by a nonlogs premium", async () => {
  stubUpstreams();
  const payload = (await get("/v1/prices", { PRICES: memoryKV() })) as Payload;
  assert.ok(!(payload.sources.WOW ?? "").includes("nonlogs"), payload.sources.WOW);
  assert.ok(Math.abs(payload.rates.WOW - CEXSWAP_WOW) < 1e-12, String(payload.rates.WOW));
  for (const source of Object.values(payload.sources)) {
    assert.ok(!source.includes("nonlogs"), source);
  }
});

test("with no qualifying source left, WOW is omitted rather than guessed", async () => {
  stubUpstreams({ cexswapWowAgeHours: 48 });
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
