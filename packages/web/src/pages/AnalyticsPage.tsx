import { useMemo, useState, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
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
  ScoreBar,
  SectionHeader,
  StatTile,
  Tabs,
  Td,
  Th,
} from '@/components/ui';
import { formatNumber, formatPercent, formatScore, formatSol, formatUsd, humanise } from '@/lib/format';
import { POLL, queryKeys, useApiQuery } from '@/lib/queries';

// --- API shapes ------------------------------------------------------------
// Everything is optional. These endpoints deliberately return `sufficient:
// false` shapes and omit statistics they cannot support, so a field that is
// present in the happy path is genuinely absent in the honest path.

type RangeKey = '7d' | '30d' | '90d' | '1y' | 'all';

interface RateEstimate {
  point?: number;
  lower?: number;
  upper?: number;
  successes?: number;
  n?: number;
  method?: string;
  reliable?: boolean;
}

interface Distribution {
  sufficient?: boolean;
  reason?: string;
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
  topOnePercentShare?: number;
  topFivePercentShare?: number;
  topTenPercentShare?: number;
  topOnePercentSpansTokens?: number;
  topFivePercentSpansTokens?: number;
  topTenPercentSpansTokens?: number;
  gini?: number;
  dustFraction?: number;
  dustCount?: number;
  dustThresholdSol?: number;
  zeroCount?: number;
  meanToMedianRatio?: number | null;
  includesAccrued?: boolean;
  reliable?: boolean;
  minReliableN?: number;
  caveats?: string[];
}

interface CostByKind {
  kind?: string;
  sol?: number;
  usd?: number;
  n?: number;
}

interface PnL {
  sufficient?: boolean;
  reason?: string;
  network?: string;
  revenueRealisedSol?: number;
  feeCollectionCount?: number;
  revenueAccruedUnclaimedSol?: number;
  costs?: {
    onChainLaunchSol?: number;
    operatingSol?: number;
    operatingUsd?: number;
    expenseLedgerSol?: number;
    expenseLedgerUsd?: number;
    byKind?: CostByKind[];
    solPriceUsd?: number | null;
    totalSol?: number;
    totalSolIncludingUsd?: number | null;
  };
  grossProfitSol?: number;
  netProfitSol?: number | null;
  netProfitSolExcludingUsdCosts?: number;
  roi?: number | null;
  launches?: number;
  successes?: number;
  profitPerLaunchSol?: number | null;
  perLaunchFeesSol?: {
    meanSol?: number;
    medianSol?: number;
    p90Sol?: number;
    topTenPercentShare?: number;
    n?: number;
    reliable?: boolean;
  };
  breakEvenRate?: RateEstimate;
  costPerSuccessfulLaunchSol?: number | null;
  organicVolumeSol?: number;
  revenuePer1000SolVolume?: number | null;
  caveats?: string[];
}

interface DimensionGroup {
  dimension?: string;
  key?: string;
  label?: string;
  n?: number;
  successes?: number;
  successRate?: RateEstimate;
  medianFeesSol?: number;
  meanFeesSol?: number;
  shrunkMeanFeesSol?: number;
  totalFeesSol?: number;
  p90FeesSol?: number;
  graduations?: number;
  reliable?: boolean;
  minReliableN?: number;
}

interface DimensionResponse {
  dimension?: string;
  groups?: DimensionGroup[];
}

interface SeriesPoint {
  t: number;
  value: number;
  n: number;
}

interface SeriesResponse {
  metric?: string;
  points?: SeriesPoint[];
}

interface SignalCorrelation {
  feature?: string;
  correlation?: number;
  lower?: number | null;
  upper?: number | null;
  n?: number;
  reliable?: boolean;
  degenerate?: boolean;
  caveat?: string;
}

interface SignalsResponse {
  signals?: SignalCorrelation[];
}

interface ForecastScenario {
  label?: string;
  basis?: string;
  creatorFeesSol?: number;
  costsSol?: number;
  netIncomeSol?: number;
}

interface Forecast {
  sufficient?: boolean;
  reason?: string;
  n?: number;
  windowDays?: number;
  perLaunchFeesSol?: { meanSol?: number; medianSol?: number; p25Sol?: number; p75Sol?: number; p90Sol?: number; n?: number };
  launchesPerMonth?: number;
  observedLaunchesPerMonth?: number;
  configuredMaxLaunchesPerMonth?: number;
  launchRateBasis?: string;
  costPerLaunchSol?: number;
  fixedMonthlyCostSol?: number;
  monthlyOperatingUsd?: number;
  solPriceUsd?: number | null;
  scenarios?: { low?: ForecastScenario; base?: ForecastScenario; high?: ForecastScenario };
  caveats?: string[];
}

// --- Static configuration --------------------------------------------------

const RANGES: Array<{ id: RangeKey; label: string }> = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: '1y', label: '1 year' },
  { id: 'all', label: 'All time' },
];

type MetricKey = 'creator_fees_sol' | 'launches' | 'organic_volume_sol' | 'spend_sol' | 'ai_spend_usd';

const METRICS: Array<{ id: MetricKey; label: string; unit: 'sol' | 'usd' | 'count'; axis: string; description: string }> = [
  {
    id: 'creator_fees_sol',
    label: 'Creator fees',
    unit: 'sol',
    axis: 'SOL',
    description: 'Fees actually claimed on-chain, bucketed by when the claim landed.',
  },
  { id: 'launches', label: 'Launches', unit: 'count', axis: 'Launches', description: 'Confirmed launches per bucket.' },
  {
    id: 'organic_volume_sol',
    label: 'Organic volume',
    unit: 'sol',
    axis: 'SOL',
    description:
      "Each token's lifetime organic volume is attributed to the bucket it launched in, because volume is stored cumulatively per token rather than per interval.",
  },
  { id: 'spend_sol', label: 'On-chain spend', unit: 'sol', axis: 'SOL', description: 'Platform-wide spend, not scoped to one network.' },
  { id: 'ai_spend_usd', label: 'AI spend', unit: 'usd', axis: 'USD', description: 'Model and image provider costs, platform-wide.' },
];

const DIMENSIONS: Array<{ id: string; label: string }> = [
  { id: 'category', label: 'Category' },
  { id: 'trend_source', label: 'Trend source' },
  { id: 'launch_hour_utc', label: 'Launch hour (UTC)' },
  { id: 'launch_day_of_week', label: 'Day of week' },
  { id: 'concept_archetype', label: 'Concept archetype' },
  { id: 'saturation_bucket', label: 'Saturation bucket' },
  { id: 'opportunity_bucket', label: 'Opportunity bucket' },
  { id: 'exploration_arm', label: 'Exploration arm' },
];

/** Bucket width follows the range so a chart never renders 8,760 hourly points. */
function bucketFor(range: RangeKey): 'hour' | 'day' | 'week' {
  if (range === '7d') return 'hour';
  if (range === '1y' || range === 'all') return 'week';
  return 'day';
}

const BUCKET_LABEL: Record<'hour' | 'day' | 'week', string> = {
  hour: 'Hour (UTC)',
  day: 'Day (UTC)',
  week: 'Week beginning (UTC, Monday)',
};

// --- Page ------------------------------------------------------------------

export default function AnalyticsPage() {
  const [range, setRange] = useState<RangeKey>('30d');
  const [metric, setMetric] = useState<MetricKey>('creator_fees_sol');
  const [dimension, setDimension] = useState<string>('category');

  const bucket = bucketFor(range);

  const distributionQuery = useApiQuery<Distribution>(
    queryKeys.analyticsDistribution(range),
    `/api/analytics/distribution?range=${range}`,
    { refetchInterval: POLL.slow },
  );
  const pnlQuery = useApiQuery<PnL>(queryKeys.analyticsPnl(range), `/api/analytics/pnl?range=${range}`, {
    refetchInterval: POLL.slow,
  });
  const seriesQuery = useApiQuery<SeriesResponse>(
    queryKeys.analyticsSeries(metric, range, bucket),
    `/api/analytics/series?metric=${metric}&bucket=${bucket}&range=${range}`,
    { refetchInterval: POLL.slow },
  );
  const dimensionQuery = useApiQuery<DimensionResponse>(
    queryKeys.analyticsDimension(dimension, range),
    `/api/analytics/by/${dimension}?range=${range}`,
    { refetchInterval: POLL.slow },
  );
  const signalsQuery = useApiQuery<SignalsResponse>(queryKeys.analyticsSignals, '/api/analytics/signals', {
    refetchInterval: POLL.slow,
  });
  const forecastQuery = useApiQuery<Forecast>(queryKeys.analyticsForecast, '/api/analytics/forecast', {
    refetchInterval: POLL.slow,
  });

  const distribution = distributionQuery.data;
  const pnl = pnlQuery.data;

  // "Nothing has happened yet" is a different state from "this range is empty",
  // and only the first one deserves an onboarding screen.
  const settled = !distributionQuery.isLoading && !pnlQuery.isLoading && !signalsQuery.isLoading;
  const nothingYet =
    settled &&
    !distributionQuery.isError &&
    !pnlQuery.isError &&
    (distribution?.n ?? 0) === 0 &&
    (pnl?.launches ?? 0) === 0 &&
    (signalsQuery.data?.signals?.length ?? 0) === 0;

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Analytics"
        description="Where the revenue actually comes from, what it costs to produce, and which of the platform's own signals have any relationship to the outcome."
        action={<RangeSelector value={range} onChange={setRange} />}
      />

      {nothingYet ? (
        <Card>
          <EmptyState
            icon="▦"
            title="No launches to analyse yet"
            description={
              <>
                Every panel on this page is computed from launches that have actually happened. Once the pipeline has
                confirmed its first launches — and those tokens have had time to earn — the revenue distribution, P&amp;L,
                attribution and signal tables fill in automatically.
                {distribution?.reason ? (
                  <span className="mt-2 block text-ink-subtle">Analytics service reports: {distribution.reason}</span>
                ) : null}
              </>
            }
          />
        </Card>
      ) : (
        <>
          <DistributionPanel query={distributionQuery} range={range} />
          <PnLPanel query={pnlQuery} range={range} />
          <SeriesPanel query={seriesQuery} metric={metric} onMetricChange={setMetric} bucket={bucket} />
          <AttributionPanel query={dimensionQuery} dimension={dimension} onDimensionChange={setDimension} />
          <SignalsPanel query={signalsQuery} />
          <ForecastPanel query={forecastQuery} />
        </>
      )}
    </div>
  );
}

export { AnalyticsPage };

// --- Range selector --------------------------------------------------------

function RangeSelector({ value, onChange }: { value: RangeKey; onChange: (next: RangeKey) => void }) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Analysis range">
      {RANGES.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.id)}
            className={
              active
                ? 'rounded-lg border border-accent-dim bg-accent-dim/40 px-2.5 py-1.5 text-xs font-semibold text-accent-soft'
                : 'rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink'
            }
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

interface QueryLike<T> {
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  data: T | undefined;
  refetch: () => unknown;
}

// --- 1. Revenue distribution ----------------------------------------------

function DistributionPanel({ query, range }: { query: QueryLike<Distribution>; range: RangeKey }) {
  const data = query.data;

  return (
    <Card>
      <SectionHeader
        title="Revenue distribution"
        description="How creator fees are spread across the tokens launched in this range. This is the panel that decides whether any other average on this page means anything."
        action={data?.n !== undefined ? <SampleSize n={data.n} minimum={data.minReliableN ?? 8} /> : undefined}
      />

      <div className="mt-4">
        {query.isLoading ? (
          <LoadingRows rows={4} />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : !data || data.sufficient === false ? (
          <EmptyState
            icon="◔"
            title="Not enough launches in this range to describe a distribution"
            description={
              <>
                {data?.reason ?? 'The analytics service reported that this range has no analysable launches.'}
                {' '}
                Percentiles, a Gini coefficient and a tail share computed from {formatNumber(data?.n ?? 0)} token
                {(data?.n ?? 0) === 1 ? '' : 's'} would be arithmetic, not a finding — so nothing is drawn here.
                {range !== 'all' ? ' Try widening the range to All time.' : ''}
              </>
            }
          />
        ) : (
          <DistributionBody data={data} />
        )}
      </div>
    </Card>
  );
}

function DistributionBody({ data }: { data: Distribution }) {
  const n = data.n ?? 0;
  const minReliable = data.minReliableN ?? 8;
  const meanToMedian = data.meanToMedianRatio ?? null;
  const topFive = data.topFivePercentShare;
  const tailDominates = (topFive ?? 0) >= 0.5;

  const shares: Array<{ label: string; share: number | undefined; spans: number | undefined }> = [
    { label: 'Top 1%', share: data.topOnePercentShare, spans: data.topOnePercentSpansTokens },
    { label: 'Top 5%', share: data.topFivePercentShare, spans: data.topFivePercentSpansTokens },
    { label: 'Top 10%', share: data.topTenPercentShare, spans: data.topTenPercentSpansTokens },
  ];

  const percentiles: Array<{ label: string; value: number | undefined }> = [
    { label: 'p10', value: data.p10Sol },
    { label: 'p25', value: data.p25Sol },
    { label: 'Median (p50)', value: data.medianSol },
    { label: 'p75', value: data.p75Sol },
    { label: 'p90', value: data.p90Sol },
    { label: 'p99', value: data.p99Sol },
    { label: 'Max', value: data.maxSol },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Mean per token"
          value={formatSol(data.meanSol)}
          tone={meanToMedian !== null && meanToMedian > 2 ? 'warning' : 'neutral'}
          hint={
            meanToMedian === null
              ? 'The median is zero, so no mean-to-median ratio is defined.'
              : `${formatScore(meanToMedian, 1)}× the median${meanToMedian > 2 ? ' — this is a statement about the tail' : ''}`
          }
        />
        <StatTile label="Median per token" value={formatSol(data.medianSol)} hint="What a typical launch actually earned" />
        <StatTile
          label="Gini coefficient"
          value={formatScore(data.gini, 2)}
          tone={(data.gini ?? 0) > 0.7 ? 'warning' : 'neutral'}
          hint="0 = every token earned the same, 1 = one token earned everything"
        />
        <StatTile
          label="Earned essentially nothing"
          value={formatPercent(data.dustFraction, 0)}
          tone={(data.dustFraction ?? 0) > 0.5 ? 'warning' : 'neutral'}
          hint={`${formatNumber(data.dustCount)} of ${formatNumber(n)} tokens below ${formatSol(data.dustThresholdSol)}; ${formatNumber(data.zeroCount)} earned exactly zero`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">Concentration of revenue</h3>
          <ul className="mt-3 space-y-3">
            {shares.map((row) => (
              <li key={row.label}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-ink-muted">
                    {row.label}
                    {row.spans !== undefined && (
                      <span className="ml-1.5 text-xs text-ink-subtle">
                        = {formatNumber(row.spans)} token{row.spans === 1 ? '' : 's'}
                      </span>
                    )}
                  </span>
                  <span className="tnum font-medium text-ink">{formatPercent(row.share, 1)}</span>
                </div>
                <ScoreBar
                  className="mt-1.5"
                  value={row.share ?? 0}
                  tone={(row.share ?? 0) >= 0.5 ? 'warning' : 'accent'}
                />
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs leading-relaxed text-ink-subtle">
            Share of the {formatSol(data.totalSol)} earned in this range.{' '}
            {data.includesAccrued === false
              ? 'Only fees already claimed on-chain are counted.'
              : 'Fees accrued but not yet claimed are included, so this is the economic view rather than the cash one.'}
          </p>
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">Percentiles of fees per token</h3>
          <DataTable className="mt-2">
            <thead>
              <tr>
                <Th>Percentile</Th>
                <Th align="right">Creator fees</Th>
              </tr>
            </thead>
            <tbody>
              {percentiles.map((row) => (
                <tr key={row.label}>
                  <Td className={row.label.startsWith('Median') ? 'font-medium text-ink' : undefined}>{row.label}</Td>
                  <Td align="right" className={`tnum ${row.label.startsWith('Median') ? 'font-medium text-ink' : ''}`}>
                    {formatSol(row.value)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </div>
      </div>

      <Note tone={tailDominates ? 'warning' : 'neutral'}>
        <strong className="font-semibold">Read the median, not the mean.</strong> Memecoin revenue is heavy-tailed:{' '}
        {topFive !== undefined ? (
          <>
            the best-earning 5% of tokens here ({formatNumber(data.topFivePercentSpansTokens)} of {formatNumber(n)}) took{' '}
            {formatPercent(topFive, 1)} of all revenue.{' '}
          </>
        ) : null}
        When the top 5% produce most of the revenue, average revenue per launch is a misleading number — it describes a
        tail that almost no launch belongs to, and multiplying it by a planned launch count produces a forecast of money
        that will not arrive. This panel exists to make that visible rather than to let the average stand alone.
      </Note>

      {n < minReliable && (
        <Note tone="warning">
          Only {formatNumber(n)} token{n === 1 ? '' : 's'} in this range, below the {formatNumber(minReliable)} the service
          treats as the minimum for shape statistics. With a sample this small the Gini coefficient and the tail shares are
          artefacts of how few tokens there are: a single token makes the Gini 0 and the top-1% share 100% at the same time.
        </Note>
      )}

      {(data.caveats ?? []).map((caveat) => (
        <Note key={caveat}>{caveat}</Note>
      ))}
    </div>
  );
}

// --- 2. Profit and loss ----------------------------------------------------

function PnLPanel({ query, range }: { query: QueryLike<PnL>; range: RangeKey }) {
  const data = query.data;

  return (
    <Card>
      <SectionHeader
        title="Profit and loss"
        description="Cash-basis revenue against every cost the platform recorded in this range."
      />
      <div className="mt-4">
        {query.isLoading ? (
          <LoadingRows rows={4} />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : !data || data.sufficient === false ? (
          <EmptyState
            icon="▤"
            title="No launches fell in this range"
            description={
              <>
                {data?.reason ?? 'There is nothing to attribute revenue or cost to in this window.'} P&amp;L needs at least
                one launch before ROI, profit per launch or a break-even rate mean anything.
                {range !== 'all' ? ' Widen the range to All time to see everything recorded so far.' : ''}
              </>
            }
          />
        ) : (
          <PnLBody data={data} />
        )}
      </div>
    </Card>
  );
}

function PnLBody({ data }: { data: PnL }) {
  const costs = data.costs;
  const net = data.netProfitSol;
  const netUnknown = net === null || net === undefined;
  const perLaunch = data.perLaunchFeesSol;
  const breakEven = data.breakEvenRate;
  const byKind = (costs?.byKind ?? []).filter((row) => (row.sol ?? 0) !== 0 || (row.usd ?? 0) !== 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label="Revenue (claimed)"
          value={formatSol(data.revenueRealisedSol)}
          tone={(data.revenueRealisedSol ?? 0) > 0 ? 'positive' : 'neutral'}
          hint={`${formatNumber(data.feeCollectionCount)} collections · ${formatSol(data.revenueAccruedUnclaimedSol)} accrued, unclaimed`}
        />
        <StatTile
          label="Total cost"
          value={formatSol(costs?.totalSol)}
          hint={
            costs?.solPriceUsd === null || costs?.solPriceUsd === undefined
              ? `Plus ${formatUsd(costs?.operatingUsd)} billed in USD, not convertible: no SOL price recorded`
              : `Includes USD costs at ${formatUsd(costs.solPriceUsd)}/SOL`
          }
        />
        <StatTile
          label="Gross profit"
          value={formatSol(data.grossProfitSol, { sign: true })}
          tone={(data.grossProfitSol ?? 0) >= 0 ? 'positive' : 'negative'}
          hint="Revenue less direct on-chain launch cost"
        />
        <StatTile
          label="Net profit"
          value={netUnknown ? '—' : formatSol(net, { sign: true })}
          tone={netUnknown ? 'neutral' : net >= 0 ? 'positive' : 'negative'}
          hint={
            netUnknown
              ? `No SOL price recorded, so USD costs cannot be converted. Excluding them: ${formatSol(data.netProfitSolExcludingUsdCosts, { sign: true })}.`
              : 'Gross profit less operating costs'
          }
        />
        <StatTile
          label="ROI"
          value={data.roi === null || data.roi === undefined ? '—' : formatPercent(data.roi, 1)}
          tone={data.roi === null || data.roi === undefined ? 'neutral' : data.roi >= 0 ? 'positive' : 'negative'}
          hint={
            data.roi === null || data.roi === undefined
              ? 'Undefined: no cost was incurred, or USD costs cannot be converted'
              : 'Net profit divided by total cost'
          }
        />
        <StatTile
          label="Profit per launch"
          value={
            data.profitPerLaunchSol === null || data.profitPerLaunchSol === undefined
              ? '—'
              : formatSol(data.profitPerLaunchSol, { sign: true })
          }
          hint={`An aggregate divided by ${formatNumber(data.launches)} launches — not what a launch earns`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">Costs by kind</h3>
          {byKind.length === 0 ? (
            <Note>No costs were recorded in this range. That is a fact about the ledger, not an estimate of zero spend.</Note>
          ) : (
            <DataTable className="mt-2">
              <thead>
                <tr>
                  <Th>Kind</Th>
                  <Th align="right">SOL</Th>
                  <Th align="right">USD</Th>
                  <Th align="right">Entries</Th>
                </tr>
              </thead>
              <tbody>
                {byKind.map((row) => (
                  <tr key={row.kind ?? 'unknown'}>
                    <Td className="text-ink">{humanise(row.kind)}</Td>
                    <Td align="right" className="tnum">
                      {formatSol(row.sol)}
                    </Td>
                    <Td align="right" className="tnum">
                      {(row.usd ?? 0) === 0 ? '—' : formatUsd(row.usd)}
                    </Td>
                    <Td align="right" className="tnum">
                      {formatNumber(row.n)}
                    </Td>
                  </tr>
                ))}
                <tr>
                  <Td className="font-medium text-ink">On-chain launch spend</Td>
                  <Td align="right" className="tnum font-medium text-ink">
                    {formatSol(costs?.onChainLaunchSol)}
                  </Td>
                  <Td align="right">—</Td>
                  <Td align="right" className="tnum">
                    {formatNumber(data.launches)}
                  </Td>
                </tr>
              </tbody>
            </DataTable>
          )}
        </div>

        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">Unit economics</h3>
          <dl className="divide-y divide-border/60 text-sm">
            <UnitRow
              term="Break-even rate"
              value={
                breakEven?.point === undefined ? (
                  '—'
                ) : (
                  <span className="tnum">
                    {formatPercent(breakEven.point, 0)}{' '}
                    <span className="text-xs text-ink-subtle">
                      [{formatPercent(breakEven.lower, 0)} – {formatPercent(breakEven.upper, 0)}]
                    </span>
                  </span>
                )
              }
              detail={
                breakEven?.n !== undefined ? (
                  <span className="flex items-center gap-2">
                    <SampleSize n={breakEven.n} />
                    <span>
                      {formatNumber(breakEven.successes)} launch{breakEven.successes === 1 ? '' : 'es'} whose own fees covered
                      their own cost
                    </span>
                  </span>
                ) : undefined
              }
            />
            <UnitRow
              term="Cost per successful launch"
              value={
                data.costPerSuccessfulLaunchSol === null || data.costPerSuccessfulLaunchSol === undefined
                  ? '—'
                  : formatSol(data.costPerSuccessfulLaunchSol)
              }
              detail={`${formatNumber(data.successes)} of ${formatNumber(data.launches)} launches reached the success bar`}
            />
            <UnitRow
              term="Revenue per 1,000 SOL of organic volume"
              value={
                data.revenuePer1000SolVolume === null || data.revenuePer1000SolVolume === undefined
                  ? '—'
                  : formatSol(data.revenuePer1000SolVolume)
              }
              detail={`Take rate over ${formatSol(data.organicVolumeSol)} of organic volume from the same cohort`}
            />
            <UnitRow
              term="Fees per launch (mean / median)"
              value={
                <span className="tnum">
                  {formatSol(perLaunch?.meanSol)} <span className="text-ink-subtle">/</span> {formatSol(perLaunch?.medianSol)}
                </span>
              }
              detail={
                perLaunch?.n !== undefined ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <SampleSize n={perLaunch.n} />
                    <span>
                      p90 {formatSol(perLaunch.p90Sol)} · best tenth took {formatPercent(perLaunch.topTenPercentShare, 0)} of
                      cohort revenue
                    </span>
                  </span>
                ) : undefined
              }
            />
          </dl>
        </div>
      </div>

      {perLaunch?.reliable === false && (
        <Note tone="warning">
          The per-launch fee statistics come from {formatNumber(perLaunch.n)} launches, which the service flags as too few to
          be reliable. Treat the mean, median and p90 above as a description of those specific launches, not as an estimate
          of what the next one will earn.
        </Note>
      )}
      {breakEven?.reliable === false && (
        <Note tone="warning">
          The break-even rate is computed from {formatNumber(breakEven.n)} launches. Its interval is wide enough to contain
          almost any true value; it is shown so the width is visible, not so the point estimate can be quoted.
        </Note>
      )}
      {(data.caveats ?? []).map((caveat) => (
        <Note key={caveat}>{caveat}</Note>
      ))}
    </div>
  );
}

function UnitRow({ term, value, detail }: { term: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2.5">
      <div className="min-w-0">
        <dt className="text-ink-muted">{term}</dt>
        {detail && <dd className="mt-0.5 text-xs leading-relaxed text-ink-subtle">{detail}</dd>}
      </div>
      <dd className="tnum shrink-0 font-medium text-ink">{value}</dd>
    </div>
  );
}

// --- 3. Time series --------------------------------------------------------

function SeriesPanel({
  query,
  metric,
  onMetricChange,
  bucket,
}: {
  query: QueryLike<SeriesResponse>;
  metric: MetricKey;
  onMetricChange: (next: MetricKey) => void;
  bucket: 'hour' | 'day' | 'week';
}) {
  const config = METRICS.find((m) => m.id === metric) ?? METRICS[0]!;
  const points = query.data?.points ?? [];
  const observed = points.some((point) => (point?.n ?? 0) > 0 || (point?.value ?? 0) !== 0);
  const total = points.reduce((accumulator, point) => accumulator + (point?.value ?? 0), 0);

  const formatValue = (value: number | undefined): string =>
    config.unit === 'sol' ? formatSol(value) : config.unit === 'usd' ? formatUsd(value) : formatNumber(value);

  return (
    <Card>
      <SectionHeader title="Over time" description={config.description} />
      <Tabs
        className="mt-3"
        tabs={METRICS.map((m) => ({ id: m.id, label: m.label }))}
        active={metric}
        onChange={onMetricChange}
      />

      <div className="mt-4">
        {query.isLoading ? (
          <LoadingRows rows={4} />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : points.length === 0 || !observed ? (
          <EmptyState
            icon="◌"
            title={`No ${config.label.toLowerCase()} recorded in this range`}
            description="Every bucket in this window is empty. Drawing a flat line at zero would look like a measurement, so nothing is drawn. Widen the range, or pick another metric."
          />
        ) : (
          <>
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={points} margin={{ top: 8, right: 8, left: 4, bottom: 24 }}>
                  <defs>
                    <linearGradient id="analytics-series-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="t"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    scale="time"
                    tickFormatter={(value: number) => formatBucket(value, bucket)}
                    tick={{ fontSize: 11, fill: 'var(--color-ink-subtle)' }}
                    tickLine={false}
                    axisLine={{ stroke: 'var(--color-border)' }}
                    minTickGap={28}
                    label={{
                      value: BUCKET_LABEL[bucket],
                      position: 'insideBottom',
                      offset: -16,
                      fill: 'var(--color-ink-subtle)',
                      fontSize: 11,
                    }}
                  />
                  <YAxis
                    width={64}
                    tick={{ fontSize: 11, fill: 'var(--color-ink-subtle)' }}
                    tickLine={false}
                    axisLine={{ stroke: 'var(--color-border)' }}
                    tickFormatter={(value: number) =>
                      config.unit === 'count' ? formatNumber(value) : value === 0 ? '0' : value.toFixed(value < 1 ? 3 : 1)
                    }
                    label={{ value: config.axis, angle: -90, position: 'insideLeft', fill: 'var(--color-ink-subtle)', fontSize: 11 }}
                  />
                  <Tooltip
                    content={<SeriesTooltip bucket={bucket} label={config.label} format={formatValue} />}
                    cursor={{ stroke: 'var(--color-border-strong)' }}
                  />
                  {/* Counts step rather than curve: interpolating between two launch counts would draw fractional launches. */}
                  <Area
                    type={config.unit === 'count' ? 'stepAfter' : 'monotone'}
                    dataKey="value"
                    name={config.label}
                    stroke="var(--color-accent-soft)"
                    strokeWidth={2}
                    fill="url(#analytics-series-fill)"
                    activeDot={{ r: 3, fill: 'var(--color-accent-soft)' }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-ink-subtle">
              <span className="tnum">{formatValue(total)}</span> across {formatNumber(points.length)}{' '}
              {bucket} buckets. A bucket at zero means nothing happened then, not that the data is missing.
            </p>
          </>
        )}
      </div>
    </Card>
  );
}

function formatBucket(value: number, bucket: 'hour' | 'day' | 'week'): string {
  const date = new Date(value);
  if (bucket === 'hour') return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function SeriesTooltip({
  active,
  payload,
  bucket,
  label,
  format,
}: TooltipProps<number, string> & { bucket: 'hour' | 'day' | 'week'; label: string; format: (value: number) => string }) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.payload as SeriesPoint | undefined;
  if (!point) return null;
  return (
    <div className="card-raised px-3 py-2 text-xs shadow-lg">
      <div className="font-medium text-ink">{formatBucket(point.t, bucket)}</div>
      <div className="tnum mt-1 text-accent-soft">
        {label}: {format(point.value)}
      </div>
      <div className="mt-1 text-ink-subtle">
        {point.n === 0 ? 'no records in this bucket' : `${formatNumber(point.n)} record${point.n === 1 ? '' : 's'}`}
      </div>
    </div>
  );
}

// --- 4. Performance attribution -------------------------------------------

function AttributionPanel({
  query,
  dimension,
  onDimensionChange,
}: {
  query: QueryLike<DimensionResponse>;
  dimension: string;
  onDimensionChange: (next: string) => void;
}) {
  const groups = query.data?.groups ?? [];
  const label = DIMENSIONS.find((d) => d.id === dimension)?.label ?? humanise(dimension);

  return (
    <Card>
      <SectionHeader
        title="Performance attribution"
        description="Launches grouped by one decision dimension, ranked by the shrunk mean rather than the raw one."
        action={
          <div className="min-w-[12rem]">
            <label className="label" htmlFor="attribution-dimension">
              Dimension
            </label>
            <select
              id="attribution-dimension"
              className="input"
              value={dimension}
              onChange={(event) => onDimensionChange(event.target.value)}
            >
              {DIMENSIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        }
      />

      <div className="mt-4">
        {query.isLoading ? (
          <LoadingRows rows={5} />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : groups.length === 0 ? (
          <EmptyState
            icon="◇"
            title={`No launches carry a ${label.toLowerCase()} in this range`}
            description="Attribution needs launches that recorded this dimension at decision time. Once launches accumulate — or once the range is widened — the groups appear here with their sample sizes and intervals."
          />
        ) : (
          <>
            <DataTable>
              <thead>
                <tr>
                  <Th>{label}</Th>
                  <Th align="right">n</Th>
                  <Th align="right">Success rate</Th>
                  <Th align="right">Median fees</Th>
                  <Th align="right">Raw mean</Th>
                  <Th align="right">Shrunk mean</Th>
                  <Th>Reliability</Th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group, index) => {
                  const rate = group.successRate;
                  const minimum = group.minReliableN ?? 8;
                  return (
                    <tr key={group.key ?? group.label ?? String(index)}>
                      <Td className="font-medium text-ink">{group.label ?? humanise(group.key)}</Td>
                      <Td align="right" className="tnum">
                        {formatNumber(group.n)}
                      </Td>
                      <Td align="right" className="tnum whitespace-nowrap">
                        {rate?.point === undefined ? (
                          '—'
                        ) : (
                          <>
                            {formatPercent(rate.point, 0)}
                            <span className="ml-1 text-xs text-ink-subtle">
                              [{formatPercent(rate.lower, 0)}–{formatPercent(rate.upper, 0)}]
                            </span>
                          </>
                        )}
                      </Td>
                      <Td align="right" className="tnum">
                        {formatSol(group.medianFeesSol)}
                      </Td>
                      <Td align="right" className="tnum text-ink-subtle">
                        {formatSol(group.meanFeesSol)}
                      </Td>
                      <Td align="right" className="tnum font-medium text-ink">
                        {formatSol(group.shrunkMeanFeesSol)}
                      </Td>
                      <Td>
                        {group.reliable ? (
                          <Badge tone="positive">✓ n ≥ {minimum}</Badge>
                        ) : (
                          <Badge tone="warning">⚠ Low sample</Badge>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>

            <Note tone="accent">
              <strong className="font-semibold">Trust the shrunk mean.</strong> The raw mean of a two-launch group is not an
              estimate of anything: whichever group happens to contain the single best token would top this table forever.
              The shrunk column pulls every group toward the global mean in proportion to how little evidence it has, so a
              small group must be consistently good — not once lucky — to rank. Groups are ordered by that column
              deliberately, and success rates use a Beta posterior so a 1-for-1 group reports about 50% with a very wide
              interval rather than a triumphant 100%.
            </Note>
          </>
        )}
      </div>
    </Card>
  );
}

// --- 5. Signal predictiveness ---------------------------------------------

function SignalsPanel({ query }: { query: QueryLike<SignalsResponse> }) {
  const signals = useMemo(() => query.data?.signals ?? [], [query.data]);
  const [openFeature, setOpenFeature] = useState<string | null>(null);

  // The service appends the same base caveat to every row; the most common
  // string is that base text, which is what belongs at the top of the panel.
  const sharedCaveat = useMemo(() => {
    const counts = new Map<string, number>();
    for (const signal of signals) {
      if (!signal.caveat) continue;
      counts.set(signal.caveat, (counts.get(signal.caveat) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const [text, count] of counts) {
      if (count > bestCount || (count === bestCount && best !== null && text.length < best.length)) {
        best = text;
        bestCount = count;
      }
    }
    return best;
  }, [signals]);

  return (
    <Card>
      <SectionHeader
        title="Signal predictiveness"
        description="Spearman rank correlation between each decision-time feature and the creator fees the launch actually earned."
      />

      <div className="mt-4 space-y-4">
        {query.isLoading ? (
          <LoadingRows rows={5} />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : signals.length === 0 ? (
          <EmptyState
            icon="◐"
            title="No launch has both stored features and a measured outcome yet"
            description="This table compares what the model believed at decision time against what the token actually earned. It fills in once confirmed launches have recorded predictions and their tokens have accrued fees."
          />
        ) : (
          <>
            {sharedCaveat && <Note tone="warning">{sharedCaveat}</Note>}

            <DataTable>
              <thead>
                <tr>
                  <Th>Feature</Th>
                  <Th align="right">Correlation</Th>
                  <Th>Strength</Th>
                  <Th align="right">95% interval</Th>
                  <Th align="right">n</Th>
                  <Th>Reliability</Th>
                  <Th align="right">Caveat</Th>
                </tr>
              </thead>
              <tbody>
                {signals.map((signal) => {
                  const feature = signal.feature ?? 'unknown';
                  const correlation = signal.correlation ?? 0;
                  const positive = correlation >= 0;
                  const open = openFeature === feature;
                  return (
                    <tr key={feature}>
                      <Td className="font-medium text-ink">{humanise(feature)}</Td>
                      <Td align="right" className="tnum">
                        {signal.degenerate ? '—' : `${positive ? '+' : '−'}${Math.abs(correlation).toFixed(2)}`}
                      </Td>
                      <Td className="w-32 min-w-[7rem]">
                        {signal.degenerate ? (
                          <span className="text-xs text-ink-subtle">unmeasurable</span>
                        ) : (
                          <span className="flex items-center gap-2">
                            <ScoreBar value={Math.abs(correlation)} tone={positive ? 'positive' : 'negative'} />
                            <span className="text-xs text-ink-subtle">{positive ? 'higher' : 'lower'}</span>
                          </span>
                        )}
                      </Td>
                      <Td align="right" className="tnum whitespace-nowrap">
                        {signal.lower === null || signal.lower === undefined || signal.upper === null || signal.upper === undefined
                          ? '—'
                          : `${signal.lower.toFixed(2)} to ${signal.upper.toFixed(2)}`}
                      </Td>
                      <Td align="right" className="tnum">
                        {signal.n === undefined ? '—' : <SampleSize n={signal.n} minimum={20} />}
                      </Td>
                      <Td>
                        {signal.degenerate ? (
                          <Badge tone="neutral">⃠ No variation</Badge>
                        ) : signal.reliable ? (
                          <Badge tone="positive">✓ Interpretable</Badge>
                        ) : (
                          <Badge tone="warning">⚠ Not interpretable</Badge>
                        )}
                      </Td>
                      <Td align="right">
                        <button
                          type="button"
                          className="text-xs text-ink-subtle underline decoration-dotted underline-offset-2 transition-colors hover:text-ink"
                          aria-expanded={open}
                          onClick={() => setOpenFeature(open ? null : feature)}
                        >
                          {open ? 'Hide' : 'Why'}
                        </button>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>

            {openFeature && (
              <Note tone="info">
                <strong className="font-semibold">{humanise(openFeature)}: </strong>
                {signals.find((signal) => signal.feature === openFeature)?.caveat ?? 'No caveat was returned for this feature.'}
              </Note>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

// --- 6. Forecast -----------------------------------------------------------

function ForecastPanel({ query }: { query: QueryLike<Forecast> }) {
  const data = query.data;
  const scenarios = data?.scenarios;

  const rows: Array<{ key: 'low' | 'base' | 'high'; label: string; scenario: ForecastScenario | undefined }> = [
    { key: 'low', label: 'Low', scenario: scenarios?.low },
    { key: 'base', label: 'Base', scenario: scenarios?.base },
    { key: 'high', label: 'High', scenario: scenarios?.high },
  ];

  return (
    <Card>
      <SectionHeader
        title="Monthly forecast"
        description="Projected monthly economics at the observed launch rate, expressed as a band rather than a single number."
      />

      <div className="mt-4 space-y-4">
        {query.isLoading ? (
          <LoadingRows rows={3} />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : !data || data.sufficient === false || !scenarios ? (
          <EmptyState
            icon="◷"
            title="Not enough history to forecast"
            description={
              <>
                {data?.reason ?? 'The analytics service has no realised launches to project from.'} A forecast built on{' '}
                {formatNumber(data?.n ?? 0)} launch{(data?.n ?? 0) === 1 ? '' : 'es'} would be a restatement of one or two
                outcomes with a confident label on it, so none is shown.
              </>
            }
          />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              {rows.map(({ key, label, scenario }) => {
                const net = scenario?.netIncomeSol;
                return (
                  <div key={key} className={key === 'base' ? 'card-raised p-4' : 'card p-4'}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">{label}</span>
                      {key === 'base' && <Badge tone="accent">Central</Badge>}
                    </div>
                    <div
                      className={`tnum mt-2 text-2xl font-semibold tracking-tight ${
                        net === undefined ? 'text-ink' : net >= 0 ? 'text-positive' : 'text-negative'
                      }`}
                    >
                      {formatSol(net, { sign: true })}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-subtle">net income per month</div>
                    <dl className="mt-3 space-y-1 text-xs">
                      <div className="flex justify-between gap-2">
                        <dt className="text-ink-subtle">Creator fees</dt>
                        <dd className="tnum text-ink-muted">{formatSol(scenario?.creatorFeesSol)}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-ink-subtle">Costs</dt>
                        <dd className="tnum text-ink-muted">{formatSol(scenario?.costsSol)}</dd>
                      </div>
                    </dl>
                    {scenario?.basis && <p className="mt-2 text-xs leading-relaxed text-ink-subtle">{scenario.basis}</p>}
                  </div>
                );
              })}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                label="Launches per month"
                value={formatNumber(data.launchesPerMonth, 1)}
                hint={data.launchRateBasis ?? `Observed ${formatNumber(data.observedLaunchesPerMonth, 1)}/month`}
              />
              <StatTile label="Cost per launch" value={formatSol(data.costPerLaunchSol)} hint="Direct on-chain cost" />
              <StatTile
                label="Fixed monthly cost"
                value={formatSol(data.fixedMonthlyCostSol)}
                hint={
                  data.solPriceUsd === null || data.solPriceUsd === undefined
                    ? `Excludes ${formatUsd(data.monthlyOperatingUsd)} of USD costs: no SOL price recorded`
                    : `Includes USD costs at ${formatUsd(data.solPriceUsd)}/SOL`
                }
              />
              <StatTile
                label="Based on"
                value={formatNumber(data.n)}
                hint={`launches over the last ${formatNumber(data.windowDays)} days`}
                tone={(data.n ?? 0) < 8 ? 'warning' : 'neutral'}
              />
            </div>

            {data.perLaunchFeesSol && (
              <p className="text-xs leading-relaxed text-ink-subtle">
                Per-launch fees behind the band: median {formatSol(data.perLaunchFeesSol.medianSol)}, p25{' '}
                {formatSol(data.perLaunchFeesSol.p25Sol)}, p75 {formatSol(data.perLaunchFeesSol.p75Sol)}, p90{' '}
                {formatSol(data.perLaunchFeesSol.p90Sol)}{' '}
                {data.perLaunchFeesSol.n !== undefined && <SampleSize n={data.perLaunchFeesSol.n} />}
              </p>
            )}

            {(data.caveats ?? []).map((caveat) => (
              <Note key={caveat}>{caveat}</Note>
            ))}
          </>
        )}
      </div>
    </Card>
  );
}
