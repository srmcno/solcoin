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
