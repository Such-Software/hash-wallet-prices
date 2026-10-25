/**
 * Circulating supply for the market listing. Each coin uses the most direct
 * figure we can get without a market-data aggregator:
 *
 *  - Fixed halving schedules (BTC, LTC) are computed exactly from the block
 *    height, which any explorer reports.
 *    BCH shares Bitcoin's schedule.
 *  - Grin pays a flat 60 GRIN per block, and Dogecoin a flat 10,000 DOGE per
 *    block since block 600,000, so both are computed from height (Dogecoin
 *    from an anchor, since its early rewards were random).
 *  - Coins whose supply depends on history (burns, uncles, tail emission)
 *    read a figure published from chain data: the onion explorer's emission
 *    counter for XMR (xmrchain.net) and WOW (explore.wownero.com, ours),
 *    ultrasound.money for ETH, Blockscout for ETC, and DAI's own
 *    totalSupply().
 *
 * Blockchair is read for BCH's height only. On 2026-10-25 one of its
 * Dogecoin answers was 140,000 blocks ahead of every other explorer and 16B
 * DOGE high, and the next answer was fine, so its supply figures are not used.
 * recordSupply also refuses any figure far from the last one recorded.
 *
 * A failed fetch returns nothing and the listing keeps showing the last
 * recorded figure with its timestamp, so an outage ages the number visibly
 * instead of zeroing it.
 */

export interface Supply {
  circulating: number;
  source: string;
}

type Fetcher = () => Promise<Supply>;

/**
 * Total issued by a halving schedule for blocks 0..height inclusive. Exact in
 * base units: the subsidy halves by right shift, as in Bitcoin's
 * GetBlockSubsidy, so the result matches the node's own arithmetic.
 */
export function halvingSupply(height: number, initialUnits: bigint, interval: number, unitsPerCoin = 1e8): number {
  let remaining = BigInt(height) + 1n;
  let subsidy = initialUnits;
  let total = 0n;
  const step = BigInt(interval);
  while (remaining > 0n && subsidy > 0n) {
    const blocks = remaining < step ? remaining : step;
    total += blocks * subsidy;
    remaining -= blocks;
    subsidy >>= 1n;
  }
  return Number(total) / unitsPerCoin;
}

/**
 * Dogecoin: 10,000 DOGE per block since block 600,000. The early rewards were
 * random, so the total is carried forward from a point where two explorers
 * agreed (dogechain.info totalbc and BlockCypher's height, 2026-10-25).
 */
const DOGE_ANCHOR_HEIGHT = 6_430_020;
const DOGE_ANCHOR_SUPPLY = 156_472_702_863.23425;
export function dogeSupply(height: number): number {
  return DOGE_ANCHOR_SUPPLY + (height - DOGE_ANCHOR_HEIGHT) * 10_000;
}

/** Grin: 60 GRIN for every block, the genesis block included. */
export function grinSupply(height: number): number {
  return 60 * (height + 1);
}

/** 32-byte big-endian word from eth_call, in token units with `decimals`. */
export function uint256ToNumber(hex: string, decimals: number): number {
  const value = BigInt(hex);
  const scale = 10n ** BigInt(decimals);
  // Keep six decimals of precision through the integer division.
  return Number((value * 1_000_000n) / scale) / 1_000_000;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "user-agent": "neroswap-prices/1.0", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${new URL(url).host} http ${res.status}`);
  return (await res.json()) as T;
}

async function tipHeight(url: string): Promise<number> {
  const res = await fetch(url, { headers: { "user-agent": "neroswap-prices/1.0" } });
  if (!res.ok) throw new Error(`${new URL(url).host} http ${res.status}`);
  const height = parseInt((await res.text()).trim(), 10);
  if (!Number.isFinite(height) || height <= 0) throw new Error(`${new URL(url).host} returned no height`);
  return height;
}

/**
 * Circulating supply from an onion explorer's emission monitor. Its `coinbase`
 * total is already net of fees (the monitor subtracts each block's fees before
 * adding), so it is the amount issued. A monitor that is still scanning from
 * genesis reports a partial total; that figure is refused until its block is
 * within EMISSION_MAX_LAG of the explorer's tip, or the 2% guard in
 * recordSupply would later refuse the real one.
 */
export const EMISSION_MAX_LAG = 100;
export function emissionSupply(
  emission: { blk_no?: number; coinbase?: string | number },
  tipHeight: number,
  atomicPerCoin: number,
): number {
  const { blk_no, coinbase } = emission;
  if (typeof blk_no !== "number" || coinbase === undefined) throw new Error("no emission data");
  if (!(tipHeight > 0) || tipHeight - blk_no > EMISSION_MAX_LAG) {
    throw new Error(`emission monitor at block ${blk_no}, tip ${tipHeight}: still scanning`);
  }
  return Number(BigInt(coinbase)) / atomicPerCoin;
}

async function explorerEmission(base: string, atomicPerCoin: number): Promise<number> {
  const [emission, info] = await Promise.all([
    getJson<{ status?: string; data?: { blk_no?: number; coinbase?: string | number } }>(`${base}/api/emission`),
    getJson<{ data?: { height?: number } }>(`${base}/api/networkinfo`),
  ]);
  if (emission.status !== "success" || !emission.data) throw new Error(`${new URL(base).host}: emission monitor off`);
  return emissionSupply(emission.data, info.data?.height ?? 0, atomicPerCoin);
}

const DAI_CONTRACT = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

export const SUPPLY_FETCHERS: Record<string, Fetcher> = {
  BTC: async () => ({
    circulating: halvingSupply(await tipHeight("https://mempool.space/api/blocks/tip/height"), 50n * 100_000_000n, 210_000),
    source: "computed from block height (mempool.space)",
  }),

  LTC: async () => ({
    circulating: halvingSupply(await tipHeight("https://litecoinspace.org/api/blocks/tip/height"), 50n * 100_000_000n, 840_000),
    source: "computed from block height (litecoinspace.org)",
  }),

  BCH: async () => {
    // `blocks` counts the genesis block, so the tip height is one less.
    const body = await getJson<{ data?: { blocks?: number } }>("https://api.blockchair.com/bitcoin-cash/stats");
    const blocks = body.data?.blocks;
    if (!(typeof blocks === "number" && blocks > 0)) throw new Error("blockchair bch: no height");
    return {
      circulating: halvingSupply(blocks - 1, 50n * 100_000_000n, 210_000),
      source: "computed from block height (blockchair.com)",
    };
  },

  DOGE: async () => {
    const body = await getJson<{ height?: number }>("https://api.blockcypher.com/v1/doge/main");
    if (!(typeof body.height === "number" && body.height >= DOGE_ANCHOR_HEIGHT)) throw new Error("blockcypher doge: no height");
    return { circulating: dogeSupply(body.height), source: "computed from block height (blockcypher.com)" };
  },

  XMR: async () => ({
    circulating: await explorerEmission("https://xmrchain.net", 1e12),
    source: "xmrchain.net emission",
  }),

  WOW: async () => ({
    circulating: await explorerEmission("https://explore.wownero.com", 1e11),
    source: "explore.wownero.com emission",
  }),

  ETH: async () => {
    const body = await getJson<{ m5?: { supply: number }[] }>("https://ultrasound.money/api/v2/fees/supply-over-time");
    const latest = body.m5?.[body.m5.length - 1]?.supply;
    if (!(typeof latest === "number" && latest > 0)) throw new Error("ultrasound: no supply");
    return { circulating: latest, source: "ultrasound.money" };
  },

  ETC: async () => {
    const body = await getJson<{ status?: string; result?: string }>(
      "https://etc.blockscout.com/api?module=stats&action=coinsupply",
    );
    const value = parseFloat(body.result ?? "");
    if (body.status !== "1" || !(value > 0)) throw new Error("blockscout etc: no supply");
    return { circulating: value, source: "etc.blockscout.com" };
  },

  DAI: async () => {
    const body = await getJson<{ result?: string }>("https://ethereum-rpc.publicnode.com", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: DAI_CONTRACT, data: "0x18160ddd" }, "latest"], // totalSupply()
      }),
    });
    if (!body.result || body.result === "0x") throw new Error("dai totalSupply: empty result");
    return { circulating: uint256ToNumber(body.result, 18), source: "DAI totalSupply() on Ethereum" };
  },

  GRIN: async () => {
    // Any Grin node knows the height; this pool's public stats are the one
    // keyless HTTPS source that answered reliably.
    const body = await getJson<{ nodes?: { height?: string }[] }>("https://grin.2miners.com/api/stats");
    const height = parseInt(body.nodes?.[0]?.height ?? "", 10);
    if (!(height > 0)) throw new Error("2miners grin: no height");
    return { circulating: grinSupply(height), source: "computed from block height (2miners.com)" };
  },
};

/** Fetch every coin's supply; failures are logged and left out. */
export async function fetchAllSupply(coins: readonly string[]): Promise<Record<string, Supply>> {
  const out: Record<string, Supply> = {};
  await Promise.all(
    coins.map(async (coin) => {
      const fetcher = SUPPLY_FETCHERS[coin];
      if (!fetcher) return;
      try {
        const supply = await fetcher();
        if (Number.isFinite(supply.circulating) && supply.circulating > 0) out[coin] = supply;
      } catch (e) {
        console.error(`supply ${coin} failed`, e);
      }
    }),
  );
  return out;
}
