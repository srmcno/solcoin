import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
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
import { Badge, Card, EmptyState, ErrorState, LoadingRows, Note, SampleSize, ScoreBar, SectionHeader, StatTile, type Tone } from '@/components/ui';
import { formatNumber, formatPercent, formatRelative, formatSol, formatUsd, humanise } from '@/lib/format';
import { POLL, queryKeys, useApiQuery } from '@/lib/queries';

// --- API shapes ------------------------------------------------------------
// Every field is optional: the overview is assembled from several ledgers and
// a partial response must degrade to an em-dash, never to a zero that reads as
// a measurement.

interface RateEstimate {
  point?: number;
  lower?: number;
  upper?: number;
  successes?: number;
  n?: number;
  reliable?: boolean;
}

interface Overview {
  network?: string;
  asOfMs?: number;
  fees?: {
    collectedSol?: number;
    collectedTodaySol?: number;
    collected7dSol?: number;
    collected30dSol?: number;
    outstandingAccruedSol?: number;
    lifetimeRevenueSol?: number;
    collectionCount?: number;
  };
  launches?: { attempted?: number; confirmed?: number; failed?: number; executionRate?: RateEstimate };
  tokens?: { launched?: number; active?: number; graduated?: number; dormant?: number };
  successfulLaunchRate?: RateEstimate;
  graduationRate?: RateEstimate;
  volume?: { totalOrganicSol?: number; n?: number };
  revenuePerLaunch?: {
    meanSol?: number;
    medianSol?: number;
    p90Sol?: number;
    /** Share of all revenue earned by the best-earning tenth of tokens. */
    topTenPercentShare?: number;
    /** meanSol / medianSol; null when the median is zero. Above ~2 the mean is a tail statistic. */
    meanToMedianRatio?: number | null;
    n?: number;
    reliable?: boolean;
  };
  pipeline?: {
    candidatesAwaitingApproval?: number;
    conceptsInFlight?: number;
    opportunitiesDiscoveredToday?: number;
    trendsActive?: number;
  };
  spend?: {
    onChainLaunchSol?: number;
    operatingSol?: number;
    operatingUsd?: number;
    totalSol?: number;
    solPriceUsd?: number | null;
    totalSolIncludingUsd?: number | null;
  };
  netProfitSol?: number | null;
  netProfitSolExcludingUsdCosts?: number;
  caveats?: string[];
}

interface HealthComponent {
  id: string;
  label?: string;
  kind?: string;
  state?: 'ok' | 'degraded' | 'down' | string;
  detail?: string;
  essential?: boolean;
}

interface JobStatus {
  name: string;
  description?: string;
  enabled?: boolean;
  lastRunAt?: number | null;
  lastStatus?: string | null;
  consecutiveFailures?: number;
  running?: boolean;
  overdueSeconds?: number;
}

interface SystemStatus {
  health?: { overall?: 'ok' | 'degraded' | 'down'; components?: HealthComponent[]; summary?: string; checkedAt?: number };
  usage?: {
    launchesToday?: number;
    launchesLastHour?: number;
    solSpentToday?: number;
    aiSpentTodayUsd?: number;
    consecutiveFailures?: number;
    limits?: {
      maxLaunchesPerHour?: number;
      maxLaunchesPerDay?: number;
      maxSolPerHour?: number;
      maxSolSpendPerDay?: number;
      maxAiSpendUsdPerDay?: number;
      consecutiveFailureShutdown?: number;
    };
    emergencyStop?: boolean;
  };
  wallet?: {
    address?: string | null;
    balanceSol?: number;
    belowFloor?: boolean;
    floorSol?: number;
    canSign?: boolean;
    balanceCheckedAt?: number | null;
  };
  phase?: string;
  network?: string;
  autonomy?: Record<string, string | undefined>;
  emergencyStop?: boolean;
  emergencyStopReason?: string;
  jobs?: JobStatus[];
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
  scenarios?: { low?: ForecastScenario; base?: ForecastScenario; high?: ForecastScenario };
  caveats?: string[];
}

/** The activation ladder, described in the operator's terms rather than the enum's. */
const PHASE_LADDER: Array<{ id: string; label: string; detail: string }> = [
  { id: 'phase1_research', label: 'Research only', detail: 'Trends and concepts are gathered. Nothing is spent on-chain.' },
  { id: 'phase2_devnet', label: 'Devnet launches', detail: 'The full pipeline runs against devnet, where SOL is worthless.' },
  { id: 'phase3_mainnet_approval', label: 'Mainnet with approval', detail: 'Real launches, but every one waits for you to approve it.' },
  { id: 'phase4_limited_autonomous', label: 'Limited autonomy', detail: 'Launches proceed unattended, inside the daily limits you set.' },
  { id: 'phase5_adaptive_autonomous', label: 'Adaptive autonomy', detail: 'Thresholds adapt to measured performance. Limits still bind.' },
];

export function OverviewPage() {
  const overviewQuery = useApiQuery<Overview>(queryKeys.analyticsOverview, '/api/analytics/overview', {
    refetchInterval: POLL.normal,
  });
  const statusQuery = useApiQuery<SystemStatus>(queryKeys.systemStatus, '/api/system/status', {
    refetchInterval: POLL.fast,
  });
  const seriesQuery = useApiQuery<SeriesResponse>(
    queryKeys.analyticsSeries('creator_fees_sol', '30d', 'day'),
    '/api/analytics/series?metric=creator_fees_sol&bucket=day&range=30d',
    { refetchInterval: POLL.slow },
  );
  const forecastQuery = useApiQuery<Forecast>(queryKeys.analyticsForecast, '/api/analytics/forecast', {
    refetchInterval: POLL.slow,
  });

  const overview = overviewQuery.data;
  const status = statusQuery.data;

  if (overviewQuery.isLoading) {
    return (
      <div className="space-y-4">
        <SectionHeader title="Overview" description="Loading the current operating picture…" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="card h-24 animate-pulse bg-surface-raised/40" />
          ))}
        </div>
        <LoadingRows rows={4} />
      </div>
    );
  }

  if (overviewQuery.isError) {
    return (
      <Card>
        <ErrorState error={overviewQuery.error} onRetry={() => void overviewQuery.refetch()} />
      </Card>
    );
  }

  // Succeeded but returned nothing. This is not "nothing has been launched" —
  // that is a claim about the platform, and the response gives no grounds for
  // it. Say what actually happened instead.
  if (!overview) {
    return (
      <Card>
        <EmptyState
          title="The overview came back empty"
          description="The request succeeded but carried no metrics, so nothing here can be stated one way or the other. This is not a report that the platform is idle."
          action={
            <button className="btn btn-ghost" onClick={() => void overviewQuery.refetch()}>
              Try again
            </button>
          }
        />
      </Card>
    );
  }

  // Only claim "nothing has been launched" when the response actually said so.
  // A missing `tokens` block is an unknown, and an unknown must not be turned
  // into a zero that the getting-started card then narrates as fact.
  const launched = overview.tokens?.launched;
  const gettingStarted = launched === 0;
  // The status endpoint is the live authority on the network; the overview
  // response carries the network it was computed for, which is the honest
  // fallback while status is still in flight.
  const network = status?.network ?? overview?.network;

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Overview"
        description={
          <>
            What the platform is doing, what it has earned and what it has spent.
            {overview?.asOfMs ? <span className="text-ink-subtle"> Figures as of {formatRelative(overview.asOfMs)}.</span> : null}
          </>
        }
      />

      <NetworkProvenance network={network} />

      {gettingStarted ? (
        <GettingStartedTiles overview={overview} status={status} />
      ) : (
        <HeadlineTiles overview={overview} status={status} />
      )}

      <OperatingStrip
        status={status}
        loading={statusQuery.isLoading}
        error={statusQuery.error}
        onRetry={() => void statusQuery.refetch()}
      />

      {gettingStarted && <GettingStarted phase={status?.phase} />}

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <SectionHeader
            title="Creator fees collected"
            description="Daily total of fees actually claimed on-chain over the last 30 days. Fees earned but still sitting in a vault are not counted here."
          />
          <div className="mt-4">
            <FeeChart query={seriesQuery} />
          </div>
        </Card>

        <Attention overview={overview} status={status} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ForecastPanel query={forecastQuery} />
        <RevenuePerLaunch overview={overview} />
      </div>

      {overview?.caveats && overview.caveats.length > 0 && (
        <Card>
          <SectionHeader title="What these numbers cannot tell you" description="Reported by the analytics service alongside the figures above." />
          <ul className="mt-3 space-y-2">
            {overview.caveats.map((caveat) => (
              <li key={caveat}>
                <Note>{caveat}</Note>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

// --- Provenance ------------------------------------------------------------

/**
 * Every SOL figure on this page — fees, profit, wallet balance, the chart, the
 * forecast — is denominated in whatever the configured network's SOL is worth.
 * On `simulation` that is nothing at all: the numbers come out of the
 * simulator, not a market. On `devnet` the tokens are real transactions but the
 * SOL is free and worthless.
 *
 * The network badge lives further down in the operating strip, below the fold
 * on a phone, and a badge is not a claim anyway. The headline numbers are the
 * thing that gets misread as money, so the qualification goes above them.
 */
function NetworkProvenance({ network }: { network: string | undefined }) {
  if (network === 'mainnet' || network === undefined) return null;

  if (network === 'simulation') {
    return (
      <Note tone="warning">
        <span aria-hidden="true">◇</span> <strong className="font-semibold">Simulated — none of this is real money.</strong>{' '}
        The platform is running on the simulation network: no token below exists on-chain, no fee was ever claimed from a
        market, and every SOL figure on this page — fees, net profit, wallet balance, the chart and the forecast — is
        produced by the simulator. It is useful for checking that the pipeline works end to end. It is not revenue, and
        it does not predict revenue.
      </Note>
    );
  }

  if (network === 'devnet') {
    return (
      <Note tone="warning">
        <strong className="font-semibold">Devnet — the SOL below has no value.</strong> Transactions here are real and
        the pipeline is the same one mainnet uses, but devnet SOL is free from a faucet. Treat every figure on this page
        as a test of the machinery, not as earnings.
      </Note>
    );
  }

  return (
    <Note tone="warning">
      <strong className="font-semibold">Unrecognised network “{network}”.</strong> This build knows how to interpret
      simulation, devnet and mainnet. Until the network is identified, do not assume the SOL figures below represent real
      money.
    </Note>
  );
}

/** The label for a network, matching the shell's badge so the two never disagree. */
function networkLabel(network: string | undefined): string {
  if (network === 'simulation') return 'Simulation';
  if (network === 'devnet') return 'Devnet';
  if (network === 'mainnet') return 'MAINNET';
  return network ? humanise(network) : 'Unknown';
}

/**
 * The wallet balance as the API can actually justify it.
 *
 * `balanceSol` is a cached figure that defaults to zero — zero when there is no
 * wallet, and zero when a wallet exists but its balance has never been fetched.
 * Rendering that as "0.00 SOL" states a measurement that was never taken, so
 * both cases resolve to an em-dash with the reason attached.
 */
function walletBalanceDisplay(wallet: SystemStatus['wallet']): { value: string; hint: string; measured: boolean } {
  if (!wallet?.address) {
    return {
      value: '—',
      hint: 'No wallet is configured, so there is no balance to read.',
      measured: false,
    };
  }
  if (wallet.balanceCheckedAt === null || wallet.balanceCheckedAt === undefined) {
    return {
      value: '—',
      hint: 'This wallet’s balance has never been fetched from an RPC, so the platform does not know it.',
      measured: false,
    };
  }
  return {
    value: formatSol(wallet.balanceSol),
    hint: wallet.belowFloor
      ? `Below the ${formatSol(wallet.floorSol)} floor — spending is halted. Read ${formatRelative(wallet.balanceCheckedAt)}.`
      : `Floor ${formatSol(wallet.floorSol)} · read ${formatRelative(wallet.balanceCheckedAt)}`,
    measured: true,
  };
}

// --- Headline tiles --------------------------------------------------------

function HeadlineTiles({ overview, status }: { overview: Overview | undefined; status: SystemStatus | undefined }) {
  const fees = overview?.fees;
  const wallet = status?.wallet;
  const netProfit = overview?.netProfitSol;
  const netProfitExclUsd = overview?.netProfitSolExcludingUsdCosts;
  const totalSpend = overview?.spend?.totalSol;
  const balance = walletBalanceDisplay(wallet);
  const collections = fees?.collectionCount;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
      <StatTile
        label="Creator fees, total"
        value={formatSol(fees?.collectedSol)}
        tone={(fees?.collectedSol ?? 0) > 0 ? 'positive' : 'neutral'}
        hint={
          <>
            {collections === undefined
              ? 'Claimed on-chain.'
              : `Claimed on-chain across ${formatNumber(collections)} collection${collections === 1 ? '' : 's'}.`}
            {fees?.outstandingAccruedSol !== undefined &&
              ` A further ${formatSol(fees.outstandingAccruedSol)} is earned but not yet claimed.`}
          </>
        }
      />
      <StatTile label="Fees today" value={formatSol(fees?.collectedTodaySol)} hint="Claimed in the last 24 hours" />
      <StatTile label="Fees, 7 days" value={formatSol(fees?.collected7dSol)} hint={`30 days: ${formatSol(fees?.collected30dSol)}`} />
      <StatTile
        label="Net profit"
        value={netProfit === null || netProfit === undefined ? '—' : formatSol(netProfit, { sign: true })}
        tone={netProfit === null || netProfit === undefined ? 'neutral' : netProfit >= 0 ? 'positive' : 'negative'}
        hint={
          // null and undefined are different failures and deserve different
          // explanations: the service declining to convert is a decision it
          // made, a missing field is a response we cannot account for.
          netProfit === null
            ? `No SOL price has ever been recorded, so USD costs cannot be converted without inventing a rate. Excluding USD costs entirely: ${formatSol(netProfitExclUsd)}.`
            : netProfit === undefined
              ? 'The analytics response did not include a net profit figure.'
              : `Lifetime revenue less ${formatSol(totalSpend)} of spend`
        }
      />
      <StatTile
        label="Wallet balance"
        value={balance.value}
        tone={balance.measured && wallet?.belowFloor ? 'negative' : 'neutral'}
        hint={balance.hint}
      />
      <StatTile
        label="Tokens launched"
        value={formatNumber(overview?.tokens?.launched)}
        hint={`${formatNumber(overview?.tokens?.active)} active · ${formatNumber(overview?.tokens?.graduated)} graduated · ${formatNumber(overview?.tokens?.dormant)} dormant`}
      />
    </div>
  );
}

function GettingStartedTiles({ overview, status }: { overview: Overview | undefined; status: SystemStatus | undefined }) {
  const balance = walletBalanceDisplay(status?.wallet);

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile
        label="Wallet balance"
        value={balance.value}
        tone={balance.measured && status?.wallet?.belowFloor ? 'negative' : 'neutral'}
        hint={balance.hint}
      />
      <StatTile
        label="Trends active"
        value={formatNumber(overview?.pipeline?.trendsActive)}
        hint="In the working set right now"
      />
      <StatTile
        label="Opportunities today"
        value={formatNumber(overview?.pipeline?.opportunitiesDiscoveredToday)}
        hint="Discovered in the last 24 hours"
      />
      <StatTile
        label="Awaiting approval"
        value={formatNumber(overview?.pipeline?.candidatesAwaitingApproval)}
        tone={(overview?.pipeline?.candidatesAwaitingApproval ?? 0) > 0 ? 'warning' : 'neutral'}
        hint="Candidates ready for your decision"
      />
    </div>
  );
}

// --- Operating status ------------------------------------------------------

function OperatingStrip({
  status,
  loading,
  error,
  onRetry,
}: {
  status: SystemStatus | undefined;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <Card>
        <LoadingRows rows={2} />
      </Card>
    );
  }
  if (error) {
    return (
      <Card>
        <ErrorState error={error} onRetry={onRetry} />
      </Card>
    );
  }
  if (!status) {
    return (
      <Card>
        <EmptyState
          title="Operating status unavailable"
          description="The status endpoint returned nothing, so the network, phase, autonomy setting and daily limits below cannot be shown. If the server has only just started, this resolves within a few seconds."
          action={
            <button className="btn btn-ghost" onClick={onRetry}>
              Try again
            </button>
          }
        />
      </Card>
    );
  }

  const network = status.network;
  const networkTone: Tone = network === 'mainnet' ? 'negative' : network === 'devnet' ? 'warning' : 'info';
  const launchAutonomy = status.autonomy?.launch ?? 'unknown';
  const autonomyTone: Tone = launchAutonomy === 'auto' ? 'warning' : launchAutonomy === 'approve' ? 'info' : 'neutral';
  const usage = status.usage;
  const limits = usage?.limits;
  const health = status.health?.overall;

  return (
    <Card>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <StripFact label="Network">
            <Badge tone={networkTone}>{networkLabel(network)}</Badge>
          </StripFact>
          <StripFact label="Phase">
            <span className="text-sm font-medium text-ink">
              {status.phase ? humanise(status.phase.replace(/^phase\d_/, '')) : '—'}
            </span>
          </StripFact>
          <StripFact label="Launch autonomy">
            <Badge tone={autonomyTone}>
              {launchAutonomy === 'auto'
                ? 'Automatic'
                : launchAutonomy === 'approve'
                  ? 'Needs approval'
                  : launchAutonomy === 'off'
                    ? 'Off'
                    : 'Unknown'}
            </Badge>
          </StripFact>
          <StripFact label="Emergency stop">
            <Badge tone={status.emergencyStop ? 'negative' : 'positive'}>
              {status.emergencyStop ? 'Engaged' : 'Clear'}
            </Badge>
          </StripFact>
          <StripFact label="Health">
            <Badge tone={health === 'ok' ? 'positive' : health === 'degraded' ? 'warning' : health === 'down' ? 'negative' : 'neutral'}>
              {health === 'ok' ? 'Healthy' : health === 'degraded' ? 'Degraded' : health === 'down' ? 'Down' : 'Unknown'}
            </Badge>
          </StripFact>
        </div>

        <div className="grid w-full gap-3 sm:grid-cols-3 lg:max-w-xl">
          <LimitMeter
            label="Launches today"
            value={usage?.launchesToday}
            limit={limits?.maxLaunchesPerDay}
            render={(v) => formatNumber(v)}
          />
          <LimitMeter
            label="SOL spent today"
            value={usage?.solSpentToday}
            limit={limits?.maxSolSpendPerDay}
            render={(v) => formatSol(v, { digits: 3 })}
          />
          <LimitMeter
            label="AI spend today"
            value={usage?.aiSpentTodayUsd}
            limit={limits?.maxAiSpendUsdPerDay}
            render={(v) => formatUsd(v)}
          />
        </div>
      </div>

      {/*
        The health summary is the server's own sentence about its components,
        and it is the one place the operator is told that unconfigured
        providers are a normal, chosen state rather than a fault.
      */}
      {status.health?.summary && (
        <p className="mt-3 border-t border-border pt-3 text-xs leading-relaxed text-ink-muted">
          {status.health.summary}
          {status.health.checkedAt ? (
            <span className="text-ink-subtle"> Checked {formatRelative(status.health.checkedAt)}.</span>
          ) : null}
        </p>
      )}

      {status.emergencyStop && (
        <div className="mt-4">
          <Note tone="negative">
            Emergency stop is engaged. {status.emergencyStopReason || 'Every job with a side effect is suspended.'} Release
            it from System health once the cause is understood.
          </Note>
        </div>
      )}
    </Card>
  );
}

function StripFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-ink-subtle">{label}</span>
      {children}
    </div>
  );
}

function LimitMeter({
  label,
  value,
  limit,
  render,
}: {
  label: string;
  value: number | undefined;
  limit: number | undefined;
  render: (value: number | undefined) => string;
}) {
  // A limit of exactly zero is a limit — "nothing is allowed" — not a missing
  // one, and the two must not collapse into the same sentence.
  const zeroLimit = limit === 0;
  const known = value !== undefined && limit !== undefined && limit > 0;
  const ratio = known ? value / limit : 0;
  // Colour is doubled by the word beside it: a meter that only turns amber is
  // invisible to anyone who cannot see amber.
  const tone: Tone = zeroLimit
    ? 'neutral'
    : !known
      ? 'neutral'
      : ratio >= 1
        ? 'negative'
        : ratio >= 0.8
          ? 'warning'
          : 'accent';
  const state = !known ? null : ratio >= 1 ? 'at limit' : ratio >= 0.8 ? 'near limit' : null;

  const caption = zeroLimit
    ? 'Limit is zero — nothing is permitted'
    : known
      ? `${formatPercent(Math.min(ratio, 1), 0)} used${state ? ` — ${state}` : ''}`
      : limit === undefined
        ? 'No limit reported'
        : 'Usage not reported';

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-ink-muted">{label}</span>
        <span className="tnum text-xs text-ink-subtle">
          {value === undefined ? '—' : render(value)} / {limit === undefined ? '—' : render(limit)}
        </span>
      </div>
      <ScoreBar className="mt-1.5" value={known ? Math.min(ratio, 1) : 0} tone={tone} />
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px]">
        <span className={state === 'at limit' ? 'text-negative' : state === 'near limit' ? 'text-warning' : 'text-ink-subtle'}>
          {caption}
        </span>
      </div>
    </div>
  );
}

// --- Fee chart -------------------------------------------------------------

function FeeChart({ query }: { query: { isLoading: boolean; isError: boolean; error: Error | null; data: SeriesResponse | undefined; refetch: () => unknown } }) {
  if (query.isLoading) return <LoadingRows rows={4} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const points = query.data?.points ?? [];
  const hasValue = points.some((p) => (p?.value ?? 0) > 0);

  // "The series came back empty" and "every day in the series was zero" are
  // different facts. The second is a measurement; the first is not, and saying
  // "no fees were collected" on the strength of it would be a claim the
  // response does not support.
  if (points.length === 0) {
    return (
      <EmptyState
        title="No data returned for this window"
        description="The series endpoint returned no buckets at all, so nothing can be said about the last 30 days either way. This usually clears on the next refresh; if it persists the analytics job may not be running."
        action={
          <Link className="btn btn-ghost" to="/health">
            Check system health
          </Link>
        }
      />
    );
  }

  if (!hasValue) {
    return (
      <EmptyState
        title="No creator fees collected in the last 30 days"
        description={`All ${points.length} daily buckets came back at zero — that is a measurement, not missing data. Fees appear here once a launched token has earned and a collection transaction has landed.`}
        action={
          <Link className="btn btn-ghost" to="/fees">
            Open creator fees
          </Link>
        }
      />
    );
  }

  const total = points.reduce((acc, p) => acc + (p?.value ?? 0), 0);

  return (
    <div>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 8, right: 8, left: 4, bottom: 22 }}>
            <defs>
              <linearGradient id="overview-fee-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.5} />
                <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              domain={['dataMin', 'dataMax']}
              scale="time"
              tickFormatter={shortDay}
              tick={{ fontSize: 11, fill: 'var(--color-ink-subtle)' }}
              tickLine={false}
              axisLine={{ stroke: 'var(--color-border)' }}
              minTickGap={24}
              label={{ value: 'Day (UTC)', position: 'insideBottom', offset: -14, fill: 'var(--color-ink-subtle)', fontSize: 11 }}
            />
            <YAxis
              width={62}
              tick={{ fontSize: 11, fill: 'var(--color-ink-subtle)' }}
              tickLine={false}
              axisLine={{ stroke: 'var(--color-border)' }}
              tickFormatter={(v: number) => (v === 0 ? '0' : v.toFixed(v < 1 ? 3 : 1))}
              label={{ value: 'SOL', angle: -90, position: 'insideLeft', fill: 'var(--color-ink-subtle)', fontSize: 11 }}
            />
            <Tooltip content={<FeeTooltip />} cursor={{ stroke: 'var(--color-border-strong)' }} />
            <Area
              type="monotone"
              dataKey="value"
              name="Creator fees"
              stroke="var(--color-accent-soft)"
              strokeWidth={2}
              fill="url(#overview-fee-fill)"
              activeDot={{ r: 3, fill: 'var(--color-accent-soft)' }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 text-xs text-ink-subtle">
        <span className="tnum">{formatSol(total)}</span> collected across {points.length} daily buckets. Empty days are
        drawn as zero because nothing was collected, not because data is missing.
      </p>
    </div>
  );
}

function shortDay(value: number): string {
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function FeeTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.payload as SeriesPoint | undefined;
  if (!point) return null;
  return (
    <div className="card-raised px-3 py-2 text-xs shadow-lg">
      <div className="font-medium text-ink">{shortDay(point.t)}</div>
      <div className="tnum mt-1 text-accent-soft">{formatSol(point.value)}</div>
      <div className="mt-1 text-ink-subtle">
        {point.n === 0 ? 'no collections' : `${formatNumber(point.n)} collection${point.n === 1 ? '' : 's'}`}
      </div>
    </div>
  );
}

// --- Needs your attention --------------------------------------------------

interface AttentionItem {
  id: string;
  tone: Tone;
  title: string;
  detail: string;
  to?: string;
  cta?: string;
}

function buildAttention(overview: Overview | undefined, status: SystemStatus | undefined): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (status?.emergencyStop) {
    items.push({
      id: 'emergency',
      tone: 'negative',
      title: 'Emergency stop engaged',
      detail: status.emergencyStopReason || 'All jobs with side effects are suspended until it is released.',
      to: '/health',
      cta: 'System health',
    });
  }

  // `balanceSol` and `belowFloor` are both derived from a cached balance that
  // defaults to zero, so with no wallet — or with a wallet whose balance has
  // never been fetched — `belowFloor` is true for a balance nobody measured.
  // Raising a blocking alarm off that would be inventing an emergency.
  const wallet = status?.wallet;
  const balanceMeasured = Boolean(wallet?.address) && wallet?.balanceCheckedAt !== null && wallet?.balanceCheckedAt !== undefined;

  if (!wallet?.address) {
    // Unconfigured is the expected state of a fresh install and stays out of
    // the way while the platform is only doing research. It becomes worth
    // saying once the phase implies something will be spent.
    if (status?.phase && status.phase !== 'phase1_research') {
      items.push({
        id: 'wallet-missing',
        tone: 'warning',
        title: 'No operating wallet is configured',
        detail: `This phase (${humanise(status.phase.replace(/^phase\d_/, ''))}) expects to spend, and nothing can be launched or collected without a wallet.`,
        to: '/wallet',
        cta: 'Configure wallet',
      });
    }
  } else if (!balanceMeasured) {
    items.push({
      id: 'wallet-unread',
      tone: 'warning',
      title: 'The wallet balance has never been read',
      detail: 'A wallet is configured but no RPC balance check has succeeded, so the platform cannot tell whether it is funded or whether it is below its floor.',
      to: '/wallet',
      cta: 'Open wallet',
    });
  } else if (wallet.belowFloor) {
    items.push({
      id: 'wallet-floor',
      tone: 'negative',
      title: 'Wallet is below its floor',
      detail: `The operating wallet holds ${formatSol(wallet.balanceSol)} against a floor of ${formatSol(wallet.floorSol)}, read ${formatRelative(wallet.balanceCheckedAt)}. Spending is halted until it is topped up.`,
      to: '/wallet',
      cta: 'Open wallet',
    });
  }

  if (wallet?.address && wallet.canSign === false && status?.network !== 'simulation') {
    items.push({
      id: 'wallet-sign',
      tone: 'warning',
      title: 'This process cannot sign for the wallet',
      detail: 'No usable key is loaded, so no transaction can be submitted. Check the wallet custody configuration.',
      to: '/wallet',
      cta: 'Open wallet',
    });
  }

  const awaiting = overview?.pipeline?.candidatesAwaitingApproval ?? 0;
  if (awaiting > 0) {
    items.push({
      id: 'candidates',
      tone: 'warning',
      title: `${formatNumber(awaiting)} candidate${awaiting === 1 ? '' : 's'} awaiting your approval`,
      detail: 'Nothing launches while a candidate sits here. Trends go stale quickly, so a decision is worth more than a delay.',
      to: '/candidates',
      cta: 'Review candidates',
    });
  }

  const failures = status?.usage?.consecutiveFailures ?? 0;
  const shutdownAt = status?.usage?.limits?.consecutiveFailureShutdown;
  if (failures > 0) {
    items.push({
      id: 'launch-failures',
      tone: failures >= (shutdownAt ?? Infinity) ? 'negative' : 'warning',
      title: `${formatNumber(failures)} consecutive launch failure${failures === 1 ? '' : 's'}`,
      detail: shutdownAt
        ? `The platform halts itself at ${formatNumber(shutdownAt)}.`
        : 'Repeated failures usually mean an RPC or balance problem rather than a strategy problem.',
      to: '/health',
      cta: 'System health',
    });
  }

  for (const job of status?.jobs ?? []) {
    const jobFailures = job.consecutiveFailures ?? 0;
    if (jobFailures > 0 || job.lastStatus === 'error' || job.lastStatus === 'failed') {
      items.push({
        id: `job-${job.name}`,
        tone: jobFailures >= 3 ? 'negative' : 'warning',
        title: `Job "${humanise(job.name)}" is failing`,
        detail: `${jobFailures > 0 ? `${formatNumber(jobFailures)} consecutive failures. ` : ''}Last run ${formatRelative(job.lastRunAt ?? null)}.`,
        to: '/health',
        cta: 'System health',
      });
    }
  }

  for (const component of status?.health?.components ?? []) {
    if (component.state === 'down' || component.state === 'degraded') {
      items.push({
        id: `health-${component.id}`,
        tone: component.state === 'down' ? 'negative' : 'warning',
        title: `${component.label ?? humanise(component.id)} is ${component.state}`,
        detail: component.detail ?? 'No further detail was reported.',
        to: '/health',
        cta: 'System health',
      });
    }
  }

  return items;
}

function Attention({ overview, status }: { overview: Overview | undefined; status: SystemStatus | undefined }) {
  const items = buildAttention(overview, status);

  return (
    <Card>
      <SectionHeader title="Needs your attention" description="Everything the platform cannot resolve on its own." />
      {items.length === 0 ? (
        <div className="mt-2">
          <EmptyState
            icon={<span aria-hidden="true">✓</span>}
            title="Nothing needs your attention"
            description="Checked just now: no candidate is waiting for approval, the emergency stop is clear, no scheduled job is failing, and no essential component is down or degraded. Providers you have chosen not to configure are not counted as problems."
          />
        </div>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {items.map((item) => (
            <li key={item.id} className="rounded-lg border border-border bg-surface-raised/50 px-3 py-2.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={item.tone}>{item.tone === 'negative' ? 'Blocking' : 'Action'}</Badge>
                    <span className="min-w-0 break-words text-sm font-medium text-ink">{item.title}</span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-ink-muted">{item.detail}</p>
                </div>
                {item.to && (
                  <Link to={item.to} className="btn btn-ghost shrink-0 text-xs">
                    {item.cta ?? 'Open'}
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// --- Forecast --------------------------------------------------------------

function ForecastPanel({
  query,
}: {
  query: { isLoading: boolean; isError: boolean; error: Error | null; data: Forecast | undefined; refetch: () => unknown };
}) {
  return (
    <Card>
      <SectionHeader
        title="Profitability forecast"
        description="A projection of monthly net income from realised launch outcomes — not a target, and not a promise."
      />
      <div className="mt-4">
        {query.isLoading ? (
          <LoadingRows rows={3} />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : !query.data ? (
          <EmptyState title="No forecast returned" description="The forecast endpoint returned nothing to display." />
        ) : query.data.sufficient !== true ? (
          // The service refuses to project from too few launches. Showing its
          // reason is the whole point: an invented number here would be the
          // most damaging thing on the page.
          <div className="space-y-2">
            <Note tone="warning">
              <strong className="font-semibold">Not enough data to forecast.</strong>{' '}
              {query.data.reason ?? 'The analytics service reported insufficient data and declined to project a figure.'}
            </Note>
            <div className="flex items-center gap-2 text-xs text-ink-subtle">
              <span>Realised launches available:</span>
              <SampleSize n={query.data.n ?? 0} />
            </div>
          </div>
        ) : (
          <ForecastDetail forecast={query.data} />
        )}
      </div>
    </Card>
  );
}

function ForecastDetail({ forecast }: { forecast: Forecast }) {
  const scenarios: Array<{ key: 'low' | 'base' | 'high'; label: string }> = [
    { key: 'low', label: 'Low' },
    { key: 'base', label: 'Base' },
    { key: 'high', label: 'High' },
  ];

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {scenarios.map(({ key, label }) => {
          const scenario = forecast.scenarios?.[key];
          const net = scenario?.netIncomeSol;
          return (
            <div key={key} className="rounded-lg border border-border bg-surface-raised/50 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-subtle">{label}</div>
              <div
                className={`tnum mt-1 text-lg font-semibold ${
                  net === undefined ? 'text-ink' : net >= 0 ? 'text-positive' : 'text-negative'
                }`}
              >
                {net === undefined ? '—' : formatSol(net, { sign: true })}
              </div>
              <div className="tnum mt-1 text-xs text-ink-muted">
                {formatSol(scenario?.creatorFeesSol)} fees − {formatSol(scenario?.costsSol)} costs
              </div>
              {scenario?.basis && <p className="mt-1.5 text-[11px] leading-relaxed text-ink-subtle">{scenario.basis}</p>}
            </div>
          );
        })}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
        <Fact term="Launches / month" value={formatNumber(forecast.launchesPerMonth, 1)} />
        <Fact term="Median fees / launch" value={formatSol(forecast.perLaunchFeesSol?.medianSol)} />
        <Fact term="Cost / launch" value={formatSol(forecast.costPerLaunchSol)} />
      </dl>

      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-subtle">
        <span>Based on {formatNumber(forecast.windowDays)} days of realised outcomes.</span>
        <SampleSize n={forecast.n ?? forecast.perLaunchFeesSol?.n ?? 0} />
      </div>

      {forecast.launchRateBasis && <Note>{forecast.launchRateBasis}</Note>}
      {(forecast.caveats ?? []).map((caveat) => (
        <Note key={caveat} tone="warning">
          {caveat}
        </Note>
      ))}
    </div>
  );
}

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt className="text-ink-subtle">{term}</dt>
      <dd className="tnum mt-0.5 font-medium text-ink">{value}</dd>
    </div>
  );
}

// --- Revenue per launch ----------------------------------------------------

function RevenuePerLaunch({ overview }: { overview: Overview | undefined }) {
  const rpl = overview?.revenuePerLaunch;
  const n = rpl?.n ?? 0;
  const mean = rpl?.meanSol;
  const median = rpl?.medianSol;
  // The service computes this itself and returns null when the median is zero;
  // prefer its answer over recomputing one that could disagree with the tile.
  const ratio =
    rpl?.meanToMedianRatio ?? (median !== undefined && median > 0 && mean !== undefined ? mean / median : null);
  const topDecileShare = rpl?.topTenPercentShare;

  return (
    <Card>
      <SectionHeader
        title="Revenue per launch"
        description="Median and mean are shown together on purpose. One of them describes a typical launch; the other does not."
      />

      {n === 0 ? (
        <div className="mt-2">
          <EmptyState
            title="No launches have earned yet"
            description="The median and mean fill in once tokens have been launched and their fees observed. Until then there is no distribution to describe. The rates below are reported separately and may already have something to say."
          />
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-border bg-surface-raised/50 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-subtle">Median (typical)</div>
              <div className="tnum mt-1 text-xl font-semibold text-ink">{formatSol(median)}</div>
            </div>
            <div className="rounded-lg border border-border bg-surface-raised/50 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-subtle">Mean (skewed)</div>
              <div className="tnum mt-1 text-xl font-semibold text-ink-muted">{formatSol(mean)}</div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-subtle">
            <span>Across all launches with an observed outcome:</span>
            <SampleSize n={n} />
            {ratio !== null && <span className="tnum">mean / median = {ratio.toFixed(1)}×</span>}
            {rpl?.p90Sol !== undefined && <span className="tnum">90th percentile {formatSol(rpl.p90Sol)}</span>}
          </div>

          {topDecileShare !== undefined && (
            <p className="text-xs leading-relaxed text-ink-muted">
              The best-earning tenth of tokens accounts for{' '}
              <span className="tnum font-medium text-ink">{formatPercent(topDecileShare, 0)}</span> of all revenue earned.
            </p>
          )}

          <Note tone={ratio !== null && ratio >= 2 ? 'warning' : 'neutral'}>
            Token revenue is heavily skewed: a handful of tokens earn almost all of it and most earn dust. The mean is
            dragged upward by the largest one or two launches, so on its own it reads as "every launch earns this" when
            in truth almost none do. Read the median first and treat the mean as a statement about the tail.
            {ratio !== null && ratio >= 2
              ? ` Here the mean is ${ratio.toFixed(1)}× the median, which means the average is describing the tail rather than a typical launch.`
              : ''}
          </Note>

          {rpl?.reliable === false && (
            <Note tone="warning">
              Only {formatNumber(n)} launches have an observed outcome. Both figures will move a great deal with the next
              few results; treat them as an early indication rather than a measurement.
            </Note>
          )}

        </div>
      )}

      {/*
        Outside the revenue branch on purpose. Execution can have a great deal
        to say — a run of launches that never confirmed, for instance — at the
        exact moment revenue has nothing, and that is when it matters most.
      */}
      <div className="mt-4 space-y-3 border-t border-border pt-3">
        <RateRow
          label="Successful launches"
          definition="A launch counts as successful once the token has attracted at least 10 organic holders."
          rate={overview?.successfulLaunchRate}
          unit="launches"
        />
        <RateRow
          label="Graduated to an AMM"
          definition="The share of launched tokens that filled their bonding curve and moved to an AMM."
          rate={overview?.graduationRate}
          unit="tokens"
        />
        <RateRow
          label="Launch execution"
          definition="Confirmed launches over attempted ones. This measures whether transactions land, not whether the tokens do well."
          rate={overview?.launches?.executionRate}
          unit="attempts"
        />
      </div>
    </Card>
  );
}

/**
 * One rate, with everything the API knows about how much to trust it.
 *
 * Refuses to print a percentage at n = 0. A Wilson interval on zero trials is
 * arithmetically defined and completely meaningless, and "0%" beside it reads
 * as a finding rather than an absence of evidence.
 */
function RateRow({
  label,
  definition,
  rate,
  unit,
}: {
  label: string;
  definition: string;
  rate: RateEstimate | undefined;
  unit: string;
}) {
  if (!rate || rate.n === undefined) {
    return (
      <div>
        <div className="text-xs font-medium text-ink-muted">{label}</div>
        <p className="mt-1 text-xs leading-relaxed text-ink-subtle">This rate was not included in the response.</p>
      </div>
    );
  }

  if (rate.n === 0) {
    return (
      <div>
        <div className="text-xs font-medium text-ink-muted">{label}</div>
        <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
          No {unit} have been observed yet, so there is no rate to report. {definition}
        </p>
      </div>
    );
  }

  const hasInterval = rate.lower !== undefined && rate.upper !== undefined;

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-ink-muted">{label}</span>
        <span className="tnum text-sm font-semibold text-ink">{formatPercent(rate.point, 0)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-subtle">
        {hasInterval && (
          <span className="tnum">
            95% interval {formatPercent(rate.lower, 0)} – {formatPercent(rate.upper, 0)}
          </span>
        )}
        {rate.successes !== undefined && (
          <span className="tnum">
            {formatNumber(rate.successes)} of {formatNumber(rate.n)} {unit}
          </span>
        )}
        <SampleSize n={rate.n} />
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-subtle">{definition}</p>
      {rate.reliable === false && (
        <div className="mt-2">
          <Note tone="warning">
            This rate comes from {formatNumber(rate.n)} {unit}.{' '}
            {hasInterval
              ? 'The interval above is nearly as wide as the range it sits in, so the point estimate is not yet informative.'
              : 'The sample is too small for the point estimate to be informative.'}
          </Note>
        </div>
      )}
    </div>
  );
}

// --- Getting started -------------------------------------------------------

function GettingStarted({ phase }: { phase: string | undefined }) {
  const currentIndex = PHASE_LADDER.findIndex((p) => p.id === phase);

  return (
    <Card>
      <SectionHeader
        title="Nothing has been launched yet"
        description="That is the expected state of a fresh install. The platform moves up a ladder of phases, and each step has to be taken deliberately."
        action={
          <Link to="/settings" className="btn btn-primary">
            Open settings
          </Link>
        }
      />

      <ol className="mt-4 space-y-2">
        {PHASE_LADDER.map((step, index) => {
          const isCurrent = index === currentIndex;
          const isPast = currentIndex >= 0 && index < currentIndex;
          return (
            <li
              key={step.id}
              className={`flex gap-3 rounded-lg border px-3 py-2.5 ${
                isCurrent ? 'border-accent-dim bg-accent-dim/20' : 'border-border bg-surface-raised/40'
              }`}
            >
              <span
                className={`tnum mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                  isCurrent ? 'bg-accent text-white' : isPast ? 'bg-positive-dim text-positive' : 'bg-surface-hover text-ink-subtle'
                }`}
                aria-hidden="true"
              >
                {index + 1}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`text-sm font-medium ${isCurrent ? 'text-accent-soft' : 'text-ink'}`}>{step.label}</span>
                  {isCurrent && <Badge tone="accent">You are here</Badge>}
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{step.detail}</p>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="mt-4 space-y-2">
        <Note>
          Start by letting research run for a day: opportunities and concepts accumulate with nothing at stake. When you
          are ready to spend, move to devnet before mainnet — the pipeline is identical and the SOL is worthless.
        </Note>
        <div className="flex flex-wrap gap-2">
          <Link to="/opportunities" className="btn btn-ghost">
            See what research found
          </Link>
          <Link to="/settings" className="btn btn-ghost">
            Configure limits and autonomy
          </Link>
        </div>
      </div>
    </Card>
  );
}

export default OverviewPage;
