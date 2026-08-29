import { useMemo, useState } from 'react';
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
  ScoreBar,
  SectionHeader,
  StatTile,
  Tabs,
  Td,
  Th,
  type Tone,
} from '@/components/ui';
import { formatDuration, formatNumber, formatPercent, formatRelative, formatScore, humanise } from '@/lib/format';
import { POLL, queryKeys, useApiMutation, useApiQuery } from '@/lib/queries';
import { useSession } from '@/lib/session';

interface ScoredTrend {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  category: string;
  phase: string;
  status: string;
  opportunityScore: number;
  rawOpportunityScore: number;
  saturationScore: number;
  velocity: number;
  acceleration: number;
  consistency: number;
  novelty: number;
  audienceEstimate: number;
  engagement: number;
  memeability: number;
  sourceCount: number;
  remainingLifespanHours: number;
  ageHours: number;
  firstSeenAt: number;
  lastSeenAt: number;
  sources?: string[];
  keywords?: string[];
  aiSummary: string | null;
  injectionFlagged: boolean;
}

interface OpportunitiesResponse {
  opportunities?: ScoredTrend[];
  qualifyingCount?: number;
  thresholds?: {
    generation?: number;
    gate?: number;
    maxSaturation?: number;
    maxTrendAgeHours?: number;
  };
}

interface JobsResponse {
  jobs?: Array<{ name: string; enabled: boolean; intervalSeconds: number; lastRunAt: number | null; nextRunAt: number | null; running: boolean }>;
}

/**
 * Phase tones encode the platform's thesis, not a rainbow: `emerging` is the
 * window the whole system exists to catch, so it is the only positive tone.
 * Everything past the peak reads as a warning or worse.
 */
const PHASE_TONE: Record<string, Tone> = {
  nascent: 'info',
  emerging: 'positive',
  peaking: 'warning',
  declining: 'negative',
  dormant: 'neutral',
};

const PHASE_HINT: Record<string, string> = {
  nascent: 'Just detected; too little history to be confident yet.',
  emerging: 'Growing and not yet crowded — the window this platform targets.',
  peaking: 'Attention is at or near its maximum; upside is mostly spent.',
  declining: 'Interest is falling away.',
  dormant: 'Flat. Kept for matching, not for action.',
};

const PHASES = ['nascent', 'emerging', 'peaking', 'declining', 'dormant'] as const;

type SortKey = 'score' | 'velocity' | 'newest' | 'saturation';

const SORTS: Array<{ id: SortKey; label: string }> = [
  { id: 'score', label: 'Opportunity score' },
  { id: 'velocity', label: 'Velocity' },
  { id: 'newest', label: 'Newest' },
  { id: 'saturation', label: 'Least saturated' },
];

/** Cross-source confirmation below this is a single unverified population. */
const MIN_SOURCES = 2;

export function OpportunitiesPage() {
  const { can } = useSession();
  const [tab, setTab] = useState<'all' | 'clears' | 'below'>('all');
  const [sort, setSort] = useState<SortKey>('score');
  const [phase, setPhase] = useState<string>('all');
  const [category, setCategory] = useState<string>('all');
  const [minScore, setMinScore] = useState(0);

  const query = useApiQuery<OpportunitiesResponse>(queryKeys.opportunities, '/api/opportunities', {
    refetchInterval: POLL.normal,
  });
  const jobs = useApiQuery<JobsResponse>(queryKeys.jobs, '/api/jobs', { refetchInterval: POLL.normal });

  const discover = useApiMutation<{ ok?: boolean; message?: string }>('/api/trends/discover', {
    invalidate: [queryKeys.opportunities, queryKeys.jobs],
  });

  const trends = useMemo(() => query.data?.opportunities ?? [], [query.data]);
  const generationThreshold = query.data?.thresholds?.generation;
  const discoveryJob = jobs.data?.jobs?.find((j) => j.name === 'trend-discovery');

  const categories = useMemo(
    () => [...new Set(trends.map((t) => t.category).filter(Boolean))].sort(),
    [trends],
  );

  const clearsThreshold = (t: ScoredTrend): boolean =>
    generationThreshold !== undefined && t.opportunityScore >= generationThreshold;

  const visible = useMemo(() => {
    const filtered = trends.filter((t) => {
      if (phase !== 'all' && t.phase !== phase) return false;
      if (category !== 'all' && t.category !== category) return false;
      if (t.opportunityScore < minScore) return false;
      if (tab === 'clears' && !clearsThreshold(t)) return false;
      if (tab === 'below' && clearsThreshold(t)) return false;
      return true;
    });

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sort) {
        case 'velocity':
          return b.velocity - a.velocity;
        case 'newest':
          return b.firstSeenAt - a.firstSeenAt;
        case 'saturation':
          return a.saturationScore - b.saturationScore;
        default:
          return b.opportunityScore - a.opportunityScore;
      }
    });
    return sorted;
  }, [trends, phase, category, minScore, tab, sort, generationThreshold]);

  const clearingCount = useMemo(() => trends.filter(clearsThreshold).length, [trends, generationThreshold]);
  const unconfirmed = useMemo(() => visible.filter((t) => t.sourceCount < MIN_SOURCES).length, [visible]);

  const runButton = can('run_research') ? (
    <button
      className="btn btn-primary"
      onClick={() => discover.mutate()}
      disabled={discover.isPending || discoveryJob?.running}
    >
      {discover.isPending ? 'Starting…' : discoveryJob?.running ? 'Discovery running…' : 'Run discovery now'}
    </button>
  ) : null;

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Opportunities"
        description="Trends discovered across independent sources, scored for how much untapped attention is left. Only trends clearing the generation threshold are handed to concept generation."
        action={runButton}
      />

      {discover.isSuccess && (
        <Note tone="positive">
          {discover.data?.message ?? 'Discovery started. Results appear as providers report in.'}
        </Note>
      )}
      {discover.isError && <Note tone="negative">Could not start discovery: {discover.error.message}</Note>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Clearing threshold"
          value={query.isLoading ? '—' : formatNumber(query.data?.qualifyingCount ?? clearingCount)}
          tone={(query.data?.qualifyingCount ?? clearingCount) > 0 ? 'positive' : 'neutral'}
          hint={
            generationThreshold === undefined
              ? 'Threshold not reported by the API.'
              : `Score ≥ ${formatScore(generationThreshold, 0)} of 100`
          }
        />
        <StatTile
          label="Trends tracked"
          value={query.isLoading ? '—' : formatNumber(trends.length)}
          hint="Active trends returned by the scorer."
        />
        <StatTile
          label="Quality gate"
          value={
            query.data?.thresholds?.gate === undefined ? '—' : formatScore(query.data.thresholds.gate, 0)
          }
          hint={
            query.data?.thresholds?.maxSaturation === undefined
              ? 'Minimum score a concept must hold at launch.'
              : `Min score at launch; max saturation ${formatPercent(query.data.thresholds.maxSaturation, 0)}`
          }
        />
        <StatTile
          label="Max trend age"
          value={
            query.data?.thresholds?.maxTrendAgeHours === undefined
              ? '—'
              : formatDuration(query.data.thresholds.maxTrendAgeHours)
          }
          hint="Older trends are refused by the quality gate."
        />
      </div>

      <Card padded={false}>
        <div className="border-b border-border px-4 pt-3 sm:px-5">
          <Tabs
            tabs={[
              { id: 'all', label: 'All', count: trends.length },
              { id: 'clears', label: 'Clears threshold', count: clearingCount },
              { id: 'below', label: 'Below threshold', count: trends.length - clearingCount },
            ]}
            active={tab}
            onChange={setTab}
            className="border-b-0"
          />
        </div>

        <div className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div className="min-w-[9rem] flex-1 sm:max-w-[12rem]">
            <label className="label" htmlFor="opp-sort">
              Sort by
            </label>
            <select id="opp-sort" className="input" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-[9rem] flex-1 sm:max-w-[12rem]">
            <label className="label" htmlFor="opp-phase">
              Phase
            </label>
            <select id="opp-phase" className="input" value={phase} onChange={(e) => setPhase(e.target.value)}>
              <option value="all">All phases</option>
              {PHASES.map((p) => (
                <option key={p} value={p}>
                  {humanise(p)}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-[9rem] flex-1 sm:max-w-[12rem]">
            <label className="label" htmlFor="opp-category">
              Category
            </label>
            <select id="opp-category" className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="all">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {humanise(c)}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-[9rem] flex-1 sm:max-w-[12rem]">
            <label className="label" htmlFor="opp-min-score">
              Minimum score
            </label>
            <input
              id="opp-min-score"
              className="input tnum"
              type="number"
              min={0}
              max={100}
              step={1}
              value={minScore}
              onChange={(e) => setMinScore(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
            />
          </div>
        </div>

        <div className="px-4 py-4 sm:px-5">
          {query.isLoading ? (
            <LoadingRows rows={8} />
          ) : query.isError ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : trends.length === 0 ? (
            <EmptyState
              icon="◎"
              title="No trends discovered yet"
              description={
                <>
                  Discovery runs on a schedule and writes trends here as sources report in.
                  {discoveryJob ? (
                    <>
                      {' '}
                      The next <span className="font-medium text-ink">trend-discovery</span> run is due{' '}
                      <span className="tnum text-ink">{formatRelative(discoveryJob.nextRunAt)}</span>
                      {discoveryJob.lastRunAt ? (
                        <> (last ran {formatRelative(discoveryJob.lastRunAt)}).</>
                      ) : (
                        <> — it has not run yet.</>
                      )}
                      {!discoveryJob.enabled && ' The job is currently disabled in Settings → Jobs.'}
                    </>
                  ) : (
                    ' Check Settings → Jobs for the discovery schedule.'
                  )}
                  {!can('run_research') && ' Ask an operator to trigger a run if you need results sooner.'}
                </>
              }
              action={runButton}
            />
          ) : visible.length === 0 ? (
            <EmptyState
              icon="⁝"
              title="No trends match these filters"
              description={`${formatNumber(trends.length)} trends are tracked, but none match the current phase, category, score and threshold filters. Widen them to see the full set.`}
              action={
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    setPhase('all');
                    setCategory('all');
                    setMinScore(0);
                    setTab('all');
                  }}
                >
                  Clear filters
                </button>
              }
            />
          ) : (
            <div className="space-y-3">
              {generationThreshold !== undefined && (
                <Note tone="neutral">
                  Generation threshold is <strong className="tnum">{formatScore(generationThreshold, 0)}</strong> of 100.
                  Rows marked <span className="text-positive">Clears</span> are eligible for concept generation; rows
                  marked <span className="text-ink-subtle">Below</span> are tracked but not acted on.
                </Note>
              )}
              {unconfirmed > 0 && (
                <Note tone="warning">
                  {formatNumber(unconfirmed)} of {formatNumber(visible.length)} listed trends were seen on fewer than{' '}
                  {MIN_SOURCES} independent sources. Their velocity and saturation come from a single population and
                  should not be read as confirmed.
                </Note>
              )}

              <DataTable>
                <thead>
                  <tr>
                    <Th>Trend</Th>
                    <Th>Phase</Th>
                    <Th align="right">Opportunity</Th>
                    <Th align="right">Velocity</Th>
                    <Th align="right">Saturation</Th>
                    <Th align="right">Age</Th>
                    <Th align="right">Runway left</Th>
                    <Th>Sources</Th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((t) => {
                    const clears = clearsThreshold(t);
                    return (
                      <tr key={t.id} className="transition-colors hover:bg-surface-hover/60">
                        <Td className="min-w-[16rem] max-w-[22rem]">
                          <Link
                            to={`/opportunities/${t.id}`}
                            className="text-sm font-medium text-ink hover:text-accent-soft"
                          >
                            {t.title}
                          </Link>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            <Badge>{humanise(t.category)}</Badge>
                            {t.injectionFlagged && (
                              <Badge tone="warning">
                                <span aria-hidden="true">⚠</span> Injection flagged
                              </Badge>
                            )}
                          </div>
                          {t.injectionFlagged && (
                            <p className="mt-1 text-xs leading-relaxed text-warning">
                              Source text contained something resembling an instruction. It was treated strictly as
                              data and never passed to a model as a prompt.
                            </p>
                          )}
                        </Td>
                        <Td>
                          <Badge tone={PHASE_TONE[t.phase] ?? 'neutral'}>{humanise(t.phase)}</Badge>
                          <div className="mt-1 max-w-[13rem] text-xs leading-snug text-ink-subtle">
                            {PHASE_HINT[t.phase] ?? ''}
                          </div>
                        </Td>
                        <Td align="right" className="min-w-[9rem]">
                          <div className="tnum text-sm font-semibold text-ink">{formatScore(t.opportunityScore, 1)}</div>
                          <ScoreBar value={t.opportunityScore} max={100} className="mt-1.5" />
                          <div className="mt-1 text-xs">
                            {clears ? (
                              <span className="text-positive">✓ Clears</span>
                            ) : (
                              <span className="text-ink-subtle">
                                {generationThreshold === undefined
                                  ? 'No threshold'
                                  : `Below by ${formatScore(generationThreshold - t.opportunityScore, 1)}`}
                              </span>
                            )}
                          </div>
                        </Td>
                        <Td align="right" className="tnum whitespace-nowrap">
                          <span className={t.velocity > 0 ? 'text-positive' : t.velocity < 0 ? 'text-negative' : ''}>
                            {t.velocity > 0 ? '▲' : t.velocity < 0 ? '▼' : ''} {formatPercent(t.velocity, 1)}/h
                          </span>
                          <div className="text-xs text-ink-subtle">accel {formatPercent(t.acceleration, 2)}</div>
                        </Td>
                        <Td align="right" className="min-w-[7rem]">
                          <div className="tnum text-sm">{formatPercent(t.saturationScore, 0)}</div>
                          <ScoreBar value={t.saturationScore} invert className="mt-1.5" />
                        </Td>
                        <Td align="right" className="tnum whitespace-nowrap">
                          {formatDuration(t.ageHours)}
                        </Td>
                        <Td align="right" className="tnum whitespace-nowrap">
                          {formatDuration(t.remainingLifespanHours)}
                        </Td>
                        <Td className="min-w-[11rem]">
                          <div className="flex flex-wrap items-center gap-1">
                            {(t.sources ?? []).slice(0, 4).map((s) => (
                              <Badge key={s} tone="info">
                                {humanise(s)}
                              </Badge>
                            ))}
                            {(t.sources?.length ?? 0) > 4 && <Badge>+{(t.sources?.length ?? 0) - 4}</Badge>}
                            {(t.sources?.length ?? 0) === 0 && <span className="text-xs text-ink-subtle">—</span>}
                          </div>
                          <div className="mt-1">
                            <SampleSize n={t.sourceCount} minimum={MIN_SOURCES} />
                          </div>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </DataTable>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

export default OpportunitiesPage;
