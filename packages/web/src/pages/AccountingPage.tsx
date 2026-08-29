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
  revenueUsd?: number;
  costUsd?: number;
  netUsd?: number;
  entriesMissingUsd?: number;
  usdCoverage?: number;
  entriesMissingSol?: number;
  transferCount?: number;
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
  launches?: number;
}

interface MonthlyResponse {
  months?: MonthlyRow[];
}

const RANGES: Array<{ id: RangeKey; label: string }> = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: '1y', label: '1 year' },
  { id: 'all', label: 'All time' },
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

  const summary = ledgerQuery.data?.summary;
  const entries = ledgerQuery.data?.entries ?? [];
  const total = summary?.entryCount ?? 0;
  const canExport = can('export_accounting');

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
        action={
          <div className="flex flex-wrap items-center gap-2">
            <RangeSelector value={range} onChange={changeRange} />
            {canExport && (
              <>
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
              </>
            )}
          </div>
        }
      />

      {canExport ? (
        <p className="text-xs text-ink-subtle">Exports always cover the full ledger, not the selected range, and are recorded in the audit log.</p>
      ) : (
        <Note>
          Exporting the ledger requires the <code className="font-mono">export_accounting</code> permission, which this
          account does not have. An owner or admin can grant it in Settings.
        </Note>
      )}

      {exportError && <Note tone="negative">Export failed: {exportError}</Note>}

      {summary?.disclaimer && <Note tone="warning">{summary.disclaimer}</Note>}

      <SummaryTiles query={ledgerQuery} />

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
              <LedgerTable entries={entries} />
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

// --- Summary ---------------------------------------------------------------

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
          hint={`${formatUsd(summary?.revenueUsd)} across the entries that carry a recorded USD value`}
        />
        <StatTile
          label="Costs"
          value={formatSol(summary?.costSol)}
          hint={`${formatUsd(summary?.costUsd)} across the entries that carry a recorded USD value`}
        />
        <StatTile
          label="Net"
          value={net === undefined ? '—' : formatSol(net, { sign: true })}
          tone={net === undefined ? 'neutral' : net >= 0 ? 'positive' : 'negative'}
          hint={`${formatNumber(entryCount)} entries · ${formatNumber(summary?.transferCount)} internal transfers (${formatSol(summary?.transferSol)}) excluded`}
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
                          <span className="text-ink-subtle" title="No entry in this month carried a recorded SOL price">
                            not valued
                          </span>
                        ) : (
                          formatUsd(row.netUsd)
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
              A month shows &ldquo;not valued&rdquo; in USD when none of its entries carried a SOL price at the time of the
              event. Those months are not converted at today&rsquo;s rate, because doing so would silently restate past
              results every time SOL moves.
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

function LedgerTable({ entries }: { entries: LedgerEntry[] }) {
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
                {amount === 0 ? '—' : `${revenue ? '+' : '−'}${formatSol(Math.abs(amount))}`}
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
                <ReferenceCell reference={entry.reference} network={entry.network} />
              </Td>
              <Td className="whitespace-nowrap text-ink-subtle">{entry.network ? humanise(entry.network) : '—'}</Td>
            </tr>
          );
        })}
      </tbody>
    </DataTable>
  );
}

function ReferenceCell({ reference, network }: { reference: string | null | undefined; network: string | null | undefined }) {
  if (!reference) return <span className="text-ink-subtle">—</span>;
  if (!SIGNATURE_PATTERN.test(reference)) {
    return (
      <span className="font-mono text-xs text-ink-muted" title={reference}>
        {truncateAddress(reference, 6)}
      </span>
    );
  }
  return (
    <a
      className="font-mono text-xs text-accent-soft underline decoration-dotted underline-offset-2 transition-colors hover:text-ink"
      href={solscanUrl('tx', reference, network ?? 'mainnet')}
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
