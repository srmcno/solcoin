import { describe, expect, it } from 'vitest';
import { createDexScreenerProvider } from '../../packages/server/src/providers/market/dexscreener.js';
import { computeSaturation } from '@solcoin/shared';
import type { HttpClient } from '../../packages/server/src/providers/http.js';

/**
 * Units, where two of them are in play.
 *
 * Aggregators report volume in USD. It is converted to SOL for display, and
 * the saturation scorer weighs it against USD thresholds. Carrying only the
 * converted figure and then comparing it against a dollar threshold made a
 * competitor doing real money look like one doing pocket change, which let
 * crowded concepts through the gate that exists to stop them.
 */

function fakeHttp(payload: unknown): HttpClient {
  return {
    circuitOpen: false,
    circuitOpenUntilMs: 0,
    request: async () => payload,
  } as unknown as HttpClient;
}

const SOL_USD = 105;

const searchPayload = {
  pairs: [
    {
      chainId: 'solana',
      dexId: 'raydium',
      pairAddress: 'Pair11111111111111111111111111111111111111',
      baseToken: { address: 'Mint11111111111111111111111111111111111111', name: 'Rival', symbol: 'RIVAL' },
      quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
      priceUsd: '0.004',
      volume: { h24: 525_000, h6: 100_000, h1: 20_000, m5: 2_000 },
      txns: { h24: { buys: 900, sells: 700 } },
      liquidity: { usd: 90_000 },
      marketCap: 4_000_000,
      pairCreatedAt: 1_780_000_000_000,
    },
  ],
};

describe('market data units', () => {
  it('reports the 24-hour volume in both SOL and USD', async () => {
    const provider = createDexScreenerProvider({
      http: fakeHttp(searchPayload),
      discoveryHttp: fakeHttp(searchPayload),
      solPriceUsd: async () => SOL_USD,
    });

    const [token] = await provider.searchTokens('rival');
    expect(token).toBeDefined();
    // The USD figure is the one the aggregator actually reported, not a
    // round-trip through a SOL price that may not be the rate used.
    expect(token?.volume24hUsd).toBe(525_000);
    expect(token?.volume24hSol).toBeCloseTo(525_000 / SOL_USD, 6);
  });

  it('leaves the SOL figure undefined when no rate is known, and keeps the USD one', async () => {
    const provider = createDexScreenerProvider({
      http: fakeHttp(searchPayload),
      discoveryHttp: fakeHttp(searchPayload),
    });

    const [token] = await provider.searchTokens('rival');
    expect(token?.volume24hSol).toBeUndefined();
    expect(token?.volume24hUsd).toBe(525_000);
  });

  it('scores a serious competitor as one, which the SOL figure did not', () => {
    const competitor = (volume24hUsd: number) => ({
      mint: 'Mint11111111111111111111111111111111111111',
      name: 'Rival',
      symbol: 'RIVAL',
      createdAtMs: 1_780_000_000_000,
      marketCapUsd: 4_000_000,
      volume24hUsd,
      holders: 900,
      graduated: true,
    });

    const concept = {
      name: 'Rival Coin',
      symbol: 'RIVL',
      keywords: ['rival'],
      embedding: undefined,
      nowMs: 1_780_050_000_000,
    };

    const inUsd = computeSaturation({ ...concept, competitors: [competitor(525_000)] });
    const inSol = computeSaturation({ ...concept, competitors: [competitor(525_000 / SOL_USD)] });

    // Same competitor, same money, two units. If the difference were nil the
    // unit error would have been harmless; it is not.
    expect(inUsd.score).toBeGreaterThan(inSol.score);
  });
});

describe('launch cost estimation', () => {
  /**
   * The reservation this feeds is what the SOL spend caps are counted against.
   * The previous allowance was a round 6,000,000 lamports, described in its own
   * comment as deliberately conservative, and it was short of the measured
   * mainnet cost by about 30% — so every cap admitted more than it was set to.
   */
  it('covers the rent a launch actually pays', async () => {
    const { estimatedLaunchCostLamports, LAUNCH_RENT_LAMPORTS, LAUNCH_NETWORK_FEE_LAMPORTS } = await import(
      '@solcoin/shared'
    );

    // Measured on mainnet: mint + bonding curve + the curve's token account.
    const measuredRent =
      LAUNCH_RENT_LAMPORTS.mint + LAUNCH_RENT_LAMPORTS.bondingCurve + LAUNCH_RENT_LAMPORTS.associatedTokenAccount;
    expect(measuredRent).toBe(7_461_120);

    const estimate = estimatedLaunchCostLamports(0);
    expect(estimate).toBeGreaterThanOrEqual(measuredRent + LAUNCH_NETWORK_FEE_LAMPORTS);
    // And decisively above the figure it replaced.
    expect(estimate).toBeGreaterThan(6_000_000);
  });

  it('adds the creator token account only when there is a developer buy', async () => {
    const { estimatedLaunchCostLamports, LAUNCH_RENT_LAMPORTS } = await import('@solcoin/shared');
    const devBuy = 50_000_000;
    const withBuy = estimatedLaunchCostLamports(devBuy);
    const without = estimatedLaunchCostLamports(0);

    // The buy itself, plus somewhere for the tokens it buys to land.
    expect(withBuy - without).toBe(devBuy + LAUNCH_RENT_LAMPORTS.associatedTokenAccount);
  });

  it('never returns less than the deposit for a negative input', async () => {
    const { estimatedLaunchCostLamports } = await import('@solcoin/shared');
    expect(estimatedLaunchCostLamports(-1)).toBe(estimatedLaunchCostLamports(0));
  });
});

describe('coins are launched in creator-fee mode', () => {
  /**
   * Pump.fun's Cashback Coins redirect the entire 0.30% creator leg of every
   * bonding-curve trade to traders instead of the creator vault, and the mode
   * is fixed at creation and locked permanently. A coin launched in cashback
   * mode earns its creator nothing on the curve, ever.
   *
   * The SDK defaults `cashback` to false, so omitting it works today. This
   * guards against it being dropped again, or against a dependency upgrade
   * flipping that default — either of which would silently make every future
   * launch unable to earn, with nothing failing and nothing visible in a diff.
   *
   * A source assertion, deliberately: the behaviour it protects can only be
   * observed on mainnet, and the realistic failure is the argument going away
   * during a refactor rather than the protocol changing under us.
   */
  it('passes cashback: false to every create instruction', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(
      resolve(process.cwd(), 'packages/server/src/providers/solana/pumpfun-adapter.ts'),
      'utf8',
    );

    // Each create call's argument object, delimited by brace matching rather
    // than a regex — a non-greedy pattern stops at the first `})` and silently
    // matches a fragment, which is how the first version of this test passed
    // while an argument was missing.
    const calls: string[] = [];
    const opener = /createV2(?:AndBuy)?Instructions?\(\{/g;
    for (let m = opener.exec(source); m !== null; m = opener.exec(source)) {
      let depth = 1;
      let i = m.index + m[0].length;
      while (i < source.length && depth > 0) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') depth--;
        i++;
      }
      calls.push(source.slice(m.index, i));
    }

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      // Comments stripped first. The block comment beside the argument quotes
      // `cashback: false` verbatim, so matching the raw text passed even with
      // the argument deleted — which is exactly the failure this test exists
      // to catch, and it did not catch it until the comment was excluded.
      const code = call.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, 'a create call is missing an explicit cashback: false').toMatch(/\bcashback:\s*false\b/);
    }
  });
});
