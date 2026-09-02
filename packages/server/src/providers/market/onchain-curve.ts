import { createHash } from 'node:crypto';
import { PublicKey, type Connection } from '@solana/web3.js';
import { PUMP_PROGRAM_IDS, type ExecutionNetwork } from '@solcoin/shared';
import { safeErrorText } from '../../core/errors.js';
import { componentLogger } from '../../core/logger.js';
import type { MarketProvider, ProviderStatus, TokenMarketData } from '../types.js';

/**
 * The chain itself as a market data source.
 *
 * Every other market provider is an indexer: pump.fun's API, DexScreener,
 * Jupiter. They are richer — holders, volume, trade counts — and they are
 * also the reason a freshly launched token can be invisible to the platform
 * for its first minutes, unreachable during a third-party outage, and never
 * visible at all on devnet, where none of them index anything.
 *
 * This provider reads the bonding-curve account straight from RPC and derives
 * what the curve alone can tell: price, market cap, curve progress, whether it
 * has graduated, and the SOL actually sitting in it. It cannot know holders or
 * volume, and it says so by leaving those fields undefined rather than
 * inventing them.
 *
 * It is registered last, so on mainnet an indexer's fuller answer wins and
 * this fills in only for mints they have not seen. On devnet it is the only
 * provider that can answer, which is what makes the devnet rehearsal able to
 * confirm that monitoring picks up a token the platform has just created.
 *
 * The account is decoded here rather than through the SDK. The layout is
 * eight bytes of Anchor discriminator followed by five u64 reserves, the
 * completion flag, the creator, two more flags and the quote mint — 115 bytes
 * in full, with older curves shorter and missing the trailing fields, which
 * the SDK also treats as zero. Decoding by hand keeps this module free of the
 * SDK's CommonJS interop and lets its arithmetic be tested against bytes.
 */

export const BONDING_CURVE_SEED = 'bonding-curve';

/** Anchor account discriminator: the first 8 bytes of sha256("account:BondingCurve"). */
export const BONDING_CURVE_DISCRIMINATOR: Buffer = createHash('sha256')
  .update('account:BondingCurve')
  .digest()
  .subarray(0, 8);

/** Length of the current layout; older accounts are padded up to it. */
export const BONDING_CURVE_FULL_LENGTH = 115;

const TOKEN_DECIMALS = 6;
const SOL_DECIMALS = 9;
const NATIVE_MINT = 'So11111111111111111111111111111111111111112';
const DEFAULT_PUBKEY = PublicKey.default.toBase58();

/**
 * Real token reserves a curve opens with, in base units, when the global
 * account cannot be read. This is mainnet's figure and is used only as a
 * fallback: progress is reported against it and marked estimated in the logs.
 */
export const FALLBACK_INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n;

export interface DecodedBondingCurve {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: string;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  quoteMint: string;
  /** True when the curve is priced in SOL, which is what every figure below assumes. */
  quoteIsSol: boolean;
}

export function bondingCurveAddress(mint: string | PublicKey): PublicKey {
  const key = typeof mint === 'string' ? new PublicKey(mint) : mint;
  return PublicKey.findProgramAddressSync(
    [Buffer.from(BONDING_CURVE_SEED), key.toBuffer()],
    new PublicKey(PUMP_PROGRAM_IDS.pump),
  )[0];
}

/** Decode a bonding-curve account. Returns null for anything that is not one. */
export function decodeBondingCurve(raw: Uint8Array): DecodedBondingCurve | null {
  if (raw.length < 8 + 5 * 8 + 1) return null;
  const data = Buffer.alloc(Math.max(raw.length, BONDING_CURVE_FULL_LENGTH));
  Buffer.from(raw).copy(data);
  if (!data.subarray(0, 8).equals(BONDING_CURVE_DISCRIMINATOR)) return null;

  let offset = 8;
  const u64 = (): bigint => {
    const value = data.readBigUInt64LE(offset);
    offset += 8;
    return value;
  };
  const bool = (): boolean => data[offset++] !== 0;
  const pubkey = (): string => {
    const value = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    return value;
  };

  const virtualTokenReserves = u64();
  const virtualQuoteReserves = u64();
  const realTokenReserves = u64();
  const realQuoteReserves = u64();
  const tokenTotalSupply = u64();
  const complete = bool();
  const creator = pubkey();
  const isMayhemMode = bool();
  const isCashbackCoin = bool();
  const quoteMint = pubkey();

  return {
    virtualTokenReserves,
    virtualQuoteReserves,
    realTokenReserves,
    realQuoteReserves,
    tokenTotalSupply,
    complete,
    creator,
    isMayhemMode,
    isCashbackCoin,
    quoteMint,
    // An all-zero quote mint is what curves written before the field existed
    // carry, and those were all SOL.
    quoteIsSol: quoteMint === DEFAULT_PUBKEY || quoteMint === NATIVE_MINT,
  };
}

export interface CurveMetrics {
  priceSol?: number;
  marketCapSol?: number;
  marketCapUsd?: number;
  liquiditySol: number;
  liquidityUsd?: number;
  /** 0..1, against the reserves the curve opened with. 1 once complete. */
  bondingCurveProgress: number;
  graduated: boolean;
}

/**
 * What the curve's reserves say about the market.
 *
 * Price is the constant-product spot price: quote reserves over token
 * reserves, corrected for the two assets' decimals. Market cap is that price
 * over the total supply, which is the figure pump.fun itself shows. Progress
 * is how much of the opening real token reserve has been sold.
 */
export function curveMetrics(
  curve: DecodedBondingCurve,
  options: { initialRealTokenReserves: bigint; solPriceUsd: number | null },
): CurveMetrics {
  const graduated = curve.complete;
  const initial = options.initialRealTokenReserves > 0n ? options.initialRealTokenReserves : FALLBACK_INITIAL_REAL_TOKEN_RESERVES;
  const sold = Number(initial - curve.realTokenReserves) / Number(initial);
  const bondingCurveProgress = graduated ? 1 : Math.min(1, Math.max(0, sold));
  const liquiditySol = Number(curve.realQuoteReserves) / 10 ** SOL_DECIMALS;

  const metrics: CurveMetrics = {
    liquiditySol,
    bondingCurveProgress,
    graduated,
  };
  if (options.solPriceUsd && options.solPriceUsd > 0) metrics.liquidityUsd = liquiditySol * options.solPriceUsd;

  if (!curve.quoteIsSol || curve.virtualTokenReserves === 0n) return metrics;

  const priceSol =
    (Number(curve.virtualQuoteReserves) / Number(curve.virtualTokenReserves)) *
    10 ** (TOKEN_DECIMALS - SOL_DECIMALS);
  const marketCapSol = priceSol * (Number(curve.tokenTotalSupply) / 10 ** TOKEN_DECIMALS);
  metrics.priceSol = priceSol;
  metrics.marketCapSol = marketCapSol;
  if (options.solPriceUsd && options.solPriceUsd > 0) metrics.marketCapUsd = marketCapSol * options.solPriceUsd;
  return metrics;
}

/** The slice of the RPC client this provider needs; `SolanaRpc` satisfies it. */
export interface CurveRpc {
  call<T>(operation: string, fn: (connection: Connection) => Promise<T>): Promise<T>;
  getSlot(): Promise<number>;
  readonly connection: Connection;
}

export interface OnChainCurveProviderOptions {
  rpc: CurveRpc;
  network: ExecutionNetwork;
  solPriceUsd?: () => Promise<number | null>;
  /**
   * Reads the reserves a new curve opens with, from the program's global
   * account. Injected for tests; the default goes through the SDK.
   */
  readInitialRealTokenReserves?: () => Promise<bigint>;
  now?: () => number;
}

const GLOBAL_CACHE_TTL_MS = 60 * 60_000;
const BATCH = 100;

export function createOnChainCurveProvider(options: OnChainCurveProviderOptions): MarketProvider {
  const log = componentLogger('provider.onchain-curve');
  const now = options.now ?? Date.now;
  const { rpc, network } = options;

  const readInitialReserves =
    options.readInitialRealTokenReserves ??
    (async (): Promise<bigint> => {
      const { OnlinePumpSdk } = await import('@pump-fun/pump-sdk');
      const global = await new OnlinePumpSdk(rpc.connection).fetchGlobal();
      return BigInt(global.initialRealTokenReserves.toString());
    });

  let cachedInitial: { value: bigint; at: number; fallback: boolean } | null = null;
  async function initialRealTokenReserves(): Promise<bigint> {
    if (cachedInitial && now() - cachedInitial.at < GLOBAL_CACHE_TTL_MS) return cachedInitial.value;
    try {
      const value = await readInitialReserves();
      cachedInitial = { value, at: now(), fallback: false };
    } catch (e) {
      // Progress is the only figure this affects, and a slightly wrong
      // progress beats no observation at all. Cached briefly so a flapping
      // RPC is not asked on every poll.
      if (!cachedInitial?.fallback) {
        log.warn({ err: safeErrorText(e, 160) }, 'could not read the global account; curve progress uses the mainnet opening reserves');
      }
      cachedInitial = { value: FALLBACK_INITIAL_REAL_TOKEN_RESERVES, at: now() - GLOBAL_CACHE_TTL_MS + 60_000, fallback: true };
    }
    return cachedInitial.value;
  }

  let lastSuccessAt = 0;
  let lastFailureAt = 0;
  let lastDetail = 'not yet used';

  return {
    id: 'onchain_curve',
    label: 'On-chain bonding curve',
    kind: 'market',

    async healthCheck(): Promise<ProviderStatus> {
      const started = now();
      try {
        const slot = await rpc.getSlot();
        return {
          id: 'onchain_curve',
          label: 'On-chain bonding curve',
          kind: 'market',
          state: 'ok',
          detail: `Reading curve accounts from ${network} RPC, slot ${slot}.`,
          requiresCredentials: false,
          latencyMs: now() - started,
          lastSuccessAt: lastSuccessAt || undefined,
          lastFailureAt: lastFailureAt || undefined,
        };
      } catch (e) {
        return {
          id: 'onchain_curve',
          label: 'On-chain bonding curve',
          kind: 'market',
          state: 'down',
          detail: safeErrorText(e, 160),
          requiresCredentials: false,
          latencyMs: now() - started,
          lastSuccessAt: lastSuccessAt || undefined,
          lastFailureAt: lastFailureAt || undefined,
        };
      }
    },

    async getTokens(mints: readonly string[]): Promise<TokenMarketData[]> {
      const valid: Array<{ mint: string; curve: PublicKey }> = [];
      for (const mint of mints) {
        try {
          valid.push({ mint, curve: bondingCurveAddress(mint) });
        } catch {
          // Not a public key; nothing on chain can answer for it.
        }
      }
      if (valid.length === 0) return [];

      const [solUsd, initial] = await Promise.all([
        options.solPriceUsd ? options.solPriceUsd().catch(() => null) : Promise.resolve(null),
        initialRealTokenReserves(),
      ]);

      const out: TokenMarketData[] = [];
      const programId = PUMP_PROGRAM_IDS.pump;
      for (let i = 0; i < valid.length; i += BATCH) {
        const chunk = valid.slice(i, i + BATCH);
        let infos: Array<{ data: Buffer; owner: PublicKey } | null>;
        try {
          infos = await rpc.call('getMultipleAccountsInfo', (c) =>
            c.getMultipleAccountsInfo(
              chunk.map((v) => v.curve),
              'confirmed',
            ),
          );
          lastSuccessAt = now();
          lastDetail = 'ok';
        } catch (e) {
          lastFailureAt = now();
          lastDetail = safeErrorText(e, 160);
          log.warn({ err: lastDetail }, 'could not read bonding-curve accounts');
          throw e;
        }

        const observedAt = now();
        chunk.forEach((item, index) => {
          const info = infos[index];
          if (!info || info.owner.toBase58() !== programId) return;
          const curve = decodeBondingCurve(info.data);
          if (!curve) return;
          const metrics = curveMetrics(curve, { initialRealTokenReserves: initial, solPriceUsd: solUsd });
          const record: TokenMarketData = {
            mint: item.mint,
            graduated: metrics.graduated,
            bondingCurveProgress: metrics.bondingCurveProgress,
            source: 'onchain',
            observedAt,
          };
          if (metrics.priceSol !== undefined) record.priceSol = metrics.priceSol;
          if (metrics.priceSol !== undefined && solUsd) record.priceUsd = metrics.priceSol * solUsd;
          if (metrics.marketCapUsd !== undefined) record.marketCapUsd = metrics.marketCapUsd;
          if (metrics.liquidityUsd !== undefined) record.liquidityUsd = metrics.liquidityUsd;
          out.push(record);
        });
      }
      void lastDetail;
      return out;
    },
  };
}
