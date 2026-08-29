import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { CURVE_VAULT_RENT_LAMPORTS, lamportsToSol, solToLamports } from '@solcoin/shared';
import { createHarness, type TestHarness } from '../helpers.js';
import { FeeService, type AccrualSnapshot } from '../../packages/server/src/services/fee.service.js';
import { SimulationLaunchAdapter } from '../../packages/server/src/providers/solana/simulation-adapter.js';

/**
 * Creator-fee economics.
 *
 * The failure mode here is quiet rather than loud: a claim that costs more than
 * it recovers still succeeds on chain, so nothing alerts. These tests pin the
 * arithmetic that decides whether claiming is worth doing at all.
 */

let harness: TestHarness;
let service: FeeService;
let adapter: SimulationLaunchAdapter;
const CREATOR = 'CreAtor11111111111111111111111111111111111';

function snapshot(overrides: Partial<AccrualSnapshot> = {}): AccrualSnapshot {
  return {
    creator: CREATOR,
    curveVaultLamports: 0,
    curveClaimableLamports: 0,
    ammVaultLamports: 0,
    totalClaimableLamports: 0,
    observedAt: harness.clock.now(),
    deltaLamports: 0,
    ...overrides,
  };
}

beforeEach(() => {
  harness = createHarness();
  adapter = new SimulationLaunchAdapter({ now: () => harness.clock.now() });
  service = new FeeService(
    harness.db,
    harness.settings,
    harness.guard,
    harness.audit,
    harness.events,
    () => harness.clock.now(),
  );
});

afterEach(() => harness.cleanup());

describe('collection economics', () => {
  it('does not claim an empty vault', () => {
    const decision = service.decideCollection(snapshot(), null);
    expect(decision.shouldCollect).toBe(false);
    // The reason must explain the stranded rent, or an operator seeing a
    // nonzero vault balance and a zero claimable amount will assume a bug.
    expect(decision.reason).toMatch(/rent-exempt|stranded|not claimable/i);
  });

  it('does not claim below the configured threshold', () => {
    const claimable = solToLamports(0.0005);
    const decision = service.decideCollection(
      snapshot({ curveClaimableLamports: claimable, totalClaimableLamports: claimable }),
      null,
    );
    expect(decision.shouldCollect).toBe(false);
    expect(decision.reason).toMatch(/below the .* threshold/i);
  });

  it('refuses a claim that would recover less than it costs', () => {
    // Two lamports above the transaction cost: technically positive, and
    // absolutely not worth a transaction.
    const decision = service.decideCollection(
      snapshot({ curveClaimableLamports: 5_002, totalClaimableLamports: 5_002 }),
      null,
    );
    expect(decision.shouldCollect).toBe(false);
    expect(decision.valueRatio).toBeLessThan(5);
  });

  it('never claims an amount at or below its own transaction cost', () => {
    harness.settings.update(
      { fees: { collectionThresholdSol: 0, minCollectionValueRatio: 1, minHoursBetweenCollections: 0 } },
      { type: 'system' },
    );
    const decision = service.decideCollection(
      snapshot({ curveClaimableLamports: 4_000, totalClaimableLamports: 4_000 }),
      null,
    );
    expect(decision.shouldCollect).toBe(false);
    expect(decision.reason).toMatch(/destroy value|cost/i);
  });

  it('claims once the amount clears both the threshold and the value ratio', () => {
    const claimable = solToLamports(0.05);
    const decision = service.decideCollection(
      snapshot({ curveClaimableLamports: claimable, totalClaimableLamports: claimable }),
      null,
    );
    expect(decision.shouldCollect).toBe(true);
    expect(decision.valueRatio).toBeGreaterThan(5);
  });

  it('respects the minimum interval between collections', () => {
    const claimable = solToLamports(0.05);
    const oneHourAgo = harness.clock.now() - 3_600_000;
    const decision = service.decideCollection(
      snapshot({ curveClaimableLamports: claimable, totalClaimableLamports: claimable }),
      oneHourAgo,
    );
    expect(decision.shouldCollect).toBe(false);
    expect(decision.reason).toMatch(/minimum interval/i);
  });

  it('does not force-sweep a wallet that has never collected anything', () => {
    // With no reference point the interval is undefined. Treating it as
    // infinite would sweep the very first dust accrual at a loss.
    const claimable = solToLamports(0.0004);
    const decision = service.decideCollection(
      snapshot({ curveClaimableLamports: claimable, totalClaimableLamports: claimable }),
      null,
    );
    expect(decision.shouldCollect).toBe(false);
  });

  it('force-sweeps a slow earner that would otherwise never clear the threshold', () => {
    const claimable = solToLamports(0.0004);
    const longAgo = harness.clock.now() - 200 * 3_600_000;
    const decision = service.decideCollection(
      snapshot({ curveClaimableLamports: claimable, totalClaimableLamports: claimable }),
      { lastCollectionAt: null, accruingSince: longAgo },
    );
    expect(decision.shouldCollect).toBe(true);
    expect(decision.reason).toMatch(/forced/i);
  });

  it('accounts for both vaults when estimating the claim cost', () => {
    const single = service.decideCollection(
      snapshot({ curveClaimableLamports: solToLamports(0.05), totalClaimableLamports: solToLamports(0.05) }),
      null,
    );
    const both = service.decideCollection(
      snapshot({
        curveClaimableLamports: solToLamports(0.025),
        ammVaultLamports: solToLamports(0.025),
        totalClaimableLamports: solToLamports(0.05),
      }),
      null,
    );
    // Sweeping two vaults is more compute, so the same proceeds cost more.
    expect(both.estimatedCostLamports).toBeGreaterThanOrEqual(single.estimatedCostLamports);
  });
});

describe('accrual tracking', () => {
  it('records snapshots for both vaults and reports the claimable total', async () => {
    const result = await service.snapshotAccruals(adapter, CREATOR);
    expect(result.creator).toBe(CREATOR);

    const rows = harness.db.$raw
      .prepare(`SELECT vault FROM creator_fee_events WHERE kind = 'accrual_snapshot'`)
      .all() as Array<{ vault: string }>;
    expect(rows.map((r) => r.vault).sort()).toEqual(['amm', 'curve']);
  });

  it('does not report a collection as negative earnings', async () => {
    // Between two snapshots the vault can drop because it was swept. A naive
    // difference would read that as the creator losing money.
    harness.db.$raw
      .prepare(
        `INSERT INTO creator_fee_events (id, kind, vault, wallet_address, lamports, claimable_lamports, source, observed_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run('fee_a', 'accrual_snapshot', 'curve', CREATOR, 0, solToLamports(0.1), 'test', harness.clock.now() - 7_200_000, harness.clock.now());
    harness.db.$raw
      .prepare(
        `INSERT INTO creator_fee_events (id, kind, vault, wallet_address, lamports, claimable_lamports, source, observed_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run('fee_b', 'collection', 'curve', CREATOR, solToLamports(0.1), 0, 'test', harness.clock.now() - 3_600_000, harness.clock.now());

    const result = await service.snapshotAccruals(adapter, CREATOR);
    expect(result.deltaLamports).toBeGreaterThanOrEqual(0);
  });

  it('reports the stranded rent so a nonzero vault with nothing claimable makes sense', async () => {
    await service.snapshotAccruals(adapter, CREATOR);
    const totals = await service.totals();
    expect(totals.strandedRentLamports).toBeGreaterThanOrEqual(0);
    expect(totals.collectedLamports).toBe(0);
  });

  it('refuses to collect while fee-collection autonomy is off', async () => {
    harness.settings.update({ autonomy: { fee_collection: 'off' } }, { type: 'system' });
    const signer = Keypair.fromSeed(new Uint8Array(32).fill(3));
    const result = await service.collect(adapter, CREATOR, async (fn) => fn(signer));
    expect(result.collected).toBe(false);
    expect(result.reason).toMatch(/switched off/i);
  });

  it('refuses to collect while the emergency stop is engaged', async () => {
    harness.settings.emergencyStop('paused for a test', { type: 'system' });
    const signer = Keypair.fromSeed(new Uint8Array(32).fill(3));
    const result = await service.collect(adapter, CREATOR, async (fn) => fn(signer));
    expect(result.collected).toBe(false);
    expect(result.reason).toMatch(/emergency stop/i);
  });
});

describe('stranded rent arithmetic', () => {
  it('matches the protocol constant exactly', () => {
    // The bonding-curve vault is a zero-byte System-owned account, so its
    // rent-exempt minimum is fixed and permanently unrecoverable.
    expect(CURVE_VAULT_RENT_LAMPORTS).toBe(890_880);
    expect(lamportsToSol(CURVE_VAULT_RENT_LAMPORTS)).toBeCloseTo(0.00089088, 8);
  });
});

describe('what a claim costs', () => {
  const withSigner = async <T>(fn: (kp: Keypair) => Promise<T>): Promise<T> =>
    fn(Keypair.fromSeed(new Uint8Array(32).fill(11)));

  function committedSpendLamports(): number {
    const row = harness.db.$raw
      .prepare(
        `SELECT COALESCE(SUM(lamports + fee_lamports), 0) AS total
           FROM wallet_transactions WHERE direction = 'out' AND status IN ('pending','confirmed')`,
      )
      .get() as { total: number };
    return row.total;
  }

  beforeEach(() => {
    harness.settings.update({ autonomy: { fee_collection: 'approve' } }, { type: 'system' });
    // The simulated vaults are filled by simulated trading; seeding them
    // directly is the only way to reach the claim path deterministically.
    (adapter as unknown as { vaults: Map<string, { curve: number; amm: number }> }).vaults.set(CREATOR, {
      curve: solToLamports(0.5),
      amm: 0,
    });
  });

  it('records the network fee as committed spend', async () => {
    expect(committedSpendLamports()).toBe(0);
    const result = await service.collect(adapter, CREATOR, withSigner, { actorType: 'user' });
    expect(result.collected).toBe(true);
    // The claim is revenue-positive, but the signature fee is still real SOL
    // leaving the wallet. Recorded nowhere the guard could see it, a claim loop
    // against a failing RPC would spend outside every limit the operator set.
    expect(committedSpendLamports()).toBeGreaterThan(0);
  });

  it('is refused when the spending limits leave no room', async () => {
    // "Spend nothing" has to mean nothing, including network fees.
    harness.settings.update(
      { limits: { maxSolSpendPerDay: 0, maxSolPerHour: 0, maxSolPerTransaction: 0 } },
      { type: 'system' },
    );
    const result = await service.collect(adapter, CREATOR, withSigner, { actorType: 'user' });
    expect(result.collected).toBe(false);
    // Named explicitly so this cannot pass because there was nothing to claim.
    expect(result.reason).toMatch(/limit/i);
    expect(committedSpendLamports()).toBe(0);
  });

  it('is not blocked by the wallet balance floor', async () => {
    // The floor exists precisely so there is always enough SOL left to collect
    // what has already been earned. Applying it here would defeat its purpose.
    harness.settings.update({ limits: { walletBalanceFloorSol: 1000 } }, { type: 'system' });
    const result = await service.collect(adapter, CREATOR, withSigner, { actorType: 'user' });
    expect(result.collected).toBe(true);
  });
});
