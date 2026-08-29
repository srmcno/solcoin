import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  ErrorBar,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
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
  ScoreBar,
  SectionHeader,
  StatTile,
  Tabs,
  Td,
  Th,
  type Tone,
} from '@/components/ui';
import { formatDateTime, formatNumber, formatPercent, formatRelative, formatScore, formatSol, humanise, truncateAddress } from '@/lib/format';
import { POLL, queryKeys, useApiMutation, useApiQuery } from '@/lib/queries';
import { useSession } from '@/lib/session';

// --- API shapes ------------------------------------------------------------
// The learning service deliberately returns nulls rather than zeros where it
// has nothing to report ("log loss 0" reads as perfect, which is the opposite
// of "never scored"), so every field here is optional and every null is a
// distinct state from a number.

interface HeadMetrics {
  n?: number;
  positives?: number;
  logLoss?: number | null;
  brier?: number | null;
  auc?: number | null;
  meanPredicted?: number | null;
  observedRate?: number | null;
  reliable?: boolean;
}

interface CalibrationBin {
  binLower?: number;
  binUpper?: number;
  n?: number;
  predicted?: number | null;
  observed?: number | null;
  observedLower?: number | null;
  observedUpper?: number | null;
}

interface HeadCalibration extends HeadMetrics {
  head?: string;
  observedLower?: number | null;
  observedUpper?: number | null;
  verdict?: string;
  explanation?: string;
  bins?: CalibrationBin[];
}

interface CalibrationReport {
  modelVersion?: string;
  generatedAt?: number;
  n?: number;
  heads?: HeadCalibration[];
  note?: string;
  caveats?: string[];
}

interface ObservedRate {
  rate?: number;
  lower?: number;
  upper?: number;
  n?: number;
  observedN?: number;
  successes?: number;
  priorPseudoCount?: number;
  sufficient?: boolean;
  source?: 'observed' | 'prior' | string;
}

interface ObservedBaseRates {
  first_buy?: ObservedRate;
  ten_holders?: ObservedRate;
  hundred_holders?: ObservedRate;
  graduation?: ObservedRate;
  n?: number;
  sufficient?: boolean;
  reason?: string;
  caveats?: string[];
}

interface WeightShift {
  head?: string;
  feature?: string;
  label?: string;
  before?: number;
  after?: number;
  delta?: number;
  reading?: string;
}

interface SkewedSummary {
  n?: number;
  mean?: number;
  median?: number;
  p10?: number;
  p90?: number;
  max?: number;
  topDecileShare?: number;
  reliable?: boolean;
}

interface RevenueAccuracy {
  n?: number;
  actualFeesSol?: SkewedSummary | null;
  predictedFeesSol?: SkewedSummary | null;
  medianErrorSol?: number | null;
  medianAbsoluteErrorSol?: number | null;
  reliable?: boolean;
  note?: string;
}

interface LearningSummary {
  modelVersion?: string;
  modelCreatedAt?: number;
  trainedOn?: number;
  outcomes?: {
    total?: number;
    applied?: number;
    pending?: number;
    byHorizon?: Array<{ horizonHours?: number; n?: number }>;
    labelledLaunches?: number;
  };
  calibration?: Array<{ head?: string; n?: number; verdict?: string; explanation?: string }>;
  baseRates?: ObservedBaseRates;
  revenue?: RevenueAccuracy;
  movedWeights?: WeightShift[];
  caveats?: string[];
  trust?: string;
}

interface ModelVersionRow {
  id?: string;
  version?: string;
  kind?: string;
  trained_on?: number;
  metrics?: string | null;
  notes?: string | null;
  active?: number;
  created_at?: number;
}

interface LearningResponse {
  summary?: LearningSummary;
  calibration?: CalibrationReport;
  baseRates?: ObservedBaseRates;
  models?: ModelVersionRow[];
}

interface PredictionErrorRow {
  predictionId?: string;
  outcomeId?: string;
  conceptId?: string | null;
  tokenMint?: string | null;
  name?: string | null;
  symbol?: string | null;
  modelVersion?: string;
  predictedAt?: number;
  horizonHours?: number;
  predicted?: Record<string, number | undefined>;
  actual?: Record<string, 0 | 1 | null | undefined>;
  signedError?: Record<string, number | null | undefined>;
  expectedCreatorFeesSol?: number;
  actualCreatorFeesSol?: number | null;
  creatorFeesErrorSol?: number | null;
  expectedVolume24hSol?: number;
  actualVolume24hSol?: number | null;
  peakHolders?: number | null;
  explanation?: string;
}

interface BundleMetrics {
  samples?: number;
  labelledPairs?: number;
  meanLogLoss?: number | null;
  byHead?: Record<string, HeadMetrics | undefined>;
}

interface TrainingResult {
  trained?: boolean;
  version?: string;
  samples?: number;
  metricsBefore?: BundleMetrics | null;
  metricsAfter?: BundleMetrics | null;
  activated?: boolean;
  reason?: string;
}

// --- Static configuration --------------------------------------------------

const HEADS = ['first_buy', 'ten_holders', 'hundred_holders', 'graduation'] as const;
type HeadKey = (typeof HEADS)[number];

const HEAD_LABEL: Record<string, string> = {
  first_buy: 'First buy',
  ten_holders: 'Ten holders',
  hundred_holders: 'Hundred holders',
  graduation: 'Graduation',
};

const HEAD_MEANING: Record<string, string> = {
  first_buy: 'At least one organic buyer arrived.',
  ten_holders: 'The token reached ten distinct holders.',
  hundred_holders: 'The token reached a hundred distinct holders.',
  graduation: 'The token completed its bonding curve.',
};

const VERDICT_TONE: Record<string, Tone> = {
  'well calibrated': 'positive',
  overconfident: 'negative',
  underconfident: 'warning',
  'insufficient data': 'neutral',
};

/** A verdict needs this many labelled launches server-side; mirrored for markers. */
const MIN_VERDICT_SAMPLES = 20;

function headLabel(head: string | undefined): string {
  if (!head) return '—';
  return HEAD_LABEL[head] ?? humanise(head);
}

// --- Page ------------------------------------------------------------------

export default function LearningPage() {
  const { can } = useSession();
  const [head, setHead] = useState<HeadKey>('first_buy');

  const learningQuery = useApiQuery<LearningResponse>(queryKeys.learning, '/api/learning', {
    refetchInterval: POLL.slow,
  });
  const errorsQuery = useApiQuery<{ errors?: PredictionErrorRow[] }>(
    queryKeys.learningErrors,
    '/api/learning/errors?limit=50',
    { refetchInterval: POLL.slow },
  );
  const train = useApiMutation<TrainingResult, undefined>('/api/learning/train', {
    invalidate: [queryKeys.learning, queryKeys.learningErrors],
  });

  const summary = learningQuery.data?.summary;
  const calibration = learningQuery.data?.calibration;
  const baseRates = learningQuery.data?.baseRates ?? summary?.baseRates;
  const models = learningQuery.data?.models ?? [];
  const trainedOn = summary?.trainedOn ?? 0;
  const labelledLaunches = summary?.outcomes?.labelledLaunches ?? 0;

  const headTabs = useMemo(
    () =>
      HEADS.map((id) => ({
        id,
        label: HEAD_LABEL[id] ?? id,
        count: calibration?.heads?.find((h) => h.head === id)?.n ?? 0,
      })),
    [calibration],
  );

  if (learningQuery.isLoading) {
    return (
      <div className="space-y-4">
        <SectionHeader title="AI learning" description="What the model has learned from real outcomes, and how much of it to believe." />
        <LoadingRows rows={7} />
      </div>
    );
  }

  if (learningQuery.isError) {
    return (
      <div className="space-y-4">
        <SectionHeader title="AI learning" />
        <Card>
          <ErrorState error={learningQuery.error} onRetry={() => void learningQuery.refetch()} />
        </Card>
      </div>
    );
  }

  const nothingLearned = trainedOn === 0 && labelledLaunches === 0 && (calibration?.n ?? 0) === 0;

  return (
    <div className="space-y-4">
      <SectionHeader
        title="AI learning"
        description="The model publishes a probability before every launch and is scored against what actually happened. This page is that scorecard, including the parts that say the model does not yet know anything."
        action={
          can('manage_experiments') ? (
            <button className="btn btn-primary" onClick={() => train.mutate(undefined)} disabled={train.isPending}>
              {train.isPending ? 'Training…' : 'Train now'}
            </button>
          ) : undefined
        }
      />

      <TrustPanel summary={summary} calibrationN={calibration?.n ?? 0} />

      {train.isError && (
        <Note tone="negative">Training failed: {train.error instanceof Error ? train.error.message : 'unknown error'}</Note>
      )}
      {train.data && <TrainingOutcome result={train.data} />}

      {nothingLearned ? (
        <Card>
          <EmptyState
            icon="◐"
            title="The model has not learned from anything yet"
            description={
              <>
                Nothing on this page is hidden — there is genuinely no evidence yet. Predictions are recorded at launch and
                labelled once their outcome window closes (24, 72 and 168 hours). Once the platform has confirmed launches and
                those windows have elapsed, calibration, base rates and the prediction-versus-reality table fill in on their own.
                Until then the model is running on hand-set domain priors.
              </>
            }
          />
        </Card>
      ) : null}

      <CalibrationSection
        report={calibration}
        head={head}
        onHeadChange={setHead}
        tabs={headTabs}
        isLoading={learningQuery.isLoading}
      />

      <BaseRatesSection rates={baseRates} />

      <WeightsSection shifts={summary?.movedWeights ?? []} trainedOn={trainedOn} />

      <RevenueSection revenue={summary?.revenue} />

      <ErrorsSection query={errorsQuery} />

      <ModelVersionsSection models={models} />

      {summary?.caveats && summary.caveats.length > 0 && (
        <Card>
          <SectionHeader title="What limits every number above" />
          <ul className="mt-3 space-y-2">
            {summary.caveats.map((caveat, i) => (
              <li key={i} className="flex gap-2 text-xs leading-relaxed text-ink-muted">
                <span aria-hidden="true" className="text-ink-subtle">
                  ▸
                </span>
                <span>{caveat}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

export { LearningPage };

// --- 1. Trust --------------------------------------------------------------

function TrustPanel({ summary, calibrationN }: { summary?: LearningSummary; calibrationN: number }) {
  const trainedOn = summary?.trainedOn ?? 0;
  const outcomes = summary?.outcomes;

  // The tone of the whole page follows this number. A confident-looking
  // dashboard over four launches would be actively misleading, so the loudest
  // element on the page is the warning when the sample is thin.
  const tone: Tone = trainedOn === 0 ? 'negative' : trainedOn < 30 ? 'warning' : trainedOn < 150 ? 'info' : 'positive';
  const headline =
    trainedOn === 0
      ? 'Untrained — every probability is a hand-set prior'
      : trainedOn < 30
        ? 'Barely trained — treat every probability as a prior that has been nudged'
        : trainedOn < 150
          ? 'Partially trained — common outcomes measured, rare ones still assumed'
          : 'Trained on a usable sample';

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={tone}>{headline}</Badge>
              <span className="tnum text-xs text-ink-subtle">
                model {summary?.modelVersion ?? '—'} · built {formatRelative(summary?.modelCreatedAt)}
              </span>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-muted">
              {summary?.trust ?? 'The learning service has not returned a trust statement.'}
            </p>
          </div>
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Outcomes learned from"
          value={formatNumber(trainedOn)}
          tone={tone === 'positive' ? 'positive' : tone === 'negative' ? 'negative' : 'warning'}
          hint={
            trainedOn === 0
              ? 'No real outcome has been folded into the model.'
              : `Folded into the active bundle. ${formatNumber(outcomes?.pending ?? 0)} labelled outcome(s) still pending.`
          }
        />
        <StatTile
          label="Labelled launches"
          value={formatNumber(outcomes?.labelledLaunches ?? 0)}
          hint={`${formatNumber(outcomes?.total ?? 0)} outcome row(s) across all horizons; each launch contributes once, at its longest elapsed horizon.`}
        />
        <StatTile
          label="Launches scored"
          value={formatNumber(calibrationN)}
          hint={
            calibrationN < MIN_VERDICT_SAMPLES
              ? `Below the ${MIN_VERDICT_SAMPLES} needed for any calibration verdict.`
              : 'Launches with both a stored prediction and a measured outcome.'
          }
          tone={calibrationN < MIN_VERDICT_SAMPLES ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Outcome horizons"
          value={
            outcomes?.byHorizon && outcomes.byHorizon.length > 0
              ? outcomes.byHorizon.map((h) => `${h.horizonHours ?? '?'}h`).join(' · ')
              : '—'
          }
          hint={
            outcomes?.byHorizon && outcomes.byHorizon.length > 0
              ? outcomes.byHorizon.map((h) => `${h.horizonHours ?? '?'}h: ${formatNumber(h.n ?? 0)}`).join(', ')
              : 'No outcome window has closed yet.'
          }
        />
      </div>
    </div>
  );
}

function TrainingOutcome({ result }: { result: TrainingResult }) {
  const before = result.metricsBefore?.meanLogLoss ?? null;
  const after = result.metricsAfter?.meanLogLoss ?? null;
  const improved = before !== null && after !== null ? after < before : null;

  return (
    <Card>
      <SectionHeader
        title="Last training run"
        description="A new bundle is only activated when it does not degrade held-out calibration. A rejected model is the system working, not a failure."
        action={
          <Badge tone={result.activated ? 'positive' : 'warning'}>
            {result.activated ? '✓ Activated' : '✕ Not activated'}
          </Badge>
        }
      />
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <MetricSwatch label="Mean log loss before" value={before === null ? '—' : formatScore(before, 4)} tone="neutral" />
        <MetricSwatch
          label="Mean log loss after"
          value={after === null ? '—' : formatScore(after, 4)}
          tone={improved === null ? 'neutral' : improved ? 'positive' : 'negative'}
          hint={improved === null ? 'Not measurable' : improved ? 'Lower is better — improved' : 'Lower is better — degraded'}
        />
        <MetricSwatch
          label="Samples"
          value={formatNumber(result.samples ?? 0)}
          tone="neutral"
          hint={`${formatNumber(result.metricsAfter?.labelledPairs ?? 0)} labelled (head, launch) pairs scored`}
        />
      </div>
      <p className="mt-3 text-sm leading-relaxed text-ink-muted">{result.reason ?? 'No reason was returned.'}</p>
      {result.version && <p className="tnum mt-1 text-xs text-ink-subtle">Candidate version {result.version}</p>}
    </Card>
  );
}

function MetricSwatch({ label, value, tone, hint }: { label: string; value: string; tone: Tone; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised px-3 py-2.5">
      <div className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{label}</div>
      <div
        className={
          'tnum mt-1 text-lg font-semibold ' +
          (tone === 'positive' ? 'text-positive' : tone === 'negative' ? 'text-negative' : 'text-ink')
        }
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-ink-subtle">{hint}</div>}
    </div>
  );
}

// --- 2. Calibration --------------------------------------------------------

function CalibrationSection({
  report,
  head,
  onHeadChange,
  tabs,
  isLoading,
}: {
  report?: CalibrationReport;
  head: HeadKey;
  onHeadChange: (id: HeadKey) => void;
  tabs: Array<{ id: HeadKey; label: string; count?: number }>;
  isLoading: boolean;
}) {
  const heads = report?.heads ?? [];
  const selected = heads.find((h) => h.head === head);

  return (
    <Card>
      <SectionHeader
        title="Calibration"
        description="A well-calibrated model that says 30% is right 30% of the time. Log loss and Brier score are penalties — lower is better. AUC is ranking ability: 0.5 is a coin flip and is reported as null when only one class has been observed."
      />

      {isLoading ? (
        <LoadingRows rows={4} className="mt-4" />
      ) : heads.length === 0 ? (
        <EmptyState
          title="Nothing to calibrate against yet"
          description={report?.note ?? 'No launch has both a stored prediction and a measured outcome.'}
        />
      ) : (
        <>
          <DataTable className="mt-4">
            <thead>
              <tr>
                <Th>Prediction head</Th>
                <Th align="right">n</Th>
                <Th align="right">Positives</Th>
                <Th align="right">Log loss</Th>
                <Th align="right">Brier</Th>
                <Th align="right">AUC</Th>
                <Th align="right">Predicted</Th>
                <Th align="right">Observed</Th>
                <Th>Verdict</Th>
              </tr>
            </thead>
            <tbody>
              {heads.map((h, headIndex) => {
                const n = h.n ?? 0;
                const verdict = h.verdict ?? 'insufficient data';
                // The service sets `reliable: false` below its verdict threshold:
                // the numbers on the row are printable, not evidence. Saying so
                // on the row matters more than the row itself.
                const unreliable = h.reliable === false;
                return (
                  <tr key={h.head ?? `head-${headIndex}`}>
                    <Td className="text-ink">
                      <div className="font-medium">{headLabel(h.head)}</div>
                      <div className="text-xs text-ink-subtle">{HEAD_MEANING[h.head ?? ''] ?? ''}</div>
                    </Td>
                    <Td align="right">
                      <SampleSize n={n} minimum={MIN_VERDICT_SAMPLES} />
                    </Td>
                    <Td align="right" className="tnum">
                      {formatNumber(h.positives ?? 0)}
                    </Td>
                    <Td align="right" className="tnum">
                      {h.logLoss === null || h.logLoss === undefined ? <NotScored /> : formatScore(h.logLoss, 4)}
                    </Td>
                    <Td align="right" className="tnum">
                      {h.brier === null || h.brier === undefined ? <NotScored /> : formatScore(h.brier, 4)}
                    </Td>
                    <Td align="right" className="tnum">
                      {h.auc === null || h.auc === undefined ? <NotScored label="undefined" /> : formatScore(h.auc, 3)}
                    </Td>
                    <Td align="right" className="tnum">
                      {h.meanPredicted === null || h.meanPredicted === undefined ? '—' : formatPercent(h.meanPredicted, 1)}
                    </Td>
                    <Td align="right" className="tnum">
                      {h.observedRate === null || h.observedRate === undefined ? (
                        '—'
                      ) : (
                        <>
                          {formatPercent(h.observedRate, 1)}
                          {h.observedLower !== null &&
                          h.observedLower !== undefined &&
                          h.observedUpper !== null &&
                          h.observedUpper !== undefined ? (
                            <div className="text-xs text-ink-subtle">
                              {formatPercent(h.observedLower, 0)}–{formatPercent(h.observedUpper, 0)}
                            </div>
                          ) : null}
                        </>
                      )}
                    </Td>
                    <Td>
                      <Badge tone={unreliable ? 'warning' : (VERDICT_TONE[verdict] ?? 'neutral')}>{verdict}</Badge>
                      {unreliable && (
                        <div className="mt-1 max-w-[16rem] whitespace-normal text-xs leading-relaxed text-warning">
                          ⚠ Marked unreliable by the service — the metrics on this row are printed, not established.
                        </div>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>

          <div className="mt-5 border-t border-border pt-4">
            <Tabs tabs={tabs} active={head} onChange={onHeadChange} />
            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
              <ReliabilityDiagram head={head} calibration={selected} />
              <div className="space-y-3">
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Verdict</div>
                  <div className="mt-1.5">
                    <Badge tone={VERDICT_TONE[selected?.verdict ?? 'insufficient data'] ?? 'neutral'}>
                      {selected?.verdict ?? 'insufficient data'}
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-ink-muted">
                    {selected?.explanation ?? 'This head has not been scored.'}
                  </p>
                </div>
                {(selected?.reliable === false || (selected?.n ?? 0) < MIN_VERDICT_SAMPLES) && (
                  <Note tone="warning">
                    The service marks this head unreliable: {formatNumber(selected?.n ?? 0)} labelled launch(es). The points
                    beside this are drawn because they exist, not because they are evidence — at least {MIN_VERDICT_SAMPLES} are
                    needed before the gap between forecast and reality means anything.
                  </Note>
                )}
              </div>
            </div>
          </div>

          {report?.note && <p className="mt-4 text-xs leading-relaxed text-ink-subtle">{report.note}</p>}
          {report?.caveats && report.caveats.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {report.caveats.map((c, i) => (
                <li key={i} className="flex gap-2 text-xs leading-relaxed text-ink-subtle">
                  <span aria-hidden="true">▸</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

function NotScored({ label = 'not scored' }: { label?: string }) {
  return <span className="text-xs italic text-ink-subtle">{label}</span>;
}

interface ReliabilityPoint {
  predicted: number;
  observed: number;
  n: number;
  binLower: number;
  binUpper: number;
  /** [distance below, distance above] — recharts ErrorBar wants offsets. */
  err: [number, number];
}

function ReliabilityDiagram({ head, calibration }: { head: HeadKey; calibration?: HeadCalibration }) {
  const points = useMemo<ReliabilityPoint[]>(() => {
    const bins = calibration?.bins ?? [];
    const out: ReliabilityPoint[] = [];
    for (const bin of bins) {
      const n = bin.n ?? 0;
      const predicted = bin.predicted;
      const observed = bin.observed;
      if (n <= 0 || predicted === null || predicted === undefined || observed === null || observed === undefined) continue;
      const lower = bin.observedLower ?? observed;
      const upper = bin.observedUpper ?? observed;
      out.push({
        predicted,
        observed,
        n,
        binLower: bin.binLower ?? 0,
        binUpper: bin.binUpper ?? 1,
        err: [Math.max(0, observed - lower), Math.max(0, upper - observed)],
      });
    }
    return out;
  }, [calibration]);

  if (points.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface-raised">
        <EmptyState
          title={`No populated bins for ${headLabel(head).toLowerCase()}`}
          description="A reliability diagram plots forecast probability against realised frequency. It appears once at least one probability bin contains a labelled launch."
        />
      </div>
    );
  }

  return (
    <div>
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 16, bottom: 34, left: 8 }}>
            <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
            <XAxis
              type="number"
              dataKey="predicted"
              domain={[0, 1]}
              ticks={[0, 0.25, 0.5, 0.75, 1]}
              tickFormatter={(v: number) => formatPercent(v, 0)}
              tick={{ fontSize: 11, fill: 'var(--color-ink-subtle)' }}
              tickLine={false}
              axisLine={{ stroke: 'var(--color-border)' }}
              label={{
                value: 'Predicted probability',
                position: 'insideBottom',
                offset: -18,
                fill: 'var(--color-ink-subtle)',
                fontSize: 11,
              }}
            />
            <YAxis
              type="number"
              dataKey="observed"
              domain={[0, 1]}
              ticks={[0, 0.25, 0.5, 0.75, 1]}
              tickFormatter={(v: number) => formatPercent(v, 0)}
              tick={{ fontSize: 11, fill: 'var(--color-ink-subtle)' }}
              tickLine={false}
              axisLine={{ stroke: 'var(--color-border)' }}
              width={46}
              label={{
                value: 'Observed frequency',
                angle: -90,
                position: 'insideLeft',
                fill: 'var(--color-ink-subtle)',
                fontSize: 11,
              }}
            />
            <ZAxis type="number" dataKey="n" range={[50, 420]} name="launches in bin" />
            <ReferenceLine
              segment={[
                { x: 0, y: 0 },
                { x: 1, y: 1 },
              ]}
              stroke="var(--color-ink-subtle)"
              strokeDasharray="5 4"
              ifOverflow="extendDomain"
            />
            <Tooltip cursor={{ stroke: 'var(--color-border-strong)' }} content={<ReliabilityTooltip />} />
            <Scatter name="Calibration bins" data={points} fill="var(--color-accent)" fillOpacity={0.75}>
              <ErrorBar dataKey="err" direction="y" width={4} strokeWidth={1} stroke="var(--color-accent-soft)" />
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
        Each dot is a probability bin: forecast on the x-axis, what actually happened on the y-axis. Dot area is the number of
        launches in the bin and the vertical whisker is its 95% Wilson interval. The dashed diagonal is perfect calibration —
        dots below it mean the model promised more than the market delivered.
      </p>
    </div>
  );
}

function ReliabilityTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.payload as ReliabilityPoint | undefined;
  if (!point) return null;
  const lower = point.observed - point.err[0];
  const upper = point.observed + point.err[1];
  return (
    <div className="card-raised px-3 py-2 text-xs shadow-lg">
      <div className="font-medium text-ink">
        Bin {formatPercent(point.binLower, 0)}–{formatPercent(point.binUpper, 0)}
      </div>
      <div className="tnum mt-1 text-accent-soft">Predicted {formatPercent(point.predicted, 1)}</div>
      <div className="tnum text-ink">
        Observed {formatPercent(point.observed, 1)}{' '}
        <span className="text-ink-subtle">
          (95% {formatPercent(lower, 0)}–{formatPercent(upper, 0)})
        </span>
      </div>
      <div className="mt-1">
        <SampleSize n={point.n} minimum={MIN_VERDICT_SAMPLES} />
      </div>
    </div>
  );
}

// --- 3. Base rates ---------------------------------------------------------

function BaseRatesSection({ rates }: { rates?: ObservedBaseRates }) {
  if (!rates) {
    return (
      <Card>
        <SectionHeader title="Base rates" />
        <EmptyState title="No base rates returned" description="The learning service did not return an observed base-rate block." />
      </Card>
    );
  }

  const rows = HEADS.map((head) => ({ head, rate: rates[head] }));
  // `sufficient` is the service's own judgement; `source` is how it acted on it.
  // They agree, and the flag is what is reported rather than being re-derived.
  const anyObserved = rates.sufficient === true || rows.some((r) => r.rate?.sufficient === true);

  return (
    <Card>
      <SectionHeader
        title="Observed base rates versus the priors"
        description="How often each outcome actually happens. Where evidence is thin the platform keeps the hand-set domain prior instead of a ratio computed from a handful of launches."
        action={<SampleSize n={rates.n ?? 0} minimum={30} />}
      />

      {/* The service's `reason` explains the state either way, so it is shown
          either way — a reader who sees measured rates still needs to know how
          they were arrived at. */}
      <div className="mt-3">
        <Note tone={anyObserved ? 'info' : 'warning'}>
          <strong className="font-semibold">
            {anyObserved ? 'Some rates are measured. ' : 'Every rate below is the hand-set prior, not a measurement. '}
          </strong>
          {rates.reason ?? 'The service did not explain how these rates were arrived at.'}
        </Note>
      </div>

      <DataTable className="mt-4">
        <thead>
          <tr>
            <Th>Outcome</Th>
            <Th align="right">Rate in use</Th>
            <Th align="right">95% interval</Th>
            <Th align="right">Raw observed</Th>
            <Th align="right">Labels</Th>
            <Th>Source</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ head, rate }) => {
            const observedN = rate?.observedN ?? 0;
            const successes = rate?.successes ?? 0;
            const raw = observedN > 0 ? successes / observedN : null;
            const isPrior = rate?.sufficient !== true;
            return (
              <tr key={head}>
                <Td className="text-ink">
                  <div className="font-medium">{headLabel(head)}</div>
                  <div className="text-xs text-ink-subtle">{HEAD_MEANING[head]}</div>
                </Td>
                <Td align="right" className="tnum text-ink">
                  {rate?.rate === undefined ? '—' : formatPercent(rate.rate, 1)}
                </Td>
                <Td align="right" className="tnum">
                  {/* A prior carries lower=0, upper=1. Printing "0%–100%" under a
                      column headed "95% interval" dresses a hand-set constant up
                      as a computed one, so a prior says it has no interval. */}
                  {isPrior ? (
                    <span className="text-xs italic text-ink-subtle">no interval — assumed</span>
                  ) : rate?.lower === undefined || rate.upper === undefined ? (
                    '—'
                  ) : (
                    `${formatPercent(rate.lower, 1)}–${formatPercent(rate.upper, 1)}`
                  )}
                </Td>
                <Td align="right" className="tnum">
                  {raw === null ? (
                    <span className="text-xs italic text-ink-subtle">never observed</span>
                  ) : (
                    <>
                      {formatPercent(raw, 1)}
                      <div className="text-xs text-ink-subtle">
                        {formatNumber(successes)}/{formatNumber(observedN)}
                      </div>
                    </>
                  )}
                </Td>
                <Td align="right">
                  <SampleSize n={observedN} minimum={30} />
                </Td>
                <Td>
                  <Badge tone={isPrior ? 'warning' : 'positive'}>{isPrior ? 'Prior (assumed)' : 'Observed'}</Badge>
                  {isPrior && (rate?.priorPseudoCount ?? 0) > 0 && (
                    <div className="tnum mt-1 text-xs text-ink-subtle">
                      pseudo-count {formatNumber(rate?.priorPseudoCount ?? 0, 1)}
                    </div>
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>

      {rates.caveats && rates.caveats.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {rates.caveats.map((c, i) => (
            <li key={i} className="flex gap-2 text-xs leading-relaxed text-ink-subtle">
              <span aria-hidden="true">▸</span>
              <span>{c}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// --- 4. What the model learned --------------------------------------------

function WeightsSection({ shifts, trainedOn }: { shifts: WeightShift[]; trainedOn: number }) {
  const maxDelta = shifts.reduce((max, s) => Math.max(max, Math.abs(s.delta ?? 0)), 0);

  return (
    <Card>
      <SectionHeader
        title="What the model learned"
        description="Features whose weights have moved furthest from the domain prior they started at. A large move on a small sample is noise learned confidently, so read these next to the outcome count."
      />

      {shifts.length === 0 ? (
        <EmptyState
          title="No weight has moved yet"
          description={
            trainedOn === 0
              ? 'The model is still exactly its starting priors. Weights move once labelled outcomes are folded in by a training run.'
              : 'Training has run but no feature weight has moved far enough from its prior to report.'
          }
        />
      ) : (
        <DataTable className="mt-4">
          <thead>
            <tr>
              <Th>Feature</Th>
              <Th>Head</Th>
              <Th align="right">Prior</Th>
              <Th align="right">Now</Th>
              <Th align="right">Move</Th>
              <Th>Reading</Th>
            </tr>
          </thead>
          <tbody>
            {shifts.map((shift, i) => {
              const delta = shift.delta ?? 0;
              const up = delta >= 0;
              return (
                <tr key={`${shift.head ?? ''}:${shift.feature ?? i}`}>
                  <Td className="text-ink">
                    <div className="font-medium">{shift.label ?? humanise(shift.feature)}</div>
                    <div className="tnum text-xs text-ink-subtle">{shift.feature ?? '—'}</div>
                  </Td>
                  <Td>{headLabel(shift.head)}</Td>
                  <Td align="right" className="tnum">
                    {shift.before === undefined ? '—' : formatScore(shift.before, 3)}
                  </Td>
                  <Td align="right" className="tnum text-ink">
                    {shift.after === undefined ? '—' : formatScore(shift.after, 3)}
                  </Td>
                  <Td align="right" className="min-w-[8rem]">
                    <div className={'tnum text-sm font-medium ' + (up ? 'text-positive' : 'text-negative')}>
                      {up ? '▲' : '▼'} {formatScore(Math.abs(delta), 3)}
                    </div>
                    <ScoreBar
                      value={maxDelta > 0 ? Math.abs(delta) / maxDelta : 0}
                      tone={up ? 'positive' : 'negative'}
                      className="mt-1"
                    />
                  </Td>
                  <Td className="max-w-md whitespace-normal text-xs leading-relaxed">{shift.reading ?? '—'}</Td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}
    </Card>
  );
}

// --- 5. Revenue accuracy ---------------------------------------------------

function RevenueSection({ revenue }: { revenue?: RevenueAccuracy }) {
  if (!revenue) {
    return (
      <Card>
        <SectionHeader title="Revenue forecast accuracy" />
        <EmptyState
          title="No revenue accuracy block returned"
          description="The learning service did not report fee-forecast accuracy. It appears once at least one launch has both a stored fee forecast and a measured fee total."
        />
      </Card>
    );
  }
  const n = revenue.n ?? 0;
  const actual = revenue.actualFeesSol;
  const predicted = revenue.predictedFeesSol;

  return (
    <Card>
      <SectionHeader
        title="Revenue forecast accuracy"
        description="Creator fees are long-tailed: the mean is a statement about whichever launch happened to work. The median and the p10–p90 range are the figures to read."
        action={<SampleSize n={n} minimum={10} />}
      />

      {n === 0 || !actual || !predicted ? (
        <EmptyState
          title="No launch has a measured fee figure yet"
          description={revenue.note ?? 'Fee accuracy appears once launches have accrued creator fees and their outcome windows have closed.'}
        />
      ) : (
        <>
          {/* `note` is the service's own qualification of these figures and is
              shown whether or not it also set `reliable: false`. */}
          {(revenue.reliable === false || revenue.note) && (
            <div className="mt-3">
              <Note tone={revenue.reliable === false ? 'warning' : 'info'}>
                {revenue.reliable === false && (
                  <strong className="font-semibold">Not reliable at this sample size. </strong>
                )}
                {revenue.note ??
                  `Only ${formatNumber(n)} measured launch(es) — the shape of this distribution is not yet estimated.`}
              </Note>
            </div>
          )}
          <DataTable className="mt-4">
            <thead>
              <tr>
                <Th>Creator fees per launch</Th>
                <Th align="right">Median</Th>
                <Th align="right">Mean</Th>
                <Th align="right">p10</Th>
                <Th align="right">p90</Th>
                <Th align="right">Max</Th>
                <Th align="right">Top decile share</Th>
              </tr>
            </thead>
            <tbody>
              <SkewRow label="Actual" tone="text-positive" summary={actual} />
              <SkewRow label="Model expected" tone="text-info" summary={predicted} />
            </tbody>
          </DataTable>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <MetricSwatch
              label="Median miss (actual − expected)"
              value={revenue.medianErrorSol === null || revenue.medianErrorSol === undefined ? '—' : formatSol(revenue.medianErrorSol, { sign: true })}
              tone={(revenue.medianErrorSol ?? 0) >= 0 ? 'positive' : 'negative'}
              hint={(revenue.medianErrorSol ?? 0) >= 0 ? 'Launches typically beat the forecast' : 'Launches typically fell short of the forecast'}
            />
            <MetricSwatch
              label="Median absolute miss"
              value={
                revenue.medianAbsoluteErrorSol === null || revenue.medianAbsoluteErrorSol === undefined
                  ? '—'
                  : formatSol(revenue.medianAbsoluteErrorSol)
              }
              tone="neutral"
              hint="Typical size of the error regardless of direction"
            />
          </div>
        </>
      )}
    </Card>
  );
}

function SkewRow({ label, tone, summary }: { label: string; tone: string; summary: SkewedSummary }) {
  return (
    <tr>
      <Td className={'font-medium ' + tone}>
        {label}
        <div className="text-xs font-normal text-ink-subtle">n={formatNumber(summary.n ?? 0)}</div>
        {/* `reliable: false` means the shape — p10, p90, top-decile share — is
            not estimated. The cells still print, so the row has to say so. */}
        {summary.reliable === false && (
          <div className="whitespace-normal text-xs font-normal leading-relaxed text-warning">
            ⚠ shape not estimated at this n
          </div>
        )}
      </Td>
      <Td align="right" className="tnum text-ink">
        {formatSol(summary.median)}
      </Td>
      <Td align="right" className="tnum">
        {formatSol(summary.mean)}
      </Td>
      <Td align="right" className="tnum">
        {formatSol(summary.p10)}
      </Td>
      <Td align="right" className="tnum">
        {formatSol(summary.p90)}
      </Td>
      <Td align="right" className="tnum">
        {formatSol(summary.max)}
      </Td>
      <Td align="right" className="tnum">
        {summary.topDecileShare === undefined ? '—' : formatPercent(summary.topDecileShare, 0)}
      </Td>
    </tr>
  );
}

// --- 6. Prediction versus reality -----------------------------------------

interface ErrorsQueryLike {
  data?: { errors?: PredictionErrorRow[] };
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => unknown;
}

function ErrorsSection({ query }: { query: ErrorsQueryLike }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const rows = query.data?.errors ?? [];

  return (
    <Card>
      <SectionHeader
        title="Prediction versus reality"
        description="The 50 most recent launches the model published a forecast for, with what actually happened and why the model thought what it did. This is a window on the history, not the whole of it — the calibration figures above are computed over every scored launch, not just these rows."
        action={rows.length > 0 ? <SampleSize n={rows.length} minimum={MIN_VERDICT_SAMPLES} /> : undefined}
      />

      {query.isLoading ? (
        <LoadingRows rows={5} className="mt-4" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No scored launches yet"
          description="A launch appears here once its outcome window has closed and its labels have been recorded — 24 hours after launch at the earliest."
        />
      ) : (
        <DataTable className="mt-4">
          <thead>
            <tr>
              <Th>Launch</Th>
              <Th>Forecast made</Th>
              {HEADS.map((h) => (
                <Th key={h} align="center">
                  {HEAD_LABEL[h]}
                </Th>
              ))}
              <Th align="right">Fees expected</Th>
              <Th align="right">Fees actual</Th>
              <Th align="right">Miss</Th>
              <Th align="right">Why</Th>
            </tr>
          </thead>
          {rows.map((row, index) => {
            const key = row.outcomeId ?? row.predictionId ?? `row-${index}`;
            const open = expanded === key;
            const feeError = row.creatorFeesErrorSol;
            return (
              <tbody key={key}>
                <tr>
                  <Td className="text-ink">
                    <div className="font-medium">{row.name ?? row.symbol ?? truncateAddress(row.tokenMint)}</div>
                    <div className="tnum text-xs text-ink-subtle">
                      {row.symbol ? `${row.symbol} · ` : ''}
                      {truncateAddress(row.tokenMint)}
                    </div>
                  </Td>
                  <Td>
                    <div className="whitespace-nowrap text-xs">{formatRelative(row.predictedAt)}</div>
                    <div className="tnum text-xs text-ink-subtle">
                      {row.horizonHours ?? '?'}h horizon · {row.modelVersion ?? '—'}
                    </div>
                  </Td>
                  {HEADS.map((h) => (
                    <Td key={h} align="center">
                      <HeadOutcome
                        predicted={row.predicted?.[h]}
                        actual={row.actual?.[h] ?? null}
                        signedError={row.signedError?.[h] ?? null}
                      />
                    </Td>
                  ))}
                  <Td align="right" className="tnum text-info">
                    {formatSol(row.expectedCreatorFeesSol)}
                  </Td>
                  <Td align="right" className="tnum text-positive">
                    {row.actualCreatorFeesSol === null || row.actualCreatorFeesSol === undefined ? (
                      <span className="text-xs italic text-ink-subtle">not measured</span>
                    ) : (
                      formatSol(row.actualCreatorFeesSol)
                    )}
                  </Td>
                  <Td align="right" className="tnum">
                    {feeError === null || feeError === undefined ? (
                      '—'
                    ) : (
                      <span className={feeError >= 0 ? 'text-positive' : 'text-negative'}>
                        {feeError >= 0 ? '▲' : '▼'} {formatSol(Math.abs(feeError))}
                      </span>
                    )}
                  </Td>
                  <Td align="right">
                    <button
                      className="btn btn-ghost px-2 py-1 text-xs"
                      onClick={() => setExpanded(open ? null : key)}
                      aria-expanded={open}
                      aria-label={open ? 'Hide explanation' : 'Show explanation'}
                    >
                      {open ? 'Hide' : 'Explain'}
                    </button>
                  </Td>
                </tr>
                {open && (
                  <tr>
                    <td
                      colSpan={HEADS.length + 6}
                      className="border-b border-border/60 bg-surface-raised px-3 py-3 align-top text-ink-muted"
                    >
                      <div className="max-w-3xl space-y-2 text-xs leading-relaxed">
                        <p>{row.explanation ?? 'No explanation was stored for this prediction.'}</p>
                        <p className="tnum text-ink-subtle">
                          Peak holders in window:{' '}
                          {row.peakHolders === null || row.peakHolders === undefined ? 'never recorded' : formatNumber(row.peakHolders)} ·
                          24h volume expected {formatSol(row.expectedVolume24hSol)}, actual{' '}
                          {row.actualVolume24hSol === null || row.actualVolume24hSol === undefined
                            ? 'not measured'
                            : formatSol(row.actualVolume24hSol)}
                        </p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            );
          })}
        </DataTable>
      )}
    </Card>
  );
}

function HeadOutcome({
  predicted,
  actual,
  signedError,
}: {
  predicted: number | undefined;
  actual: 0 | 1 | null;
  signedError: number | null | undefined;
}) {
  if (predicted === undefined) return <span className="text-xs text-ink-subtle">—</span>;
  const label = actual === null || actual === undefined ? 'unlabelled' : actual === 1 ? 'yes' : 'no';
  const tone =
    actual === null || actual === undefined
      ? 'text-ink-subtle'
      : signedError === null || signedError === undefined
        ? 'text-ink-muted'
        : signedError > 0.25
          ? 'text-negative'
          : signedError < -0.25
            ? 'text-warning'
            : 'text-positive';
  const mark = actual === null || actual === undefined ? '·' : actual === 1 ? '✓' : '✕';
  return (
    <div className="whitespace-nowrap">
      <div className="tnum text-xs text-ink-muted">{formatPercent(predicted, 0)}</div>
      <div className={'tnum text-xs font-medium ' + tone}>
        <span aria-hidden="true">{mark}</span> {label}
      </div>
    </div>
  );
}

// --- 7. Model versions -----------------------------------------------------

function ModelVersionsSection({ models }: { models: ModelVersionRow[] }) {
  if (models.length === 0) {
    return (
      <Card>
        <SectionHeader title="Model versions" />
        <EmptyState
          title="No trained bundle has been stored"
          description="The platform is running on its starting priors, which are code, not a stored model. A row appears here the first time a training run produces a bundle — whether or not that bundle passes the calibration check and becomes active."
        />
      </Card>
    );
  }
  const shown = models.slice(0, 8);

  return (
    <Card>
      <SectionHeader
        title="Model versions"
        description="Every bundle the trainer has produced. Only one is active at a time; a version that was built but never activated failed the calibration check."
        action={
          models.length > shown.length ? (
            <span className="tnum text-xs text-ink-subtle">
              newest {formatNumber(shown.length)} of {formatNumber(models.length)}
            </span>
          ) : undefined
        }
      />
      <DataTable className="mt-4">
        <thead>
          <tr>
            <Th>Version</Th>
            <Th>Kind</Th>
            <Th align="right">Trained on</Th>
            <Th align="right">Mean log loss</Th>
            <Th>Built</Th>
            <Th>State</Th>
          </tr>
        </thead>
        <tbody>
          {shown.map((model, i) => {
            const metrics = parseMetrics(model.metrics);
            return (
              <tr key={model.id ?? model.version ?? i}>
                <Td className="tnum text-ink">{model.version ?? '—'}</Td>
                <Td>{humanise(model.kind)}</Td>
                <Td align="right">
                  <SampleSize n={model.trained_on ?? 0} minimum={MIN_VERDICT_SAMPLES} />
                </Td>
                <Td align="right" className="tnum">
                  {metrics === null || metrics === undefined ? <NotScored /> : formatScore(metrics, 4)}
                </Td>
                <Td className="whitespace-nowrap text-xs">{formatDateTime(model.created_at)}</Td>
                <Td>
                  <Badge tone={model.active === 1 ? 'positive' : 'neutral'}>{model.active === 1 ? '✓ Active' : 'Superseded'}</Badge>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>
    </Card>
  );
}

/** Metrics are stored as a JSON blob whose shape has changed over time. */
function parseMetrics(raw: string | null | undefined): number | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { meanLogLoss?: number | null } | null;
    const value = parsed?.meanLogLoss;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
