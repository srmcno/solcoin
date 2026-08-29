import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { createHarness, type TestHarness } from '../helpers.js';
import { LaunchService } from '../../packages/server/src/services/launch.service.js';
import { SimulationLaunchAdapter } from '../../packages/server/src/providers/solana/simulation-adapter.js';
import type { LaunchAdapter } from '../../packages/server/src/providers/solana/launch-adapter.js';

/**
 * States the platform could get into and never get out of.
 *
 * Each of these is a safety mechanism that worked exactly once: it engaged
 * correctly, and then there was no way back. A guard with no release is not a
 * guard, it is a trap — and the operator's only remaining option is to edit the
 * database by hand.
 */

let harness: TestHarness;
const signer = Keypair.fromSeed(new Uint8Array(32).fill(5));
const withSigner = async <T>(fn: (kp: Keypair) => Promise<T>): Promise<T> => fn(signer);

beforeEach(() => {
  harness = createHarness();
});
afterEach(() => harness.cleanup());

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

function seedFailedLaunch(id: string, conceptId: string): void {
  harness.db.$raw
    .prepare(
      `INSERT INTO concepts (id, name, symbol, description, status, metadata_uri, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(conceptId, 'Concept', 'CPT', 'test', 'failed', 'https://example.invalid/m.json', harness.clock.now(), harness.clock.now());
  harness.db.$raw
    .prepare(
      `INSERT INTO launches (id, concept_id, idempotency_key, network, adapter, status, last_error, error_code, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      conceptId,
      LaunchService.idempotencyKey(conceptId, 'simulation'),
      'simulation',
      'simulation',
      'failed',
      'RPC unavailable',
      'provider_unavailable',
      harness.clock.now(),
      harness.clock.now(),
    );
}

describe('the consecutive-failure breaker', () => {
  it('engages after the configured number of failures', () => {
    harness.settings.update({ limits: { consecutiveFailureShutdown: 3 } }, { type: 'system' });
    for (let i = 0; i < 3; i++) seedFailedLaunch(`lch_f${i}`, `cpt_f${i}`);

    const decision = harness.guard.checkLaunch();
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('consecutive_failures');
  });

  it('names the operation that releases it, rather than a mechanism that does not exist', () => {
    harness.settings.update({ limits: { consecutiveFailureShutdown: 2 } }, { type: 'system' });
    seedFailedLaunch('lch_m0', 'cpt_m0');
    seedFailedLaunch('lch_m1', 'cpt_m1');
    expect(harness.guard.checkLaunch().reason).toContain('/api/system/clear-launch-failures');
  });

  it('can be released, which is the whole point', () => {
    harness.settings.update({ limits: { consecutiveFailureShutdown: 3 } }, { type: 'system' });
    for (let i = 0; i < 3; i++) seedFailedLaunch(`lch_r${i}`, `cpt_r${i}`);
    expect(harness.guard.checkLaunch().allowed).toBe(false);

    const cleared = harness.guard.clearLaunchFailures({ actorId: 'usr_1', actorLabel: 'Operator' }, 'RPC provider replaced');
    expect(cleared).toBe(3);

    // Without a release the breaker is permanent: every launch is refused
    // before it can produce the success that would reset the count.
    expect(harness.guard.checkLaunch().allowed).toBe(true);
    expect(harness.guard.consecutiveLaunchFailures()).toBe(0);
  });

  it('keeps the failures in the record rather than deleting them', () => {
    harness.settings.update({ limits: { consecutiveFailureShutdown: 3 } }, { type: 'system' });
    for (let i = 0; i < 3; i++) seedFailedLaunch(`lch_k${i}`, `cpt_k${i}`);
    harness.guard.clearLaunchFailures({ actorId: 'usr_1' }, 'acknowledged');

    const rows = harness.db.$raw.prepare('SELECT status FROM launches').all() as Array<{ status: string }>;
    expect(rows).toHaveLength(3);
    // Reclassified, not erased: the failure analytics count both.
    expect(rows.every((r) => r.status === 'abandoned')).toBe(true);
    expect(harness.audit.verifyChain().valid).toBe(true);
  });
});

describe('retrying a failed launch', () => {
  it('is refused while the failed attempt still holds the idempotency key', async () => {
    seedFailedLaunch('lch_x', 'cpt_x');
    const outcome = await service().launch(
      {
        conceptId: 'cpt_x',
        name: 'Concept',
        symbol: 'CPT',
        description: 'test',
        metadataUri: 'https://example.invalid/m.json',
        approvalMode: 'manual',
      },
      withSigner,
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('previous launch attempt');
  });

  it('succeeds once the failed attempt is retired', async () => {
    seedFailedLaunch('lch_y', 'cpt_y');
    const launches = service();

    expect(launches.retireFailed('cpt_y', 'simulation')).toBe(1);

    const outcome = await launches.launch(
      {
        conceptId: 'cpt_y',
        name: 'Concept',
        symbol: 'CPT',
        description: 'test',
        metadataUri: 'https://example.invalid/m.json',
        approvalMode: 'manual',
      },
      withSigner,
    );
    // The dashboard offers a retry on a failed candidate; this is what makes
    // pressing it do something.
    expect(outcome.status).toBe('confirmed');
    expect(outcome.mintAddress).toBeTruthy();
  });

  it('keeps the retired attempt, so the history still shows the failure', () => {
    seedFailedLaunch('lch_z', 'cpt_z');
    service().retireFailed('cpt_z', 'simulation');
    const row = harness.db.$raw.prepare('SELECT status, idempotency_key FROM launches WHERE id = ?').get('lch_z') as {
      status: string;
      idempotency_key: string;
    };
    expect(row.status).toBe('abandoned');
    expect(row.idempotency_key).toBe('retired:lch_z');
  });

  it('does nothing to a launch that is still in flight', () => {
    harness.db.$raw
      .prepare(
        `INSERT INTO concepts (id, name, symbol, description, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
      )
      .run('cpt_live', 'C', 'C', 't', 'launching', harness.clock.now(), harness.clock.now());
    harness.db.$raw
      .prepare(
        `INSERT INTO launches (id, concept_id, idempotency_key, network, adapter, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run('lch_live', 'cpt_live', LaunchService.idempotencyKey('cpt_live', 'simulation'), 'simulation', 'simulation', 'submitted', harness.clock.now(), harness.clock.now());

    // Retiring a submitted launch would let a second token be minted for a
    // transaction that may still land.
    expect(service().retireFailed('cpt_live', 'simulation')).toBe(0);
  });
});
