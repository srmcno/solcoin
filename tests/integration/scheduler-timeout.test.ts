import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from '../helpers.js';
import { JobScheduler } from '../../packages/server/src/jobs/scheduler.js';
import type { JobDefinition } from '../../packages/server/src/jobs/scheduler.js';

/**
 * A timeout that only asks is not a timeout.
 *
 * Aborting the controller tells a cooperating job to stop. A job that never
 * consumes its signal — or a provider inside it that ignores the one it was
 * handed — leaves the run pending forever: the slot stays occupied for the
 * life of the process while the database lease expires underneath it, so a
 * second scheduler can start the same side effects alongside the first.
 */

let harness: TestHarness;
let scheduler: JobScheduler;

beforeEach(() => {
  harness = createHarness();
  scheduler = new JobScheduler({
    db: harness.db,
    settings: harness.settings,
    now: () => Date.now(),
    tickMs: 50,
  });
});

afterEach(async () => {
  await scheduler.stop().catch(() => undefined);
  harness.cleanup();
});

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition never held');
}

function runOf(name: string): { status: string; error: string | null } | undefined {
  return harness.db.$raw
    .prepare('SELECT status, error FROM job_runs WHERE job_name = ? ORDER BY started_at DESC LIMIT 1')
    .get(name) as { status: string; error: string | null } | undefined;
}

describe('a job that ignores its abort signal', () => {
  it('is still bounded by its timeout', async () => {
    let release: (() => void) | null = null;
    const job: JobDefinition = {
      name: 'stubborn',
      description: 'Never looks at the signal it was given.',
      intervalSeconds: 3600,
      hasSideEffects: false,
      timeoutSeconds: 1,
      run: () =>
        new Promise((resolve) => {
          release = () => resolve({ itemsProcessed: 1 });
        }),
    };

    scheduler.registerAll([job]);
    const started = Date.now();
    await scheduler.runNow('stubborn');
    // `runNow` starts the run and returns; wait for it to reach a terminal
    // state. Without racing the run against the deadline it never does.
    await waitFor(() => runOf('stubborn')?.status !== 'running', 6_000);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(5_000);
    const run = runOf('stubborn');
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatch(/timed out/i);

    // The lease is deliberately still held: the abandoned work may still be
    // running, and releasing it now is exactly what lets two copies overlap.
    const lease = harness.db.$raw.prepare('SELECT lock_token FROM job_state WHERE job_name = ?').get('stubborn') as
      | { lock_token: string | null }
      | undefined;
    expect(lease?.lock_token).toBeTruthy();

    // Once the abandoned run settles, the lease goes.
    (release as unknown as () => void)?.();
    await waitFor(() => {
      const row = harness.db.$raw.prepare('SELECT lock_token FROM job_state WHERE job_name = ?').get('stubborn') as
        | { lock_token: string | null }
        | undefined;
      return row?.lock_token === null;
    }, 3_000);
  });

  it('releases the lease immediately when the job finishes on time', async () => {
    scheduler.registerAll([
      {
        name: 'prompt',
        description: 'Finishes well inside its timeout.',
        intervalSeconds: 3600,
        hasSideEffects: false,
        timeoutSeconds: 30,
        run: async () => ({ itemsProcessed: 3 }),
      },
    ]);

    await scheduler.runNow('prompt');
    await waitFor(() => runOf('prompt')?.status === 'succeeded', 5_000);
    expect(runOf('prompt')?.status).toBe('succeeded');
    const lease = harness.db.$raw.prepare('SELECT lock_token FROM job_state WHERE job_name = ?').get('prompt') as
      | { lock_token: string | null }
      | undefined;
    expect(lease?.lock_token).toBeNull();
  });
});

describe('running a job by hand', () => {
  it('refuses a job an operator has disabled', async () => {
    scheduler.registerAll([
      {
        name: 'paused',
        description: 'Switched off deliberately.',
        intervalSeconds: 3600,
        hasSideEffects: true,
        timeoutSeconds: 30,
        run: async () => ({ itemsProcessed: 1 }),
      },
    ]);
    scheduler.setEnabled('paused', false);

    // Disabling is an operational pause. A manual run that ignores it makes the
    // pause meaningless — an owner who switched off the launch queue did so to
    // stop launches happening, by any route.
    const result = await scheduler.runNow('paused');
    expect(result.started).toBe(false);
    expect(result.reason).toMatch(/disabled/i);
    expect(runOf('paused')).toBeUndefined();
  });

  it('runs one that is enabled', async () => {
    scheduler.registerAll([
      {
        name: 'live',
        description: 'Enabled.',
        intervalSeconds: 3600,
        hasSideEffects: false,
        timeoutSeconds: 30,
        run: async () => ({ itemsProcessed: 1 }),
      },
    ]);

    const result = await scheduler.runNow('live');
    expect(result.started).toBe(true);
    await waitFor(() => runOf('live')?.status === 'succeeded', 5_000);
  });
});
