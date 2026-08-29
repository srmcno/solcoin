import { randomUUID } from 'node:crypto';
import { AppError, safeErrorText } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { componentLogger } from '../core/logger.js';
import type { Db } from '../db/client.js';
import type { SettingsService } from '../services/settings.service.js';

/**
 * Background job scheduler.
 *
 * Deliberately not a queue library. The workload is a fixed set of recurring
 * jobs on a single node, and a broker would add an operational dependency
 * without solving a problem this system has. What it does need — and what this
 * provides — is:
 *
 *  - **Durable schedules.** Next-run times live in the database, so a restart
 *    resumes rather than resetting every interval.
 *  - **Locking.** A lease with an expiry means two processes (or a restarted
 *    one) cannot run the same job concurrently, and a crashed run cannot
 *    deadlock the job forever.
 *  - **Observability.** Every run is recorded with duration, outcome and item
 *    counts, so "is the platform actually working?" is answerable.
 *  - **Backoff.** Repeated failures push the next run further out instead of
 *    hammering a broken dependency every interval.
 *  - **Honest halting.** When the emergency stop is engaged, jobs with side
 *    effects do not run at all; read-only jobs continue so the dashboard stays
 *    accurate while the platform is paused.
 */

export interface JobContext {
  signal: AbortSignal;
  runId: string;
  /** Report progress so a long job is not opaque. */
  progress: (itemsProcessed: number, note?: string) => void;
}

export interface JobDefinition {
  name: string;
  description: string;
  intervalSeconds: number;
  /** Jobs with side effects are suspended by the emergency stop. */
  hasSideEffects: boolean;
  /** Skip entirely unless this returns true. */
  enabledWhen?: (settings: SettingsService) => boolean;
  /** Maximum run time before the job is aborted. */
  timeoutSeconds?: number;
  run: (context: JobContext) => Promise<{ itemsProcessed?: number; result?: unknown } | void>;
}

export interface SchedulerOptions {
  db: Db;
  settings: SettingsService;
  /** Poll interval for the scheduler loop itself. */
  tickMs?: number;
  now?: () => number;
  /** Identifies this process in job leases. */
  instanceId?: string;
}

export class JobScheduler {
  private readonly log = componentLogger('scheduler');
  private readonly jobs = new Map<string, JobDefinition>();
  private readonly running = new Map<string, AbortController>();
  private readonly instanceId: string;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.instanceId = options.instanceId ?? randomUUID();
  }

  register(job: JobDefinition): void {
    if (this.jobs.has(job.name)) throw new AppError('conflict', `Job "${job.name}" is already registered.`);
    this.jobs.set(job.name, job);
    this.options.db.$raw
      .prepare(
        `INSERT INTO job_state (job_name, enabled, interval_seconds, next_run_at, updated_at)
         VALUES (?, 1, ?, ?, ?)
         ON CONFLICT(job_name) DO UPDATE SET interval_seconds = excluded.interval_seconds, updated_at = excluded.updated_at`,
      )
      // Stagger first runs so a cold start does not fire every job at once and
      // immediately exhaust several rate limits.
      .run(job.name, job.intervalSeconds, this.now() + this.staggerFor(job.name), this.now());
  }

  registerAll(jobs: JobDefinition[]): void {
    for (const job of jobs) this.register(job);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = this.options.tickMs ?? 5_000;
    this.timer = setInterval(() => {
      void this.tick().catch((e) => this.log.error({ err: safeErrorText(e, 200) }, 'scheduler tick failed'));
    }, tick);
    // Do not hold the event loop open purely for the scheduler.
    this.timer.unref?.();
    this.log.info({ jobs: this.jobs.size, instanceId: this.instanceId }, 'job scheduler started');
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const [name, controller] of this.running) {
      this.log.info({ job: name }, 'aborting running job for shutdown');
      controller.abort(new Error('scheduler shutting down'));
    }
    // Give in-flight jobs a moment to unwind so their run rows are finalised.
    const deadline = this.now() + 5_000;
    while (this.running.size > 0 && this.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this.releaseStaleLocks(true);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    this.releaseStaleLocks(false);

    const due = this.options.db.$raw
      .prepare(
        `SELECT job_name FROM job_state
          WHERE enabled = 1 AND next_run_at <= ? AND (locked_until IS NULL OR locked_until < ?)
          ORDER BY next_run_at ASC`,
      )
      .all(this.now(), this.now()) as Array<{ job_name: string }>;

    for (const { job_name: name } of due) {
      const job = this.jobs.get(name);
      if (!job) continue;
      if (this.running.has(name)) continue;
      void this.execute(job);
    }
  }

  /** Run a job now, outside its schedule. */
  async runNow(name: string): Promise<{ started: boolean; reason?: string }> {
    const job = this.jobs.get(name);
    if (!job) return { started: false, reason: `No job named "${name}".` };
    if (this.running.has(name)) return { started: false, reason: 'Already running.' };
    void this.execute(job, 'manual');
    return { started: true };
  }

  private async execute(job: JobDefinition, trigger: 'schedule' | 'manual' = 'schedule'): Promise<void> {
    const settings = this.options.settings.get();

    if (job.hasSideEffects && settings.emergencyStop) {
      this.scheduleNext(job, 'skipped');
      return;
    }
    if (job.enabledWhen && !job.enabledWhen(this.options.settings)) {
      this.scheduleNext(job, 'skipped');
      return;
    }

    // Acquire the lease. The conditional UPDATE is the atomic step: if another
    // process took it between our SELECT and here, `changes` is zero.
    const lockToken = randomUUID();
    const timeoutMs = (job.timeoutSeconds ?? Math.max(120, job.intervalSeconds * 3)) * 1000;
    const acquired = this.options.db.$raw
      .prepare(
        `UPDATE job_state SET locked_until = ?, lock_token = ?, updated_at = ?
          WHERE job_name = ? AND (locked_until IS NULL OR locked_until < ?)`,
      )
      .run(this.now() + timeoutMs, lockToken, this.now(), job.name, this.now()).changes;
    if (acquired === 0) return;

    const runId = newId('job', this.now());
    const controller = new AbortController();
    this.running.set(job.name, controller);

    let itemsProcessed = 0;
    let timeoutReject: ((reason: Error) => void) | null = null;
    const timer = setTimeout(() => {
      const error = new Error(`job timed out after ${timeoutMs}ms`);
      controller.abort(error);
      timeoutReject?.(error);
    }, timeoutMs);

    this.options.db.$raw
      .prepare(
        `INSERT INTO job_runs (id, job_name, status, lock_token, trigger, started_at, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(runId, job.name, 'running', lockToken, trigger, this.now(), this.now());

    const started = this.now();

    /*
     * The abort signal is a request, not a guarantee.
     *
     * Aborting the controller only tells a cooperating job to stop. A job that
     * does not consume the signal — or a provider inside it that ignores the
     * one it was handed — leaves `job.run(...)` pending forever, so the run
     * never finishes, the slot stays occupied for the life of the process, and
     * the database lease expires underneath it, letting a second scheduler
     * start the same work.
     *
     * Racing the run against the deadline bounds it whether or not anyone is
     * listening. The abandoned work may still be running, so the lease is held
     * until it actually settles: releasing it at the deadline is precisely
     * what would let two copies overlap.
     */
    let settled = false;
    const timedOut = new Promise<never>((_, reject) => {
      timeoutReject = reject;
    });

    const work = job
      .run({
        signal: controller.signal,
        runId,
        progress: (count, note) => {
          itemsProcessed = count;
          if (note) this.log.debug({ job: job.name, count, note }, 'job progress');
        },
      })
      .finally(() => {
        settled = true;
      });

    try {
      const outcome = await Promise.race([work, timedOut]);
      const duration = this.now() - started;
      itemsProcessed = outcome?.itemsProcessed ?? itemsProcessed;

      this.options.db.$raw
        .prepare(
          `UPDATE job_runs SET status = 'succeeded', finished_at = ?, duration_ms = ?, items_processed = ?, result = ?
           WHERE id = ?`,
        )
        .run(this.now(), duration, itemsProcessed, outcome?.result ? JSON.stringify(outcome.result).slice(0, 8000) : null, runId);

      this.scheduleNext(job, 'succeeded');
      if (duration > 30_000) {
        this.log.info({ job: job.name, durationMs: duration, itemsProcessed }, 'job completed');
      }
    } catch (e) {
      const duration = this.now() - started;
      const message = safeErrorText(e, 600);
      this.options.db.$raw
        .prepare(
          `UPDATE job_runs SET status = 'failed', finished_at = ?, duration_ms = ?, items_processed = ?, error = ?
           WHERE id = ?`,
        )
        .run(this.now(), duration, itemsProcessed, message, runId);
      this.scheduleNext(job, 'failed');
      this.log.error({ job: job.name, err: message, durationMs: duration }, 'job failed');
    } finally {
      clearTimeout(timer);

      const release = (): void => {
        this.running.delete(job.name);
        this.options.db.$raw
          .prepare(`UPDATE job_state SET locked_until = NULL, lock_token = NULL, updated_at = ? WHERE job_name = ? AND lock_token = ?`)
          .run(this.now(), job.name, lockToken);
      };

      if (settled) {
        release();
      } else {
        // Timed out with the work still running. Holding the lease until it
        // stops is the whole point: a second copy started now would be doing
        // the same side effects alongside the first.
        this.log.warn(
          { job: job.name, timeoutMs },
          'job exceeded its timeout and did not stop; holding its lease until the abandoned run settles',
        );
        void work
          .catch(() => undefined)
          .finally(() => {
            this.log.warn({ job: job.name }, 'an abandoned job run finally settled; releasing its lease');
            release();
          });
      }
    }
  }

  /**
   * Compute the next run time.
   *
   * Failures back off exponentially up to an hour: a job whose dependency is
   * down should not retry every thirty seconds for the rest of the day.
   */
  private scheduleNext(job: JobDefinition, status: 'succeeded' | 'failed' | 'skipped'): void {
    const row = this.options.db.$raw.prepare('SELECT consecutive_failures FROM job_state WHERE job_name = ?').get(job.name) as
      | { consecutive_failures: number }
      | undefined;
    const previousFailures = row?.consecutive_failures ?? 0;
    const failures = status === 'failed' ? previousFailures + 1 : 0;

    const baseMs = job.intervalSeconds * 1000;
    const backoff = failures > 0 ? Math.min(3_600_000, baseMs * 2 ** Math.min(failures, 6)) : baseMs;
    // Jitter avoids convoying: without it, jobs registered together stay locked
    // in step forever and spike the same rate limits simultaneously.
    const jitter = 1 + (Math.random() - 0.5) * 0.15;

    this.options.db.$raw
      .prepare(
        `UPDATE job_state SET last_run_at = ?, next_run_at = ?, last_status = ?, consecutive_failures = ?, updated_at = ?
         WHERE job_name = ?`,
      )
      .run(this.now(), this.now() + Math.round(backoff * jitter), status, failures, this.now(), job.name);
  }

  /**
   * Release leases whose holder died.
   *
   * A lease that expired without being cleared means the process holding it
   * crashed mid-run. The corresponding run row is marked failed so it does not
   * sit as `running` forever and skew the health view.
   */
  private releaseStaleLocks(force: boolean): void {
    const cutoff = force ? this.now() + 1 : this.now();
    const stale = this.options.db.$raw
      .prepare('SELECT job_name, lock_token FROM job_state WHERE locked_until IS NOT NULL AND locked_until < ?')
      .all(cutoff) as Array<{ job_name: string; lock_token: string | null }>;

    for (const { job_name, lock_token } of stale) {
      if (this.running.has(job_name) && !force) continue;
      this.options.db.$raw
        .prepare('UPDATE job_state SET locked_until = NULL, lock_token = NULL, updated_at = ? WHERE job_name = ?')
        .run(this.now(), job_name);
      if (lock_token) {
        this.options.db.$raw
          .prepare(
            `UPDATE job_runs SET status = 'failed', error = 'The process running this job stopped before it finished.',
                                 finished_at = ? WHERE lock_token = ? AND status = 'running'`,
          )
          .run(this.now(), lock_token);
      }
    }
  }

  /** Deterministic per-job stagger so identical deployments do not synchronise. */
  private staggerFor(name: string): number {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return 2_000 + (hash % 45_000);
  }

  setEnabled(name: string, enabled: boolean): void {
    this.options.db.$raw
      .prepare('UPDATE job_state SET enabled = ?, updated_at = ? WHERE job_name = ?')
      .run(enabled ? 1 : 0, this.now(), name);
  }

  setInterval(name: string, intervalSeconds: number): void {
    this.options.db.$raw
      .prepare('UPDATE job_state SET interval_seconds = ?, next_run_at = ?, updated_at = ? WHERE job_name = ?')
      .run(intervalSeconds, this.now() + intervalSeconds * 1000, this.now(), name);
  }

  /** Job status for the System Health dashboard. */
  status(): Array<{
    name: string;
    description: string;
    enabled: boolean;
    intervalSeconds: number;
    lastRunAt: number | null;
    nextRunAt: number | null;
    lastStatus: string | null;
    consecutiveFailures: number;
    running: boolean;
    overdueSeconds: number;
    hasSideEffects: boolean;
  }> {
    const rows = this.options.db.$raw.prepare('SELECT * FROM job_state').all() as Array<Record<string, unknown>>;
    return rows
      .filter((r) => this.jobs.has(String(r.job_name)))
      .map((r) => {
        const job = this.jobs.get(String(r.job_name))!;
        const nextRunAt = r.next_run_at !== null ? Number(r.next_run_at) : null;
        return {
          name: job.name,
          description: job.description,
          enabled: Boolean(r.enabled),
          intervalSeconds: Number(r.interval_seconds),
          lastRunAt: r.last_run_at !== null ? Number(r.last_run_at) : null,
          nextRunAt,
          lastStatus: (r.last_status as string | null) ?? null,
          consecutiveFailures: Number(r.consecutive_failures ?? 0),
          running: this.running.has(job.name),
          overdueSeconds: nextRunAt && nextRunAt < this.now() ? Math.round((this.now() - nextRunAt) / 1000) : 0,
          hasSideEffects: job.hasSideEffects,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async recentRuns(jobName?: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    if (jobName) {
      return this.options.db.$raw
        .prepare('SELECT * FROM job_runs WHERE job_name = ? ORDER BY created_at DESC LIMIT ?')
        .all(jobName, limit) as Array<Record<string, unknown>>;
    }
    return this.options.db.$raw
      .prepare('SELECT * FROM job_runs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
  }
}
