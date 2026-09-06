# hash-wallet-prices

Cloudflare Worker that aggregates USD prices for [Hash Wallet](https://github.com/Such-Software/hash-wallet) and serves them at one cached endpoint.

Why this exists: see the architectural notes in the wallet repo. Short version — having every user's phone hit Kraken/NonKYC directly leaks wallet-holder activity to the exchanges and spreads our rate-limit budget across thousands of IPs. One Worker with a cron-refreshed KV cache fixes both.

## Sources

* **Kraken** (`api.kraken.com/0/public/Ticker`) — BTC, XMR, LTC, DOGE, ETH, BCH, XNO (all → USD).
* **Nonlogs.io** (`api.nonlogs.io/api/markets`) — WOW. Algorithm averages `WOW-BTC × Kraken BTC/USD` and `WOW-USDT` when both exist. Lifted from `~/src/smirk-backend/src/infra/prices.rs`.
* **cexswap.cc** (`cexswap.cc/api/public/markets/summary`) — WOW backup. Endpoint returns `last_usd` precomputed per pair, so we average across all WOW spot pairs.
* **Pinned** — USDT, USDC, DAI all return 1.00.

WOW USD price is the **average of whichever Nonlogs and cexswap routes returned a value** — survives one source going down without a code change.

## Endpoints

| Path | Shape |
| --- | --- |
| `GET /v2/rates?base=BTC&quote=USD` | `{ "results": { "BTC_USD": 67342.5 } }` — drop-in compatible with the wallet's existing fetch code |
| `GET /v1/prices` | `{ "rates": { ... }, "sources": { ... }, "fetched_at": "..." }` — preferred, returns everything in one call |
| `GET /v1/sparkline?coin=BTC&hours=24` | `{ coin, hours, points: [[ts_ms, price], ...] }` — hourly buckets, max 168 points (7 days) |
| `POST /v1/trocador-webhook` | Trocador POSTs the full trade body on every status change; we store it under `trade:<id>` for 14 days |
| `GET /v1/trade/:trade_id` | Returns the cached trade body (whatever Trocador last sent for that id), or 404 |
| `GET /healthz` | `{ ok: true, coins: N, fetched_at: ... }` |

Non-USD quotes convert through ECB daily reference rates (fetched each cron run); an unknown quote currency returns 0 and the wallet falls back to "price unavailable."

## Deploy

```bash
npm install
npx wrangler login
npx wrangler kv:namespace create PRICES
# Paste the returned id into wrangler.toml's kv_namespaces.id field.
npx wrangler deploy
```

After first deploy the worker is live at `https://hash-wallet-prices.<your-cloudflare-subdomain>.workers.dev`. To put it behind `prices.suchsoftware.com`, point that hostname's DNS at Cloudflare and uncomment the `[[routes]]` block in `wrangler.toml`.

## Local dev

```bash
npm install
npx wrangler dev          # starts a local server with hot reload
curl localhost:8787/healthz
curl 'localhost:8787/v2/rates?base=BTC&quote=USD'
```

## Adding a coin

1. If Kraken lists it: add `TICKER: "PAIRUSD"` to `KRAKEN_PAIRS` in `src/index.ts`.
2. If only smaller exchanges list it: add a new fetcher function alongside `fetchNonkyc()` and merge its results in `refreshPrices()`. Keep it `try`/`catch` wrapped so a single source failure doesn't poison the whole refresh.

## License

MIT.

## The oracle

`GET /v1/oracle` returns the current rates alongside the method that produced
them, the guard values, and the limits we know about. It is served by the code
that implements it, so it cannot drift from the truth the way a separate
document would.

### What it prices, and from what

| Source | Covers | Price basis |
| --- | --- | --- |
| Kraken | majors | spot ticker |
| Nonlogs | niche tickers, BTC and USDT routes | live book midpoint, falling back to last trade |
| CexSwap | niche tickers, all quote routes | last trade in USD, weighted by 7-day USD volume, expiring after 12 hours |

Niche tickers are volume-weighted across the venues that produce a usable
number.

### Why the book midpoint, and not the last trade

A last print says where somebody traded once. On a market doing a few hundred
dollars a day that can be many hours old, and it can sit at the day's extreme.
The midpoint of the current best bid and ask says where you could trade now,
which is what a price feed is being asked.

The case that prompted the change, on 2026-09-06: Nonlogs WOW-BTC last traded
at 10 sat while its book stood 10 bid, 13 ask. The feed said $0.007989; the
market said $0.009187. Meanwhile CexSwap's WOW-XMR print, carrying $635 of
seven-day volume against Nonlogs' $169, was the 24-hour low and 11.5 hours old.
The feed as a whole read $0.008546 against a cross-venue consensus of $0.009280,
low by 8.6%, and a desk quoting against it refused to bid where the market
actually traded.

### Guards

- **Spread.** A midpoint is only meaningful across a real two-sided book, so
  both sides must exist, the ask must be above the bid, and the spread must be
  at or under 60%. Otherwise the last trade is used. 60% is deliberately loose:
  on these venues a 30% spread is ordinary, while dead pairs show books wider
  than 1000% that must never set a price.
- **Staleness.** A CexSwap print older than 12 hours is dropped. Its summary
  carries no book, so staleness is the only guard available there, and seven
  days of volume can be a single old fill.
- **Dead pairs.** Any pair with no volume is ignored entirely. Without this, a
  stale print on an untraded pair drags the average; WOW-ETH sat at $0.000087
  and WOW-USDT at $0.070 on the same day the coin was worth about $0.009.

### What it does not do

- A midpoint is not depth-weighted. It says where the touch is, not what size
  can trade there.
- CexSwap pool prices are not read directly. Only its last trade is available
  without an authenticated quote, so between trades that source lags the pool
  it describes.
- No source is excluded for being one we quote on ourselves. This is a public
  price index and it prices the market as it finds it; a consumer that needs to
  exclude its own influence has to do that itself.
