import { useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
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
  Modal,
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
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelative,
  formatScore,
  formatSol,
  formatUsd,
  humanise,
  solscanUrl,
  truncateAddress,
} from '@/lib/format';
import { POLL, queryKeys, useApiMutation, useApiQuery } from '@/lib/queries';
import { useSession } from '@/lib/session';

interface Candidate {
  id: string;
  name: string | null;
  symbol: string | null;
  description: string | null;
  narrative: string | null;
  archetype: string | null;
  category: string | null;
  status: string;
  imageUri: string | null;
  metadataUri: string | null;
  trendId: string | null;
  trendTitle: string | null;
  trendScore: number | null;
  originalityScore: number;
  saturationScore: number;
  aiPanelScore: number;
  aiPanelDisagreement: number;
  hardCollision: boolean;
  requiresHumanReview: boolean;
  isExploration: boolean;
  explorationArm: string | null;
  reasoningSummary: string | null;
  rejectionReason: string | null;
  rejectionDetail: string | null;
  confidence: number | null;
  createdAt: number;
  expiresAt: number | null;
}

interface Trend {
  id: string;
  title: string;
  phase?: string;
  category?: string;
  opportunityScore?: number;
  saturationScore?: number;
  sourceCount?: number;
  ageHours?: number;
  remainingLifespanHours?: number;
}

interface Evaluation {
  role?: string;
  model?: string;
  provider?: string;
  score?: number;
  verdict?: string | null;
  summary?: string | null;
  concerns?: unknown;
  strengths?: unknown;
  riskFlags?: unknown;
  risk_flags?: unknown;
  created_at?: number;
}

interface GateCheck {
  name: string;
  passed: boolean;
  value: number | string;
  threshold: number | string;
  comparison: string;
  detail?: string;
}

interface SaturationMatch {
  name?: string;
  symbol?: string;
  mint?: string;
  similarity?: number;
  kind?: string;
  ageHours?: number;
  marketCapUsd?: number;
  volume24hUsd?: number;
  graduated?: boolean;
  weight?: number;
}

interface Saturation {
  score?: number;
  competitorCount?: number;
  recentCompetitorCount?: number;
  competitorQuality?: number;
  bestCompetitorMarketCapUsd?: number;
  hardCollision?: boolean;
  matches?: SaturationMatch[];
  rationale?: string[];
}

interface Originality {
  score?: number;
  maxPriorSimilarity?: number;
  nearestPrior?: { id?: string; name?: string; symbol?: string; similarity?: number };
  clichePenalty?: number;
  cliches?: string[];
  isDuplicate?: boolean;
  rationale?: string[];
}

interface Driver {
  feature: string;
  value: number;
  weight: number;
  contribution: number;
}

interface DetailResponse {
  candidate?: Candidate;
  trend?: Trend | null;
  prediction?: Record<string, unknown> | null;
  explanation?: string[];
  evaluations?: Evaluation[];
  saturation?: Saturation;
  originality?: Originality;
  gateChecks?: unknown[];
  riskFlags?: unknown;
}

interface RiskFlag {
  flag: string;
  severity: string;
  label: string;
  matched?: string;
}

interface SystemStatus {
  network?: string;
  autonomy?: Record<string, string>;
  emergencyStop?: boolean;
}

const SEVERITY_TONE: Record<string, Tone> = { block: 'negative', review: 'warning', note: 'info' };
const SEVERITY_RANK: Record<string, number> = { block: 0, review: 1, note: 2 };

const VERDICT_TONE: Record<string, Tone> = {
  approve: 'positive',
  pass: 'positive',
  strong: 'positive',
  revise: 'warning',
  caution: 'warning',
  weak: 'warning',
  reject: 'negative',
  fail: 'negative',
};

/**
 * Each panellist is given a deliberately partial brief, so their scores are not
 * comparable to one another. Without this, a 0.35 from the skeptic reads as a
 * red flag when it is the expected output of the role.
 */
const ROLE_HELP: Record<string, string> = {
  skeptic:
    'Instructed to find the ways this fails, not to be balanced. Its default position is that the token gets no attention at all, so a low score here is the normal case and is not by itself a reason to reject.',
  market_analyst:
    'Judges demand only: how large and reachable the audience is, whether the timing is right, and whether the people following this trend trade tokens at all.',
  risk: 'Judges legal, ethical and reputational exposure only, and is instructed to be strict. A "reject" verdict here means do not launch under any circumstances, whatever the other scores say.',
  creative_critic:
    'Judges one thing: would somebody who already knows this trend screenshot it and send it to a friend. Nothing about construction or correctness.',
  decision: 'The aggregate verdict formed from the other roles, weighted by how much each is trusted for this decision.',
};

const MILESTONE_LABELS: Array<{ key: string; label: string }> = [
  { key: 'p_first_buy', label: 'Any organic buyer' },
  { key: 'p_ten_holders', label: 'Ten holders' },
  { key: 'p_hundred_holders', label: 'A hundred holders' },
  { key: 'p_graduation', label: 'Graduates to AMM' },
];

/** Below this the model has seen too few realised outcomes to be a measurement. */
const LOW_CONFIDENCE = 0.5;
const DISAGREEMENT_THRESHOLD = 0.45;
const APPROVABLE: ReadonlySet<string> = new Set(['awaiting_approval', 'draft', 'evaluating']);
const REJECTABLE: ReadonlySet<string> = new Set(['awaiting_approval', 'draft', 'evaluating', 'approved']);
const LAUNCHABLE: ReadonlySet<string> = new Set(['approved', 'awaiting_approval', 'queued', 'failed']);

const AXIS_STYLE = { fill: 'var(--color-ink-subtle)', fontSize: 11 } as const;

function num(source: Record<string, unknown> | null | undefined, key: string): number | null {
  if (!source) return null;
  const raw = source[key];
  if (raw === null || raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function str(source: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!source) return null;
  const raw = source[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function parseRiskFlags(raw: unknown): RiskFlag[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): RiskFlag | null => {
      if (typeof entry === 'string') return { flag: entry, severity: 'note', label: humanise(entry) };
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const flag = String(record.flag ?? record.name ?? '');
      if (!flag) return null;
      return {
        flag,
        severity: String(record.severity ?? 'note'),
        label: String(record.label ?? humanise(flag)),
        matched: typeof record.matched === 'string' ? record.matched : undefined,
      };
    })
    .filter((f): f is RiskFlag => f !== null)
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3));
}

function parseGateChecks(raw: unknown): GateCheck[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): GateCheck | null => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const name = String(record.name ?? '');
      if (!name) return null;
      const asCell = (value: unknown): number | string =>
        typeof value === 'number' && Number.isFinite(value) ? value : String(value ?? '—');
      return {
        name,
        passed: Boolean(record.passed),
        value: asCell(record.value),
        threshold: asCell(record.threshold),
        comparison: String(record.comparison ?? ''),
        detail: typeof record.detail === 'string' ? record.detail : undefined,
      };
    })
    .filter((c): c is GateCheck => c !== null);
}

function parseStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function parseDrivers(raw: unknown): Driver[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): Driver | null => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const feature = String(record.feature ?? '');
      const contribution = Number(record.contribution);
      if (!feature || !Number.isFinite(contribution)) return null;
      return {
        feature,
        value: Number(record.value ?? 0),
        weight: Number(record.weight ?? 0),
        contribution,
      };
    })
    .filter((d): d is Driver => d !== null);
}

function formatCell(value: number | string): string {
  if (typeof value !== 'number') return value;
  return Number.isInteger(value) ? formatNumber(value) : formatScore(value, 3);
}

function isRenderableImage(uri: string | null | undefined): boolean {
  if (!uri) return false;
  return /^(https?:|data:image\/)/i.test(uri);
}

function Hint({ text, children }: { text: string; children: ReactNode }) {
  return (
    <span className="inline-flex cursor-help" title={text}>
      {children}
    </span>
  );
}

function Artwork({ candidate }: { candidate: Candidate }) {
  const [failed, setFailed] = useState(false);
  const initial = (candidate.symbol ?? candidate.name ?? '?').trim().charAt(0).toUpperCase() || '?';

  if (isRenderableImage(candidate.imageUri) && candidate.imageUri && !failed) {
    return (
      <img
        src={candidate.imageUri}
        alt={`Artwork for ${candidate.name ?? 'this candidate'}`}
        onError={() => setFailed(true)}
        className="h-24 w-24 shrink-0 rounded-2xl border border-border object-cover"
      />
    );
  }
  return (
    <div className="shrink-0 text-center">
      <div
        className="flex h-24 w-24 items-center justify-center rounded-2xl border border-dashed border-border-strong bg-surface-raised text-3xl font-semibold text-ink-subtle"
        aria-hidden="true"
      >
        {initial}
      </div>
      <div className="mt-1 text-[0.625rem] leading-tight text-ink-subtle">artwork pending</div>
    </div>
  );
}

function ProbabilityTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: Record<string, unknown> }>;
}) {
  const row = payload?.[0]?.payload as { label?: string; probability?: number } | undefined;
  if (!active || !row) return null;
  return (
    <div className="card-raised px-3 py-2 text-xs shadow-lg">
      <div className="font-medium text-ink">{row.label}</div>
      <div className="tnum mt-1 text-ink-muted">
        Modelled probability {formatPercent(row.probability ?? null, 1)}
      </div>
    </div>
  );
}

function DriverTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: Record<string, unknown> }> }) {
  const row = payload?.[0]?.payload as (Driver & { label?: string }) | undefined;
  if (!active || !row) return null;
  return (
    <div className="card-raised max-w-xs px-3 py-2 text-xs shadow-lg">
      <div className="font-medium text-ink">{row.label ?? humanise(row.feature)}</div>
      <div className="tnum mt-1 text-ink-muted">
        value {formatScore(row.value, 3)} × weight {formatScore(row.weight, 3)} ={' '}
        <span className={row.contribution >= 0 ? 'text-accent-soft' : 'text-negative'}>
          {row.contribution >= 0 ? '+' : ''}
          {formatScore(row.contribution, 3)}
        </span>
      </div>
    </div>
  );
}

/** The p10 → median → p90 band, drawn to scale so the skew is visible. */
function FeeRange({ p10, median, p90, mean }: { p10: number | null; median: number | null; p90: number | null; mean: number | null }) {
  if (p10 === null || median === null || p90 === null || p90 <= p10) {
    return (
      <Note tone="warning">
        The model did not record a full percentile range for creator fees, so only the point estimate above is
        available. A single number hides how skewed this distribution is — treat it with caution.
      </Note>
    );
  }
  const span = p90 - p10;
  const pct = (value: number): number => Math.max(0, Math.min(100, ((value - p10) / span) * 100));

  return (
    <div>
      <div className="relative mt-6 h-2 rounded-full bg-surface-raised">
        <div className="absolute inset-y-0 left-0 right-0 rounded-full bg-accent-dim/70" />
        <div
          className="absolute -top-1 h-4 w-1 rounded-full bg-accent-soft"
          style={{ left: `calc(${pct(median)}% - 2px)` }}
          aria-hidden="true"
        />
        {mean !== null && (
          <div
            className="absolute -top-1 h-4 w-1 rounded-full bg-warning"
            style={{ left: `calc(${pct(mean)}% - 2px)` }}
            aria-hidden="true"
          />
        )}
      </div>
      <div className="tnum mt-2 flex justify-between gap-2 text-xs text-ink-muted">
        <span>
          <span className="block text-[0.625rem] uppercase tracking-wide text-ink-subtle">p10 (unlucky)</span>
          {formatSol(p10)}
        </span>
        <span className="text-center">
          <span className="block text-[0.625rem] uppercase tracking-wide text-accent-soft">median</span>
          {formatSol(median)}
        </span>
        <span className="text-right">
          <span className="block text-[0.625rem] uppercase tracking-wide text-ink-subtle">p90 (lucky)</span>
          {formatSol(p90)}
        </span>
      </div>
      {mean !== null && (
        <p className="mt-2 text-xs leading-relaxed text-ink-subtle">
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-warning align-middle" aria-hidden="true" />
          The mean is {formatSol(mean)}
          {mean > median
            ? ' — above the median, because a small number of very large outcomes pull the average up. Most launches land nearer the median than the mean.'
            : '.'}
        </p>
      )}
    </div>
  );
}

function GateRow({ check }: { check: GateCheck }) {
  return (
    <tr>
      <Td className="font-medium text-ink">
        {humanise(check.name)}
        {check.detail && <div className="mt-0.5 text-xs font-normal text-ink-subtle">{check.detail}</div>}
      </Td>
      <Td align="right" className="tnum text-ink">
        {formatCell(check.value)}
      </Td>
      <Td align="center" className="tnum text-ink-subtle">
        {check.comparison || '—'}
      </Td>
      <Td align="right" className="tnum">
        {formatCell(check.threshold)}
      </Td>
      <Td align="right">
        <span className={check.passed ? 'text-positive' : 'text-negative'}>
          <span aria-hidden="true">{check.passed ? '✓' : '✕'}</span> {check.passed ? 'Pass' : 'Fail'}
        </span>
      </Td>
    </tr>
  );
}

function EvaluationCard({ evaluation }: { evaluation: Evaluation }) {
  const role = evaluation.role ?? 'unknown';
  const score = typeof evaluation.score === 'number' ? evaluation.score : null;
  const verdict = evaluation.verdict ?? null;
  const strengths = parseStrings(evaluation.strengths);
  const concerns = parseStrings(evaluation.concerns);
  const flags = parseRiskFlags(evaluation.riskFlags ?? evaluation.risk_flags);

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink">{humanise(role)}</div>
          <div className="text-xs text-ink-subtle">{evaluation.model ?? 'model not recorded'}</div>
        </div>
        <div className="text-right">
          <div className="tnum text-lg font-semibold text-ink">{formatPercent(score, 0)}</div>
          {verdict && <Badge tone={VERDICT_TONE[verdict.toLowerCase()] ?? 'neutral'}>{humanise(verdict)}</Badge>}
        </div>
      </div>

      {score !== null && (
        <ScoreBar
          className="mt-3"
          value={score}
          tone={score > 0.7 ? 'positive' : score > 0.45 ? 'accent' : 'warning'}
        />
      )}

      {ROLE_HELP[role] && <p className="mt-3 text-xs leading-relaxed text-ink-subtle">{ROLE_HELP[role]}</p>}

      {evaluation.summary && <p className="mt-3 text-sm leading-relaxed text-ink-muted">{evaluation.summary}</p>}

      {strengths.length > 0 && (
        <div className="mt-3">
          <div className="text-[0.625rem] font-semibold uppercase tracking-wide text-positive">Strengths</div>
          <ul className="mt-1 space-y-1">
            {strengths.map((s) => (
              <li key={s} className="flex gap-2 text-xs leading-relaxed text-ink-muted">
                <span aria-hidden="true" className="text-positive">
                  +
                </span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {concerns.length > 0 && (
        <div className="mt-3">
          <div className="text-[0.625rem] font-semibold uppercase tracking-wide text-warning">Concerns</div>
          <ul className="mt-1 space-y-1">
            {concerns.map((c) => (
              <li key={c} className="flex gap-2 text-xs leading-relaxed text-ink-muted">
                <span aria-hidden="true" className="text-warning">
                  −
                </span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {flags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {flags.map((flag) => (
            <Badge key={flag.flag} tone={SEVERITY_TONE[flag.severity] ?? 'neutral'}>
              {flag.label}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

export function CandidateDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { can } = useSession();

  const [rejectOpen, setRejectOpen] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [reason, setReason] = useState('');

  const query = useApiQuery<DetailResponse>(queryKeys.candidate(id), `/api/candidates/${encodeURIComponent(id)}`, {
    enabled: id.length > 0,
    refetchInterval: POLL.normal,
  });
  // Network and autonomy are not on the candidate response, and a launch
  // confirmation that cannot name the network it will spend on is useless.
  const system = useApiQuery<SystemStatus>(queryKeys.systemStatus, '/api/system/status', {
    refetchInterval: POLL.fast,
  });

  const invalidate = [['candidates'] as const, queryKeys.candidate(id)];

  const approve = useApiMutation<{ ok?: boolean; message?: string }>(
    `/api/candidates/${encodeURIComponent(id)}/approve`,
    { invalidate },
  );
  const reject = useApiMutation<{ ok?: boolean }, { reason: string }>(
    `/api/candidates/${encodeURIComponent(id)}/reject`,
    {
      invalidate,
      onSuccess: () => {
        setRejectOpen(false);
        setReason('');
      },
    },
  );
  const launch = useApiMutation<
    { ok?: boolean; mint?: string; signature?: string; network?: string; simulated?: boolean; costSol?: number }
  >(`/api/candidates/${encodeURIComponent(id)}/launch`, {
    invalidate,
    onSuccess: () => setLaunchOpen(false),
  });
  const regenerate = useApiMutation<{ ok?: boolean; generated?: number }>(
    `/api/candidates/${encodeURIComponent(id)}/regenerate`,
    { invalidate, onSuccess: () => setRegenerateOpen(false) },
  );

  const candidate = query.data?.candidate;
  const prediction = query.data?.prediction ?? null;
  const explanation = parseStrings(query.data?.explanation);
  const evaluations = useMemo(
    () => (query.data?.evaluations ?? []).filter((e) => (e.role ?? '') !== 'decision'),
    [query.data],
  );
  const gateChecks = useMemo(() => parseGateChecks(query.data?.gateChecks), [query.data]);
  const riskFlags = useMemo(() => parseRiskFlags(query.data?.riskFlags), [query.data]);
  const saturation = query.data?.saturation ?? {};
  const originality = query.data?.originality ?? {};
  const trend = query.data?.trend ?? null;
  const network = system.data?.network;

  const features = useMemo(() => {
    const raw = prediction?.features;
    if (!raw || typeof raw !== 'object') return [] as Array<{ key: string; value: number }>;
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, value]) => Number.isFinite(Number(value)))
      .map(([key, value]) => ({ key, value: Number(value) }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [prediction]);

  const drivers = useMemo(() => parseDrivers(prediction?.drivers), [prediction]);
  const driverChart = useMemo(
    () =>
      [...drivers]
        .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
        .slice(0, 10)
        .sort((a, b) => b.contribution - a.contribution)
        .map((d) => ({ ...d, label: humanise(d.feature) })),
    [drivers],
  );

  const milestones = useMemo(
    () =>
      MILESTONE_LABELS.map(({ key, label }) => ({ key, label, probability: num(prediction, key) })).filter(
        (m): m is { key: string; label: string; probability: number } => m.probability !== null,
      ),
    [prediction],
  );

  const scores = evaluations
    .map((e) => (typeof e.score === 'number' ? e.score : null))
    .filter((s): s is number => s !== null);
  const spread = scores.length > 1 ? Math.max(...scores) - Math.min(...scores) : null;

  const economics = (prediction?.economics ?? null) as Record<string, unknown> | null;
  const launchCostSol = num(economics, 'launchCostSol');
  const solPriceUsd = num(economics, 'solPriceUsd');
  const confidence = num(prediction, 'confidence') ?? candidate?.confidence ?? null;
  const modelVersion = str(prediction, 'model_version');
  const tailConcentration = num(prediction, 'tail_concentration');

  if (query.isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
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

  if (!candidate) {
    return (
      <Card>
        <EmptyState
          icon="◇"
          title="Candidate not found"
          description="This candidate may have expired and been pruned, or the link is stale. The candidates list shows everything the platform currently holds."
          action={
            <Link className="btn btn-ghost" to="/candidates">
              Back to candidates
            </Link>
          }
        />
      </Card>
    );
  }

  const blocking = riskFlags.filter((f) => f.severity === 'block');
  const hoursToExpiry = candidate.expiresAt ? (candidate.expiresAt - Date.now()) / 3_600_000 : null;
  const canLaunchNow = can('launch_token') && LAUNCHABLE.has(candidate.status);
  const metadataMissing = !candidate.metadataUri;

  return (
    <div className="space-y-5">
      <div>
        <Link to="/candidates" className="text-xs text-ink-subtle transition-colors hover:text-accent-soft">
          ← Candidates
        </Link>
      </div>

      {blocking.length > 0 && (
        <div className="rounded-xl border-2 border-negative bg-negative-dim/30 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-negative">
            <span aria-hidden="true">■</span> Blocking risk flag — do not launch
          </div>
          <ul className="mt-2 space-y-1 text-sm leading-relaxed text-ink-muted">
            {blocking.map((flag) => (
              <li key={flag.flag}>
                <strong className="text-ink">{flag.label}</strong>
                {flag.matched ? ` — matched “${flag.matched}”` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Card>
        <div className="flex flex-col gap-4 sm:flex-row">
          <Artwork candidate={candidate} />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 className="text-xl font-semibold tracking-tight text-ink">{candidate.name ?? 'Unnamed concept'}</h1>
              <span className="tnum text-sm font-semibold text-accent-soft">${candidate.symbol ?? '—'}</span>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge tone={candidate.status === 'launched' ? 'positive' : candidate.status === 'rejected' ? 'negative' : 'accent'}>
                {humanise(candidate.status)}
              </Badge>
              {candidate.archetype && <Badge>{humanise(candidate.archetype)}</Badge>}
              {candidate.category && <Badge>{humanise(candidate.category)}</Badge>}
              {candidate.isExploration && (
                <Hint text="Exploration: the platform deliberately tries a fraction of candidates its model is unsure about, because a confident rejection from an under-trained model is worth very little. These launches are how the model finds out where it is wrong.">
                  <Badge tone="info">
                    ◈ Exploration{candidate.explorationArm ? `: ${humanise(candidate.explorationArm)}` : ''}
                  </Badge>
                </Hint>
              )}
              {candidate.aiPanelDisagreement > DISAGREEMENT_THRESHOLD && (
                <Hint
                  text={`Panel disagreement ${formatPercent(candidate.aiPanelDisagreement, 0)}. The reviewers reached materially different conclusions; read their summaries below rather than the average.`}
                >
                  <Badge tone="warning">⚖ Reviewers disagreed</Badge>
                </Hint>
              )}
              {candidate.hardCollision && <Badge tone="negative">✕ Name collision</Badge>}
              {candidate.requiresHumanReview && <Badge tone="warning">Needs human review</Badge>}
              {hoursToExpiry !== null && (
                <Badge tone={hoursToExpiry <= 0 ? 'negative' : hoursToExpiry < 6 ? 'warning' : 'neutral'}>
                  {hoursToExpiry <= 0 ? 'Expired' : `Expires in ${formatDuration(hoursToExpiry)}`}
                </Badge>
              )}
            </div>

            {candidate.description && (
              <p className="mt-3 text-sm leading-relaxed text-ink-muted">{candidate.description}</p>
            )}
            {candidate.narrative && (
              <p className="mt-2 text-sm leading-relaxed text-ink-subtle">{candidate.narrative}</p>
            )}

            <div className="mt-3 text-xs text-ink-subtle">
              Created {formatRelative(candidate.createdAt)} ({formatDateTime(candidate.createdAt)}).{' '}
              {trend ? (
                <>
                  From trend{' '}
                  <Link
                    to={`/opportunities/${encodeURIComponent(trend.id)}`}
                    className="text-accent-soft transition-colors hover:underline"
                  >
                    {trend.title}
                  </Link>
                  {trend.opportunityScore !== undefined && ` (score ${formatScore(trend.opportunityScore, 1)})`}
                  {trend.phase ? `, ${humanise(trend.phase)} phase` : ''}.
                </>
              ) : (
                'No source trend is recorded for this candidate.'
              )}
            </div>

            {candidate.status === 'rejected' && (
              <Note tone="negative">
                Rejected: {humanise(candidate.rejectionReason)}
                {candidate.rejectionDetail ? ` — ${candidate.rejectionDetail}` : ''}
              </Note>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
          {can('approve_candidate') && APPROVABLE.has(candidate.status) && (
            <button className="btn btn-primary" onClick={() => approve.mutate(undefined)} disabled={approve.isPending}>
              {approve.isPending ? 'Approving…' : 'Approve'}
            </button>
          )}
          {canLaunchNow && (
            <button
              className="btn btn-ghost"
              onClick={() => {
                launch.reset();
                setLaunchOpen(true);
              }}
              disabled={launch.isPending}
            >
              {launch.isPending ? 'Launching…' : 'Launch now'}
            </button>
          )}
          {can('generate_concepts') && candidate.trendId && (
            <button className="btn btn-ghost" onClick={() => setRegenerateOpen(true)} disabled={regenerate.isPending}>
              Regenerate
            </button>
          )}
          {can('reject_candidate') && REJECTABLE.has(candidate.status) && (
            <button
              className="btn btn-danger"
              onClick={() => {
                reject.reset();
                setReason('');
                setRejectOpen(true);
              }}
            >
              Reject
            </button>
          )}
          {!can('approve_candidate') && !can('reject_candidate') && !can('launch_token') && (
            <span className="text-xs text-ink-subtle">
              Your role can review this candidate but not act on it. An owner or admin must approve, reject or launch.
            </span>
          )}
        </div>

        {approve.isError && <Note tone="negative">Could not approve: {approve.error.message}</Note>}
        {approve.isSuccess && <Note tone="positive">{approve.data?.message ?? 'Approved.'}</Note>}
        {launch.isError && <Note tone="negative">Launch failed: {launch.error.message}</Note>}
        {launch.isSuccess && (
          <Note tone="positive">
            Launched{launch.data?.simulated ? ' in simulation' : ''} on {humanise(launch.data?.network ?? network)}.
            Mint {truncateAddress(launch.data?.mint, 6)}
            {launch.data?.mint && network && (
              <>
                {' '}
                <a
                  className="underline"
                  href={solscanUrl('token', launch.data.mint, network)}
                  target="_blank"
                  rel="noreferrer"
                >
                  view on Solscan
                </a>
              </>
            )}
            {launch.data?.costSol !== undefined && ` — cost ${formatSol(launch.data.costSol)}.`}
          </Note>
        )}
        {regenerate.isError && <Note tone="negative">Could not regenerate: {regenerate.error.message}</Note>}
        {regenerate.isSuccess && (
          <Note tone="positive">
            Regenerated {formatNumber(regenerate.data?.generated ?? 0)} fresh concepts for this trend. This candidate
            was rejected as superseded; the new ones are on the candidates list.
          </Note>
        )}
      </Card>

      {/* 2. The prediction */}
      <Card>
        <SectionHeader
          title="Predicted outcome"
          description="What the model expects if this launches, with its uncertainty stated rather than hidden. These are simulated distributions, not observations of this token."
        />

        {!prediction ? (
          <EmptyState
            icon="◐"
            title="No prediction recorded"
            description="This candidate has no stored prediction, which normally means it was rejected before the model ran or the model bundle was unavailable at the time. There is no modelled expected value to show, and none will be invented here."
          />
        ) : (
          <div className="mt-4 space-y-4">
            {confidence !== null && confidence < LOW_CONFIDENCE && (
              <Note tone="warning">
                <span aria-hidden="true">⚠</span> Model confidence is {formatPercent(confidence, 0)}. The model has
                seen too few realised launches for these figures to be measurements — they are informed priors. Use
                them to rank candidates against each other, not to predict what this one will earn.
              </Note>
            )}

            {explanation.length > 0 && (
              <div className="rounded-xl border border-accent-dim bg-accent-dim/15 p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-accent-soft">In plain English</div>
                <ul className="mt-2 space-y-1.5">
                  {explanation.map((line) => (
                    <li key={line} className="flex gap-2 text-sm leading-relaxed text-ink-muted">
                      <span aria-hidden="true" className="text-accent-soft">
                        •
                      </span>
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile
                label="Expected value"
                value={formatSol(num(prediction, 'expected_value_sol'), { sign: true })}
                tone={(num(prediction, 'expected_value_sol') ?? 0) >= 0 ? 'positive' : 'negative'}
                hint="Mean net SOL across simulated outcomes, after launch and operating costs."
              />
              <StatTile
                label="P(profitable)"
                value={formatPercent(num(prediction, 'probability_profitable'), 0)}
                hint="Share of simulated outcomes that end above break-even."
              />
              <StatTile
                label="Median creator fees"
                value={formatSol(num(prediction, 'creator_fees_median_sol'))}
                hint="The middle outcome — a better guide than the mean for a skewed distribution."
              />
              <StatTile
                label="Model confidence"
                value={formatPercent(confidence, 0)}
                tone={confidence !== null && confidence < LOW_CONFIDENCE ? 'warning' : 'neutral'}
                hint={modelVersion ? `Model version ${modelVersion}` : 'Model version not recorded.'}
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <h3 className="text-sm font-semibold text-ink">Milestone probabilities</h3>
                {milestones.length === 0 ? (
                  <Note tone="warning">No milestone probabilities were stored with this prediction.</Note>
                ) : (
                  <>
                    <div className="mt-3 w-full" style={{ height: Math.max(200, milestones.length * 46) }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={milestones}
                          layout="vertical"
                          margin={{ top: 4, right: 24, bottom: 28, left: 8 }}
                          barCategoryGap="26%"
                        >
                          <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" horizontal={false} />
                          <XAxis
                            type="number"
                            domain={[0, 1]}
                            tick={AXIS_STYLE}
                            stroke="var(--color-border-strong)"
                            tickFormatter={(v: number) => formatPercent(v, 0)}
                            label={{
                              value: 'Modelled probability',
                              position: 'insideBottom',
                              offset: -16,
                              fill: 'var(--color-ink-subtle)',
                              fontSize: 11,
                            }}
                          />
                          <YAxis
                            type="category"
                            dataKey="label"
                            tick={AXIS_STYLE}
                            stroke="var(--color-border-strong)"
                            width={116}
                          />
                          <Tooltip content={<ProbabilityTooltip />} cursor={{ fill: 'var(--color-surface-hover)' }} />
                          <Bar dataKey="probability" radius={[0, 4, 4, 0]} isAnimationActive={false}>
                            {milestones.map((m) => (
                              <Cell key={m.key} fill="var(--color-accent)" />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <ul className="mt-2 space-y-1">
                      {milestones.map((m) => (
                        <li key={m.key} className="flex items-baseline justify-between gap-3 text-xs">
                          <span className="text-ink-muted">{m.label}</span>
                          <span className="tnum text-ink">{formatPercent(m.probability, 1)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>

              <div>
                <h3 className="text-sm font-semibold text-ink">Creator fees, as a range</h3>
                <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
                  Token outcomes are heavily skewed: most earn almost nothing and a few earn a great deal. A single
                  expected number would be misleading, so the tenth-to-ninetieth percentile band is shown instead.
                </p>
                <FeeRange
                  p10={num(prediction, 'creator_fees_p10_sol')}
                  median={num(prediction, 'creator_fees_median_sol')}
                  p90={num(prediction, 'creator_fees_p90_sol')}
                  mean={num(prediction, 'expected_creator_fees_sol')}
                />

                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <div>
                    <dt className="text-ink-subtle">Expected 24h volume</dt>
                    <dd className="tnum text-ink">{formatSol(num(prediction, 'expected_volume_24h_sol'))}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-subtle">Expected lifespan</dt>
                    <dd className="tnum text-ink">{formatDuration(num(prediction, 'expected_lifespan_hours'))}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-subtle">Launch cost assumed</dt>
                    <dd className="tnum text-ink">
                      {formatSol(launchCostSol)}
                      {launchCostSol !== null && solPriceUsd !== null && (
                        <span className="ml-1 text-ink-subtle">≈ {formatUsd(launchCostSol * solPriceUsd)}</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-subtle">Tail concentration</dt>
                    <dd className="tnum text-ink">{formatPercent(tailConcentration, 0)}</dd>
                  </div>
                </dl>

                {tailConcentration !== null && tailConcentration > 0.4 && (
                  <Note tone="warning">
                    {formatPercent(tailConcentration, 0)} of the expected value comes from the top 1% of simulated
                    outcomes. This is a low-probability, high-payoff candidate, not a reliable earner — the median
                    outcome is what you should expect to see.
                  </Note>
                )}
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* 3. Quality gate */}
      <Card>
        <SectionHeader
          title="Quality gate"
          description="Every threshold the candidate was measured against, with the value it actually held. This is the complete reason it passed or failed — nothing else gates a launch."
          action={
            gateChecks.length > 0 ? (
              <Badge tone={gateChecks.every((c) => c.passed) ? 'positive' : 'negative'}>
                {gateChecks.filter((c) => c.passed).length} of {gateChecks.length} passed
              </Badge>
            ) : undefined
          }
        />
        {gateChecks.length === 0 ? (
          <EmptyState
            icon="▦"
            title="No gate checks recorded"
            description="This candidate has no stored gate result. That happens when it was rejected earlier in the pipeline — during safety screening or panel review — before the quality gate ran."
          />
        ) : (
          <div className="mt-3">
            <DataTable>
              <thead>
                <tr>
                  <Th>Check</Th>
                  <Th align="right">Measured</Th>
                  <Th align="center">Test</Th>
                  <Th align="right">Threshold</Th>
                  <Th align="right">Result</Th>
                </tr>
              </thead>
              <tbody>
                {gateChecks.map((check) => (
                  <GateRow key={check.name} check={check} />
                ))}
              </tbody>
            </DataTable>
            {candidate.isExploration && (
              <Note tone="info">
                This candidate was assessed on the exploration path, which uses looser (but still real) thresholds. The
                exploration budget shrinks as the model accumulates evidence.
              </Note>
            )}
          </div>
        )}
      </Card>

      {/* 4. Evaluation panel */}
      <Card>
        <SectionHeader
          title="Review panel"
          description="Independent reviewers, each given a deliberately narrow brief. Their scores are not meant to agree, and averaging them hides more than it shows."
          action={
            evaluations.length > 0 ? (
              <div className="text-right">
                <div className="tnum text-sm font-semibold text-ink">{formatPercent(candidate.aiPanelScore, 0)}</div>
                <div className="flex items-center justify-end gap-1.5 text-xs text-ink-subtle">
                  weighted panel score <SampleSize n={evaluations.length} minimum={3} />
                </div>
              </div>
            ) : undefined
          }
        />

        {evaluations.length === 0 ? (
          <EmptyState
            icon="◐"
            title="No reviews recorded"
            description="The review panel has not run for this candidate yet, or every panellist failed to respond. A candidate cannot be approved on an empty panel — regenerate it, or check provider health on the System health page."
          />
        ) : (
          <div className="mt-4 space-y-4">
            <Note>
              The panel is adversarial by design. The <strong>skeptic</strong> is instructed to find failure modes and
              to withhold high scores, so a low skeptic score is the expected result rather than an alarm. The{' '}
              <strong>risk reviewer</strong> is the exception: a reject verdict there is decisive on its own.
            </Note>

            {spread !== null && (
              <div>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Score spread</span>
                  <span className="tnum text-xs text-ink-muted">
                    {formatPercent(Math.min(...scores), 0)} – {formatPercent(Math.max(...scores), 0)} (spread{' '}
                    {formatPercent(spread, 0)})
                    {candidate.aiPanelDisagreement > 0 &&
                      `, recorded disagreement ${formatPercent(candidate.aiPanelDisagreement, 0)}`}
                  </span>
                </div>
                <div className="relative mt-3 mb-1 h-2 rounded-full bg-surface-raised">
                  {evaluations.map((e) =>
                    typeof e.score === 'number' ? (
                      <span
                        key={e.role ?? e.model ?? String(e.score)}
                        className="absolute -top-1.5 h-5 w-1 rounded-full bg-accent-soft"
                        style={{ left: `calc(${Math.max(0, Math.min(1, e.score)) * 100}% - 2px)` }}
                        title={`${humanise(e.role ?? 'reviewer')}: ${formatPercent(e.score, 0)}`}
                      />
                    ) : null,
                  )}
                </div>
                <div className="tnum flex justify-between text-[0.625rem] text-ink-subtle">
                  <span>0%</span>
                  <span>100%</span>
                </div>
                {spread > DISAGREEMENT_THRESHOLD && (
                  <Note tone="warning">
                    The reviewers disagreed materially. That usually means the concept is genuinely borderline — one
                    role sees something the others do not. Read the summaries rather than the average before deciding.
                  </Note>
                )}
              </div>
            )}

            <div className="grid gap-3 lg:grid-cols-2">
              {evaluations.map((evaluation, index) => (
                <EvaluationCard key={evaluation.role ?? `reviewer-${index}`} evaluation={evaluation} />
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* 5. Saturation */}
      <Card>
        <SectionHeader
          title="Saturation"
          description="How crowded this idea already is on-chain. Timing is the edge this platform claims, so a high score here is the single strongest reason not to launch."
        />

        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Saturation score"
            value={formatPercent(saturation.score ?? candidate.saturationScore, 0)}
            tone={
              (saturation.score ?? candidate.saturationScore) > 0.66
                ? 'negative'
                : (saturation.score ?? candidate.saturationScore) > 0.33
                  ? 'warning'
                  : 'positive'
            }
            hint="Higher is worse. Derived from similar tokens weighted by recency and traction."
          />
          <StatTile
            label="Competitors"
            value={formatNumber(saturation.competitorCount ?? 0)}
            hint={`${formatNumber(saturation.recentCompetitorCount ?? 0)} launched in the last 24 hours`}
          />
          <StatTile
            label="Best competitor"
            value={formatUsd(saturation.bestCompetitorMarketCapUsd ?? null, { compact: true })}
            hint="Largest market cap among matching tokens."
          />
          <StatTile
            label="Name collision"
            value={saturation.hardCollision ?? candidate.hardCollision ? 'Yes' : 'No'}
            tone={saturation.hardCollision ?? candidate.hardCollision ? 'negative' : 'positive'}
            hint="Whether an existing token is close enough that traders would confuse the two."
          />
        </div>

        {(saturation.competitorCount ?? 0) === 0 && (saturation.matches ?? []).length === 0 && (
          <Note tone="warning">
            No competing tokens were returned by the market scan. A saturation score of zero here means
            &quot;nothing found&quot;, which is not the same as &quot;nothing exists&quot; — if the market data
            providers are degraded, this check is uninformative. Check System health before relying on it.
          </Note>
        )}

        {(saturation.matches ?? []).length > 0 && (
          <div className="mt-4">
            <DataTable>
              <thead>
                <tr>
                  <Th>Competing token</Th>
                  <Th>Match</Th>
                  <Th align="right">Similarity</Th>
                  <Th align="right">Age</Th>
                  <Th align="right">Market cap</Th>
                  <Th>Status</Th>
                  <Th>Mint</Th>
                </tr>
              </thead>
              <tbody>
                {(saturation.matches ?? []).map((match, index) => (
                  <tr key={match.mint ?? `${match.symbol ?? 'match'}-${index}`}>
                    <Td className="text-ink">
                      <div className="font-medium">{match.name ?? 'Unnamed'}</div>
                      <div className="tnum text-xs text-ink-subtle">${match.symbol ?? '—'}</div>
                    </Td>
                    <Td>
                      <Badge tone={match.kind === 'name' || match.kind === 'ticker' ? 'warning' : 'neutral'}>
                        {humanise(match.kind ?? 'unknown')}
                      </Badge>
                    </Td>
                    <Td align="right" className="tnum">
                      <div>{formatPercent(match.similarity ?? null, 0)}</div>
                      <ScoreBar className="mt-1 w-20" value={match.similarity ?? 0} invert />
                    </Td>
                    <Td align="right" className="tnum">
                      {formatDuration(match.ageHours ?? null)}
                    </Td>
                    <Td align="right" className="tnum">
                      {formatUsd(match.marketCapUsd ?? null, { compact: true })}
                    </Td>
                    <Td>
                      {match.graduated ? (
                        <Badge tone="warning">Graduated</Badge>
                      ) : (
                        <span className="text-xs text-ink-subtle">On curve</span>
                      )}
                    </Td>
                    <Td>
                      {match.mint ? (
                        <span className="flex items-center gap-2">
                          {network ? (
                            <a
                              className="tnum text-xs text-accent-soft transition-colors hover:underline"
                              href={solscanUrl('token', match.mint, network)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {truncateAddress(match.mint)}
                            </a>
                          ) : (
                            <span className="tnum text-xs text-ink-muted">{truncateAddress(match.mint)}</span>
                          )}
                          <CopyButton value={match.mint} label="Copy" />
                        </span>
                      ) : (
                        <span className="text-xs text-ink-subtle">—</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        )}

        {parseStrings(saturation.rationale).length > 0 && (
          <ul className="mt-4 space-y-1.5">
            {parseStrings(saturation.rationale).map((line) => (
              <li key={line} className="flex gap-2 text-xs leading-relaxed text-ink-muted">
                <span aria-hidden="true" className="text-ink-subtle">
                  •
                </span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* 6. Originality */}
      <Card>
        <SectionHeader
          title="Originality"
          description="Distance from every concept this platform has generated before, and from the naming patterns that saturate every token list."
        />

        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Originality score</div>
            <div className="tnum mt-1 text-2xl font-semibold text-ink">
              {formatPercent(originality.score ?? candidate.originalityScore, 0)}
            </div>
            <ScoreBar
              className="mt-2"
              value={originality.score ?? candidate.originalityScore}
              tone={(originality.score ?? candidate.originalityScore) > 0.6 ? 'positive' : 'warning'}
            />
            {originality.isDuplicate && (
              <Note tone="negative">
                This is effectively a repeat of a concept the platform has already produced. Launching it competes with
                the platform&apos;s own earlier token.
              </Note>
            )}
          </div>

          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Nearest prior concept</div>
            {originality.nearestPrior?.name ? (
              <div className="mt-1 text-sm text-ink">
                {originality.nearestPrior.name}{' '}
                <span className="tnum text-accent-soft">${originality.nearestPrior.symbol ?? '—'}</span>
                <div className="tnum mt-1 text-xs text-ink-subtle">
                  {formatPercent(originality.nearestPrior.similarity ?? originality.maxPriorSimilarity ?? null, 0)}{' '}
                  similar
                </div>
              </div>
            ) : (
              <p className="mt-1 text-sm text-ink-muted">
                No prior concept was close enough to register. Either this is genuinely new ground or the platform has
                not generated much yet.
              </p>
            )}
          </div>

          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Clichés detected</div>
            {(originality.cliches ?? []).length === 0 ? (
              <p className="mt-1 text-sm text-ink-muted">None of the tracked naming clichés were found.</p>
            ) : (
              <>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {parseStrings(originality.cliches).map((cliche) => (
                    <Badge key={cliche} tone="warning">
                      {cliche}
                    </Badge>
                  ))}
                </div>
                {originality.clichePenalty !== undefined && (
                  <div className="tnum mt-2 text-xs text-ink-subtle">
                    Penalty applied: −{formatPercent(originality.clichePenalty, 0)}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {parseStrings(originality.rationale).length > 0 && (
          <ul className="mt-4 space-y-1.5">
            {parseStrings(originality.rationale).map((line) => (
              <li key={line} className="flex gap-2 text-xs leading-relaxed text-ink-muted">
                <span aria-hidden="true" className="text-ink-subtle">
                  •
                </span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* 7. Risk flags */}
      <Card>
        <SectionHeader
          title="Risk flags"
          description="Legal, ethical and reputational exposure detected by the risk lexicon and by the review panel."
        />
        {riskFlags.length === 0 ? (
          <EmptyState
            icon="◇"
            title="No risk flags"
            description="Nothing in the name, description or narrative matched the risk lexicon. That is a screening result, not legal advice — the lexicon only catches patterns it knows about."
          />
        ) : (
          <ul className="mt-4 space-y-2">
            {riskFlags.map((flag) => (
              <li
                key={`${flag.flag}-${flag.severity}`}
                className={
                  flag.severity === 'block'
                    ? 'flex flex-wrap items-center gap-3 rounded-lg border-2 border-negative bg-negative-dim/30 px-3 py-2'
                    : 'flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-raised px-3 py-2'
                }
              >
                <Badge tone={SEVERITY_TONE[flag.severity] ?? 'neutral'}>
                  {flag.severity === 'block' ? '■ ' : flag.severity === 'review' ? '▲ ' : ''}
                  {humanise(flag.severity)}
                </Badge>
                <span className="text-sm font-medium text-ink">{flag.label}</span>
                {flag.matched && <span className="text-xs text-ink-subtle">matched “{flag.matched}”</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* 8. Feature vector — for auditing the decision */}
      <Card>
        <SectionHeader
          title="Audit the decision"
          description="The exact feature vector the model saw, and the contributions that moved the prediction. Kept collapsed because most decisions do not need it — but every number above comes from here."
        />

        <details className="group mt-3">
          <summary className="cursor-pointer list-none rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:text-ink">
            <span aria-hidden="true" className="mr-2 inline-block transition-transform group-open:rotate-90">
              ▸
            </span>
            Show feature vector and drivers ({formatNumber(features.length)} features, {formatNumber(drivers.length)}{' '}
            drivers)
          </summary>

          <div className="mt-4 space-y-5">
            {driverChart.length === 0 ? (
              <Note>
                No driver breakdown was stored with this prediction, so the contribution of each feature cannot be
                shown.
              </Note>
            ) : (
              <div>
                <h3 className="text-sm font-semibold text-ink">Top feature contributions</h3>
                <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
                  Positive contributions pushed the predicted outcome up, negative ones pulled it down. Magnitudes are
                  in the model&apos;s internal units, so compare them to each other rather than reading them as SOL.
                </p>
                <div className="mt-3 w-full" style={{ height: Math.max(220, driverChart.length * 30) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={driverChart}
                      layout="vertical"
                      margin={{ top: 4, right: 20, bottom: 28, left: 8 }}
                      barCategoryGap="22%"
                    >
                      <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" horizontal={false} />
                      <XAxis
                        type="number"
                        tick={AXIS_STYLE}
                        stroke="var(--color-border-strong)"
                        tickFormatter={(v: number) => formatScore(v, 2)}
                        label={{
                          value: 'Contribution to the prediction',
                          position: 'insideBottom',
                          offset: -16,
                          fill: 'var(--color-ink-subtle)',
                          fontSize: 11,
                        }}
                      />
                      <YAxis
                        type="category"
                        dataKey="label"
                        tick={AXIS_STYLE}
                        stroke="var(--color-border-strong)"
                        width={132}
                      />
                      <ReferenceLine x={0} stroke="var(--color-border-strong)" />
                      <Tooltip content={<DriverTooltip />} cursor={{ fill: 'var(--color-surface-hover)' }} />
                      <Bar dataKey="contribution" radius={[0, 4, 4, 0]} isAnimationActive={false}>
                        {driverChart.map((d) => (
                          <Cell
                            key={d.feature}
                            fill={d.contribution >= 0 ? 'var(--color-accent)' : 'var(--color-negative)'}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {features.length === 0 ? (
              <Note>No feature vector was stored with this prediction.</Note>
            ) : (
              <div>
                <h3 className="text-sm font-semibold text-ink">Feature vector at decision time</h3>
                <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
                  Recorded verbatim when the prediction was made, so a later evaluation compares like with like.
                </p>
                <DataTable className="mt-3">
                  <thead>
                    <tr>
                      <Th>Feature</Th>
                      <Th align="right">Value</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {features.map((feature) => (
                      <tr key={feature.key}>
                        <Td className="text-ink">{humanise(feature.key)}</Td>
                        <Td align="right" className="tnum text-ink">
                          {formatScore(feature.value, 4)}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
              </div>
            )}

            {candidate.reasoningSummary && (
              <div>
                <h3 className="text-sm font-semibold text-ink">Generation reasoning</h3>
                <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-ink-muted">
                  {candidate.reasoningSummary}
                </p>
              </div>
            )}
          </div>
        </details>
      </Card>

      <Modal
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title={`Reject ${candidate.name ?? 'candidate'}`}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setRejectOpen(false)}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              disabled={reason.trim().length === 0 || reject.isPending}
              onClick={() => reject.mutate({ reason: reason.trim() })}
            >
              {reject.isPending ? 'Rejecting…' : 'Reject candidate'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm leading-relaxed text-ink-muted">
            The reason is stored in the audit log and fed back into the learning loop, so describe what was actually
            wrong rather than simply declining.
          </p>
          <div>
            <label className="label" htmlFor="reject-reason">
              Reason (required)
            </label>
            <textarea
              id="reject-reason"
              className="input min-h-24"
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. The risk reviewer's trademark concern is real — the name is one letter from a registered brand."
            />
            <div className="tnum mt-1 text-xs text-ink-subtle">{reason.length}/500</div>
          </div>
          {reject.isError && <Note tone="negative">Could not reject: {reject.error.message}</Note>}
        </div>
      </Modal>

      <Modal
        open={launchOpen}
        onClose={() => setLaunchOpen(false)}
        title="Launch this token now"
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setLaunchOpen(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={launch.isPending || metadataMissing}
              onClick={() => launch.mutate(undefined)}
            >
              {launch.isPending ? 'Launching…' : `Launch on ${humanise(network ?? 'unknown')}`}
            </button>
          </>
        }
      >
        <div className="space-y-3 text-sm leading-relaxed text-ink-muted">
          <p>
            This creates <strong className="text-ink">{candidate.name ?? 'this token'}</strong> (
            <span className="tnum text-accent-soft">${candidate.symbol ?? '—'}</span>) on{' '}
            <strong className="text-ink">{humanise(network ?? 'an unreported network')}</strong> immediately, without
            waiting for the next launch cycle.
          </p>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-border bg-surface-raised px-3 py-2 text-xs">
            <div>
              <dt className="text-ink-subtle">Network</dt>
              <dd className="text-ink">{humanise(network ?? 'not reported')}</dd>
            </div>
            <div>
              <dt className="text-ink-subtle">Estimated cost</dt>
              <dd className="tnum text-ink">
                {launchCostSol === null ? 'not available' : formatSol(launchCostSol)}
                {launchCostSol !== null && solPriceUsd !== null && ` ≈ ${formatUsd(launchCostSol * solPriceUsd)}`}
              </dd>
            </div>
          </dl>

          {launchCostSol === null && (
            <Note tone="warning">
              No cost assumption was stored with this candidate&apos;s prediction, so the figure above cannot be shown.
              The actual cost is whatever the launch transaction consumes.
            </Note>
          )}

          {network === 'mainnet' ? (
            <Note tone="negative">
              <span aria-hidden="true">⚠</span> <strong>This is mainnet.</strong> The transaction spends real funds and
              cannot be undone, refunded or reversed. A token, once minted, is public and permanent.
            </Note>
          ) : (
            <Note tone="info">
              Network is {humanise(network ?? 'unreported')}, so no real funds are at stake — but the launch is still
              recorded and counts against your daily limits.
            </Note>
          )}

          {blocking.length > 0 && (
            <Note tone="negative">
              <span aria-hidden="true">■</span> This candidate carries {formatNumber(blocking.length)} blocking risk
              flag{blocking.length === 1 ? '' : 's'}. Launching it anyway is a deliberate override of the platform&apos;s
              own safety screening.
            </Note>
          )}

          {candidate.status !== 'approved' && (
            <Note tone="warning">
              This candidate is &quot;{humanise(candidate.status)}&quot;, not approved. Launching now skips the
              approval step entirely.
            </Note>
          )}

          {metadataMissing && (
            <Note tone="negative">
              No hosted metadata URI exists for this candidate yet, so the artwork step has not finished. Launching
              would mint a permanently broken token, and the server will refuse it.
            </Note>
          )}

          {system.data?.emergencyStop && (
            <Note tone="negative">
              <span aria-hidden="true">■</span> The emergency stop is engaged. Every action that spends funds is
              suspended, so this launch will be refused until it is released.
            </Note>
          )}

          {launch.isError && <Note tone="negative">Launch failed: {launch.error.message}</Note>}
        </div>
      </Modal>

      <Modal
        open={regenerateOpen}
        onClose={() => setRegenerateOpen(false)}
        title="Regenerate concepts for this trend"
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setRegenerateOpen(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={regenerate.isPending}
              onClick={() => regenerate.mutate(undefined)}
            >
              {regenerate.isPending ? 'Regenerating…' : 'Regenerate'}
            </button>
          </>
        }
      >
        <div className="space-y-3 text-sm leading-relaxed text-ink-muted">
          <p>
            This rejects <strong className="text-ink">{candidate.name ?? 'this candidate'}</strong> as superseded and
            generates a fresh set of concepts from the same trend
            {trend ? ` ("${trend.title}")` : ''}. The current candidate cannot be recovered afterwards.
          </p>
          <p>
            Generation calls the model providers again, so it costs money and takes a little time. If the trend itself
            is the problem — already peaked, or too crowded — regenerating will not help.
          </p>
        </div>
      </Modal>
    </div>
  );
}

export default CandidateDetailPage;
