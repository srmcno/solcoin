import { useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Badge,
  Card,
  CopyButton,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingRows,
  Note,
  SampleSize,
  ScoreBar,
  SectionHeader,
  Skeleton,
  StatTile,
  Td,
  Th,
  type Tone,
} from '@/components/ui';
import {
  formatCompact,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelative,
  formatSol,
  formatUsd,
  humanise,
  pumpFunUrl,
  solscanUrl,
  truncateAddress,
} from '@/lib/format';
import { POLL, queryKeys, useApiMutation, useApiQuery } from '@/lib/queries';

const LAMPORTS_PER_SOL = 1_000_000_000;

interface Token {
  mint: string;
  launchId?: string | null;
  conceptId?: string | null;
  trendId?: string | null;
  network?: string | null;
  name?: string | null;
  symbol?: string | null;
  imageUri?: string | null;
  creatorAddress?: string | null;
  lifecycle?: string | null;
  poolAddress?: string | null;
  createdOnChainAt?: number | null;
  firstTradeAt?: number | null;
  lastTradeAt?: number | null;
  graduatedAt?: number | null;
  dormantAt?: number | null;
  holders?: number | null;
  peakHolders?: number | null;
  marketCapUsd?: number | null;
  peakMarketCapUsd?: number | null;
  liquidityUsd?: number | null;
  volume1hSol?: number | null;
  volume24hSol?: number | null;
  peakVolume24hSol?: number | null;
  volumeTotalSol?: number | null;
  txCount?: number | null;
  holderGini?: number | null;
  creatorFeesAccruedSol?: number | null;
  creatorFeesCollectedSol?: number | null;
  creatorFeesTotalSol?: number | null;
  monitorTier?: string | null;
  nextPollAt?: number | null;
  dataSource?: string | null;
  createdAt?: number | null;
}

/** Observations and snapshots come straight from SQLite, so they are snake_case. */
interface ObservationRow {
  observed_at?: number | null;
  source?: string | null;
  price_sol?: number | null;
  market_cap_usd?: number | null;
  liquidity_usd?: number | null;
  volume_1h_sol?: number | null;
  volume_24h_sol?: number | null;
  holders?: number | null;
}

interface HolderRow {
  observed_at?: number | null;
  holder_count?: number | null;
  top10_share?: number | null;
  gini?: number | null;
  source?: string | null;
}

interface FeeEventRow {
  id?: string | null;
  kind?: string | null;
  vault?: string | null;
  lamports?: number | null;
  claimable_lamports?: number | null;
  usd_value?: number | null;
  transaction_signature?: string | null;
  network_fee_lamports?: number | null;
  source?: string | null;
  observed_at?: number | null;
}

interface Concept {
  id?: string | null;
  name?: string | null;
  symbol?: string | null;
  description?: string | null;
  narrative?: string | null;
  archetype?: string | null;
  reasoningSummary?: string | null;
  riskFlags?: unknown;
  isExploration?: boolean;
  explorationArm?: string | null;
}

interface Trend {
  id?: string | null;
  title?: string | null;
  summary?: string | null;
  category?: string | null;
  phase?: string | null;
  opportunityScore?: number | null;
  saturationScore?: number | null;
  sourceCount?: number | null;
}

interface Comparison {
  predicted?: {
    pFirstBuy?: number;
    pTenHolders?: number;
    pHundredHolders?: number;
    pGraduation?: number;
    volume24hSol?: number;
    creatorFeesSol?: number;
    lifespanHours?: number;
    modelVersion?: string;
  } | null;
  actual?: {
    gotFirstBuy?: boolean;
    holders?: number;
    peakHolders?: number;
    graduated?: boolean;
    volume24hSol?: number;
    peakVolume24hSol?: number;
    creatorFeesSol?: number;
    lifespanHours?: number | null;
  } | null;
}

interface TokenDetailResponse {
  token?: Token;
  observations?: ObservationRow[];
  holders?: HolderRow[];
  feeEvents?: FeeEventRow[];
  launch?: Record<string, unknown> | null;
  concept?: Concept | null;
  trend?: Trend | null;
  comparison?: Comparison | null;
}

const LIFECYCLE_TONE: Record<string, Tone> = {
  new: 'info',
  early_traction: 'info',
  growing: 'accent',
  high_momentum: 'positive',
  graduated: 'positive',
  active: 'accent',
  declining: 'warning',
  dormant: 'neutral',
  failed: 'negative',
};

const AXIS_STYLE = { fill: 'var(--color-ink-subtle)', fontSize: 11 } as const;

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function maybeNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function lamportsToSol(lamports: unknown): number {
  return num(lamports) / LAMPORTS_PER_SOL;
}

function distinctSources(rows: Array<{ source?: string | null }>): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const source = typeof row.source === 'string' ? row.source.trim() : '';
    if (source) seen.add(source);
  }
  return [...seen].sort().map((s) => humanise(s));
}

function shortTime(t: number): string {
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

interface TooltipPayloadItem {
  name?: string | number;
  value?: string | number | Array<string | number>;
  color?: string;
  dataKey?: string | number;
}

export function TokenDetailPage() {
  const { mint = '' } = useParams<{ mint: string }>();
  const query = useApiQuery<TokenDetailResponse>(queryKeys.token(mint), `/api/tokens/${encodeURIComponent(mint)}`, {
    enabled: mint.length > 0,
    refetchInterval: POLL.normal,
  });

  const refresh = useApiMutation<unknown, void>(`/api/tokens/${encodeURIComponent(mint)}/refresh`, {
    invalidate: [queryKeys.token(mint)],
  });

  const token = query.data?.token;
  const observations = useMemo(() => query.data?.observations ?? [], [query.data]);
  const holderSnapshots = useMemo(() => query.data?.holders ?? [], [query.data]);
  const feeEvents = useMemo(() => query.data?.feeEvents ?? [], [query.data]);
  const concept = query.data?.concept ?? null;
  const trend = query.data?.trend ?? null;
  const comparison = query.data?.comparison ?? null;

  const marketSeries = useMemo(
    () =>
      observations
        .map((o) => ({
          t: num(o.observed_at),
          marketCapUsd: maybeNum(o.market_cap_usd),
          volume24hSol: maybeNum(o.volume_24h_sol),
        }))
        .filter((row) => row.t > 0)
        .sort((a, b) => a.t - b.t),
    [observations],
  );

  // Which providers these points came from. Observations are deduplicated per
  // (token, source, time), so two providers that disagree both end up on the
  // same line — the reader has to be told when that is happening.
  const marketSources = useMemo(() => distinctSources(observations), [observations]);
  const holderSources = useMemo(() => distinctSources(holderSnapshots), [holderSnapshots]);

  const holderSeries = useMemo(
    () =>
      holderSnapshots
        .map((h) => ({
          t: num(h.observed_at),
          holders: maybeNum(h.holder_count),
          top10Share: maybeNum(h.top10_share),
          gini: maybeNum(h.gini),
        }))
        .filter((row) => row.t > 0 && row.holders !== null)
        .sort((a, b) => a.t - b.t),
    [holderSnapshots],
  );

  const latestHolderSnapshot = holderSeries.length > 0 ? holderSeries[holderSeries.length - 1] : undefined;

  if (query.isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-16 w-72" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-72 w-full" />
        <LoadingRows rows={5} />
      </div>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  if (!token) {
    return (
      <Card>
        <EmptyState
          icon="◆"
          title="Token not found"
          description="No token with this mint address is tracked here. It may have been pruned, or the address may be mistyped."
          action={
            <Link className="btn btn-ghost" to="/tokens">
              Back to live tokens
            </Link>
          }
        />
      </Card>
    );
  }

  const network = token.network ?? 'simulation';
  const simulated = network === 'simulation';
  const now = Date.now();
  const born = token.createdOnChainAt ?? token.createdAt ?? null;
  const age = born ? (now - born) / 3_600_000 : null;
  const accrued = num(token.creatorFeesAccruedSol);
  const collected = num(token.creatorFeesCollectedSol);
  const totalFees = num(token.creatorFeesTotalSol);
  // Collections are not free. Netting the transaction cost off is the only
  // honest way to state what this token has actually returned.
  const networkFeesPaid = feeEvents.reduce((sum, e) => sum + lamportsToSol(e.network_fee_lamports), 0);
  // `holder_gini` is NOT NULL DEFAULT 0 in the schema, so an unmeasured token
  // reports 0 — which reads as "perfectly evenly distributed" and would earn a
  // green "relatively well spread" verdict for a token nobody has ever scanned.
  // A real Gini of exactly 0 does not occur, so treat it as not measured.
  const recordedGini = num(token.holderGini) > 0 ? num(token.holderGini) : null;
  const gini = latestHolderSnapshot?.gini ?? recordedGini;
  const top10Share = latestHolderSnapshot?.top10Share ?? null;
  const concentrationFromSnapshot =
    latestHolderSnapshot !== undefined &&
    (latestHolderSnapshot.gini !== null || latestHolderSnapshot.top10Share !== null);

  return (
    <div className="space-y-5">
      <div>
        <Link to="/tokens" className="text-xs text-ink-subtle transition-colors hover:text-accent-soft">
          ← Live tokens
        </Link>

        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <Artwork token={token} />
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold tracking-tight text-ink">
                {token.name || token.symbol || truncateAddress(token.mint)}
              </h1>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-muted">
                <span className="font-medium text-accent-soft">${token.symbol || '—'}</span>
                <span aria-hidden="true" className="text-ink-subtle">
                  ·
                </span>
                <span className="tnum font-mono text-xs text-ink-subtle" title={token.mint}>
                  {truncateAddress(token.mint, 6)}
                </span>
                <CopyButton value={token.mint} label="Copy mint" />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge tone={LIFECYCLE_TONE[token.lifecycle ?? ''] ?? 'neutral'}>{humanise(token.lifecycle)}</Badge>
                <Badge tone={network === 'mainnet' ? 'negative' : network === 'devnet' ? 'warning' : 'info'}>
                  {network === 'mainnet' ? 'MAINNET' : humanise(network)}
                </Badge>
                {token.monitorTier && <Badge>Monitoring: {humanise(token.monitorTier)}</Badge>}
                {token.graduatedAt && <Badge tone="positive">Graduated {formatRelative(token.graduatedAt, now)}</Badge>}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!simulated && (
              <>
                <a
                  className="btn btn-ghost"
                  href={solscanUrl('token', token.mint, network)}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Solscan ↗
                </a>
                <a className="btn btn-ghost" href={pumpFunUrl(token.mint)} target="_blank" rel="noreferrer noopener">
                  pump.fun ↗
                </a>
              </>
            )}
            <button
              className="btn btn-ghost"
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending}
              aria-label="Refresh this token from its data provider"
            >
              {refresh.isPending ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>
      </div>

      {simulated && (
        <Note tone="warning">
          <span aria-hidden="true">◇</span> <strong>Simulated — no on-chain token exists.</strong> This mint address is
          synthetic, there is no Solscan or pump.fun page for it, and every figure below is produced by the simulator
          rather than measured from a market. Do not read any of it as revenue.
        </Note>
      )}

      {refresh.isError && <Note tone="negative">Refresh failed: {refresh.error.message}</Note>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Market cap"
          value={<Metric>{num(token.marketCapUsd) > 0 ? formatUsd(token.marketCapUsd, { compact: true }) : '—'}</Metric>}
          hint={
            num(token.peakMarketCapUsd) > 0
              ? `Peak ${formatUsd(token.peakMarketCapUsd, { compact: true })}`
              : 'No market cap has been observed yet.'
          }
        />
        <StatTile
          label="Holders"
          value={<Metric>{formatNumber(token.holders)}</Metric>}
          hint={`Peak ${formatNumber(token.peakHolders)}${holderSeries.length > 0 ? ` · ${holderSeries.length} snapshots` : ' · no snapshots recorded'}`}
        />
        <StatTile
          label="24h volume"
          value={<Metric>{formatSol(token.volume24hSol, { digits: 3 })}</Metric>}
          hint={
            num(token.peakVolume24hSol) > 0 ? `Peak 24h ${formatSol(token.peakVolume24hSol, { digits: 3 })}` : undefined
          }
        />
        <StatTile
          label="Total volume"
          value={<Metric>{formatSol(token.volumeTotalSol, { digits: 3 })}</Metric>}
          hint={`${formatNumber(token.txCount)} transactions recorded`}
        />
        <StatTile
          label="Creator fees earned"
          value={<Metric>{formatSol(totalFees, { digits: 4 })}</Metric>}
          tone={totalFees > 0 ? 'positive' : 'neutral'}
          hint={
            <span className="block space-y-0.5">
              <span className="block">
                Accrued (unclaimed): <span className="tnum text-ink-muted">{formatSol(accrued, { digits: 4 })}</span>
              </span>
              <span className="block">
                Collected (in wallet): <span className="tnum text-ink-muted">{formatSol(collected, { digits: 4 })}</span>
              </span>
            </span>
          }
        />
        <StatTile
          label="Age"
          value={<Metric>{age === null ? '—' : formatDuration(age)}</Metric>}
          hint={born ? `Created ${formatDateTime(born)}` : 'No creation timestamp recorded.'}
        />
        <StatTile
          label="Last trade"
          value={<Metric>{token.lastTradeAt ? formatRelative(token.lastTradeAt, now) : 'never'}</Metric>}
          tone={!token.lastTradeAt ? 'warning' : 'neutral'}
          hint={
            token.firstTradeAt
              ? `First trade ${formatRelative(token.firstTradeAt, now)}`
              : 'This token has never been bought.'
          }
        />
        <StatTile
          label="Liquidity"
          value={<Metric>{num(token.liquidityUsd) > 0 ? formatUsd(token.liquidityUsd, { compact: true }) : '—'}</Metric>}
          hint={token.dataSource ? `Source: ${humanise(token.dataSource)}` : 'No data source recorded.'}
        />
      </div>

      {!token.firstTradeAt && (
        <Note tone="warning">
          This token has never recorded a first buy. Everything derived from trading — volume, market cap, fees — is
          therefore zero rather than unknown.
        </Note>
      )}

      <PredictionVsActual comparison={comparison} token={token} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="min-w-0">
          <SectionHeader
            title="Market cap and volume"
            description="Every market observation stored for this token in the last 30 days. Gaps are polling gaps, not zeroes — the line connects across them."
          />
          {marketSeries.length === 0 ? (
            <div className="mt-2">
              <EmptyState
                icon="▦"
                title="No market observations yet"
                description="The monitoring job writes an observation each time it polls this token. The first one appears after the next poll."
              />
            </div>
          ) : (
            <>
              <div className="mt-4 h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={marketSeries} margin={{ top: 8, right: 8, bottom: 26, left: 0 }}>
                    <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" vertical={false} />
                    <XAxis
                      dataKey="t"
                      type="number"
                      scale="time"
                      domain={['dataMin', 'dataMax']}
                      tickFormatter={(v: number) => shortTime(v)}
                      tick={AXIS_STYLE}
                      stroke="var(--color-border-strong)"
                      minTickGap={40}
                      label={{
                        value: 'Observed at',
                        position: 'insideBottom',
                        offset: -16,
                        fill: 'var(--color-ink-subtle)',
                        fontSize: 11,
                      }}
                    />
                    <YAxis
                      yAxisId="cap"
                      tick={AXIS_STYLE}
                      stroke="var(--color-border-strong)"
                      width={58}
                      tickFormatter={(v: number) => formatUsd(v, { compact: true })}
                      label={{
                        value: 'Market cap (USD)',
                        angle: -90,
                        position: 'insideLeft',
                        fill: 'var(--color-ink-subtle)',
                        fontSize: 11,
                        style: { textAnchor: 'middle' },
                      }}
                    />
                    <YAxis
                      yAxisId="vol"
                      orientation="right"
                      tick={AXIS_STYLE}
                      stroke="var(--color-border-strong)"
                      width={52}
                      tickFormatter={(v: number) => formatCompact(v)}
                      label={{
                        value: '24h volume (SOL)',
                        angle: 90,
                        position: 'insideRight',
                        fill: 'var(--color-ink-subtle)',
                        fontSize: 11,
                        style: { textAnchor: 'middle' },
                      }}
                    />
                    <Tooltip content={<MarketTooltip />} cursor={{ stroke: 'var(--color-border-strong)' }} />
                    <Line
                      yAxisId="cap"
                      type="linear"
                      dataKey="marketCapUsd"
                      name="Market cap"
                      stroke="var(--color-accent)"
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                    <Line
                      yAxisId="vol"
                      type="linear"
                      dataKey="volume24hSol"
                      name="24h volume"
                      stroke="var(--color-info)"
                      strokeWidth={2}
                      strokeDasharray="6 3"
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-subtle">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="inline-block h-0.5 w-4 rounded-full"
                    style={{ background: 'var(--color-accent)' }}
                  />
                  Market cap (solid)
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="inline-block h-0.5 w-4 rounded-full"
                    style={{ background: 'var(--color-info)' }}
                  />
                  24h volume (dashed)
                </span>
                {marketSources.length > 0 && <span>Source: {marketSources.join(', ')}</span>}
                <SampleSize n={marketSeries.length} />
              </div>
              {marketSeries.length < 8 && (
                <div className="mt-3">
                  <Note tone="warning">
                    Only {formatNumber(marketSeries.length)} observations exist. The shape of this line is an artefact
                    of how often the token was polled, not a reliable price history.
                  </Note>
                </div>
              )}
              {marketSources.length > 1 && (
                <div className="mt-3">
                  <Note tone="warning">
                    These points come from {formatNumber(marketSources.length)} different providers (
                    {marketSources.join(', ')}) plotted on one line. Where they disagree the line will step between
                    them, and that step is a disagreement between sources rather than a movement in the market.
                  </Note>
                </div>
              )}
            </>
          )}
        </Card>

        <Card className="min-w-0">
          <SectionHeader
            title="Holder growth"
            description="Distinct holding wallets at each snapshot. Holder count is the least manipulable of the early signals, which is why the model leans on it."
          />
          {holderSeries.length === 0 ? (
            <div className="mt-2">
              <EmptyState
                icon="◍"
                title="No holder snapshots yet"
                description="Holder counts require an on-chain account scan. One is taken on each monitoring pass once the token has traded."
              />
            </div>
          ) : (
            <>
              <div className="mt-4 h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={holderSeries} margin={{ top: 8, right: 12, bottom: 26, left: 0 }}>
                    <defs>
                      <linearGradient id="holderFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--color-positive)" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="var(--color-positive)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" vertical={false} />
                    <XAxis
                      dataKey="t"
                      type="number"
                      scale="time"
                      domain={['dataMin', 'dataMax']}
                      tickFormatter={(v: number) => shortTime(v)}
                      tick={AXIS_STYLE}
                      stroke="var(--color-border-strong)"
                      minTickGap={40}
                      label={{
                        value: 'Snapshot taken at',
                        position: 'insideBottom',
                        offset: -16,
                        fill: 'var(--color-ink-subtle)',
                        fontSize: 11,
                      }}
                    />
                    <YAxis
                      tick={AXIS_STYLE}
                      stroke="var(--color-border-strong)"
                      width={48}
                      allowDecimals={false}
                      tickFormatter={(v: number) => formatCompact(v)}
                      label={{
                        value: 'Holders',
                        angle: -90,
                        position: 'insideLeft',
                        fill: 'var(--color-ink-subtle)',
                        fontSize: 11,
                        style: { textAnchor: 'middle' },
                      }}
                    />
                    <Tooltip content={<HolderTooltip />} cursor={{ stroke: 'var(--color-border-strong)' }} />
                    <Area
                      type="monotone"
                      dataKey="holders"
                      name="Holders"
                      stroke="var(--color-positive)"
                      strokeWidth={2}
                      fill="url(#holderFill)"
                      dot={false}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-subtle">
                <span>
                  {formatNumber(holderSeries.length)} snapshots between {shortTime(num(holderSeries[0]?.t))} and{' '}
                  {shortTime(num(latestHolderSnapshot?.t))}
                </span>
                {holderSources.length > 0 && <span>Source: {holderSources.join(', ')}</span>}
                <SampleSize n={holderSeries.length} />
              </div>
            </>
          )}
        </Card>
      </div>

      <Card>
        <SectionHeader
          title="Holder concentration"
          description="How evenly the supply is spread. High concentration means a few wallets hold most of the supply, so one of them selling can end the token — it is a risk signal, not an achievement."
        />
        {gini === null && top10Share === null ? (
          <div className="mt-2">
            <EmptyState
              title="Concentration has not been measured"
              description="Gini and top-10 share are computed from a holder scan. None has completed for this token yet."
            />
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-2">
            <ConcentrationMeter
              label="Gini coefficient"
              value={gini}
              display={gini === null ? '—' : gini.toFixed(3)}
              reading={giniReading(gini)}
              scale="0 = every holder holds an equal amount · 1 = one wallet holds everything"
            />
            <ConcentrationMeter
              label="Top 10 wallets hold"
              value={top10Share}
              display={top10Share === null ? '—' : formatPercent(top10Share, 1)}
              reading={top10Reading(top10Share)}
              scale="Share of circulating supply held by the ten largest wallets"
            />
            <div className="sm:col-span-2">
              {!concentrationFromSnapshot ? (
                <Note tone="warning">
                  These figures come from the denormalised token record, not from a stored holder snapshot, so there is
                  no history behind them and no way to tell how old the underlying scan is.
                </Note>
              ) : (
                <p className="text-xs text-ink-subtle">
                  Measured on the most recent snapshot, {formatRelative(num(latestHolderSnapshot?.t), now)}
                  {holderSources.length > 0 ? ` via ${holderSources.join(', ')}` : ''}.{' '}
                  <SampleSize n={holderSeries.length} />
                </p>
              )}
            </div>
          </div>
        )}
      </Card>

      <Card>
        <SectionHeader
          title="Creator fee history"
          description="Accrual snapshots record what the vaults owe; collections record what actually reached the wallet. Only collected fees are revenue."
          action={
            totalFees > 0 ? (
              <Link className="btn btn-ghost" to="/fees">
                Fees ledger
              </Link>
            ) : undefined
          }
        />
        {feeEvents.length === 0 ? (
          <div className="mt-2">
            <EmptyState
              icon="⬢"
              title="No fee events recorded"
              description="This token has not accrued or collected any creator fees. For most launches that never changes — the fee ledger stays empty."
            />
          </div>
        ) : (
          <div className="mt-4">
            <DataTable>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Event</Th>
                  <Th>Vault</Th>
                  <Th align="right">Amount</Th>
                  <Th align="right">Claimable</Th>
                  <Th align="right">Network fee paid</Th>
                  <Th align="right">USD at the time</Th>
                  <Th>Recorded by</Th>
                  <Th>Transaction</Th>
                </tr>
              </thead>
              <tbody>
                {feeEvents.map((event, index) => {
                  const kind = event.kind ?? 'unknown';
                  const signature = event.transaction_signature ?? null;
                  const networkFee = lamportsToSol(event.network_fee_lamports);
                  return (
                    <tr key={event.id ?? `${kind}-${index}`} className="transition-colors hover:bg-surface-hover/60">
                      <Td className="tnum whitespace-nowrap">{formatDateTime(maybeNum(event.observed_at))}</Td>
                      <Td>
                        <Badge tone={kind === 'collection' ? 'positive' : kind === 'adjustment' ? 'warning' : 'neutral'}>
                          {humanise(kind)}
                        </Badge>
                      </Td>
                      <Td>{humanise(event.vault)}</Td>
                      <Td align="right" className="tnum text-ink">
                        {formatSol(lamportsToSol(event.lamports), { digits: 6 })}
                      </Td>
                      <Td align="right" className="tnum">
                        {formatSol(lamportsToSol(event.claimable_lamports), { digits: 6 })}
                      </Td>
                      <Td align="right" className="tnum text-ink-subtle">
                        {networkFee > 0 ? `−${formatSol(networkFee, { digits: 6 })}` : '—'}
                      </Td>
                      <Td align="right" className="tnum">
                        {maybeNum(event.usd_value) === null ? '—' : formatUsd(event.usd_value)}
                      </Td>
                      <Td className="text-xs text-ink-subtle">{humanise(event.source)}</Td>
                      <Td>
                        {!signature ? (
                          <span className="text-xs text-ink-subtle">—</span>
                        ) : simulated ? (
                          <span className="tnum font-mono text-xs text-ink-subtle">
                            {truncateAddress(signature, 5)} (simulated)
                          </span>
                        ) : (
                          <a
                            className="tnum font-mono text-xs text-ink-subtle transition-colors hover:text-accent-soft"
                            href={solscanUrl('tx', signature, network)}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            {truncateAddress(signature, 5)} ↗
                          </a>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
            <div className="mt-3 space-y-2">
              {accrued > 0 && (
                <Note tone="neutral">
                  <strong className="tnum">{formatSol(accrued, { digits: 4 })}</strong> is accrued but not yet
                  collected. Accrued fees are a claim on a vault, not money in the wallet; a collection transaction has
                  to succeed before it counts as revenue.
                </Note>
              )}
              {networkFeesPaid > 0 && (
                <Note tone={collected - networkFeesPaid <= 0 ? 'warning' : 'neutral'}>
                  <strong className="tnum">{formatSol(networkFeesPaid, { digits: 6 })}</strong> has been paid in
                  network fees to collect against this token, against{' '}
                  <strong className="tnum">{formatSol(collected, { digits: 6 })}</strong> collected — a net of{' '}
                  <strong className="tnum">{formatSol(collected - networkFeesPaid, { digits: 6 })}</strong>.
                  {collected - networkFeesPaid <= 0 &&
                    ' Collecting from this token has cost more than it has returned.'}
                </Note>
              )}
            </div>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="min-w-0">
          <SectionHeader
            title="Where this token came from"
            description="The concept the model wrote and the trend that prompted it. Provenance is what makes a post-mortem possible."
          />
          <div className="mt-4 space-y-4">
            {concept ? (
              <div className="rounded-xl border border-border bg-surface-raised p-3.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Concept</div>
                    <div className="mt-0.5 text-sm font-medium text-ink">
                      {concept.id ? (
                        <Link
                          className="hover:text-accent-soft"
                          to={`/candidates/${encodeURIComponent(String(concept.id))}`}
                        >
                          {concept.name || 'Untitled concept'}
                        </Link>
                      ) : (
                        (concept.name ?? 'Untitled concept')
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {concept.archetype && <Badge>{humanise(concept.archetype)}</Badge>}
                    {concept.isExploration && (
                      <Badge tone="info">
                        Exploration{concept.explorationArm ? `: ${humanise(concept.explorationArm)}` : ''}
                      </Badge>
                    )}
                  </div>
                </div>
                {concept.description && (
                  <p className="mt-2 text-sm leading-relaxed text-ink-muted">{concept.description}</p>
                )}
                {concept.reasoningSummary && (
                  <div className="mt-3 border-t border-border pt-2.5">
                    <div className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Model reasoning</div>
                    <p className="mt-1 text-sm leading-relaxed text-ink-muted">{concept.reasoningSummary}</p>
                  </div>
                )}
                <RiskFlags flags={concept.riskFlags} />
              </div>
            ) : (
              <EmptyState
                title="No concept linked"
                description="This token was not created from a stored concept, so there is no generation reasoning to review."
              />
            )}

            {trend ? (
              <div className="rounded-xl border border-border bg-surface-raised p-3.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Trend</div>
                    <div className="mt-0.5 text-sm font-medium text-ink">
                      {trend.id ? (
                        <Link
                          className="hover:text-accent-soft"
                          to={`/opportunities/${encodeURIComponent(String(trend.id))}`}
                        >
                          {trend.title || 'Untitled trend'}
                        </Link>
                      ) : (
                        (trend.title ?? 'Untitled trend')
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {trend.category && <Badge>{humanise(trend.category)}</Badge>}
                    {trend.phase && <Badge tone="info">{humanise(trend.phase)}</Badge>}
                  </div>
                </div>
                {trend.summary && <p className="mt-2 text-sm leading-relaxed text-ink-muted">{trend.summary}</p>}
                <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-subtle">
                  <span className="tnum">Opportunity {formatNumber(trend.opportunityScore, 1)}</span>
                  <span className="tnum">Saturation {formatPercent(maybeNum(trend.saturationScore), 0)}</span>
                  {trend.sourceCount !== null && trend.sourceCount !== undefined && (
                    <span className="inline-flex items-center gap-1.5">
                      Independent sources <SampleSize n={num(trend.sourceCount)} minimum={2} />
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <EmptyState
                title="No trend linked"
                description="This token was not traced back to a discovered trend — it may have been launched manually."
              />
            )}
          </div>
        </Card>

        <Card className="min-w-0">
          <SectionHeader
            title="On-chain details"
            description="The addresses this token is anchored to. Copy them straight out rather than retyping."
          />
          <dl className="mt-4 space-y-2.5 text-sm">
            <AddressRow label="Mint" value={token.mint} network={network} simulated={simulated} />
            <AddressRow label="Creator" value={token.creatorAddress} network={network} simulated={simulated} />
            <AddressRow label="Pool" value={token.poolAddress} network={network} simulated={simulated} />
            <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2.5">
              <dt className="text-ink-subtle">Next scheduled poll</dt>
              <dd className="tnum text-ink-muted">
                {token.nextPollAt ? formatRelative(token.nextPollAt, now) : 'not scheduled'}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-subtle">Data source</dt>
              <dd className="text-ink-muted">{humanise(token.dataSource)}</dd>
            </div>
          </dl>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prediction vs actual
// ---------------------------------------------------------------------------

interface ProbabilityRow {
  kind: 'probability';
  metric: string;
  predicted: number;
  happened: boolean;
  actualLabel: string;
}

interface QuantityRow {
  kind: 'quantity';
  metric: string;
  predicted: number;
  actual: number | null;
  render: (value: number) => string;
  caveat?: string;
}

type ComparisonRow = ProbabilityRow | QuantityRow;

function PredictionVsActual({ comparison, token }: { comparison: Comparison | null; token: Token }) {
  const predicted = comparison?.predicted ?? null;
  const actual = comparison?.actual ?? null;

  if (!predicted || !actual) {
    return (
      <Card>
        <SectionHeader
          title="Prediction vs actual"
          description="What the model said would happen, against what did."
        />
        <div className="mt-2">
          <EmptyState
            icon="◑"
            title="No stored prediction for this token"
            description="This token was launched without a recorded forecast — either it predates prediction storage or it was launched manually. Without a prediction there is nothing to score the model against, so no accuracy figure is shown here rather than an invented one."
          />
        </div>
      </Card>
    );
  }

  const peakHolders = num(actual.peakHolders);
  const holders = num(actual.holders);
  const bestHolders = Math.max(peakHolders, holders);
  const stillLive = Boolean(token.lastTradeAt) && token.lifecycle !== 'dormant' && token.lifecycle !== 'failed';

  const rows: ComparisonRow[] = [
    {
      kind: 'probability',
      metric: 'Got a first buy',
      predicted: num(predicted.pFirstBuy),
      happened: Boolean(actual.gotFirstBuy),
      actualLabel: actual.gotFirstBuy ? 'Yes' : 'No — never traded',
    },
    {
      kind: 'probability',
      metric: 'Reached 10 holders',
      predicted: num(predicted.pTenHolders),
      happened: bestHolders >= 10,
      actualLabel: `${bestHolders >= 10 ? 'Yes' : 'No'} — peaked at ${formatNumber(bestHolders)}`,
    },
    {
      kind: 'probability',
      metric: 'Reached 100 holders',
      predicted: num(predicted.pHundredHolders),
      happened: bestHolders >= 100,
      actualLabel: `${bestHolders >= 100 ? 'Yes' : 'No'} — peaked at ${formatNumber(bestHolders)}`,
    },
    {
      kind: 'probability',
      metric: 'Graduated',
      predicted: num(predicted.pGraduation),
      happened: Boolean(actual.graduated),
      actualLabel: actual.graduated ? 'Yes' : 'No',
    },
    {
      kind: 'quantity',
      metric: '24h volume (SOL)',
      predicted: num(predicted.volume24hSol),
      actual: num(actual.peakVolume24hSol) > 0 ? num(actual.peakVolume24hSol) : num(actual.volume24hSol),
      render: (v) => formatSol(v, { digits: 3 }),
      caveat: 'Compared against the best 24h window observed, which is the most generous reading of the outcome.',
    },
    {
      kind: 'quantity',
      metric: 'Creator fees (SOL)',
      predicted: num(predicted.creatorFeesSol),
      actual: num(actual.creatorFeesSol),
      render: (v) => formatSol(v, { digits: 4 }),
      caveat: 'Accrued plus collected. Only the collected part has actually been received.',
    },
    {
      kind: 'quantity',
      metric: 'Lifespan (hours)',
      predicted: num(predicted.lifespanHours),
      actual: maybeNum(actual.lifespanHours),
      render: (v) => formatDuration(v),
      caveat: stillLive
        ? 'The token is still trading, so the actual lifespan is a lower bound and will grow.'
        : undefined,
    },
  ];

  const sentence = characteriseOutcome(rows, predicted.modelVersion);

  return (
    <Card>
      <SectionHeader
        title="Prediction vs actual"
        description="What the model said would happen, against what did. This is the only section on the page that can tell you whether the platform is learning anything."
        action={
          predicted.modelVersion ? (
            <Badge tone="neutral">Model {predicted.modelVersion}</Badge>
          ) : undefined
        }
      />

      <p className="mt-3 text-sm leading-relaxed text-ink">{sentence}</p>

      <div className="mt-4">
        <DataTable>
          <thead>
            <tr>
              <Th>Metric</Th>
              <Th align="right">Predicted</Th>
              <Th>Actual</Th>
              <Th align="right">Error</Th>
              <Th>Reading</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const verdict = rowVerdict(row);
              return (
                <tr key={row.metric} className="transition-colors hover:bg-surface-hover/60">
                  <Td className="text-ink">{row.metric}</Td>
                  <Td align="right" className="tnum text-ink">
                    {row.kind === 'probability' ? formatPercent(row.predicted, 0) : row.render(row.predicted)}
                  </Td>
                  <Td className="tnum">
                    {row.kind === 'probability'
                      ? row.actualLabel
                      : row.actual === null
                        ? 'not yet measurable'
                        : row.render(row.actual)}
                    {row.kind === 'quantity' && row.caveat && (
                      <div className="mt-0.5 text-xs leading-relaxed text-ink-subtle">{row.caveat}</div>
                    )}
                  </Td>
                  <Td align="right" className="tnum whitespace-nowrap">
                    {verdict.error}
                  </Td>
                  <Td>
                    <Badge tone={verdict.tone}>
                      <span aria-hidden="true">{verdict.glyph}</span> {verdict.label}
                    </Badge>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      </div>

      <div className="mt-4">
        <Note tone="warning">
          One token is one observation <SampleSize n={1} />. A prediction that looks well calibrated here may be luck
          and a bad miss may be variance; neither says anything about the model on its own. Model accuracy is only
          meaningful over the whole population — see <Link className="underline" to="/learning">AI learning</Link> for
          the aggregate calibration.
        </Note>
      </div>
    </Card>
  );
}

function rowVerdict(row: ComparisonRow): { error: string; label: string; tone: Tone; glyph: string } {
  if (row.kind === 'probability') {
    const outcome = row.happened ? 1 : 0;
    const gap = Math.abs(outcome - row.predicted);
    const confident = row.predicted >= 0.5;
    const correct = confident === row.happened;
    // A probability is never simply right or wrong; the honest reading is how
    // far the stated confidence sat from what happened.
    return {
      error: `${formatPercent(gap, 0)} off`,
      label: gap <= 0.25 ? 'Close' : correct ? 'Right direction' : 'Missed',
      tone: gap <= 0.25 ? 'positive' : correct ? 'neutral' : 'warning',
      glyph: gap <= 0.25 ? '✓' : correct ? '≈' : '✕',
    };
  }

  if (row.actual === null) {
    return { error: '—', label: 'Not measurable', tone: 'neutral', glyph: '·' };
  }

  const diff = row.actual - row.predicted;
  const relative = row.predicted > 0 ? Math.abs(diff) / row.predicted : null;
  const errorText =
    relative === null
      ? `${diff >= 0 ? '+' : '−'}${row.render(Math.abs(diff))}`
      : `${diff >= 0 ? '+' : '−'}${row.render(Math.abs(diff))} (${formatPercent(relative, 0)})`;

  if (relative !== null && relative <= 0.25) {
    return { error: errorText, label: 'Close', tone: 'positive', glyph: '✓' };
  }
  return {
    error: errorText,
    label: diff >= 0 ? 'Under-predicted' : 'Over-predicted',
    tone: diff >= 0 ? 'info' : 'warning',
    glyph: diff >= 0 ? '▲' : '▼',
  };
}

/**
 * A one-line plain-English reading of the comparison. Generated from the rows
 * themselves so it can never drift away from the table above it.
 */
function characteriseOutcome(rows: ComparisonRow[], modelVersion?: string): string {
  const parts: string[] = [];

  const tenHolders = rows.find((r): r is ProbabilityRow => r.kind === 'probability' && r.metric === 'Reached 10 holders');
  const firstBuy = rows.find((r): r is ProbabilityRow => r.kind === 'probability' && r.metric === 'Got a first buy');
  const fees = rows.find((r): r is QuantityRow => r.kind === 'quantity' && r.metric === 'Creator fees (SOL)');

  if (firstBuy) {
    parts.push(
      firstBuy.happened
        ? `The model gave a ${formatPercent(firstBuy.predicted, 0)} chance of a first buy, and the token was bought.`
        : `The model gave a ${formatPercent(firstBuy.predicted, 0)} chance of a first buy; nobody ever bought it.`,
    );
  }

  if (tenHolders) {
    const reached = tenHolders.actualLabel.replace(/^(Yes|No) — peaked at /, '');
    parts.push(
      tenHolders.happened
        ? `It predicted a ${formatPercent(tenHolders.predicted, 0)} chance of ten holders; it reached ${reached}.`
        : `It predicted a ${formatPercent(tenHolders.predicted, 0)} chance of ten holders; it peaked at ${reached}.`,
    );
  }

  if (fees) {
    const actualFees = fees.actual ?? 0;
    parts.push(
      actualFees <= 0
        ? `It expected ${fees.render(fees.predicted)} in creator fees and earned nothing.`
        : actualFees >= fees.predicted
          ? `It expected ${fees.render(fees.predicted)} in creator fees and earned ${fees.render(actualFees)} — ahead of forecast.`
          : `It expected ${fees.render(fees.predicted)} in creator fees and earned ${fees.render(actualFees)} — short of forecast.`,
    );
  }

  if (parts.length === 0) {
    return `A prediction${modelVersion ? ` from model ${modelVersion}` : ''} is stored for this token, but none of its metrics can be scored yet.`;
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function giniReading(gini: number | null): { text: string; tone: Tone } {
  if (gini === null) return { text: 'Not measured.', tone: 'neutral' };
  if (gini >= 0.9)
    return {
      text: 'Extremely concentrated. A handful of wallets hold nearly all of the supply and can end this token by selling.',
      tone: 'negative',
    };
  if (gini >= 0.75)
    return { text: 'Highly concentrated. A few wallets dominate the supply — treat any price as fragile.', tone: 'warning' };
  if (gini >= 0.5)
    return { text: 'Moderately concentrated, which is normal for an early token but still a real exit risk.', tone: 'warning' };
  return { text: 'Relatively well spread for a token of this size.', tone: 'positive' };
}

function top10Reading(share: number | null): { text: string; tone: Tone } {
  if (share === null) return { text: 'Not measured.', tone: 'neutral' };
  if (share >= 0.8)
    return { text: 'The ten largest wallets hold almost everything. Any one of them can move the price alone.', tone: 'negative' };
  if (share >= 0.5) return { text: 'The ten largest wallets hold the majority of supply.', tone: 'warning' };
  return { text: 'No small group of wallets controls the majority of supply.', tone: 'positive' };
}

function ConcentrationMeter({
  label,
  value,
  display,
  reading,
  scale,
}: {
  label: string;
  value: number | null;
  display: string;
  reading: { text: string; tone: Tone };
  scale: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{label}</span>
        <span className="tnum text-lg font-semibold text-ink">{display}</span>
      </div>
      {/*
        A null value must not fall back to a zero-width bar: on an inverted
        scale that renders as the healthiest possible reading, which is the
        opposite of "we never measured this".
      */}
      {value === null ? (
        <div
          className="mt-2 h-1.5 w-full rounded-full border border-dashed border-border"
          role="img"
          aria-label={`${label}: not measured`}
        />
      ) : (
        <ScoreBar className="mt-2" value={value} max={1} invert />
      )}
      <p className="mt-1.5 text-[11px] text-ink-subtle">{scale}</p>
      <p
        className={`mt-1.5 text-xs leading-relaxed ${
          reading.tone === 'negative'
            ? 'text-negative'
            : reading.tone === 'warning'
              ? 'text-warning'
              : reading.tone === 'positive'
                ? 'text-positive'
                : 'text-ink-muted'
        }`}
      >
        {reading.text}
      </p>
    </div>
  );
}

function RiskFlags({ flags }: { flags: unknown }) {
  const list = Array.isArray(flags) ? flags.filter((f): f is string => typeof f === 'string' && f.length > 0) : [];
  if (list.length === 0) {
    return <p className="mt-3 border-t border-border pt-2.5 text-xs text-ink-subtle">No risk flags were raised.</p>;
  }
  return (
    <div className="mt-3 border-t border-border pt-2.5">
      <div className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Risk flags</div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {list.map((flag) => (
          <Badge key={flag} tone="warning">
            <span aria-hidden="true">⚠</span> {humanise(flag)}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function AddressRow({
  label,
  value,
  network,
  simulated,
}: {
  label: string;
  value?: string | null;
  network: string;
  simulated: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-subtle">{label}</dt>
      <dd className="flex min-w-0 items-baseline gap-2">
        {!value ? (
          <span className="text-ink-subtle">—</span>
        ) : (
          <>
            {simulated ? (
              <span className="tnum truncate font-mono text-xs text-ink-muted" title={value}>
                {truncateAddress(value, 6)}
              </span>
            ) : (
              <a
                className="tnum truncate font-mono text-xs text-ink-muted transition-colors hover:text-accent-soft"
                href={solscanUrl('account', value, network)}
                target="_blank"
                rel="noreferrer noopener"
                title={value}
              >
                {truncateAddress(value, 6)} ↗
              </a>
            )}
            <CopyButton value={value} label="Copy" />
          </>
        )}
      </dd>
    </div>
  );
}

function Artwork({ token }: { token: Token }) {
  const [failed, setFailed] = useState(false);
  const initials = (token.symbol || token.name || '?').slice(0, 3).toUpperCase();

  if (!token.imageUri || failed) {
    return (
      <span
        aria-hidden="true"
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-raised text-xs font-semibold text-ink-subtle"
      >
        {initials}
      </span>
    );
  }

  return (
    <img
      src={token.imageUri}
      alt=""
      // Operator- or model-supplied URI pointing at an arbitrary host; it must
      // not carry the dashboard URL along with the request.
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="h-12 w-12 shrink-0 rounded-xl border border-border object-cover"
    />
  );
}

/**
 * A headline figure that wraps instead of pushing the page sideways. A
 * six-decimal SOL amount at `text-2xl` is wider than a half-width tile on a
 * 375px screen, and an overflowing number scrolls the whole document.
 */
function Metric({ children }: { children: ReactNode }) {
  return <span className="block break-words text-xl sm:text-2xl">{children}</span>;
}

function MarketTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string | number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="card-raised px-3 py-2 text-xs shadow-lg">
      <div className="tnum mb-1.5 font-medium text-ink">{typeof label === 'number' ? formatDateTime(label) : '—'}</div>
      <ul className="space-y-1">
        {payload.map((item) => (
          <li key={String(item.dataKey)} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block h-0.5 w-3 rounded-full"
              style={{ background: item.color }}
            />
            <span className="text-ink-muted">{String(item.name ?? '')}</span>
            <span className="tnum ml-auto text-ink">
              {typeof item.value !== 'number'
                ? '—'
                : item.dataKey === 'marketCapUsd'
                  ? formatUsd(item.value, { compact: true })
                  : formatSol(item.value, { digits: 3 })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HolderTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string | number;
}) {
  const first = payload?.[0];
  if (!active || !first) return null;
  return (
    <div className="card-raised px-3 py-2 text-xs shadow-lg">
      <div className="tnum mb-1 font-medium text-ink">{typeof label === 'number' ? formatDateTime(label) : '—'}</div>
      <div className="tnum text-ink-muted">
        Holders <span className="ml-1 text-ink">{typeof first.value === 'number' ? formatNumber(first.value) : '—'}</span>
      </div>
    </div>
  );
}

export default TokenDetailPage;
