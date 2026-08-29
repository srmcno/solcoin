import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingRows,
  Modal,
  Note,
  ScoreBar,
  SectionHeader,
  Skeleton,
  StatTile,
  Td,
  Th,
  type Tone,
} from '@/components/ui';
import {
  formatDateTime,
  formatNumber,
  formatPercent,
  formatRelative,
  formatSol,
  formatUsd,
  humanise,
  solscanUrl,
  truncateAddress,
} from '@/lib/format';
import { POLL, queryKeys, useApiMutation, useApiQuery } from '@/lib/queries';
import { useSession } from '@/lib/session';

const LAMPORTS_PER_SOL = 1_000_000_000;
const AXIS_STYLE = { fill: 'var(--color-ink-subtle)', fontSize: 11 } as const;

interface FeeTotals {
  collectedSol?: number | null;
  collectedTodaySol?: number | null;
  collected7dSol?: number | null;
  collected30dSol?: number | null;
  outstandingSol?: number | null;
  strandedRentSol?: number | null;
  collectionCount?: number | null;
}

/** creator_fee_events rows arrive straight from SQLite, so they are snake_case. */
interface FeeEventRow {
  id?: string | null;
  token_mint?: string | null;
  kind?: string | null;
  vault?: string | null;
  vault_address?: string | null;
  wallet_address?: string | null;
  lamports?: number | null;
  claimable_lamports?: number | null;
  usd_value?: number | null;
  sol_price_usd?: number | null;
  transaction_signature?: string | null;
  network_fee_lamports?: number | null;
  source?: string | null;
  observed_at?: number | null;
}

interface CollectionDecision {
  shouldCollect?: boolean | null;
  reason?: string | null;
  claimableLamports?: number | null;
  estimatedCostLamports?: number | null;
  valueRatio?: number | null;
}

interface FeeSettings {
  collectionThresholdSol?: number | null;
  minHoursBetweenCollections?: number | null;
  minCollectionValueRatio?: number | null;
  forceCollectionIntervalHours?: number | null;
}

interface FeesResponse {
  totals?: FeeTotals;
  history?: FeeEventRow[];
  nextCollection?: CollectionDecision | null;
  settings?: FeeSettings;
  autonomy?: string;
}

interface TokenFeeRow {
  mint?: string | null;
  name?: string | null;
  symbol?: string | null;
  lifecycle?: string | null;
  network?: string | null;
  accruedSol?: number | null;
  collectedSol?: number | null;
  totalSol?: number | null;
  volumeTotalSol?: number | null;
  createdAt?: number | null;
}

interface ByTokenResponse {
  tokens?: TokenFeeRow[];
  note?: string | null;
}

interface SystemStatus {
  network?: string;
}

interface TooltipPayloadItem {
  name?: string | number;
  value?: string | number | Array<string | number>;
  dataKey?: string | number;
  color?: string;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function maybeNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toSol(lamports: unknown): number {
  return num(lamports) / LAMPORTS_PER_SOL;
}

function shortDay(t: number): string {
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const AUTONOMY_COPY: Record<string, { tone: Tone; title: string; body: string }> = {
  auto: {
    tone: 'warning',
    title: 'Fee collection autonomy: automatic',
    body:
      'The platform submits claim transactions on its own whenever the decision below says collection is worthwhile. You do not need to press anything; you also cannot stop an individual claim except by lowering autonomy in Settings.',
  },
  approve: {
    tone: 'info',
    title: 'Fee collection autonomy: approval required',
    body:
      'The platform evaluates when a claim is worth its transaction cost but will not submit one. Fees keep accruing on chain until an operator collects them here.',
  },
  suggest: {
    tone: 'neutral',
    title: 'Fee collection autonomy: suggest only',
    body:
      'The platform reports what it would do and nothing else. Nothing is claimed until an operator presses Collect now.',
  },
  off: {
    tone: 'neutral',
    title: 'Fee collection autonomy: off',
    body:
      'Automatic collection is disabled entirely. Fees remain claimable on chain indefinitely, so nothing is lost by leaving this off — but nothing arrives in the wallet either.',
  },
};

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipPayloadItem[]; label?: string | number }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="card-raised px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-semibold text-ink">{typeof label === 'number' ? formatDateTime(label) : String(label ?? '')}</div>
      {payload.map((item, index) => (
        <div key={`${String(item.dataKey)}-${index}`} className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: item.color }} aria-hidden="true" />
          <span className="text-ink-muted">{item.name}</span>
          <span className="tnum ml-auto font-medium text-ink">{formatSol(maybeNum(item.value))}</span>
        </div>
      ))}
    </div>
  );
}

export function FeesPage() {
  const { can } = useSession();
  const [confirmOverride, setConfirmOverride] = useState(false);
  const [collectResult, setCollectResult] = useState<string | null>(null);

  const query = useApiQuery<FeesResponse>(queryKeys.fees, '/api/fees', { refetchInterval: POLL.normal });
  const byToken = useApiQuery<ByTokenResponse>(queryKeys.feesByToken, '/api/fees/by-token', {
    refetchInterval: POLL.slow,
  });
  // Fee events carry no network column, so the explorer links need the network
  // the platform is currently running against. Layout already holds this query.
  const status = useApiQuery<SystemStatus>(queryKeys.systemStatus, '/api/system/status', { refetchInterval: POLL.fast });
  const network = status.data?.network ?? 'mainnet';

  const collect = useApiMutation<{ ok?: boolean; collectedSol?: number; signature?: string }, void>('/api/fees/collect', {
    invalidate: [queryKeys.fees, queryKeys.feesByToken, queryKeys.wallet],
    onSuccess: (result) => {
      setConfirmOverride(false);
      setCollectResult(
        result?.signature
          ? `Collected ${formatSol(result.collectedSol)} — signature ${truncateAddress(result.signature, 6)}.`
          : `Collected ${formatSol(result?.collectedSol)}.`,
      );
    },
  });

  const totals = query.data?.totals;
  const decision = query.data?.nextCollection ?? null;
  const settings = query.data?.settings;
  const history = useMemo(() => query.data?.history ?? [], [query.data]);
  const tokens = useMemo(() => byToken.data?.tokens ?? [], [byToken.data]);

  const series = useMemo(() => {
    let cumulative = 0;
    return history
      .map((row) => ({ t: num(row.observed_at), amount: toSol(row.lamports) }))
      .filter((row) => row.t > 0)
      .sort((a, b) => a.t - b.t)
      .map((row) => {
        cumulative += row.amount;
        return { ...row, cumulative };
      });
  }, [history]);

  const tokenTotal = useMemo(() => tokens.reduce((sum, t) => sum + num(t.totalSol), 0), [tokens]);

  const canCollect = can('collect_fees');
  const shouldCollect = decision?.shouldCollect === true;
  const strandedRent = num(totals?.strandedRentSol);
  const collectionCount = num(totals?.collectionCount);

  if (query.isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-9 w-64" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-40 w-full" />
        <LoadingRows rows={6} />
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

  const nothingEverHappened = collectionCount === 0 && history.length === 0 && num(totals?.outstandingSol) === 0;

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Creator fees"
        description="Every token this platform launches pays its creator a share of trading fees. This page shows what has been claimed, what is still on chain, and whether claiming it right now would pay for itself."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-ghost" onClick={() => void query.refetch()} disabled={query.isFetching}>
              {query.isFetching ? 'Refreshing…' : 'Refresh'}
            </button>
            {canCollect && (
              // Not recommended is not the same as forbidden: the button stays
              // reachable but loses its primary styling and routes through a
              // modal that states the reason before anything is signed.
              <button
                className={shouldCollect ? 'btn btn-primary' : 'btn btn-ghost'}
                onClick={() => (shouldCollect ? collect.mutate() : setConfirmOverride(true))}
                disabled={collect.isPending || decision === null}
                title={
                  decision === null
                    ? 'No collection decision is available — configure an operating wallet first'
                    : shouldCollect
                      ? 'Submit a claim transaction now'
                      : decision.reason ?? 'The platform does not recommend collecting right now'
                }
              >
                {collect.isPending ? 'Collecting…' : shouldCollect ? 'Collect now' : 'Collect anyway…'}
              </button>
            )}
          </div>
        }
      />

      <AutonomyBanner autonomy={query.data?.autonomy} />

      {!canCollect && (
        <Note>
          Collecting fees requires the <strong>collect_fees</strong> permission, which your account does not have. Every
          figure on this page is still accurate and current; only the Collect action is unavailable to you.
        </Note>
      )}

      {collect.isError && (
        <Note tone="negative">
          <strong>Collection failed.</strong> {collect.error instanceof Error ? collect.error.message : 'The server rejected the claim.'}
        </Note>
      )}
      {collectResult && (
        <Note tone="positive">
          <span aria-hidden="true">✓</span> {collectResult}
        </Note>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile
          label="Collected all time"
          value={formatSol(totals?.collectedSol)}
          tone={num(totals?.collectedSol) > 0 ? 'positive' : 'neutral'}
          hint={`${formatNumber(collectionCount)} collection ${collectionCount === 1 ? 'transaction' : 'transactions'}`}
        />
        <StatTile label="Today" value={formatSol(totals?.collectedTodaySol)} hint="Since local midnight" />
        <StatTile label="Last 7 days" value={formatSol(totals?.collected7dSol)} hint="Rolling window" />
        <StatTile label="Last 30 days" value={formatSol(totals?.collected30dSol)} hint="Rolling window" />
        <StatTile
          label="Outstanding"
          value={formatSol(totals?.outstandingSol)}
          tone={num(totals?.outstandingSol) > 0 ? 'accent' : 'neutral'}
          hint="Claimable on chain right now, excluding rent"
        />
      </div>

      {/* The single most misread number on this page: the vault never empties. */}
      <Note tone={strandedRent > 0 ? 'warning' : 'neutral'}>
        <strong>
          {strandedRent > 0 ? `${formatSol(strandedRent)} is stranded rent and is not recoverable.` : 'About stranded rent.'}
        </strong>{' '}
        The bonding-curve creator vault is a rent-exempt Solana account: it must permanently retain a minimum balance to
        exist at all. That minimum can never be claimed, so the vault balance you see in an explorer and the claimable
        amount shown here will never agree. This is not a bug, a failed claim, or lost revenue in transit — it is the
        cost of holding the account open. Outstanding above already excludes it.
      </Note>

      <div className="grid gap-4 xl:grid-cols-3">
        <DecisionPanel decision={decision} settings={settings} className="xl:col-span-2" />
        <ThresholdPanel settings={settings} />
      </div>

      {nothingEverHappened ? (
        <Card>
          <EmptyState
            icon="⬢"
            title="No creator fees yet"
            description="Nothing has been claimed and nothing is currently claimable. Fees appear here once a launched token starts trading — the fee-collection job records an accrual snapshot on every poll and a collection event whenever it claims. If you have launched tokens and expect fees, check that a wallet is configured on the Wallet page and that the monitoring jobs are running."
            action={
              <Link className="btn btn-ghost" to="/tokens">
                View live tokens
              </Link>
            }
          />
        </Card>
      ) : (
        <Card>
          <SectionHeader
            title="Collection history"
            description="Each claim transaction the platform has submitted, newest first. Network fee is what the claim itself cost."
          />
          {series.length >= 2 ? (
            <div className="mt-4 h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={series} margin={{ top: 8, right: 8, bottom: 26, left: 0 }}>
                  <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" vertical={false} />
                  <XAxis
                    dataKey="t"
                    type="number"
                    scale="time"
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={(v: number) => shortDay(v)}
                    tick={AXIS_STYLE}
                    stroke="var(--color-border-strong)"
                    minTickGap={36}
                    label={{ value: 'Collected at', position: 'insideBottom', offset: -16, fill: 'var(--color-ink-subtle)', fontSize: 11 }}
                  />
                  <YAxis
                    yAxisId="amount"
                    tick={AXIS_STYLE}
                    stroke="var(--color-border-strong)"
                    width={56}
                    tickFormatter={(v: number) => v.toFixed(3)}
                    label={{
                      value: 'Per claim (SOL)',
                      angle: -90,
                      position: 'insideLeft',
                      fill: 'var(--color-ink-subtle)',
                      fontSize: 11,
                      style: { textAnchor: 'middle' },
                    }}
                  />
                  <YAxis
                    yAxisId="cumulative"
                    orientation="right"
                    tick={AXIS_STYLE}
                    stroke="var(--color-border-strong)"
                    width={56}
                    tickFormatter={(v: number) => v.toFixed(2)}
                    label={{
                      value: 'Cumulative (SOL)',
                      angle: 90,
                      position: 'insideRight',
                      fill: 'var(--color-ink-subtle)',
                      fontSize: 11,
                      style: { textAnchor: 'middle' },
                    }}
                  />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--color-surface-hover)' }} />
                  <Bar yAxisId="amount" dataKey="amount" name="Claimed" fill="var(--color-accent)" isAnimationActive={false} />
                  <Line
                    yAxisId="cumulative"
                    type="monotone"
                    dataKey="cumulative"
                    name="Cumulative"
                    stroke="var(--color-positive)"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          ) : (
            series.length === 1 && (
              <div className="mt-3">
                <Note>Only one collection has been recorded, so there is no trend to plot yet. The chart appears from the second claim onwards.</Note>
              </div>
            )
          )}

          <div className="mt-4">
            {history.length === 0 ? (
              <EmptyState
                icon="◌"
                title="No collections recorded"
                description="Fees are accruing or waiting, but no claim transaction has been submitted yet. The decision panel above explains why."
              />
            ) : (
              <DataTable>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th align="right">Claimed</Th>
                    <Th align="right">Network fee</Th>
                    <Th align="right">Net</Th>
                    <Th align="right">USD at the time</Th>
                    <Th>Vault</Th>
                    <Th>Token</Th>
                    <Th>Source</Th>
                    <Th>Signature</Th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((row, index) => {
                    const claimed = toSol(row.lamports);
                    const fee = toSol(row.network_fee_lamports);
                    const net = claimed - fee;
                    const usd = maybeNum(row.usd_value);
                    return (
                      <tr key={row.id ?? `${row.transaction_signature ?? 'row'}-${index}`} className="hover:bg-surface-hover/40">
                        <Td>
                          <span title={formatDateTime(maybeNum(row.observed_at))}>{formatRelative(maybeNum(row.observed_at))}</span>
                        </Td>
                        <Td align="right" className="tnum font-medium text-ink">
                          {formatSol(claimed)}
                        </Td>
                        <Td align="right" className="tnum">
                          {formatSol(fee)}
                        </Td>
                        <Td align="right" className={`tnum font-medium ${net >= 0 ? 'text-positive' : 'text-negative'}`}>
                          {net >= 0 ? '+' : ''}
                          {formatSol(net)}
                        </Td>
                        <Td align="right" className="tnum">
                          {usd === null ? <span className="text-ink-subtle" title="No SOL price was recorded for this event">—</span> : formatUsd(usd)}
                        </Td>
                        <Td>
                          <Badge tone={row.vault === 'amm' ? 'info' : 'neutral'}>{humanise(row.vault ?? 'curve')}</Badge>
                        </Td>
                        <Td>
                          {row.token_mint ? (
                            <Link className="text-accent-soft hover:underline" to={`/tokens/${encodeURIComponent(row.token_mint)}`}>
                              {truncateAddress(row.token_mint)}
                            </Link>
                          ) : (
                            <span className="text-ink-subtle" title="Wallet-level claim covering every token">wallet-level</span>
                          )}
                        </Td>
                        <Td className="text-ink-subtle">{humanise(row.source ?? null)}</Td>
                        <Td>
                          {row.transaction_signature ? (
                            <a
                              className="text-accent-soft hover:underline"
                              href={solscanUrl('tx', row.transaction_signature, network)}
                              target="_blank"
                              rel="noreferrer noopener"
                            >
                              {truncateAddress(row.transaction_signature, 6)}
                            </a>
                          ) : (
                            <span className="text-ink-subtle">—</span>
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </DataTable>
            )}
          </div>
        </Card>
      )}

      <Card>
        <SectionHeader
          title="Fees by token"
          description="Which launches have actually earned. Sorted by lifetime fees, accrued plus collected."
        />

        <div className="mt-3 space-y-3">
          {byToken.data?.note && <Note tone="warning">{byToken.data.note}</Note>}

          {byToken.isLoading ? (
            <LoadingRows rows={4} />
          ) : byToken.isError ? (
            <ErrorState error={byToken.error} onRetry={() => void byToken.refetch()} />
          ) : tokens.length === 0 ? (
            <EmptyState
              icon="◆"
              title="No token has earned a fee yet"
              description="A token appears here as soon as it accrues or is credited with any creator fee. If tokens are live but this is empty, either they have not traded or the fee-accrual job has not run since they did."
            />
          ) : (
            <DataTable>
              <thead>
                <tr>
                  <Th>Token</Th>
                  <Th>Lifecycle</Th>
                  <Th align="right">Accrued (est.)</Th>
                  <Th align="right">Collected (est.)</Th>
                  <Th align="right">Lifetime (est.)</Th>
                  <Th align="right">Share of fees</Th>
                  <Th align="right">Volume</Th>
                  <Th align="right">Launched</Th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((token, index) => {
                  const total = num(token.totalSol);
                  const share = tokenTotal > 0 ? total / tokenTotal : 0;
                  return (
                    <tr key={token.mint ?? index} className="hover:bg-surface-hover/40">
                      <Td>
                        {token.mint ? (
                          <Link className="min-w-0 text-accent-soft hover:underline" to={`/tokens/${encodeURIComponent(token.mint)}`}>
                            <span className="font-medium">{token.symbol ?? token.name ?? truncateAddress(token.mint)}</span>
                          </Link>
                        ) : (
                          <span className="text-ink-subtle">Unknown mint</span>
                        )}
                        {token.name && token.symbol && <div className="truncate text-xs text-ink-subtle">{token.name}</div>}
                      </Td>
                      <Td>
                        <Badge tone={lifecycleTone(token.lifecycle)}>{humanise(token.lifecycle ?? 'unknown')}</Badge>
                      </Td>
                      <Td align="right" className="tnum">
                        {formatSol(token.accruedSol)}
                      </Td>
                      <Td align="right" className="tnum">
                        {formatSol(token.collectedSol)}
                      </Td>
                      <Td align="right" className="tnum font-medium text-ink">
                        {formatSol(total)}
                      </Td>
                      <Td align="right">
                        <div className="flex items-center justify-end gap-2">
                          <span className="tnum text-xs text-ink-muted">{formatPercent(share, 1)}</span>
                          <ScoreBar value={share} className="w-14" />
                        </div>
                      </Td>
                      <Td align="right" className="tnum">
                        {formatSol(token.volumeTotalSol)}
                      </Td>
                      <Td align="right" className="text-ink-subtle">
                        <span title={formatDateTime(maybeNum(token.createdAt))}>{formatRelative(maybeNum(token.createdAt))}</span>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          )}
        </div>
      </Card>

      <Modal
        open={confirmOverride}
        onClose={() => setConfirmOverride(false)}
        title="Collect against the platform's advice?"
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setConfirmOverride(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={() => collect.mutate()} disabled={collect.isPending}>
              {collect.isPending ? 'Collecting…' : 'Collect anyway'}
            </button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-ink-muted">
          <p>The collection rules say this claim should not be submitted right now. The reason, verbatim:</p>
          <Note tone="warning">{decision?.reason ?? 'No reason was returned by the API.'}</Note>
          <dl className="grid grid-cols-2 gap-3">
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-subtle">Claimable</dt>
              <dd className="tnum text-sm font-medium text-ink">{formatSol(toSol(decision?.claimableLamports))}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-subtle">Estimated cost</dt>
              <dd className="tnum text-sm font-medium text-ink">{formatSol(toSol(decision?.estimatedCostLamports))}</dd>
            </div>
          </dl>
          <p>
            The transaction fee is spent whether or not the claim is worth it. If the claimable amount is smaller than
            the cost, submitting this destroys value. The server may also refuse the request outright.
          </p>
        </div>
      </Modal>
    </div>
  );
}

function lifecycleTone(lifecycle: string | null | undefined): Tone {
  switch (lifecycle) {
    case 'graduated':
      return 'positive';
    case 'trading':
    case 'live':
      return 'accent';
    case 'dormant':
    case 'dead':
      return 'neutral';
    case 'failed':
      return 'negative';
    default:
      return 'neutral';
  }
}

function AutonomyBanner({ autonomy }: { autonomy: string | undefined }) {
  if (!autonomy) {
    return (
      <Note>
        The API did not report a fee-collection autonomy mode, so this page cannot tell you whether the platform will
        claim fees on its own. Check Settings before relying on automatic collection.
      </Note>
    );
  }
  const copy = AUTONOMY_COPY[autonomy];
  if (!copy) {
    return (
      <Note>
        <strong>Fee collection autonomy: {humanise(autonomy)}.</strong> This dashboard does not have an explanation for
        that mode. Check Settings to see what it does.
      </Note>
    );
  }
  return (
    <Note tone={copy.tone}>
      <strong>{copy.title}.</strong> {copy.body}
    </Note>
  );
}

function DecisionPanel({
  decision,
  settings,
  className,
}: {
  decision: CollectionDecision | null;
  settings: FeeSettings | undefined;
  className?: string;
}) {
  if (!decision) {
    return (
      <Card className={className}>
        <SectionHeader title="Collection decision" />
        <div className="mt-2">
          <Note tone="warning">
            No decision could be evaluated, which normally means no operating wallet is configured — there is no creator
            address to check vaults for. Configure a wallet and this panel will fill in.
          </Note>
        </div>
      </Card>
    );
  }

  const claimable = toSol(decision.claimableLamports);
  const cost = toSol(decision.estimatedCostLamports);
  const ratio = maybeNum(decision.valueRatio);
  const required = maybeNum(settings?.minCollectionValueRatio);
  const shouldCollect = decision.shouldCollect === true;
  const ratioMeetsBar = ratio !== null && required !== null ? ratio >= required : null;

  return (
    <Card className={className}>
      <SectionHeader
        title="Collection decision"
        description="Evaluated against live vault balances every time this page loads."
        action={
          <Badge tone={shouldCollect ? 'positive' : 'neutral'}>
            {shouldCollect ? '● Will collect' : '○ Will not collect'}
          </Badge>
        }
      />

      <div className="mt-3">
        <Note tone={shouldCollect ? 'positive' : 'warning'}>
          <strong>{shouldCollect ? 'Collecting now is worthwhile.' : 'Not collecting.'}</strong> {decision.reason ?? 'The API returned no reason.'}
        </Note>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Claimable now</dt>
          <dd className="tnum mt-1 text-lg font-semibold text-ink">{formatSol(claimable)}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Estimated claim cost</dt>
          <dd className="tnum mt-1 text-lg font-semibold text-ink">{formatSol(cost)}</dd>
          <dd className="mt-0.5 text-xs text-ink-subtle">Signature and priority fees</dd>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Value ratio</dt>
          <dd
            className={`tnum mt-1 text-lg font-semibold ${
              ratioMeetsBar === null ? 'text-ink' : ratioMeetsBar ? 'text-positive' : 'text-warning'
            }`}
          >
            {ratio === null ? '—' : `${ratio.toFixed(1)}×`}
            {ratioMeetsBar === false && <span className="ml-1 text-xs font-medium">below bar</span>}
            {ratioMeetsBar === true && <span className="ml-1 text-xs font-medium">meets bar</span>}
          </dd>
          {ratio !== null && required !== null && (
            <>
              <ScoreBar value={Math.min(ratio, required * 2)} max={required * 2} tone={ratioMeetsBar ? 'positive' : 'warning'} className="mt-2" />
              <dd className="mt-1 text-xs text-ink-subtle">
                Claimable ÷ transaction cost. The bar is {required}×.
              </dd>
            </>
          )}
        </div>
      </dl>

      <p className="mt-4 text-xs leading-relaxed text-ink-muted">
        The value ratio is the real economic test: a claim costs a transaction fee whether it recovers 0.0001 SOL or 1
        SOL. Claiming a dust balance is a guaranteed loss, so small balances are deliberately left on chain to
        accumulate. Nothing expires — an unclaimed balance stays claimable indefinitely.
      </p>
    </Card>
  );
}

function ThresholdPanel({ settings }: { settings: FeeSettings | undefined }) {
  if (!settings) {
    return (
      <Card>
        <SectionHeader title="Collection rules" />
        <div className="mt-2">
          <Note>The API did not return the fee settings, so the thresholds below cannot be shown.</Note>
        </div>
      </Card>
    );
  }
  const rows: Array<{ label: string; value: string; hint: string }> = [
    {
      label: 'Collection threshold',
      value: formatSol(settings.collectionThresholdSol),
      hint: 'Minimum claimable balance before a claim is considered.',
    },
    {
      label: 'Minimum value ratio',
      value: settings.minCollectionValueRatio === null || settings.minCollectionValueRatio === undefined ? '—' : `${settings.minCollectionValueRatio}×`,
      hint: 'A claim must recover at least this multiple of its own cost.',
    },
    {
      label: 'Minimum interval',
      value: settings.minHoursBetweenCollections === null || settings.minHoursBetweenCollections === undefined ? '—' : `${settings.minHoursBetweenCollections}h`,
      hint: 'Never claim more often than this.',
    },
    {
      label: 'Forced interval',
      value: settings.forceCollectionIntervalHours ? `${settings.forceCollectionIntervalHours}h` : 'Disabled',
      hint: 'Claim regardless of threshold once this long has passed, so a slow earner is eventually swept.',
    },
  ];

  return (
    <Card>
      <SectionHeader title="Collection rules" description="Editable in Settings." />
      <dl className="mt-3 space-y-3">
        {rows.map((row) => (
          <div key={row.label}>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-sm text-ink-muted">{row.label}</dt>
              <dd className="tnum text-sm font-semibold text-ink">{row.value}</dd>
            </div>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-subtle">{row.hint}</p>
          </div>
        ))}
      </dl>
    </Card>
  );
}

export default FeesPage;
