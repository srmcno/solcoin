import { useMemo, useState, type ReactNode } from 'react';
import {
  Badge,
  Card,
  CopyButton,
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
  formatRelative,
  formatSol,
  humanise,
  solscanUrl,
  truncateAddress,
} from '@/lib/format';
import { POLL, queryKeys, useApiMutation, useApiQuery } from '@/lib/queries';
import { useSession } from '@/lib/session';

const LAMPORTS_PER_SOL = 1_000_000_000;
const EXPORT_PHRASE = 'I understand this reveals my private key';
/** A balance older than this is stale enough that the operator should be told. */
const STALE_BALANCE_MS = 10 * 60_000;
/** The server caps /api/wallet transaction history at this many rows. */
const TRANSACTION_LIMIT = 50;

/**
 * On the simulation network there is no chain behind any of this.
 *
 * The server hands a configured wallet a fixed synthetic float so that the
 * spend guards are exercised end to end, and it refuses every transfer. A
 * balance that was invented, and an address that exists nowhere, must never be
 * rendered as though an explorer could confirm them.
 */
function isSimulated(network: string | null | undefined): boolean {
  return (network ?? 'simulation') === 'simulation';
}

/** An address or signature link, suppressed when there is no chain to link to. */
function ExplorerLink({
  kind,
  value,
  network,
  className,
  children,
}: {
  kind: 'account' | 'tx';
  value: string;
  network: string;
  className?: string;
  children: ReactNode;
}) {
  if (isSimulated(network)) {
    return (
      <span
        className={`${className ?? ''} text-ink-subtle`.trim()}
        title="Simulated — this does not exist on any chain, so there is no explorer page for it"
      >
        {children} <span className="text-xs">(not on chain)</span>
      </span>
    );
  }
  return (
    <a className={className} href={solscanUrl(kind, value, network)} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

interface WalletSummary {
  address?: string | null;
  role?: string | null;
  network?: string | null;
  balanceLamports?: number | null;
  balanceSol?: number | null;
  balanceCheckedAt?: number | null;
  custody?: string | null;
  canSign?: boolean | null;
  belowFloor?: boolean | null;
  floorSol?: number | null;
  availableForSpendSol?: number | null;
  treasuryAddress?: string | null;
  treasuryBalanceLamports?: number | null;
}

/** wallet_transactions rows come straight from SQLite, so they are snake_case. */
interface TransactionRow {
  id?: string | null;
  wallet_address?: string | null;
  network?: string | null;
  signature?: string | null;
  direction?: string | null;
  purpose?: string | null;
  lamports?: number | null;
  fee_lamports?: number | null;
  counterparty?: string | null;
  status?: string | null;
  initiated_by?: string | null;
  error?: string | null;
  occurred_at?: number | null;
}

interface AccountRow {
  id?: string | null;
  role?: string | null;
  address?: string | null;
  label?: string | null;
  network?: string | null;
  has_signing_key?: number | boolean | null;
  custody?: string | null;
  balance_lamports?: number | null;
  balance_checked_at?: number | null;
  active?: number | boolean | null;
}

interface SweepEvaluation {
  shouldSweep?: boolean | null;
  reason?: string | null;
  amountLamports?: number | null;
  destination?: string | null;
}

interface WalletSettings {
  sweepThresholdSol?: number | null;
  operatingFloatSol?: number | null;
  autoSweepEnabled?: boolean | null;
  treasuryAddress?: string | null;
}

interface WalletResponse {
  summary?: WalletSummary;
  transactions?: TransactionRow[];
  accounts?: AccountRow[];
  sweep?: SweepEvaluation | null;
  settings?: WalletSettings;
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

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

const STATUS_TONE: Record<string, Tone> = {
  confirmed: 'positive',
  pending: 'warning',
  failed: 'negative',
};

export function WalletPage() {
  const { can } = useSession();
  const query = useApiQuery<WalletResponse>(queryKeys.wallet, '/api/wallet', { refetchInterval: POLL.fast });

  const summary = query.data?.summary;
  const settings = query.data?.settings;
  const sweep = query.data?.sweep ?? null;
  const transactions = useMemo(() => query.data?.transactions ?? [], [query.data]);
  const accounts = useMemo(() => query.data?.accounts ?? [], [query.data]);

  const network = summary?.network ?? 'mainnet';
  const address = summary?.address ?? null;
  const custody = summary?.custody ?? 'unknown';
  const canSign = summary?.canSign === true;
  const watchOnly = custody === 'watch_only';
  const simulated = isSimulated(summary?.network);

  const canConfigure = can('edit_wallet_config');
  const canTransfer = can('transfer_funds');

  const refresh = useApiMutation<{ operatingSol?: number | null; treasurySol?: number | null }, void>(
    '/api/wallet/refresh',
    { invalidate: [queryKeys.wallet] },
  );

  if (query.isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-56 w-full" />
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
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

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Wallet"
        description="The funds this platform can touch, and the funds it deliberately cannot."
        action={
          <button className="btn btn-ghost" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            {refresh.isPending ? 'Checking chain…' : 'Refresh balances'}
          </button>
        }
      />

      {refresh.isError && (
        <Note tone="negative">
          <strong>Balance refresh failed.</strong>{' '}
          {refresh.error instanceof Error ? refresh.error.message : 'The RPC endpoint did not answer.'}
        </Note>
      )}

      {/*
        The single most dangerous misreading available on this page: a balance
        that was invented by the server, shown next to a real-looking address.
      */}
      {simulated && (
        <Note tone="warning">
          <span aria-hidden="true">◇</span> <strong>This platform is running on the simulation network.</strong> There
          is no chain behind anything on this page.{' '}
          {address
            ? 'The balance below is not a measurement: the server assigns a configured wallet a fixed synthetic float so the spending limits and the launch pipeline can be exercised end to end. No SOL exists, the address holds nothing, and transfers and sweeps are refused outright.'
            : 'No wallet is configured, so nothing is being simulated yet. Any wallet created here will be given a synthetic balance rather than a real one.'}{' '}
          Nothing here can be confirmed in an explorer, so the explorer links are withheld rather than pointed at a
          mainnet page that would show a different account or nothing at all. Switch the network in Settings to operate
          for real.
        </Note>
      )}

      <CustodyDiagram
        summary={summary}
        settings={settings}
        network={network}
        hasWallet={Boolean(address)}
      />

      {!address ? (
        <SetupFlow canConfigure={canConfigure} />
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-3">
            <OperatingWalletCard summary={summary} network={network} className="xl:col-span-2" />
            <TreasuryCard summary={summary} settings={settings} sweep={sweep} network={network} canTransfer={canTransfer} />
          </div>

          {watchOnly && (
            <Note tone="warning">
              <span aria-hidden="true">⚠</span> <strong>This wallet is watch-only.</strong> No private key for it exists
              on this machine, so this process cannot sign anything: launches, fee claims, transfers and sweeps will all
              fail. Balances and history below are read from the chain and are accurate; every action is not. To let the
              platform operate, import a key or create a fresh operating wallet.
            </Note>
          )}
          {!watchOnly && !canSign && (
            <Note tone="warning">
              <span aria-hidden="true">⚠</span> <strong>This process cannot currently sign for this wallet.</strong>{' '}
              Custody is reported as <strong>{humanise(custody)}</strong> but no usable signing key is loaded — most
              often because the encrypted secret store is locked. Until that is resolved, launches and fee claims cannot
              be submitted.
            </Note>
          )}

          <TransferPanel
            canTransfer={canTransfer}
            canSign={canSign}
            summary={summary}
            network={network}
          />

          <AccountsCard accounts={accounts} network={network} />

          <TransactionsCard transactions={transactions} network={network} />

          <DangerZone canTransfer={canTransfer} canSign={canSign} />
        </>
      )}
    </div>
  );
}

/**
 * The two-tier custody model.
 *
 * Drawn rather than described because the whole point — that the hot wallet is
 * a small, bounded, deliberately-drained buffer — is a shape, not a sentence.
 */
function CustodyDiagram({
  summary,
  settings,
  network,
  hasWallet,
}: {
  summary: WalletSummary | undefined;
  settings: WalletSettings | undefined;
  network: string;
  hasWallet: boolean;
}) {
  const treasuryAddress = summary?.treasuryAddress ?? settings?.treasuryAddress ?? null;
  const treasurySol = summary?.treasuryBalanceLamports === null || summary?.treasuryBalanceLamports === undefined
    ? null
    : toSol(summary.treasuryBalanceLamports);
  const operatingSol = maybeNum(summary?.balanceSol);
  const float = maybeNum(settings?.operatingFloatSol);
  const threshold = maybeNum(settings?.sweepThresholdSol);

  return (
    <Card>
      <SectionHeader
        title="Custody model"
        description="Only the operating wallet's key exists on this machine, so the most a total compromise of this process can cost you is the operating balance — never the treasury."
      />

      <div className="mt-4 space-y-1.5">
        <div className="rounded-xl border border-positive-dim bg-positive-dim/20 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-wide text-positive">Treasury — cold</div>
              <div className="mt-1 text-sm text-ink-muted">
                Key held elsewhere: a hardware wallet, an exchange, or a laptop that never runs this software. This
                process knows the address and nothing more, so it can pay in but can never pay out.
              </div>
            </div>
            <div className="text-right">
              <div className="tnum text-lg font-semibold text-ink">
                {treasurySol === null ? '—' : formatSol(treasurySol)}
              </div>
              <div className="text-xs text-ink-subtle">
                {treasuryAddress ? truncateAddress(treasuryAddress, 6) : 'not configured'}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 px-1 py-1.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center text-lg text-accent-soft" aria-hidden="true">
            ↑
          </div>
          <div className="text-xs leading-relaxed text-ink-muted">
            <span className="font-semibold text-ink">Sweep.</span> Anything above the{' '}
            {float === null ? 'operating float' : `${formatNumber(float, 2)} SOL operating float`} is moved out to the
            treasury once the balance passes {threshold === null ? 'the sweep threshold' : `${formatNumber(threshold, 2)} SOL`}. Value only
            ever flows upward.
          </div>
        </div>

        <div className="rounded-xl border border-accent-dim bg-accent-dim/20 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-wide text-accent-soft">Operating wallet — hot</div>
              <div className="mt-1 text-sm text-ink-muted">
                Key encrypted at rest on this machine and decrypted in memory to sign. Fund it with what the next few
                launches need and no more. Network: <strong className="text-ink">{humanise(network)}</strong>.
              </div>
            </div>
            <div className="text-right">
              <div className="tnum text-lg font-semibold text-ink">
                {hasWallet ? formatSol(operatingSol) : '—'}
              </div>
              <div className="text-xs text-ink-subtle">
                {!hasWallet ? 'no wallet yet' : isSimulated(network) ? 'simulated balance' : 'balance'}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 px-1 py-1.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center text-lg text-ink-subtle" aria-hidden="true">
            ↕
          </div>
          <div className="text-xs leading-relaxed text-ink-muted">
            <span className="font-semibold text-ink">Spends down</span> on launch transactions and network fees;{' '}
            <span className="font-semibold text-ink">earns up</span> from creator-fee claims.
          </div>
        </div>

        <div className="rounded-xl border border-dashed border-border-strong bg-surface-raised p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">Launches and fee claims</div>
          <div className="mt-1 text-sm text-ink-muted">
            Every on-chain action the platform performs is signed by the operating wallet and is bounded by the spend
            limits in Settings.
          </div>
        </div>
      </div>
    </Card>
  );
}

function OperatingWalletCard({
  summary,
  network,
  className,
}: {
  summary: WalletSummary | undefined;
  network: string;
  className?: string;
}) {
  const address = summary?.address ?? '';
  const balance = maybeNum(summary?.balanceSol);
  const floor = maybeNum(summary?.floorSol);
  const available = maybeNum(summary?.availableForSpendSol);
  const belowFloor = summary?.belowFloor === true;
  const canSign = summary?.canSign === true;
  const custody = summary?.custody ?? 'unknown';
  const checkedAt = maybeNum(summary?.balanceCheckedAt);
  const simulated = isSimulated(network);
  // A synthetic balance cannot go stale against a chain that is not there, so
  // the staleness warning would be noise — the simulation banner already says
  // the figure is invented.
  const stale = !simulated && (checkedAt === null || Date.now() - checkedAt > STALE_BALANCE_MS);

  // The bar reads as "how far above the floor am I", capped at twice the floor
  // so that a healthy wallet does not render as a permanently full bar.
  const floorScale = floor !== null && floor > 0 ? floor * 2 : null;

  return (
    <Card className={className}>
      <SectionHeader
        title="Operating wallet"
        action={
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={custody === 'watch_only' ? 'warning' : 'accent'}>{humanise(custody)}</Badge>
            <Badge tone={canSign ? 'positive' : 'negative'}>{canSign ? '✓ Can sign' : '✕ Cannot sign'}</Badge>
          </div>
        }
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="min-w-0 break-all rounded-lg border border-border bg-ground px-2 py-1 font-mono text-xs text-ink-muted">
          {address || 'no address'}
        </code>
        {address && <CopyButton value={address} label="Copy address" />}
        {address && !isSimulated(network) && (
          <a
            className="text-xs text-ink-subtle transition-colors hover:text-accent-soft"
            href={solscanUrl('account', address, network)}
            target="_blank"
            rel="noreferrer noopener"
          >
            Solscan ↗
          </a>
        )}
        {address && isSimulated(network) && (
          <span className="text-xs text-ink-subtle" title="Simulated — this address exists on no chain">
            No explorer page
          </span>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile
          label={simulated ? 'Balance (simulated)' : 'Balance'}
          value={formatSol(balance)}
          tone={simulated ? 'warning' : belowFloor ? 'negative' : 'neutral'}
          hint={
            simulated
              ? 'Synthetic float assigned by the server — no SOL exists'
              : checkedAt === null
                ? 'Never checked against the chain'
                : `Checked ${formatRelative(checkedAt)}`
          }
        />
        <StatTile
          label="Available to spend"
          value={formatSol(available)}
          hint={
            simulated
              ? 'Balance minus the floor — derived from the simulated balance'
              : 'Balance minus the floor the platform refuses to spend below'
          }
        />
        <StatTile label="Balance floor" value={formatSol(floor)} hint="Spending halts at or below this" />
      </div>

      {floorScale !== null && balance !== null && (
        <div className="mt-4">
          <div className="flex items-baseline justify-between text-xs text-ink-subtle">
            <span>Floor {formatSol(floor)}</span>
            <span>{formatSol(floorScale)}</span>
          </div>
          <ScoreBar
            value={Math.min(balance, floorScale)}
            max={floorScale}
            tone={belowFloor ? 'negative' : balance < floorScale * 0.75 ? 'warning' : 'positive'}
            className="mt-1.5"
          />
        </div>
      )}

      <div className="mt-4 space-y-2">
        {belowFloor && (
          <Note tone="negative">
            <span aria-hidden="true">⚠</span> <strong>Below the balance floor.</strong> The platform has stopped every
            operation that spends SOL, including launches, and will keep refusing until the balance is above{' '}
            {formatSol(floor)}. Fund this address to resume.
          </Note>
        )}
        {stale && (
          <Note tone="warning">
            {checkedAt === null
              ? 'This balance has never been read from the chain, so it may be wrong. Press Refresh balances.'
              : `This balance was last read from the chain ${formatRelative(checkedAt)} (${formatDateTime(checkedAt)}). It is a cached figure, not live — press Refresh balances to confirm before acting on it.`}
          </Note>
        )}
      </div>
    </Card>
  );
}

function TreasuryCard({
  summary,
  settings,
  sweep,
  network,
  canTransfer,
}: {
  summary: WalletSummary | undefined;
  settings: WalletSettings | undefined;
  sweep: SweepEvaluation | null;
  network: string;
  canTransfer: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const treasuryAddress = summary?.treasuryAddress ?? settings?.treasuryAddress ?? null;
  const treasurySol =
    summary?.treasuryBalanceLamports === null || summary?.treasuryBalanceLamports === undefined
      ? null
      : toSol(summary.treasuryBalanceLamports);
  const shouldSweep = sweep?.shouldSweep === true;
  const sweepAmount = toSol(sweep?.amountLamports);

  const runSweep = useApiMutation<{ ok?: boolean; signature?: string; amountSol?: number }, void>('/api/wallet/sweep', {
    invalidate: [queryKeys.wallet],
    onSuccess: () => setConfirming(false),
  });

  return (
    <Card>
      <SectionHeader title="Treasury" action={<Badge tone={settings?.autoSweepEnabled ? 'info' : 'neutral'}>{settings?.autoSweepEnabled ? 'Auto-sweep on' : 'Auto-sweep off'}</Badge>} />

      {treasuryAddress ? (
        <div className="mt-3 space-y-3">
          <div>
            <div className="label">Address</div>
            <code className="block break-all rounded-lg border border-border bg-ground px-2 py-1 font-mono text-xs text-ink-muted">
              {treasuryAddress}
            </code>
            <div className="mt-1.5 flex items-center gap-3">
              <CopyButton value={treasuryAddress} label="Copy" />
              {isSimulated(network) ? (
                <span className="text-xs text-ink-subtle" title="Simulated — no chain to look this up on">
                  No explorer page
                </span>
              ) : (
                <a
                  className="text-xs text-ink-subtle transition-colors hover:text-accent-soft"
                  href={solscanUrl('account', treasuryAddress, network)}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Solscan ↗
                </a>
              )}
            </div>
          </div>

          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Balance</div>
            <div className="tnum mt-1 text-2xl font-semibold text-ink">{treasurySol === null ? '—' : formatSol(treasurySol)}</div>
            {treasurySol === null && (
              <div className="mt-1 text-xs text-ink-subtle">
                Not read yet — press Refresh balances. No number is shown rather than a zero, because zero would be a lie.
              </div>
            )}
          </div>

          <Note tone={shouldSweep ? 'positive' : 'neutral'}>
            <strong>{shouldSweep ? `Sweep ready: ${formatSol(sweepAmount)}.` : 'No sweep right now.'}</strong>{' '}
            {sweep?.reason ?? 'The API returned no sweep evaluation.'}
          </Note>

          {isSimulated(network) ? (
            <Note tone="warning">
              <span aria-hidden="true">◇</span> Sweeping is unavailable on the simulation network: a sweep is a
              transfer, and there are no real funds to move.
            </Note>
          ) : canTransfer ? (
            <button
              className="btn btn-ghost w-full"
              onClick={() => setConfirming(true)}
              disabled={!shouldSweep || runSweep.isPending}
              title={shouldSweep ? 'Move the excess to treasury' : sweep?.reason ?? 'Nothing to sweep'}
            >
              {runSweep.isPending ? 'Sweeping…' : shouldSweep ? `Sweep ${formatSol(sweepAmount)} to treasury` : 'Nothing to sweep'}
            </button>
          ) : (
            <Note>Sweeping requires the transfer_funds permission, which your account does not have.</Note>
          )}

          {runSweep.isError && (
            <Note tone="negative">
              <strong>Sweep failed.</strong>{' '}
              {runSweep.error instanceof Error ? runSweep.error.message : 'The server rejected the sweep.'}
            </Note>
          )}
          {runSweep.isSuccess && !runSweep.isPending && (
            <Note tone="positive">
              <span aria-hidden="true">✓</span> Swept {formatSol(runSweep.data?.amountSol)}
              {runSweep.data?.signature ? ` — signature ${truncateAddress(runSweep.data.signature, 6)}.` : '.'}
            </Note>
          )}
        </div>
      ) : (
        <div className="mt-3">
          <Note tone="warning">
            <strong>No treasury address is configured.</strong> Everything the platform earns will sit in the hot
            operating wallet, where a compromise of this machine takes all of it. Set a treasury address in Settings —
            ideally one whose key never touches this machine — and revenue will be swept out automatically.
          </Note>
        </div>
      )}

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Sweep to treasury"
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={() => runSweep.mutate()} disabled={runSweep.isPending}>
              {runSweep.isPending ? 'Sweeping…' : 'Confirm sweep'}
            </button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-ink-muted">
          <p>
            Moving <strong className="tnum text-ink">{formatSol(sweepAmount)}</strong> out of the operating wallet to:
          </p>
          <code className="block break-all rounded-lg border border-border bg-ground px-3 py-2 font-mono text-xs text-ink">
            {sweep?.destination ?? treasuryAddress ?? 'unknown destination'}
          </code>
          <p>
            Read the address above. A Solana transfer is irreversible and there is nobody to appeal to if it is wrong.
          </p>
        </div>
      </Modal>
    </Card>
  );
}

function SetupFlow({ canConfigure }: { canConfigure: boolean }) {
  const [mode, setMode] = useState<'none' | 'import' | 'watch'>('none');
  const [secret, setSecret] = useState('');
  const [watchAddress, setWatchAddress] = useState('');
  const [label, setLabel] = useState('');

  const create = useApiMutation<{ publicKey?: string; message?: string }, { label?: string }>('/api/wallet/create', {
    invalidate: [queryKeys.wallet],
  });
  const importKey = useApiMutation<{ publicKey?: string }, { secret: string; label?: string }>('/api/wallet/import', {
    invalidate: [queryKeys.wallet],
    onSuccess: () => setSecret(''),
  });
  const watchOnly = useApiMutation<{ ok?: boolean; message?: string }, { address: string; label?: string }>(
    '/api/wallet/watch-only',
    { invalidate: [queryKeys.wallet] },
  );

  const pending = create.isPending || importKey.isPending || watchOnly.isPending;
  const error = create.error ?? importKey.error ?? watchOnly.error;

  if (!canConfigure) {
    return (
      <Card>
        <EmptyState
          icon="⬡"
          title="No wallet is configured"
          description="This platform cannot launch anything or claim any fee until an operating wallet exists. Configuring one requires the edit_wallet_config permission, which your account does not have — ask an owner or admin to set it up."
        />
      </Card>
    );
  }

  return (
    <Card>
      <SectionHeader
        title="Set up an operating wallet"
        description="Nothing can be launched, signed or claimed until this exists. Three ways to do it, in order of how much risk they carry."
      />

      {error && (
        <div className="mt-3">
          <Note tone="negative">
            <strong>That did not work.</strong> {error instanceof Error ? error.message : 'The server rejected the request.'}
          </Note>
        </div>
      )}
      {create.isSuccess && create.data?.publicKey && (
        <div className="mt-3">
          <Note tone="positive">
            <span aria-hidden="true">✓</span> Created <strong>{truncateAddress(create.data.publicKey, 6)}</strong>.{' '}
            {create.data.message ?? 'Fund it with only what near-term launches need.'}
          </Note>
        </div>
      )}
      {watchOnly.isSuccess && (
        <div className="mt-3">
          <Note tone="warning">{watchOnly.data?.message ?? 'Watching this address. This process cannot sign for it.'}</Note>
        </div>
      )}

      <div className="mt-4">
        <label className="label" htmlFor="wallet-label">
          Label (optional)
        </label>
        <input
          id="wallet-label"
          className="input max-w-sm"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Operating wallet"
        />
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <SetupOption
          title="Create a fresh wallet"
          tone="positive"
          recommendation="Recommended"
          body="A new keypair is generated here and encrypted at rest immediately. No secret ever crosses the network or passes through your clipboard, and the wallet starts with a zero balance, so nothing existing is put at risk. You fund it yourself, with as little as you like."
          action={
            <button className="btn btn-primary w-full" onClick={() => create.mutate({ label: label || undefined })} disabled={pending}>
              {create.isPending ? 'Creating…' : 'Create wallet'}
            </button>
          }
        />

        <SetupOption
          title="Import an existing key"
          tone="negative"
          recommendation="Highest risk"
          body="Use only a wallet you created for this platform alone. Pasting a private key into a browser form exposes it to your clipboard history, any browser extension with page access, and anything logging your keystrokes — and the key you paste probably guards funds already."
          action={
            mode === 'import' ? (
              <div className="space-y-2">
                <label className="label" htmlFor="wallet-secret">
                  Private key (base58 or JSON array)
                </label>
                <textarea
                  id="wallet-secret"
                  className="input font-mono text-xs"
                  rows={3}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste the secret key"
                />
                <div className="flex gap-2">
                  <button className="btn btn-ghost flex-1" onClick={() => { setMode('none'); setSecret(''); }}>
                    Cancel
                  </button>
                  <button
                    className="btn btn-danger flex-1"
                    onClick={() => importKey.mutate({ secret: secret.trim(), label: label || undefined })}
                    disabled={secret.trim().length < 32 || pending}
                  >
                    {importKey.isPending ? 'Importing…' : 'Import key'}
                  </button>
                </div>
              </div>
            ) : (
              <button className="btn btn-ghost w-full" onClick={() => setMode('import')} disabled={pending}>
                Import a key anyway
              </button>
            )
          }
        />

        <SetupOption
          title="Watch an address"
          tone="warning"
          recommendation="Read-only"
          body="Track a wallet's balance and history without holding its key. Nothing can be signed: launches, transfers, sweeps and fee claims will all fail. Useful for observing a mainnet wallet while running the platform in simulation."
          action={
            mode === 'watch' ? (
              <div className="space-y-2">
                <label className="label" htmlFor="watch-address">
                  Public address
                </label>
                <input
                  id="watch-address"
                  className="input font-mono text-xs"
                  value={watchAddress}
                  onChange={(e) => setWatchAddress(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Solana public key"
                />
                <div className="flex gap-2">
                  <button className="btn btn-ghost flex-1" onClick={() => setMode('none')}>
                    Cancel
                  </button>
                  <button
                    className="btn btn-ghost flex-1"
                    onClick={() => watchOnly.mutate({ address: watchAddress.trim(), label: label || undefined })}
                    disabled={watchAddress.trim().length < 32 || pending}
                  >
                    {watchOnly.isPending ? 'Saving…' : 'Watch address'}
                  </button>
                </div>
              </div>
            ) : (
              <button className="btn btn-ghost w-full" onClick={() => setMode('watch')} disabled={pending}>
                Watch an address
              </button>
            )
          }
        />
      </div>
    </Card>
  );
}

function SetupOption({
  title,
  body,
  tone,
  recommendation,
  action,
}: {
  title: string;
  body: string;
  tone: Tone;
  recommendation: string;
  action: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <Badge tone={tone}>{recommendation}</Badge>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-ink-muted">{body}</p>
      </div>
      <div className="mt-auto">{action}</div>
    </div>
  );
}

function TransferPanel({
  canTransfer,
  canSign,
  summary,
  network,
}: {
  canTransfer: boolean;
  canSign: boolean;
  summary: WalletSummary | undefined;
  network: string;
}) {
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [confirming, setConfirming] = useState(false);

  const transfer = useApiMutation<{ ok?: boolean; signature?: string; amountSol?: number }, { destination: string; amountSol: number }>(
    '/api/wallet/transfer',
    {
      invalidate: [queryKeys.wallet],
      onSuccess: () => {
        setConfirming(false);
        setDestination('');
        setAmount('');
      },
    },
  );

  const parsedAmount = Number(amount);
  const amountValid = amount.trim() !== '' && Number.isFinite(parsedAmount) && parsedAmount > 0;
  const destinationValid = destination.trim().length >= 32 && destination.trim().length <= 64;
  const balance = maybeNum(summary?.balanceSol);
  const available = maybeNum(summary?.availableForSpendSol);
  const exceedsBalance = amountValid && balance !== null && parsedAmount > balance;
  const exceedsAvailable = amountValid && !exceedsBalance && available !== null && parsedAmount > available;
  const simulated = isSimulated(network);

  // The server refuses every transfer on the simulation network. Offering a
  // working-looking form that can only ever fail is worse than saying so.
  if (simulated) {
    return (
      <Card>
        <SectionHeader title="Send SOL" />
        <div className="mt-3">
          <Note tone="warning">
            <span aria-hidden="true">◇</span> <strong>Transfers are unavailable on the simulation network.</strong>{' '}
            There are no real funds to move, and the server rejects the request rather than pretending to send
            something. Switch the network in Settings to enable this.
          </Note>
        </div>
      </Card>
    );
  }

  if (!canTransfer) {
    return (
      <Card>
        <SectionHeader title="Send SOL" />
        <div className="mt-3">
          <Note>
            Sending funds requires the <strong>transfer_funds</strong> permission, which your account does not have. You
            can see every balance and transaction on this page but cannot move anything.
          </Note>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <SectionHeader
        title="Send SOL"
        description="A manual transfer out of the operating wallet. It is recorded in the audit log with your name against it."
      />

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <div>
          <label className="label" htmlFor="transfer-destination">
            Destination address
          </label>
          <input
            id="transfer-destination"
            className="input font-mono text-xs"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="Solana public key"
            aria-describedby="transfer-help"
          />
        </div>
        <div>
          <label className="label" htmlFor="transfer-amount">
            Amount (SOL)
          </label>
          <input
            id="transfer-amount"
            className="input tnum sm:w-36"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0.0000"
          />
        </div>
        <button
          className="btn btn-primary"
          onClick={() => setConfirming(true)}
          disabled={!destinationValid || !amountValid || exceedsBalance || !canSign || transfer.isPending}
          title={!canSign ? 'This process holds no signing key for the operating wallet' : undefined}
        >
          Review transfer
        </button>
      </div>

      <p id="transfer-help" className="mt-2 text-xs text-ink-subtle">
        Available to spend: <span className="tnum">{formatSol(available)}</span> of{' '}
        <span className="tnum">{formatSol(balance)}</span>.
      </p>

      <div className="mt-3 space-y-2">
        {exceedsBalance && (
          <Note tone="negative">
            <span aria-hidden="true">⚠</span> {formatSol(parsedAmount)} is more than the wallet holds ({formatSol(balance)}).
          </Note>
        )}
        {exceedsAvailable && (
          <Note tone="warning">
            <span aria-hidden="true">⚠</span> This is more than the {formatSol(available)} available above the balance
            floor. The transfer may succeed and leave the platform unable to launch until the wallet is topped up.
          </Note>
        )}
        {transfer.isError && (
          <Note tone="negative">
            <strong>Transfer failed.</strong>{' '}
            {transfer.error instanceof Error ? transfer.error.message : 'The server rejected the transfer.'}
          </Note>
        )}
        {transfer.isSuccess && !transfer.isPending && (
          <Note tone="positive">
            <span aria-hidden="true">✓</span> Sent {formatSol(transfer.data?.amountSol)}
            {transfer.data?.signature ? ` — signature ${truncateAddress(transfer.data.signature, 6)}.` : '.'}
          </Note>
        )}
      </div>

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Confirm this transfer"
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={() => transfer.mutate({ destination: destination.trim(), amountSol: parsedAmount })}
              disabled={transfer.isPending}
            >
              {transfer.isPending ? 'Sending…' : `Send ${formatSol(parsedAmount)}`}
            </button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-ink-muted">
          <p>Check every character of this address. There is no way to reverse a Solana transfer and no support desk.</p>
          <div>
            <div className="label">Destination</div>
            <code className="block break-all rounded-lg border border-border-strong bg-ground px-3 py-2 font-mono text-sm leading-relaxed text-ink">
              {destination.trim()}
            </code>
          </div>
          <dl className="grid grid-cols-2 gap-3">
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-subtle">Amount</dt>
              <dd className="tnum text-base font-semibold text-ink">{formatSol(parsedAmount)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-subtle">Network</dt>
              <dd className="text-base font-semibold text-ink">{humanise(network)}</dd>
            </div>
          </dl>
          {network === 'mainnet' && (
            <Note tone="negative">
              <span aria-hidden="true">⚠</span> This is mainnet. The SOL is real and the transfer is final.
            </Note>
          )}
        </div>
      </Modal>
    </Card>
  );
}

function AccountsCard({ accounts, network }: { accounts: AccountRow[]; network: string }) {
  return (
    <Card>
      <SectionHeader
        title="Known accounts"
        description="Every address this platform tracks, and whether it holds a signing key here."
      />
      <div className="mt-3">
        {accounts.length === 0 ? (
          <EmptyState
            icon="⬡"
            title="No accounts recorded"
            description="Accounts appear once a wallet is created, imported or watched."
          />
        ) : (
          <DataTable>
            <thead>
              <tr>
                <Th>Role</Th>
                <Th>Label</Th>
                <Th>Address</Th>
                <Th>Network</Th>
                <Th>Custody</Th>
                <Th align="center">Signing key</Th>
                <Th align="right">Balance</Th>
                <Th align="right">Checked</Th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account, index) => {
                const rowAddress = account.address ?? '';
                const rowNetwork = account.network ?? network;
                return (
                  <tr key={account.id ?? `${rowAddress}-${index}`} className="hover:bg-surface-hover/40">
                    <Td className="text-ink">{humanise(account.role ?? null)}</Td>
                    <Td>{account.label ?? '—'}</Td>
                    <Td>
                      {rowAddress ? (
                        <ExplorerLink
                          kind="account"
                          value={rowAddress}
                          network={rowNetwork}
                          className="font-mono text-xs text-accent-soft hover:underline"
                        >
                          {truncateAddress(rowAddress, 6)}
                        </ExplorerLink>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td>
                      {isSimulated(rowNetwork) ? (
                        <Badge tone="warning">
                          <span aria-hidden="true">◇</span> Simulation
                        </Badge>
                      ) : (
                        humanise(rowNetwork)
                      )}
                    </Td>
                    <Td>
                      <Badge tone={account.custody === 'watch_only' ? 'warning' : 'accent'}>{humanise(account.custody ?? null)}</Badge>
                    </Td>
                    <Td align="center">
                      {truthy(account.has_signing_key) ? (
                        <span className="text-positive">✓ yes</span>
                      ) : (
                        <span className="text-ink-subtle">✕ no</span>
                      )}
                    </Td>
                    {/* Never checked is not the same as empty: a zero here would be a lie. */}
                    <Td align="right" className="tnum">
                      {maybeNum(account.balance_checked_at) === null ? (
                        <span className="text-ink-subtle" title="This balance has never been read, so no figure is shown">
                          —
                        </span>
                      ) : (
                        formatSol(toSol(account.balance_lamports))
                      )}
                    </Td>
                    <Td align="right" className="text-ink-subtle">
                      <span title={formatDateTime(maybeNum(account.balance_checked_at))}>
                        {formatRelative(maybeNum(account.balance_checked_at))}
                      </span>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        )}
      </div>
    </Card>
  );
}

function TransactionsCard({ transactions, network }: { transactions: TransactionRow[]; network: string }) {
  // The API returns at most this many rows, so "every transfer" would be a
  // claim the data cannot support once the wallet has been busy.
  const truncated = transactions.length >= TRANSACTION_LIMIT;
  return (
    <Card>
      <SectionHeader
        title="Transaction history"
        description={
          transactions.length === 0
            ? 'Every transfer this platform has signed or attempted, newest first.'
            : `The ${transactions.length} most recent transfers this platform signed or attempted, newest first — including the ones that failed.`
        }
      />
      {truncated && (
        <div className="mt-3">
          <Note>
            Only the most recent {TRANSACTION_LIMIT} transfers are returned by the API. Older ones exist and are not
            listed here, so do not read this table as a complete ledger.
          </Note>
        </div>
      )}
      <div className="mt-3">
        {transactions.length === 0 ? (
          <EmptyState
            icon="▤"
            title="No transactions yet"
            description="Nothing has moved in or out of this wallet through the platform. Launches, fee claims and sweeps all appear here as they happen, including the ones that fail."
          />
        ) : (
          <DataTable>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Purpose</Th>
                <Th>Direction</Th>
                <Th align="right">Amount</Th>
                <Th align="right">Network fee</Th>
                <Th>Counterparty</Th>
                <Th>Status</Th>
                <Th>Signature</Th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((tx, index) => {
                const outbound = tx.direction === 'out' || tx.direction === 'outbound';
                const status = (tx.status ?? 'pending').toLowerCase();
                const rowNetwork = tx.network ?? network;
                return (
                  <tr key={tx.id ?? `${tx.signature ?? 'tx'}-${index}`} className="align-top hover:bg-surface-hover/40">
                    <Td>
                      <span title={formatDateTime(maybeNum(tx.occurred_at))}>{formatRelative(maybeNum(tx.occurred_at))}</span>
                    </Td>
                    <Td className="text-ink">
                      {humanise(tx.purpose ?? null)}
                      {tx.initiated_by && (
                        <div className="text-xs text-ink-subtle">by {tx.initiated_by}</div>
                      )}
                    </Td>
                    <Td>
                      <span className={outbound ? 'text-negative' : 'text-positive'}>
                        {outbound ? '↑ out' : '↓ in'}
                      </span>
                    </Td>
                    <Td align="right" className="tnum font-medium text-ink">
                      {outbound ? '−' : '+'}
                      {formatSol(toSol(tx.lamports))}
                    </Td>
                    <Td align="right" className="tnum">
                      {formatSol(toSol(tx.fee_lamports))}
                    </Td>
                    <Td>
                      {tx.counterparty ? (
                        <ExplorerLink
                          kind="account"
                          value={tx.counterparty}
                          network={rowNetwork}
                          className="font-mono text-xs text-accent-soft hover:underline"
                        >
                          {truncateAddress(tx.counterparty, 5)}
                        </ExplorerLink>
                      ) : (
                        <span className="text-ink-subtle">—</span>
                      )}
                    </Td>
                    <Td>
                      <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{humanise(status)}</Badge>
                      {tx.error && <div className="mt-1 max-w-xs text-xs leading-relaxed text-negative">{tx.error}</div>}
                    </Td>
                    <Td>
                      {tx.signature ? (
                        <ExplorerLink
                          kind="tx"
                          value={tx.signature}
                          network={rowNetwork}
                          className="text-accent-soft hover:underline"
                        >
                          {truncateAddress(tx.signature, 5)}
                        </ExplorerLink>
                      ) : (
                        <span className="text-ink-subtle" title="Never reached the chain">—</span>
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
  );
}

function DangerZone({ canTransfer, canSign }: { canTransfer: boolean; canSign: boolean }) {
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [secret, setSecret] = useState<string | null>(null);

  const exportKey = useApiMutation<{ secretKeyBase64?: string; warning?: string }, { confirmation: string }>(
    '/api/wallet/export',
    {
      onSuccess: (result) => {
        // Held in component state only, and dropped the moment the modal closes.
        setSecret(result?.secretKeyBase64 ?? null);
        setPhrase('');
      },
    },
  );

  const closeSecret = () => {
    setSecret(null);
    exportKey.reset();
  };

  return (
    <Card className="border-negative-dim">
      <SectionHeader
        title="Danger zone"
        description="One action lives here. It is collapsed because there is no accidental version of it."
        action={
          <button className="btn btn-ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls="danger-zone-body">
            {open ? 'Hide' : 'Show'}
          </button>
        }
      />

      {open && (
        <div id="danger-zone-body" className="mt-4 space-y-3">
          <Note tone="negative">
            <strong>Exporting reveals the operating wallet's private key in plain text.</strong> Anyone who sees it
            controls the wallet permanently and can drain it without touching this machine. The export is written to the
            audit log with your name, the time and your IP address — an export and a theft are indistinguishable
            afterwards, so the record is the only protection you have. If you only need a backup, prefer creating a
            fresh wallet and moving funds to it.
          </Note>

          {!canTransfer ? (
            <Note>
              Exporting requires the <strong>transfer_funds</strong> permission, which your account does not have.
            </Note>
          ) : !canSign ? (
            <Note tone="warning">
              There is no private key on this machine to export — this wallet is watch-only or its key is not loaded.
            </Note>
          ) : (
            <>
              <div>
                <label className="label" htmlFor="export-confirmation">
                  Type <span className="font-mono text-ink">{EXPORT_PHRASE}</span> to enable the button
                </label>
                <input
                  id="export-confirmation"
                  className="input max-w-lg"
                  value={phrase}
                  onChange={(e) => setPhrase(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={EXPORT_PHRASE}
                />
              </div>
              <button
                className="btn btn-danger"
                onClick={() => exportKey.mutate({ confirmation: phrase })}
                disabled={phrase !== EXPORT_PHRASE || exportKey.isPending}
              >
                {exportKey.isPending ? 'Exporting…' : 'Reveal private key'}
              </button>
              {exportKey.isError && (
                <Note tone="negative">
                  <strong>Export refused.</strong>{' '}
                  {exportKey.error instanceof Error ? exportKey.error.message : 'The server rejected the request.'}
                </Note>
              )}
            </>
          )}
        </div>
      )}

      <Modal
        open={secret !== null}
        onClose={closeSecret}
        title="Private key"
        footer={
          <button className="btn btn-primary" onClick={closeSecret}>
            Done
          </button>
        }
      >
        <div className="space-y-3">
          <Note tone="negative">
            {exportKey.data?.warning ??
              'Anyone holding this key controls the wallet. This export has been recorded in the audit log.'}
          </Note>
          <code className="block break-all rounded-lg border border-negative-dim bg-ground px-3 py-2 font-mono text-xs leading-relaxed text-ink">
            {secret}
          </code>
          <div className="flex items-center justify-between gap-3">
            <CopyButton value={secret ?? ''} label="Copy private key" />
            <span className="text-xs text-ink-subtle">Closing this dialog discards it from the page.</span>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

export default WalletPage;
