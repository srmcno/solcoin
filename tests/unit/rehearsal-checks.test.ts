import { describe, expect, it } from 'vitest';
import { CURVE_VAULT_RENT_LAMPORTS, screenRisk, solToLamports } from '@solcoin/shared';
import {
  GENESIS_HASHES,
  assertDevnetGenesis,
  expectedCreatorFeeLamports,
  explorerUrl,
  liveCreatorFeeBps,
  minimumBuyLamportsForClaim,
  parseRehearsalArgs,
  rehearsalFixture,
  rehearsalVerdict,
  requiredFundingLamports,
} from '../../packages/server/src/cli/rehearsal-checks.js';
import { balanceIsStale } from '../../packages/server/src/services/wallet.service.js';

/**
 * The rehearsal signs a purchase of its own token. That is a protocol test on
 * devnet and self-trading anywhere real, so the parts that keep it on devnet
 * and the parts that size it are pinned here.
 */

describe('the devnet gate', () => {
  it('accepts devnet by genesis hash', () => {
    expect(() => assertDevnetGenesis(GENESIS_HASHES.devnet)).not.toThrow();
  });

  it('refuses mainnet, naming it', () => {
    expect(() => assertDevnetGenesis(GENESIS_HASHES.mainnet)).toThrow(/MAINNET/);
  });

  it('refuses a cluster it does not recognise rather than assuming', () => {
    expect(() => assertDevnetGenesis('4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY')).toThrow(/unrecognised/);
  });
});

describe('the fixture token', () => {
  it('passes the same safety screen a generated concept must', () => {
    const fixture = rehearsalFixture(Date.UTC(2026, 8, 2, 16, 34));
    expect(screenRisk(fixture.name, fixture.symbol, fixture.description).blocked).toBe(false);
  });

  it('fits pump.fun limits and says what it is', () => {
    const fixture = rehearsalFixture(Date.UTC(2026, 8, 2, 16, 34));
    expect(fixture.name.length).toBeLessThanOrEqual(32);
    expect(fixture.symbol.length).toBeLessThanOrEqual(10);
    expect(fixture.name).toBe('Solcoin Rehearsal 0902-1634');
    expect(fixture.description).toMatch(/devnet/i);
    expect(fixture.description).toMatch(/no value/i);
  });
});

describe('sizing the test buy', () => {
  it('computes the creator leg at 30 bps of the SOL side', () => {
    expect(expectedCreatorFeeLamports(solToLamports(1))).toBe(3_000_000);
    expect(expectedCreatorFeeLamports(0)).toBe(0);
  });

  it('requires a buy whose fee clears the stranded rent with headroom', () => {
    const minimum = minimumBuyLamportsForClaim();
    // The fee it deposits must exceed the rent the vault keeps forever.
    expect(expectedCreatorFeeLamports(minimum)).toBeGreaterThan(CURVE_VAULT_RENT_LAMPORTS);
    expect(expectedCreatorFeeLamports(minimum) - CURVE_VAULT_RENT_LAMPORTS).toBeGreaterThanOrEqual(99_999);
    // About a third of a SOL at mainnet's 30 bps.
    expect(minimum).toBeGreaterThan(solToLamports(0.33));
    expect(minimum).toBeLessThan(solToLamports(0.34));
  });

  it('sizes the buy from the live rate, so devnet at 5 bps needs six times more', () => {
    const devnet = minimumBuyLamportsForClaim({ creatorFeeBps: 5 });
    // Six times the mainnet figure, give or take the ceiling on each.
    expect(Math.abs(devnet - minimumBuyLamportsForClaim({ creatorFeeBps: 30 }) * 6)).toBeLessThanOrEqual(10);
    expect(expectedCreatorFeeLamports(devnet, 5)).toBeGreaterThan(CURVE_VAULT_RENT_LAMPORTS);
  });

  it('reads the creator rate the way the program does', () => {
    // No fee-config account: the global flat rate.
    expect(liveCreatorFeeBps({ globalCreatorFeeBps: 5, feeTiers: null, openingMarketCapLamports: 1_000 })).toBe(5);
    expect(liveCreatorFeeBps({ globalCreatorFeeBps: 5, feeTiers: [], openingMarketCapLamports: 1_000 })).toBe(5);
    // With one: the highest tier at or below the market cap, else the first.
    const tiers = [
      { marketCapLamportsThreshold: 0, creatorBps: 30 },
      { marketCapLamportsThreshold: 420_000_000_000, creatorBps: 95 },
      { marketCapLamportsThreshold: 1_000_000_000_000, creatorBps: 88 },
    ];
    expect(liveCreatorFeeBps({ globalCreatorFeeBps: 5, feeTiers: tiers, openingMarketCapLamports: 28_000_000_000 })).toBe(30);
    expect(liveCreatorFeeBps({ globalCreatorFeeBps: 5, feeTiers: tiers, openingMarketCapLamports: 500_000_000_000 })).toBe(95);
    expect(liveCreatorFeeBps({ globalCreatorFeeBps: 5, feeTiers: tiers, openingMarketCapLamports: 5_000_000_000_000 })).toBe(88);
  });

  it('funds the floor, the launch reserve, the buy, and an allowance', () => {
    const required = requiredFundingLamports({ floorLamports: 50_000_000, launchReserveLamports: 10_000_000, buyLamports: 400_000_000 });
    expect(required).toBeGreaterThan(460_000_000);
    expect(required).toBeLessThan(470_000_000);
    expect(requiredFundingLamports({ floorLamports: 0, launchReserveLamports: 0, buyLamports: -5 })).toBe(
      requiredFundingLamports({ floorLamports: 0, launchReserveLamports: 0, buyLamports: 0 }),
    );
  });
});

describe('judging a run', () => {
  it('is a pass only when nothing failed or blocked', () => {
    const verdict = rehearsalVerdict([
      { step: 'a', status: 'passed', detail: '' },
      { step: 'b', status: 'skipped', detail: '' },
    ]);
    expect(verdict.ok).toBe(true);
    expect(verdict.exitCode).toBe(0);
  });

  it('distinguishes being blocked on funding from a platform failure', () => {
    const blocked = rehearsalVerdict([{ step: 'Wallet is funded', status: 'blocked', detail: 'holds 0 SOL' }]);
    expect(blocked.exitCode).toBe(3);
    expect(blocked.summary).toContain('Wallet is funded');
    const failed = rehearsalVerdict([
      { step: 'Wallet is funded', status: 'blocked', detail: '' },
      { step: 'Launch', status: 'failed', detail: '' },
    ]);
    expect(failed.exitCode).toBe(1);
  });
});

describe('arguments', () => {
  it('leaves the buy unsized by default so the command can size it from the live rate', () => {
    const args = parseRehearsalArgs([]);
    expect(args.buySol).toBeNull();
    expect(args.skipBuy).toBe(false);
    expect(args.enterDevnet).toBe(false);
  });

  it('accepts both spellings of a valued flag', () => {
    expect(parseRehearsalArgs(['--buy-sol', '0.5']).buySol).toBe(0.5);
    expect(parseRehearsalArgs(['--buy-sol=0.35']).buySol).toBe(0.35);
  });

  it('rejects nonsense rather than running with it', () => {
    expect(() => parseRehearsalArgs(['--buy-sol', 'lots'])).toThrow(/non-negative/);
    expect(() => parseRehearsalArgs(['--mainnet'])).toThrow(/Unknown option/);
  });
});

describe('explorer links', () => {
  it('points devnet transactions at the devnet cluster', () => {
    expect(explorerUrl('tx', 'sig', 'devnet')).toBe('https://solscan.io/tx/sig?cluster=devnet');
    expect(explorerUrl('address', 'addr', 'mainnet')).toBe('https://solscan.io/address/addr');
  });
});

describe('balance staleness', () => {
  it('treats a balance that was never fetched as stale', () => {
    expect(balanceIsStale(null, 1_000_000, 120_000)).toBe(true);
    expect(balanceIsStale(undefined, 1_000_000, 120_000)).toBe(true);
  });

  it('is fresh within the window and stale beyond it', () => {
    expect(balanceIsStale(1_000_000 - 60_000, 1_000_000, 120_000)).toBe(false);
    expect(balanceIsStale(1_000_000 - 120_001, 1_000_000, 120_000)).toBe(true);
  });
});
