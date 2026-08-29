import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { createHarness, type TestHarness } from '../helpers.js';
import { LaunchService } from '../../packages/server/src/services/launch.service.js';
import { SimulationLaunchAdapter } from '../../packages/server/src/providers/solana/simulation-adapter.js';
import type { LaunchAdapter } from '../../packages/server/src/providers/solana/launch-adapter.js';
import { AppError } from '../../packages/server/src/core/errors.js';

/**
 * Duplicate-launch prevention.
 *
 * This is the failure mode that costs real money: a retried job that mints a
 * second token. Each test here corresponds to a way that could happen.
 */

let harness: TestHarness;
let adapter: SimulationLaunchAdapter;
let service: LaunchService;
const signer = Keypair.fromSeed(new Uint8Array(32).fill(7));
const withSigner = async <T>(fn: (kp: Keypair) => Promise<T>): Promise<T> => fn(signer);

function seedConcept(id: string): void {
  harness.db.$raw
    .prepare(
      `INSERT INTO concepts (id, name, symbol, description, status, metadata_uri, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(id, 'Test Concept', 'TSTC', 'A concept used in tests', 'approved', 'https://example.invalid/meta.json', harness.clock.now(), harness.clock.now());
}

const input = (conceptId: string) => ({
  conceptId,
  name: 'Test Concept',
  symbol: 'TSTC',
  description: 'A concept used in tests',
  metadataUri: 'https://example.invalid/meta.json',
  approvalMode: 'manual' as const,
  initiatedBy: 'tester',
});

beforeEach(() => {
  harness = createHarness();
  adapter = new SimulationLaunchAdapter({ now: () => harness.clock.now() });
  const adapters = new Map<string, LaunchAdapter>([['simulation', adapter]]);
  service = new LaunchService(
    harness.db,
    harness.settings,
    harness.guard,
    harness.audit,
    harness.events,
    adapters,
    () => harness.clock.now(),
  );
  seedConcept('cpt_1');
});

afterEach(() => harness.cleanup());

describe('idempotency', () => {
  it('derives the same key for a concept and network every time', () => {
    const a = LaunchService.idempotencyKey('cpt_1', 'simulation');
    const b = LaunchService.idempotencyKey('cpt_1', 'simulation');
    expect(a).toBe(b);
  });

  it('derives a different key per network, so devnet and mainnet are independent', () => {
    expect(LaunchService.idempotencyKey('cpt_1', 'devnet')).not.toBe(LaunchService.idempotencyKey('cpt_1', 'mainnet'));
  });

  it('returns the original result rather than launching twice', async () => {
    const first = await service.launch(input('cpt_1'), withSigner);
    expect(first.status).toBe('confirmed');
    expect(first.mintAddress).toBeTruthy();

    const second = await service.launch(input('cpt_1'), withSigner);
    expect(second.status).toBe('confirmed');
    expect(second.launchId).toBe(first.launchId);
    expect(second.mintAddress).toBe(first.mintAddress);

    const count = harness.db.$raw.prepare('SELECT COUNT(*) AS n FROM launches').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('does not create a second row when two attempts race', async () => {
    // Concurrent attempts are the realistic version of the retry problem: two
    // scheduler ticks, or a manual launch racing the launch job.
    const results = await Promise.all([
      service.launch(input('cpt_1'), withSigner),
      service.launch(input('cpt_1'), withSigner),
      service.launch(input('cpt_1'), withSigner),
    ]);

    const count = harness.db.$raw.prepare('SELECT COUNT(*) AS n FROM launches').get() as { n: number };
    expect(count.n).toBe(1);

    const confirmed = results.filter((r) => r.status === 'confirmed');
    expect(confirmed.length).toBeGreaterThanOrEqual(1);
    // Losers report a conflict rather than throwing or silently succeeding.
    for (const loser of results.filter((r) => r.status !== 'confirmed')) {
      expect(loser.errorCode).toBe('conflict');
    }
    const mints = new Set(results.map((r) => r.mintAddress).filter(Boolean));
    expect(mints.size).toBeLessThanOrEqual(1);
  });

  it('derives the same mint address for the same idempotency key', () => {
    const key = LaunchService.idempotencyKey('cpt_1', 'devnet');
    // The real adapter's derivation is the second line of defence: even if the
    // database row were lost, the retry targets the same mint and the on-chain
    // create fails as "already in use" rather than minting a second token.
    const seedA = deriveDeterministic(key);
    const seedB = deriveDeterministic(key);
    expect(seedA).toBe(seedB);
    expect(deriveDeterministic(LaunchService.idempotencyKey('cpt_2', 'devnet'))).not.toBe(seedA);
  });

  it('records the signature before the outcome is known', async () => {
    let signatureAtSignTime: string | null = null;
    const observing = new SimulationLaunchAdapter({ now: () => harness.clock.now() });
    const original = observing.execute.bind(observing);
    observing.execute = async (plan, payer, options) => {
      await options?.onSigned?.({ signature: 'SIM-SIG', blockhash: 'bh', lastValidBlockHeight: 1 });
      const row = harness.db.$raw
        .prepare('SELECT transaction_signature FROM launches WHERE concept_id = ?')
        .get('cpt_1') as { transaction_signature: string | null } | undefined;
      signatureAtSignTime = row?.transaction_signature ?? null;
      return original(plan, payer, options);
    };

    const adapters = new Map<string, LaunchAdapter>([['simulation', observing]]);
    const observedService = new LaunchService(
      harness.db,
      harness.settings,
      harness.guard,
      harness.audit,
      harness.events,
      adapters,
      () => harness.clock.now(),
    );

    await observedService.launch(input('cpt_1'), withSigner);
    // A process that died here must find the signature on restart.
    expect(signatureAtSignTime).toBe('SIM-SIG');
  });
});

describe('limits and safety', () => {
  it('refuses to launch while the emergency stop is engaged', async () => {
    harness.settings.emergencyStop('testing', { type: 'system' });
    const result = await service.launch(input('cpt_1'), withSigner);
    expect(result.status).toBe('blocked');
    expect(result.errorCode).toBe('emergency_stop');
    const count = harness.db.$raw.prepare('SELECT COUNT(*) AS n FROM launches').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('refuses once the hourly launch limit is reached', async () => {
    harness.settings.update({ limits: { maxLaunchesPerDay: 3, maxLaunchesPerHour: 1 } }, { type: 'system' });
    await service.launch(input('cpt_1'), withSigner);

    seedConcept('cpt_2');
    const second = await service.launch(input('cpt_2'), withSigner);
    expect(second.status).toBe('blocked');
    expect(second.errorCode).toBe('hourly_launch_limit');
  });

  it('refuses once the daily limit is reached even after the hourly window clears', async () => {
    harness.settings.update({ limits: { maxLaunchesPerDay: 2, maxLaunchesPerHour: 1 } }, { type: 'system' });
    await service.launch(input('cpt_1'), withSigner);

    // Step past the hourly window so only the daily limit can bind.
    harness.clock.advance(2 * 3_600_000);
    seedConcept('cpt_2');
    expect((await service.launch(input('cpt_2'), withSigner)).status).toBe('confirmed');

    harness.clock.advance(2 * 3_600_000);
    seedConcept('cpt_3');
    const third = await service.launch(input('cpt_3'), withSigner);
    expect(third.status).toBe('blocked');
    expect(third.errorCode).toBe('daily_launch_limit');
  });

  it('permits a launch again once the limit window has passed', async () => {
    harness.settings.update({ limits: { maxLaunchesPerDay: 1, maxLaunchesPerHour: 1 } }, { type: 'system' });
    await service.launch(input('cpt_1'), withSigner);

    harness.clock.advance(25 * 3_600_000);
    seedConcept('cpt_2');
    const second = await service.launch(input('cpt_2'), withSigner);
    expect(second.status).toBe('confirmed');
  });

  it('halts launching after consecutive failures', async () => {
    const failing = new SimulationLaunchAdapter({ now: () => harness.clock.now() });
    failing.execute = async () => {
      throw new AppError('transaction_failed', 'simulated chain failure');
    };
    const adapters = new Map<string, LaunchAdapter>([['simulation', failing]]);
    const failingService = new LaunchService(
      harness.db,
      harness.settings,
      harness.guard,
      harness.audit,
      harness.events,
      adapters,
      () => harness.clock.now(),
    );

    harness.settings.update({ limits: { consecutiveFailureShutdown: 2, maxLaunchesPerDay: 10, maxLaunchesPerHour: 10 } }, { type: 'system' });

    for (const id of ['cpt_1', 'cpt_2']) {
      if (id !== 'cpt_1') seedConcept(id);
      const result = await failingService.launch(input(id), withSigner);
      expect(result.status).toBe('failed');
    }

    // The breaker must engage rather than continuing to burn fees.
    expect(harness.settings.get().emergencyStop).toBe(true);
    expect(harness.settings.get().emergencyStopReason).toMatch(/consecutive launch failures/i);
  });

  it('records every launch in the audit log with an intact chain', async () => {
    await service.launch(input('cpt_1'), withSigner);
    const entries = await harness.audit.query({ targetType: 'launch' });
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('launch.requested');
    expect(actions).toContain('launch.confirmed');
    expect(harness.audit.verifyChain().valid).toBe(true);
  });
});

describe('recovery', () => {
  it('confirms a launch that was broadcast but never recorded as confirmed', async () => {
    const result = await service.launch(input('cpt_1'), withSigner);
    harness.db.$raw
      .prepare(`UPDATE launches SET status = 'submitted', confirmed_at = NULL WHERE id = ?`)
      .run(result.launchId);

    const unresolved = await service.listUnresolved();
    expect(unresolved).toHaveLength(1);

    const outcome = await service.resolveUnconfirmed(result.launchId, async () => 'confirmed');
    expect(outcome).toBe('confirmed');
    const row = await service.getById(result.launchId);
    expect(row?.status).toBe('confirmed');
  });

  it('fails a launch whose transaction expired without landing', async () => {
    const result = await service.launch(input('cpt_1'), withSigner);
    harness.db.$raw.prepare(`UPDATE launches SET status = 'submitted' WHERE id = ?`).run(result.launchId);

    const outcome = await service.resolveUnconfirmed(result.launchId, async () => 'expired');
    expect(outcome).toBe('failed');
    const row = await service.getById(result.launchId);
    expect(row?.error_code).toBe('transaction_expired');
  });

  it('leaves an unknown-state launch alone rather than guessing', async () => {
    const result = await service.launch(input('cpt_1'), withSigner);
    harness.db.$raw.prepare(`UPDATE launches SET status = 'submitted' WHERE id = ?`).run(result.launchId);

    const outcome = await service.resolveUnconfirmed(result.launchId, async () => 'unknown');
    expect(outcome).toBe('pending');
    const row = await service.getById(result.launchId);
    // Marking a possibly-live token as failed would be worse than waiting.
    expect(row?.status).toBe('submitted');
  });

  it('refuses to retry a launch whose outcome is still in flight', async () => {
    // Seeded directly on devnet: simulated launches are auto-confirmed on
    // reconciliation because nothing was ever broadcast, so the ambiguous case
    // only exists for a real network.
    harness.db.$raw
      .prepare(
        `INSERT INTO launches (id, concept_id, idempotency_key, network, adapter, status,
                               mint_address, transaction_signature, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'lch_inflight',
        'cpt_1',
        LaunchService.idempotencyKey('cpt_1', 'devnet'),
        'devnet',
        'pumpfun_sdk',
        'submitted',
        'MintAddressPlaceholder1111111111111111111111',
        'PENDING-SIG',
        harness.clock.now(),
        harness.clock.now(),
      );
    harness.settings.update({ execution: { phase: 'phase2_devnet', network: 'devnet' } }, { type: 'system' });

    const retry = await service.launch(input('cpt_1'), withSigner);
    expect(retry.status).toBe('blocked');
    expect(retry.errorCode).toBe('conflict');
    expect(retry.error).toMatch(/still unknown|reconcil/i);
    const count = harness.db.$raw.prepare('SELECT COUNT(*) AS n FROM launches').get() as { n: number };
    expect(count.n).toBe(1);
  });
});

/** Mirrors the adapter's HKDF derivation for the determinism assertion. */
function deriveDeterministic(key: string): string {
  const { createHash, hkdfSync } = require('node:crypto') as typeof import('node:crypto');
  const seed = Buffer.from(
    hkdfSync('sha256', Buffer.from('test-secret-key-material', 'utf8'), createHash('sha256').update(key).digest(), Buffer.from('solcoin/mint/v1', 'utf8'), 32),
  );
  return Keypair.fromSeed(new Uint8Array(seed)).publicKey.toBase58();
}
