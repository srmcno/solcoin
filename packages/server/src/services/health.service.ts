import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { TIME, lamportsToSol, median, shrinkToPrior, wilsonInterval, type HealthState } from '@solcoin/shared';
import { safeErrorText } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { parseJson, stringify } from '../core/json.js';
import { componentLogger } from '../core/logger.js';
import type { Db } from '../db/client.js';
import type { Provider, ProviderStatus } from '../providers/types.js';
import type { SettingsService } from './settings.service.js';

/**
 * System health.
 *
 * The purpose of this service is to answer one question honestly: *can this
 * platform currently do its job, and if not, what is stopping it?* Two design
 * rules follow from that:
 *
 *  - **"unconfigured" is not "broken".** The platform is built to run with any
 *    subset of its integrations present. A provider with no credential reports
 *    `unconfigured`, and that state never degrades overall health — otherwise
 *    every install would show red on day one and the operator would learn to
 *    ignore the indicator, which is the only failure mode that actually matters.
 *  - **A hung dependency must not hang the check.** Every provider probe runs
 *    concurrently behind a hard timeout, so the status endpoint answers in
 *    bounded time no matter how badly a third party is behaving.
 */

export type HealthComponentKind = 'provider' | 'database' | 'scheduler' | 'disk' | 'wallet' | 'clock';

/**
 * Availability over the recorded history of a provider, with honest bounds.
 *
 * Never a bare percentage: a rate is only ever published with the sample size
 * it came from, a 95% interval, the fleet-wide rate it was shrunk toward, and
 * a statement of what would bias it.
 */
export type Availability =
  | { sufficient: false; n: number; reason: string }
  | {
      sufficient: true;
      /** Observations (successes + failures) behind this estimate. */
      n: number;
      /** Raw successes / n for this provider alone. Unshrunk, so 20/20 reads 1. */
      observed: number;
      /**
       * 95% Wilson bounds on `observed`. They bound the *raw* rate; they are
       * deliberately not an interval around `point`.
       */
      observedLower: number;
      observedUpper: number;
      /**
       * The estimate to rank providers by: `observed` shrunk toward
       * `fleet.rate` in proportion to how little evidence this provider has.
       * On a thin sample it sits outside [observedLower, observedUpper] — that
       * is the shrinkage working, not an inconsistency.
       */
      point: number;
      /** Pooled rate across every registered provider, and its sample size. */
      fleet: { rate: number; n: number };
      /** Why this number is weaker evidence than a percentage looks. */
      caveat: string;
    };

export interface HealthComponent {
  id: string;
  label: string;
  kind: HealthComponentKind;
  state: HealthState;
  /** Always a sentence a human can act on, never just a status word. */
  detail: string;
  latencyMs?: number;
  /**
   * Whether the platform is unable to operate at all without this component.
   * Only an essential component being `down` can make the system `down`.
   */
  essential: boolean;
  metrics?: Record<string, number | string | boolean | null>;
  availability?: Availability;
  checkedAt: number;
}

export interface SystemHealth {
  overall: 'ok' | 'degraded' | 'down';
  checkedAt: number;
  components: HealthComponent[];
  summary: string;
}

export interface ProviderStateChange {
  at: number;
  from: string;
  to: string;
  detail: string;
  latencyMs: number | null;
}

/** A provider probe must be cheap; anything slower than this is a fault. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Results are reused for this long unless `force` is set. The dashboard polls
 * status far more often than provider health can meaningfully change, and each
 * probe costs a real request against a real quota.
 */
const CACHE_TTL_MS = 15_000;

/** Consecutive failures before this service opens a provider's circuit. */
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_BASE_COOLDOWN_MS = 30 * TIME.second;
const CIRCUIT_MAX_COOLDOWN_MS = 15 * TIME.minute;

/**
 * Minimum probes before an availability *rate* is reported at all. Below this,
 * a Wilson interval spans most of the unit interval and a "100% uptime" badge
 * off three samples is worse than no badge.
 */
const MIN_AVAILABILITY_SAMPLES = 20;

/**
 * Pseudo-observations of the fleet-wide rate mixed into each provider's own
 * rate before it is published as `point`.
 *
 * Availabilities are read side by side, and an unshrunk 20/20 reads as a
 * flawless provider next to a 5,000-observation one at 99.5%. It is not
 * flawless, it is barely measured. At this strength a provider needs roughly
 * ten observations of its own before its record outweighs the fleet's.
 */
const AVAILABILITY_PRIOR_STRENGTH = 10;

/**
 * Attached to every published availability. Two things make this number weaker
 * than a percentage looks, and both are structural rather than incidental:
 * the counters never reset, and the sample selects itself.
 */
const AVAILABILITY_CAVEAT =
  'Cumulative over the whole recorded history, not a rate over a recent window, and it mixes synthetic probes with real request outcomes. It is also biased upward by selection: while a provider is failing its circuit opens and the client refuses to send, so failures stop being counted for exactly as long as it is broken. Read it as a coarse reliability ranking, never as an SLA measurement.';

/**
 * Latency probes taken per database check. A single reading is n = 1 and query
 * latency is heavily right-skewed, so one GC pause or one fsync would otherwise
 * be enough to flip the component to `degraded`. The median decides the state;
 * the slowest reading is reported next to it so the tail is never hidden.
 */
const DB_LATENCY_SAMPLES = 5;

/** A job overdue by more than this multiple of its own interval is late. */
const OVERDUE_INTERVAL_MULTIPLE = 2;

/** Consecutive job failures tolerated before the scheduler counts as degraded. */
const JOB_FAILURE_TOLERANCE = 2;

const DB_LATENCY_WARN_MS = 250;

export class HealthService {
  private readonly log = componentLogger('health');
  private readonly providers = new Map<string, Provider>();
  private cached: SystemHealth | null = null;

  /**
   * Wall-clock and monotonic readings taken together at construction. Their
   * divergence since is the only clock anomaly detectable without a network
   * time source: it catches the wall clock *jumping* (NTP step, VM resume,
   * manual change), not a steady offset from true UTC. Reported as exactly that.
   */
  private readonly startedWallMs: number;
  private readonly startedMonotonicMs: number;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly now: () => number = Date.now,
  ) {
    this.startedWallMs = this.now();
    this.startedMonotonicMs = performance.now();
  }

  /** Hold the set of providers to probe. Replaces any previous registration. */
  register(providers: Provider[]): void {
    this.providers.clear();
    for (const provider of providers) this.providers.set(provider.id, provider);
    this.cached = null;
    this.log.debug({ providers: [...this.providers.keys()] }, 'registered providers for health probing');
  }

  async checkAll(options: { force?: boolean } = {}): Promise<SystemHealth> {
    if (!options.force && this.cached && this.now() - this.cached.checkedAt < CACHE_TTL_MS) {
      return this.cached;
    }

    const checkedAt = this.now();
    const [providerComponents, diskComponent] = await Promise.all([this.checkProviders(), this.checkDisk()]);

    const components: HealthComponent[] = [
      this.checkDatabase(),
      this.checkScheduler(),
      diskComponent,
      this.checkWallet(),
      this.checkClock(),
      ...providerComponents,
    ];

    const health: SystemHealth = {
      overall: overallState(components),
      checkedAt,
      components,
      summary: summarise(components),
    };
    this.cached = health;
    return health;
  }

  /**
   * Fold a single real call's outcome into a provider's counters.
   *
   * Deliberately cheap — one upsert, no reads — because this is fed by the
   * HttpClient `onResult` hook on every request. Real traffic is better
   * evidence than a synthetic probe, so these counters and the probe's share
   * the same row.
   */
  recordProviderResult(providerId: string, ok: boolean, latencyMs: number, detail?: string): void {
    const kind = this.providers.get(providerId)?.kind ?? 'unknown';
    const timestamp = this.now();
    this.db.$raw
      .prepare(
        `INSERT INTO provider_health
           (id, provider, kind, state, detail, latency_ms, success_count, failure_count, consecutive_failures,
            circuit_open_until, rate_limit_reset_at, last_success_at, last_failure_at, checked_at)
         VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           state = excluded.state,
           detail = excluded.detail,
           latency_ms = excluded.latency_ms,
           success_count = provider_health.success_count + excluded.success_count,
           failure_count = provider_health.failure_count + excluded.failure_count,
           consecutive_failures = CASE WHEN excluded.failure_count = 0 THEN 0 ELSE provider_health.consecutive_failures + 1 END,
           last_success_at = COALESCE(excluded.last_success_at, provider_health.last_success_at),
           last_failure_at = COALESCE(excluded.last_failure_at, provider_health.last_failure_at),
           checked_at = excluded.checked_at`,
      )
      .run(
        providerId,
        providerId,
        kind,
        ok ? 'ok' : 'degraded',
        detail ?? (ok ? 'Live request succeeded.' : 'Live request failed.'),
        Math.round(latencyMs),
        ok ? 1 : 0,
        ok ? 0 : 1,
        ok ? 0 : 1,
        ok ? timestamp : null,
        ok ? null : timestamp,
        timestamp,
      );
  }

  /**
   * Recent state changes for a provider.
   *
   * `provider_health` holds only the current state, so transitions are written
   * to `system_events` as they happen and read back here. That also means the
   * history is bounded by whatever retention `system_events` has, rather than
   * growing unboundedly in a dedicated table.
   */
  history(providerId: string, limit = 50): ProviderStateChange[] {
    const rows = this.db.$raw
      .prepare(
        `SELECT created_at, context FROM system_events
          WHERE component = 'health' AND ref_type = 'provider' AND ref_id = ?
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(providerId, Math.min(Math.max(limit, 1), 500)) as Array<{ created_at: number; context: string | null }>;

    return rows.map((row) => {
      const context = parseJson<{ from?: string; to?: string; detail?: string; latencyMs?: number | null }>(row.context, {});
      return {
        at: Number(row.created_at),
        from: context.from ?? 'unknown',
        to: context.to ?? 'unknown',
        detail: context.detail ?? '',
        latencyMs: context.latencyMs ?? null,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Provider probes
  // -------------------------------------------------------------------------

  private async checkProviders(): Promise<HealthComponent[]> {
    const providers = [...this.providers.values()];
    if (providers.length === 0) return [];

    // allSettled + per-probe timeout: one hung provider cannot stall the check.
    const results = await Promise.allSettled(providers.map((p) => withTimeout(p.healthCheck(), PROBE_TIMEOUT_MS, p.id)));

    // Two passes. The first persists each probe and collects its counters; the
    // second builds the components, because a provider's availability is only
    // interpretable against the pooled rate of the whole fleet and that is not
    // known until every provider has been folded in.
    const probed = providers.map((provider, index) => {
      const settled = results[index];
      const checkedAt = this.now();

      let status: ProviderStatus;
      if (settled?.status === 'fulfilled') {
        status = settled.value;
      } else {
        const reason = settled ? safeErrorText(settled.reason, 300) : 'the probe produced no result';
        status = {
          id: provider.id,
          label: provider.label,
          kind: provider.kind,
          state: 'down',
          detail: `Health probe failed: ${reason}`,
          requiresCredentials: false,
        };
      }

      return { status, counters: this.persistProviderStatus(status, checkedAt), checkedAt };
    });

    const fleetSuccesses = probed.reduce((total, p) => total + p.counters.successCount, 0);
    const fleetTrials = probed.reduce((total, p) => total + p.counters.successCount + p.counters.failureCount, 0);
    // With no observations anywhere there is no fleet rate to shrink toward.
    // Assuming 1.0 would invent optimism, so fall back to the uninformative 0.5.
    const fleet = { rate: fleetTrials > 0 ? fleetSuccesses / fleetTrials : 0.5, n: fleetTrials };

    return probed.map((p) => this.toComponent(p.status, p.counters, p.checkedAt, fleet));
  }

  /**
   * Upsert the probe result, maintaining the counters and the circuit breaker.
   *
   * `unconfigured` and `unknown` are neutral: they neither count as a success
   * nor as a failure, because a provider the operator has not set up has not
   * failed at anything.
   */
  private persistProviderStatus(
    status: ProviderStatus,
    checkedAt: number,
  ): { state: string; successCount: number; failureCount: number; consecutiveFailures: number; circuitOpenUntil: number | null } {
    const existing = this.db.$raw
      .prepare(
        'SELECT state, success_count, failure_count, consecutive_failures, circuit_open_until FROM provider_health WHERE id = ?',
      )
      .get(status.id) as
      | {
          state: string;
          success_count: number;
          failure_count: number;
          consecutive_failures: number;
          circuit_open_until: number | null;
        }
      | undefined;

    const neutral = status.state === 'unconfigured' || status.state === 'unknown';
    const ok = status.state === 'ok' || status.state === 'degraded';

    const successCount = (existing?.success_count ?? 0) + (!neutral && ok ? 1 : 0);
    const failureCount = (existing?.failure_count ?? 0) + (!neutral && !ok ? 1 : 0);
    const consecutiveFailures = neutral
      ? (existing?.consecutive_failures ?? 0)
      : ok
        ? 0
        : (existing?.consecutive_failures ?? 0) + 1;

    // Cooldown grows with the failure streak so a persistently dead provider is
    // probed rarely, while a one-off blip recovers quickly.
    const circuitOpenUntil =
      consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD
        ? checkedAt +
          Math.min(CIRCUIT_MAX_COOLDOWN_MS, CIRCUIT_BASE_COOLDOWN_MS * 2 ** (consecutiveFailures - CIRCUIT_FAILURE_THRESHOLD))
        : null;

    this.db.$raw
      .prepare(
        `INSERT INTO provider_health
           (id, provider, kind, state, detail, latency_ms, success_count, failure_count, consecutive_failures,
            circuit_open_until, rate_limit_reset_at, last_success_at, last_failure_at, checked_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           kind = excluded.kind,
           state = excluded.state,
           detail = excluded.detail,
           latency_ms = excluded.latency_ms,
           success_count = excluded.success_count,
           failure_count = excluded.failure_count,
           consecutive_failures = excluded.consecutive_failures,
           circuit_open_until = excluded.circuit_open_until,
           rate_limit_reset_at = COALESCE(excluded.rate_limit_reset_at, provider_health.rate_limit_reset_at),
           last_success_at = COALESCE(excluded.last_success_at, provider_health.last_success_at),
           last_failure_at = COALESCE(excluded.last_failure_at, provider_health.last_failure_at),
           checked_at = excluded.checked_at`,
      )
      .run(
        status.id,
        status.id,
        status.kind,
        status.state,
        status.detail.slice(0, 500),
        status.latencyMs !== undefined ? Math.round(status.latencyMs) : null,
        successCount,
        failureCount,
        consecutiveFailures,
        circuitOpenUntil,
        status.quotaResetAt ?? null,
        !neutral && ok ? checkedAt : (status.lastSuccessAt ?? null),
        !neutral && !ok ? checkedAt : (status.lastFailureAt ?? null),
        checkedAt,
      );

    // Only transitions are worth recording; writing every probe would bury the
    // signal under thousands of identical rows.
    const previousState = existing?.state ?? 'unknown';
    if (previousState !== status.state) {
      this.db.$raw
        .prepare(
          `INSERT INTO system_events (id, level, component, message, context, ref_type, ref_id, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          newId('evt', checkedAt),
          status.state === 'down' ? 'error' : status.state === 'degraded' ? 'warn' : 'info',
          'health',
          `${status.label} moved from ${previousState} to ${status.state}`,
          stringify({ from: previousState, to: status.state, detail: status.detail, latencyMs: status.latencyMs ?? null }),
          'provider',
          status.id,
          checkedAt,
        );
      this.log.info({ provider: status.id, from: previousState, to: status.state }, 'provider state changed');
    }

    return {
      state: status.state,
      successCount,
      failureCount,
      consecutiveFailures,
      circuitOpenUntil,
    };
  }

  private toComponent(
    status: ProviderStatus,
    counters: { successCount: number; failureCount: number; consecutiveFailures: number; circuitOpenUntil: number | null },
    checkedAt: number,
    fleet: { rate: number; n: number },
  ): HealthComponent {
    const trials = counters.successCount + counters.failureCount;
    // A rate off a handful of probes is not a measurement. Report the sample
    // size and refuse the number rather than printing a confident-looking one.
    const availability: Availability =
      trials < MIN_AVAILABILITY_SAMPLES
        ? {
            sufficient: false,
            n: trials,
            reason: `Only ${trials} recorded observation${trials === 1 ? '' : 's'}; at least ${MIN_AVAILABILITY_SAMPLES} are needed before an availability rate means anything, so no rate is reported for this provider.`,
          }
        : (() => {
            const interval = wilsonInterval(counters.successCount, trials);
            return {
              sufficient: true as const,
              n: trials,
              observed: interval.point,
              observedLower: interval.lower,
              observedUpper: interval.upper,
              // Shrunk toward the fleet so providers with very different
              // sample sizes can be compared without the least-measured one
              // topping the list.
              point: shrinkToPrior(interval.point, trials, fleet.rate, AVAILABILITY_PRIOR_STRENGTH),
              fleet,
              caveat: AVAILABILITY_CAVEAT,
            };
          })();

    const detail =
      counters.circuitOpenUntil && counters.circuitOpenUntil > checkedAt
        ? `${status.detail} Circuit open until ${new Date(counters.circuitOpenUntil).toISOString()} after ${counters.consecutiveFailures} consecutive failures.`
        : status.state === 'unconfigured'
          ? `${status.detail}${status.setupHint ? ` ${status.setupHint}` : ''}`
          : status.detail;

    return {
      id: status.id,
      label: status.label,
      kind: 'provider',
      state: status.state,
      detail,
      latencyMs: status.latencyMs,
      // No single third-party provider is essential: the platform is designed
      // to degrade to whatever subset is reachable.
      essential: false,
      metrics: {
        providerKind: status.kind,
        successCount: counters.successCount,
        failureCount: counters.failureCount,
        consecutiveFailures: counters.consecutiveFailures,
        circuitOpenUntil: counters.circuitOpenUntil,
        quotaRemaining: status.quotaRemaining ?? null,
        requiresCredentials: status.requiresCredentials,
      },
      availability,
      checkedAt,
    };
  }

  // -------------------------------------------------------------------------
  // Local components
  // -------------------------------------------------------------------------

  private checkDatabase(): HealthComponent {
    const checkedAt = this.now();
    try {
      // Trivial but real: it touches the b-tree rather than only the parser.
      // Sampled rather than timed once, because query latency is right-skewed
      // and a single reading cannot distinguish a slow database from one
      // unlucky pause.
      const probe = this.db.$raw.prepare('SELECT COUNT(*) AS n FROM sqlite_schema');
      const samples: number[] = [];
      for (let i = 0; i < DB_LATENCY_SAMPLES; i++) {
        const started = performance.now();
        probe.get();
        samples.push(performance.now() - started);
      }
      const medianMs = median(samples);
      const worstMs = Math.max(...samples);

      const size = this.db.$raw
        .prepare('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()')
        .get() as { bytes: number } | undefined;
      const bytes = size?.bytes ?? 0;

      // The median decides; the tail is reported alongside so a database that
      // is usually fast but occasionally stalls is still visible.
      const slow = medianMs > DB_LATENCY_WARN_MS;
      const tailHeavy = !slow && worstMs > DB_LATENCY_WARN_MS;
      return {
        id: 'database',
        label: 'Database',
        kind: 'database',
        state: slow ? 'degraded' : 'ok',
        detail: slow
          ? `The median of ${DB_LATENCY_SAMPLES} trivial queries took ${medianMs.toFixed(1)} ms (slowest ${worstMs.toFixed(1)} ms), above the ${DB_LATENCY_WARN_MS} ms threshold. The database file is ${formatBytes(bytes)}; check for a long-running write or a slow disk.`
          : `Median ${medianMs.toFixed(1)} ms over ${DB_LATENCY_SAMPLES} trivial queries, slowest ${worstMs.toFixed(1)} ms. Database file is ${formatBytes(bytes)}.${
              tailHeavy
                ? ` The slowest reading is past the ${DB_LATENCY_WARN_MS} ms threshold even though the median is not, so the database occasionally stalls; ${DB_LATENCY_SAMPLES} samples is too few to say how often.`
                : ''
            }`,
        latencyMs: Math.round(medianMs),
        // Nothing works without the database, including recording that nothing works.
        essential: true,
        metrics: {
          fileBytes: bytes,
          fileMegabytes: Number((bytes / 1_048_576).toFixed(2)),
          latencySamples: DB_LATENCY_SAMPLES,
          latencyMedianMs: Number(medianMs.toFixed(2)),
          latencyMaxMs: Number(worstMs.toFixed(2)),
        },
        checkedAt,
      };
    } catch (e) {
      return {
        id: 'database',
        label: 'Database',
        kind: 'database',
        state: 'down',
        detail: `The database did not answer a trivial query: ${safeErrorText(e, 300)}`,
        essential: true,
        checkedAt,
      };
    }
  }

  /**
   * Scheduler liveness, inferred from job state rather than from the scheduler
   * object, so this reports the truth even if the scheduler loop has died.
   */
  private checkScheduler(): HealthComponent {
    const checkedAt = this.now();
    const rows = this.db.$raw
      .prepare(
        'SELECT job_name, enabled, interval_seconds, next_run_at, last_run_at, last_status, consecutive_failures FROM job_state',
      )
      .all() as Array<{
      job_name: string;
      enabled: number;
      interval_seconds: number;
      next_run_at: number | null;
      last_run_at: number | null;
      last_status: string | null;
      consecutive_failures: number;
    }>;

    const enabled = rows.filter((r) => r.enabled === 1);
    if (enabled.length === 0) {
      return {
        id: 'scheduler',
        label: 'Job scheduler',
        kind: 'scheduler',
        state: 'unknown',
        detail:
          rows.length === 0
            ? 'No jobs are registered. This is expected in a process that does not run the scheduler; otherwise the scheduler has not started.'
            : `All ${rows.length} registered jobs are disabled, so nothing is scheduled to run.`,
        essential: false,
        metrics: { registered: rows.length, enabled: 0 },
        checkedAt,
      };
    }

    const overdue = enabled.filter(
      (r) => r.next_run_at !== null && checkedAt - r.next_run_at > OVERDUE_INTERVAL_MULTIPLE * r.interval_seconds * 1000,
    );
    const failing = enabled.filter((r) => r.consecutive_failures > JOB_FAILURE_TOLERANCE);

    // Every job overdue at once means the loop itself is not running — a single
    // stuck job cannot produce that pattern.
    const stalled = overdue.length === enabled.length;
    const state: HealthState = stalled ? 'down' : overdue.length > 0 || failing.length > 0 ? 'degraded' : 'ok';

    const worstOverdue = overdue.reduce((worst, r) => {
      const lateSeconds = r.next_run_at === null ? 0 : Math.round((checkedAt - r.next_run_at) / 1000);
      return lateSeconds > worst.lateSeconds ? { name: r.job_name, lateSeconds } : worst;
    }, { name: '', lateSeconds: 0 });

    const parts: string[] = [];
    if (stalled) {
      parts.push(
        `All ${enabled.length} enabled jobs are overdue by more than ${OVERDUE_INTERVAL_MULTIPLE} intervals, which means the scheduler loop is not running.`,
      );
    } else if (overdue.length > 0) {
      parts.push(
        `${overdue.length} of ${enabled.length} jobs are overdue by more than ${OVERDUE_INTERVAL_MULTIPLE} intervals; the worst is "${worstOverdue.name}", ${worstOverdue.lateSeconds}s late.`,
      );
    }
    if (failing.length > 0) {
      parts.push(
        `${failing.length} job(s) have failed more than ${JOB_FAILURE_TOLERANCE} times consecutively: ${failing
          .map((r) => `${r.job_name} (${r.consecutive_failures})`)
          .join(', ')}.`,
      );
    }
    if (parts.length === 0) parts.push(`All ${enabled.length} enabled jobs are on schedule.`);

    return {
      id: 'scheduler',
      label: 'Job scheduler',
      kind: 'scheduler',
      state,
      detail: parts.join(' '),
      essential: false,
      metrics: {
        registered: rows.length,
        enabled: enabled.length,
        overdue: overdue.length,
        failing: failing.length,
        worstOverdueSeconds: worstOverdue.lateSeconds,
      },
      checkedAt,
    };
  }

  /**
   * Free space for the directory holding the database.
   *
   * `statfs` is guarded because it is not available on every platform or
   * filesystem this could run on; an unavailable measurement reports `unknown`
   * rather than inventing a number or pretending the disk is fine.
   */
  private async checkDisk(): Promise<HealthComponent> {
    const checkedAt = this.now();
    const directory = this.dataDirectory();

    if (!directory) {
      return {
        id: 'disk',
        label: 'Disk space',
        kind: 'disk',
        state: 'unknown',
        detail: 'The database is not backed by a file (in-memory), so there is no data directory to measure.',
        essential: false,
        checkedAt,
      };
    }

    try {
      const { statfs } = await import('node:fs/promises');
      const stats = await statfs(directory);
      const blockSize = Number(stats.bsize);
      const totalBytes = Number(stats.blocks) * blockSize;
      const freeBytes = Number(stats.bavail) * blockSize;
      const freeRatio = totalBytes > 0 ? freeBytes / totalBytes : 0;

      // SQLite cannot commit a transaction on a full volume, so this escalates
      // to `down` before writes actually start failing.
      const state: HealthState = freeBytes < 100 * 1_048_576 || freeRatio < 0.02 ? 'down' : freeRatio < 0.1 ? 'degraded' : 'ok';

      return {
        id: 'disk',
        label: 'Disk space',
        kind: 'disk',
        state,
        detail: `${formatBytes(freeBytes)} free of ${formatBytes(totalBytes)} (${(freeRatio * 100).toFixed(1)}%) on the volume holding ${directory}.${
          state === 'ok' ? '' : ' SQLite cannot commit writes on a full volume; free space before it reaches zero.'
        }`,
        essential: true,
        metrics: {
          directory,
          freeBytes,
          totalBytes,
          freePercent: Number((freeRatio * 100).toFixed(2)),
        },
        checkedAt,
      };
    } catch (e) {
      return {
        id: 'disk',
        label: 'Disk space',
        kind: 'disk',
        state: 'unknown',
        detail: `Free space could not be measured for ${directory}: ${safeErrorText(e, 200)}. node:fs statfs is unavailable on some platforms and filesystems; this is not itself a fault.`,
        essential: false,
        metrics: { directory },
        checkedAt,
      };
    }
  }

  /**
   * Wallet configuration.
   *
   * Reports on *configuration*, not on the chain: a missing operating wallet is
   * `unconfigured` (entirely normal in the research and simulation phases), and
   * only a wallet that exists but cannot fund work is a degradation.
   */
  private checkWallet(): HealthComponent {
    const checkedAt = this.now();
    const config = this.settings.get();
    const network = config.execution.network;
    const floorLamports = Math.round(config.limits.walletBalanceFloorSol * 1_000_000_000);

    const account = this.db.$raw
      .prepare(
        `SELECT address, has_signing_key, custody, balance_lamports, balance_checked_at
           FROM wallet_accounts WHERE role = 'operating' AND network = ? AND active = 1
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(network) as
      | {
          address: string;
          has_signing_key: number;
          custody: string;
          balance_lamports: number;
          balance_checked_at: number | null;
        }
      | undefined;

    if (!account) {
      return {
        id: 'wallet',
        label: 'Operating wallet',
        kind: 'wallet',
        state: 'unconfigured',
        detail: `No active operating wallet is registered for the ${network} network. Research, concept generation and scoring all run without one; only launches, fee claims and transfers need it.`,
        essential: false,
        metrics: { network },
        checkedAt,
      };
    }

    const issues: string[] = [];
    if (account.has_signing_key !== 1) {
      issues.push(
        `The wallet is registered as ${account.custody} and this process cannot sign for it, so no transaction can be submitted.`,
      );
    }
    if (account.balance_lamports < floorLamports) {
      issues.push(
        `Balance ${lamportsToSol(account.balance_lamports).toFixed(4)} SOL is below the ${config.limits.walletBalanceFloorSol} SOL floor, so all spending is blocked.`,
      );
    }
    if (config.wallet.autoSweepEnabled && !config.wallet.treasuryAddress) {
      issues.push('Automatic sweeps are enabled but no treasury address is set, so revenue has nowhere to go.');
    }
    // A balance last read hours ago is a stale basis for spending decisions.
    const balanceAgeMs = account.balance_checked_at === null ? null : checkedAt - account.balance_checked_at;
    if (balanceAgeMs !== null && balanceAgeMs > 6 * TIME.hour) {
      issues.push(`The cached balance was last refreshed ${Math.round(balanceAgeMs / TIME.hour)}h ago and may be stale.`);
    }

    return {
      id: 'wallet',
      label: 'Operating wallet',
      kind: 'wallet',
      state: issues.length > 0 ? 'degraded' : 'ok',
      detail:
        issues.length > 0
          ? issues.join(' ')
          : `Wallet ${account.address} on ${network} holds ${lamportsToSol(account.balance_lamports).toFixed(4)} SOL, above its ${config.limits.walletBalanceFloorSol} SOL floor, and this process can sign for it.`,
      essential: false,
      metrics: {
        network,
        address: account.address,
        balanceSol: Number(lamportsToSol(account.balance_lamports).toFixed(6)),
        floorSol: config.limits.walletBalanceFloorSol,
        canSign: account.has_signing_key === 1,
        balanceAgeSeconds: balanceAgeMs === null ? null : Math.round(balanceAgeMs / 1000),
      },
      checkedAt,
    };
  }

  /**
   * Wall-clock jump detection.
   *
   * Solana blockhashes expire on a wall-clock horizon and the scheduler fires
   * on wall-clock deadlines, so a clock that jumps produces transactions that
   * are rejected as expired and jobs that either stampede or stall.
   */
  private checkClock(): HealthComponent {
    const checkedAt = this.now();
    const monotonicElapsed = performance.now() - this.startedMonotonicMs;
    const wallElapsed = checkedAt - this.startedWallMs;
    const driftMs = wallElapsed - monotonicElapsed;

    const maxDriftMs = this.settings.get().limits.maxClockDriftSeconds * 1000;
    const absolute = Math.abs(driftMs);
    const state: HealthState = absolute > maxDriftMs ? 'down' : absolute > maxDriftMs * 0.25 ? 'degraded' : 'ok';

    return {
      id: 'clock',
      label: 'System clock',
      kind: 'clock',
      state,
      detail:
        state === 'ok'
          ? `The wall clock has stayed within ${(absolute / 1000).toFixed(2)}s of the monotonic reference taken at startup. This detects clock jumps, not absolute offset from true UTC — that would require an external time source.`
          : `The wall clock has diverged ${(driftMs / 1000).toFixed(2)}s from the monotonic reference taken at startup (limit ${this.settings.get().limits.maxClockDriftSeconds}s), which means it was stepped or the host was suspended. Transaction blockhashes expire on wall-clock time and job scheduling depends on it; re-sync via NTP and restart.`,
      // A stepped clock invalidates transaction expiry and scheduling.
      essential: true,
      metrics: {
        driftMs: Math.round(driftMs),
        uptimeSeconds: Math.round(monotonicElapsed / 1000),
        maxDriftSeconds: this.settings.get().limits.maxClockDriftSeconds,
      },
      checkedAt,
    };
  }

  /** Directory of the SQLite file, read from the connection itself. */
  private dataDirectory(): string | null {
    try {
      const rows = this.db.$raw.pragma('database_list') as Array<{ name: string; file: string }>;
      const main = rows.find((r) => r.name === 'main');
      return main?.file ? dirname(main.file) : null;
    } catch {
      return null;
    }
  }
}

/**
 * Roll components up into one verdict.
 *
 * `unconfigured` is skipped entirely: a provider the operator has chosen not to
 * set up is in a normal, intended state and must never colour the system
 * indicator. Only an *essential* component being down makes the system down.
 */
function overallState(components: HealthComponent[]): SystemHealth['overall'] {
  if (components.some((c) => c.essential && c.state === 'down')) return 'down';
  const degraded = components.some(
    (c) => c.state === 'degraded' || c.state === 'down' || (c.essential && c.state === 'unknown'),
  );
  return degraded ? 'degraded' : 'ok';
}

function summarise(components: HealthComponent[]): string {
  const providers = components.filter((c) => c.kind === 'provider');
  const providerOk = providers.filter((c) => c.state === 'ok').length;
  const providerUnconfigured = providers.filter((c) => c.state === 'unconfigured').length;
  const providerBad = providers.filter((c) => c.state === 'down' || c.state === 'degraded');

  const parts: string[] = [];
  if (providers.length > 0) {
    parts.push(
      `${providerOk}/${providers.length} providers healthy` +
        (providerUnconfigured > 0 ? `, ${providerUnconfigured} unconfigured (normal)` : '') +
        (providerBad.length > 0 ? `, failing: ${providerBad.map((c) => c.label).join(', ')}` : ''),
    );
  } else {
    parts.push('no providers registered');
  }

  for (const id of ['database', 'scheduler', 'disk', 'wallet', 'clock']) {
    const component = components.find((c) => c.id === id);
    if (!component) continue;
    // Local components are only worth a mention when they are not fine; the
    // database latency is the exception because it is the number most often wanted.
    if (component.id === 'database' && component.state === 'ok') {
      parts.push(`database median ${component.latencyMs ?? 0} ms over ${DB_LATENCY_SAMPLES} probes`);
    } else if (component.state !== 'ok' && component.state !== 'unconfigured') {
      parts.push(`${component.label.toLowerCase()} ${component.state}`);
    }
  }

  return `${parts.join('; ')}.`;
}

/**
 * Bound a probe.
 *
 * The underlying promise is abandoned rather than cancelled — `healthCheck`
 * takes no abort signal — so the result is ignored if it eventually arrives.
 * That is acceptable for a probe and is the price of never stalling the check.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} health probe exceeded ${timeoutMs}ms`)), timeoutMs);
        // Do not hold the event loop open for a probe timer.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
