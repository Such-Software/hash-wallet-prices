-- Long-term price and supply history for the market listing (neroswap.com/markets)
-- and charts. The cron writes one row per coin every five minutes into
-- price_points, folds the same sample into price_hourly, and once an hour records
-- each coin's circulating supply. price_points is pruned to 90 days; the hourly
-- table and supply are kept indefinitely (about 90k rows a year each for ten coins).

CREATE TABLE IF NOT EXISTS price_points (
  coin TEXT NOT NULL,
  ts INTEGER NOT NULL,      -- unix seconds, start of the five-minute bucket
  price REAL NOT NULL,      -- USD
  source TEXT NOT NULL,     -- kraken, gateio, cexswap-pools, ...
  PRIMARY KEY (coin, ts)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_price_points_ts ON price_points (ts);

CREATE TABLE IF NOT EXISTS price_hourly (
  coin TEXT NOT NULL,
  ts INTEGER NOT NULL,      -- unix seconds, start of the hour
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  samples INTEGER NOT NULL,
  PRIMARY KEY (coin, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS supply_points (
  coin TEXT NOT NULL,
  ts INTEGER NOT NULL,      -- unix seconds, start of the hour
  circulating REAL NOT NULL,
  source TEXT NOT NULL,     -- where the figure came from, shown next to the market cap
  PRIMARY KEY (coin, ts)
) WITHOUT ROWID;
