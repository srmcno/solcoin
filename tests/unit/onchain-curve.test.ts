import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { PUMP_PROGRAM_IDS } from '@solcoin/shared';
import {
  BONDING_CURVE_DISCRIMINATOR,
  BONDING_CURVE_FULL_LENGTH,
  bondingCurveAddress,
  createOnChainCurveProvider,
  curveMetrics,
  decodeBondingCurve,
  type CurveRpc,
} from '../../packages/server/src/providers/market/onchain-curve.js';

/**
 * The on-chain market provider decodes bonding-curve accounts by hand. These
 * tests pin the layout to bytes and the arithmetic to figures pump.fun itself
 * displays, so a wrong decimal or a shifted field shows up here rather than
 * as a token the monitor prices a thousand times too high.
 */

/** Mainnet opening state of a fresh curve, from the program's global config. */
const OPENING = {
  virtualTokenReserves: 1_073_000_000_000_000n,
  virtualQuoteReserves: 30_000_000_000n,
  realTokenReserves: 793_100_000_000_000n,
  realQuoteReserves: 0n,
  tokenTotalSupply: 1_000_000_000_000_000n,
};

const CREATOR = new PublicKey(new Uint8Array(32).fill(7));
const NATIVE = 'So11111111111111111111111111111111111111112';

function encodeCurve(input: {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  complete?: boolean;
  creator?: PublicKey;
  isMayhemMode?: boolean;
  isCashbackCoin?: boolean;
  quoteMint?: PublicKey;
  /** Emit only this many bytes, to imitate an older, shorter account. */
  truncateTo?: number;
}): Buffer {
  const buf = Buffer.alloc(BONDING_CURVE_FULL_LENGTH);
  BONDING_CURVE_DISCRIMINATOR.copy(buf, 0);
  let o = 8;
  for (const v of [input.virtualTokenReserves, input.virtualQuoteReserves, input.realTokenReserves, input.realQuoteReserves, input.tokenTotalSupply]) {
    buf.writeBigUInt64LE(v, o);
    o += 8;
  }
  buf[o++] = input.complete ? 1 : 0;
  (input.creator ?? CREATOR).toBuffer().copy(buf, o);
  o += 32;
  buf[o++] = input.isMayhemMode ? 1 : 0;
  buf[o++] = input.isCashbackCoin ? 1 : 0;
  (input.quoteMint ?? PublicKey.default).toBuffer().copy(buf, o);
  return input.truncateTo ? buf.subarray(0, input.truncateTo) : buf;
}

describe('decoding', () => {
  it('uses the Anchor discriminator the program publishes', () => {
    // sha256("account:BondingCurve")[0..8], as in the SDK's IDL.
    expect([...BONDING_CURVE_DISCRIMINATOR]).toEqual([23, 183, 248, 55, 96, 216, 172, 96]);
  });

  it('round-trips every field of a full-length account', () => {
    const curve = decodeBondingCurve(encodeCurve({ ...OPENING, complete: false, isMayhemMode: true }));
    expect(curve).not.toBeNull();
    expect(curve!.virtualTokenReserves).toBe(OPENING.virtualTokenReserves);
    expect(curve!.virtualQuoteReserves).toBe(OPENING.virtualQuoteReserves);
    expect(curve!.realTokenReserves).toBe(OPENING.realTokenReserves);
    expect(curve!.tokenTotalSupply).toBe(OPENING.tokenTotalSupply);
    expect(curve!.complete).toBe(false);
    expect(curve!.creator).toBe(CREATOR.toBase58());
    expect(curve!.isMayhemMode).toBe(true);
    expect(curve!.isCashbackCoin).toBe(false);
    expect(curve!.quoteIsSol).toBe(true);
  });

  it('treats an older, shorter account as SOL-quoted with the trailing flags off', () => {
    // Before the cashback and quote-mint fields existed the account was 81
    // bytes. The SDK pads those to the current length; so does this.
    const curve = decodeBondingCurve(encodeCurve({ ...OPENING, truncateTo: 81 }));
    expect(curve).not.toBeNull();
    expect(curve!.creator).toBe(CREATOR.toBase58());
    expect(curve!.isCashbackCoin).toBe(false);
    expect(curve!.quoteIsSol).toBe(true);
  });

  it('recognises the native mint as a SOL quote and anything else as not', () => {
    expect(decodeBondingCurve(encodeCurve({ ...OPENING, quoteMint: new PublicKey(NATIVE) }))!.quoteIsSol).toBe(true);
    const usdc = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(decodeBondingCurve(encodeCurve({ ...OPENING, quoteMint: usdc }))!.quoteIsSol).toBe(false);
  });

  it('rejects anything without the discriminator', () => {
    const wrong = encodeCurve(OPENING);
    wrong[0] ^= 0xff;
    expect(decodeBondingCurve(wrong)).toBeNull();
    expect(decodeBondingCurve(Buffer.alloc(4))).toBeNull();
  });

  it('derives the curve address from the mint under the pump program', () => {
    const mint = new PublicKey('8hq8jk4VEE28iDhuw6FvyKRjAZoez5tAKw6bdiixpump');
    const expected = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mint.toBuffer()],
      new PublicKey(PUMP_PROGRAM_IDS.pump),
    )[0];
    expect(bondingCurveAddress(mint).equals(expected)).toBe(true);
    expect(bondingCurveAddress(mint.toBase58()).equals(expected)).toBe(true);
  });
});

describe('metrics', () => {
  const initial = OPENING.realTokenReserves;

  it('prices a fresh curve at the market cap pump.fun shows for a new coin', () => {
    const curve = decodeBondingCurve(encodeCurve(OPENING))!;
    const m = curveMetrics(curve, { initialRealTokenReserves: initial, solPriceUsd: 200 });
    // 30 SOL over 1.073B tokens, then across the 1B supply: about 28 SOL.
    expect(m.marketCapSol).toBeCloseTo(27.96, 1);
    expect(m.priceSol).toBeCloseTo(2.796e-8, 11);
    expect(m.marketCapUsd).toBeCloseTo(27.96 * 200, 0);
    expect(m.bondingCurveProgress).toBe(0);
    expect(m.graduated).toBe(false);
    expect(m.liquiditySol).toBe(0);
  });

  it('reports progress as the share of the opening real reserve that has sold', () => {
    const half = decodeBondingCurve(
      encodeCurve({ ...OPENING, realTokenReserves: initial / 2n, realQuoteReserves: 42_000_000_000n }),
    )!;
    const m = curveMetrics(half, { initialRealTokenReserves: initial, solPriceUsd: null });
    expect(m.bondingCurveProgress).toBeCloseTo(0.5, 6);
    expect(m.liquiditySol).toBe(42);
    expect(m.liquidityUsd).toBeUndefined();
    expect(m.marketCapUsd).toBeUndefined();
  });

  it('reports a completed curve as graduated at full progress', () => {
    const done = decodeBondingCurve(encodeCurve({ ...OPENING, realTokenReserves: 0n, complete: true }))!;
    const m = curveMetrics(done, { initialRealTokenReserves: initial, solPriceUsd: 100 });
    expect(m.graduated).toBe(true);
    expect(m.bondingCurveProgress).toBe(1);
  });

  it('never reports a SOL price for a curve quoted in something else', () => {
    const usdc = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const curve = decodeBondingCurve(encodeCurve({ ...OPENING, quoteMint: usdc }))!;
    const m = curveMetrics(curve, { initialRealTokenReserves: initial, solPriceUsd: 100 });
    expect(m.priceSol).toBeUndefined();
    expect(m.marketCapSol).toBeUndefined();
    expect(m.bondingCurveProgress).toBe(0);
  });

  it('clamps progress when the reserve was wound back past its opening figure', () => {
    // Mayhem coins can move backwards; a negative progress would be nonsense.
    const rewound = decodeBondingCurve(encodeCurve({ ...OPENING, realTokenReserves: initial + 1_000n }))!;
    expect(curveMetrics(rewound, { initialRealTokenReserves: initial, solPriceUsd: null }).bondingCurveProgress).toBe(0);
  });
});

describe('provider', () => {
  function fakeRpc(accounts: Record<string, Buffer>, owner = new PublicKey(PUMP_PROGRAM_IDS.pump)): CurveRpc {
    const connection = {
      async getMultipleAccountsInfo(keys: PublicKey[]) {
        return keys.map((k) => {
          const data = accounts[k.toBase58()];
          return data ? { data, owner, lamports: 1, executable: false } : null;
        });
      },
    };
    return {
      call: async (_op, fn) => fn(connection as never),
      getSlot: async () => 123,
      connection: connection as never,
    };
  }

  it('answers for mints whose curve exists and stays silent for the rest', async () => {
    const mint = new PublicKey('8hq8jk4VEE28iDhuw6FvyKRjAZoez5tAKw6bdiixpump');
    const rpc = fakeRpc({ [bondingCurveAddress(mint).toBase58()]: encodeCurve(OPENING) });
    const provider = createOnChainCurveProvider({
      rpc,
      network: 'devnet',
      solPriceUsd: async () => 150,
      readInitialRealTokenReserves: async () => OPENING.realTokenReserves,
      now: () => 1_000,
    });

    const result = await provider.getTokens([mint.toBase58(), CREATOR.toBase58(), 'not-a-key']);
    expect(result).toHaveLength(1);
    const token = result[0]!;
    expect(token.mint).toBe(mint.toBase58());
    expect(token.source).toBe('onchain');
    expect(token.observedAt).toBe(1_000);
    expect(token.graduated).toBe(false);
    expect(token.bondingCurveProgress).toBe(0);
    expect(token.marketCapUsd).toBeCloseTo(27.96 * 150, 0);
    // What the curve cannot tell is left unsaid, not guessed.
    expect(token.holders).toBeUndefined();
    expect(token.volume24hSol).toBeUndefined();
  });

  it('ignores an account at the curve address that the pump program does not own', async () => {
    const mint = new PublicKey('8hq8jk4VEE28iDhuw6FvyKRjAZoez5tAKw6bdiixpump');
    const rpc = fakeRpc({ [bondingCurveAddress(mint).toBase58()]: encodeCurve(OPENING) }, PublicKey.default);
    const provider = createOnChainCurveProvider({
      rpc,
      network: 'mainnet',
      readInitialRealTokenReserves: async () => OPENING.realTokenReserves,
    });
    expect(await provider.getTokens([mint.toBase58()])).toEqual([]);
  });

  it('falls back to the mainnet opening reserve when the global account cannot be read', async () => {
    const mint = new PublicKey('8hq8jk4VEE28iDhuw6FvyKRjAZoez5tAKw6bdiixpump');
    const rpc = fakeRpc({
      [bondingCurveAddress(mint).toBase58()]: encodeCurve({ ...OPENING, realTokenReserves: OPENING.realTokenReserves / 4n }),
    });
    const provider = createOnChainCurveProvider({
      rpc,
      network: 'mainnet',
      readInitialRealTokenReserves: async () => {
        throw new Error('rpc down');
      },
    });
    const [token] = await provider.getTokens([mint.toBase58()]);
    expect(token!.bondingCurveProgress).toBeCloseTo(0.75, 6);
  });

  it('reports health from the RPC without spending a read on a curve', async () => {
    const provider = createOnChainCurveProvider({
      rpc: fakeRpc({}),
      network: 'devnet',
      readInitialRealTokenReserves: async () => OPENING.realTokenReserves,
    });
    const status = await provider.healthCheck();
    expect(status.state).toBe('ok');
    expect(status.requiresCredentials).toBe(false);
    expect(status.detail).toContain('devnet');
  });
});
