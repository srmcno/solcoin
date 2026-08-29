import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { createHarness, type TestHarness } from '../helpers.js';
import { LaunchService } from '../../packages/server/src/services/launch.service.js';
import { SimulationLaunchAdapter } from '../../packages/server/src/providers/solana/simulation-adapter.js';
import type { LaunchAdapter } from '../../packages/server/src/providers/solana/launch-adapter.js';
import { AuthService } from '../../packages/server/src/security/auth.js';

/**
 * Limits that only hold when nothing interleaves.
 *
 * Every counter the guard uses is read from the database, and every caller
 * does asynchronous work before it writes the row that consumes what it just
 * claimed. Two requests arriving inside that window read the same totals and
 * clear the same cap, so a limit that reads as enforced is not. The same shape
 * lets two bootstrap requests each create an owner.
 *
 * These tests all follow the real interleaving: yield to the event loop first,
 * then reserve. With the check and the write in separate steps, every one of
 * them lets both callers through.
 */

let harness: TestHarness;

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => {
  harness.cleanup();
});

describe('spend limits under concurrency', () => {
  /** Insert the outgoing transaction that consumes part of the hourly cap. */
  function reserveTransfer(lamports: number): ReturnType<TestHarness['guard']['reserveSpend']> {
    return harness.guard.reserveSpend({ operation: 'wallet_transfer', lamports }, () => {
      harness.db.$raw
        .prepare(
          `INSERT INTO wallet_transactions (id, wallet_address, network, direction, purpose, lamports,
                                            counterparty, status, occurred_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          `wtx_${lamports}_${Math.round(harness.clock.now())}_${Math.random().toString(36).slice(2, 8)}`,
          'Wallet11111111111111111111111111111111111',
          'devnet',
          'out',
          'manual_transfer',
          lamports,
          'Dest111111111111111111111111111111111111',
          'pending',
          harness.clock.now(),
          harness.clock.now(),
        );
    });
  }

  it('lets two concurrent transfers spend a cap only one of them fits under', async () => {
    harness.settings.update(
      {
        autonomy: { wallet_transfer: 'approve' },
        // The daily cap is raised first: the settings service clamps the hourly
        // limit to it, so setting the hourly one alone would have no effect.
        limits: { maxSolSpendPerDay: 2, maxSolPerHour: 1, maxSolPerTransaction: 1 },
      },
      { type: 'system' },
    );

    // 0.6 SOL each: either alone is fine, both together are not.
    const attempt = async (): Promise<string> => {
      // The await a real caller has here is fetching the wallet balance.
      await Promise.resolve();
      return reserveTransfer(600_000_000).outcome;
    };

    const outcomes = await Promise.all([attempt(), attempt()]);
    expect(outcomes.filter((o) => o === 'reserved')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'denied')).toHaveLength(1);

    const committed = harness.db.$raw
      .prepare(`SELECT COALESCE(SUM(lamports), 0) AS total FROM wallet_transactions WHERE direction = 'out'`)
      .get() as { total: number };
    expect(committed.total).toBe(600_000_000);
  });

  it('writes nothing when the reservation is denied', () => {
    harness.settings.update(
      {
        autonomy: { wallet_transfer: 'approve' },
        // The daily cap is raised first: the settings service clamps the hourly
        // limit to it, so setting the hourly one alone would have no effect.
        limits: { maxSolSpendPerDay: 2, maxSolPerHour: 1, maxSolPerTransaction: 1 },
      },
      { type: 'system' },
    );
    expect(reserveTransfer(600_000_000).outcome).toBe('reserved');
    expect(reserveTransfer(600_000_000).outcome).toBe('denied');

    const rows = harness.db.$raw.prepare('SELECT COUNT(*) AS n FROM wallet_transactions').get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('decides and writes without yielding, so nothing can run in between', () => {
    harness.settings.update({ autonomy: { wallet_transfer: 'approve' } }, { type: 'system' });
    let wroteDuringTheCall = false;
    harness.guard.reserveSpend({ operation: 'wallet_transfer', lamports: 1_000 }, () => {
      wroteDuringTheCall = true;
    });
    // If the reservation were asynchronous this would still be false here, and
    // the window this whole mechanism exists to close would be open again.
    expect(wroteDuringTheCall).toBe(true);
  });
});

describe('launch limits under concurrency', () => {
  const signer = Keypair.fromSeed(new Uint8Array(32).fill(9));
  const withSigner = async <T>(fn: (kp: Keypair) => Promise<T>): Promise<T> => fn(signer);

  function seedConcept(id: string): void {
    harness.db.$raw
      .prepare(
        `INSERT INTO concepts (id, name, symbol, description, status, metadata_uri, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(id, `Concept ${id}`, 'TSTC', 'A concept used in tests', 'approved', 'https://example.invalid/m.json', harness.clock.now(), harness.clock.now());
  }

  it('lets two different concepts launch past an hourly limit of one', async () => {
    harness.settings.update({ limits: { maxLaunchesPerHour: 1, maxLaunchesPerDay: 5 } }, { type: 'system' });
    seedConcept('cpt_a');
    seedConcept('cpt_b');

    const adapter = new SimulationLaunchAdapter({ now: () => harness.clock.now() });
    const service = new LaunchService(
      harness.db,
      harness.settings,
      harness.guard,
      harness.audit,
      harness.events,
      new Map<string, LaunchAdapter>([['simulation', adapter]]),
      () => harness.clock.now(),
    );

    // Two distinct concepts: idempotency cannot save this one, only the limit can.
    const results = await Promise.all([
      service.launch(
        { conceptId: 'cpt_a', name: 'A', symbol: 'AAA', description: 'a', metadataUri: 'https://example.invalid/a.json', approvalMode: 'manual' },
        withSigner,
      ),
      service.launch(
        { conceptId: 'cpt_b', name: 'B', symbol: 'BBB', description: 'b', metadataUri: 'https://example.invalid/b.json', approvalMode: 'manual' },
        withSigner,
      ),
    ]);

    const launched = harness.db.$raw
      .prepare(`SELECT COUNT(*) AS n FROM launches WHERE status IN ('preparing','submitted','confirmed')`)
      .get() as { n: number };
    expect(launched.n).toBe(1);

    const blocked = results.filter((r) => r.status === 'blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.errorCode).toBe('hourly_launch_limit');
  });

  it('still calls a duplicate of one concept a conflict, not a limit', async () => {
    harness.settings.update({ limits: { maxLaunchesPerHour: 1, maxLaunchesPerDay: 5 } }, { type: 'system' });
    seedConcept('cpt_same');

    const adapter = new SimulationLaunchAdapter({ now: () => harness.clock.now() });
    const service = new LaunchService(
      harness.db,
      harness.settings,
      harness.guard,
      harness.audit,
      harness.events,
      new Map<string, LaunchAdapter>([['simulation', adapter]]),
      () => harness.clock.now(),
    );

    const attempt = () =>
      service.launch(
        { conceptId: 'cpt_same', name: 'S', symbol: 'SSS', description: 's', metadataUri: 'https://example.invalid/s.json', approvalMode: 'manual' },
        withSigner,
      );

    const results = await Promise.all([attempt(), attempt()]);
    for (const loser of results.filter((r) => r.status !== 'confirmed')) {
      // "Hourly limit reached" would send an operator hunting a capacity
      // problem that does not exist.
      expect(loser.errorCode).toBe('conflict');
    }
  });
});

describe('first-owner creation under concurrency', () => {
  it('creates exactly one owner when two bootstrap requests race', async () => {
    const auth = new AuthService(harness.db, harness.audit, () => harness.clock.now());

    // Different email addresses, so the uniqueness constraint cannot catch it.
    // Password hashing is deliberately slow and sits between the check and the
    // insert, which is the whole window.
    const results = await Promise.allSettled([
      auth.createUser({
        email: 'first@example.invalid',
        password: 'quince-lantern-frosted-9412',
        displayName: 'First',
        role: 'owner',
        requireFirstUser: true,
      }),
      auth.createUser({
        email: 'second@example.invalid',
        password: 'thicket-marmalade-8817',
        displayName: 'Second',
        role: 'owner',
        requireFirstUser: true,
      }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const users = harness.db.$raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    expect(users.n).toBe(1);

    const rejection = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejection.reason)).toContain('set up by another request');
  });

  it('does not constrain ordinary account creation', async () => {
    const auth = new AuthService(harness.db, harness.audit, () => harness.clock.now());
    await auth.createUser({
      email: 'owner@example.invalid',
      password: 'quince-lantern-frosted-9412',
      displayName: 'Owner',
      role: 'owner',
    });
    await auth.createUser({
      email: 'operator@example.invalid',
      password: 'thicket-marmalade-8817',
      displayName: 'Operator',
      role: 'operator',
    });
    const users = harness.db.$raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    expect(users.n).toBe(2);
  });
});
