import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { createHarness, type TestHarness } from '../helpers.js';
import { SimulationLaunchAdapter } from '../../packages/server/src/providers/solana/simulation-adapter.js';
import { MonitoringService } from '../../packages/server/src/services/monitoring.service.js';
import { TIME } from '@solcoin/shared';

/**
 * The simulated world is where the platform builds its priors before it spends
 * anything real, so a simulation that inflates revenue or forgets its own
 * tokens does not fail loudly — it teaches the model the wrong thing.
 */

let harness: TestHarness;

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => harness.cleanup());

const payer = Keypair.fromSeed(new Uint8Array(32).fill(9));

async function launchSimulated(adapter: SimulationLaunchAdapter, symbol: string): Promise<string> {
  const plan = await adapter.prepare(
    {
      idempotencyKey: `key-${symbol}`,
      name: `Token ${symbol}`,
      symbol,
      description: 'a simulated token',
      metadataUri: 'https://example.invalid/m.json',
      devBuyLamports: 0,
      slippageBps: 500,
      priorityFeeMicroLamports: 0,
      network: 'simulation',
    },
    payer.publicKey.toBase58(),
  );
  await adapter.execute(plan, payer);
  return plan.mintAddress;
}

/** A mint whose drawn destiny actually earns fees, so the maths is exercised. */
async function launchEarningToken(adapter: SimulationLaunchAdapter): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const mint = await launchSimulated(adapter, `SIM${i}`);
    const market = adapter.getSimulatedMarket(mint, harness.clock.now() + 6 * TIME.hour);
    if (market.cumulativeVolumeSol > 5) return mint;
  }
  throw new Error('no simulated token drew a tradeable destiny');
}

describe('simulated creator fees are earned once', () => {
  /**
   * Accrual is computed from cumulative volume, which only grows. Zeroing the
   * vault on a claim without recording the claim meant the next accrual pass
   * refilled it from that same cumulative total — the platform re-earned a
   * token's entire fee history on every collection cycle, and that fabricated
   * revenue fed straight into experiment outcomes and the learning model.
   */
  it('does not refill the vault with fees that were already swept', async () => {
    const adapter = new SimulationLaunchAdapter({ now: () => harness.clock.now() });
    const mint = await launchEarningToken(adapter);
    const creator = payer.publicKey.toBase58();

    harness.clock.advance(6 * TIME.hour);
    adapter.accrueFees(mint, creator, 0.0005, 0.0005);
    const first = await adapter.getAccruedFees(creator);
    expect(first.totalClaimableLamports).toBeGreaterThan(0);

    const plan = await adapter.prepareFeeClaim(creator);
    expect(plan).not.toBeNull();
    const claim = await adapter.executeFeeClaim(plan!, payer);
    expect(claim.claimedLamports).toBe(first.totalClaimableLamports);

    // The vault is empty, and an accrual pass immediately afterwards must not
    // put the same lamports back into it.
    adapter.accrueFees(mint, creator, 0.0005, 0.0005);
    const second = await adapter.getAccruedFees(creator);
    expect(second.totalClaimableLamports).toBe(0);

    // Only genuinely new volume earns again.
    harness.clock.advance(2 * TIME.hour);
    adapter.accrueFees(mint, creator, 0.0005, 0.0005);
    const third = await adapter.getAccruedFees(creator);
    expect(third.totalClaimableLamports).toBeGreaterThan(0);
    expect(third.totalClaimableLamports).toBeLessThan(first.totalClaimableLamports);
  });
});

describe('simulated state survives a restart', () => {
  /**
   * The destiny of a simulated token lived only in the adapter instance, and a
   * fresh instance is built on every provider refresh — every credential save,
   * every settings change, every boot. Afterwards `getSimulatedMarket` reported
   * `exists: false` for tokens that were still in the database and on every
   * dashboard: no observations, no fee accrual, no learning samples, and
   * nothing anywhere saying so.
   */
  it('rebuilds a token with exactly the fate it was launched with', async () => {
    const first = new SimulationLaunchAdapter({ now: () => harness.clock.now() });
    const mint = await launchEarningToken(first);
    const createdAt = harness.clock.now();

    harness.clock.advance(4 * TIME.hour);
    const before = first.getSimulatedMarket(mint);

    // What a provider refresh or a restart produces.
    const replacement = new SimulationLaunchAdapter({ now: () => harness.clock.now() });
    expect(replacement.getSimulatedMarket(mint).exists).toBe(false);

    replacement.ensureToken(mint, createdAt);
    const after = replacement.getSimulatedMarket(mint);

    expect(after.exists).toBe(true);
    expect(after.volume24hSol).toBeCloseTo(before.volume24hSol, 9);
    expect(after.holders).toBe(before.holders);
    expect(after.graduated).toBe(before.graduated);
  });

  it('does not overwrite a token it already knows', async () => {
    const adapter = new SimulationLaunchAdapter({ now: () => harness.clock.now() });
    const mint = await launchEarningToken(adapter);
    harness.clock.advance(3 * TIME.hour);
    const before = adapter.getSimulatedMarket(mint);

    // A rehydration pass running against a live adapter must be a no-op.
    adapter.ensureToken(mint, harness.clock.now());
    expect(adapter.getSimulatedMarket(mint).volume24hSol).toBeCloseTo(before.volume24hSol, 9);
  });

  it('restores the lifetime swept total so a restart cannot re-collect', async () => {
    const adapter = new SimulationLaunchAdapter({ now: () => harness.clock.now() });
    const mint = await launchEarningToken(adapter);
    const creator = payer.publicKey.toBase58();
    const createdAt = harness.clock.now();

    harness.clock.advance(6 * TIME.hour);
    adapter.accrueFees(mint, creator, 0.0005, 0.0005);
    const accrued = await adapter.getAccruedFees(creator);
    const plan = await adapter.prepareFeeClaim(creator);
    await adapter.executeFeeClaim(plan!, payer);

    const replacement = new SimulationLaunchAdapter({ now: () => harness.clock.now() });
    replacement.ensureToken(mint, createdAt);
    replacement.restoreClaimed(creator, accrued.totalClaimableLamports);

    replacement.accrueFees(mint, creator, 0.0005, 0.0005);
    expect((await replacement.getAccruedFees(creator)).totalClaimableLamports).toBe(0);
  });
});

describe('monitoring polls only the network it has providers for', () => {
  /**
   * The due-token query returned every network's tokens and the monitor
   * processed them with whichever providers were loaded. On simulation that
   * hands a real mainnet token a synthetic market; on mainnet it asks an
   * aggregator about a devnet mint it has never heard of. Either way the
   * token's own record is overwritten with numbers that are not about it.
   */
  it('excludes tokens launched on another network', () => {
    const monitoring = new MonitoringService(harness.db, harness.events, () => harness.clock.now());
    for (const [mint, network] of [
      ['MintSim', 'simulation'],
      ['MintMain', 'mainnet'],
      ['MintDev', 'devnet'],
    ] as const) {
      harness.db.$raw
        .prepare(
          `INSERT INTO tokens (mint, network, name, symbol, creator_address, lifecycle, monitor_tier,
                               created_on_chain_at, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(mint, network, mint, 'SYM', 'CreatorTest', 'new', 'hot', harness.clock.now(), harness.clock.now(), harness.clock.now());
    }

    expect(monitoring.dueForPoll(10, 'simulation').map((t) => t.mint)).toEqual(['MintSim']);
    expect(monitoring.dueForPoll(10, 'mainnet').map((t) => t.mint)).toEqual(['MintMain']);
    // No network given means every network, which is what the API surfaces use.
    expect(monitoring.dueForPoll(10).length).toBe(3);
  });
});

describe('rehydration is safe against a live adapter', () => {
  /**
   * Every provider refresh rehydrates, and the ledger row for a sweep is
   * written only after the sweep returns. A refresh landing in that gap must
   * not hand the adapter a swept total that predates the claim it just made,
   * because the next accrual pass would then refill the vault.
   */
  it('never lowers the swept total it already knows', async () => {
    const adapter = new SimulationLaunchAdapter({ now: () => harness.clock.now() });
    const mint = await launchEarningToken(adapter);
    const creator = payer.publicKey.toBase58();

    harness.clock.advance(6 * TIME.hour);
    adapter.accrueFees(mint, creator, 0.0005, 0.0005);
    const plan = await adapter.prepareFeeClaim(creator);
    const claim = await adapter.executeFeeClaim(plan!, payer);
    expect(adapter.claimedLamports(creator)).toBe(claim.claimedLamports);

    // The ledger has not caught up yet: it still reports nothing swept.
    adapter.restoreClaimed(creator, 0);
    adapter.restoreClaimed(creator, 1);
    expect(adapter.claimedLamports(creator)).toBe(claim.claimedLamports);

    adapter.accrueFees(mint, creator, 0.0005, 0.0005);
    expect((await adapter.getAccruedFees(creator)).totalClaimableLamports).toBe(0);
  });
});
