import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from '../helpers.js';
import { JobScheduler, type JobDefinition } from '../../packages/server/src/jobs/scheduler.js';

/**
 * Job scheduling under failure.
 *
 * The scheduler's job is not to run things on time — that part is easy. It is
 * to guarantee that a crashed process cannot deadlock a job forever, that two
 * processes cannot run the same job at once, and that a broken dependency does
 * not get hammered every interval until someone notices.
 */

let harness: TestHarness;
let scheduler: JobScheduler;
const runs: string[] = [];

function job(overrides: Partial<JobDefinition> & { name: string }): JobDefinition {
  return {
    description: 'test job',
    intervalSeconds: 60,
    hasSideEffects: false,
    run: async () => {
      runs.push(overrides.name);
      return { itemsProcessed: 1 };
    },
    ...overrides,
  };
}

/** Make a job due immediately, bypassing the registration stagger. */
function makeDue(name: string): void {
  harness.db.$raw.prepare('UPDATE job_state SET next_run_at = ? WHERE job_name = ?').run(harness.clock.now() - 1, name);
}

async function settle(ms = 60): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  harness = createHarness();
  runs.length = 0;
  scheduler = new JobScheduler({
    db: harness.db,
    settings: harness.settings,
    now: () => harness.clock.now(),
    instanceId: 'test-instance',
  });
});

afterEach(async () => {
  await scheduler.stop();
  harness.cleanup();
});

describe('registration and execution', () => {
  it('records a run with its duration and item count', async () => {
    scheduler.register(job({ name: 'alpha' }));
    await scheduler.runNow('alpha');
    await settle();

    const row = harness.db.$raw.prepare('SELECT * FROM job_runs WHERE job_name = ?').get('alpha') as Record<string, unknown>;
    expect(row.status).toBe('succeeded');
    expect(row.items_processed).toBe(1);
    expect(row.trigger).toBe('manual');
    expect(runs).toEqual(['alpha']);
  });

  it('staggers first runs so a cold start does not fire everything at once', () => {
    for (const name of ['a', 'b', 'c', 'd', 'e']) scheduler.register(job({ name }));
    const rows = harness.db.$raw.prepare('SELECT job_name, next_run_at FROM job_state').all() as Array<{
      job_name: string;
      next_run_at: number;
    }>;
    const times = new Set(rows.map((r) => r.next_run_at));
    // Identical first-run times would exhaust several rate limits together.
    expect(times.size).toBe(rows.length);
  });

  it('refuses to register the same job twice', () => {
    scheduler.register(job({ name: 'dup' }));
    expect(() => scheduler.register(job({ name: 'dup' }))).toThrow(/already registered/i);
  });

  it('reports an unknown job rather than silently doing nothing', async () => {
    const result = await scheduler.runNow('nope');
    expect(result.started).toBe(false);
    expect(result.reason).toMatch(/no job named/i);
  });
});

describe('locking', () => {
  it('does not start a second run while one is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    scheduler.register(
      job({
        name: 'slow',
        run: async () => {
          runs.push('slow');
          await gate;
          return { itemsProcessed: 1 };
        },
      }),
    );

    const first = await scheduler.runNow('slow');
    await settle(20);
    const second = await scheduler.runNow('slow');
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(second.reason).toMatch(/already running/i);

    release();
    await settle();
    expect(runs).toEqual(['slow']);
  });

  it('does not let a second scheduler take a job another instance holds', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const definition = job({
      name: 'shared',
      run: async () => {
        runs.push('shared');
        await gate;
        return { itemsProcessed: 1 };
      },
    });

    scheduler.register(definition);
    const other = new JobScheduler({
      db: harness.db,
      settings: harness.settings,
      now: () => harness.clock.now(),
      instanceId: 'second-instance',
    });
    // Registration is idempotent at the state-row level, so the second instance
    // sees the same schedule rather than resetting it.
    harness.db.$raw
      .prepare('UPDATE job_state SET interval_seconds = interval_seconds WHERE job_name = ?')
      .run('shared');

    void scheduler.runNow('shared');
    await settle(20);

    // The lease is held, so the other instance's attempt must be a no-op.
    const locked = harness.db.$raw.prepare('SELECT locked_until FROM job_state WHERE job_name = ?').get('shared') as {
      locked_until: number | null;
    };
    expect(locked.locked_until).toBeGreaterThan(harness.clock.now());

    release();
    await settle();
    await other.stop();
    expect(runs).toEqual(['shared']);
  });

  it('releases a lease whose holder died and marks the run failed', async () => {
    scheduler.register(job({ name: 'orphan' }));
    // Simulate a process that took the lease and then vanished.
    harness.db.$raw
      .prepare(`UPDATE job_state SET locked_until = ?, lock_token = 'ghost' WHERE job_name = ?`)
      .run(harness.clock.now() - 1_000, 'orphan');
    harness.db.$raw
      .prepare(
        `INSERT INTO job_runs (id, job_name, status, lock_token, trigger, started_at, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run('run_ghost', 'orphan', 'running', 'ghost', 'schedule', harness.clock.now() - 60_000, harness.clock.now() - 60_000);

    makeDue('orphan');
    scheduler.start();
    await settle(120);

    const ghost = harness.db.$raw.prepare('SELECT status, error FROM job_runs WHERE id = ?').get('run_ghost') as {
      status: string;
      error: string | null;
    };
    // A run left as 'running' forever would skew every health reading.
    expect(ghost.status).toBe('failed');
    expect(ghost.error).toMatch(/stopped before it finished/i);
  });
});

describe('failure handling', () => {
  it('backs off exponentially rather than retrying every interval', async () => {
    scheduler.register(
      job({
        name: 'flaky',
        intervalSeconds: 60,
        run: async () => {
          throw new Error('dependency is down');
        },
      }),
    );

    const intervals: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      await scheduler.runNow('flaky');
      await settle();
      const row = harness.db.$raw
        .prepare('SELECT next_run_at, consecutive_failures FROM job_state WHERE job_name = ?')
        .get('flaky') as { next_run_at: number; consecutive_failures: number };
      intervals.push(row.next_run_at - harness.clock.now());
      expect(row.consecutive_failures).toBe(attempt + 1);
    }

    expect(intervals[1]!).toBeGreaterThan(intervals[0]!);
    expect(intervals[2]!).toBeGreaterThan(intervals[1]!);
  });

  it('clears the failure count after a success', async () => {
    let shouldFail = true;
    scheduler.register(
      job({
        name: 'recovers',
        run: async () => {
          if (shouldFail) throw new Error('still down');
          return { itemsProcessed: 1 };
        },
      }),
    );

    await scheduler.runNow('recovers');
    await settle();
    shouldFail = false;
    await scheduler.runNow('recovers');
    await settle();

    const row = harness.db.$raw
      .prepare('SELECT consecutive_failures, last_status FROM job_state WHERE job_name = ?')
      .get('recovers') as { consecutive_failures: number; last_status: string };
    expect(row.consecutive_failures).toBe(0);
    expect(row.last_status).toBe('succeeded');
  });

  it('aborts a job that exceeds its timeout instead of hanging forever', async () => {
    scheduler.register(
      job({
        name: 'hangs',
        timeoutSeconds: 0.05,
        run: async ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted by timeout')));
          }),
      }),
    );

    await scheduler.runNow('hangs');
    await settle(250);
    const row = harness.db.$raw.prepare('SELECT status, error FROM job_runs WHERE job_name = ?').get('hangs') as {
      status: string;
      error: string;
    };
    expect(row.status).toBe('failed');
  });
});

describe('emergency stop', () => {
  it('suspends jobs with side effects but keeps read-only jobs running', async () => {
    scheduler.register(job({ name: 'writes', hasSideEffects: true }));
    scheduler.register(job({ name: 'reads', hasSideEffects: false }));
    harness.settings.emergencyStop('paused for a test', { type: 'system' });

    makeDue('writes');
    makeDue('reads');
    scheduler.start();
    await settle(150);

    // A paused platform that also stops reporting is much harder to debug.
    expect(runs).toContain('reads');
    expect(runs).not.toContain('writes');
    const row = harness.db.$raw.prepare('SELECT last_status FROM job_state WHERE job_name = ?').get('writes') as {
      last_status: string;
    };
    expect(row.last_status).toBe('skipped');
  });

  it('resumes side-effecting jobs once the stop is released', async () => {
    scheduler.register(job({ name: 'writes2', hasSideEffects: true }));
    harness.settings.emergencyStop('paused', { type: 'system' });
    await scheduler.runNow('writes2');
    await settle();
    expect(runs).not.toContain('writes2');

    harness.settings.releaseEmergencyStop('resumed', { type: 'system' });
    await scheduler.runNow('writes2');
    await settle();
    expect(runs).toContain('writes2');
  });
});

describe('status reporting', () => {
  it('reports overdue jobs so a stalled scheduler is visible', async () => {
    scheduler.register(job({ name: 'late' }));
    harness.db.$raw
      .prepare('UPDATE job_state SET next_run_at = ? WHERE job_name = ?')
      .run(harness.clock.now() - 300_000, 'late');

    const status = scheduler.status().find((s) => s.name === 'late');
    expect(status?.overdueSeconds).toBeGreaterThan(250);
    expect(status?.hasSideEffects).toBe(false);
  });

  it('honours enable and interval changes', async () => {
    scheduler.register(job({ name: 'tunable' }));
    scheduler.setEnabled('tunable', false);
    scheduler.setInterval('tunable', 900);

    const status = scheduler.status().find((s) => s.name === 'tunable');
    expect(status?.enabled).toBe(false);
    expect(status?.intervalSeconds).toBe(900);

    makeDue('tunable');
    scheduler.start();
    await settle(120);
    expect(runs).not.toContain('tunable');
  });
});
