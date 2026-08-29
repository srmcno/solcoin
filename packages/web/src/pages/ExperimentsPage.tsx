import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingRows,
  Modal,
  Note,
  SampleSize,
  ScoreBar,
  SectionHeader,
  StatTile,
  Td,
  Th,
  type Tone,
} from '@/components/ui';
import { formatNumber, formatPercent, formatRelative, formatScore, humanise } from '@/lib/format';
import { POLL, queryKeys, useApiMutation, useApiQuery } from '@/lib/queries';
import { useSession } from '@/lib/session';

// --- API shapes ------------------------------------------------------------
// GET /api/experiments returns raw rows from the experiments table, so the list
// arrives snake_cased while the detail endpoint returns the camelCase service
// shape. Both are accepted here rather than assuming either.

interface ExperimentListRow {
  id?: string;
  name?: string;
  hypothesis?: string;
  factor?: string;
  status?: string;
  metric?: string;
  min_samples_per_arm?: number;
  minSamplesPerArm?: number;
  started_at?: number | null;
  startedAt?: number | null;
  ended_at?: number | null;
  endedAt?: number | null;
  conclusion?: string | null;
  created_at?: number;
  createdAt?: number;
}

interface Experiment {
  id: string;
  name: string;
  hypothesis: string;
  factor: string;
  status: string;
  metric: string;
  minSamplesPerArm: number;
  startedAt: number | null;
  endedAt: number | null;
  conclusion: string | null;
  createdAt: number;
}

interface ArmRate {
  posteriorMean?: number;
  lower?: number;
  upper?: number;
  successes?: number;
  n?: number;
}

interface ArmMetric {
  /**
   * Outcomes that carried a numeric value. This — not the arm's `n` — is the
   * sample behind every figure in the metric block, and it is routinely
   * smaller: an outcome can be a recorded success with a null value.
   */
  valueCount?: number;
  meanValue?: number | null;
  shrunkMeanValue?: number | null;
  medianValue?: number | null;
  p25?: number | null;
  p75?: number | null;
  p90?: number | null;
  maxValue?: number | null;
  topTenPercentShare?: number | null;
  meanToMedianRatio?: number | null;
  tailStatisticsMeaningful?: boolean;
}

interface ArmResult {
  armId?: string;
  key?: string;
  label?: string;
  config?: Record<string, unknown>;
  assigned?: number;
  n?: number;
  /** Share of assignments that reached an outcome; null when none were assigned. */
  outcomeCoverage?: number | null;
  successRate?: ArmRate;
  metric?: ArmMetric;
  probabilityBest?: number;
  reachedMinSamples?: boolean;
}

interface ExperimentResults {
  experimentId?: string;
  name?: string;
  hypothesis?: string;
  factor?: string;
  metric?: string;
  status?: string;
  minSamplesPerArm?: number;
  totalAssigned?: number;
  totalOutcomes?: number;
  /** Outcomes carrying a numeric value; the n behind `pooledMeanValue`. */
  totalMetricValues?: number;
  /** The target every arm's shrunk mean is pulled toward. Null when unmeasured. */
  pooledMeanValue?: number | null;
  arms?: ArmResult[];
  leader?: { key?: string; probabilityBest?: number } | null;
  conclusive?: boolean;
  interpretation?: string;
  /** What this comparison does and does not establish, in the service's words. */
  caveats?: string[];
  monteCarloDraws?: number;
}

interface BanditArmView {
  dimension?: string;
  key?: string;
  label?: string;
  posteriorMean?: number;
  lower?: number;
  upper?: number;
  n?: number;
  successes?: number;
  failures?: number;
  meanReward?: number;
  rewardCount?: number;
  ucb?: number;
  sampled?: number;
  active?: boolean;
  updatedAt?: number;
}

interface ExperimentsResponse {
  experiments?: ExperimentListRow[];
  banditArms?: BanditArmView[];
}

// --- Static configuration --------------------------------------------------

const STATUS_TONE: Record<string, Tone> = {
  draft: 'neutral',
  running: 'accent',
  completed: 'positive',
  abandoned: 'warning',
};

const METRIC_OPTIONS = [
  { id: 'creator_fees_sol', label: 'Creator fees (SOL)' },
  { id: 'ten_holders', label: 'Reached ten holders' },
  { id: 'volume_24h_sol', label: '24h volume (SOL)' },
];

/** Server gate: an experiment is only called conclusive above this posterior. */
const CONCLUSIVE_PROBABILITY = 0.9;

function normalise(row: ExperimentListRow): Experiment {
  return {
    id: row.id ?? '',
    name: row.name ?? 'Untitled experiment',
    hypothesis: row.hypothesis ?? '',
    factor: row.factor ?? '—',
    status: row.status ?? 'draft',
    metric: row.metric ?? '—',
    minSamplesPerArm: row.minSamplesPerArm ?? row.min_samples_per_arm ?? 0,
    startedAt: row.startedAt ?? row.started_at ?? null,
    endedAt: row.endedAt ?? row.ended_at ?? null,
    conclusion: row.conclusion ?? null,
    createdAt: row.createdAt ?? row.created_at ?? 0,
  };
}

// --- Page ------------------------------------------------------------------

export default function ExperimentsPage() {
  const { can } = useSession();
  const manage = can('manage_experiments');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const listQuery = useApiQuery<ExperimentsResponse>(queryKeys.experiments, '/api/experiments', {
    refetchInterval: POLL.normal,
  });

  const experiments = useMemo(() => (listQuery.data?.experiments ?? []).map(normalise).filter((e) => e.id), [listQuery.data]);

  // Selecting the first experiment on arrival means the results panel is never
  // an empty box next to a populated list.
  useEffect(() => {
    if (selectedId === null && experiments.length > 0) setSelectedId(experiments[0]?.id ?? null);
  }, [experiments, selectedId]);

  const selected = experiments.find((e) => e.id === selectedId) ?? null;

  const resultsQuery = useApiQuery<ExperimentResults>(
    queryKeys.experiment(selectedId ?? 'none'),
    `/api/experiments/${selectedId ?? ''}`,
    { enabled: Boolean(selectedId), refetchInterval: POLL.normal },
  );

  // ['experiments'] is a prefix of ['experiments', id], so one invalidation
  // refreshes both the list and whichever result panel is open.
  const start = useApiMutation<{ ok?: boolean }, string>((id) => `/api/experiments/${id}/start`, {
    invalidate: [queryKeys.experiments],
  });
  const stop = useApiMutation<{ ok?: boolean }, { id: string; conclusion: string }>(
    (vars) => `/api/experiments/${vars.id}/stop`,
    { invalidate: [queryKeys.experiments] },
  );

  if (listQuery.isLoading) {
    return (
      <div className="space-y-4">
        <SectionHeader title="Experiments" description="Pre-registered A/B tests on the things the platform can vary." />
        <LoadingRows rows={6} />
      </div>
    );
  }

  if (listQuery.isError) {
    return (
      <div className="space-y-4">
        <SectionHeader title="Experiments" />
        <Card>
          <ErrorState error={listQuery.error} onRetry={() => void listQuery.refetch()} />
        </Card>
      </div>
    );
  }

  const banditArms = listQuery.data?.banditArms ?? [];

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Experiments"
        description="Each experiment fixes its sample size before it starts, so a result cannot be declared the moment the numbers happen to look good. Read the interpretation, not the ranking."
        action={
          manage ? (
            <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              New experiment
            </button>
          ) : undefined
        }
      />

      {experiments.length === 0 ? (
        <Card>
          <EmptyState
            icon="◑"
            title="No experiments yet"
            description={
              manage
                ? 'An experiment varies one factor — a ticker style, an image prompt, a launch hour — across two to six arms and measures the effect on a chosen metric. Create one, start it, and the pipeline will assign new concepts to arms automatically.'
                : 'No experiment has been created yet. An account with experiment permissions can create one.'
            }
            action={
              manage ? (
                <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
                  Create the first experiment
                </button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
          <ExperimentList experiments={experiments} selectedId={selectedId} onSelect={setSelectedId} />
          <ResultsPanel
            experiment={selected}
            query={resultsQuery}
            manage={manage}
            onStart={(id) => start.mutate(id)}
            onStop={(id, conclusion) => stop.mutate({ id, conclusion })}
            starting={start.isPending}
            stopping={stop.isPending}
            actionError={start.error ?? stop.error ?? null}
          />
        </div>
      )}

      <BanditPanel arms={banditArms} />

      <CreateExperimentModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={(id) => setSelectedId(id)} />
    </div>
  );
}

export { ExperimentsPage };

// --- 1. List ---------------------------------------------------------------

function ExperimentList({
  experiments,
  selectedId,
  onSelect,
}: {
  experiments: Experiment[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Card padded={false} className="overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">All experiments</h2>
        <p className="mt-0.5 text-xs text-ink-subtle">{formatNumber(experiments.length)} registered</p>
      </div>
      <ul className="max-h-[32rem] divide-y divide-border overflow-y-auto">
        {experiments.map((experiment) => {
          const active = experiment.id === selectedId;
          return (
            <li key={experiment.id}>
              <button
                className={
                  'w-full px-4 py-3 text-left transition-colors ' +
                  (active ? 'bg-accent-dim/25' : 'hover:bg-surface-hover')
                }
                onClick={() => onSelect(experiment.id)}
                aria-current={active ? 'true' : undefined}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className={'truncate text-sm font-medium ' + (active ? 'text-accent-soft' : 'text-ink')}>
                    {experiment.name}
                  </span>
                  <Badge tone={STATUS_TONE[experiment.status] ?? 'neutral'}>{humanise(experiment.status)}</Badge>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-subtle">
                  <span>factor: {humanise(experiment.factor)}</span>
                  <span>metric: {humanise(experiment.metric)}</span>
                  <span className="tnum">target {formatNumber(experiment.minSamplesPerArm)}/arm</span>
                </div>
                <div className="mt-1 text-xs text-ink-subtle">
                  {experiment.startedAt ? `started ${formatRelative(experiment.startedAt)}` : `created ${formatRelative(experiment.createdAt)}`}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// --- 2. Results ------------------------------------------------------------

interface ResultsQueryLike {
  data?: ExperimentResults;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => unknown;
}

function ResultsPanel({
  experiment,
  query,
  manage,
  onStart,
  onStop,
  starting,
  stopping,
  actionError,
}: {
  experiment: Experiment | null;
  query: ResultsQueryLike;
  manage: boolean;
  onStart: (id: string) => void;
  onStop: (id: string, conclusion: string) => void;
  starting: boolean;
  stopping: boolean;
  actionError: Error | null;
}) {
  const [stopOpen, setStopOpen] = useState(false);
  const [conclusion, setConclusion] = useState('');

  if (!experiment) {
    return (
      <Card>
        <EmptyState title="Select an experiment" description="Pick an experiment from the list to see its per-arm results." />
      </Card>
    );
  }

  const results = query.data;
  const arms = results?.arms ?? [];
  const minSamples = results?.minSamplesPerArm ?? experiment.minSamplesPerArm;
  const smallestArm = arms.reduce<number | null>((min, a) => (min === null ? (a.n ?? 0) : Math.min(min, a.n ?? 0)), null);
  const conclusive = results?.conclusive === true;

  // Differential attrition: randomisation balances arms at assignment, not at
  // measurement. Coverage that differs between arms means the compared arms are
  // no longer the randomised ones, so the spread is called out rather than
  // being left for the reader to compute from the per-arm cards.
  const coverages = arms
    .map((a) => a.outcomeCoverage)
    .filter((c): c is number => typeof c === 'number' && Number.isFinite(c));
  const attritionSpread = coverages.length > 1 ? Math.max(...coverages) - Math.min(...coverages) : null;

  return (
    <div className="space-y-4">
      <Card>
        <SectionHeader
          title={experiment.name}
          description={experiment.hypothesis}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[experiment.status] ?? 'neutral'}>{humanise(experiment.status)}</Badge>
              {manage && experiment.status === 'draft' && (
                <button className="btn btn-primary" onClick={() => onStart(experiment.id)} disabled={starting}>
                  {starting ? 'Starting…' : 'Start'}
                </button>
              )}
              {manage && experiment.status === 'running' && (
                <button className="btn btn-danger" onClick={() => setStopOpen(true)} disabled={stopping}>
                  Stop
                </button>
              )}
            </div>
          }
        />

        {actionError && <div className="mt-3"><Note tone="negative">{actionError.message}</Note></div>}

        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile label="Factor varied" value={humanise(experiment.factor)} hint="The one thing that differs between arms." />
          <StatTile label="Metric" value={humanise(experiment.metric)} hint="What each arm is scored on." />
          <StatTile
            label="Assigned / with outcome"
            value={`${formatNumber(results?.totalAssigned ?? 0)} / ${formatNumber(results?.totalOutcomes ?? 0)}`}
            hint="Assignments whose outcome window has not closed cannot be scored yet."
          />
          <StatTile
            label="Smallest arm"
            value={smallestArm === null ? '—' : formatNumber(smallestArm)}
            tone={smallestArm !== null && smallestArm < minSamples ? 'warning' : 'positive'}
            hint={`Pre-registered target is ${formatNumber(minSamples)} per arm.`}
          />
        </div>

        <div className="mt-4">
          <Note tone={conclusive ? 'positive' : 'warning'}>
            <strong className="font-semibold">{conclusive ? 'Conclusive. ' : 'Not conclusive. '}</strong>
            {results?.interpretation ?? 'No interpretation has been returned for this experiment yet.'}
          </Note>
        </div>

        {experiment.conclusion && (
          <p className="mt-3 text-sm leading-relaxed text-ink-muted">
            <span className="font-medium text-ink">Recorded conclusion: </span>
            {experiment.conclusion}
          </p>
        )}

        {/* The service writes out what randomisation here does and does not buy.
            Dropping it would leave the table inviting a causal reading it has
            not earned, which is the whole reason the service returns it. */}
        {results?.caveats && results.caveats.length > 0 && (
          <div className="mt-4 border-t border-border pt-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
              What this comparison does not establish
            </h3>
            <ul className="mt-2 space-y-2">
              {results.caveats.map((caveat, i) => (
                <li key={i} className="flex gap-2 text-xs leading-relaxed text-ink-muted">
                  <span aria-hidden="true" className="text-warning">
                    ▸
                  </span>
                  <span>{caveat}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card>
        <SectionHeader
          title="Per-arm results"
          description={`Success rates are Beta posterior means, not successes over n: a one-of-one arm reports about 50%, not 100%. P(best) is a Monte Carlo estimate over the arms' posteriors${results?.monteCarloDraws ? ` from ${formatNumber(results.monteCarloDraws)} draws` : ''}.`}
        />

        {query.isLoading ? (
          <LoadingRows rows={4} className="mt-4" />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : arms.length === 0 ? (
          <EmptyState
            title="This experiment has no arms with results"
            description="Arms appear here once the experiment is running and the pipeline has assigned concepts to them."
          />
        ) : (
          <>
            {attritionSpread !== null && attritionSpread > 0.2 && (
              <div className="mt-3">
                <Note tone="warning">
                  <strong className="font-semibold">Uneven outcome coverage. </strong>
                  The share of assignments that reached a recorded outcome differs by{' '}
                  {formatPercent(attritionSpread, 0)} between arms. Randomisation only balances the arms at assignment; if
                  outcomes go missing at different rates afterwards, the arms being compared are no longer the arms that were
                  randomised.
                </Note>
              </div>
            )}
            <div className="mt-4 space-y-3">
              {arms.map((arm, i) => (
                <ArmCard
                  key={arm.armId ?? arm.key ?? i}
                  arm={arm}
                  minSamples={minSamples}
                  metric={results?.metric ?? experiment.metric}
                  isLeader={Boolean(results?.leader?.key && results.leader.key === arm.key)}
                  conclusive={conclusive}
                  pooledMeanValue={results?.pooledMeanValue ?? null}
                  totalMetricValues={results?.totalMetricValues}
                />
              ))}
            </div>
            {!conclusive && (
              <p className="mt-3 text-xs leading-relaxed text-ink-subtle">
                An arm is only called a winner when every arm has reached its pre-registered sample size and one arm holds at
                least a {formatPercent(CONCLUSIVE_PROBABILITY, 0)} posterior probability of being best. Until both hold, the bars
                below describe the sample, not the world.
              </p>
            )}
          </>
        )}
      </Card>

      <Modal
        open={stopOpen}
        onClose={() => setStopOpen(false)}
        title={`Stop “${experiment.name}”`}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setStopOpen(false)}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              disabled={stopping}
              onClick={() => {
                onStop(experiment.id, conclusion);
                setStopOpen(false);
                setConclusion('');
              }}
            >
              {stopping ? 'Stopping…' : 'Stop experiment'}
            </button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-ink-muted">
          Stopping ends assignment to this experiment. Record what you concluded — including “nothing, the sample was too small”,
          which is the honest answer most of the time.
        </p>
        <label className="label mt-4" htmlFor="stop-conclusion">
          Conclusion
        </label>
        <textarea
          id="stop-conclusion"
          className="input min-h-24"
          value={conclusion}
          onChange={(e) => setConclusion(e.target.value)}
          placeholder="What did this experiment establish, if anything?"
        />
      </Modal>
    </div>
  );
}

function ArmCard({
  arm,
  minSamples,
  metric,
  isLeader,
  conclusive,
  pooledMeanValue,
  totalMetricValues,
}: {
  arm: ArmResult;
  minSamples: number;
  metric: string;
  isLeader: boolean;
  conclusive: boolean;
  pooledMeanValue: number | null;
  totalMetricValues?: number;
}) {
  const n = arm.n ?? 0;
  const rate = arm.successRate;
  const probabilityBest = arm.probabilityBest;
  const progress = minSamples > 0 ? Math.min(1, n / minSamples) : 0;
  const reached = arm.reachedMinSamples === true;
  const armMetric = arm.metric;
  // The metric block has its own n: an outcome can be recorded without a value.
  const valueCount = armMetric?.valueCount ?? 0;
  const coverage = arm.outcomeCoverage;

  return (
    <div className="rounded-xl border border-border bg-surface-raised p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-ink">{arm.label ?? arm.key ?? 'Arm'}</span>
            <span className="tnum text-xs text-ink-subtle">{arm.key}</span>
            {isLeader && (
              <Badge tone={conclusive ? 'positive' : 'neutral'}>
                {conclusive ? '✓ Winner' : 'Nominally ahead'}
              </Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-ink-subtle">
            <span className="tnum">{formatNumber(arm.assigned ?? 0)} assigned</span>
            <span className="tnum">{formatNumber(n)} with outcome</span>
            <span className={'tnum ' + (coverage !== null && coverage !== undefined && coverage < 0.8 ? 'text-warning' : '')}>
              {coverage === null || coverage === undefined
                ? 'coverage n/a'
                : `${formatPercent(coverage, 0)} coverage`}
            </span>
            <SampleSize n={n} minimum={Math.max(2, minSamples)} />
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs font-medium uppercase tracking-wide text-ink-subtle">P(best)</div>
          <div className="tnum text-xl font-semibold text-accent-soft">
            {probabilityBest === undefined ? '—' : formatPercent(probabilityBest, 0)}
          </div>
        </div>
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between text-xs text-ink-subtle">
          <span>Posterior probability this arm is best</span>
          <span className="tnum">{probabilityBest === undefined ? '—' : formatPercent(probabilityBest, 1)}</span>
        </div>
        {probabilityBest !== undefined && (
          <ScoreBar value={probabilityBest} tone={conclusive && isLeader ? 'positive' : 'accent'} className="mt-1 h-2" />
        )}
        {n === 0 && (
          <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
            This arm has no outcomes, so it keeps its wide prior — the share above is what an untested arm is entitled to, not
            something it has shown.
          </p>
        )}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Success rate</div>
          <div className="tnum mt-0.5 text-sm text-ink">
            {rate?.posteriorMean === undefined ? '—' : formatPercent(rate.posteriorMean, 1)}
            <span className="ml-1.5 text-xs text-ink-subtle">
              {rate?.lower === undefined || rate.upper === undefined
                ? ''
                : `95% ${formatPercent(rate.lower, 0)}–${formatPercent(rate.upper, 0)}`}
            </span>
          </div>
          <div className="tnum text-xs text-ink-subtle">
            {formatNumber(rate?.successes ?? 0)} success(es) in {formatNumber(rate?.n ?? n)}
          </div>
        </div>
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
            Progress to pre-registered n
          </div>
          <div className="tnum mt-0.5 text-sm text-ink">
            {formatNumber(n)} / {formatNumber(minSamples)}
          </div>
          <ScoreBar value={progress} tone={reached ? 'positive' : 'warning'} className="mt-1.5" />
          <div className={'mt-1 text-xs ' + (reached ? 'text-positive' : 'text-warning')}>
            {reached ? '✓ target reached' : `⚠ ${formatNumber(Math.max(0, minSamples - n))} more needed`}
          </div>
        </div>
      </div>

      {armMetric && (
        <div className="mt-3 border-t border-border pt-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{humanise(metric)}</div>
            {/* The metric figures are conditional on `valueCount`, not on the
                arm's outcome count, and the two differ whenever an outcome was
                recorded without a value. The smaller number is the honest one. */}
            <div className="flex items-center gap-2 text-xs text-ink-subtle">
              <SampleSize n={valueCount} minimum={Math.max(2, minSamples)} />
              {valueCount < n && (
                <span className="text-warning">
                  ⚠ {formatNumber(n - valueCount)} of {formatNumber(n)} outcome(s) carried no value
                </span>
              )}
            </div>
          </div>
          {valueCount === 0 ? (
            <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
              No outcome in this arm carried a numeric {humanise(metric).toLowerCase()} value, so this arm has no median, no
              mean and no percentiles. Nothing is shown rather than zeros, which would sit in the same column as measured
              figures.
            </p>
          ) : (
            <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
              <MetricCell label="Median" value={formatScore(armMetric.medianValue, 4)} emphasis />
              <MetricCell label="Mean" value={formatScore(armMetric.meanValue, 4)} />
              <MetricCell
                label="Shrunk mean"
                value={formatScore(armMetric.shrunkMeanValue, 4)}
                hint={
                  pooledMeanValue === null
                    ? 'no pooled mean to shrink toward'
                    : `pulled toward ${formatScore(pooledMeanValue, 4)} (pooled over ${formatNumber(totalMetricValues ?? 0)})`
                }
              />
              <MetricCell label="p75 / p90" value={`${formatScore(armMetric.p75, 3)} / ${formatScore(armMetric.p90, 3)}`} />
            </div>
          )}
          {valueCount === 0 ? null : armMetric.tailStatisticsMeaningful === false ? (
            <p className="mt-2 text-xs leading-relaxed text-warning">
              ⚠ Too few outcomes in this arm for the tail statistics to mean anything — the percentiles above are printed, not
              estimated.
            </p>
          ) : armMetric.meanToMedianRatio !== null &&
            armMetric.meanToMedianRatio !== undefined &&
            armMetric.meanToMedianRatio > 2 ? (
            <p className="mt-2 text-xs leading-relaxed text-warning">
              ⚠ The mean is {formatScore(armMetric.meanToMedianRatio, 1)}× the median and the top 10% of launches carry{' '}
              {formatPercent(armMetric.topTenPercentShare ?? 0, 0)} of this arm's total — the arm's headline rests on its tail,
              not on a typical launch.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function MetricCell({
  label,
  value,
  emphasis,
  hint,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  hint?: string;
}) {
  return (
    <div>
      <div className="text-ink-subtle">{label}</div>
      <div className={'tnum ' + (emphasis ? 'font-medium text-ink' : 'text-ink-muted')}>{value}</div>
      {hint && <div className="tnum text-[0.6875rem] leading-tight text-ink-subtle">{hint}</div>}
    </div>
  );
}

// --- 3. Bandit arms --------------------------------------------------------

function BanditPanel({ arms }: { arms: BanditArmView[] }) {
  const maxUcb = arms.reduce((max, a) => Math.max(max, a.ucb ?? 0), 0);

  return (
    <Card>
      <SectionHeader
        title="Exploration arms (Thompson sampling)"
        description="The exploration policy is a separate, always-on bandit over launch strategies — it is not one of the experiments above."
      />

      <div className="mt-3">
        <Note tone="info">
          Each arm holds a Beta posterior over its success rate. To choose, the platform draws one random sample from every arm's
          posterior and launches the arm whose draw came out highest. An arm with few observations has a wide posterior, so its
          draws are sometimes very high — which is exactly why under-tested arms keep getting tried instead of being frozen out by
          an early lucky run.
        </Note>
      </div>

      {arms.length === 0 ? (
        <EmptyState
          title="No exploration arms recorded yet"
          description="Arms are created the first time the pipeline explores a strategy. Once launches start, each arm accumulates successes and failures here."
        />
      ) : (
        <DataTable className="mt-4">
          <thead>
            <tr>
              <Th>Arm</Th>
              <Th align="right">Posterior mean</Th>
              <Th align="right">95% interval</Th>
              <Th align="right">n</Th>
              <Th align="right">Mean reward</Th>
              <Th align="right">UCB</Th>
              <Th align="right">This draw</Th>
              <Th>State</Th>
            </tr>
          </thead>
          <tbody>
            {arms.map((arm, i) => {
              const n = arm.n ?? 0;
              const mean = arm.posteriorMean;
              return (
                <tr key={arm.key ?? i}>
                  <Td className="text-ink">
                    <div className="font-medium">{arm.label ?? arm.key ?? '—'}</div>
                    <div className="tnum text-xs text-ink-subtle">
                      {arm.key} · {formatNumber(arm.successes ?? 0)}W / {formatNumber(arm.failures ?? 0)}L
                    </div>
                  </Td>
                  <Td align="right" className="min-w-[7rem]">
                    <div className="tnum text-ink">{mean === undefined ? '—' : formatPercent(mean, 1)}</div>
                    {mean !== undefined && <ScoreBar value={mean} tone="accent" className="mt-1" />}
                    {n === 0 && (
                      <div className="whitespace-normal text-xs leading-tight text-ink-subtle">prior only — untried</div>
                    )}
                  </Td>
                  <Td align="right" className="tnum">
                    {arm.lower === undefined || arm.upper === undefined
                      ? '—'
                      : `${formatPercent(arm.lower, 0)}–${formatPercent(arm.upper, 0)}`}
                  </Td>
                  <Td align="right">
                    <SampleSize n={n} />
                  </Td>
                  <Td align="right" className="tnum">
                    {formatScore(arm.meanReward, 4)}
                    <div className="text-xs text-ink-subtle">over {formatNumber(arm.rewardCount ?? 0)}</div>
                  </Td>
                  <Td align="right" className="min-w-[7rem]">
                    <div className="tnum text-ink-muted">{formatScore(arm.ucb, 3)}</div>
                    <ScoreBar value={maxUcb > 0 ? (arm.ucb ?? 0) / maxUcb : 0} tone="info" className="mt-1" />
                  </Td>
                  <Td align="right" className="tnum">
                    {formatScore(arm.sampled, 3)}
                  </Td>
                  <Td>
                    <Badge tone={arm.active === false ? 'neutral' : 'positive'}>
                      {arm.active === false ? 'Paused' : '✓ Active'}
                    </Badge>
                    <div className="mt-1 text-xs text-ink-subtle">{formatRelative(arm.updatedAt)}</div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}

      {arms.length > 0 && (
        <p className="mt-3 text-xs leading-relaxed text-ink-subtle">
          The posterior interval says how much is known about an arm; the UCB says what is worth trying next, and is high both for
          genuinely good arms and for untested ones. “This draw” is a single Thompson sample taken when the page loaded — it is a
          sample, not a statistic, and it changes on every refresh by design.
        </p>
      )}
    </Card>
  );
}

// --- 4. Create -------------------------------------------------------------

interface ArmDraft {
  key: string;
  label: string;
  config: string;
}

const EMPTY_ARMS: ArmDraft[] = [
  { key: 'control', label: 'Control', config: '{}' },
  { key: 'variant_a', label: 'Variant A', config: '{}' },
];

function CreateExperimentModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [hypothesis, setHypothesis] = useState('');
  const [factor, setFactor] = useState('');
  const [metric, setMetric] = useState('creator_fees_sol');
  const [minSamples, setMinSamples] = useState('12');
  const [arms, setArms] = useState<ArmDraft[]>(EMPTY_ARMS);
  const [localError, setLocalError] = useState<string | null>(null);

  const create = useApiMutation<{ id?: string }, Record<string, unknown>>('/api/experiments', {
    invalidate: [queryKeys.experiments],
    onSuccess: (result) => {
      if (result?.id) onCreated(result.id);
      reset();
      onClose();
    },
  });

  function reset() {
    setName('');
    setHypothesis('');
    setFactor('');
    setMetric('creator_fees_sol');
    setMinSamples('12');
    setArms(EMPTY_ARMS);
    setLocalError(null);
  }

  function updateArm(index: number, patch: Partial<ArmDraft>) {
    setArms((current) => current.map((arm, i) => (i === index ? { ...arm, ...patch } : arm)));
  }

  function submit() {
    setLocalError(null);
    if (name.trim().length < 3) return setLocalError('Name must be at least 3 characters.');
    if (hypothesis.trim().length < 10) return setLocalError('Hypothesis must be at least 10 characters — state what you expect and why.');
    if (factor.trim().length < 2) return setLocalError('Name the factor being varied, e.g. ticker_style.');
    const parsedMin = Number(minSamples);
    if (!Number.isInteger(parsedMin) || parsedMin < 2 || parsedMin > 200) {
      return setLocalError('Minimum samples per arm must be a whole number between 2 and 200.');
    }
    if (arms.length < 2 || arms.length > 6) return setLocalError('An experiment needs between 2 and 6 arms.');

    const parsedArms: Array<{ key: string; label: string; config: Record<string, unknown> }> = [];
    for (const [index, arm] of arms.entries()) {
      if (!arm.key.trim() || !arm.label.trim()) return setLocalError(`Arm ${index + 1} needs both a key and a label.`);
      let config: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(arm.config.trim() || '{}');
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return setLocalError(`Arm ${index + 1} config must be a JSON object.`);
        }
        config = parsed as Record<string, unknown>;
      } catch {
        return setLocalError(`Arm ${index + 1} config is not valid JSON.`);
      }
      parsedArms.push({ key: arm.key.trim(), label: arm.label.trim(), config });
    }
    if (new Set(parsedArms.map((a) => a.key)).size !== parsedArms.length) {
      return setLocalError('Arm keys must be unique.');
    }

    create.mutate({
      name: name.trim(),
      hypothesis: hypothesis.trim(),
      factor: factor.trim(),
      metric,
      minSamplesPerArm: parsedMin,
      arms: parsedArms,
    });
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="New experiment"
      footer={
        <>
          <button
            className="btn btn-ghost"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create experiment'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Note tone="neutral">
          The sample size is pre-registered: the experiment cannot be declared a success before every arm reaches it. Choose it
          now, from what effect size would be worth acting on — not later, from what the data happens to show.
        </Note>

        <div>
          <label className="label" htmlFor="exp-name">
            Name
          </label>
          <input id="exp-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ticker style: word versus acronym" />
        </div>

        <div>
          <label className="label" htmlFor="exp-hypothesis">
            Hypothesis
          </label>
          <textarea
            id="exp-hypothesis"
            className="input min-h-20"
            value={hypothesis}
            onChange={(e) => setHypothesis(e.target.value)}
            placeholder="Pronounceable word tickers earn more creator fees than acronyms because they are easier to repeat in chat."
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="exp-factor">
              Factor varied
            </label>
            <input id="exp-factor" className="input" value={factor} onChange={(e) => setFactor(e.target.value)} placeholder="ticker_style" />
          </div>
          <div>
            <label className="label" htmlFor="exp-metric">
              Metric
            </label>
            <select id="exp-metric" className="input" value={metric} onChange={(e) => setMetric(e.target.value)}>
              {METRIC_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="label" htmlFor="exp-min-samples">
            Minimum samples per arm
          </label>
          <input
            id="exp-min-samples"
            className="input"
            type="number"
            min={2}
            max={200}
            value={minSamples}
            onChange={(e) => setMinSamples(e.target.value)}
          />
        </div>

        <div>
          <div className="flex items-center justify-between">
            <span className="label mb-0">Arms ({arms.length})</span>
            <div className="flex gap-2">
              <button
                className="btn btn-ghost px-2 py-1 text-xs"
                onClick={() => setArms((current) => [...current, { key: `variant_${current.length}`, label: `Variant ${current.length}`, config: '{}' }])}
                disabled={arms.length >= 6}
              >
                Add arm
              </button>
              <button
                className="btn btn-ghost px-2 py-1 text-xs"
                onClick={() => setArms((current) => current.slice(0, -1))}
                disabled={arms.length <= 2}
              >
                Remove last
              </button>
            </div>
          </div>

          <div className="mt-2 space-y-3">
            {arms.map((arm, index) => (
              <div key={index} className="rounded-lg border border-border bg-surface-raised p-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor={`arm-key-${index}`}>
                      Key
                    </label>
                    <input
                      id={`arm-key-${index}`}
                      className="input"
                      value={arm.key}
                      onChange={(e) => updateArm(index, { key: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor={`arm-label-${index}`}>
                      Label
                    </label>
                    <input
                      id={`arm-label-${index}`}
                      className="input"
                      value={arm.label}
                      onChange={(e) => updateArm(index, { label: e.target.value })}
                    />
                  </div>
                </div>
                <label className="label mt-2" htmlFor={`arm-config-${index}`}>
                  Config (JSON object handed verbatim to the pipeline)
                </label>
                <textarea
                  id={`arm-config-${index}`}
                  className="input min-h-16 font-mono text-xs"
                  value={arm.config}
                  onChange={(e) => updateArm(index, { config: e.target.value })}
                  spellCheck={false}
                />
              </div>
            ))}
          </div>
        </div>

        {localError && <Note tone="negative">{localError}</Note>}
        {create.isError && <Note tone="negative">{create.error.message}</Note>}
      </div>
    </Modal>
  );
}
