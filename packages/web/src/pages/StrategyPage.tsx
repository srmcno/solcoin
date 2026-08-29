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
import { formatNumber, formatPercent, formatScore, formatSol } from '@/lib/format';
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
  /** Null — not zero — when no unobserved candidate carried a usable feature vector. */
  modelledFeesSol?: number | null;
  modelledMedianFeesSol?: number | null;
  modelledCostSol?: number;
  modelledNetSol?: number | null;
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
  /** Candidates the strategy accepted but whose approval a human would have gated. */
  wouldHaveRequiredHumanReview?: number;
  /** Candidates in the window with no stored prediction; not replayable at all. */
  candidatesWithoutStoredPrediction?: number;
  /** Gate checks skipped because the stored feature vector lacked the input. */
  unevaluableChecks?: Record<string, number>;
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
  /** The unshrunk per-launch mean actually observed. Null when nothing was. */
  rawMeanNetPerLaunchSol?: number | null;
  /** Shrunk toward the all-launch mean. Null with no observed launches. */
  shrunkMeanNetPerLaunchSol?: number | null;
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
  /**
   * Which launches the per-launch outcomes were resampled from. 'all-observed'
   * means this strategy's own selections were too thin to stand alone, so the
   * projection reflects its launch *rate* and says nothing about its picks.
   */
  bootstrapPopulation?: 'strategy' | 'all-observed' | string;
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
  /** The unshrunk per-launch mean actually observed at this point. */
  rawMeanNetPerLaunchSol?: number | null;
  /** Shrunk toward the global mean; null where no launch was observed. */
  shrunkMeanNetPerLaunchSol?: number | null;
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

        {!isPending && comparison && (
          <Note
            tone={
              shared < MIN_OBSERVED_FOR_COMPARISON ? 'negative' : comparison.anyDistinguishable === true ? 'info' : 'warning'
            }
          >
            <strong className="font-semibold">
              {formatNumber(shared)} observed launch{shared === 1 ? '' : 'es'} available to separate the strategies.{' '}
              {shared >= MIN_OBSERVED_FOR_COMPARISON &&
                (comparison.anyDistinguishable === true
                  ? 'At least one pair is separable. '
                  : 'No pair is separable. ')}
            </strong>
            {shared < MIN_OBSERVED_FOR_COMPARISON
              ? `Below the ${MIN_OBSERVED_FOR_COMPARISON} the service requires on both sides of a comparison, so no ordering in the table below is evidence of anything.`
              : (comparison.note ?? '')}
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
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
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
                <Th align="right">Net / launch (raw · shrunk)</Th>
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
                    {/* With nothing observed the service returns 0, meaning
                        "nothing was measured" — but a green +0.00 SOL reads as
                        "broke even", which is a result this strategy never
                        produced. Zero observations gets a word, not a number. */}
                    <Td align="right" className="tnum">
                      {observed === 0 ? (
                        <span className="text-xs italic text-ink-subtle">nothing measured</span>
                      ) : (
                        <span className={realised >= 0 ? 'font-medium text-positive' : 'font-medium text-negative'}>
                          <span aria-hidden="true">●</span> {formatSol(realised, { sign: true })}
                        </span>
                      )}
                      <div className="text-xs text-ink-subtle">
                        {observed === 0
                          ? `${formatNumber(entry.launches ?? 0)} selected, none launched`
                          : `on ${formatNumber(observed)} measured`}
                      </div>
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
                    {/* The service returns the raw mean specifically so it can sit
                        beside the shrunk one: over few launches shrinkage pulls a
                        losing cell positive, and the two disagreeing in sign is
                        the signal that the sample says nothing. Showing the
                        shrunk figure alone hides exactly that. */}
                    <Td align="right" className="tnum min-w-[9rem]">
                      <div className="text-ink">
                        {entry.rawMeanNetPerLaunchSol === null || entry.rawMeanNetPerLaunchSol === undefined ? (
                          <span className="text-xs italic text-ink-subtle">never measured</span>
                        ) : (
                          formatSol(entry.rawMeanNetPerLaunchSol, { sign: true })
                        )}
                      </div>
                      <div className="text-xs text-ink-subtle">
                        {entry.shrunkMeanNetPerLaunchSol === null || entry.shrunkMeanNetPerLaunchSol === undefined
                          ? 'no shrunk estimate'
                          : `shrunk ${formatSol(entry.shrunkMeanNetPerLaunchSol, { sign: true })}`}
                      </div>
                      {signsDisagree(entry.rawMeanNetPerLaunchSol, entry.shrunkMeanNetPerLaunchSol) && (
                        <div className="whitespace-normal text-xs leading-tight text-warning">
                          ⚠ raw and shrunk disagree in sign — the estimate is mostly the prior
                        </div>
                      )}
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

          <div className="mt-4 space-y-4">
            {entries.map((entry, i) => (
              <StrategyFootnotes key={entry.name ?? i} entry={entry} />
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

/** True when a shrunk estimate has been pulled across zero from what was measured. */
function signsDisagree(raw: number | null | undefined, shrunk: number | null | undefined): boolean {
  if (typeof raw !== 'number' || typeof shrunk !== 'number') return false;
  if (!Number.isFinite(raw) || !Number.isFinite(shrunk)) return false;
  return (raw < 0 && shrunk > 0) || (raw > 0 && shrunk < 0);
}

/**
 * Everything the replay recorded about *how* a row was produced: the candidates
 * it could not replay at all, the checks it could not evaluate, the approvals it
 * had to assume, and the service's own caveats for this strategy. The row above
 * is a number; this is what the number is conditional on.
 */
function StrategyFootnotes({ entry }: { entry: ComparisonEntry }) {
  const replay = entry.replay;
  if (!replay) return null;
  const name = entry.name ?? 'This strategy';
  const unreplayable = replay.candidatesWithoutStoredPrediction ?? 0;
  const humanReview = replay.wouldHaveRequiredHumanReview ?? 0;
  const unevaluable = Object.entries(replay.unevaluableChecks ?? {}).filter(([, count]) => count > 0);
  const caveats = replay.caveats ?? [];

  if (!replay.modelled && unreplayable === 0 && humanReview === 0 && unevaluable.length === 0 && caveats.length === 0) {
    return null;
  }

  return (
    <div className="rounded-xl border border-border bg-surface-raised p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">{name} — how this row was produced</h3>

      {replay.modelled && (
        <div className="mt-2">
          <ModelledNote name={name} modelled={replay.modelled} />
        </div>
      )}

      <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-ink-muted">
        {unreplayable > 0 && (
          <li className="flex gap-2">
            <span aria-hidden="true" className="text-warning">
              ▸
            </span>
            <span>
              <span className="tnum">{formatNumber(unreplayable)}</span> candidate(s) in this window carry no stored prediction
              and could not be replayed at all. They are outside every figure on this row — neither accepted nor rejected by it.
            </span>
          </li>
        )}
        {humanReview > 0 && (
          <li className="flex gap-2">
            <span aria-hidden="true" className="text-warning">
              ▸
            </span>
            <span>
              <span className="tnum">{formatNumber(humanReview)}</span> selected candidate(s) carried a risk flag and would have
              been held for human approval. They are counted as launched here, because inventing a human's decision would be
              worse than stating the ambiguity.
            </span>
          </li>
        )}
        {unevaluable.map(([check, count]) => (
          <li key={check} className="flex gap-2">
            <span aria-hidden="true" className="text-warning">
              ▸
            </span>
            <span>
              The <span className="font-medium">{check}</span> check was skipped on{' '}
              <span className="tnum">{formatNumber(count)}</span> candidate(s): the stored feature vector did not carry its
              input, so the gate passed them without ever testing them.
            </span>
          </li>
        ))}
        {caveats.map((caveat, i) => (
          <li key={`caveat-${i}`} className="flex gap-2">
            <span aria-hidden="true" className="text-warning">
              ▸
            </span>
            <span>{caveat}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ModelledNote({ name, modelled }: { name: string; modelled: ModelledProjection }) {
  // Null net means the model could not form a feature vector for any of them —
  // a different statement from "the model expects nothing", which is what a
  // zero in this position would say.
  const net = modelled.modelledNetSol;
  const unscored = (modelled.unobservedCandidates ?? 0) - (modelled.scoredCandidates ?? 0);

  return (
    <>
      <Note tone="info">
        <strong className="font-semibold">{name} — modelled component. </strong>
        {formatNumber(modelled.unobservedCandidates ?? 0)} candidate(s) this strategy would have launched were never launched, so
        they have no outcome.{' '}
        {net === null || net === undefined ? (
          <>
            The model could not form a usable feature vector for any of them, so there is no modelled net at all — not a
            modelled net of zero.
          </>
        ) : (
          <>
            The {formatSol(net)} modelled net above is the current model ({modelled.modelVersion ?? 'unknown version'}, trained
            on {formatNumber(modelled.modelTrainedOnOutcomes ?? 0)} outcomes) guessing on their behalf —{' '}
            {formatNumber(modelled.scoredCandidates ?? 0)} of them could actually be scored
            {unscored > 0 ? ` and ${formatNumber(unscored)} could not` : ''}
            {modelled.extrapolated ? ', and the total was scaled up from that scored subset' : ''}. It is not revenue and must
            never be added to the realised column.
          </>
        )}
      </Note>
      <CaveatList caveats={modelled.caveats ?? []} className="mt-2" />
    </>
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
    const { p5, p25, p75, p95 } = quantiles;
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
          {/* 'all-observed' means the strategy's own picks were too thin to
              resample, so the fan below describes the platform's launch history
              at this strategy's launch *rate* — it says nothing about whether
              this strategy picks better tokens. Not saying so would let the
              chart be read as a forecast of the strategy. */}
          {result.bootstrapPopulation === 'all-observed' && (
            <div className="mt-3">
              <Note tone="warning">
                <strong className="font-semibold">Resampled from every observed launch, not this strategy's. </strong>
                This strategy's own selections had too few realised outcomes to resample, so the simulation draws from the
                platform's whole realised history instead. The projection therefore reflects only how often this strategy would
                launch — it carries no information about the quality of the candidates it picks.
              </Note>
            </div>
          )}
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
              hint={`${
                result.bootstrapPopulation === 'all-observed'
                  ? 'Every observed launch, not this strategy’s. '
                  : result.bootstrapPopulation === 'strategy'
                    ? 'This strategy’s own selections. '
                    : ''
              }Median ${formatSol(result.bootstrapSource?.medianSol)}, p90 ${formatSol(result.bootstrapSource?.p90Sol)} per launch`}
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
  /**
   * Null — not zero — at a threshold that produced no observed launch. Recharts
   * breaks the line at a null, which is the honest picture: the series has no
   * value there. A zero would draw a point on the break-even axis and read as
   * "this threshold broke even", a result that was never measured.
   */
  realisedNetSol: number | null;
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
  const points = useMemo(() => response?.results ?? [], [response]);

  const chartData = useMemo<SweepChartPoint[]>(
    () =>
      points.map((point) => ({
        label: config.format(point.value ?? 0),
        value: point.value ?? 0,
        launches: point.launches ?? 0,
        realisedNetSol: (point.observedLaunches ?? 0) > 0 ? (point.realisedNetSol ?? null) : null,
        observedLaunches: point.observedLaunches ?? 0,
        underpowered: point.underpowered === true,
      })),
    [points, config],
  );

  const underpoweredCount = chartData.filter((p) => p.underpowered).length;

  // Union of every point's caveats, in first-seen order and de-duplicated.
  const sweepCaveats = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const point of points) {
      for (const caveat of point.caveats ?? []) {
        if (seen.has(caveat)) continue;
        seen.add(caveat);
        out.push(caveat);
      }
    }
    return out;
  }, [points]);

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
                {underpoweredCount} of {chartData.length} swept values rest on too few observed launches to mean anything, and
                are drawn as hollow points below. The line still moves through them; it is moving on one or two tokens, not on a
                trend.
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
                  dot={<SweepDot />}
                  activeDot={{ r: 5 }}
                  // A threshold with no observed launch has no realised net. The
                  // line breaks there rather than being drawn through a zero.
                  connectNulls={false}
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
                <Th align="right">Net / launch (raw · shrunk)</Th>
                <Th>Reliability</Th>
              </tr>
            </thead>
            <tbody>
              {points.map((point, i) => {
                const observedHere = point.observedLaunches ?? 0;
                const net = point.realisedNetSol ?? 0;
                return (
                  <tr key={`${point.value ?? i}`}>
                    <Td className="tnum text-ink">{config.format(point.value ?? 0)}</Td>
                    <Td align="right" className="tnum">
                      {formatNumber(point.launches ?? 0)}
                    </Td>
                    <Td align="right">
                      <SampleSize n={observedHere} minimum={MIN_OBSERVED_FOR_COMPARISON} />
                    </Td>
                    {/* Zero observed launches makes realised net 0 by definition.
                        Printing it as a signed SOL figure claims a break-even
                        result at this threshold that was never measured. */}
                    <Td align="right" className="tnum">
                      {observedHere === 0 ? (
                        <span className="text-xs italic text-ink-subtle">nothing measured</span>
                      ) : (
                        <span className={net >= 0 ? 'text-positive' : 'text-negative'}>{formatSol(net, { sign: true })}</span>
                      )}
                    </Td>
                    <Td align="right" className="tnum">
                      {point.observedFraction === undefined ? '—' : formatPercent(point.observedFraction, 0)}
                    </Td>
                    <Td align="right" className="tnum min-w-[9rem]">
                      <div className="text-ink">
                        {point.rawMeanNetPerLaunchSol === null || point.rawMeanNetPerLaunchSol === undefined ? (
                          <span className="text-xs italic text-ink-subtle">never measured</span>
                        ) : (
                          formatSol(point.rawMeanNetPerLaunchSol, { sign: true })
                        )}
                      </div>
                      <div className="text-xs text-ink-subtle">
                        {point.shrunkMeanNetPerLaunchSol === null || point.shrunkMeanNetPerLaunchSol === undefined
                          ? 'no shrunk estimate'
                          : `shrunk ${formatSol(point.shrunkMeanNetPerLaunchSol, { sign: true })}`}
                      </div>
                      {signsDisagree(point.rawMeanNetPerLaunchSol, point.shrunkMeanNetPerLaunchSol) && (
                        <div className="whitespace-normal text-xs leading-tight text-warning">
                          ⚠ raw and shrunk disagree in sign
                        </div>
                      )}
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

          {/* Each swept point carries its own caveats and they are not identical:
              a threshold that selected nothing says something a well-populated
              one does not. Reading only the first point's would drop those. */}
          <CaveatList caveats={sweepCaveats} className="mt-4" />
        </>
      )}
    </Card>
  );
}

/**
 * An underpowered point is drawn hollow. The aggregate warning above the chart
 * says how many there are; this says *which*, so a reader cannot follow the line
 * through a value that rests on one token without seeing that it does.
 */
function SweepDot(props: { cx?: number; cy?: number; payload?: SweepChartPoint }) {
  const { cx, cy, payload } = props;
  if (cx === undefined || cy === undefined) return null;
  // No realised net at this threshold: no point to draw.
  if (payload?.realisedNetSol === null || payload?.realisedNetSol === undefined) return null;
  const underpowered = payload?.underpowered === true;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={underpowered ? 3.5 : 3}
      fill={underpowered ? 'var(--color-surface)' : 'var(--color-positive)'}
      stroke="var(--color-positive)"
      strokeWidth={underpowered ? 1.5 : 1}
      strokeDasharray={underpowered ? '2 1.5' : undefined}
    />
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
      {point.realisedNetSol === null ? (
        <div className="text-ink-subtle">No launch at this threshold was ever observed — nothing to measure.</div>
      ) : (
        <div className={'tnum ' + (point.realisedNetSol >= 0 ? 'text-positive' : 'text-negative')}>
          Realised net {formatSol(point.realisedNetSol, { sign: true })}
        </div>
      )}
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
