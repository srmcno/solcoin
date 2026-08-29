import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { createHarness, type TestHarness } from '../helpers.js';
import { LaunchService } from '../../packages/server/src/services/launch.service.js';
import { SimulationLaunchAdapter } from '../../packages/server/src/providers/solana/simulation-adapter.js';
import type { LaunchAdapter } from '../../packages/server/src/providers/solana/launch-adapter.js';

/**
 * Round seven of review. Every case here is a way the platform could lose
 * track of money or of a candidate while every existing test stayed green.
 */

let harness: TestHarness;
const signer = Keypair.fromSeed(new Uint8Array(32).fill(7));
const withSigner = async <T>(fn: (kp: Keypair) => Promise<T>): Promise<T> => fn(signer);

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => harness.cleanup());

function seedConcept(id: string, status = 'approved'): void {
  harness.db.$raw
    .prepare(
      `INSERT INTO concepts (id, name, symbol, description, status, metadata_uri, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(id, `Concept ${id}`, 'CPT', 'A concept used in tests', status, 'https://example.invalid/m.json', harness.clock.now(), harness.clock.now());
}

function service(): LaunchService {
  return new LaunchService(
    harness.db,
    harness.settings,
    harness.guard,
    harness.audit,
    harness.events,
    new Map<string, LaunchAdapter>([['simulation', new SimulationLaunchAdapter({ now: () => harness.clock.now() })]]),
    () => harness.clock.now(),
  );
}

/**
 * An adapter that stops inside `prepare`, so a launch can be observed while it
 * holds a reservation and has not yet reconciled it to a planned cost. That
 * window is exactly where the defect lived.
 */
function pausingAdapter(): { adapter: LaunchAdapter; prepared: Promise<void>; release: () => void } {
  const base = new SimulationLaunchAdapter({ now: () => harness.clock.now() });
  let signalPrepared: () => void = () => {};
  let release: () => void = () => {};
  const prepared = new Promise<void>((resolve) => {
    signalPrepared = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const adapter = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return async (...args: Parameters<LaunchAdapter['prepare']>) => {
          signalPrepared();
          await gate;
          return target.prepare(...args);
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  }) as unknown as LaunchAdapter;

  return { adapter, prepared, release };
}

function serviceWith(adapter: LaunchAdapter): LaunchService {
  return new LaunchService(
    harness.db,
    harness.settings,
    harness.guard,
    harness.audit,
    harness.events,
    new Map<string, LaunchAdapter>([['simulation', adapter]]),
    () => harness.clock.now(),
  );
}

describe('a launch reservation carries its own cost', () => {
  /**
   * The reservation row is what the SOL caps are counted against. Inserted at
   * the zero default it is counted as free, so between claiming the slot and
   * the adapter finishing its preparation the spend is invisible — and a
   * second launch arriving in that window clears a cap it should have hit.
   */
  it('records the conservative estimate at the moment the slot is claimed', async () => {
    seedConcept('cpt_estimate');
    const { adapter, prepared, release } = pausingAdapter();
    const svc = serviceWith(adapter);

    const inFlight = svc.launch(
      {
        conceptId: 'cpt_estimate',
        name: 'Concept',
        symbol: 'CPT',
        description: 'd',
        metadataUri: 'https://example.invalid/m.json',
        approvalMode: 'manual',
      },
      withSigner,
      { walletBalanceLamports: 5_000_000_000 },
    );

    await prepared;

    const row = harness.db.$raw
      .prepare(`SELECT status, total_cost_lamports FROM launches WHERE concept_id = 'cpt_estimate'`)
      .get() as { status: string; total_cost_lamports: number } | undefined;

    expect(row?.status).toBe('preparing');
    expect(row?.total_cost_lamports).toBe(harness.guard.estimatedLaunchCostLamports());
    expect(row?.total_cost_lamports).toBeGreaterThan(0);

    release();
    await inFlight;
  });

  /**
   * The same defect stated as the consequence that matters: two launches
   * overlapping in that window must not both clear a SOL cap only one of them
   * fits under.
   */
  it('stops a concurrent launch from spending past the hourly SOL cap', async () => {
    harness.settings.update(
      {
        limits: { maxLaunchesPerHour: 5, maxLaunchesPerDay: 5, maxSolPerHour: 0.08, maxSolPerTransaction: 0.5 },
        execution: { devBuySol: 0.05 },
      },
      { type: 'system' },
    );
    seedConcept('cpt_a');
    seedConcept('cpt_b');

    const first = pausingAdapter();
    const svcA = serviceWith(first.adapter);
    const inFlight = svcA.launch(
      { conceptId: 'cpt_a', name: 'A', symbol: 'AAA', description: 'd', metadataUri: 'u', approvalMode: 'manual' },
      withSigner,
      { walletBalanceLamports: 5_000_000_000 },
    );
    await first.prepared;

    // The first launch holds a reservation and has broadcast nothing. Its
    // estimate alone leaves no room under the hourly cap for a second.
    const svcB = serviceWith(new SimulationLaunchAdapter({ now: () => harness.clock.now() }));
    const second = await svcB.launch(
      { conceptId: 'cpt_b', name: 'B', symbol: 'BBB', description: 'd', metadataUri: 'u', approvalMode: 'manual' },
      withSigner,
      { walletBalanceLamports: 5_000_000_000 },
    );

    expect(second.status).toBe('blocked');
    expect(second.errorCode).toBe('hourly_spend_limit');

    first.release();
    await inFlight;
  });
});

describe('a recovered launch failure releases its concept', () => {
  /**
   * `launching` is a transient status owned by the launch call. When the
   * process dies mid-launch nothing restores it, and recovery only ever
   * touched the launch row — so the concept kept a status the launch queue
   * ignores, the expiry sweep skips, and the stranded sweep will not touch
   * because a launch row exists. Invisible and unlaunchable forever.
   */
  function seedOrphan(id: string, launchId: string, mint: string | null): void {
    seedConcept(id, 'launching');
    harness.db.$raw
      .prepare(
        `INSERT INTO launches (id, concept_id, idempotency_key, network, adapter, status, approval_mode,
                               mint_address, transaction_signature, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(launchId, id, `key-${launchId}`, 'simulation', 'simulation', 'submitted', 'manual', mint, 'sig', harness.clock.now(), harness.clock.now());
  }

  it('moves the concept out of launching when the transaction expired', async () => {
    seedOrphan('cpt_orphan', 'lch_orphan', 'MintOrphan');

    const outcome = await service().resolveUnconfirmed('lch_orphan', async () => 'expired');
    expect(outcome).toBe('failed');

    const concept = harness.db.$raw.prepare(`SELECT status, rejection_reason FROM concepts WHERE id = 'cpt_orphan'`).get() as {
      status: string;
      rejection_reason: string | null;
    };
    expect(concept.status).toBe('failed');
    expect(concept.rejection_reason).toBe('launch_unresolved');
  });

  it('moves the concept out of launching when no mint was ever assigned', async () => {
    seedOrphan('cpt_nomint', 'lch_nomint', null);

    const outcome = await service().resolveUnconfirmed('lch_nomint', async () => 'confirmed');
    expect(outcome).toBe('failed');

    const concept = harness.db.$raw.prepare(`SELECT status FROM concepts WHERE id = 'cpt_nomint'`).get() as { status: string };
    expect(concept.status).toBe('failed');
  });

  /** A concept that already moved on must not be dragged back by a late pass. */
  it('leaves a concept that is no longer launching alone', async () => {
    seedOrphan('cpt_done', 'lch_done', 'MintDone');
    harness.db.$raw.prepare(`UPDATE concepts SET status = 'launched' WHERE id = 'cpt_done'`).run();

    await service().resolveUnconfirmed('lch_done', async () => 'expired');

    const concept = harness.db.$raw.prepare(`SELECT status FROM concepts WHERE id = 'cpt_done'`).get() as { status: string };
    expect(concept.status).toBe('launched');
  });
});
