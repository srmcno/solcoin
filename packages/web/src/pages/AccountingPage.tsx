import { useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
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
  SectionHeader,
  StatTile,
  Td,
  Th,
} from '@/components/ui';
import { downloadExport } from '@/lib/api';
import { formatDateTime, formatNumber, formatPercent, formatSol, formatUsd, humanise, solscanUrl, truncateAddress } from '@/lib/format';
import { POLL, queryKeys, useApiQuery } from '@/lib/queries';
import { useSession } from '@/lib/session';

// --- API shapes ------------------------------------------------------------
// `amountUsd`, and every USD figure derived from it, is null wherever no SOL
// price was recorded at the time of the event. The ledger never back-fills, so
// this page must render those as unvalued rather than as zero.

type RangeKey = '7d' | '30d' | '90d' | '1y' | 'all';

interface LedgerEntry {
  id?: string;
  date?: string;
  occurredAtMs?: number;
  type?: 'revenue' | 'expense';
  category?: string;
  description?: string;
  amountSol?: number;
  amountUsd?: number | null;
  solPriceUsd?: number | null;
  reference?: string | null;
  network?: string | null;
  refType?: string | null;
  refId?: string | null;
  source?: string;
  countsTowardPnl?: boolean;
  solDerivedFromUsd?: boolean;
}

interface CategoryTotal {
  category?: string;
  type?: 'revenue' | 'expense';
  entryCount?: number;
  amountSol?: number;
  amountUsd?: number;
  entriesMissingUsd?: number;
  /** Null when no entry in the bucket carried a USD valuation. */
  usdCoverage?: number | null;
  countsTowardPnl?: boolean;
}

interface AccountingSummary {
  rangeStart?: string | null;
  rangeEnd?: string | null;
  entryCount?: number;
  byCategory?: CategoryTotal[];
  revenueSol?: number;
  costSol?: number;
  netSol?: number;
  // Null, never zero, where the valued subset is empty: zero would read as
  // "no money", which is a different and usually false statement.
  revenueUsd?: number | null;
  costUsd?: number | null;
  netUsd?: number | null;
  entriesMissingUsd?: number;
  usdCoverage?: number;
  /** Valuation coverage per side; the two routinely differ. */
  revenueEntryCount?: number;
  revenueEntriesMissingUsd?: number;
  costEntryCount?: number;
  costEntriesMissingUsd?: number;
  entriesMissingSol?: number;
  transferCount?: number;
  transferInSol?: number;
  transferOutSol?: number;
  /** Gross movement, in + out. Not a balance. */
  transferSol?: number;
  notes?: string[];
  disclaimer?: string;
}

interface LedgerResponse {
  entries?: LedgerEntry[];
  summary?: AccountingSummary;
}

interface MonthlyRow {
  month?: string;
  revenueSol?: number;
  costSol?: number;
  netSol?: number;
  revenueUsd?: number | null;
  costUsd?: number | null;
  netUsd?: number | null;
  /** P&L entries behind the month's totals, and how many carried no price. */
  entryCount?: number;
  entriesMissingUsd?: number;
  launches?: number;
}

interface MonthlyResponse {
  months?: MonthlyRow[];
}

/** The network the platform is currently executing against. */
interface SystemStatus {
  network?: string;
}

// `short` is what fits five buttons across a 375px phone; `label` is the
// accessible name, so the control never becomes "7d" to a screen reader.
const RANGES: Array<{ id: RangeKey; label: string; short: string }> = [
  { id: '7d', label: 'Last 7 days', short: '7d' },
  { id: '30d', label: 'Last 30 days', short: '30d' },
  { id: '90d', label: 'Last 90 days', short: '90d' },
  { id: '1y', label: 'Last year', short: '1y' },
  { id: 'all', label: 'All time', short: 'All' },
];

const PAGE_SIZES = [50, 100, 200] as const;

/**
 * Base58 with no 0/O/I/l, at signature length. Only a reference that looks like
 * a real signature becomes a Solscan link — a dead link on an internal id would
 * imply an on-chain record that does not exist.
 */
const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{80,100}$/;

export default function AccountingPage() {
  const { can } = useSession();
  const [range, setRange] = useState<RangeKey>('30d');
  const [limit, setLimit] = useState<number>(100);
  const [offset, setOffset] = useState<number>(0);
  const [exporting, setExporting] = useState<'csv' | 'json' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const ledgerQuery = useApiQuery<LedgerResponse>(
    [...queryKeys.accountingLedger(range), limit, offset],
    `/api/accounting/ledger?range=${range}&limit=${limit}&offset=${offset}`,
    { refetchInterval: POLL.slow },
  );
  const monthlyQuery = useApiQuery<MonthlyResponse>(queryKeys.accountingMonthly, '/api/accounting/monthly', {
    refetchInterval: POLL.slow,
  });
  // Ledger entries from off-chain sources carry no network of their own, so the
  // explorer links need the network the platform is running against — and on
  // simulation there is no chain to link to at all.
  const statusQuery = useApiQuery<SystemStatus>(queryKeys.systemStatus, '/api/system/status', {
    refetchInterval: POLL.slow,
  });
  const platformNetwork = statusQuery.data?.network;

  const summary = ledgerQuery.data?.summary;
  const entries = ledgerQuery.data?.entries ?? [];
  const total = summary?.entryCount ?? 0;
  const canExport = can('export_accounting');
  // Only counted over the page in hand: the summary carries no network split,
  // so a claim about the whole range would be one this page cannot support.
  const simulatedOnPage = entries.filter((entry) => entry.network === 'simulation').length;

  const changeRange = (next: RangeKey) => {
    setRange(next);
    setOffset(0);
  };

  const runExport = async (format: 'csv' | 'json') => {
    setExportError(null);
    setExporting(format);
    try {
      await downloadExport(`/api/accounting/export?format=${format}&range=all`, `solcoin-ledger.${format}`);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'The export could not be produced.');
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Accounting"
        description="Every economic event the platform caused, as it was recorded. Nothing here is smoothed, estimated or back-filled."
        action={<RangeSelector value={range} onChange={changeRange} />}
      />

      {canExport ? (
        // Kept out of the header action so the row cannot outgrow a 375px
        // screen, and so the buttons sit beside the caveat that qualifies them.
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={exporting !== null}
            onClick={() => void runExport('csv')}
          >
            {exporting === 'csv' ? 'Preparing…' : 'Export CSV'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={exporting !== null}
            onClick={() => void runExport('json')}
          >
            {exporting === 'json' ? 'Preparing…' : 'Export JSON'}
          </button>
          <p className="text-xs text-ink-subtle">
            Exports always cover the full ledger, not the selected range, and are recorded in the audit log.
          </p>
        </div>
      ) : (
        <Note>
          Exporting the ledger requires the <code className="font-mono">export_accounting</code> permission, which this
          account does not have. An owner or admin can grant it in Settings.
        </Note>
      )}

      {exportError && <Note tone="negative">Export failed: {exportError}</Note>}

      {platformNetwork === 'simulation' && (
        <Note tone="warning">
          <strong className="font-semibold">The platform is running on the simulation network.</strong> Launches and fee
          claims are executed against the simulation adapter, which fabricates mint addresses, transaction signatures and
          amounts. Entries produced that way are recorded in this ledger exactly like real ones, so the revenue, cost and
          net figures below can include money that never moved. Rows marked <em>simulated</em> carry no explorer link
          because there is no chain behind them.
        </Note>
      )}

      {platformNetwork !== 'simulation' && simulatedOnPage > 0 && (
        <Note tone="warning">
          {formatNumber(simulatedOnPage)} of the {formatNumber(entries.length)} entr
          {entries.length === 1 ? 'y' : 'ies'} on this page {simulatedOnPage === 1 ? 'was' : 'were'} recorded against the
          simulation network. No SOL moved for {simulatedOnPage === 1 ? 'it' : 'them'}, but{' '}
          {simulatedOnPage === 1 ? 'it counts' : 'they count'} toward the totals above, which the accounting service does
          not split by network.
        </Note>
      )}

      {summary?.disclaimer && <Note tone="warning">{summary.disclaimer}</Note>}

      <SummaryTiles query={ledgerQuery} />

      <CategoryPanel query={ledgerQuery} />

      <MonthlyPanel query={monthlyQuery} />

      <Card padded={false}>
        <div className="p-4 sm:p-5">
          <SectionHeader
            title="Ledger"
            description="One row per economic event, newest first. Transfers between the platform's own wallets are listed for completeness and excluded from revenue, costs and net."
            action={
              <div className="min-w-[9rem]">
                <label className="label" htmlFor="ledger-page-size">
                  Rows per page
                </label>
                <select
                  id="ledger-page-size"
                  className="input"
                  value={limit}
                  onChange={(event) => {
                    setLimit(Number(event.target.value));
                    setOffset(0);
                  }}
                >
                  {PAGE_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </div>
            }
          />
        </div>

        <div className="px-4 pb-4 sm:px-5 sm:pb-5">
          {ledgerQuery.isLoading ? (
            <LoadingRows rows={8} />
          ) : ledgerQuery.isError ? (
            <ErrorState error={ledgerQuery.error} onRetry={() => void ledgerQuery.refetch()} />
          ) : entries.length === 0 ? (
            <EmptyState
              icon="▤"
              title={range === 'all' ? 'The ledger is empty' : 'No entries in this range'}
              description={
                range === 'all'
                  ? 'Entries appear here automatically as the platform spends and earns: launch costs the moment a launch confirms, AI and infrastructure costs as they are billed, and creator fees when a collection lands on-chain.'
                  : 'Nothing was recorded in this window. Widen the range to All time to see everything the platform has recorded so far.'
              }
            />
          ) : (
            <>
              <LedgerTable entries={entries} platformNetwork={platformNetwork} />
              <Pagination
                offset={offset}
                limit={limit}
                shown={entries.length}
                total={total}
                onChange={setOffset}
              />
            </>
          )}
        </div>
      </Card>

      {(summary?.notes ?? []).length > 0 && (
        <Card>
          <SectionHeader title="How to read these figures" description="Reported by the accounting service alongside the totals." />
          <ul className="mt-3 space-y-2">
            {(summary?.notes ?? []).map((note) => (
              <li key={note}>
                <Note>{note}</Note>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

export { AccountingPage };

// --- Range selector --------------------------------------------------------

function RangeSelector({ value, onChange }: { value: RangeKey; onChange: (next: RangeKey) => void }) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Ledger range">
      {RANGES.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            aria-label={option.label}
            title={option.label}
            onClick={() => onChange(option.id)}
            className={
              active
                ? 'rounded-lg border border-accent-dim bg-accent-dim/40 px-2.5 py-1.5 text-xs font-semibold text-accent-soft'
                : 'rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink'
            }
          >
            {option.short}
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

// --- Summary ---------------------------------------------------------------

/**
 * A USD total is only as good as the share of entries that carried a price when
 * the event happened, so it is never shown without that share. A null total is
 * stated as unvalued rather than rendered as an em dash on its own — the reader
 * needs to know a number is missing, not merely absent.
 */
function usdHint(
  usd: number | null | undefined,
  entryCount: number | undefined,
  missing: number | undefined,
  side: 'revenue' | 'cost',
): string {
  if (usd === null || usd === undefined) {
    return `No ${side} entry in range carried a recorded SOL price, so there is no USD total to state.`;
  }
  const total = entryCount ?? 0;
  const priced = Math.max(0, total - (missing ?? 0));
  if (total === 0) return `${formatUsd(usd)} across the entries that carry a recorded USD value`;
  return `${formatUsd(usd)} across ${formatNumber(priced)} of ${formatNumber(total)} ${side} entries — the rest carried no recorded price`;
}

function SummaryTiles({ query }: { query: QueryLike<LedgerResponse> }) {
  if (query.isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="card h-24 animate-pulse bg-surface-raised/40" />
        ))}
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

  const summary = query.data?.summary;
  const entryCount = summary?.entryCount ?? 0;
  const missingUsd = summary?.entriesMissingUsd ?? 0;
  const net = summary?.netSol;

  if (entryCount === 0) {
    return (
      <Card>
        <EmptyState
          icon="◇"
          title="Nothing recorded in this range"
          description="Revenue and cost tiles appear once the ledger has at least one entry in the selected window."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Revenue"
          value={formatSol(summary?.revenueSol)}
          tone={(summary?.revenueSol ?? 0) > 0 ? 'positive' : 'neutral'}
          hint={usdHint(summary?.revenueUsd, summary?.revenueEntryCount, summary?.revenueEntriesMissingUsd, 'revenue')}
        />
        <StatTile
          label="Costs"
          value={formatSol(summary?.costSol)}
          hint={usdHint(summary?.costUsd, summary?.costEntryCount, summary?.costEntriesMissingUsd, 'cost')}
        />
        <StatTile
          label="Net"
          value={net === undefined ? '—' : formatSol(net, { sign: true })}
          tone={net === undefined ? 'neutral' : net >= 0 ? 'positive' : 'negative'}
          hint={`Over ${formatNumber(entryCount)} entries. ${formatNumber(summary?.transferCount)} internal transfer${
            (summary?.transferCount ?? 0) === 1 ? '' : 's'
          } excluded: ${formatSol(summary?.transferInSol)} in, ${formatSol(summary?.transferOutSol)} out`}
        />
        <StatTile
          label="Entries without a USD value"
          value={formatNumber(missingUsd)}
          tone={missingUsd > 0 ? 'warning' : 'positive'}
          hint={
            missingUsd > 0
              ? `USD totals above describe ${formatPercent(summary?.usdCoverage, 0)} of the ${formatNumber(entryCount)} entries in range`
              : 'Every entry in range carries a recorded SOL price'
          }
        />
      </div>

      {(summary?.entriesMissingSol ?? 0) > 0 && (
        <Note tone="warning">
          {formatNumber(summary?.entriesMissingSol)} entr{(summary?.entriesMissingSol ?? 0) === 1 ? 'y was' : 'ies were'}{' '}
          billed in USD with no SOL price recorded. They contribute to the USD cost total but not to the SOL one, so the SOL
          net above is understated by that amount.
        </Note>
      )}
    </div>
  );
}

// --- Category breakdown ----------------------------------------------------

/**
 * The summary's own bucketing, shown as it arrives. Buckets are keyed by
 * category *and* direction — `wallet_transfer` carries both an inbound and an
 * outbound stream — so the two are listed separately rather than netted.
 */
function CategoryPanel({ query }: { query: QueryLike<LedgerResponse> }) {
  const rows = (query.data?.summary?.byCategory ?? []).filter((row) => Boolean(row?.category));
  const sorted = [...rows].sort((a, b) => Math.abs(b.amountSol ?? 0) - Math.abs(a.amountSol ?? 0));

  // Loading, error and empty are all already stated by the summary tiles above,
  // which read the same query. Repeating them here would show one failure three
  // times, so this panel simply stands down until it has rows.
  if (query.isLoading || query.isError || sorted.length === 0) return null;

  return (
    <Card>
      <SectionHeader
        title="By category"
        description="Where the SOL in this range came from and went, split by category and direction. Every bucket carries the number of entries behind it."
      />
      <div className="mt-4">
        <DataTable>
          <thead>
            <tr>
              <Th>Category</Th>
              <Th>Direction</Th>
              <Th align="right">Entries</Th>
              <Th align="right">SOL</Th>
              <Th align="right">USD</Th>
              <Th>In P&amp;L</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const revenue = row.type === 'revenue';
              const missing = row.entriesMissingUsd ?? 0;
              const count = row.entryCount ?? 0;
              return (
                <tr key={`${row.category}-${row.type}`}>
                  <Td className="font-medium text-ink">{humanise(row.category)}</Td>
                  <Td>
                    <Badge tone={revenue ? 'positive' : 'neutral'}>{revenue ? '↑ Revenue' : '↓ Expense'}</Badge>
                  </Td>
                  <Td align="right" className="tnum">
                    {formatNumber(count)}
                  </Td>
                  <Td align="right" className={`tnum ${revenue ? 'text-positive' : 'text-ink'}`}>
                    {formatSol(row.amountSol)}
                  </Td>
                  <Td align="right" className="tnum whitespace-nowrap">
                    {row.usdCoverage === null || row.usdCoverage === undefined || missing >= count ? (
                      <span
                        className="text-ink-subtle"
                        title="No entry in this bucket carried a SOL price at the time of the event"
                      >
                        not valued
                      </span>
                    ) : (
                      <>
                        {formatUsd(row.amountUsd)}
                        {missing > 0 && (
                          <span
                            className="ml-1 text-xs text-warning"
                            title={`${missing} of ${count} entries in this bucket carried no recorded price and are excluded from the USD figure`}
                          >
                            {formatPercent(row.usdCoverage, 0)} priced
                          </span>
                        )}
                      </>
                    )}
                  </Td>
                  <Td>
                    {row.countsTowardPnl === false ? (
                      <span
                        className="text-xs text-ink-subtle"
                        title="A movement between the platform's own wallets, excluded from revenue, costs and net"
                      >
                        excluded
                      </span>
                    ) : (
                      <span className="text-xs text-ink-subtle">counted</span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      </div>
    </Card>
  );
}

// --- Monthly breakdown -----------------------------------------------------

function MonthlyPanel({ query }: { query: QueryLike<MonthlyResponse> }) {
  const months = (query.data?.months ?? []).filter((row): row is MonthlyRow => Boolean(row?.month));
  const hasMovement = months.some((row) => (row.revenueSol ?? 0) !== 0 || (row.costSol ?? 0) !== 0);

  return (
    <Card>
      <SectionHeader
        title="Monthly breakdown"
        description="Revenue against cost per UTC calendar month, over the whole ledger rather than the selected range."
      />

      <div className="mt-4">
        {query.isLoading ? (
          <LoadingRows rows={5} />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : months.length === 0 || !hasMovement ? (
          <EmptyState
            icon="◫"
            title="No month has any recorded revenue or cost yet"
            description="This chart is drawn only from months that actually contain entries. Bars at zero would look like a measured result, so nothing is drawn until there is something to draw."
          />
        ) : (
          <div className="space-y-4">
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={months} margin={{ top: 8, right: 8, left: 4, bottom: 28 }}>
                  <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="month"
                    tick={{ fontSize: 11, fill: 'var(--color-ink-subtle)' }}
                    tickLine={false}
                    axisLine={{ stroke: 'var(--color-border)' }}
                    label={{ value: 'Month (UTC)', position: 'insideBottom', offset: -18, fill: 'var(--color-ink-subtle)', fontSize: 11 }}
                  />
                  <YAxis
                    width={64}
                    tick={{ fontSize: 11, fill: 'var(--color-ink-subtle)' }}
                    tickLine={false}
                    axisLine={{ stroke: 'var(--color-border)' }}
                    tickFormatter={(value: number) => (value === 0 ? '0' : value.toFixed(value < 1 ? 3 : 1))}
                    label={{ value: 'SOL', angle: -90, position: 'insideLeft', fill: 'var(--color-ink-subtle)', fontSize: 11 }}
                  />
                  <Tooltip content={<MonthlyTooltip />} cursor={{ fill: 'var(--color-surface-hover)' }} />
                  <Legend
                    wrapperStyle={{ fontSize: 12, color: 'var(--color-ink-muted)', paddingTop: 8 }}
                    iconType="square"
                  />
                  <Bar dataKey="revenueSol" name="Revenue" fill="var(--color-positive)" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="costSol" name="Cost" fill="var(--color-negative)" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <DataTable>
              <thead>
                <tr>
                  <Th>Month</Th>
                  <Th align="right">Revenue</Th>
                  <Th align="right">Cost</Th>
                  <Th align="right">Net</Th>
                  <Th align="right">Net (USD)</Th>
                  <Th align="right">Entries</Th>
                  <Th align="right">Launches</Th>
                </tr>
              </thead>
              <tbody>
                {months.map((row) => {
                  const net = row.netSol ?? 0;
                  return (
                    <tr key={row.month}>
                      <Td className="font-medium text-ink">{row.month}</Td>
                      <Td align="right" className="tnum">
                        {formatSol(row.revenueSol)}
                      </Td>
                      <Td align="right" className="tnum">
                        {formatSol(row.costSol)}
                      </Td>
                      <Td align="right" className={`tnum font-medium ${net >= 0 ? 'text-positive' : 'text-negative'}`}>
                        {net >= 0 ? '+' : ''}
                        {formatSol(net)}
                      </Td>
                      <Td align="right" className="tnum">
                        {row.netUsd === null || row.netUsd === undefined ? (
                          <span
                            className="text-ink-subtle"
                            title="A net USD figure needs both sides priced; at least one side of this month carried no recorded SOL price"
                          >
                            not valued
                          </span>
                        ) : (
                          formatUsd(row.netUsd)
                        )}
                      </Td>
                      <Td align="right" className="tnum whitespace-nowrap">
                        {formatNumber(row.entryCount)}
                        {(row.entriesMissingUsd ?? 0) > 0 && (
                          <span
                            className="ml-1 text-xs text-warning"
                            title={`${row.entriesMissingUsd} of them carried no recorded SOL price and are excluded from every USD figure for this month`}
                          >
                            {formatNumber(row.entriesMissingUsd)} unpriced
                          </span>
                        )}
                      </Td>
                      <Td align="right" className="tnum">
                        {formatNumber(row.launches)}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>

            <Note>
              A month shows &ldquo;not valued&rdquo; in USD unless <em>both</em> its revenue and its cost side carried a
              recorded SOL price: netting a valued revenue total against an unvalued cost total would manufacture a profit
              out of missing prices. Nothing is converted at today&rsquo;s rate either, because doing so would silently
              restate past results every time SOL moves. The entry counts show how much of each month is priced.
            </Note>
          </div>
        )}
      </div>
    </Card>
  );
}

function MonthlyTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload as MonthlyRow | undefined;
  if (!row) return null;
  const net = row.netSol ?? 0;
  return (
    <div className="card-raised px-3 py-2 text-xs shadow-lg">
      <div className="font-medium text-ink">{row.month}</div>
      <div className="tnum mt-1 text-positive">Revenue {formatSol(row.revenueSol)}</div>
      <div className="tnum text-negative">Cost {formatSol(row.costSol)}</div>
      <div className={`tnum mt-1 font-medium ${net >= 0 ? 'text-positive' : 'text-negative'}`}>
        Net {net >= 0 ? '+' : ''}
        {formatSol(net)}
      </div>
      <div className="mt-1 text-ink-subtle">
        {formatNumber(row.launches)} launch{(row.launches ?? 0) === 1 ? '' : 'es'}
      </div>
    </div>
  );
}

// --- Ledger table ----------------------------------------------------------

function LedgerTable({ entries, platformNetwork }: { entries: LedgerEntry[]; platformNetwork: string | undefined }) {
  return (
    <DataTable>
      <thead>
        <tr>
          <Th>Date</Th>
          <Th>Type</Th>
          <Th>Category</Th>
          <Th>Description</Th>
          <Th align="right">SOL</Th>
          <Th align="right">USD</Th>
          <Th>Reference</Th>
          <Th>Network</Th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry, index) => {
          const revenue = entry.type === 'revenue';
          const amount = entry.amountSol ?? 0;
          return (
            <tr key={entry.id ?? `${entry.date ?? 'entry'}-${index}`}>
              <Td className="whitespace-nowrap text-ink-muted">{formatDateTime(entry.occurredAtMs)}</Td>
              <Td>
                <Badge tone={revenue ? 'positive' : 'neutral'}>{revenue ? '↑ Revenue' : '↓ Expense'}</Badge>
                {entry.countsTowardPnl === false && (
                  <span className="ml-1.5 text-xs text-ink-subtle" title="A movement between the platform's own wallets: not counted in revenue, costs or net">
                    transfer
                  </span>
                )}
              </Td>
              <Td className="whitespace-nowrap">{humanise(entry.category)}</Td>
              <Td className="max-w-xs">
                <span className="block truncate" title={entry.description ?? undefined}>
                  {entry.description || '—'}
                </span>
              </Td>
              <Td align="right" className={`tnum whitespace-nowrap ${revenue ? 'text-positive' : 'text-ink'}`}>
                {amount === 0 ? (
                  <span
                    className="text-ink-subtle"
                    title={
                      entry.amountUsd === null || entry.amountUsd === undefined
                        ? 'No SOL amount was recorded for this entry'
                        : 'Billed in USD with no SOL price recorded, so it has no SOL amount and does not move the SOL totals'
                    }
                  >
                    —
                  </span>
                ) : (
                  `${revenue ? '+' : '−'}${formatSol(Math.abs(amount))}`
                )}
                {entry.solDerivedFromUsd && (
                  <span className="ml-1 text-xs text-ink-subtle" title="Converted from a USD amount at the SOL price recorded for this event">
                    est.
                  </span>
                )}
              </Td>
              <Td align="right" className="tnum whitespace-nowrap">
                {entry.amountUsd === null || entry.amountUsd === undefined ? (
                  <span className="text-ink-subtle" title="No SOL price was recorded for this event, and the ledger never back-fills one">
                    not valued
                  </span>
                ) : (
                  formatUsd(entry.amountUsd)
                )}
              </Td>
              <Td className="whitespace-nowrap">
                <ReferenceCell reference={entry.reference} network={entry.network} platformNetwork={platformNetwork} />
              </Td>
              <Td className="whitespace-nowrap">
                {entry.network === 'simulation' ? (
                  <Badge tone="warning">
                    <span aria-hidden="true">◇</span> Simulated
                  </Badge>
                ) : entry.network ? (
                  <span className="text-ink-subtle">{humanise(entry.network)}</span>
                ) : (
                  <span className="text-ink-subtle" title="This source records no network; an off-chain cost has none">
                    —
                  </span>
                )}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </DataTable>
  );
}

function ReferenceCell({
  reference,
  network,
  platformNetwork,
}: {
  reference: string | null | undefined;
  network: string | null | undefined;
  platformNetwork: string | undefined;
}) {
  if (!reference) return <span className="text-ink-subtle">—</span>;

  // A simulated event never touched a chain: its signature was invented by the
  // simulation adapter and must never be dressed up as an explorer link.
  if (network === 'simulation') {
    return (
      <span
        className="font-mono text-xs text-ink-subtle"
        title="Fabricated by the simulation adapter — this reference does not exist on any chain"
      >
        {truncateAddress(reference, 6)} (not on chain)
      </span>
    );
  }

  // Internal ids, not signatures: a link would imply an on-chain record that
  // does not exist.
  if (!SIGNATURE_PATTERN.test(reference)) {
    return (
      <span className="font-mono text-xs text-ink-muted" title={reference}>
        {truncateAddress(reference, 6)}
      </span>
    );
  }

  // Off-chain sources record no network. Falling back to the platform's current
  // one is only safe where that is itself a chain — on simulation it says
  // nothing about where an older signature belongs, so no link is offered.
  const chain = network ?? platformNetwork;
  if (!chain || chain === 'simulation') {
    return (
      <span
        className="font-mono text-xs text-ink-muted"
        title="No network is recorded for this entry, so no explorer link can be built for it"
      >
        {truncateAddress(reference, 6)}
      </span>
    );
  }

  return (
    <a
      className="font-mono text-xs text-accent-soft underline decoration-dotted underline-offset-2 transition-colors hover:text-ink"
      href={solscanUrl('tx', reference, chain)}
      target="_blank"
      rel="noreferrer noopener"
      title={`View ${reference} on Solscan`}
    >
      {truncateAddress(reference, 6)} ↗
    </a>
  );
}

// --- Pagination ------------------------------------------------------------

function Pagination({
  offset,
  limit,
  shown,
  total,
  onChange,
}: {
  offset: number;
  limit: number;
  shown: number;
  total: number;
  onChange: (next: number) => void;
}) {
  const first = total === 0 ? 0 : offset + 1;
  const last = offset + shown;
  const hasPrevious = offset > 0;
  const hasNext = last < total;

  return (
    <nav className="mt-3 flex flex-wrap items-center justify-between gap-3" aria-label="Ledger pagination">
      <p className="tnum text-xs text-ink-subtle">
        Showing {formatNumber(first)}–{formatNumber(last)} of {formatNumber(total)} entries in range
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!hasPrevious}
          onClick={() => onChange(Math.max(0, offset - limit))}
        >
          ← Previous
        </button>
        <button type="button" className="btn btn-ghost" disabled={!hasNext} onClick={() => onChange(offset + limit)}>
          Next →
        </button>
      </div>
    </nav>
  );
}
