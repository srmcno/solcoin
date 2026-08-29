import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge,
  Card,
  CopyButton,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingRows,
  Modal,
  Note,
  SampleSize,
  ScoreBar,
  SectionHeader,
  Skeleton,
  StatTile,
  Tabs,
  Td,
  Th,
  type Tone,
} from '@/components/ui';
import { formatDateTime, formatNumber, formatPercent, formatRelative, humanise } from '@/lib/format';
import { POLL, queryKeys, useApiMutation, useApiQuery } from '@/lib/queries';
import { useSession } from '@/lib/session';

/**
 * Availability below this many observations is reported by the server as
 * insufficient; the same floor is used here so the sample-size marker warns at
 * the point the backend stops publishing a rate.
 */
const MIN_AVAILABILITY_SAMPLES = 20;

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const LOG_LIMIT = 200;
const AUDIT_LIMIT = 100;

type TabId = 'components' | 'jobs' | 'audit' | 'logs' | 'diagnostics';

interface Availability {
  sufficient?: boolean | null;
  n?: number | null;
  reason?: string | null;
  observed?: number | null;
  observedLower?: number | null;
  observedUpper?: number | null;
  point?: number | null;
  fleet?: { rate?: number | null; n?: number | null } | null;
  caveat?: string | null;
}

interface HealthComponent {
  id?: string | null;
  label?: string | null;
  kind?: string | null;
  state?: string | null;
  detail?: string | null;
  latencyMs?: number | null;
  essential?: boolean | null;
  requiresCredentials?: boolean | null;
  setupHint?: string | null;
  quotaRemaining?: number | null;
  metrics?: Record<string, unknown> | null;
  availability?: Availability | null;
  checkedAt?: number | null;
}

interface JobRow {
  name?: string | null;
  description?: string | null;
  enabled?: boolean | null;
  intervalSeconds?: number | null;
  lastRunAt?: number | null;
  nextRunAt?: number | null;
  lastStatus?: string | null;
  consecutiveFailures?: number | null;
  running?: boolean | null;
  overdueSeconds?: number | null;
  hasSideEffects?: boolean | null;
}

interface SystemStatusResponse {
  health?: {
    overall?: string | null;
    checkedAt?: number | null;
    components?: HealthComponent[] | null;
    summary?: string | null;
  } | null;
  usage?: Record<string, unknown> | null;
  wallet?: Record<string, unknown> | null;
  jobs?: JobRow[] | null;
  emergencyStop?: boolean | null;
  emergencyStopReason?: string | null;
  network?: string | null;
  phase?: string | null;
}

/** Drizzle returns camelCase for audit rows. */
interface AuditEntry {
  id?: string | null;
  sequence?: number | null;
  actorType?: string | null;
  actorId?: string | null;
  actorLabel?: string | null;
  action?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  parameters?: string | null;
  result?: string | null;
  resultDetail?: string | null;
  reason?: string | null;
  ipAddress?: string | null;
  transactionSignature?: string | null;
  hash?: string | null;
  createdAt?: number | null;
}

interface AuditVerification {
  valid?: boolean | null;
  checked?: number | null;
  brokenAtSequence?: number | null;
  detail?: string | null;
}

/** The log endpoint runs raw SQL, so these rows arrive snake_case. */
interface LogRow {
  id?: string | null;
  level?: string | null;
  component?: string | null;
  message?: string | null;
  context?: string | null;
  ref_type?: string | null;
  ref_id?: string | null;
  created_at?: number | null;
}

interface DiagnosticsResponse {
  checkedAt?: number | null;
  environment?: Record<string, unknown> | null;
  secretStore?: Record<string, unknown> | null;
  wallet?: Record<string, unknown> | null;
  execution?: Record<string, unknown> | null;
  providers?: Record<string, unknown> | null;
  model?: Record<string, unknown> | null;
  economics?: Record<string, unknown> | null;
  auditChain?: AuditVerification | null;
}

function maybeNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function num(value: unknown): number {
  return maybeNum(value) ?? 0;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

/**
 * Health state → tone.
 *
 * `unconfigured` is deliberately neutral. A fresh install has no credentials
 * for most integrations, and painting that red teaches the operator to ignore
 * the health indicator entirely — which is the only failure mode that matters.
 */
const STATE_TONE: Record<string, Tone> = {
  ok: 'positive',
  degraded: 'warning',
  down: 'negative',
  unconfigured: 'neutral',
  unknown: 'neutral',
};

const STATE_LABEL: Record<string, string> = {
  ok: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
  unconfigured: 'Not set up',
  unknown: 'Unknown',
};

/** Colour is never the only signal: every state also carries a glyph. */
const STATE_GLYPH: Record<string, string> = {
  ok: '●',
  degraded: '▲',
  down: '■',
  unconfigured: '○',
  unknown: '?',
};

const JOB_STATUS_TONE: Record<string, Tone> = {
  succeeded: 'positive',
  running: 'info',
  queued: 'neutral',
  skipped: 'neutral',
  failed: 'negative',
  cancelled: 'warning',
};

const LOG_LEVEL_TONE: Record<string, Tone> = {
  debug: 'neutral',
  info: 'info',
  warn: 'warning',
  error: 'negative',
};

function formatInterval(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172_800) return `${(seconds / 3600).toFixed(seconds % 3600 === 0 ? 0 : 1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

function componentMetric(component: HealthComponent, key: string): unknown {
  const direct = (component as Record<string, unknown>)[key];
  if (direct !== undefined && direct !== null) return direct;
  return component.metrics?.[key];
}

export function HealthPage() {
  const { can } = useSession();
  const [tab, setTab] = useState<TabId>('components');

  const status = useApiQuery<SystemStatusResponse>(queryKeys.systemStatus, '/api/system/status', {
    refetchInterval: POLL.fast,
  });

  const health = status.data?.health;
  const components = useMemo(() => health?.components ?? [], [health]);
  const jobs = useMemo(() => status.data?.jobs ?? [], [status.data]);

  const overall = str(health?.overall) || 'unknown';
  const counts = useMemo(() => {
    let ok = 0;
    let attention = 0;
    let unconfigured = 0;
    for (const component of components) {
      const state = str(component.state);
      if (state === 'ok') ok += 1;
      else if (state === 'degraded' || state === 'down') attention += 1;
      else if (state === 'unconfigured') unconfigured += 1;
    }
    return { ok, attention, unconfigured, total: components.length };
  }, [components]);

  const overdueJobs = jobs.filter((job) => num(job.overdueSeconds) > 0).length;
  const failingJobs = jobs.filter((job) => num(job.consecutiveFailures) > 0).length;

  if (status.isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-24 w-full" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <LoadingRows rows={6} />
      </div>
    );
  }

  if (status.isError) {
    return (
      <Card>
        <ErrorState error={status.error} onRetry={() => void status.refetch()} />
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <SectionHeader
        title="System health"
        description="What the platform can currently do, what is stopping it, and a tamper-evident record of everything it has done."
        action={
          <button className="btn btn-ghost" onClick={() => void status.refetch()} disabled={status.isFetching}>
            {status.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />

      <OverallBanner
        overall={overall}
        summary={str(health?.summary)}
        checkedAt={maybeNum(health?.checkedAt)}
        emergencyStop={status.data?.emergencyStop === true}
        emergencyStopReason={str(status.data?.emergencyStopReason)}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Overall"
          value={STATE_LABEL[overall] ?? humanise(overall)}
          tone={STATE_TONE[overall] ?? 'neutral'}
          hint={`Checked ${formatRelative(maybeNum(health?.checkedAt))}`}
        />
        <StatTile
          label="Components healthy"
          value={counts.total === 0 ? '—' : `${counts.ok}/${counts.total}`}
          tone={counts.attention > 0 ? 'warning' : 'neutral'}
          hint={
            counts.unconfigured > 0
              ? `Of the ${counts.total} registered, ${counts.unconfigured} are not set up yet — normal on a new install, and not counted as faults`
              : 'Every registered component reported in'
          }
        />
        <StatTile
          label="Jobs overdue"
          value={formatNumber(overdueJobs)}
          tone={overdueJobs > 0 ? 'warning' : 'neutral'}
          hint={`${jobs.filter((j) => j.enabled === true).length} of ${jobs.length} jobs enabled`}
        />
        <StatTile
          label="Jobs failing"
          value={formatNumber(failingJobs)}
          tone={failingJobs > 0 ? 'negative' : 'neutral'}
          hint="Jobs with at least one consecutive failure"
        />
      </div>

      <Tabs
        tabs={[
          { id: 'components', label: 'Components', count: counts.total },
          { id: 'jobs', label: 'Jobs', count: jobs.length },
          { id: 'audit', label: 'Audit log' },
          { id: 'logs', label: 'System log' },
          { id: 'diagnostics', label: 'Diagnostics' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'components' && <ComponentsPanel components={components} />}
      {tab === 'jobs' && <JobsPanel jobs={jobs} canRun={can('run_research')} canEdit={can('edit_limits')} />}
      {tab === 'audit' && <AuditPanel canView={can('view_audit')} />}
      {tab === 'logs' && <LogsPanel />}
      {tab === 'diagnostics' && <DiagnosticsPanel />}
    </div>
  );
}

function OverallBanner({
  overall,
  summary,
  checkedAt,
  emergencyStop,
  emergencyStopReason,
}: {
  overall: string;
  summary: string;
  checkedAt: number | null;
  emergencyStop: boolean;
  emergencyStopReason: string;
}) {
  const tone = STATE_TONE[overall] ?? 'neutral';
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={tone}>
              <span aria-hidden="true">{STATE_GLYPH[overall] ?? '?'}</span>
              {STATE_LABEL[overall] ?? humanise(overall)}
            </Badge>
            <span className="text-xs text-ink-subtle">Checked {formatRelative(checkedAt)}</span>
          </div>
          <p className="max-w-3xl text-sm leading-relaxed text-ink-muted">
            {summary || 'No summary was reported for this check.'}
          </p>
        </div>
      </div>
      {emergencyStop && (
        <div className="mt-3">
          <Note tone="negative">
            <strong className="font-semibold">Emergency stop is engaged.</strong> No job with side effects will run until
            it is released from Settings → Danger zone.{' '}
            {emergencyStopReason ? `Reason on record: “${emergencyStopReason}”.` : 'No reason was recorded.'}
          </Note>
        </div>
      )}
    </Card>
  );
}

function ComponentsPanel({ components }: { components: HealthComponent[] }) {
  const providers = components.filter((c) => str(c.kind) === 'provider');
  const platform = components.filter((c) => str(c.kind) !== 'provider');
  const unconfigured = providers.filter((c) => str(c.state) === 'unconfigured');

  if (components.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No components have reported yet"
          description="The health service registers a component the first time it is probed. Give the platform a moment after start-up, then refresh. If this stays empty, check that the server process is running."
          icon="◉"
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {unconfigured.length > 0 && (
        <Note tone="info">
          {unconfigured.length} integration{unconfigured.length === 1 ? ' is' : 's are'} not set up. That is a normal
          state, not a fault — the platform runs on whatever subset of providers has credentials, and an unconfigured
          provider never counts against overall health. Add credentials under{' '}
          <Link className="underline underline-offset-2" to="/settings">
            Settings → Providers &amp; secrets
          </Link>
          .
        </Note>
      )}

      <Card>
        <SectionHeader
          title="Platform"
          description="Local components. Only an essential one being down can take the whole system down."
        />
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {platform.length === 0 ? (
            <p className="text-sm text-ink-muted">No local components reported.</p>
          ) : (
            platform.map((component) => <ComponentCard key={str(component.id)} component={component} />)
          )}
        </div>
      </Card>

      <Card>
        <SectionHeader
          title="Providers"
          description="External integrations. Each is optional; the platform degrades to the subset that is reachable."
        />
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {providers.length === 0 ? (
            <p className="text-sm text-ink-muted">
              No external providers are registered yet. Add a credential in Settings to bring one online.
            </p>
          ) : (
            providers.map((component) => <ComponentCard key={str(component.id)} component={component} />)
          )}
        </div>
      </Card>
    </div>
  );
}

function ComponentCard({ component }: { component: HealthComponent }) {
  const state = str(component.state) || 'unknown';
  const tone = STATE_TONE[state] ?? 'neutral';
  const latency = maybeNum(component.latencyMs);
  const quota = maybeNum(componentMetric(component, 'quotaRemaining'));
  const providerKind = str(componentMetric(component, 'providerKind'));
  const setupHint = str(component.setupHint);
  const availability = component.availability ?? null;
  // The health service folds a provider's setup hint into `detail` for the
  // unconfigured state, so `setupHint` usually arrives empty. Rather than
  // inventing a sentence to fill the gap, the block below says only what the
  // server actually reported — and `requiresCredentials` decides where the
  // operator is sent, because a source that needs no key is idle for a
  // configuration reason, not a missing credential.
  const requires = componentMetric(component, 'requiresCredentials');
  const needsCredential = requires === true ? true : requires === false ? false : null;

  return (
    <div className="rounded-xl border border-border bg-surface-raised p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-ink">{str(component.label) || humanise(str(component.id))}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-subtle">
            <span>{providerKind ? humanise(providerKind) : humanise(str(component.kind))}</span>
            {component.essential === true && <span>· Essential</span>}
          </div>
        </div>
        <Badge tone={tone}>
          <span aria-hidden="true">{STATE_GLYPH[state] ?? '?'}</span>
          {STATE_LABEL[state] ?? humanise(state)}
        </Badge>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-ink-muted">{str(component.detail) || 'No detail reported.'}</p>

      {state === 'unconfigured' && (
        <div className="mt-2.5 rounded-lg border border-border bg-surface px-2.5 py-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">To enable this</div>
          {setupHint ? (
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">{setupHint}</p>
          ) : needsCredential === false ? (
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              This one needs no credential. It is idle because of how it is configured, not because a key is missing.
            </p>
          ) : null}
          <Link className="mt-1.5 inline-block text-xs text-accent-soft underline underline-offset-2" to="/settings">
            {needsCredential === false ? 'Open Settings →' : 'Open Providers & secrets →'}
          </Link>
        </div>
      )}

      {(latency !== null || quota !== null) && (
        <div className="tnum mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-subtle">
          {latency !== null && <span>Latency {formatNumber(latency)} ms</span>}
          {quota !== null && (
            <span className={quota <= 0 ? 'text-negative' : quota < 100 ? 'text-warning' : undefined}>
              Quota remaining {formatNumber(quota)}
              {quota <= 0 && ' — exhausted'}
            </span>
          )}
        </div>
      )}

      {availability && <AvailabilityBlock availability={availability} />}
    </div>
  );
}

/**
 * Availability is only ever shown with the evidence behind it. The server
 * refuses to publish a rate under twenty observations, and when it does publish
 * one the number is shrunk toward the fleet rate — both facts are surfaced here
 * rather than hidden, because a bare "100% uptime" off three probes is worse
 * than no figure at all.
 */
function AvailabilityBlock({ availability }: { availability: Availability }) {
  const n = maybeNum(availability.n) ?? 0;

  if (availability.sufficient !== true) {
    return (
      <div className="mt-3 border-t border-border pt-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">Availability</span>
          <SampleSize n={n} minimum={MIN_AVAILABILITY_SAMPLES} />
        </div>
        <p className="mt-1 text-xs leading-relaxed text-warning">
          {str(availability.reason) ||
            `Not enough observations to publish a rate (${n} of ${MIN_AVAILABILITY_SAMPLES} needed).`}
        </p>
      </div>
    );
  }

  const point = maybeNum(availability.point);
  const observed = maybeNum(availability.observed);
  const lower = maybeNum(availability.observedLower);
  const upper = maybeNum(availability.observedUpper);
  const fleetRate = maybeNum(availability.fleet?.rate);
  const fleetN = maybeNum(availability.fleet?.n);

  return (
    <div className="mt-3 border-t border-border pt-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">Availability</span>
        <SampleSize n={n} minimum={MIN_AVAILABILITY_SAMPLES} />
      </div>
      <div className="tnum mt-1 flex items-baseline gap-2">
        <span className="text-lg font-semibold text-ink">{formatPercent(point, 1)}</span>
        <span className="text-[11px] text-ink-subtle">shrunk estimate</span>
      </div>
      {point !== null && <ScoreBar value={point} className="mt-1.5" tone="info" />}
      <dl className="tnum mt-2 space-y-0.5 text-[11px] text-ink-subtle">
        {observed !== null && (
          <div className="flex justify-between gap-3">
            <dt>Observed (raw)</dt>
            <dd>
              {formatPercent(observed, 1)}
              {lower !== null && upper !== null && ` · 95% CI ${formatPercent(lower, 1)}–${formatPercent(upper, 1)}`}
            </dd>
          </div>
        )}
        {fleetRate !== null && (
          <div className="flex justify-between gap-3">
            <dt>Fleet rate</dt>
            <dd>
              {formatPercent(fleetRate, 1)}
              {fleetN !== null && ` (n=${formatNumber(fleetN)})`}
            </dd>
          </div>
        )}
      </dl>
      {observed !== null && lower !== null && upper !== null && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-subtle">
          The interval bounds the raw rate, not the shrunk estimate above it. On a thin sample the estimate sits outside
          the interval — that is the shrinkage working, not an inconsistency.
        </p>
      )}
      {str(availability.caveat) && (
        <p className="mt-2 text-[11px] leading-relaxed text-warning">{str(availability.caveat)}</p>
      )}
    </div>
  );
}

function JobsPanel({ jobs, canRun, canEdit }: { jobs: JobRow[]; canRun: boolean; canEdit: boolean }) {
  const [editing, setEditing] = useState<JobRow | null>(null);
  const [feedback, setFeedback] = useState<{ tone: Tone; text: string } | null>(null);

  const runJob = useApiMutation<{ ok?: boolean }, { name: string }>((v) => `/api/jobs/${encodeURIComponent(v.name)}/run`, {
    method: 'POST',
    invalidate: [queryKeys.systemStatus, queryKeys.jobs],
    onSuccess: (_result, variables) => setFeedback({ tone: 'positive', text: `Started ${variables.name}.` }),
  });

  const patchJob = useApiMutation<{ ok?: boolean }, { name: string; enabled?: boolean; intervalSeconds?: number }>(
    (v) => `/api/jobs/${encodeURIComponent(v.name)}`,
    {
      method: 'PATCH',
      invalidate: [queryKeys.systemStatus, queryKeys.jobs],
      onSuccess: (_result, variables) => {
        setEditing(null);
        setFeedback({ tone: 'positive', text: `Updated ${variables.name}.` });
      },
    },
  );

  if (jobs.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No scheduled jobs are registered"
          description="Jobs are registered by the server on start-up. An empty list usually means the scheduler has not started — check the system log for scheduler errors."
          icon="◷"
        />
      </Card>
    );
  }

  const error = runJob.error ?? patchJob.error;

  return (
    <Card padded={false}>
      <div className="p-4 sm:p-5">
        <SectionHeader
          title="Scheduled jobs"
          description="Everything the platform does on a timer. Jobs marked as having side effects can spend SOL or write on-chain, and are suspended entirely while the emergency stop is engaged."
        />
        {feedback && (
          <div className="mt-3">
            <Note tone={feedback.tone}>{feedback.text}</Note>
          </div>
        )}
        {error && (
          <div className="mt-3">
            <Note tone="negative">{error.message}</Note>
          </div>
        )}
        {!canRun && !canEdit && (
          <div className="mt-3">
            <Note tone="neutral">
              Your role can view the schedule but not change it. Running a job needs the “run research” permission;
              enabling, disabling or re-timing one needs “edit limits”.
            </Note>
          </div>
        )}
      </div>

      <div className="px-4 pb-4 sm:px-5">
        <DataTable>
        <thead>
          <tr>
            <Th>Job</Th>
            <Th>Schedule</Th>
            <Th>Last run</Th>
            <Th>Next run</Th>
            <Th>Last status</Th>
            <Th align="right">Failures</Th>
            <Th>Side effects</Th>
            <Th align="right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const name = str(job.name);
            const overdue = num(job.overdueSeconds);
            const failures = num(job.consecutiveFailures);
            const lastStatus = str(job.lastStatus);
            const running = job.running === true;
            const enabled = job.enabled === true;

            return (
              <tr key={name} className="transition-colors hover:bg-surface-hover/40">
                <Td>
                  <div className="max-w-xs">
                    <div className="flex items-center gap-2 font-medium text-ink">
                      <span className="truncate">{humanise(name)}</span>
                      {!enabled && <Badge tone="neutral">Disabled</Badge>}
                      {running && <Badge tone="info">Running</Badge>}
                    </div>
                    <div className="mt-0.5 text-xs leading-relaxed text-ink-subtle">{str(job.description) || '—'}</div>
                  </div>
                </Td>
                <Td className="tnum whitespace-nowrap">every {formatInterval(maybeNum(job.intervalSeconds))}</Td>
                <Td className="whitespace-nowrap">
                  <span title={formatDateTime(maybeNum(job.lastRunAt))}>{formatRelative(maybeNum(job.lastRunAt))}</span>
                </Td>
                <Td className="whitespace-nowrap">
                  {!enabled ? (
                    <span className="text-ink-subtle">Not scheduled</span>
                  ) : overdue > 0 ? (
                    <span className="tnum font-medium text-warning">
                      <span aria-hidden="true">▲ </span>overdue by {formatInterval(overdue)}
                    </span>
                  ) : (
                    <span title={formatDateTime(maybeNum(job.nextRunAt))}>{formatRelative(maybeNum(job.nextRunAt))}</span>
                  )}
                </Td>
                <Td>
                  {lastStatus ? (
                    <Badge tone={JOB_STATUS_TONE[lastStatus] ?? 'neutral'}>{humanise(lastStatus)}</Badge>
                  ) : (
                    <span className="text-ink-subtle">Never run</span>
                  )}
                </Td>
                <Td align="right" className={failures > 0 ? 'tnum font-medium text-negative' : 'tnum'}>
                  {formatNumber(failures)}
                </Td>
                <Td>
                  {job.hasSideEffects === true ? (
                    <Badge tone="warning">
                      <span aria-hidden="true">▲</span>Yes
                    </Badge>
                  ) : (
                    <span className="text-ink-subtle">No</span>
                  )}
                </Td>
                <Td align="right">
                  <div className="flex justify-end gap-1.5">
                    {canRun && (
                      <button
                        className="btn btn-ghost px-2 py-1 text-xs"
                        disabled={running || runJob.isPending}
                        onClick={() => runJob.mutate({ name })}
                      >
                        {running ? 'Running…' : 'Run now'}
                      </button>
                    )}
                    {canEdit && (
                      <>
                        <button
                          className="btn btn-ghost px-2 py-1 text-xs"
                          aria-pressed={enabled}
                          disabled={patchJob.isPending}
                          onClick={() => patchJob.mutate({ name, enabled: !enabled })}
                        >
                          {enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button className="btn btn-ghost px-2 py-1 text-xs" onClick={() => setEditing(job)}>
                          Schedule
                        </button>
                      </>
                    )}
                  </div>
                </Td>
              </tr>
            );
          })}
        </tbody>
        </DataTable>
      </div>

      <JobScheduleModal
        key={str(editing?.name) || 'no-job'}
        job={editing}
        onClose={() => setEditing(null)}
        pending={patchJob.isPending}
        onSave={(intervalSeconds) => {
          if (editing) patchJob.mutate({ name: str(editing.name), intervalSeconds });
        }}
      />
    </Card>
  );
}

function JobScheduleModal({
  job,
  onClose,
  onSave,
  pending,
}: {
  job: JobRow | null;
  onClose: () => void;
  onSave: (intervalSeconds: number) => void;
  pending: boolean;
}) {
  const [value, setValue] = useState('');
  const current = maybeNum(job?.intervalSeconds);
  const parsed = Number(value === '' ? (current ?? 0) : value);
  const valid = Number.isFinite(parsed) && parsed >= 15 && parsed <= 86_400;

  return (
    <Modal
      open={job !== null}
      onClose={onClose}
      title={job ? `Schedule for ${humanise(str(job.name))}` : 'Schedule'}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!valid || pending} onClick={() => onSave(Math.round(parsed))}>
            {pending ? 'Saving…' : 'Save schedule'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label" htmlFor="job-interval">
            Interval (seconds)
          </label>
          <input
            id="job-interval"
            className="input tnum"
            type="number"
            min={15}
            max={86_400}
            step={15}
            value={value === '' ? (current ?? '') : value}
            onChange={(e) => setValue(e.target.value)}
          />
          <p className="mt-1.5 text-xs leading-relaxed text-ink-subtle">
            Between 15 seconds and 24 hours. Currently every {formatInterval(current)}; a shorter interval means more
            requests against provider quotas, a longer one means the platform reacts more slowly.
          </p>
        </div>
        {!valid && <Note tone="warning">Enter a whole number of seconds between 15 and 86,400.</Note>}
      </div>
    </Modal>
  );
}

function AuditPanel({ canView }: { canView: boolean }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const filters = useMemo(() => ({ limit: AUDIT_LIMIT }), []);

  const query = useApiQuery<{ entries?: AuditEntry[]; total?: number }>(
    queryKeys.audit(filters),
    `/api/system/audit?limit=${AUDIT_LIMIT}`,
    { enabled: canView, refetchInterval: POLL.normal },
  );

  // A GET, so it is a lazy query rather than a mutation: the button simply
  // refetches it on demand rather than running the walk on every page load.
  const verify = useApiQuery<AuditVerification>(['system', 'audit', 'verify'], '/api/system/audit/verify', {
    enabled: false,
    gcTime: 0,
    retry: false,
  });

  if (!canView) {
    return (
      <Card>
        <EmptyState
          title="You do not have access to the audit log"
          description="Reading the audit log needs the “view audit” permission. An owner or admin can grant it to your account."
          icon="◫"
        />
      </Card>
    );
  }

  const entries = query.data?.entries ?? [];
  const verification = verify.data;
  // The server walks the chain under a row limit, so a clean walk is not by
  // itself proof that the whole log is intact. Comparing what was checked
  // against the recorded total is what makes the claim below honest.
  const total = maybeNum(query.data?.total);
  const checked = maybeNum(verification?.checked);
  const uncheckedRemainder = total !== null && checked !== null && total > checked ? total - checked : null;

  return (
    <div className="space-y-4">
      <Card>
        <SectionHeader
          title="Audit chain"
          description="Every audit entry stores a hash of itself and of the entry before it, so modifying or deleting any row breaks the chain and can be detected. Verifying walks the chain and reports the first break."
          action={
            <button className="btn btn-ghost" onClick={() => void verify.refetch()} disabled={verify.isFetching}>
              {verify.isFetching ? 'Verifying…' : 'Verify chain'}
            </button>
          }
        />
        <div className="mt-3">
          {verify.isError ? (
            <Note tone="negative">Verification could not run: {verify.error.message}</Note>
          ) : !verification ? (
            <Note tone="neutral">
              Not verified in this session. Verification reads every entry and recomputes its hash, so it is run on
              demand rather than on every page load.
            </Note>
          ) : verification.valid === true ? (
            <Note tone="positive">
              <strong className="font-semibold">Chain intact.</strong> {formatNumber(checked)} entries were re-hashed and
              every one matched the record that follows it.{' '}
              {uncheckedRemainder !== null
                ? `The walk stops at a row limit, so ${formatNumber(uncheckedRemainder)} of the ${formatNumber(total)} recorded entries were not covered by this check — treat the result as "no tampering found in the part that was walked", not as a clean bill for the whole log.`
                : total !== null
                  ? `That is every one of the ${formatNumber(total)} entries on record: nothing has been altered or removed.`
                  : 'Nothing in the walked range has been altered or removed.'}
            </Note>
          ) : (
            <Note tone="negative">
              <strong className="font-semibold">Chain broken at sequence {formatNumber(maybeNum(verification.brokenAtSequence))}.</strong>{' '}
              {str(verification.detail) || 'The recomputed hash did not match the stored one.'} The first{' '}
              {formatNumber(checked)} entries verified cleanly; everything from the break onward should be treated as
              untrustworthy.
            </Note>
          )}
        </div>
      </Card>

      <Card padded={false}>
        <div className="p-4 sm:p-5">
          <SectionHeader
            title="Recent activity"
            description={
              query.data?.total !== undefined
                ? `Showing the ${Math.min(entries.length, AUDIT_LIMIT)} most recent of ${formatNumber(maybeNum(query.data.total))} entries.`
                : 'Who did what, when, and why.'
            }
          />
        </div>

        {query.isLoading ? (
          <div className="px-4 pb-4 sm:px-5">
            <LoadingRows rows={6} />
          </div>
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : entries.length === 0 ? (
          <EmptyState
            title="Nothing has been recorded yet"
            description="The audit log fills as the platform and its operators act: signing in, changing a setting, approving a candidate, launching a token. On a fresh install it is empty until the first of those happens."
            icon="◫"
          />
        ) : (
          <div className="px-4 pb-4 sm:px-5">
            <DataTable>
            <thead>
              <tr>
                <Th align="right">Seq</Th>
                <Th>Time</Th>
                <Th>Actor</Th>
                <Th>Action</Th>
                <Th>Target</Th>
                <Th>Result</Th>
                <Th>Reason</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => {
                const key = str(entry.id) || `${str(entry.sequence)}-${index}`;
                const result = str(entry.result) || 'ok';
                const open = expanded === key;
                return (
                  <tr
                    key={key}
                    className="cursor-pointer transition-colors hover:bg-surface-hover/40"
                    onClick={() => setExpanded(open ? null : key)}
                  >
                    <Td align="right" className="tnum whitespace-nowrap text-ink-subtle">
                      {formatNumber(maybeNum(entry.sequence))}
                    </Td>
                    <Td className="whitespace-nowrap">
                      <span title={formatDateTime(maybeNum(entry.createdAt))}>
                        {formatRelative(maybeNum(entry.createdAt))}
                      </span>
                    </Td>
                    <Td>
                      <div className="max-w-[14rem] truncate text-ink">{str(entry.actorLabel) || str(entry.actorId) || '—'}</div>
                      <div className="text-xs text-ink-subtle">{humanise(str(entry.actorType))}</div>
                    </Td>
                    <Td className="whitespace-nowrap font-medium text-ink">{str(entry.action) || '—'}</Td>
                    <Td>
                      <div className="max-w-[16rem] truncate">
                        {entry.targetType ? (
                          <>
                            <span className="text-ink-subtle">{humanise(str(entry.targetType))}</span>{' '}
                            <span className="font-mono text-xs">{str(entry.targetId) || '—'}</span>
                          </>
                        ) : (
                          '—'
                        )}
                      </div>
                    </Td>
                    <Td>
                      <Badge tone={result === 'ok' ? 'positive' : result === 'denied' ? 'warning' : 'negative'}>
                        {humanise(result)}
                      </Badge>
                    </Td>
                    <Td>
                      <div className={open ? 'max-w-md whitespace-pre-wrap text-xs' : 'max-w-[18rem] truncate text-xs'}>
                        {str(entry.reason) || str(entry.resultDetail) || (open ? str(entry.parameters) || '—' : '—')}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
            </DataTable>
          </div>
        )}
      </Card>
    </div>
  );
}

function LogsPanel() {
  const [level, setLevel] = useState<string>('');
  const [component, setComponent] = useState<string>('');

  // Both filters are applied server-side. Filtering the fetched window in the
  // browser instead would silently hide older events from a quiet component,
  // and a filter that quietly lies about what exists is worse than no filter.
  const query = useApiQuery<{ events?: LogRow[] }>(
    queryKeys.logs({ level: level || 'all', component: component || 'all', limit: LOG_LIMIT }),
    `/api/system/logs?limit=${LOG_LIMIT}${level ? `&level=${encodeURIComponent(level)}` : ''}${
      component ? `&component=${encodeURIComponent(component)}` : ''
    }`,
    { refetchInterval: POLL.normal },
  );

  const events = useMemo(() => query.data?.events ?? [], [query.data]);

  // Options accumulate across responses. Once a component filter is applied the
  // response contains only that component, and a select that empties itself the
  // moment you use it is unusable.
  const [knownComponents, setKnownComponents] = useState<string[]>([]);
  useEffect(() => {
    setKnownComponents((current) => {
      const merged = new Set(current);
      let added = false;
      for (const event of events) {
        const id = str(event.component);
        if (id && !merged.has(id)) {
          merged.add(id);
          added = true;
        }
      }
      return added ? [...merged].sort() : current;
    });
  }, [events]);

  const filtered = level !== '' || component !== '';
  const truncated = events.length >= LOG_LIMIT;
  const clearFilters = () => {
    setLevel('');
    setComponent('');
  };

  return (
    <Card padded={false}>
      <div className="space-y-3 p-4 sm:p-5">
        <SectionHeader
          title="System log"
          description="Structured events written by the server. Context is redacted before it is stored, so nothing here contains a credential."
        />
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-36">
            <label className="label" htmlFor="log-level">
              Level
            </label>
            <select id="log-level" className="input" value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="">All levels</option>
              {LOG_LEVELS.map((option) => (
                <option key={option} value={option}>
                  {humanise(option)}
                </option>
              ))}
            </select>
          </div>
          <div className="w-52">
            <label className="label" htmlFor="log-component">
              Component
            </label>
            <select id="log-component" className="input" value={component} onChange={(e) => setComponent(e.target.value)}>
              <option value="">All components</option>
              {knownComponents.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
              {component && !knownComponents.includes(component) && <option value={component}>{component}</option>}
            </select>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-subtle">
              Lists the components seen so far in this session, so a component that has been silent throughout may be
              missing from it.
            </p>
          </div>
          {filtered && (
            <button className="btn btn-ghost" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
        <Note tone="neutral">
          Showing the {formatNumber(events.length)} most recent event{events.length === 1 ? '' : 's'}
          {filtered ? ' matching these filters' : ''}
          {truncated
            ? `. That is the whole ${formatNumber(LOG_LIMIT)}-row window this page requests, so older matching events exist and are not shown — narrow the filters to reach them.`
            : filtered
              ? '. That is every matching event the server holds.'
              : '.'}
        </Note>
      </div>

      {query.isLoading ? (
        <div className="px-4 pb-4 sm:px-5">
          <LoadingRows rows={8} />
        </div>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : events.length === 0 ? (
        <EmptyState
          title={filtered ? 'No events match these filters' : 'The log is empty'}
          description={
            filtered
              ? 'The server holds no event at this level from this component. Try a different level or component, or clear the filters to see everything.'
              : 'Nothing has been logged yet. The server writes an event whenever a job runs, a provider changes state or something fails — run a job from the Jobs tab to see the first entries.'
          }
          icon="▤"
          action={
            filtered ? (
              <button className="btn btn-ghost" onClick={clearFilters}>
                Clear filters
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="px-4 pb-4 sm:px-5">
          <DataTable>
          <thead>
            <tr>
              <Th>Time</Th>
              <Th>Level</Th>
              <Th>Component</Th>
              <Th>Message</Th>
              <Th>Reference</Th>
            </tr>
          </thead>
          <tbody>
            {events.map((event, index) => {
              const eventLevel = str(event.level) || 'info';
              return (
                <tr key={str(event.id) || index} className="align-top transition-colors hover:bg-surface-hover/40">
                  <Td className="whitespace-nowrap">
                    <span title={formatDateTime(maybeNum(event.created_at))}>
                      {formatRelative(maybeNum(event.created_at))}
                    </span>
                  </Td>
                  <Td>
                    <Badge tone={LOG_LEVEL_TONE[eventLevel] ?? 'neutral'}>{eventLevel.toUpperCase()}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-xs">{str(event.component) || '—'}</Td>
                  <Td>
                    <div className="max-w-xl whitespace-pre-wrap break-words text-ink">{str(event.message) || '—'}</div>
                    {str(event.context) && (
                      <pre className="mt-1 max-w-xl overflow-x-auto rounded-lg border border-border bg-ground px-2 py-1.5 font-mono text-[11px] leading-relaxed text-ink-subtle">
                        {str(event.context)}
                      </pre>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-xs text-ink-subtle">
                    {str(event.ref_type) ? `${str(event.ref_type)}:${str(event.ref_id)}` : '—'}
                  </Td>
                </tr>
              );
            })}
          </tbody>
          </DataTable>
        </div>
      )}
    </Card>
  );
}

function DiagnosticsPanel() {
  const query = useApiQuery<DiagnosticsResponse>(queryKeys.diagnostics, '/api/system/diagnostics', {
    refetchInterval: POLL.slow,
  });

  if (query.isLoading) {
    return (
      <Card>
        <LoadingRows rows={6} />
      </Card>
    );
  }
  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  const data = query.data;
  if (!data) {
    return (
      <Card>
        <EmptyState
          title="No diagnostics were returned"
          description="The diagnostics endpoint answered with an empty body. Try refreshing; if it stays empty, check the system log for an error from the container."
          icon="⌘"
        />
      </Card>
    );
  }

  const environment = data.environment ?? {};
  const secretStore = data.secretStore ?? {};
  const wallet = data.wallet ?? {};
  const execution = data.execution ?? {};
  const providers = data.providers ?? {};
  const model = data.model ?? {};
  const chain = data.auditChain ?? null;

  const adapters = Array.isArray(execution.adapters) ? (execution.adapters as Array<Record<string, unknown>>) : [];
  const rpc = Array.isArray(execution.rpc) ? (execution.rpc as Array<Record<string, unknown>>) : [];

  const rawJson = JSON.stringify(data, null, 2);

  return (
    <div className="space-y-4">
      <Card>
        <SectionHeader
          title="Diagnostics"
          description="A single snapshot of what this process is configured with. Paste it into a bug report rather than describing it."
          action={<CopyButton value={rawJson} label="Copy as JSON" />}
        />
        <p className="mt-2 text-xs text-ink-subtle">Captured {formatRelative(maybeNum(data.checkedAt))}.</p>

        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <DiagnosticGroup title="Environment">
            <DiagnosticRow label="Node" value={str(environment.nodeVersion) || '—'} />
            <DiagnosticRow label="Platform" value={str(environment.platform) || '—'} />
            <DiagnosticRow
              label="Uptime"
              value={maybeNum(environment.uptimeSeconds) === null ? '—' : formatInterval(num(environment.uptimeSeconds))}
            />
            <DiagnosticRow label="Database" value={str(environment.databasePath) || '—'} mono />
          </DiagnosticGroup>

          <DiagnosticGroup title="Secret store">
            <DiagnosticRow
              label="Unlocked"
              value={secretStore.unlocked === true ? 'Yes' : 'No'}
              tone={secretStore.unlocked === true ? 'positive' : 'warning'}
            />
            <DiagnosticRow label="Secrets stored" value={formatNumber(maybeNum(secretStore.secretCount))} />
          </DiagnosticGroup>

          <DiagnosticGroup title="Wallet">
            <DiagnosticRow label="Configured" value={wallet.configured === true ? 'Yes' : 'No'} />
            <DiagnosticRow label="Can sign" value={wallet.canSign === true ? 'Yes' : 'No'} />
            <DiagnosticRow label="Custody" value={humanise(str(wallet.custody)) || '—'} />
            <DiagnosticRow
              label="Below floor"
              value={wallet.belowFloor === true ? 'Yes' : 'No'}
              tone={wallet.belowFloor === true ? 'warning' : 'neutral'}
            />
          </DiagnosticGroup>

          <DiagnosticGroup title="Execution">
            <DiagnosticRow label="Network" value={humanise(str(execution.network)) || '—'} />
            <DiagnosticRow label="Phase" value={humanise(str(execution.phase).replace(/^phase\d_/, '')) || '—'} />
          </DiagnosticGroup>

          <DiagnosticGroup title="Providers in use">
            <DiagnosticRow
              label="Trend"
              value={Array.isArray(providers.trend) ? (providers.trend as unknown[]).map((p) => str(p)).join(', ') || 'none' : '—'}
            />
            <DiagnosticRow
              label="Market"
              value={
                Array.isArray(providers.market) ? (providers.market as unknown[]).map((p) => str(p)).join(', ') || 'none' : '—'
              }
            />
            <DiagnosticRow label="AI" value={humanise(str(providers.ai)) || '—'} />
            <DiagnosticRow label="Image" value={str(providers.image) || '—'} />
          </DiagnosticGroup>

          <DiagnosticGroup title="Prediction model">
            <DiagnosticRow label="Version" value={str(model.version) || '—'} mono />
            <DiagnosticRow
              label="Trained on"
              value={maybeNum(model.trainedOn) === null ? str(model.trainedOn) || '—' : formatDateTime(num(model.trainedOn))}
            />
          </DiagnosticGroup>
        </div>
      </Card>

      {chain && (
        <Card>
          <SectionHeader title="Audit chain (from diagnostics)" />
          <div className="mt-3">
            {chain.valid === true ? (
              <Note tone="positive">
                Chain intact across the {formatNumber(maybeNum(chain.checked))} entries this snapshot walked. The walk
                starts at the first entry ever written and stops at a row limit, so it covers the oldest stretch of the
                log rather than the newest — run <strong className="font-semibold">Verify chain</strong> on the Audit log
                tab for the longer walk.
              </Note>
            ) : (
              <Note tone="negative">
                Chain broken at sequence {formatNumber(maybeNum(chain.brokenAtSequence))}.{' '}
                {str(chain.detail) || 'Re-run the full verification from the Audit log tab.'}
              </Note>
            )}
          </div>
        </Card>
      )}

      <Card padded={false}>
        <div className="p-4 sm:p-5">
          <SectionHeader title="Launch adapters" description="Which execution paths are ready to submit a transaction." />
        </div>
        {adapters.length === 0 ? (
          <EmptyState
            title="No launch adapters are registered"
            description="Adapters are built from the current network. In simulation only the simulation adapter exists, which is expected."
            icon="◆"
          />
        ) : (
          <div className="px-4 pb-4 sm:px-5">
            <DataTable>
            <thead>
              <tr>
                <Th>Adapter</Th>
                <Th>Ready</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              {adapters.map((adapter, index) => (
                <tr key={str(adapter.id) || index}>
                  <Td className="font-medium text-ink">{humanise(str(adapter.id))}</Td>
                  <Td>
                    <Badge tone={adapter.ready === true ? 'positive' : 'neutral'}>
                      <span aria-hidden="true">{adapter.ready === true ? '●' : '○'}</span>
                      {adapter.ready === true ? 'Ready' : 'Not ready'}
                    </Badge>
                  </Td>
                  <Td>{str(adapter.reason) || (adapter.ready === true ? 'Available.' : 'No reason reported.')}</Td>
                </tr>
              ))}
            </tbody>
            </DataTable>
          </div>
        )}
      </Card>

      <Card padded={false}>
        <div className="p-4 sm:p-5">
          <SectionHeader title="RPC endpoints" description="The pool the platform will use, in priority order." />
        </div>
        {rpc.length === 0 ? (
          <EmptyState
            title="No RPC endpoints"
            description="Simulation does not use an RPC pool. Switch to devnet or mainnet in Settings → Phase & autonomy and the pool will be built from your configured endpoints plus public fallbacks."
            icon="⬡"
          />
        ) : (
          <div className="px-4 pb-4 sm:px-5">
            <DataTable>
            <thead>
              <tr>
                <Th>Endpoint</Th>
                <Th>State</Th>
                <Th align="right">Latency</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              {rpc.map((endpoint, index) => {
                const state = str(endpoint.state) || 'unknown';
                return (
                  <tr key={str(endpoint.url) || index}>
                    <Td>
                      <div className="font-medium text-ink">{str(endpoint.label) || '—'}</div>
                      {/* The URL can embed an API key, so only the origin is shown. */}
                      <div className="font-mono text-xs text-ink-subtle">{originOf(str(endpoint.url))}</div>
                    </Td>
                    <Td>
                      <Badge tone={STATE_TONE[state] ?? 'neutral'}>
                        <span aria-hidden="true">{STATE_GLYPH[state] ?? '?'}</span>
                        {STATE_LABEL[state] ?? humanise(state)}
                      </Badge>
                    </Td>
                    <Td align="right" className="tnum">
                      {maybeNum(endpoint.latencyMs) === null ? '—' : `${formatNumber(num(endpoint.latencyMs))} ms`}
                    </Td>
                    <Td>{str(endpoint.detail) || '—'}</Td>
                  </tr>
                );
              })}
            </tbody>
            </DataTable>
          </div>
        )}
      </Card>
    </div>
  );
}

function originOf(url: string): string {
  if (!url) return '—';
  try {
    return new URL(url).origin;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

function DiagnosticGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-surface-raised p-3.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">{title}</div>
      <dl className="mt-2 space-y-1.5">{children}</dl>
    </div>
  );
}

function DiagnosticRow({
  label,
  value,
  mono,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: Tone;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <dt className="shrink-0 text-ink-subtle">{label}</dt>
      <dd
        className={[
          'min-w-0 break-all text-right',
          mono ? 'font-mono' : 'tnum',
          tone === 'positive' ? 'text-positive' : tone === 'warning' ? 'text-warning' : 'text-ink',
        ].join(' ')}
      >
        {value}
      </dd>
    </div>
  );
}

export default HealthPage;
