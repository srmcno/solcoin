import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingRows,
  Note,
  SampleSize,
  SectionHeader,
  StatTile,
  Td,
  Th,
} from '@/components/ui';
import { formatNumber, formatPercent, formatScore, formatSol, humanise } from '@/lib/format';
import { POLL, queryKeys, useApiMutation, useApiQuery } from '@/lib/queries';

// --- API shapes ------------------------------------------------------------

type RangeKey = '30d' | '90d' | '1y' | 'all';

interface StrategyConfig {
  minOpportunityScore?: number;
  minOriginalityScore?: number;
  maxSaturationScore?: number;
  minProbabilityTenHolders?: number;
  minExpectedValueSol?: number;
  minProbabilityProfitable?: number;
  minSourceBreadth?: number;
  maxTrendAgeHours?: number;
  blockOnHardCollision?: boolean;
  humanReviewOnAnyRiskFlag?: boolean;
  maxLaunchesPerDay?: number;
  [key: string]: unknown;
}

interface StrategyPreset {
  name?: string;
  description?: string;
  config?: StrategyConfig;
}

interface SkewSummary {
  n?: number;
  totalSol?: number;
  meanSol?: number;
  medianSol?: number;
  p10Sol?: number;
  p25Sol?: number;
  p75Sol?: number;
  p90Sol?: number;
  p99Sol?: number;
  maxSol?: number;
  top10PercentShare?: number;
  gini?: number;
}

interface ModelledProjection {
  label?: string;
  unobservedCandidates?: number;
  scoredCandidates?: number;
  extrapolated?: boolean;
  modelVersion?: string;
  modelTrainedOnOutcomes?: number;
  modelledFeesSol?: number;
  modelledMedianFeesSol?: number;
  modelledCostSol?: number;
  modelledNetSol?: number;
  caveats?: string[];
}

interface ReplayResult {
  windowDays?: number;
  candidatesConsidered?: number;
  wouldHaveLaunched?: number;
  ofWhichObserved?: number;
  ofWhichUnobserved?: number;
  observedFraction?: { point?: number; lower?: number; upper?: number; n?: number };
  realisedFeesSol?: number;
  realisedCostSol?: number;
  realisedNetSol?: number;
  realisedPerLaunch?: SkewSummary | null;
  observedGraduationRate?: { successes?: number; n?: number; mean?: number; lower?: number; upper?: number };
  launchesPerDay?: number;
  rejectionReasonBreakdown?: Record<string, number>;
  wouldHaveRequiredHumanReview?: number;
  candidatesWithoutStoredPrediction?: number;
  actualLaunchesInWindow?: number;
  modelled?: ModelledProjection | null;
  caveats?: string[];
}

interface ComparisonEntry {
  name?: string;
  description?: string;
  launches?: number;
  observedLaunches?: number;
  realisedNetSol?: number;
  modelledNetSol?: number | null;
  observedFraction?: number;
  shrunkMeanNetPerLaunchSol?: number;
  distinguishable?: boolean;
  distinguishabilityNote?: string;
  replay?: ReplayResult;
}

interface StrategyComparison {
  windowStartMs?: number;
  windowEndMs?: number;
  strategies?: ComparisonEntry[];
  sharedObservedLaunches?: number;
  anyDistinguishable?: boolean;
  note?: string;
  caveats?: string[];
}

interface ProjectionResult {
  sufficient?: boolean;
  reason?: string;
  n?: number;
  required?: number;
  months?: number;
  draws?: number;
  observedLaunches?: number;
  expectedLaunches?: number;
  launchesPerMonth?: number;
  cumulativeNetSol?: { p5?: number; p25?: number; p50?: number; p75?: number; p95?: number };
  probabilityNetPositive?: number;
  bootstrapSource?: SkewSummary;
  caveats?: string[];
}

interface SweepPoint {
  value?: number;
  launches?: number;
  observedLaunches?: number;
  realisedNetSol?: number;
  observedFraction?: number;
  shrunkMeanNetPerLaunchSol?: number;
  underpowered?: boolean;
  caveats?: string[];
}

interface SweepResponse {
  parameter?: string;
  results?: SweepPoint[];
}

// --- Static configuration --------------------------------------------------

const RANGES: Array<{ id: RangeKey; label: string }> = [
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: '1y', label: '1 year' },
  { id: 'all', label: 'All time' },
];

type SweepParameter = 'minOpportunityScore' | 'maxSaturationScore' | 'minExpectedValueSol';

const SWEEPS: Record<SweepParameter, { label: string; question: string; values: number[]; format: (v: number) => string }> = {
  minOpportunityScore: {
    label: 'Minimum opportunity score',
    question: 'Would refusing lower-scoring trends have improved returns?',
    values: [40, 45, 50, 58, 65, 72, 80],
    format: (v) => formatScore(v, 0),
  },
  maxSaturationScore: {
    label: 'Maximum saturation score',
    question: 'Would avoiding crowded trends have improved returns?',
    values: [0.2, 0.28, 0.35, 0.45, 0.55, 0.65],
    format: (v) => formatScore(v, 2),
  },
  minExpectedValueSol: {
    label: 'Minimum expected value',
    question: 'Would demanding a higher modelled edge have improved returns?',
    values: [-0.02, -0.01, 0, 0.01, 0.02, 0.05],
    format: (v) => formatSol(v, { digits: 3 }),
  },
};

const CONFIG_ROWS: Array<{ key: keyof StrategyConfig; label: string; format: (value: unknown) => string }> = [
  { key: 'maxLaunchesPerDay', label: 'Launches per day', format: (v) => (typeof v === 'number' ? formatNumber(v) : '—') },
  { key: 'minOpportunityScore', label: 'Min opportunity', format: (v) => (typeof v === 'number' ? formatScore(v, 0) : '—') },
  { key: 'maxSaturationScore', label: 'Max saturation', format: (v) => (typeof v === 'number' ? formatScore(v, 2) : '—') },
  { key: 'minProbabilityTenHolders', label: 'Min P(ten holders)', format: (v) => (typeof v === 'number' ? formatPercent(v, 0) : '—') },
  { key: 'minExpectedValueSol', label: 'Min expected value', format: (v) => (typeof v === 'number' ? formatSol(v, { digits: 3 }) : '—') },
  { key: 'maxTrendAgeHours', label: 'Max trend age', format: (v) => (typeof v === 'number' ? `${formatNumber(v)}h` : '—') },
];

/** Below this many observed launches per side the service refuses to separate strategies. */
const MIN_OBSERVED_FOR_COMPARISON = 10;

/** The presets state their thesis and their risk in one string; split for reading. */
function splitThesis(description: string | undefined): { thesis: string; risk: string | null } {
  if (!description) return { thesis: '', risk: null };
  const index = description.indexOf('Risk:');
  if (index < 0) return { thesis: description, risk: null };
  return {
    thesis: description.slice(0, index).replace(/^Thesis:\s*/, '').trim(),
    risk: description.slice(index + 'Risk:'.length).trim(),
  };
}

// --- Page ------------------------------------------------------------------

export default function StrategyPage() {
  const [range, setRange] = useState<RangeKey>('90d');
  const [sweepParameter, setSweepParameter] = useState<SweepParameter>('minOpportunityScore');

  const presetsQuery = useApiQuery<{ strategies?: StrategyPreset[] }>(queryKeys.strategies, '/api/strategies', {
    refetchInterval: POLL.slow,
  });

  // Compare, project and sweep are read-only computations exposed over POST
  // because they take a body. They are run through mutations rather than
  // queries, and re-run when their inputs change.
  const compare = useApiMutation<StrategyComparison, { range: RangeKey }>('/api/strategies/compare');
  const project = useApiMutation<ProjectionResult, { months: number; draws: number }>('/api/strategies/project');
  const sweep = useApiMutation<SweepResponse, { parameter: SweepParameter; values: number[]; range: RangeKey }>(
    '/api/strategies/sweep',
  );

  const compareRun = compare.mutate;
  const projectRun = project.mutate;
  const sweepRun = sweep.mutate;

  useEffect(() => {
    compareRun({ range });
  }, [compareRun, range]);

  useEffect(() => {
    projectRun({ months: 6, draws: 4000 });
  }, [projectRun]);

  useEffect(() => {
    sweepRun({ parameter: sweepParameter, values: SWEEPS[sweepParameter].values, range });
  }, [sweepRun, sweepParameter, range]);

  const comparison = compare.data;
  const presets = presetsQuery.data?.strategies ?? [];

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Strategy lab"
        description="Replay the launch history under different quality gates. Every figure here is conditional on candidates the live gate already selected, so read the caveats before the table."
        action={<RangeSelector value={range} onChange={setRange} />}
      />

      <LeadingCaveats comparison={comparison} isPending={compare.isPending} />

      <PresetsSection query={presetsQuery} presets={presets} />

      <ComparisonSection
        comparison={comparison}
        isPending={compare.isPending}
        isError={compare.isError}
        error={compare.error}
        onRetry={() => compareRun({ range })}
      />

      <ProjectionSection
        result={project.data}
        isPending={project.isPending}
        isError={project.isError}
        error={project.error}
        onRetry={() => projectRun({ months: 6, draws: 4000 })}
      />

      <SweepSection
        parameter={sweepParameter}
        onParameterChange={setSweepParameter}
        response={sweep.data}
        isPending={sweep.isPending}
        isError={sweep.isError}
        error={sweep.error}
        onRetry={() => sweepRun({ parameter: sweepParameter, values: SWEEPS[sweepParameter].values, range })}
      />
    </div>
  );
}

export { StrategyPage };

function RangeSelector({ value, onChange }: { value: RangeKey; onChange: (next: RangeKey) => void }) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Backtest window">
      {RANGES.map((option) => (
        <button
          key={option.id}
          className={
            'rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ' +
            (value === option.id
              ? 'border-accent-dim bg-accent-dim/40 text-accent-soft'
              : 'border-border text-ink-subtle hover:text-ink')
          }
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// --- 1. Caveats, first ------------------------------------------------------

function LeadingCaveats({ comparison, isPending }: { comparison?: StrategyComparison; isPending: boolean }) {
  const caveats = comparison?.caveats ?? [];
  const shared = comparison?.sharedObservedLaunches ?? 0;

  return (
    <Card>
      <SectionHeader title="Read this before the numbers" />
      <div className="mt-3 space-y-3">
        <Note tone="warning">
          <strong className="font-semibold">Selection bias is unavoidable here. </strong>
          The platform only ever observes what happened to tokens it actually launched. A replayed strategy that would have
          launched something the live gate rejected has no outcome to score — that candidate is counted, not measured. Every
          realised figure below therefore describes a set of launches the live gate chose, and says nothing about the ones it
          turned away.
        </Note>

        {!isPending && (
          <Note tone={shared >= MIN_OBSERVED_FOR_COMPARISON ? 'info' : 'negative'}>
            <strong className="font-semibold">
              {formatNumber(shared)} observed launch{shared === 1 ? '' : 'es'} available to separate the strategies.{' '}
            </strong>
            {shared < MIN_OBSERVED_FOR_COMPARISON
              ? `Below the ${MIN_OBSERVED_FOR_COMPARISON} the service requires on both sides of a comparison, so no ordering in the table below is evidence of anything.`
              : comparison?.note}
          </Note>
        )}

        {caveats.length > 0 && (
          <ul className="space-y-2">
            {caveats.map((caveat, i) => (
              <li key={i} className="flex gap-2 text-xs leading-relaxed text-ink-muted">
                <span aria-hidden="true" className="text-warning">
                  ▸
                </span>
                <span>{caveat}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

// --- 2. Presets -------------------------------------------------------------

interface PresetsQueryLike {
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => unknown;
}

function PresetsSection({ query, presets }: { query: PresetsQueryLike; presets: StrategyPreset[] }) {
  if (query.isLoading) return <LoadingRows rows={3} />;
  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }
  if (presets.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No preset strategies returned"
          description="The backtest service publishes three presets. If none are listed, the service could not build them from the current platform settings."
        />
      </Card>
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      {presets.map((preset, i) => {
        const { thesis, risk } = splitThesis(preset.description);
        return (
          <Card key={preset.name ?? i} className="flex flex-col">
            <h3 className="text-sm font-semibold text-ink">{preset.name ?? 'Unnamed strategy'}</h3>
            <p className="mt-2 text-xs leading-relaxed text-ink-muted">{thesis}</p>
            {risk && (
              <p className="mt-2 rounded-lg border border-warning-dim bg-warning-dim/20 px-2.5 py-2 text-xs leading-relaxed text-warning">
                <span className="font-semibold">Risk: </span>
                {risk}
              </p>
            )}
            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-border pt-3 text-xs">
              {CONFIG_ROWS.map((row) => (
                <div key={String(row.key)} className="contents">
                  <dt className="text-ink-subtle">{row.label}</dt>
                  <dd className="tnum text-right text-ink">{row.format(preset.config?.[row.key])}</dd>
                </div>
              ))}
            </dl>
          </Card>
        );
      })}
    </div>
  );
}

// --- 3. Comparison ----------------------------------------------------------

function ComparisonSection({
  comparison,
  isPending,
  isError,
  error,
  onRetry,
}: {
  comparison?: StrategyComparison;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  const entries = comparison?.strategies ?? [];

  return (
    <Card>
      <SectionHeader
        title="Strategy comparison"
        description="Each preset replayed over the same candidate history."
        action={
          <button className="btn btn-ghost" onClick={onRetry} disabled={isPending}>
            {isPending ? 'Replaying…' : 'Re-run'}
          </button>
        }
      />

      <div className="mt-3 flex flex-wrap gap-4 text-xs">
        <span className="flex items-center gap-1.5 text-positive">
          <span aria-hidden="true">●</span> REALISED — measured on launches that actually happened
        </span>
        <span className="flex items-center gap-1.5 text-info">
          <span aria-hidden="true">◌</span> MODELLED — the model's guess for candidates never launched
        </span>
      </div>

      {isPending ? (
        <LoadingRows rows={4} className="mt-4" />
      ) : isError ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : entries.length === 0 ? (
        <EmptyState
          title="Nothing to replay in this window"
          description="A replay needs candidates with stored predictions. Once the pipeline has scored candidates — launched or not — this table fills in. Widen the window if the platform has been running for longer than the range selected above."
        />
      ) : (
        <>
          <DataTable className="mt-4">
            <thead>
              <tr>
                <Th>Strategy</Th>
                <Th align="right">Would launch</Th>
                <Th align="right">Observed</Th>
                <Th align="right">Realised net</Th>
                <Th align="right">Modelled net</Th>
                <Th align="right">Observed fraction</Th>
                <Th align="right">Shrunk net / launch</Th>
                <Th>Separable?</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => {
                const observed = entry.observedLaunches ?? 0;
                const realised = entry.realisedNetSol ?? 0;
                const modelled = entry.modelledNetSol;
                return (
                  <tr key={entry.name ?? i}>
                    <Td className="text-ink">
                      <div className="font-medium">{entry.name ?? '—'}</div>
                      <div className="tnum text-xs text-ink-subtle">
                        {formatNumber(entry.replay?.candidatesConsidered ?? 0)} candidates considered
                      </div>
                    </Td>
                    <Td align="right" className="tnum">
                      {formatNumber(entry.launches ?? 0)}
                    </Td>
                    <Td align="right">
                      <SampleSize n={observed} minimum={MIN_OBSERVED_FOR_COMPARISON} />
                    </Td>
                    <Td align="right" className="tnum">
                      <span className={realised >= 0 ? 'font-medium text-positive' : 'font-medium text-negative'}>
                        <span aria-hidden="true">●</span> {formatSol(realised, { sign: true })}
                      </span>
                      <div className="text-xs text-ink-subtle">on {formatNumber(observed)} measured</div>
                    </Td>
                    <Td align="right" className="tnum">
                      {modelled === null || modelled === undefined ? (
                        <span className="text-xs italic text-ink-subtle">not modelled</span>
                      ) : (
                        <>
                          <span className="font-medium text-info">
                            <span aria-hidden="true">◌</span> {formatSol(modelled, { sign: true })}
                          </span>
                          <div className="text-xs text-ink-subtle">
                            {formatNumber(entry.replay?.ofWhichUnobserved ?? 0)} never launched
                          </div>
                        </>
                      )}
                    </Td>
                    <Td align="right" className="tnum">
                      {entry.observedFraction === undefined ? '—' : formatPercent(entry.observedFraction, 0)}
                      {entry.replay?.observedFraction?.lower !== undefined &&
                        entry.replay.observedFraction.upper !== undefined && (
                          <div className="text-xs text-ink-subtle">
                            {formatPercent(entry.replay.observedFraction.lower, 0)}–
                            {formatPercent(entry.replay.observedFraction.upper, 0)}
                          </div>
                        )}
                    </Td>
                    <Td align="right" className="tnum">
                      {entry.shrunkMeanNetPerLaunchSol === undefined ? '—' : formatSol(entry.shrunkMeanNetPerLaunchSol, { sign: true })}
                    </Td>
                    <Td className="max-w-sm whitespace-normal">
                      <Badge tone={entry.distinguishable ? 'positive' : 'warning'}>
                        {entry.distinguishable ? '✓ Separable' : '≈ Indistinguishable'}
                      </Badge>
                      <div className="mt-1 text-xs leading-relaxed text-ink-subtle">{entry.distinguishabilityNote}</div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>

          <div className="mt-4 space-y-3">
            {entries.map((entry, i) =>
              entry.replay?.modelled ? (
                <ModelledNote key={entry.name ?? i} name={entry.name ?? 'This strategy'} modelled={entry.replay.modelled} />
              ) : null,
            )}
          </div>
        </>
      )}
    </Card>
  );
}

function ModelledNote({ name, modelled }: { name: string; modelled: ModelledProjection }) {
  return (
    <Note tone="info">
      <strong className="font-semibold">{name} — modelled component. </strong>
      {formatNumber(modelled.unobservedCandidates ?? 0)} candidate(s) this strategy would have launched were never launched, so
      they have no outcome. The {formatSol(modelled.modelledNetSol)} modelled net above is the current model (
      {modelled.modelVersion ?? 'unknown version'}, trained on {formatNumber(modelled.modelTrainedOnOutcomes ?? 0)} outcomes)
      guessing on their behalf — {formatNumber(modelled.scoredCandidates ?? 0)} of them could actually be scored
      {modelled.extrapolated ? ' and the total was scaled up from that subset' : ''}. It is not revenue and must never be added
      to the realised column.
    </Note>
  );
}

// --- 4. Monte Carlo projection ---------------------------------------------

interface FanRow {
  band: string;
  range: [number, number];
  description: string;
}

function ProjectionSection({
  result,
  isPending,
  isError,
  error,
  onRetry,
}: {
  result?: ProjectionResult;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  const quantiles = result?.cumulativeNetSol;

  const fan = useMemo<FanRow[]>(() => {
    if (!quantiles) return [];
    const { p5, p25, p50, p75, p95 } = quantiles;
    if (p5 === undefined || p25 === undefined || p75 === undefined || p95 === undefined) return [];
    return [
      { band: 'p5 – p95', range: [p5, p95], description: '90% of simulated futures land inside this range' },
      { band: 'p25 – p75', range: [p25, p75], description: '50% of simulated futures land inside this range' },
    ].map((row) => ({ ...row, range: row.range as [number, number] }));
  }, [quantiles]);

  const median = quantiles?.p50;

  return (
    <Card>
      <SectionHeader
        title="Monte Carlo projection"
        description="Cumulative net profit over the next six months, simulated by resampling observed launches with replacement. The bootstrap cannot produce an outcome larger than the largest one ever seen, so it understates extreme upside rather than inventing it."
        action={
          <button className="btn btn-ghost" onClick={onRetry} disabled={isPending}>
            {isPending ? 'Simulating…' : 'Re-run'}
          </button>
        }
      />

      {isPending ? (
        <LoadingRows rows={3} className="mt-4" />
      ) : isError ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : !result ? (
        <EmptyState title="No projection yet" description="Run the simulation to project cumulative net profit forward." />
      ) : result.sufficient === false ? (
        <div className="mt-4 space-y-3">
          <Note tone="warning">
            <strong className="font-semibold">Not enough history to project. </strong>
            {result.reason ?? 'The service reported insufficient data.'} It has {formatNumber(result.n ?? 0)} observed launch(es)
            against a minimum of {formatNumber(result.required ?? 0)}. No fan chart is drawn, because a projection from this many
            launches would be a picture of the prior, not a forecast.
          </Note>
          <CaveatList caveats={result.caveats ?? []} />
        </div>
      ) : (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              label="Median cumulative net"
              value={median === undefined ? '—' : formatSol(median, { sign: true })}
              tone={(median ?? 0) >= 0 ? 'positive' : 'negative'}
              hint={`Over ${formatNumber(result.months ?? 0)} month(s), ${formatNumber(result.draws ?? 0)} draws`}
            />
            <StatTile
              label="P(net positive)"
              value={result.probabilityNetPositive === undefined ? '—' : formatPercent(result.probabilityNetPositive, 0)}
              tone={(result.probabilityNetPositive ?? 0) >= 0.5 ? 'positive' : 'warning'}
              hint={<SampleSize n={result.observedLaunches ?? 0} minimum={MIN_OBSERVED_FOR_COMPARISON} />}
            />
            <StatTile
              label="Expected launches"
              value={formatNumber(result.expectedLaunches ?? 0)}
              hint={`${formatScore(result.launchesPerMonth, 1)} per month, from the observed launch rate`}
            />
            <StatTile
              label="Resampled from"
              value={formatNumber(result.bootstrapSource?.n ?? result.observedLaunches ?? 0)}
              hint={`Median ${formatSol(result.bootstrapSource?.medianSol)}, p90 ${formatSol(result.bootstrapSource?.p90Sol)} per launch`}
              tone={(result.bootstrapSource?.n ?? 0) < 30 ? 'warning' : 'neutral'}
            />
          </div>

          {fan.length > 0 && (
            <div className="mt-5">
              <div className="h-52 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={fan} layout="vertical" margin={{ top: 8, right: 24, bottom: 28, left: 8 }} barCategoryGap="30%">
                    <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" horizontal={false} />
                    <XAxis
                      type="number"
                      tick={{ fontSize: 11, fill: 'var(--color-ink-subtle)' }}
                      tickLine={false}
                      axisLine={{ stroke: 'var(--color-border)' }}
                      tickFormatter={(v: number) => formatScore(v, 2)}
                      label={{
                        value: 'Cumulative net profit (SOL)',
                        position: 'insideBottom',
                        offset: -16,
                        fill: 'var(--color-ink-subtle)',
                        fontSize: 11,
                      }}
                    />
                    <YAxis
                      type="category"
                      dataKey="band"
                      width={72}
                      tick={{ fontSize: 11, fill: 'var(--color-ink-subtle)' }}
                      tickLine={false}
                      axisLine={{ stroke: 'var(--color-border)' }}
                    />
                    <Tooltip cursor={{ fill: 'var(--color-surface-hover)' }} content={<FanTooltip />} />
                    <ReferenceLine x={0} stroke="var(--color-ink-subtle)" strokeWidth={1} />
                    {median !== undefined && (
                      <ReferenceLine
                        x={median}
                        stroke="var(--color-accent-soft)"
                        strokeDasharray="4 3"
                        label={{ value: 'median', position: 'top', fill: 'var(--color-accent-soft)', fontSize: 10 }}
                      />
                    )}
                    <Bar dataKey="range" fill="var(--color-accent)" fillOpacity={0.55} radius={3} name="Cumulative net" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
                Bars span the simulated quantiles of cumulative net profit; the dashed line is the median and the solid line is
                break-even. A band that crosses break-even means losing money over the horizon is a routine outcome, not a tail
                risk.
              </p>
            </div>
          )}

          <CaveatList caveats={result.caveats ?? []} className="mt-4" />
        </>
      )}
    </Card>
  );
}

function FanTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload as FanRow | undefined;
  if (!row) return null;
  return (
    <div className="card-raised px-3 py-2 text-xs shadow-lg">
      <div className="font-medium text-ink">{row.band}</div>
      <div className="tnum mt-1 text-accent-soft">
        {formatSol(row.range[0], { sign: true })} to {formatSol(row.range[1], { sign: true })}
      </div>
      <div className="mt-1 text-ink-subtle">{row.description}</div>
    </div>
  );
}

// --- 5. Threshold sweep -----------------------------------------------------

interface SweepChartPoint {
  label: string;
  value: number;
  launches: number;
  realisedNetSol: number;
  observedLaunches: number;
  underpowered: boolean;
}

function SweepSection({
  parameter,
  onParameterChange,
  response,
  isPending,
  isError,
  error,
  onRetry,
}: {
  parameter: SweepParameter;
  onParameterChange: (next: SweepParameter) => void;
  response?: SweepResponse;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  const config = SWEEPS[parameter];
  const points = response?.results ?? [];

  const chartData = useMemo<SweepChartPoint[]>(
    () =>
      points.map((point) => ({
        label: config.format(point.value ?? 0),
        value: point.value ?? 0,
        launches: point.launches ?? 0,
        realisedNetSol: point.realisedNetSol ?? 0,
        observedLaunches: point.observedLaunches ?? 0,
        underpowered: point.underpowered === true,
      })),
    [points, config],
  );

  const underpoweredCount = chartData.filter((p) => p.underpowered).length;

  return (
    <Card>
      <SectionHeader
        title="Threshold sweep"
        description={config.question}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="sweep-parameter">
              Parameter to sweep
            </label>
            <select
              id="sweep-parameter"
              className="input w-auto"
              value={parameter}
              onChange={(e) => onParameterChange(e.target.value as SweepParameter)}
            >
              {(Object.keys(SWEEPS) as SweepParameter[]).map((key) => (
                <option key={key} value={key}>
                  {SWEEPS[key].label}
                </option>
              ))}
            </select>
            <button className="btn btn-ghost" onClick={onRetry} disabled={isPending}>
              {isPending ? 'Sweeping…' : 'Re-run'}
            </button>
          </div>
        }
      />

      {isPending ? (
        <LoadingRows rows={4} className="mt-4" />
      ) : isError ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : chartData.length === 0 ? (
        <EmptyState
          title="No sweep results"
          description="Sweeping needs candidates with stored predictions in the selected window. Once the pipeline has scored candidates, each threshold value is replayed and charted here."
        />
      ) : (
        <>
          {underpoweredCount > 0 && (
            <div className="mt-3">
              <Note tone="warning">
                {underpoweredCount} of {chartData.length} swept values rest on too few observed launches to mean anything. The
                line still moves at those points; it is moving on one or two tokens, not on a trend.
              </Note>
            </div>
          )}

          <div className="mt-4 h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 8, right: 16, bottom: 34, left: 8 }}>
                <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: 'var(--color-ink-subtle)' }}
                  tickLine={false}
                  axisLine={{ stroke: 'var(--color-border)' }}
                  label={{
                    value: config.label,
                    position: 'insideBottom',
                    offset: -18,
                    fill: 'var(--color-ink-subtle)',
                    fontSize: 11,
                  }}
                />
                <YAxis
                  yAxisId="launches"
                  tick={{ fontSize: 11, fill: 'var(--color-ink-subtle)' }}
                  tickLine={false}
                  axisLine={{ stroke: 'var(--color-border)' }}
                  width={44}
                  label={{ value: 'Launches', angle: -90, position: 'insideLeft', fill: 'var(--color-ink-subtle)', fontSize: 11 }}
                />
                <YAxis
                  yAxisId="net"
                  orientation="right"
                  tick={{ fontSize: 11, fill: 'var(--color-ink-subtle)' }}
                  tickLine={false}
                  axisLine={{ stroke: 'var(--color-border)' }}
                  width={56}
                  tickFormatter={(v: number) => formatScore(v, 2)}
                  label={{
                    value: 'Realised net (SOL)',
                    angle: 90,
                    position: 'insideRight',
                    fill: 'var(--color-ink-subtle)',
                    fontSize: 11,
                  }}
                />
                <Tooltip cursor={{ fill: 'var(--color-surface-hover)' }} content={<SweepTooltip parameterLabel={config.label} />} />
                <Legend wrapperStyle={{ fontSize: 11, color: 'var(--color-ink-subtle)' }} />
                <ReferenceLine yAxisId="net" y={0} stroke="var(--color-ink-subtle)" />
                <Bar yAxisId="launches" dataKey="launches" name="Launches" fill="var(--color-accent)" fillOpacity={0.55} radius={[2, 2, 0, 0]} />
                <Line
                  yAxisId="net"
                  type="monotone"
                  dataKey="realisedNetSol"
                  name="Realised net (SOL)"
                  stroke="var(--color-positive)"
                  strokeWidth={2}
                  dot={{ r: 3, fill: 'var(--color-positive)' }}
                  activeDot={{ r: 4 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <DataTable className="mt-4">
            <thead>
              <tr>
                <Th>{config.label}</Th>
                <Th align="right">Would launch</Th>
                <Th align="right">Observed</Th>
                <Th align="right">Realised net</Th>
                <Th align="right">Observed fraction</Th>
                <Th align="right">Shrunk net / launch</Th>
                <Th>Reliability</Th>
              </tr>
            </thead>
            <tbody>
              {points.map((point, i) => {
                const net = point.realisedNetSol ?? 0;
                return (
                  <tr key={`${point.value ?? i}`}>
                    <Td className="tnum text-ink">{config.format(point.value ?? 0)}</Td>
                    <Td align="right" className="tnum">
                      {formatNumber(point.launches ?? 0)}
                    </Td>
                    <Td align="right">
                      <SampleSize n={point.observedLaunches ?? 0} minimum={MIN_OBSERVED_FOR_COMPARISON} />
                    </Td>
                    <Td align="right" className="tnum">
                      <span className={net >= 0 ? 'text-positive' : 'text-negative'}>{formatSol(net, { sign: true })}</span>
                    </Td>
                    <Td align="right" className="tnum">
                      {point.observedFraction === undefined ? '—' : formatPercent(point.observedFraction, 0)}
                    </Td>
                    <Td align="right" className="tnum">
                      {point.shrunkMeanNetPerLaunchSol === undefined
                        ? '—'
                        : formatSol(point.shrunkMeanNetPerLaunchSol, { sign: true })}
                    </Td>
                    <Td>
                      <Badge tone={point.underpowered ? 'warning' : 'positive'}>
                        {point.underpowered ? '⚠ Underpowered' : '✓ Usable'}
                      </Badge>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>

          <CaveatList caveats={points[0]?.caveats ?? []} className="mt-4" />
        </>
      )}
    </Card>
  );
}

function SweepTooltip({ active, payload, parameterLabel }: TooltipProps<number, string> & { parameterLabel: string }) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.payload as SweepChartPoint | undefined;
  if (!point) return null;
  return (
    <div className="card-raised px-3 py-2 text-xs shadow-lg">
      <div className="font-medium text-ink">
        {parameterLabel}: {point.label}
      </div>
      <div className="tnum mt-1 text-accent-soft">{formatNumber(point.launches)} launches</div>
      <div className={'tnum ' + (point.realisedNetSol >= 0 ? 'text-positive' : 'text-negative')}>
        Realised net {formatSol(point.realisedNetSol, { sign: true })}
      </div>
      <div className="mt-1">
        <SampleSize n={point.observedLaunches} minimum={MIN_OBSERVED_FOR_COMPARISON} />
        {point.underpowered && <span className="ml-1.5 text-warning">underpowered</span>}
      </div>
    </div>
  );
}

// --- Shared -----------------------------------------------------------------

function CaveatList({ caveats, className }: { caveats: string[]; className?: string }) {
  if (caveats.length === 0) return null;
  return (
    <ul className={'space-y-1.5 ' + (className ?? '')}>
      {caveats.map((caveat, i) => (
        <li key={i} className="flex gap-2 text-xs leading-relaxed text-ink-subtle">
          <span aria-hidden="true">▸</span>
          <span>{caveat}</span>
        </li>
      ))}
    </ul>
  );
}
