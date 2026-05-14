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
| `GET /healthz` | `{ ok: true, coins: N, fetched_at: ... }` |

USD-only for now. Other `quote` values return 0 and the wallet falls back to "price unavailable."

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
