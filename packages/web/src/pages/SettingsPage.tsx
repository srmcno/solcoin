import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingRows,
  Modal,
  Note,
  SectionHeader,
  Skeleton,
  Tabs,
  Td,
  Th,
  type Tone,
} from '@/components/ui';
import { formatDateTime, formatNumber, formatRelative, humanise } from '@/lib/format';
import { POLL, queryKeys, useApiMutation, useApiQuery } from '@/lib/queries';
import { useSession } from '@/lib/session';

/**
 * Platform settings.
 *
 * Two rules shape this screen. First, nothing is written until the operator
 * says so: edits accumulate in a local draft and a save bar reports exactly
 * which paths will change. Second, the server is the authority on what is
 * allowed — the phase ladder caps autonomy and network, and the UI explains
 * those caps up front rather than letting the operator discover them as a 403.
 */

type Obj = Record<string, unknown>;

type TabId =
  | 'phase'
  | 'quality'
  | 'limits'
  | 'wallet'
  | 'fees'
  | 'monitoring'
  | 'research'
  | 'ai'
  | 'exploration'
  | 'notifications'
  | 'secrets'
  | 'danger';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'phase', label: 'Phase & autonomy' },
  { id: 'quality', label: 'Quality gate' },
  { id: 'limits', label: 'Limits' },
  { id: 'wallet', label: 'Wallet' },
  { id: 'fees', label: 'Fees' },
  { id: 'monitoring', label: 'Monitoring' },
  { id: 'research', label: 'Research' },
  { id: 'ai', label: 'AI' },
  { id: 'exploration', label: 'Exploration' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'secrets', label: 'Providers & secrets' },
  { id: 'danger', label: 'Danger zone' },
];

/**
 * Mirrors SENSITIVE_SETTING_PATHS on the server so the save bar can flag a
 * change before it is submitted. The server's response remains authoritative.
 */
const SENSITIVE_PATHS = [
  'autonomy.launch',
  'autonomy.fee_collection',
  'autonomy.wallet_transfer',
  'execution.network',
  'execution.phase',
  'execution.devBuySol',
  'limits.maxLaunchesPerDay',
  'limits.maxLaunchesPerHour',
  'limits.maxSolSpendPerDay',
  'limits.maxSolPerTransaction',
  'limits.maxSolPerHour',
  'limits.walletBalanceFloorSol',
  'wallet.treasuryAddress',
  'wallet.autoSweepEnabled',
  'qualityGate.minOpportunityScore',
  'qualityGate.maxSaturationScore',
  'qualityGate.minExpectedValueSol',
  'qualityGate.blockOnHardCollision',
  'emergencyStop',
];

const AUTONOMY_LEVELS = ['off', 'suggest', 'approve', 'auto'] as const;
type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

const AUTONOMY_RANK: Record<string, number> = { off: 0, suggest: 1, approve: 2, auto: 3 };

const AUTONOMY_LEVEL_HELP: Record<AutonomyLevel, string> = {
  off: 'Never runs. The capability is switched off entirely.',
  suggest: 'Prepares the work and shows it to you. Nothing is queued or acted on.',
  approve: 'Prepares the action and queues it. A human must approve before it runs.',
  auto: 'Acts on its own, within the configured rate and spend limits.',
};

/**
 * Only capabilities with real-world side effects are capped by the phase
 * ladder. Research and concept work stay available at every phase — the ladder
 * exists to gate unattended action, not to make the approval queue unusable.
 */
const AUTONOMY_CAPABILITIES: Array<{ id: string; label: string; help: string; capped: boolean }> = [
  { id: 'research', label: 'Research', help: 'Discovering and scoring trends from the configured sources.', capped: false },
  {
    id: 'concept_generation',
    label: 'Concept generation',
    help: 'Turning a qualifying trend into named token concepts.',
    capped: false,
  },
  { id: 'artwork', label: 'Artwork', help: 'Producing the token image, procedurally or via an image model.', capped: false },
  { id: 'metadata', label: 'Metadata', help: 'Writing the token name, symbol, description and links.', capped: false },
  {
    id: 'launch',
    label: 'Launch',
    help: 'Submitting the create transaction. This spends SOL and is irreversible on mainnet.',
    capped: true,
  },
  { id: 'social', label: 'Social', help: 'Posting about a launch to connected social accounts.', capped: true },
  {
    id: 'fee_collection',
    label: 'Fee collection',
    help: 'Claiming accrued creator fees. Costs a transaction fee each time.',
    capped: true,
  },
  {
    id: 'wallet_transfer',
    label: 'Wallet transfer',
    help: 'Moving SOL between the operating wallet and treasury.',
    capped: true,
  },
];

const TREND_SOURCES: Array<{ id: string; label: string; zeroAuth: boolean }> = [
  { id: 'google_trends', label: 'Google Trends', zeroAuth: true },
  { id: 'bluesky', label: 'Bluesky', zeroAuth: true },
  { id: 'mastodon', label: 'Mastodon', zeroAuth: true },
  { id: 'wikipedia', label: 'Wikipedia', zeroAuth: true },
  { id: 'hackernews', label: 'Hacker News', zeroAuth: true },
  { id: 'gdelt', label: 'GDELT (news)', zeroAuth: true },
  { id: 'stackexchange', label: 'Stack Exchange', zeroAuth: true },
  { id: 'rss', label: 'Custom RSS', zeroAuth: true },
  { id: 'youtube', label: 'YouTube', zeroAuth: false },
  { id: 'reddit', label: 'Reddit', zeroAuth: false },
  { id: 'x', label: 'X', zeroAuth: false },
  { id: 'pumpfun_market', label: 'Pump.fun market', zeroAuth: false },
  { id: 'dexscreener', label: 'Dexscreener', zeroAuth: false },
  { id: 'manual', label: 'Manual entry', zeroAuth: true },
];

const NOTIFICATION_EVENTS: Array<{ id: string; label: string }> = [
  { id: 'token_graduated', label: 'Token graduated' },
  { id: 'high_organic_volume', label: 'High organic volume' },
  { id: 'large_fee_accrual', label: 'Large fee accrual' },
  { id: 'fees_collected', label: 'Fees collected' },
  { id: 'launch_succeeded', label: 'Launch succeeded' },
  { id: 'launch_failed', label: 'Launch failed' },
  { id: 'wallet_balance_low', label: 'Wallet balance low' },
  { id: 'system_paused', label: 'System paused' },
  { id: 'emergency_stop', label: 'Emergency stop' },
  { id: 'provider_unavailable', label: 'Provider unavailable' },
  { id: 'unusual_activity', label: 'Unusual activity' },
  { id: 'high_value_opportunity', label: 'High-value opportunity' },
  { id: 'candidate_awaiting_approval', label: 'Candidate awaiting approval' },
  { id: 'model_retrained', label: 'Model retrained' },
  { id: 'daily_digest', label: 'Daily digest' },
];

const PANEL_ROLES: Array<{ id: string; label: string }> = [
  { id: 'skeptic', label: 'Skeptic' },
  { id: 'market_analyst', label: 'Market analyst' },
  { id: 'risk', label: 'Risk' },
  { id: 'creative_critic', label: 'Creative critic' },
];

/** Credentials the platform knows how to use, and what each one unlocks. */
const KNOWN_SECRETS: Array<{ key: string; label: string; category: string; unlocks: string }> = [
  { key: 'ai.anthropic.api_key', label: 'Anthropic API key', category: 'api_key', unlocks: 'Triage, concept generation and the decision panel.' },
  { key: 'ai.openai.api_key', label: 'OpenAI API key', category: 'api_key', unlocks: 'An alternative model provider and image generation.' },
  { key: 'rpc.helius.api_key', label: 'Helius API key', category: 'api_key', unlocks: 'A reliable Solana RPC ahead of the public endpoints.' },
  { key: 'rpc.mainnet.url', label: 'Mainnet RPC URL', category: 'endpoint', unlocks: 'Your own mainnet RPC, used before any fallback.' },
  { key: 'rpc.devnet.url', label: 'Devnet RPC URL', category: 'endpoint', unlocks: 'Your own devnet RPC for phase 2 testing.' },
  { key: 'market.birdeye.api_key', label: 'Birdeye API key', category: 'api_key', unlocks: 'Market data for live token monitoring.' },
  { key: 'trends.youtube.api_key', label: 'YouTube API key', category: 'api_key', unlocks: 'YouTube as a trend source.' },
  { key: 'trends.reddit.client_id', label: 'Reddit client ID', category: 'api_key', unlocks: 'Reddit as a trend source (with the secret below).' },
  { key: 'trends.reddit.client_secret', label: 'Reddit client secret', category: 'api_key', unlocks: 'Reddit as a trend source.' },
  { key: 'trends.x.bearer_token', label: 'X bearer token', category: 'api_key', unlocks: 'X as a trend source. Reads are billed per post.' },
  { key: 'storage.pinata.jwt', label: 'Pinata JWT', category: 'api_key', unlocks: 'Pinning token metadata and artwork to IPFS.' },
  { key: 'execution.pumpportal.api_key', label: 'PumpPortal API key', category: 'api_key', unlocks: 'The PumpPortal launch adapter.' },
  { key: 'notify.discord.webhook', label: 'Discord webhook', category: 'webhook', unlocks: 'Discord notifications.' },
  { key: 'notify.slack.webhook', label: 'Slack webhook', category: 'webhook', unlocks: 'Slack notifications.' },
  { key: 'notify.telegram.bot_token', label: 'Telegram bot token', category: 'api_key', unlocks: 'Telegram notifications (with the chat ID below).' },
  { key: 'notify.telegram.chat_id', label: 'Telegram chat ID', category: 'config', unlocks: 'Where Telegram notifications are delivered.' },
  { key: 'notify.webhook.url', label: 'Generic webhook URL', category: 'webhook', unlocks: 'Generic webhook notifications.' },
  { key: 'notify.smtp.url', label: 'SMTP URL', category: 'endpoint', unlocks: 'Email notifications.' },
];

interface PhaseDefinition {
  id?: string | null;
  name?: string | null;
  description?: string | null;
  networks?: string[] | null;
  maxAutonomy?: string | null;
}

interface PhasesResponse {
  current?: string | null;
  phases?: PhaseDefinition[] | null;
}

interface SecretMeta {
  key?: string | null;
  category?: string | null;
  hint?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  lastUsedAt?: number | null;
}

interface SaveResponse {
  settings?: Obj;
  changed?: Array<{ path?: string | null; from?: unknown; to?: unknown }> | null;
  sensitiveChanges?: string[] | null;
}

// ---------------------------------------------------------------------------
// Immutable path helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getAt(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const segment of path.split('.')) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function setAt(root: Obj, path: string, value: unknown): Obj {
  const segments = path.split('.');
  const head = segments[0];
  if (head === undefined) return root;
  if (segments.length === 1) return { ...root, [head]: value };
  const child = root[head];
  return { ...root, [head]: setAt(isPlainObject(child) ? child : {}, segments.slice(1).join('.'), value) };
}

/** Arrays are compared as whole values: reordering a list is a real change. */
function diffPaths(base: unknown, draft: unknown, prefix = ''): string[] {
  if (isPlainObject(base) && isPlainObject(draft)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(draft)]);
    const out: string[] = [];
    for (const key of keys) {
      out.push(...diffPaths(base[key], draft[key], prefix ? `${prefix}.${key}` : key));
    }
    return out.sort();
  }
  return JSON.stringify(base ?? null) === JSON.stringify(draft ?? null) ? [] : prefix ? [prefix] : [];
}

function buildPatch(draft: Obj, paths: string[]): Obj {
  let patch: Obj = {};
  for (const path of paths) patch = setAt(patch, path, getAt(draft, path));
  return patch;
}

function isSensitive(path: string): boolean {
  return SENSITIVE_PATHS.some((p) => path === p || path.startsWith(`${p}.`));
}

function requiredPermissions(paths: string[]): string[] {
  const permissions = new Set<string>();
  if (paths.some((p) => p.startsWith('autonomy.'))) permissions.add('edit_autonomy');
  if (paths.some((p) => p.startsWith('limits.') || p.startsWith('qualityGate.'))) permissions.add('edit_limits');
  if (paths.some((p) => p.startsWith('wallet.') || p.startsWith('execution.'))) permissions.add('edit_wallet_config');
  if (paths.includes('emergencyStop')) permissions.add('emergency_stop');
  if (permissions.size === 0 && paths.length > 0) permissions.add('edit_limits');
  return [...permissions];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function maybeNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => str(v)).filter((v) => v.length > 0) : [];
}

// ---------------------------------------------------------------------------
// Field controller
// ---------------------------------------------------------------------------

interface Controller {
  get: (path: string) => unknown;
  set: (path: string, value: unknown) => void;
  changed: (path: string) => boolean;
}

export function SettingsPage() {
  const { can } = useSession();
  const [tab, setTab] = useState<TabId>('phase');
  const [draft, setDraft] = useState<Obj | null>(null);
  const [baseline, setBaseline] = useState<Obj | null>(null);
  const [reason, setReason] = useState('');
  const [saved, setSaved] = useState<SaveResponse | null>(null);

  // Settings are never polled: a background refetch landing mid-edit would
  // silently move the baseline the save bar is diffing against.
  const settingsQuery = useApiQuery<{ settings?: Obj }>(queryKeys.settings, '/api/settings', {
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const phasesQuery = useApiQuery<PhasesResponse>(queryKeys.phases, '/api/settings/phases', {
    staleTime: POLL.slow,
  });

  const server = settingsQuery.data?.settings;

  useEffect(() => {
    if (!server) return;
    setBaseline(server);
    setDraft((current) => current ?? server);
  }, [server]);

  const changedPaths = useMemo(() => (baseline && draft ? diffPaths(baseline, draft) : []), [baseline, draft]);

  const controller = useMemo<Controller>(
    () => ({
      get: (path) => getAt(draft, path),
      set: (path, value) => setDraft((current) => (current ? setAt(current, path, value) : current)),
      changed: (path) => changedPaths.some((p) => p === path || p.startsWith(`${path}.`)),
      readOnly: false,
    }),
    [draft, changedPaths],
  );

  const save = useApiMutation<SaveResponse, { patch: Obj; reason?: string }>('/api/settings', {
    method: 'PATCH',
    invalidate: [queryKeys.settings, queryKeys.phases, queryKeys.systemStatus],
    onSuccess: (result) => {
      if (result.settings) {
        setBaseline(result.settings);
        setDraft(result.settings);
      }
      setReason('');
      setSaved(result);
    },
  });

  const applyPatch = useCallback(
    (patch: Obj, patchReason: string) => {
      setSaved(null);
      save.mutate({ patch, reason: patchReason || undefined });
    },
    [save],
  );

  if (settingsQuery.isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-10 w-full" />
        <LoadingRows rows={8} />
      </div>
    );
  }

  if (settingsQuery.isError) {
    return (
      <Card>
        <ErrorState error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} />
      </Card>
    );
  }

  if (!draft || !baseline) {
    return (
      <Card>
        <EmptyState
          title="No settings were returned"
          description="The settings endpoint answered without a settings object. Restart the server and refresh; if it persists, check the system log on the System health page."
          icon="⚙"
        />
      </Card>
    );
  }

  const currentPhase = str(getAt(draft, 'execution.phase'));
  const phases = phasesQuery.data?.phases ?? [];
  const activePhase = phases.find((p) => str(p.id) === currentPhase) ?? null;
  const phaseMaxAutonomy = str(activePhase?.maxAutonomy) || 'auto';

  const missingPermissions = requiredPermissions(changedPaths).filter((permission) => !can(permission));
  const sensitivePending = changedPaths.filter(isSensitive);

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Settings"
        description="Everything the platform's behaviour depends on. Edits are held locally until you save them; sensitive changes are written to the audit log with your reason attached."
      />

      {saved && <SaveReceipt result={saved} onDismiss={() => setSaved(null)} />}

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'phase' && (
        <PhaseAndAutonomyTab
          ctl={controller}
          phases={phases}
          phasesLoading={phasesQuery.isLoading}
          phasesError={phasesQuery.error}
          onRetryPhases={() => void phasesQuery.refetch()}
          currentPhase={currentPhase}
          phaseMaxAutonomy={phaseMaxAutonomy}
          canEditAutonomy={can('edit_autonomy')}
          canEditExecution={can('edit_wallet_config')}
          onAdvance={(phaseId, advanceReason) => applyPatch({ execution: { phase: phaseId } }, advanceReason)}
          advancing={save.isPending}
          advanceError={save.error}
        />
      )}
      {tab === 'quality' && <QualityGateTab ctl={controller} />}
      {tab === 'limits' && <LimitsTab ctl={controller} />}
      {tab === 'wallet' && <WalletTab ctl={controller} />}
      {tab === 'fees' && <FeesTab ctl={controller} />}
      {tab === 'monitoring' && <MonitoringTab ctl={controller} />}
      {tab === 'research' && <ResearchTab ctl={controller} />}
      {tab === 'ai' && <AiTab ctl={controller} />}
      {tab === 'exploration' && <ExplorationTab ctl={controller} />}
      {tab === 'notifications' && <NotificationsTab ctl={controller} />}
      {tab === 'secrets' && <SecretsTab canManage={can('edit_wallet_config')} />}
      {tab === 'danger' && (
        <DangerZoneTab
          emergencyStop={getAt(draft, 'emergencyStop') === true}
          emergencyStopReason={str(getAt(baseline, 'emergencyStopReason'))}
          canStop={can('emergency_stop')}
        />
      )}

      {changedPaths.length > 0 && (
        <SaveBar
          changedPaths={changedPaths}
          sensitivePaths={sensitivePending}
          missingPermissions={missingPermissions}
          reason={reason}
          onReason={setReason}
          pending={save.isPending}
          error={save.error}
          onDiscard={() => {
            setDraft(baseline);
            setReason('');
            save.reset();
          }}
          onSave={() => applyPatch(buildPatch(draft, changedPaths), reason)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Save bar and receipt
// ---------------------------------------------------------------------------

function SaveBar({
  changedPaths,
  sensitivePaths,
  missingPermissions,
  reason,
  onReason,
  pending,
  error,
  onDiscard,
  onSave,
}: {
  changedPaths: string[];
  sensitivePaths: string[];
  missingPermissions: string[];
  reason: string;
  onReason: (value: string) => void;
  pending: boolean;
  error: Error | null;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const blocked = missingPermissions.length > 0;
  return (
    <div className="sticky bottom-16 z-20 lg:bottom-4">
      <div className="card-raised border-accent-dim p-4 shadow-2xl shadow-black/60">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="accent">
                <span aria-hidden="true">●</span>
                {changedPaths.length} unsaved change{changedPaths.length === 1 ? '' : 's'}
              </Badge>
              {sensitivePaths.length > 0 && (
                <Badge tone="warning">
                  <span aria-hidden="true">▲</span>
                  {sensitivePaths.length} sensitive
                </Badge>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {changedPaths.slice(0, 12).map((path) => (
                <span
                  key={path}
                  className={[
                    'chip border font-mono text-[10px]',
                    isSensitive(path)
                      ? 'border-warning-dim bg-warning-dim/30 text-warning'
                      : 'border-border bg-surface text-ink-muted',
                  ].join(' ')}
                >
                  {path}
                </span>
              ))}
              {changedPaths.length > 12 && (
                <span className="chip border border-border bg-surface text-[10px] text-ink-subtle">
                  +{changedPaths.length - 12} more
                </span>
              )}
            </div>
          </div>

          <div className="flex shrink-0 gap-2">
            <button className="btn btn-ghost" onClick={onDiscard} disabled={pending}>
              Discard
            </button>
            <button className="btn btn-primary" onClick={onSave} disabled={pending || blocked}>
              {pending ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>

        <div className="mt-3">
          <label className="label" htmlFor="settings-reason">
            Reason {sensitivePaths.length > 0 ? '(recommended — it is stored with the audit entry)' : '(optional)'}
          </label>
          <input
            id="settings-reason"
            className="input"
            value={reason}
            maxLength={500}
            placeholder="Why are you making this change?"
            onChange={(e) => onReason(e.target.value)}
          />
        </div>

        {sensitivePaths.length > 0 && (
          <div className="mt-3">
            <Note tone="warning">
              <span aria-hidden="true">▲ </span>
              {sensitivePaths.join(', ')} {sensitivePaths.length === 1 ? 'is' : 'are'} classified as sensitive. Saving
              records the before and after values in the hash-chained audit log against your account.
            </Note>
          </div>
        )}

        {blocked && (
          <div className="mt-3">
            <Note tone="negative">
              Your role cannot save these changes. They need: {missingPermissions.map(humanise).join(', ')}. Discard them
              or ask an owner to apply them.
            </Note>
          </div>
        )}

        {error && (
          <div className="mt-3">
            <Note tone="negative">{error.message}</Note>
          </div>
        )}
      </div>
    </div>
  );
}

function SaveReceipt({ result, onDismiss }: { result: SaveResponse; onDismiss: () => void }) {
  const changed = result.changed ?? [];
  const sensitive = result.sensitiveChanges ?? [];
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div className="text-sm font-semibold text-positive">
            <span aria-hidden="true">● </span>
            Saved {formatNumber(changed.length)} change{changed.length === 1 ? '' : 's'}
          </div>
          {changed.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {changed.map((entry, index) => (
                <span
                  key={`${str(entry.path)}-${index}`}
                  className="chip border border-border bg-surface font-mono text-[10px] text-ink-muted"
                >
                  {str(entry.path)}: {str(entry.from) || '∅'} → {str(entry.to) || '∅'}
                </span>
              ))}
            </div>
          )}
          {sensitive.length > 0 ? (
            <Note tone="warning">
              <span aria-hidden="true">▲ </span>
              {sensitive.length} sensitive path{sensitive.length === 1 ? '' : 's'} changed ({sensitive.join(', ')}). These
              were written to the audit log with your account, the previous value and your reason. You can verify the
              chain on the System health page.
            </Note>
          ) : (
            <Note tone="neutral">
              No sensitive paths were touched. The change is still recorded in the settings history.
            </Note>
          )}
        </div>
        <button className="text-ink-subtle transition-colors hover:text-ink" onClick={onDismiss} aria-label="Dismiss">
          ✕
        </button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Field primitives
// ---------------------------------------------------------------------------

function FieldShell({
  id,
  label,
  help,
  changed,
  children,
}: {
  id: string;
  label: string;
  help: string;
  changed: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={[
        'rounded-xl border p-3',
        changed ? 'border-accent-dim bg-accent-dim/10' : 'border-border bg-surface-raised',
      ].join(' ')}
    >
      <div className="flex items-baseline justify-between gap-2">
        <label className="label mb-0" htmlFor={id}>
          {label}
        </label>
        {changed && <span className="text-[10px] font-semibold uppercase tracking-wide text-accent-soft">Edited</span>}
      </div>
      <div className="mt-2">{children}</div>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-subtle">{help}</p>
    </div>
  );
}

function NumberField({
  ctl,
  path,
  label,
  help,
  unit,
  min,
  max,
  step = 1,
}: {
  ctl: Controller;
  path: string;
  label: string;
  help: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  const id = `f-${path}`;
  const raw = maybeNum(ctl.get(path));
  const outOfRange =
    raw !== null && ((min !== undefined && raw < min) || (max !== undefined && raw > max));

  return (
    <FieldShell id={id} label={label} help={help} changed={ctl.changed(path)}>
      <div className="flex items-center gap-2">
        <input
          id={id}
          className="input tnum"
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={raw === null ? '' : raw}
          aria-describedby={`${id}-range`}
          onChange={(e) => {
            const next = e.target.value === '' ? null : Number(e.target.value);
            ctl.set(path, next === null || !Number.isFinite(next) ? 0 : next);
          }}
        />
        {unit && <span className="shrink-0 text-xs text-ink-subtle">{unit}</span>}
      </div>
      <div id={`${id}-range`} className="tnum mt-1 text-[11px] text-ink-subtle">
        Range {min ?? '—'} to {max ?? '—'}
        {unit ? ` ${unit}` : ''}
      </div>
      {outOfRange && (
        <div className="mt-1.5">
          <Note tone="warning">
            <span aria-hidden="true">▲ </span>Outside the accepted range; the server will reject this value.
          </Note>
        </div>
      )}
    </FieldShell>
  );
}

function ToggleField({ ctl, path, label, help }: { ctl: Controller; path: string; label: string; help: string }) {
  const id = `f-${path}`;
  const value = ctl.get(path) === true;
  return (
    <FieldShell id={id} label={label} help={help} changed={ctl.changed(path)}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => ctl.set(path, !value)}
        className={[
          'flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm transition-colors',
          value ? 'border-positive-dim bg-positive-dim/30 text-positive' : 'border-border bg-ground text-ink-muted',
        ].join(' ')}
      >
        <span>{value ? 'Enabled' : 'Disabled'}</span>
        <span aria-hidden="true">{value ? '●' : '○'}</span>
      </button>
    </FieldShell>
  );
}

function SelectField({
  ctl,
  path,
  label,
  help,
  options,
  disabledOptions,
}: {
  ctl: Controller;
  path: string;
  label: string;
  help: string;
  options: Array<{ value: string; label: string }>;
  disabledOptions?: string[];
}) {
  const id = `f-${path}`;
  const value = str(ctl.get(path));
  return (
    <FieldShell id={id} label={label} help={help} changed={ctl.changed(path)}>
      <select id={id} className="input" value={value} onChange={(e) => ctl.set(path, e.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={disabledOptions?.includes(option.value)}>
            {option.label}
            {disabledOptions?.includes(option.value) ? ' — not available in this phase' : ''}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

function TextField({
  ctl,
  path,
  label,
  help,
  placeholder,
}: {
  ctl: Controller;
  path: string;
  label: string;
  help: string;
  placeholder?: string;
}) {
  const id = `f-${path}`;
  const value = str(ctl.get(path));
  return (
    <FieldShell id={id} label={label} help={help} changed={ctl.changed(path)}>
      <input
        id={id}
        className="input font-mono text-xs"
        value={value}
        placeholder={placeholder}
        onChange={(e) => ctl.set(path, e.target.value)}
      />
    </FieldShell>
  );
}

/** String arrays are edited as one entry per line — a comma is legal content. */
function ListField({
  ctl,
  path,
  label,
  help,
  placeholder,
}: {
  ctl: Controller;
  path: string;
  label: string;
  help: string;
  placeholder?: string;
}) {
  const id = `f-${path}`;
  const items = strArray(ctl.get(path));
  return (
    <FieldShell id={id} label={label} help={help} changed={ctl.changed(path)}>
      <textarea
        id={id}
        className="input min-h-24 font-mono text-xs"
        value={items.join('\n')}
        placeholder={placeholder}
        onChange={(e) =>
          ctl.set(
            path,
            e.target.value
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line.length > 0),
          )
        }
      />
      <div className="tnum mt-1 text-[11px] text-ink-subtle">{items.length} entr{items.length === 1 ? 'y' : 'ies'}</div>
    </FieldShell>
  );
}

function CheckboxGroupField({
  ctl,
  path,
  label,
  help,
  options,
}: {
  ctl: Controller;
  path: string;
  label: string;
  help: string;
  options: Array<{ id: string; label: string; hint?: string }>;
}) {
  const id = `f-${path}`;
  const selected = strArray(ctl.get(path));
  const toggle = (option: string) => {
    ctl.set(path, selected.includes(option) ? selected.filter((v) => v !== option) : [...selected, option]);
  };
  return (
    <FieldShell id={id} label={label} help={help} changed={ctl.changed(path)}>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
        {options.map((option) => {
          const active = selected.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={active}
              title={option.hint}
              onClick={() => toggle(option.id)}
              className={[
                'chip border transition-colors',
                active
                  ? 'border-accent-dim bg-accent-dim/40 text-accent-soft'
                  : 'border-border bg-surface text-ink-subtle hover:text-ink-muted',
              ].join(' ')}
            >
              <span aria-hidden="true">{active ? '✓' : '＋'}</span>
              {option.label}
            </button>
          );
        })}
      </div>
      <div className="tnum mt-1.5 text-[11px] text-ink-subtle">{selected.length} selected</div>
    </FieldShell>
  );
}

function Group({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card>
      <SectionHeader title={title} description={description} />
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{children}</div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Phase & autonomy
// ---------------------------------------------------------------------------

function PhaseAndAutonomyTab({
  ctl,
  phases,
  phasesLoading,
  phasesError,
  onRetryPhases,
  currentPhase,
  phaseMaxAutonomy,
  canEditAutonomy,
  canEditExecution,
  onAdvance,
  advancing,
  advanceError,
}: {
  ctl: Controller;
  phases: PhaseDefinition[];
  phasesLoading: boolean;
  phasesError: Error | null;
  onRetryPhases: () => void;
  currentPhase: string;
  phaseMaxAutonomy: string;
  canEditAutonomy: boolean;
  canEditExecution: boolean;
  onAdvance: (phaseId: string, reason: string) => void;
  advancing: boolean;
  advanceError: Error | null;
}) {
  const [target, setTarget] = useState<PhaseDefinition | null>(null);
  const currentIndex = phases.findIndex((p) => str(p.id) === currentPhase);
  const activePhase = currentIndex >= 0 ? phases[currentIndex] : undefined;
  const allowedNetworks = strArray(activePhase?.networks);

  return (
    <div className="space-y-4">
      <Card>
        <SectionHeader
          title="Operating phase"
          description="The ladder that gates unattended action. Each rung must be climbed deliberately; the server refuses a network or an autonomy level the current phase does not permit."
        />
        <div className="mt-4">
          {phasesLoading ? (
            <LoadingRows rows={5} />
          ) : phasesError ? (
            <ErrorState error={phasesError} onRetry={onRetryPhases} />
          ) : phases.length === 0 ? (
            <EmptyState
              title="The phase ladder is unavailable"
              description="The server did not return the phase definitions, so this page cannot show what each step unlocks. Refresh, and check the System health page if it stays empty."
              icon="◭"
            />
          ) : (
            <ol className="space-y-0">
              {phases.map((phase, index) => (
                <PhaseStep
                  key={str(phase.id)}
                  phase={phase}
                  index={index}
                  last={index === phases.length - 1}
                  state={index === currentIndex ? 'current' : index < currentIndex ? 'passed' : 'ahead'}
                  canChange={canEditExecution}
                  onSelect={() => setTarget(phase)}
                />
              ))}
            </ol>
          )}
        </div>
        {!canEditExecution && phases.length > 0 && (
          <div className="mt-3">
            <Note tone="neutral">
              Changing the phase needs the “edit wallet config” permission. You can see the ladder but not move on it.
            </Note>
          </div>
        )}
      </Card>

      <Group
        title="Execution target"
        description="Which network launches are submitted to. The phase ladder is what constrains this, so raise the phase first if the network you want is unavailable."
      >
        <SelectField
          ctl={ctl}
          path="execution.network"
          label="Network"
          help="Simulation broadcasts nothing. Devnet uses real transactions with worthless SOL — note its bonding-curve reserves differ from mainnet, so pricing will not match. Mainnet spends real money."
          options={[
            { value: 'simulation', label: 'Simulation' },
            { value: 'devnet', label: 'Devnet' },
            { value: 'mainnet', label: 'Mainnet' },
          ]}
          disabledOptions={
            allowedNetworks.length > 0
              ? ['simulation', 'devnet', 'mainnet'].filter((n) => !allowedNetworks.includes(n))
              : []
          }
        />
      </Group>

      <Card>
        <SectionHeader
          title="Autonomy"
          description="How much each capability may do without a human. Four levels, applied per capability."
        />

        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {AUTONOMY_LEVELS.map((level) => (
            <div key={level} className="rounded-lg border border-border bg-surface-raised px-3 py-2">
              <div className="text-xs font-semibold text-ink">{humanise(level)}</div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-ink-subtle">{AUTONOMY_LEVEL_HELP[level]}</p>
            </div>
          ))}
        </div>

        {AUTONOMY_RANK[phaseMaxAutonomy] !== undefined && AUTONOMY_RANK[phaseMaxAutonomy] < 3 && (
          <div className="mt-3">
            <Note tone="info">
              {humanise(currentPhase.replace(/^phase\d_/, '')) || 'The current phase'} caps autonomy at{' '}
              <strong className="font-semibold">{humanise(phaseMaxAutonomy)}</strong> for the four capabilities with
              real-world side effects (launch, social, fee collection, wallet transfer). Research, concept generation,
              artwork and metadata are never capped — the ladder gates unattended action, not the approval queue.
            </Note>
          </div>
        )}

        {!canEditAutonomy && (
          <div className="mt-3">
            <Note tone="neutral">Changing autonomy needs the “edit autonomy” permission.</Note>
          </div>
        )}

        <div className="mt-4 space-y-2">
          {AUTONOMY_CAPABILITIES.map((capability) => (
            <AutonomyRow
              key={capability.id}
              ctl={ctl}
              capability={capability}
              ceiling={capability.capped ? (AUTONOMY_RANK[phaseMaxAutonomy] ?? 3) : 3}
              ceilingLabel={phaseMaxAutonomy}
              disabled={!canEditAutonomy}
            />
          ))}
        </div>
      </Card>

      <PhaseChangeModal
        target={target}
        currentPhase={currentPhase}
        currentIndex={currentIndex}
        phases={phases}
        pending={advancing}
        error={advanceError}
        onClose={() => setTarget(null)}
        onConfirm={(reason) => {
          if (target) onAdvance(str(target.id), reason);
          setTarget(null);
        }}
      />
    </div>
  );
}

function PhaseStep({
  phase,
  index,
  last,
  state,
  canChange,
  onSelect,
}: {
  phase: PhaseDefinition;
  index: number;
  last: boolean;
  state: 'passed' | 'current' | 'ahead';
  canChange: boolean;
  onSelect: () => void;
}) {
  const networks = strArray(phase.networks);
  const mainnet = networks.includes('mainnet');

  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center">
        <div
          className={[
            'tnum flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
            state === 'current'
              ? 'border-accent bg-accent text-white'
              : state === 'passed'
                ? 'border-border bg-surface-raised text-ink-muted'
                : 'border-border bg-surface text-ink-subtle',
          ].join(' ')}
          aria-hidden="true"
        >
          {state === 'passed' ? '✓' : index + 1}
        </div>
        {!last && <div className="w-px flex-1 bg-border" />}
      </div>

      <div className={['min-w-0 flex-1', last ? 'pb-0' : 'pb-5'].join(' ')}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-ink">{str(phase.name) || humanise(str(phase.id))}</span>
          {state === 'current' && <Badge tone="accent">Current phase</Badge>}
          {mainnet && (
            <Badge tone="negative">
              <span aria-hidden="true">▲</span>Real funds
            </Badge>
          )}
        </div>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-ink-muted">{str(phase.description)}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {networks.map((network) => (
            <Badge key={network} tone={network === 'mainnet' ? 'negative' : network === 'devnet' ? 'warning' : 'info'}>
              {humanise(network)}
            </Badge>
          ))}
          <span className="text-[11px] text-ink-subtle">Max autonomy: {humanise(str(phase.maxAutonomy))}</span>
        </div>
        {state !== 'current' && canChange && (
          <button
            className={['btn mt-2 px-2.5 py-1 text-xs', state === 'ahead' && mainnet ? 'btn-danger' : 'btn-ghost'].join(' ')}
            onClick={onSelect}
          >
            {state === 'ahead' ? 'Advance to this phase' : 'Return to this phase'}
          </button>
        )}
      </div>
    </li>
  );
}

function PhaseChangeModal({
  target,
  currentPhase,
  currentIndex,
  phases,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  target: PhaseDefinition | null;
  currentPhase: string;
  currentIndex: number;
  phases: PhaseDefinition[];
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [phrase, setPhrase] = useState('');

  const targetIndex = target ? phases.findIndex((p) => str(p.id) === str(target.id)) : -1;
  const advancing = targetIndex > currentIndex;
  const targetNetworks = strArray(target?.networks);
  const currentNetworks = strArray(phases[currentIndex >= 0 ? currentIndex : 0]?.networks);
  // Only the step that first unlocks mainnet gets the typed-phrase treatment.
  const unlocksMainnet = advancing && targetNetworks.includes('mainnet') && !currentNetworks.includes('mainnet');

  const reasonOk = reason.trim().length >= 3;
  const phraseOk = !unlocksMainnet || phrase.trim().toUpperCase() === 'ENABLE MAINNET';
  const ready = reasonOk && phraseOk && !pending;

  const close = () => {
    setReason('');
    setPhrase('');
    onClose();
  };

  return (
    <Modal
      open={target !== null}
      onClose={close}
      title={
        target
          ? `${advancing ? 'Advance to' : 'Return to'} ${str(target.name) || humanise(str(target.id))}`
          : 'Change phase'
      }
      footer={
        <>
          <button className="btn btn-ghost" onClick={close}>
            Cancel
          </button>
          <button
            className={unlocksMainnet ? 'btn btn-danger' : 'btn btn-primary'}
            disabled={!ready}
            onClick={() => {
              onConfirm(reason.trim());
              setReason('');
              setPhrase('');
            }}
          >
            {pending ? 'Applying…' : unlocksMainnet ? 'Enable mainnet' : advancing ? 'Advance phase' : 'Return to phase'}
          </button>
        </>
      }
    >
      {target && (
        <div className="space-y-3">
          {unlocksMainnet && (
            <Note tone="negative">
              <span aria-hidden="true">■ </span>
              <strong className="font-semibold">This unlocks mainnet.</strong> From this phase onward the platform can
              submit transactions that spend real SOL, and a launch cannot be undone. Make sure the spend limits, the
              wallet balance floor and the quality gate are where you want them before continuing.
            </Note>
          )}

          <div className="rounded-lg border border-border bg-surface-raised p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">What this phase allows</div>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{str(target.description)}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {targetNetworks.map((network) => (
                <Badge key={network} tone={network === 'mainnet' ? 'negative' : network === 'devnet' ? 'warning' : 'info'}>
                  {humanise(network)}
                </Badge>
              ))}
              <span className="text-[11px] text-ink-subtle">Max autonomy: {humanise(str(target.maxAutonomy))}</span>
            </div>
          </div>

          {!advancing && (
            <Note tone="info">
              Moving back down the ladder is safe. Any autonomy level above the new ceiling is clamped down to it rather
              than blocking the change.
            </Note>
          )}

          <div>
            <label className="label" htmlFor="phase-reason">
              Reason (required)
            </label>
            <input
              id="phase-reason"
              className="input"
              value={reason}
              maxLength={500}
              placeholder="e.g. Devnet run completed with 40 clean launches"
              onChange={(e) => setReason(e.target.value)}
            />
            <p className="mt-1.5 text-xs text-ink-subtle">
              Changing the phase from {humanise(currentPhase.replace(/^phase\d_/, '')) || 'the current phase'} is a
              sensitive change; this reason is stored in the audit log. At least 3 characters.
            </p>
          </div>

          {unlocksMainnet && (
            <div>
              <label className="label" htmlFor="phase-phrase">
                Type <span className="font-mono">ENABLE MAINNET</span> to confirm
              </label>
              <input
                id="phase-phrase"
                className="input font-mono"
                value={phrase}
                autoComplete="off"
                onChange={(e) => setPhrase(e.target.value)}
              />
            </div>
          )}

          {error && <Note tone="negative">{error.message}</Note>}
        </div>
      )}
    </Modal>
  );
}

function AutonomyRow({
  ctl,
  capability,
  ceiling,
  ceilingLabel,
  disabled,
}: {
  ctl: Controller;
  capability: { id: string; label: string; help: string; capped: boolean };
  ceiling: number;
  ceilingLabel: string;
  disabled: boolean;
}) {
  const path = `autonomy.${capability.id}`;
  const value = str(ctl.get(path));
  const changed = ctl.changed(path);

  return (
    <div
      className={[
        'rounded-xl border p-3',
        changed ? 'border-accent-dim bg-accent-dim/10' : 'border-border bg-surface-raised',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-ink">{capability.label}</span>
            {changed && <span className="text-[10px] font-semibold uppercase tracking-wide text-accent-soft">Edited</span>}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-subtle">{capability.help}</p>
        </div>

        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={`${capability.label} autonomy`}>
          {AUTONOMY_LEVELS.map((level) => {
            const blocked = (AUTONOMY_RANK[level] ?? 0) > ceiling;
            const active = value === level;
            return (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled || (blocked && !active)}
                title={
                  blocked
                    ? `The current phase caps this at ${humanise(ceilingLabel)}. Advance the phase to allow "${level}".`
                    : AUTONOMY_LEVEL_HELP[level]
                }
                onClick={() => ctl.set(path, level)}
                className={[
                  'rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
                  active
                    ? 'border-accent bg-accent-dim/50 text-accent-soft'
                    : blocked
                      ? 'cursor-not-allowed border-border bg-surface text-ink-subtle/50'
                      : 'border-border bg-surface text-ink-subtle hover:text-ink-muted',
                ].join(' ')}
              >
                {humanise(level)}
                {blocked && !active && <span aria-hidden="true"> 🔒</span>}
              </button>
            );
          })}
        </div>
      </div>

      {capability.capped && ceiling < 3 && (
        <p className="mt-2 text-[11px] leading-relaxed text-info">
          Capped at {humanise(ceilingLabel)} by the current phase. Selecting a higher level here would be rejected by the
          server, so it is disabled rather than left to fail.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setting tabs
// ---------------------------------------------------------------------------

function QualityGateTab({ ctl }: { ctl: Controller }) {
  return (
    <div className="space-y-4">
      <Note tone="neutral">
        The quality gate is what stops a weak idea reaching a transaction. Raising any threshold reduces launch volume
        and raises average quality; lowering it does the opposite. Nothing here overrides the phase ladder.
      </Note>

      <Group title="Score thresholds" description="Minimum modelled quality a candidate must reach to proceed.">
        <NumberField
          ctl={ctl}
          path="qualityGate.minOpportunityScore"
          label="Minimum opportunity score"
          unit="/ 100"
          min={0}
          max={100}
          step={1}
          help="Composite trend score. Candidates below this never reach concept evaluation."
        />
        <NumberField
          ctl={ctl}
          path="qualityGate.minOriginalityScore"
          label="Minimum originality"
          unit="0–1"
          min={0}
          max={1}
          step={0.01}
          help="How distinct the concept is from tokens that already exist. Higher means fewer copycats."
        />
        <NumberField
          ctl={ctl}
          path="qualityGate.maxSaturationScore"
          label="Maximum saturation"
          unit="0–1"
          min={0}
          max={1}
          step={0.01}
          help="How crowded the trend already is. Lower means the platform only acts on trends nobody has flooded yet."
        />
        <NumberField
          ctl={ctl}
          path="qualityGate.minSourceBreadth"
          label="Minimum independent sources"
          unit="sources"
          min={1}
          max={10}
          step={1}
          help="How many genuinely different populations must show the trend. Two Fediverse instances do not count as two."
        />
        <NumberField
          ctl={ctl}
          path="qualityGate.maxTrendAgeHours"
          label="Maximum trend age"
          unit="hours"
          min={1}
          max={720}
          step={1}
          help="Trends older than this are treated as stale and rejected."
        />
      </Group>

      <Group
        title="Modelled outcome thresholds"
        description="Gates on the prediction model's own output. These are estimates from historical launches, not guarantees — check the model's calibration on the AI learning page before leaning on them."
      >
        <NumberField
          ctl={ctl}
          path="qualityGate.minProbabilityTenHolders"
          label="Min. P(≥10 organic holders)"
          unit="0–1"
          min={0}
          max={1}
          step={0.01}
          help="Modelled chance the token attracts at least ten independent holders."
        />
        <NumberField
          ctl={ctl}
          path="qualityGate.minExpectedValueSol"
          label="Minimum expected value"
          unit="SOL"
          min={-1}
          max={10}
          step={0.01}
          help="Modelled expected value net of launch costs. Zero means the platform will not launch anything it expects to lose money on."
        />
        <NumberField
          ctl={ctl}
          path="qualityGate.minProbabilityProfitable"
          label="Min. P(net profitable)"
          unit="0–1"
          min={0}
          max={1}
          step={0.01}
          help="Modelled chance the launch ends up profitable after fees."
        />
      </Group>

      <Group title="Hard blocks" description="Rules that stop a launch outright rather than scoring it down.">
        <ToggleField
          ctl={ctl}
          path="qualityGate.blockOnHardCollision"
          label="Block on hard name collision"
          help="Refuse to launch when the name or ticker already belongs to a live token. Turning this off invites impersonation claims."
        />
        <ToggleField
          ctl={ctl}
          path="qualityGate.humanReviewOnAnyRiskFlag"
          label="Human review on any risk flag"
          help="Route a candidate to the approval queue whenever any risk flag fires, including soft ones."
        />
      </Group>
    </div>
  );
}

function LimitsTab({ ctl }: { ctl: Controller }) {
  return (
    <div className="space-y-4">
      <Note tone="warning">
        <span aria-hidden="true">▲ </span>These are the hard ceilings on what the platform can spend and how often it can
        act. They are the last line of defence if a model or a provider misbehaves, so raise them deliberately.
      </Note>

      <Group title="Rate limits" description="How often the platform may launch.">
        <NumberField ctl={ctl} path="limits.maxLaunchesPerHour" label="Max launches per hour" unit="launches" min={0} max={20} step={1} help="A hard hourly ceiling. Zero suspends launching entirely." />
        <NumberField ctl={ctl} path="limits.maxLaunchesPerDay" label="Max launches per day" unit="launches" min={0} max={50} step={1} help="A hard daily ceiling, checked independently of the hourly one." />
      </Group>

      <Group title="Spend limits" description="Ceilings on SOL and AI spend. Every one is enforced server-side before a transaction is built.">
        <NumberField ctl={ctl} path="limits.maxSolPerTransaction" label="Max SOL per transaction" unit="SOL" min={0} max={5} step={0.01} help="No single transaction may exceed this, including the optional dev buy." />
        <NumberField ctl={ctl} path="limits.maxSolPerHour" label="Max SOL per hour" unit="SOL" min={0} max={20} step={0.01} help="Rolling hourly spend cap across all transactions." />
        <NumberField ctl={ctl} path="limits.maxSolSpendPerDay" label="Max SOL per day" unit="SOL" min={0} max={100} step={0.01} help="Rolling daily spend cap. The most important single number on this page." />
        <NumberField ctl={ctl} path="limits.walletBalanceFloorSol" label="Wallet balance floor" unit="SOL" min={0} max={10} step={0.01} help="All spending stops when the operating wallet falls below this, leaving enough for fees to recover." />
        <NumberField ctl={ctl} path="limits.maxAiSpendUsdPerDay" label="Max AI spend per day" unit="USD" min={0} max={1000} step={1} help="Daily ceiling on model API spend. Reaching it pauses generation, not monitoring." />
      </Group>

      <Group title="Failure handling" description="When the platform should stop trusting itself or a dependency.">
        <NumberField ctl={ctl} path="limits.consecutiveFailureShutdown" label="Consecutive failures before shutdown" unit="failures" min={1} max={20} step={1} help="Consecutive launch failures that trigger a self-imposed halt." />
        <NumberField ctl={ctl} path="limits.rpcFailureThreshold" label="RPC failures before marking down" unit="failures" min={1} max={50} step={1} help="Consecutive RPC errors before the pool is treated as down and failover kicks in." />
        <NumberField ctl={ctl} path="limits.maxTransactionRetries" label="Max transaction retries" unit="retries" min={0} max={10} step={1} help="How many times a failed transaction is resubmitted before it is abandoned." />
        <NumberField ctl={ctl} path="limits.maxClockDriftSeconds" label="Max clock drift" unit="seconds" min={1} max={3600} step={1} help="The platform refuses to run if the machine clock drifts beyond this — signing with a bad clock produces transactions that fail in confusing ways." />
      </Group>

      <Group
        title="Transaction execution"
        description="How launch transactions are built and submitted. These affect cost and inclusion, not what gets launched."
      >
        <NumberField ctl={ctl} path="execution.devBuySol" label="Developer buy" unit="SOL" min={0} max={5} step={0.01} help="Optional initial buy at launch. Zero means create-only, which risks nothing beyond the fee." />
        <NumberField ctl={ctl} path="execution.slippageBps" label="Slippage tolerance" unit="bps" min={0} max={10000} step={10} help="Basis points of price movement tolerated on the dev buy. 500 bps is 5%." />
        <NumberField ctl={ctl} path="execution.priorityFeeMicroLamports" label="Priority fee" unit="µlamports/CU" min={0} max={10_000_000} step={1000} help="Per-compute-unit priority fee. Zero auto-estimates from recent network conditions." />
        <NumberField ctl={ctl} path="execution.jitoTipSol" label="Jito tip" unit="SOL" min={0} max={1} step={0.0001} help="Tip for bundle submission. Zero disables bundles and submits normally." />
        <SelectField
          ctl={ctl}
          path="execution.adapter"
          label="Launch adapter"
          help="Which execution path builds the transaction. Auto picks the best available for the current network."
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'pumpportal_local', label: 'PumpPortal (local signing)' },
            { value: 'pumpfun_sdk', label: 'Pump.fun SDK' },
            { value: 'simulation', label: 'Simulation' },
          ]}
        />
        <SelectField
          ctl={ctl}
          path="execution.commitment"
          label="Confirmation commitment"
          help="How settled a transaction must be before it counts as confirmed. Finalized is safest and slowest."
          options={[
            { value: 'processed', label: 'Processed' },
            { value: 'confirmed', label: 'Confirmed' },
            { value: 'finalized', label: 'Finalized' },
          ]}
        />
      </Group>
    </div>
  );
}

function WalletTab({ ctl }: { ctl: Controller }) {
  return (
    <div className="space-y-4">
      <Note tone="neutral">
        No key material is stored here. The operating wallet keystore lives in the encrypted secret store under
        Providers &amp; secrets; this tab only decides when SOL moves.
      </Note>
      <Group title="Treasury sweeps" description="Moving surplus SOL out of the hot operating wallet.">
        <NumberField ctl={ctl} path="wallet.sweepThresholdSol" label="Sweep threshold" unit="SOL" min={0} max={100} step={0.01} help="Balance above which surplus is swept to treasury. Keeping the hot wallet thin limits what a compromise costs." />
        <NumberField ctl={ctl} path="wallet.operatingFloatSol" label="Operating float" unit="SOL" min={0} max={50} step={0.01} help="How much is left behind after a sweep so the platform can keep paying fees." />
        <ToggleField ctl={ctl} path="wallet.autoSweepEnabled" label="Automatic sweeps" help="Sweep without asking. This also requires wallet transfer autonomy to be set to Auto — both must be true." />
        <TextField ctl={ctl} path="wallet.treasuryAddress" label="Treasury address" placeholder="Solana public key" help="Destination for sweeps. The platform never holds a signing key for this address; verify it character by character." />
      </Group>
    </div>
  );
}

function FeesTab({ ctl }: { ctl: Controller }) {
  return (
    <div className="space-y-4">
      <Note tone="neutral">
        Collecting creator fees costs a transaction fee. These settings exist so the platform does not spend more on
        claiming than the claim is worth.
      </Note>
      <Group title="Collection economics" description="When an accrued balance is worth a transaction.">
        <NumberField ctl={ctl} path="fees.collectionThresholdSol" label="Collection threshold" unit="SOL" min={0} max={5} step={0.0001} help="Minimum accrued balance before a collection is attempted at all." />
        <NumberField ctl={ctl} path="fees.minCollectionValueRatio" label="Minimum value ratio" unit="×" min={1} max={100} step={0.5} help="Accrued fees must be at least this many times the estimated transaction cost. Five means claiming 0.005 SOL for a 0.001 SOL fee is refused." />
        <NumberField ctl={ctl} path="fees.minHoursBetweenCollections" label="Minimum interval per token" unit="hours" min={0} max={720} step={1} help="Never collect from the same token more often than this, regardless of balance." />
        <NumberField ctl={ctl} path="fees.forceCollectionIntervalHours" label="Forced sweep interval" unit="hours" min={0} max={2160} step={1} help="Collect from every token with any balance at least this often, so dust does not sit uncollected forever." />
      </Group>
    </div>
  );
}

function MonitoringTab({ ctl }: { ctl: Controller }) {
  return (
    <div className="space-y-4">
      <Note tone="neutral">
        Tokens are polled fastest immediately after launch and progressively more slowly as they go quiet. Shorter
        intervals cost provider quota; longer ones mean the dashboard lags reality.
      </Note>
      <Group title="Poll intervals" description="How often each tier of token is refreshed.">
        <NumberField ctl={ctl} path="monitoring.hotIntervalSeconds" label="Hot interval" unit="seconds" min={15} max={3600} step={5} help="Newly launched tokens, where the first hours decide the outcome." />
        <NumberField ctl={ctl} path="monitoring.warmIntervalSeconds" label="Warm interval" unit="seconds" min={60} max={21600} step={30} help="Tokens past the opening window but still active." />
        <NumberField ctl={ctl} path="monitoring.coolIntervalSeconds" label="Cool interval" unit="seconds" min={300} max={86400} step={60} help="Older tokens that still show some activity." />
        <NumberField ctl={ctl} path="monitoring.dormantIntervalSeconds" label="Dormant interval" unit="seconds" min={3600} max={604800} step={3600} help="Tokens with no volume and no holder growth. Kept only so a revival is noticed." />
      </Group>
      <Group title="Tier windows" description="When a token moves down a tier.">
        <NumberField ctl={ctl} path="monitoring.hotWindowHours" label="Hot window" unit="hours" min={0.25} max={72} step={0.25} help="How long after launch a token stays on the hot interval." />
        <NumberField ctl={ctl} path="monitoring.warmWindowHours" label="Warm window" unit="hours" min={1} max={720} step={1} help="How long a token stays warm before cooling." />
        <NumberField ctl={ctl} path="monitoring.dormantAfterQuietHours" label="Dormant after" unit="hours" min={1} max={2160} step={1} help="Hours of no volume and no holder growth before a token is marked dormant." />
      </Group>
    </div>
  );
}

function ResearchTab({ ctl }: { ctl: Controller }) {
  return (
    <div className="space-y-4">
      <Note tone="info">
        The sources marked “no key” work on a fresh install with no signup, which is why the platform can discover
        opportunities out of the box. Reddit and X need credentials and are off by default: Reddit's unauthenticated
        endpoints now refuse requests, and X bills per post read.
      </Note>

      <Card>
        <SectionHeader title="Sources" description="Where trends come from. Breadth across genuinely different populations matters more than volume from any one." />
        <div className="mt-4 grid gap-3">
          <CheckboxGroupField
            ctl={ctl}
            path="research.enabledSources"
            label="Enabled sources"
            help="A source with no credential will report as unconfigured on the System health page rather than failing."
            options={TREND_SOURCES.map((source) => ({
              id: source.id,
              label: `${source.label}${source.zeroAuth ? '' : ' (key)'}`,
              hint: source.zeroAuth ? 'Works with no credential.' : 'Requires a credential in Providers & secrets.',
            }))}
          />
        </div>
      </Card>

      <Group title="Discovery cadence" description="How often and how widely the platform looks.">
        <NumberField ctl={ctl} path="research.discoveryIntervalMinutes" label="Discovery interval" unit="minutes" min={5} max={1440} step={5} help="How often every enabled source is swept. Shorter means fresher trends and more quota consumed." />
        <NumberField ctl={ctl} path="research.maxActiveTrends" label="Max active trends" unit="trends" min={10} max={5000} step={10} help="Size of the working set. Older or weaker trends are retired beyond this." />
        <NumberField ctl={ctl} path="research.conceptGenerationThreshold" label="Concept generation threshold" unit="/ 100" min={0} max={100} step={1} help="Opportunity score a trend must reach before any AI spend is committed to it." />
        <NumberField ctl={ctl} path="research.conceptsPerOpportunity" label="Concepts per opportunity" unit="concepts" min={1} max={12} step={1} help="How many concepts are generated per qualifying trend. More costs more and gives the gate more to choose from." />
      </Group>

      <Card>
        <SectionHeader title="Source configuration" description="Extra inputs the operator wants watched. One entry per line." />
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <ListField ctl={ctl} path="research.googleTrendsRegions" label="Google Trends regions" placeholder="US" help="ISO-3166 alpha-2 region codes to sweep. Adding regions widens coverage and multiplies request volume." />
          <ListField ctl={ctl} path="research.mastodonInstances" label="Mastodon instances" placeholder="mastodon.social" help="Instances to poll. Several instances are one population, not several, so they do not add much independent evidence." />
          <ListField ctl={ctl} path="research.customSubreddits" label="Custom subreddits" placeholder="r/somewhere" help="Only used when Reddit credentials are configured." />
          <ListField ctl={ctl} path="research.customRssFeeds" label="Custom RSS feeds" placeholder="https://example.com/feed.xml" help="Full feed URLs. Anything that is not a valid URL will be rejected on save." />
          <ListField ctl={ctl} path="research.customKeywords" label="Custom keywords" placeholder="keyword" help="Terms the platform should always watch for, regardless of what the sources surface on their own." />
        </div>
      </Card>
    </div>
  );
}

function AiTab({ ctl }: { ctl: Controller }) {
  return (
    <div className="space-y-4">
      <Note tone="neutral">
        Model identifiers are free text so a new model can be adopted without a release. A name the provider does not
        recognise will fail at call time and show up as a provider error on the System health page.
      </Note>

      <Group title="Models" description="Which model handles each stage. Cost rises sharply from triage to decision, so the split matters.">
        <TextField ctl={ctl} path="ai.triageModel" label="Triage model" help="Cheap, high-volume classification of raw trend signals." />
        <TextField ctl={ctl} path="ai.generationModel" label="Generation model" help="Mid-tier model that writes candidate concepts." />
        <TextField ctl={ctl} path="ai.decisionModel" label="Decision model" help="Strongest model, used only for the final launch decision." />
        <TextField ctl={ctl} path="ai.imageModel" label="Image model" help="Set to 'none' to use procedural artwork instead, which costs nothing and never fails." />
      </Group>

      <Card>
        <SectionHeader title="Evaluation panel" description="Several model roles argue a candidate before it is decided. Better decisions, more tokens spent." />
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <ToggleField ctl={ctl} path="ai.panelEnabled" label="Panel enabled" help="Run the multi-agent panel. Disabling it roughly halves evaluation cost and removes the adversarial check." />
          <CheckboxGroupField
            ctl={ctl}
            path="ai.panelRoles"
            label="Panel roles"
            help="Each role is one additional model call per candidate. The skeptic is the one that most often catches a bad idea."
            options={PANEL_ROLES}
          />
        </div>
      </Card>

      <Group title="Cost and concurrency" description="Bounds on what a single evaluation run can cost.">
        <NumberField ctl={ctl} path="ai.cacheTtlMinutes" label="Prompt cache TTL" unit="minutes" min={0} max={10080} step={10} help="How long an identical prompt is served from cache. Zero disables caching and increases spend." />
        <NumberField ctl={ctl} path="ai.maxConcurrentRequests" label="Max concurrent requests" unit="requests" min={1} max={16} step={1} help="Parallel model calls. Higher is faster and more likely to hit a provider rate limit." />
        <NumberField ctl={ctl} path="ai.maxOutputTokens" label="Max output tokens" unit="tokens" min={256} max={64000} step={256} help="Hard cap per request. Bounds the cost of a runaway generation." />
      </Group>
    </div>
  );
}

function ExplorationTab({ ctl }: { ctl: Controller }) {
  return (
    <div className="space-y-4">
      <Note tone="info">
        Exploration deliberately launches some candidates the gate would otherwise reject. Without it the platform only
        ever learns about ideas it already believed in, and the model's estimates stop improving. The looser gates below
        apply only to that reserved fraction.
      </Note>
      <Group title="Exploration budget" description="How much of the launch budget is reserved for learning.">
        <ToggleField ctl={ctl} path="exploration.enabled" label="Exploration enabled" help="Turn off only if you want purely exploitative behaviour and accept that the model stops improving." />
        <NumberField ctl={ctl} path="exploration.minExplorationRate" label="Minimum exploration rate" unit="0–1" min={0} max={1} step={0.01} help="Floor on the fraction of launches reserved for exploration." />
        <NumberField ctl={ctl} path="exploration.maxExplorationRate" label="Maximum exploration rate" unit="0–1" min={0} max={1} step={0.01} help="Ceiling on that fraction. The platform moves between the floor and this as its confidence changes." />
      </Group>
      <Group title="Exploration gates" description="The looser thresholds an exploration candidate must still clear.">
        <NumberField ctl={ctl} path="exploration.explorationMinOpportunityScore" label="Min. opportunity score" unit="/ 100" min={0} max={100} step={1} help="Lower than the main gate, but not absent — exploration is not a licence to launch anything." />
        <NumberField ctl={ctl} path="exploration.explorationMaxSaturation" label="Max. saturation" unit="0–1" min={0} max={1} step={0.01} help="Higher than the main gate, allowing the platform to test crowded trends occasionally." />
      </Group>
    </div>
  );
}

function NotificationsTab({ ctl }: { ctl: Controller }) {
  return (
    <div className="space-y-4">
      <Note tone="neutral">
        Channel credentials live in the encrypted secret store. Enabling a channel here without its credential means
        notifications are queued and dropped, and the channel will show as unconfigured on the System health page.
      </Note>

      <Card>
        <SectionHeader title="Events" description="What is worth interrupting you for." />
        <div className="mt-4">
          <CheckboxGroupField
            ctl={ctl}
            path="notifications.enabledEvents"
            label="Enabled events"
            help="Selecting everything reliably trains you to ignore all of it. Emergency stop and launch failure are the two most people keep."
            options={NOTIFICATION_EVENTS}
          />
        </div>
      </Card>

      <Group title="Channels" description="Where notifications are delivered.">
        <ToggleField ctl={ctl} path="notifications.discordEnabled" label="Discord" help="Needs the Discord webhook credential." />
        <ToggleField ctl={ctl} path="notifications.telegramEnabled" label="Telegram" help="Needs the Telegram bot token and chat ID." />
        <ToggleField ctl={ctl} path="notifications.webhookEnabled" label="Generic webhook" help="Needs the generic webhook URL. Posts a JSON body." />
        <ToggleField ctl={ctl} path="notifications.emailEnabled" label="Email" help="Needs the SMTP URL credential." />
      </Group>

      <Group title="Thresholds" description="What counts as worth reporting, and how repeats are suppressed.">
        <NumberField ctl={ctl} path="notifications.largeFeeAccrualSol" label="Large fee accrual" unit="SOL" min={0} max={100} step={0.01} help="Accrual above this fires the large-fee event." />
        <NumberField ctl={ctl} path="notifications.highVolumeSol" label="High organic volume" unit="SOL / 24h" min={0} max={10000} step={1} help="24-hour volume above this fires the high-volume event." />
        <NumberField ctl={ctl} path="notifications.dedupeWindowMinutes" label="Deduplication window" unit="minutes" min={0} max={1440} step={5} help="Repeat notifications for the same key are suppressed within this window. Zero sends every one." />
      </Group>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

function SecretsTab({ canManage }: { canManage: boolean }) {
  const [selectedKey, setSelectedKey] = useState<string>(KNOWN_SECRETS[0]?.key ?? '');
  const [customKey, setCustomKey] = useState('');
  const [value, setValue] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const query = useApiQuery<{ unlocked?: boolean; secrets?: SecretMeta[] }>(queryKeys.secrets, '/api/system/secrets', {
    enabled: canManage,
  });

  const invalidate = [queryKeys.secrets, queryKeys.systemStatus, queryKeys.providers, queryKeys.diagnostics];

  const setSecret = useApiMutation<{ ok?: boolean }, { key: string; value: string; category: string }>(
    (v) => `/api/system/secrets/${encodeURIComponent(v.key)}`,
    {
      method: 'PUT',
      invalidate,
      onSuccess: (_result, variables) => {
        setValue('');
        setNotice(`Stored ${variables.key}. Providers were reloaded, so it takes effect immediately.`);
      },
    },
  );

  const deleteSecret = useApiMutation<{ ok?: boolean }, { key: string }>(
    (v) => `/api/system/secrets/${encodeURIComponent(v.key)}`,
    {
      method: 'DELETE',
      invalidate,
      onSuccess: (_result, variables) => {
        setPendingDelete(null);
        setNotice(`Deleted ${variables.key}. Anything depending on it now reports as unconfigured.`);
      },
    },
  );

  if (!canManage) {
    return (
      <Card>
        <EmptyState
          title="You do not have access to credentials"
          description="Reading or changing stored credentials needs the “edit wallet config” permission. An owner can grant it to your account."
          icon="🔑"
        />
      </Card>
    );
  }

  if (query.isLoading) {
    return (
      <Card>
        <LoadingRows rows={6} />
      </Card>
    );
  }
  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  const unlocked = query.data?.unlocked === true;
  const stored = query.data?.secrets ?? [];
  const storedByKey = new Map(stored.map((secret) => [str(secret.key), secret]));

  const catalogue = [
    ...KNOWN_SECRETS,
    ...stored
      .filter((secret) => !KNOWN_SECRETS.some((known) => known.key === str(secret.key)))
      .map((secret) => ({
        key: str(secret.key),
        label: str(secret.key),
        category: str(secret.category) || 'api_key',
        unlocks: 'Custom credential set outside the known catalogue.',
      })),
  ];

  const effectiveKey = selectedKey === '__custom__' ? customKey.trim() : selectedKey;
  const effectiveCategory = catalogue.find((entry) => entry.key === effectiveKey)?.category ?? 'api_key';
  const canSubmit = unlocked && effectiveKey.length >= 3 && value.length > 0 && !setSecret.isPending;

  return (
    <div className="space-y-4">
      {!unlocked && (
        <Note tone="negative">
          <span aria-hidden="true">■ </span>
          <strong className="font-semibold">The secret store is locked.</strong> SOLCOIN_MASTER_KEY is unset or shorter
          than 16 characters, so nothing can be encrypted or decrypted: no credential can be stored, and any credential
          already stored cannot be read. Set that environment variable on the server to a long random string and restart
          it. Keep a copy — losing it makes every stored credential unrecoverable.
        </Note>
      )}

      {notice && <Note tone="positive">{notice}</Note>}
      {(setSecret.error ?? deleteSecret.error) && (
        <Note tone="negative">{(setSecret.error ?? deleteSecret.error)?.message}</Note>
      )}

      <Card>
        <SectionHeader
          title="Set a credential"
          description="Values are encrypted at rest and never sent back to the browser. Only a short hint is ever displayed."
        />
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="md:col-span-1">
            <label className="label" htmlFor="secret-key">
              Credential
            </label>
            <select
              id="secret-key"
              className="input"
              value={selectedKey}
              disabled={!unlocked}
              onChange={(e) => setSelectedKey(e.target.value)}
            >
              {catalogue.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.label}
                </option>
              ))}
              <option value="__custom__">Other…</option>
            </select>
            {selectedKey === '__custom__' && (
              <input
                className="input mt-2 font-mono text-xs"
                placeholder="namespace.provider.key_name"
                value={customKey}
                disabled={!unlocked}
                onChange={(e) => setCustomKey(e.target.value)}
                aria-label="Custom credential key"
              />
            )}
            <p className="mt-1.5 text-xs leading-relaxed text-ink-subtle">
              {catalogue.find((entry) => entry.key === effectiveKey)?.unlocks ?? 'A credential the platform will store as-is.'}
            </p>
          </div>

          <div className="md:col-span-2">
            <label className="label" htmlFor="secret-value">
              Value
            </label>
            <input
              id="secret-value"
              className="input font-mono text-xs"
              type="password"
              autoComplete="new-password"
              value={value}
              disabled={!unlocked}
              placeholder={unlocked ? 'Paste the credential' : 'Unavailable while the store is locked'}
              onChange={(e) => setValue(e.target.value)}
            />
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button
                className="btn btn-primary"
                disabled={!canSubmit}
                onClick={() => setSecret.mutate({ key: effectiveKey, value, category: effectiveCategory })}
              >
                {setSecret.isPending ? 'Storing…' : storedByKey.has(effectiveKey) ? 'Replace credential' : 'Store credential'}
              </button>
              <span className="font-mono text-[11px] text-ink-subtle">{effectiveKey || '—'}</span>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-subtle">
              Storing a value is recorded in the audit log — the key and who set it, never the value itself.
            </p>
          </div>
        </div>
      </Card>

      <Card padded={false}>
        <div className="p-4 sm:p-5">
          <SectionHeader
            title="Stored credentials"
            description="What the platform currently holds. A credential nobody has used in months is one worth revoking at the provider."
          />
        </div>
        {stored.length === 0 ? (
          <EmptyState
            title="No credentials are stored"
            description="This is a normal state. The platform's core trend sources need no keys at all, so it works out of the box; add a credential above only when you want a provider that requires one."
            icon="🔑"
          />
        ) : (
          <div className="px-4 pb-4 sm:px-5">
            <DataTable>
            <thead>
              <tr>
                <Th>Credential</Th>
                <Th>Category</Th>
                <Th>Hint</Th>
                <Th>Updated</Th>
                <Th>Last used</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {stored.map((secret) => {
                const key = str(secret.key);
                const known = KNOWN_SECRETS.find((entry) => entry.key === key);
                const lastUsed = maybeNum(secret.lastUsedAt);
                return (
                  <tr key={key} className="transition-colors hover:bg-surface-hover/40">
                    <Td>
                      <div className="font-medium text-ink">{known?.label ?? key}</div>
                      <div className="font-mono text-[11px] text-ink-subtle">{key}</div>
                    </Td>
                    <Td>{humanise(str(secret.category))}</Td>
                    <Td className="font-mono text-xs">{str(secret.hint) || '—'}</Td>
                    <Td className="whitespace-nowrap">
                      <span title={formatDateTime(maybeNum(secret.updatedAt))}>
                        {formatRelative(maybeNum(secret.updatedAt))}
                      </span>
                    </Td>
                    <Td className={lastUsed === null ? 'whitespace-nowrap text-warning' : 'whitespace-nowrap'}>
                      {lastUsed === null ? 'Never used' : formatRelative(lastUsed)}
                    </Td>
                    <Td align="right">
                      <button
                        className="btn btn-danger px-2 py-1 text-xs"
                        onClick={() => setPendingDelete(key)}
                        disabled={deleteSecret.isPending}
                      >
                        Delete
                      </button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
            </DataTable>
          </div>
        )}
      </Card>

      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Delete credential"
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setPendingDelete(null)}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              disabled={deleteSecret.isPending}
              onClick={() => {
                if (pendingDelete) deleteSecret.mutate({ key: pendingDelete });
              }}
            >
              {deleteSecret.isPending ? 'Deleting…' : 'Delete credential'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm leading-relaxed text-ink-muted">
            <span className="font-mono text-xs">{pendingDelete}</span> will be removed from the encrypted store. Every
            provider that depends on it will immediately report as unconfigured — which is a normal state, not a fault.
          </p>
          <Note tone="warning">
            <span aria-hidden="true">▲ </span>Deleting here does not revoke the credential at the provider. Revoke it
            there too if it may have leaked.
          </Note>
        </div>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Danger zone
// ---------------------------------------------------------------------------

function DangerZoneTab({
  emergencyStop,
  emergencyStopReason,
  canStop,
}: {
  emergencyStop: boolean;
  emergencyStopReason: string;
  canStop: boolean;
}) {
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const invalidate = [queryKeys.settings, queryKeys.systemStatus, queryKeys.jobs];

  const engage = useApiMutation<{ ok?: boolean; message?: string }, { reason: string }>('/api/system/emergency-stop', {
    method: 'POST',
    invalidate,
    onSuccess: (response) => {
      setConfirming(false);
      setReason('');
      setResult(response.message ?? 'Emergency stop engaged.');
    },
  });

  const release = useApiMutation<{ ok?: boolean; message?: string }, { reason: string }>(
    '/api/system/emergency-release',
    {
      method: 'POST',
      invalidate,
      onSuccess: (response) => {
        setConfirming(false);
        setReason('');
        setResult(response.message ?? 'Emergency stop released.');
      },
    },
  );

  const pending = engage.isPending || release.isPending;
  const error = engage.error ?? release.error;
  const reasonOk = reason.trim().length >= 3;

  return (
    <div className="space-y-4">
      <Card className="border-negative-dim">
        <SectionHeader
          title="Emergency stop"
          description="A single switch that suspends every job with side effects: no launch, no fee collection, no wallet transfer. Research and monitoring keep running so you can see what is happening while it is engaged."
          action={
            <Badge tone={emergencyStop ? 'negative' : 'positive'}>
              <span aria-hidden="true">{emergencyStop ? '■' : '●'}</span>
              {emergencyStop ? 'Engaged' : 'Not engaged'}
            </Badge>
          }
        />

        <div className="mt-4 space-y-3">
          {emergencyStop && (
            <Note tone="negative">
              <span aria-hidden="true">■ </span>The stop is currently engaged.{' '}
              {emergencyStopReason ? `Reason on record: “${emergencyStopReason}”.` : 'No reason was recorded.'}
            </Note>
          )}

          {result && <Note tone="positive">{result}</Note>}
          {error && <Note tone="negative">{error.message}</Note>}

          {!canStop ? (
            <Note tone="neutral">
              Engaging or releasing the emergency stop needs the “emergency stop” permission. You can see its state but
              not change it.
            </Note>
          ) : (
            <>
              <div>
                <label className="label" htmlFor="emergency-reason">
                  Reason (required, 3–500 characters)
                </label>
                <textarea
                  id="emergency-reason"
                  className="input min-h-20"
                  value={reason}
                  maxLength={500}
                  placeholder={
                    emergencyStop
                      ? 'e.g. RPC provider recovered and the failed launches were explained'
                      : 'e.g. Unexpected spend rate on the fee collection job'
                  }
                  onChange={(e) => setReason(e.target.value)}
                />
                <p className="mt-1.5 text-xs leading-relaxed text-ink-subtle">
                  This is written to the audit log against your account. Write what you would want to read in six months.
                </p>
              </div>

              <button
                className={emergencyStop ? 'btn btn-primary' : 'btn btn-danger'}
                disabled={!reasonOk || pending}
                onClick={() => setConfirming(true)}
              >
                {emergencyStop ? 'Release emergency stop' : 'Engage emergency stop'}
              </button>
              {!reasonOk && <p className="text-xs text-ink-subtle">Enter a reason of at least 3 characters first.</p>}
            </>
          )}
        </div>
      </Card>

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={emergencyStop ? 'Release emergency stop' : 'Engage emergency stop'}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              className={emergencyStop ? 'btn btn-primary' : 'btn btn-danger'}
              disabled={pending || !reasonOk}
              onClick={() => (emergencyStop ? release : engage).mutate({ reason: reason.trim() })}
            >
              {pending ? 'Working…' : emergencyStop ? 'Release now' : 'Stop everything now'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          {emergencyStop ? (
            <Note tone="warning">
              <span aria-hidden="true">▲ </span>Releasing lets jobs with side effects run again on their normal
              schedules — including anything that was queued while the stop was engaged. Check the approval queue first.
            </Note>
          ) : (
            <Note tone="negative">
              <span aria-hidden="true">■ </span>Every job that can spend SOL or write on-chain stops immediately. Work
              already in flight is not rolled back; a transaction already submitted will still confirm.
            </Note>
          )}
          <div>
            <div className="label">Reason to be recorded</div>
            <p className="rounded-lg border border-border bg-ground px-3 py-2 text-sm leading-relaxed text-ink">
              {reason.trim() || '—'}
            </p>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default SettingsPage;
