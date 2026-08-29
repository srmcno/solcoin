import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Modal,
  Note,
  ScoreBar,
  SectionHeader,
  Skeleton,
  StatTile,
  Tabs,
  type Tone,
} from '@/components/ui';
import { formatDuration, formatNumber, formatPercent, formatRelative, formatSol, humanise } from '@/lib/format';
import { POLL, queryKeys, useApiMutation, useApiQuery } from '@/lib/queries';
import { useSession } from '@/lib/session';

interface RiskFlag {
  flag: string;
  severity: string;
  label: string;
  matched?: string;
}

interface Candidate {
  id: string;
  name: string | null;
  symbol: string | null;
  description: string | null;
  narrative: string | null;
  archetype: string | null;
  status: string;
  imageUri: string | null;
  trendId: string | null;
  trendTitle: string | null;
  trendScore: number | null;
  originalityScore: number;
  saturationScore: number;
  aiPanelScore: number;
  aiPanelDisagreement: number;
  riskFlags: unknown;
  hardCollision: boolean;
  requiresHumanReview: boolean;
  isExploration: boolean;
  explorationArm: string | null;
  reasoningSummary: string | null;
  expectedValueSol: number | null;
  expectedCreatorFeesSol: number | null;
  probabilityTenHolders: number | null;
  probabilityGraduation: number | null;
  probabilityProfitable: number | null;
  confidence: number | null;
  createdAt: number;
  expiresAt: number | null;
}

interface CandidatesResponse {
  candidates?: Candidate[];
  counts?: Record<string, number>;
  autonomy?: string;
  network?: string;
}

type StatusId =
  | 'awaiting_approval'
  | 'approved'
  | 'draft'
  | 'evaluating'
  | 'rejected'
  | 'launched'
  | 'expired';

const STATUS_TABS: Array<{ id: StatusId; label: string }> = [
  { id: 'awaiting_approval', label: 'Awaiting approval' },
  { id: 'approved', label: 'Approved' },
  { id: 'draft', label: 'Draft' },
  { id: 'evaluating', label: 'Evaluating' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'launched', label: 'Launched' },
  { id: 'expired', label: 'Expired' },
];

/** What an operator should do about an empty tab, per tab. */
const EMPTY_COPY: Record<StatusId, { title: string; description: string }> = {
  awaiting_approval: {
    title: 'Nothing is waiting on you',
    description:
      'Candidates land here once a trend clears the generation threshold and a generated concept clears the quality gate. If this stays empty, either no trend is scoring highly enough or every concept is being rejected — Opportunities shows which.',
  },
  approved: {
    title: 'No approved candidates',
    description:
      'Approve a candidate from the Awaiting approval tab and it will appear here until the next launch cycle picks it up, or you launch it by hand from its detail page.',
  },
  draft: {
    title: 'No drafts',
    description:
      'A draft is a freshly generated concept that has not been through the review panel yet. Drafts normally exist for a minute or two before moving to Evaluating.',
  },
  evaluating: {
    title: 'Nothing is being evaluated',
    description:
      'The review panel scores each concept on originality, market fit, risk and creative appeal. Concepts pass through this state quickly, so seeing it empty is normal.',
  },
  rejected: {
    title: 'Nothing has been rejected',
    description:
      'Rejections are kept, not deleted, so you can audit why the platform or a reviewer turned a concept down. An empty list on a fresh install simply means nothing has been generated yet.',
  },
  launched: {
    title: 'No token has been launched yet',
    description:
      'Once a candidate is launched it appears here and gets a live position on the Tokens page, where its holders, volume and creator fees are tracked.',
  },
  expired: {
    title: 'Nothing has expired',
    description:
      'A candidate expires when the trend behind it goes stale before anyone approved it. Expiries are worth watching: a lot of them means candidates are sitting in review for longer than their trends survive.',
  },
};

const SEVERITY_TONE: Record<string, Tone> = {
  block: 'negative',
  review: 'warning',
  note: 'info',
};

/** Panel disagreement above this is meaningful signal, not model noise. */
const DISAGREEMENT_THRESHOLD = 0.45;
/** Below this the model has seen too few real outcomes to be a measurement. */
const LOW_CONFIDENCE = 0.5;

const APPROVABLE: ReadonlySet<string> = new Set(['awaiting_approval', 'draft', 'evaluating']);
const REJECTABLE: ReadonlySet<string> = new Set(['awaiting_approval', 'draft', 'evaluating', 'approved']);

/** The API types risk flags loosely; nothing here trusts their shape. */
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
    .filter((f): f is RiskFlag => f !== null);
}

function isRenderableImage(uri: string | null): boolean {
  if (!uri) return false;
  return /^(https?:|data:image\/)/i.test(uri);
}

function expiry(expiresAt: number | null, now: number): { text: string; tone: Tone } | null {
  if (!expiresAt || !Number.isFinite(expiresAt)) return null;
  const hours = (expiresAt - now) / 3_600_000;
  if (hours <= 0) return { text: 'Expired', tone: 'negative' };
  return { text: `Expires in ${formatDuration(hours)}`, tone: hours < 6 ? 'warning' : 'neutral' };
}

function AutonomyBanner({ autonomy, network }: { autonomy: string | undefined; network: string | undefined }) {
  const net = network ? humanise(network) : 'unknown network';
  if (autonomy === 'auto') {
    return (
      <Note tone="warning">
        <span aria-hidden="true">⚠</span> <strong>Launch autonomy: automatic.</strong> Approved candidates are launched
        by the platform without a further prompt, subject to the spend and rate limits in Settings. Network is{' '}
        <strong>{net}</strong>
        {network === 'mainnet' ? ' — launches spend real funds.' : '.'} Rejecting a candidate is the only way to stop
        it.
      </Note>
    );
  }
  if (autonomy === 'approve') {
    return (
      <Note tone="info">
        <strong>Launch autonomy: approval required.</strong> Nothing launches without a human. A candidate stays here
        until someone approves it, and only then can it be launched. Network is <strong>{net}</strong>.
      </Note>
    );
  }
  if (autonomy === 'suggest' || autonomy === 'off') {
    return (
      <Note tone="neutral">
        <strong>Launch autonomy: {autonomy === 'off' ? 'off' : 'suggest only'}.</strong> The platform will generate and
        score candidates but will not launch anything, even after approval. Raise autonomy in Settings when you want
        launches to be possible. Network is <strong>{net}</strong>.
      </Note>
    );
  }
  return (
    <Note tone="neutral">
      The API did not report a launch autonomy mode, so this page cannot tell you whether approving a candidate can
      lead to a launch. Check Settings before approving anything.
    </Note>
  );
}

/**
 * A tooltip wrapper. Badge takes no `title`, and several markers on this page
 * are meaningless without the sentence that explains them.
 */
function Hint({ text, children }: { text: string; children: ReactNode }) {
  return (
    <span className="inline-flex cursor-help" title={text}>
      {children}
    </span>
  );
}

function ArtworkThumb({ candidate }: { candidate: Candidate }) {
  const [failed, setFailed] = useState(false);
  const renderable = isRenderableImage(candidate.imageUri) && !failed;
  const initial = (candidate.symbol ?? candidate.name ?? '?').trim().charAt(0).toUpperCase() || '?';

  if (renderable && candidate.imageUri) {
    return (
      <img
        src={candidate.imageUri}
        alt={`Artwork for ${candidate.name ?? 'this candidate'}`}
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-16 w-16 shrink-0 rounded-xl border border-border object-cover"
      />
    );
  }

  return (
    <div className="shrink-0 text-center">
      <div
        className="flex h-16 w-16 items-center justify-center rounded-xl border border-dashed border-border-strong bg-surface-raised text-xl font-semibold text-ink-subtle"
        aria-hidden="true"
      >
        {initial}
      </div>
      <div className="mt-1 text-[0.625rem] leading-tight text-ink-subtle">artwork pending</div>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[0.625rem] font-medium uppercase tracking-wide text-ink-subtle">{label}</div>
      <div className="tnum truncate text-sm font-semibold text-ink" title={hint}>
        {value}
      </div>
    </div>
  );
}

export function CandidatesPage() {
  const { can } = useSession();
  const [status, setStatus] = useState<StatusId>('awaiting_approval');
  const [rejecting, setRejecting] = useState<Candidate | null>(null);
  const [reason, setReason] = useState('');
  const [now, setNow] = useState(() => Date.now());

  // Expiry countdowns are the only thing on this page that changes without new
  // data, so they tick locally rather than forcing a refetch.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const query = useApiQuery<CandidatesResponse>(
    queryKeys.candidates(status),
    `/api/candidates?status=${encodeURIComponent(status)}&limit=50`,
    { refetchInterval: POLL.normal },
  );

  const approve = useApiMutation<{ ok?: boolean; message?: string }, { id: string }>(
    (variables) => `/api/candidates/${encodeURIComponent(variables.id)}/approve`,
    { invalidate: [['candidates']] },
  );
  const reject = useApiMutation<{ ok?: boolean }, { id: string; reason: string }>(
    (variables) => `/api/candidates/${encodeURIComponent(variables.id)}/reject`,
    {
      invalidate: [['candidates']],
      onSuccess: () => {
        setRejecting(null);
        setReason('');
      },
    },
  );

  const candidates = useMemo(() => query.data?.candidates ?? [], [query.data]);
  const counts = query.data?.counts ?? {};
  const canApprove = can('approve_candidate');
  const canReject = can('reject_candidate');

  const lowConfidenceCount = candidates.filter(
    (c) => c.confidence !== null && c.confidence < LOW_CONFIDENCE,
  ).length;

  const tabs = STATUS_TABS.map((tab) => ({ id: tab.id, label: tab.label, count: counts[tab.id] ?? 0 }));
  const empty = EMPTY_COPY[status];

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Candidates"
        description="Token concepts generated from scored trends, each with a modelled outcome, a review-panel verdict and a quality-gate result. Approving one makes it eligible to be launched with real funds."
      />

      <AutonomyBanner autonomy={query.data?.autonomy} network={query.data?.network} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Awaiting approval"
          value={query.isLoading ? '—' : formatNumber(counts.awaiting_approval ?? 0)}
          tone={(counts.awaiting_approval ?? 0) > 0 ? 'warning' : 'neutral'}
          hint="Waiting on a human decision."
        />
        <StatTile
          label="Approved"
          value={query.isLoading ? '—' : formatNumber(counts.approved ?? 0)}
          tone={(counts.approved ?? 0) > 0 ? 'positive' : 'neutral'}
          hint="Cleared for launch, not yet launched."
        />
        <StatTile
          label="Launched"
          value={query.isLoading ? '—' : formatNumber(counts.launched ?? 0)}
          hint="Live tokens; performance is on the Tokens page."
        />
        <StatTile
          label="Rejected"
          value={query.isLoading ? '—' : formatNumber(counts.rejected ?? 0)}
          hint="Kept for audit, including the reason given."
        />
      </div>

      {approve.isError && <Note tone="negative">Could not approve: {approve.error.message}</Note>}
      {approve.isSuccess && approve.data?.message && <Note tone="positive">{approve.data.message}</Note>}
      {reject.isError && !rejecting && <Note tone="negative">Could not reject: {reject.error.message}</Note>}

      <Card padded={false}>
        <div className="px-4 pt-3 sm:px-5">
          <Tabs tabs={tabs} active={status} onChange={setStatus} />
        </div>

        <div className="p-4 sm:p-5">
          {query.isLoading ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-56 w-full" />
              ))}
            </div>
          ) : query.isError ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : candidates.length === 0 ? (
            <EmptyState
              icon="◇"
              title={empty.title}
              description={empty.description}
              action={
                <Link className="btn btn-ghost" to="/opportunities">
                  View opportunities
                </Link>
              }
            />
          ) : (
            <>
              {lowConfidenceCount > 0 && (
                <Note tone="warning">
                  {lowConfidenceCount === candidates.length
                    ? 'Every candidate below'
                    : `${formatNumber(lowConfidenceCount)} of ${formatNumber(candidates.length)} candidates below`}{' '}
                  carries model confidence under {formatPercent(LOW_CONFIDENCE, 0)}. The probabilities and expected
                  values shown are the model&apos;s priors, not measurements from realised launches — treat them as a
                  ranking, not a forecast.
                </Note>
              )}

              <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {candidates.map((candidate) => {
                  const flags = parseRiskFlags(candidate.riskFlags);
                  const blocking = flags.filter((f) => f.severity === 'block');
                  const countdown = expiry(candidate.expiresAt, now);
                  const disagreed = candidate.aiPanelDisagreement > DISAGREEMENT_THRESHOLD;
                  const approvePending = approve.isPending && approve.variables?.id === candidate.id;

                  return (
                    <div
                      key={candidate.id}
                      className="card flex flex-col gap-3 p-4 transition-colors hover:border-border-strong"
                    >
                      <div className="flex items-start gap-3">
                        <ArtworkThumb candidate={candidate} />
                        <div className="min-w-0 flex-1">
                          <Link
                            to={`/candidates/${encodeURIComponent(candidate.id)}`}
                            className="block truncate text-sm font-semibold text-ink transition-colors hover:text-accent-soft"
                          >
                            {candidate.name ?? 'Unnamed concept'}
                          </Link>
                          <div className="tnum mt-0.5 text-xs font-medium text-accent-soft">
                            ${candidate.symbol ?? '—'}
                          </div>
                          <div className="mt-1 truncate text-xs text-ink-subtle" title={candidate.trendTitle ?? ''}>
                            {candidate.trendTitle ? (
                              <>
                                From trend:{' '}
                                {candidate.trendId ? (
                                  <Link
                                    to={`/opportunities/${encodeURIComponent(candidate.trendId)}`}
                                    className="transition-colors hover:text-accent-soft"
                                  >
                                    {candidate.trendTitle}
                                  </Link>
                                ) : (
                                  candidate.trendTitle
                                )}
                              </>
                            ) : (
                              'No source trend recorded'
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        {candidate.isExploration && (
                          <Hint text="Exploration: the platform deliberately tries a fraction of candidates its model is unsure about. Without them the model only ever learns about the region it already believes in, and never finds out where it was wrong.">
                            <Badge tone="info">
                              ◈ Exploration
                              {candidate.explorationArm ? `: ${humanise(candidate.explorationArm)}` : ''}
                            </Badge>
                          </Hint>
                        )}
                        {disagreed && (
                          <Hint
                            text={`Panel disagreement ${formatPercent(candidate.aiPanelDisagreement, 0)}. The reviewers reached materially different scores, which usually means the concept is genuinely borderline rather than uniformly weak.`}
                          >
                            <Badge tone="warning">⚖ Reviewers disagreed</Badge>
                          </Hint>
                        )}
                        {candidate.hardCollision && (
                          <Hint text="An existing token is close enough that traders would confuse the two.">
                            <Badge tone="negative">✕ Name collision</Badge>
                          </Hint>
                        )}
                        {candidate.requiresHumanReview && !blocking.length && (
                          <Badge tone="warning">Needs human review</Badge>
                        )}
                        {flags.slice(0, 3).map((flag) => (
                          <Hint
                            key={`${flag.flag}-${flag.severity}`}
                            text={`${humanise(flag.severity)} severity${flag.matched ? ` — matched "${flag.matched}"` : ''}`}
                          >
                            <Badge tone={SEVERITY_TONE[flag.severity] ?? 'neutral'}>
                              {flag.severity === 'block' ? '■ ' : flag.severity === 'review' ? '▲ ' : ''}
                              {flag.label}
                            </Badge>
                          </Hint>
                        ))}
                        {flags.length > 3 && <Badge>+{flags.length - 3} more flags</Badge>}
                        {countdown && (
                          <Badge tone={countdown.tone}>
                            {countdown.tone === 'negative' ? '⏱ ' : ''}
                            {countdown.text}
                          </Badge>
                        )}
                      </div>

                      <div className="grid grid-cols-3 gap-2 border-t border-border pt-3">
                        <Metric
                          label="Expected value"
                          value={formatSol(candidate.expectedValueSol, { sign: true })}
                          hint="Modelled net SOL after launch and operating costs."
                        />
                        <Metric
                          label="P(10 holders)"
                          value={formatPercent(candidate.probabilityTenHolders, 0)}
                          hint="Modelled probability of reaching ten distinct holders."
                        />
                        <Metric
                          label="Panel score"
                          value={formatPercent(candidate.aiPanelScore, 0)}
                          hint="Weighted mean across reviewer roles."
                        />
                      </div>

                      <ScoreBar
                        value={candidate.aiPanelScore}
                        tone={candidate.aiPanelScore > 0.7 ? 'positive' : candidate.aiPanelScore > 0.5 ? 'accent' : 'warning'}
                      />

                      <div className="text-xs leading-relaxed text-ink-subtle">
                        {candidate.confidence === null ? (
                          'No model confidence was recorded for this candidate.'
                        ) : candidate.confidence < LOW_CONFIDENCE ? (
                          <span className="text-warning">
                            <span aria-hidden="true">⚠</span> Model confidence {formatPercent(candidate.confidence, 0)}{' '}
                            — these figures are priors, not measurements.
                          </span>
                        ) : (
                          <>Model confidence {formatPercent(candidate.confidence, 0)}.</>
                        )}{' '}
                        Created {formatRelative(candidate.createdAt, now)}.
                      </div>

                      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border pt-3">
                        <Link
                          className="btn btn-ghost"
                          to={`/candidates/${encodeURIComponent(candidate.id)}`}
                        >
                          Review
                        </Link>
                        {canApprove && APPROVABLE.has(candidate.status) && (
                          <button
                            className="btn btn-primary"
                            onClick={() => approve.mutate({ id: candidate.id })}
                            disabled={approvePending}
                          >
                            {approvePending ? 'Approving…' : 'Approve'}
                          </button>
                        )}
                        {canReject && REJECTABLE.has(candidate.status) && (
                          <button
                            className="btn btn-danger"
                            onClick={() => {
                              setReason('');
                              reject.reset();
                              setRejecting(candidate);
                            }}
                          >
                            Reject
                          </button>
                        )}
                        {!canApprove && !canReject && (
                          <span className="text-xs text-ink-subtle">
                            Your role can view candidates but not decide on them.
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </Card>

      <Modal
        open={rejecting !== null}
        onClose={() => setRejecting(null)}
        title={`Reject ${rejecting?.name ?? 'candidate'}`}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setRejecting(null)}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              disabled={reason.trim().length === 0 || reject.isPending}
              onClick={() => {
                if (!rejecting) return;
                reject.mutate({ id: rejecting.id, reason: reason.trim() });
              }}
            >
              {reject.isPending ? 'Rejecting…' : 'Reject candidate'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm leading-relaxed text-ink-muted">
            Rejecting {rejecting?.name ?? 'this candidate'} (${rejecting?.symbol ?? '—'}) removes it from the launch
            queue permanently. The reason is stored in the audit log and is fed back to the learning loop, so write
            what was actually wrong with it rather than &quot;no&quot;.
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
              placeholder="e.g. The trend has already peaked and three near-identical tokens launched yesterday."
            />
            <div className="tnum mt-1 text-xs text-ink-subtle">{reason.length}/500</div>
          </div>
          {reject.isError && <Note tone="negative">Could not reject: {reject.error.message}</Note>}
        </div>
      </Modal>
    </div>
  );
}

export default CandidatesPage;
