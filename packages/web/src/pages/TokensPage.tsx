import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
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
  Tabs,
  Td,
  Th,
  type Tone,
} from '@/components/ui';
import {
  formatCompact,
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
import { POLL, queryKeys, useApiQuery } from '@/lib/queries';

interface Token {
  mint: string;
  launchId?: string | null;
  conceptId?: string | null;
  trendId?: string | null;
  network?: string | null;
  name?: string | null;
  symbol?: string | null;
  imageUri?: string | null;
  lifecycle?: string | null;
  createdOnChainAt?: number | null;
  firstTradeAt?: number | null;
  lastTradeAt?: number | null;
  graduatedAt?: number | null;
  holders?: number | null;
  peakHolders?: number | null;
  marketCapUsd?: number | null;
  liquidityUsd?: number | null;
  volume24hSol?: number | null;
  volumeTotalSol?: number | null;
  txCount?: number | null;
  holderGini?: number | null;
  creatorFeesAccruedSol?: number | null;
  creatorFeesCollectedSol?: number | null;
  creatorFeesTotalSol?: number | null;
  monitorTier?: string | null;
  nextPollAt?: number | null;
  createdAt?: number | null;
}

interface MonitoringTier {
  tier: string;
  count: number;
  pollsPerHour: number;
}

interface TokensResponse {
  tokens?: Token[];
  lifecycleCounts?: Record<string, number>;
  monitoringTiers?: MonitoringTier[];
}

const PAGE_LIMIT = 50;

/**
 * Lifecycle order is the real progression a launch moves through, so the tabs
 * read left-to-right as a funnel rather than alphabetically.
 */
const LIFECYCLE_ORDER = [
  'new',
  'early_traction',
  'growing',
  'high_momentum',
  'graduated',
  'active',
  'declining',
  'dormant',
  'failed',
] as const;

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

/** Glyphs so monitoring intensity is legible without relying on colour. */
const TIER_GLYPH: Record<string, string> = {
  hot: '▮▮▮',
  warm: '▮▮▯',
  cool: '▮▯▯',
  dormant: '▯▯▯',
};

const TIER_TONE: Record<string, Tone> = {
  hot: 'accent',
  warm: 'info',
  cool: 'neutral',
  dormant: 'neutral',
};

const TIER_MEANING: Record<string, string> = {
  hot: 'Trading actively — polled at the shortest interval.',
  warm: 'Still moving, but slower — polled less often.',
  cool: 'Quiet — checked occasionally in case it wakes up.',
  dormant: 'No trades for a long time — checked rarely.',
};

type SortKey = 'name' | 'lifecycle' | 'holders' | 'volume24h' | 'marketCap' | 'fees' | 'age' | 'lastTrade';

interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

/**
 * The API reports polls/hour for the tier as a whole. Read on its own beside a
 * token count that is a different number, that invites the wrong reading, so
 * the per-token interval it implies is spelled out underneath.
 */
function perTokenInterval(tier: MonitoringTier): string {
  if (!Number.isFinite(tier.pollsPerHour) || tier.pollsPerHour <= 0 || tier.count <= 0) {
    return 'No polling interval reported.';
  }
  const seconds = 3600 / (tier.pollsPerHour / tier.count);
  if (seconds < 90) return `≈ every ${Math.round(seconds)}s per token`;
  if (seconds < 5400) return `≈ every ${Math.round(seconds / 60)}m per token`;
  return `≈ every ${(seconds / 3600).toFixed(1)}h per token`;
}

function isSimulated(token: Token): boolean {
  return (token.network ?? 'simulation') === 'simulation';
}

function num(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function bornAt(token: Token): number | null {
  return token.createdOnChainAt ?? token.createdAt ?? null;
}

function ageHours(token: Token, now: number): number | null {
  const born = bornAt(token);
  if (!born) return null;
  return (now - born) / 3_600_000;
}

export function TokensPage() {
  const [tab, setTab] = useState<string>('all');
  const [sort, setSort] = useState<SortState>({ key: 'age', dir: 'desc' });

  const path =
    tab === 'all'
      ? `/api/tokens?limit=${PAGE_LIMIT}`
      : `/api/tokens?limit=${PAGE_LIMIT}&lifecycle=${encodeURIComponent(tab)}`;

  const query = useApiQuery<TokensResponse>(queryKeys.tokens({ limit: PAGE_LIMIT, lifecycle: tab }), path, {
    refetchInterval: POLL.normal,
  });

  const tokens = useMemo(() => query.data?.tokens ?? [], [query.data]);
  // A fresh `{}` on every render would make both memos below recompute every
  // render, which is the opposite of what they are there for.
  const lifecycleCounts = useMemo(() => query.data?.lifecycleCounts ?? {}, [query.data]);
  const monitoringTiers = useMemo(() => query.data?.monitoringTiers ?? [], [query.data]);

  const totalTracked = useMemo(
    () => Object.values(lifecycleCounts).reduce((sum, n) => sum + num(n), 0),
    [lifecycleCounts],
  );

  const tabs = useMemo(() => {
    const known = LIFECYCLE_ORDER.filter((l) => lifecycleCounts[l] !== undefined);
    const extra = Object.keys(lifecycleCounts).filter(
      (l) => !(LIFECYCLE_ORDER as readonly string[]).includes(l),
    );
    return [
      { id: 'all', label: 'All', count: totalTracked },
      ...[...known, ...extra].map((l) => ({ id: l, label: humanise(l), count: num(lifecycleCounts[l]) })),
    ];
  }, [lifecycleCounts, totalTracked]);

  const now = Date.now();

  const rows = useMemo(() => {
    const direction = sort.dir === 'asc' ? 1 : -1;
    const value = (t: Token): number | string => {
      switch (sort.key) {
        case 'name':
          return (t.name ?? t.symbol ?? t.mint ?? '').toLowerCase();
        case 'lifecycle':
          return (t.lifecycle ?? '').toLowerCase();
        case 'holders':
          return num(t.holders);
        case 'volume24h':
          return num(t.volume24hSol);
        case 'marketCap':
          return num(t.marketCapUsd);
        case 'fees':
          return num(t.creatorFeesTotalSol);
        case 'lastTrade':
          return num(t.lastTradeAt);
        case 'age':
        default:
          return num(bornAt(t));
      }
    };
    return [...tokens].sort((a, b) => {
      const left = value(a);
      const right = value(b);
      if (typeof left === 'string' || typeof right === 'string') {
        return String(left).localeCompare(String(right)) * direction;
      }
      return (left - right) * direction;
    });
  }, [tokens, sort]);

  // The headline honesty check: of the tokens actually loaded, how many have
  // ever earned a lamport of creator fees?
  const earning = tokens.filter((t) => num(t.creatorFeesTotalSol) > 0).length;
  const earningRate = tokens.length > 0 ? earning / tokens.length : 0;
  const totalAccrued = tokens.reduce((sum, t) => sum + num(t.creatorFeesAccruedSol), 0);
  const totalCollected = tokens.reduce((sum, t) => sum + num(t.creatorFeesCollectedSol), 0);
  const totalFees = totalAccrued + totalCollected;
  const simulatedCount = tokens.filter(isSimulated).length;
  const truncated = tokens.length >= PAGE_LIMIT;

  /**
   * The denominator for the truncation note has to match the filter that
   * produced the rows. Comparing a lifecycle-filtered page against the global
   * total would overstate how much of the history is missing.
   */
  const scopeTotal = tab === 'all' ? totalTracked : num(lifecycleCounts[tab]);
  const scopeLabel = tab === 'all' ? 'the tokens loaded below' : `the ${humanise(tab)} tokens loaded below`;

  const toggleSort = (key: SortKey) => {
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === 'desc' ? 'asc' : 'desc' }
        : { key, dir: key === 'name' || key === 'lifecycle' ? 'asc' : 'desc' },
    );
  };

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Live tokens"
        description="Every token this platform has launched, with what it is doing now and what it has earned. Figures come from the last successful poll of each token, not from a live subscription."
      />

      {query.isError ? (
        <Card>
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </Card>
      ) : query.isLoading ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="card h-24" />
            ))}
          </div>
          <Card>
            <LoadingRows rows={8} />
          </Card>
        </div>
      ) : totalTracked === 0 && tokens.length === 0 ? (
        <Card>
          <EmptyState
            icon="◆"
            title="No tokens have been launched yet"
            description="This page fills in once a candidate is approved and a launch completes. Start at Candidates to review what the platform has generated, or at Opportunities to see the trends it is watching."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Link className="btn btn-primary" to="/candidates">
                  Review candidates
                </Link>
                <Link className="btn btn-ghost" to="/opportunities">
                  See opportunities
                </Link>
              </div>
            }
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="Tokens tracked"
              value={<Metric>{formatNumber(totalTracked)}</Metric>}
              hint="Every token in the database, across every lifecycle stage. The three tiles beside this one count only the page loaded below."
            />
            <StatTile
              label="Have earned anything"
              value={<Metric>{formatNumber(earning)}</Metric>}
              tone={earning > 0 ? 'positive' : 'neutral'}
              hint={
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  {formatPercent(earningRate, 0)} of {scopeLabel}
                  <SampleSize n={tokens.length} />
                </span>
              }
            />
            <StatTile
              label="Creator fees, loaded set"
              value={<Metric>{formatSol(totalFees, { digits: 4 })}</Metric>}
              tone={totalCollected > 0 ? 'positive' : 'neutral'}
              hint={
                <span className="block space-y-0.5">
                  <span className="block">
                    Collected (in the wallet):{' '}
                    <span className="tnum text-ink-muted">{formatSol(totalCollected, { digits: 4 })}</span>
                  </span>
                  <span className="block">
                    Accrued (still unclaimed):{' '}
                    <span className="tnum text-ink-muted">{formatSol(totalAccrued, { digits: 4 })}</span>
                  </span>
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    Summed over {scopeLabel} <SampleSize n={tokens.length} />
                  </span>
                </span>
              }
            />
            <StatTile
              label="Simulated"
              value={<Metric>{formatNumber(simulatedCount)}</Metric>}
              tone={simulatedCount > 0 ? 'warning' : 'neutral'}
              hint={
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  No on-chain existence; their figures are simulator output, not market data. Counted over {scopeLabel}
                  <SampleSize n={tokens.length} />
                </span>
              }
            />
          </div>

          {tokens.length > 0 && earningRate < 0.5 && (
            <Note tone={earning === 0 ? 'warning' : 'neutral'}>
              <strong>{formatNumber(tokens.length - earning)}</strong> of{' '}
              <strong>{formatNumber(tokens.length)}</strong> tokens shown here have earned nothing at all (
              {formatPercent(1 - earningRate, 0)}, <SampleSize n={tokens.length} />
              ). That is the normal shape of this business: a small number of launches carry the return and most produce
              no fees whatsoever. Judge the platform on the total in the fees ledger, never on the best row in this
              table.
            </Note>
          )}

          {truncated && (
            <Note tone="neutral">
              Showing the {formatNumber(tokens.length)} most recently created tokens
              {tab === 'all' ? '' : ` in ${humanise(tab)}`} out of {formatNumber(scopeTotal)}
              {tab === 'all' ? ' tracked' : ` in that stage`}. Sorting below reorders this page only — it does not
              search the full history, so the top row is the best of these {formatNumber(tokens.length)} and not
              necessarily the best overall.
            </Note>
          )}

          <Card padded={false}>
            <div className="px-4 pt-4 sm:px-5">
              <Tabs tabs={tabs} active={tab} onChange={setTab} />
            </div>

            <div className="px-4 py-4 sm:px-5">
              {tokens.length === 0 ? (
                <EmptyState
                  icon="⁝"
                  title={`No tokens in ${humanise(tab)}`}
                  description="Nothing has reached this lifecycle stage yet. Switch back to All to see everything the platform is tracking."
                  action={
                    <button className="btn btn-ghost" onClick={() => setTab('all')}>
                      Show all tokens
                    </button>
                  }
                />
              ) : (
                <DataTable>
                  <thead>
                    <tr>
                      <Th>
                        <SortButton label="Token" sortKey="name" sort={sort} onSort={toggleSort} />
                      </Th>
                      <Th>
                        <SortButton label="Lifecycle" sortKey="lifecycle" sort={sort} onSort={toggleSort} />
                      </Th>
                      <Th align="center">Monitoring</Th>
                      <Th align="right">
                        <SortButton label="Holders" sortKey="holders" sort={sort} onSort={toggleSort} align="right" />
                      </Th>
                      <Th align="right">
                        <SortButton label="24h volume" sortKey="volume24h" sort={sort} onSort={toggleSort} align="right" />
                      </Th>
                      <Th align="right">
                        <SortButton label="Market cap" sortKey="marketCap" sort={sort} onSort={toggleSort} align="right" />
                      </Th>
                      <Th align="right">
                        <SortButton label="Fees earned" sortKey="fees" sort={sort} onSort={toggleSort} align="right" />
                      </Th>
                      <Th align="right">
                        <SortButton label="Age" sortKey="age" sort={sort} onSort={toggleSort} align="right" />
                      </Th>
                      <Th align="right">
                        <SortButton label="Last trade" sortKey="lastTrade" sort={sort} onSort={toggleSort} align="right" />
                      </Th>
                      <Th>Links</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((token) => {
                      const simulated = isSimulated(token);
                      const fees = num(token.creatorFeesTotalSol);
                      const age = ageHours(token, now);
                      const tier = token.monitorTier ?? 'dormant';
                      return (
                        <tr key={token.mint} className="transition-colors hover:bg-surface-hover/60">
                          <Td className="min-w-[15rem]">
                            <div className="flex items-center gap-2.5">
                              <TokenArtwork token={token} />
                              <div className="min-w-0">
                                <Link
                                  to={`/tokens/${encodeURIComponent(token.mint)}`}
                                  className="block truncate text-sm font-medium text-ink hover:text-accent-soft"
                                >
                                  {token.name || token.symbol || truncateAddress(token.mint)}
                                </Link>
                                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                                  <span className="text-xs text-ink-subtle">
                                    ${token.symbol || '—'}
                                  </span>
                                  {simulated && (
                                    <Badge tone="warning">
                                      <span aria-hidden="true">◇</span> Simulated — no on-chain token exists
                                    </Badge>
                                  )}
                                </div>
                              </div>
                            </div>
                          </Td>
                          <Td>
                            <Badge tone={LIFECYCLE_TONE[token.lifecycle ?? ''] ?? 'neutral'}>
                              {humanise(token.lifecycle)}
                            </Badge>
                          </Td>
                          <Td align="center">
                            <span
                              className="inline-flex items-center gap-1.5 text-xs text-ink-subtle"
                              title={TIER_MEANING[tier] ?? 'Monitoring interval for this token.'}
                            >
                              <span aria-hidden="true" className="tracking-tighter">
                                {TIER_GLYPH[tier] ?? '▯▯▯'}
                              </span>
                              {humanise(tier)}
                            </span>
                          </Td>
                          <Td align="right" className="tnum text-ink">
                            {formatNumber(token.holders)}
                            {num(token.peakHolders) > num(token.holders) && (
                              <span className="ml-1 text-xs text-ink-subtle">
                                peak {formatNumber(token.peakHolders)}
                              </span>
                            )}
                          </Td>
                          <Td align="right" className="tnum">
                            {formatSol(token.volume24hSol, { digits: 2 })}
                          </Td>
                          <Td align="right" className="tnum">
                            {num(token.marketCapUsd) > 0 ? formatUsd(token.marketCapUsd, { compact: true }) : '—'}
                          </Td>
                          <Td align="right" className={`tnum ${fees > 0 ? 'text-positive' : 'text-ink-subtle'}`}>
                            {fees > 0 ? (
                              <span
                                title={`Collected (in the wallet): ${formatSol(token.creatorFeesCollectedSol, {
                                  digits: 6,
                                })} · Accrued (still unclaimed): ${formatSol(token.creatorFeesAccruedSol, {
                                  digits: 6,
                                })}`}
                              >
                                {formatSol(fees, { digits: 4 })}
                                {num(token.creatorFeesCollectedSol) <= 0 && (
                                  <span className="ml-1 text-xs font-normal text-ink-subtle">unclaimed</span>
                                )}
                              </span>
                            ) : (
                              'none'
                            )}
                          </Td>
                          <Td align="right" className="tnum">
                            {age === null ? '—' : formatDuration(age)}
                          </Td>
                          <Td align="right" className="tnum whitespace-nowrap">
                            {token.lastTradeAt ? formatRelative(token.lastTradeAt, now) : 'never traded'}
                          </Td>
                          <Td>
                            {simulated ? (
                              <span className="text-xs text-ink-subtle">No external pages</span>
                            ) : (
                              <span className="flex items-center gap-2 text-xs">
                                <a
                                  className="text-ink-subtle transition-colors hover:text-accent-soft"
                                  href={solscanUrl('token', token.mint, token.network ?? 'mainnet')}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                >
                                  Solscan
                                </a>
                                <a
                                  className="text-ink-subtle transition-colors hover:text-accent-soft"
                                  href={pumpFunUrl(token.mint)}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                >
                                  pump.fun
                                </a>
                              </span>
                            )}
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </DataTable>
              )}
            </div>

            {tokens.length > 0 && (
              <div className="px-4 pb-4 sm:px-5">
                <Note tone="neutral">
                  <strong>Fees earned</strong> is accrued plus collected. Accrued fees are a claim on a vault that a
                  collection transaction still has to succeed against; only the collected part has reached the wallet.
                  Hover any figure for the split, or open a token for its full fee history.
                </Note>
              </div>
            )}
          </Card>

          <Card>
            <SectionHeader
              title="Monitoring cost"
              description="Polling frequency drops as a token goes quiet. This is deliberate: every poll is a paid RPC or data-provider call, and a dormant token checked every thirty seconds costs money to learn nothing. A quiet token is not being ignored — it is being watched more cheaply, and it moves back up a tier as soon as it trades again."
            />
            {monitoringTiers.length === 0 ? (
              <div className="mt-4">
                <EmptyState
                  title="No monitoring tiers reported"
                  description="The monitoring service has not classified any token yet. Tiers appear after the first polling pass."
                />
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {monitoringTiers.map((tier) => (
                    <div key={tier.tier} className="rounded-xl border border-border bg-surface-raised p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                          <span aria-hidden="true" className="tracking-tighter text-ink-subtle">
                            {TIER_GLYPH[tier.tier] ?? '▯▯▯'}
                          </span>
                          {humanise(tier.tier)}
                        </span>
                        <Badge tone={TIER_TONE[tier.tier] ?? 'neutral'}>{formatNumber(tier.count)}</Badge>
                      </div>
                      <div className="tnum mt-2 text-lg font-semibold text-ink">
                        {formatCompact(tier.pollsPerHour)}
                        <span className="ml-1 text-xs font-normal text-ink-subtle">polls/hour, whole tier</span>
                      </div>
                      <p className="tnum mt-0.5 text-xs text-ink-subtle">{perTokenInterval(tier)}</p>
                      <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
                        {TIER_MEANING[tier.tier] ?? 'Custom monitoring tier.'}
                      </p>
                    </div>
                  ))}
                </div>
                <Note tone="neutral">
                  Combined:{' '}
                  <strong className="tnum">
                    {formatCompact(monitoringTiers.reduce((sum, t) => sum + num(t.pollsPerHour), 0))}
                  </strong>{' '}
                  polls per hour across{' '}
                  <strong className="tnum">{formatNumber(monitoringTiers.reduce((sum, t) => sum + num(t.count), 0))}</strong>{' '}
                  tokens. Poll intervals per tier are configured in Settings → Monitoring.
                </Note>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function SortButton({
  label,
  sortKey,
  sort,
  onSort,
  align = 'left',
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const active = sort.key === sortKey;
  const arrow = !active ? '↕' : sort.dir === 'desc' ? '↓' : '↑';
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={`inline-flex w-full items-center gap-1 text-xs font-semibold uppercase tracking-wide transition-colors ${
        align === 'right' ? 'justify-end' : 'justify-start'
      } ${active ? 'text-ink' : 'text-ink-subtle hover:text-ink-muted'}`}
      aria-label={`Sort by ${label}, ${active ? `currently ${sort.dir === 'desc' ? 'descending' : 'ascending'}` : 'not sorted'}`}
    >
      {label}
      <span aria-hidden="true" className={active ? 'text-accent-soft' : 'opacity-50'}>
        {arrow}
      </span>
    </button>
  );
}

/**
 * Token artwork is operator-supplied and frequently a dead IPFS link, so a
 * broken image falls back to the ticker rather than a browser error glyph.
 */
function TokenArtwork({ token }: { token: Token }) {
  const [failed, setFailed] = useState(false);
  const initials = (token.symbol || token.name || '?').slice(0, 3).toUpperCase();

  if (!token.imageUri || failed) {
    return (
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-raised text-[10px] font-semibold text-ink-subtle"
      >
        {initials}
      </span>
    );
  }

  return (
    <img
      src={token.imageUri}
      alt=""
      loading="lazy"
      // The URI is operator- or model-supplied and points at an arbitrary host,
      // so it must not carry the dashboard URL along with the request.
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="h-8 w-8 shrink-0 rounded-lg border border-border object-cover"
    />
  );
}

/**
 * A headline figure that can wrap rather than push the page sideways.
 *
 * A four-decimal SOL amount at `text-2xl` is wider than a half-width tile on a
 * 375px screen, and an overflowing number scrolls the whole document.
 */
function Metric({ children }: { children: ReactNode }) {
  return <span className="block break-words text-xl sm:text-2xl">{children}</span>;
}

export default TokensPage;
