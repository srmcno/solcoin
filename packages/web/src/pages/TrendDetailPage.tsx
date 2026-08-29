import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
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
  formatScore,
  humanise,
} from '@/lib/format';
import { POLL, queryKeys, useApiQuery } from '@/lib/queries';

interface Trend {
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
  scoreBreakdown?: unknown;
  aiSummary: string | null;
  injectionFlagged: boolean;
}

interface Observation {
  source: string;
  observedAt: number;
  rawValue: number;
  normalisedValue: number;
  url: string | null;
  excerpt: string | null;
}

interface Concept {
  id: string;
  name: string | null;
  symbol: string | null;
  status: string;
  opportunity_score: number | null;
  originality_score: number | null;
  saturation_score: number | null;
  ai_panel_score: number | null;
  rejection_reason: string | null;
  rejection_detail: string | null;
  created_at: number | null;
}

interface TrendDetailResponse {
  trend?: Trend;
  observations?: Observation[];
  concepts?: Concept[];
}

interface Contribution {
  component: string;
  value: number;
  weight: number;
  contribution: number;
}

interface Kinetics {
  /**
   * False when the series is too short or too brief to fit a slope. The
   * kinetics module's own contract: callers must treat velocity and
   * acceleration as unknown rather than zero-meaning-flat.
   */
  rateEstimable: boolean;
  n: number | null;
  spanHours: number | null;
}

interface ScoreBreakdown {
  rawScore?: number;
  saturationMultiplier?: number;
  /**
   * The second multiplier. The final score is raw × saturation × evidence, so
   * quoting only the saturation multiplier states arithmetic that does not
   * reproduce the number on screen.
   */
  evidenceMultiplier?: number;
  contributions: Contribution[];
  rationale: string[];
  kinetics: Kinetics | null;
}

const PHASE_TONE: Record<string, Tone> = {
  nascent: 'info',
  emerging: 'positive',
  peaking: 'warning',
  declining: 'negative',
  dormant: 'neutral',
};

const CONCEPT_TONE: Record<string, Tone> = {
  draft: 'neutral',
  evaluating: 'info',
  rejected: 'negative',
  candidate: 'accent',
  awaiting_approval: 'warning',
  approved: 'positive',
  queued: 'info',
  launching: 'info',
  launched: 'positive',
  failed: 'negative',
  expired: 'neutral',
};

/**
 * Series colours are assigned by source identity, not by position in the
 * filtered list, so a source keeps its colour no matter which others are
 * present. The order was chosen for colour-vision separation; dash patterns
 * carry the same identity for anyone who cannot rely on hue.
 */
const SERIES_ORDER = [
  'google_trends',
  'wikipedia',
  'gdelt',
  'bluesky',
  'mastodon',
  'hackernews',
  'stackexchange',
  'rss',
  'youtube',
  'reddit',
  'x',
  'pumpfun_market',
  'dexscreener',
  'manual',
];

const SERIES_COLOURS = [
  'var(--color-accent)',
  'var(--color-positive)',
  'var(--color-warning)',
  'var(--color-info)',
  'var(--color-negative)',
];

const SERIES_DASHES = ['0', '6 3', '2 3', '10 4', '6 3 2 3'];

function seriesStyle(source: string, fallbackIndex: number): { colour: string; dash: string } {
  const known = SERIES_ORDER.indexOf(source);
  const index = known >= 0 ? known : SERIES_ORDER.length + fallbackIndex;
  return {
    colour: SERIES_COLOURS[index % SERIES_COLOURS.length] ?? 'var(--color-accent)',
    dash: SERIES_DASHES[Math.floor(index / SERIES_COLOURS.length) % SERIES_DASHES.length] ?? '0',
  };
}

const COMPONENT_HELP: Record<string, string> = {
  velocity: 'Fractional growth per hour, squashed to 0–1.',
  acceleration: 'Whether growth is still speeding up or already slowing.',
  consistency: 'How steady the signal is rather than one spike.',
  breadth: 'Cross-platform confirmation, weighted by source independence.',
  audience: 'Size of the population reached, log-scaled.',
  novelty: 'Distance from every other trend currently tracked.',
  engagement: 'Interaction intensity per unit of reach.',
  memeability: 'How readily the idea becomes a name and an image.',
  earliness: 'Value of arriving early; decays with trend age.',
  runway: 'How much attention is estimated to remain.',
};

/** The API types this as `unknown`; nothing here trusts its shape. */
function parseBreakdown(raw: unknown): ScoreBreakdown | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const contributions = Array.isArray(record.contributions)
    ? record.contributions
        .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object')
        .map((c) => ({
          component: String(c.component ?? ''),
          value: Number(c.value ?? 0),
          weight: Number(c.weight ?? 0),
          contribution: Number(c.contribution ?? 0),
        }))
        .filter((c) => c.component && Number.isFinite(c.contribution))
    : [];
  const rationale = Array.isArray(record.rationale)
    ? record.rationale.filter((r): r is string => typeof r === 'string')
    : [];
  if (contributions.length === 0 && rationale.length === 0) return null;
  return {
    rawScore: finiteOrUndefined(record.rawScore),
    saturationMultiplier: finiteOrUndefined(record.saturationMultiplier),
    evidenceMultiplier: finiteOrUndefined(record.evidenceMultiplier),
    contributions,
    rationale,
    kinetics: parseKinetics(record.kinetics),
  };
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Kinetics ride along inside the breakdown blob; nothing here trusts its shape. */
function parseKinetics(raw: unknown): Kinetics | null {
  if (!raw || typeof raw !== 'object') return null;
  const k = raw as Record<string, unknown>;
  if (typeof k.rateEstimable !== 'boolean') return null;
  return {
    rateEstimable: k.rateEstimable,
    n: finiteOrUndefined(k.n) ?? null,
    spanHours: finiteOrUndefined(k.spanHours) ?? null,
  };
}

function shortTime(t: number): string {
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const AXIS_STYLE = { fill: 'var(--color-ink-subtle)', fontSize: 11 } as const;

export function TrendDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const query = useApiQuery<TrendDetailResponse>(queryKeys.trend(id), `/api/trends/${encodeURIComponent(id)}`, {
    enabled: id.length > 0,
    refetchInterval: POLL.normal,
  });

  const trend = query.data?.trend;
  const observations = useMemo(() => query.data?.observations ?? [], [query.data]);
  const concepts = query.data?.concepts ?? [];
  const breakdown = useMemo(() => parseBreakdown(trend?.scoreBreakdown), [trend?.scoreBreakdown]);

  /** Pivot observations into one row per timestamp with a column per source. */
  const { series, chartData } = useMemo(() => {
    const sources = [...new Set(observations.map((o) => o.source))];
    const byTimestamp = new Map<number, Record<string, number>>();
    for (const o of observations) {
      if (!Number.isFinite(o.observedAt) || !Number.isFinite(o.normalisedValue)) continue;
      const row = byTimestamp.get(o.observedAt) ?? {};
      row[o.source] = o.normalisedValue;
      byTimestamp.set(o.observedAt, row);
    }
    const rows = [...byTimestamp.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, values]) => ({ t, ...values }));

    return {
      series: sources.map((source, i) => ({
        source,
        n: observations.filter((o) => o.source === source).length,
        ...seriesStyle(source, i),
      })),
      chartData: rows,
    };
  }, [observations]);

  const contributionData = useMemo(
    () =>
      (breakdown?.contributions ?? [])
        .slice()
        .sort((a, b) => b.contribution - a.contribution)
        .map((c) => ({ ...c, label: humanise(c.component) })),
    [breakdown],
  );

  if (query.isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-80 w-full" />
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

  if (!trend) {
    return (
      <Card>
        <EmptyState
          icon="◎"
          title="Trend not found"
          description="This trend may have been archived and pruned. Return to Opportunities to see what is currently tracked."
          action={
            <Link className="btn btn-ghost" to="/opportunities">
              Back to opportunities
            </Link>
          }
        />
      </Card>
    );
  }

  const observationCount = observations.length;
  const sparse = observationCount < 8;
  /**
   * When the scorer could not fit a growth rate, the stored velocity,
   * acceleration and consistency are placeholder zeros. `rateEstimable === true`
   * is the only state in which they are measurements; a missing breakdown means
   * we cannot tell, which is not the same as knowing they are good.
   */
  const rateEstimable = breakdown?.kinetics?.rateEstimable === true;
  const rateKnown = breakdown?.kinetics != null;
  /** The AI enrichment pass writes the summary and the memeability score together. */
  const enriched = trend.aiSummary !== null;
  /** Names the sample the rate was attempted on, when the API reports it. */
  const rateSample =
    breakdown?.kinetics?.n == null
      ? ''
      : `: ${formatNumber(breakdown.kinetics.n)} observation${breakdown.kinetics.n === 1 ? '' : 's'}${
          breakdown.kinetics.spanHours == null ? '' : ` spanning ${formatDuration(breakdown.kinetics.spanHours)}`
        }`;

  return (
    <div className="space-y-5">
      <div>
        <Link to="/opportunities" className="text-xs text-ink-subtle transition-colors hover:text-accent-soft">
          ← Opportunities
        </Link>
        <SectionHeader
          className="mt-2"
          title={trend.title}
          description={trend.summary ?? trend.aiSummary ?? 'No summary was captured for this trend.'}
        />
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <Badge tone={PHASE_TONE[trend.phase] ?? 'neutral'}>{humanise(trend.phase)}</Badge>
          <Badge>{humanise(trend.category)}</Badge>
          <Badge tone={trend.status === 'active' ? 'accent' : 'neutral'}>{humanise(trend.status)}</Badge>
          {(trend.keywords ?? []).slice(0, 8).map((k) => (
            <Badge key={k}>{k}</Badge>
          ))}
        </div>
      </div>

      {trend.injectionFlagged && (
        <Note tone="warning">
          <span aria-hidden="true">⚠</span> <strong>Injection flagged.</strong> Text from this trend&apos;s sources
          contained something resembling an instruction to a model. Everything below is rendered as inert data; the
          text was never used as a prompt.
        </Note>
      )}

      {sparse && (
        <Note tone="warning">
          Only {formatNumber(observationCount)} observations have been recorded for this trend. Velocity, acceleration
          and consistency are estimated from that sample and are not yet reliable.
        </Note>
      )}
      {trend.sourceCount < 2 && (
        <Note tone="warning">
          Seen on a single source. Cross-platform confirmation is the strongest anti-noise signal this platform has, so
          treat this trend as unconfirmed until a second independent source reports it.
        </Note>
      )}
      {rateKnown && !rateEstimable && (
        <Note tone="warning">
          <strong>Growth rate not measurable.</strong> The observation series is too short or spans too little time to
          fit a slope
          {rateSample}. Velocity, acceleration and consistency below are shown as unknown rather than as zero — this
          trend has not
          been observed going flat, it has not been observed for long enough to say anything at all. The score is held
          down until it can be told apart from a genuinely static topic.
        </Note>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Opportunity score"
          value={formatScore(trend.opportunityScore, 1)}
          tone="accent"
          hint={
            // The score is raw × saturation × evidence. Quoting only one of the
            // two multipliers gives a product that does not equal the number
            // above it, so both are named or neither is.
            breakdown?.rawScore !== undefined &&
            breakdown.saturationMultiplier !== undefined &&
            breakdown.evidenceMultiplier !== undefined
              ? `${formatScore(breakdown.rawScore, 1)} raw × ${formatPercent(
                  breakdown.saturationMultiplier,
                  0,
                )} saturation × ${formatPercent(breakdown.evidenceMultiplier, 0)} growth evidence`
              : `Raw score ${formatScore(trend.rawOpportunityScore, 1)} before the saturation and growth-evidence multipliers`
          }
        />
        <StatTile
          label="Saturation"
          value={formatPercent(trend.saturationScore, 0)}
          tone={trend.saturationScore > 0.66 ? 'negative' : trend.saturationScore > 0.33 ? 'warning' : 'positive'}
          hint="Share of this idea already tokenised on-chain. Higher is worse."
        />
        <StatTile
          label="Age"
          value={formatDuration(trend.ageHours)}
          hint={`First seen ${formatRelative(trend.firstSeenAt)}; last seen ${formatRelative(trend.lastSeenAt)}`}
        />
        <StatTile
          label="Runway left"
          value={formatDuration(trend.remainingLifespanHours)}
          hint="Estimated attention remaining before the trend is spent."
        />
      </div>

      <Card>
        <SectionHeader
          title="Cross-platform interest"
          description="Normalised interest per source over time. Independent sources rising together is the confirmation this platform trades on; a single line moving alone is noise until something else agrees."
        />

        {chartData.length === 0 ? (
          <EmptyState
            icon="▦"
            title="No observations recorded yet"
            description="This trend has been created but no source has reported a measurable value for it. The next discovery run will fill this in."
          />
        ) : (
          <>
            <div className="mt-4 h-72 w-full sm:h-80">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 24, left: 4 }}>
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
                    label={{ value: 'Observed at', position: 'insideBottom', offset: -14, fill: 'var(--color-ink-subtle)', fontSize: 11 }}
                  />
                  <YAxis
                    domain={[0, 1]}
                    tickFormatter={(v: number) => formatPercent(v, 0)}
                    tick={AXIS_STYLE}
                    stroke="var(--color-border-strong)"
                    width={44}
                    label={{
                      value: 'Normalised interest',
                      angle: -90,
                      position: 'insideLeft',
                      fill: 'var(--color-ink-subtle)',
                      fontSize: 11,
                      style: { textAnchor: 'middle' },
                    }}
                  />
                  <Tooltip content={<InterestTooltip />} cursor={{ stroke: 'var(--color-border-strong)' }} />
                  <Legend
                    verticalAlign="top"
                    align="left"
                    height={28}
                    formatter={(value: string) => (
                      <span style={{ color: 'var(--color-ink-muted)', fontSize: 12 }}>{humanise(value)}</span>
                    )}
                  />
                  {series.map((s) => (
                    <Line
                      key={s.source}
                      type="linear"
                      dataKey={s.source}
                      name={s.source}
                      stroke={s.colour}
                      strokeWidth={2}
                      strokeDasharray={s.dash}
                      // Sources report on different cadences, so almost every row
                      // is a null for every series but one. The dots mark the
                      // actual readings; the segments between them are drawn to
                      // make the series followable, not because anything was
                      // observed in the gap. Without the dots the interpolation
                      // would be indistinguishable from measured data.
                      dot={{ r: 1.8, strokeWidth: 0, fill: s.colour }}
                      activeDot={{ r: 4 }}
                      connectNulls
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>

            <p className="mt-3 text-xs leading-relaxed text-ink-subtle">
              Each dot is one recorded reading. Sources report on their own cadence, so the lines between dots are drawn
              to make a series followable — nothing was measured in those gaps.
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-subtle">
              <span>
                {formatNumber(series.length)} {series.length === 1 ? 'source' : 'independent sources'} ·{' '}
                {formatNumber(observationCount)} observations
              </span>
              {series.map((s) => (
                <span key={s.source} className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="inline-block h-0.5 w-4 rounded-full"
                    style={{ background: s.colour }}
                  />
                  {humanise(s.source)} <SampleSize n={s.n} minimum={4} />
                </span>
              ))}
            </div>
          </>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="min-w-0">
          <SectionHeader
            title="Why this scored as it did"
            description="Each component's contribution to the score's logit, before saturation is applied. Positive bars push the score up; negative bars pull it down."
          />
          {contributionData.length === 0 ? (
            <EmptyState
              title="No score breakdown recorded"
              description="This trend has not been through a scoring pass yet, so there is nothing to explain. It will appear after the next scoring run."
            />
          ) : (
            <>
              <div className="mt-4 w-full" style={{ height: Math.max(220, contributionData.length * 30) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={contributionData}
                    layout="vertical"
                    margin={{ top: 4, right: 16, bottom: 24, left: 8 }}
                    barCategoryGap="22%"
                  >
                    <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" horizontal={false} />
                    <XAxis
                      type="number"
                      tick={AXIS_STYLE}
                      stroke="var(--color-border-strong)"
                      tickFormatter={(v: number) => formatScore(v, 2)}
                      label={{
                        value: 'Contribution to score logit',
                        position: 'insideBottom',
                        offset: -14,
                        fill: 'var(--color-ink-subtle)',
                        fontSize: 11,
                      }}
                    />
                    <YAxis
                      type="category"
                      dataKey="label"
                      tick={AXIS_STYLE}
                      stroke="var(--color-border-strong)"
                      width={96}
                    />
                    <ReferenceLine x={0} stroke="var(--color-border-strong)" />
                    <Tooltip content={<ContributionTooltip />} cursor={{ fill: 'var(--color-surface-hover)' }} />
                    <Bar dataKey="contribution" radius={[0, 4, 4, 0]} isAnimationActive={false}>
                      {contributionData.map((c) => (
                        <Cell
                          key={c.component}
                          fill={c.contribution >= 0 ? 'var(--color-accent)' : 'var(--color-negative)'}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <ul className="mt-3 space-y-1.5">
                {contributionData.map((c) => (
                  <li key={c.component} className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="text-ink-muted">
                      {c.label}
                      <span className="ml-1.5 text-ink-subtle">{COMPONENT_HELP[c.component] ?? ''}</span>
                    </span>
                    <span className="tnum shrink-0 text-ink-subtle">
                      {formatPercent(c.value, 0)} × {formatScore(c.weight, 2)} ={' '}
                      <span className={c.contribution >= 0 ? 'text-accent-soft' : 'text-negative'}>
                        {c.contribution >= 0 ? '+' : ''}
                        {formatScore(c.contribution, 2)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>

              {/*
                The bars explain the logit only. Two multipliers are applied after
                it, and they routinely move the score more than any single
                component does — leaving them out of this card would make the
                chart look like the whole explanation when it is roughly half.
              */}
              {breakdown?.rawScore !== undefined && (
                <dl className="mt-4 space-y-1.5 border-t border-border pt-3 text-xs">
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-ink-muted">Raw score from the components above</dt>
                    <dd className="tnum text-ink">{formatScore(breakdown.rawScore, 1)}</dd>
                  </div>
                  {breakdown.saturationMultiplier !== undefined && (
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="text-ink-muted">× saturation multiplier (how much is already tokenised)</dt>
                      <dd className="tnum text-ink">{formatPercent(breakdown.saturationMultiplier, 0)}</dd>
                    </div>
                  )}
                  {breakdown.evidenceMultiplier !== undefined && (
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="text-ink-muted">× growth-evidence multiplier (is attention measurably rising)</dt>
                      <dd className="tnum text-ink">{formatPercent(breakdown.evidenceMultiplier, 0)}</dd>
                    </div>
                  )}
                  <div className="flex items-baseline justify-between gap-3 border-t border-border/60 pt-1.5">
                    <dt className="font-medium text-ink">Final opportunity score</dt>
                    <dd className="tnum font-semibold text-ink">{formatScore(trend.opportunityScore, 1)}</dd>
                  </div>
                </dl>
              )}

              {breakdown && breakdown.rationale.length > 0 && (
                <div className="mt-4 space-y-1.5 border-t border-border pt-3">
                  {breakdown.rationale.map((line) => (
                    <p key={line} className="text-sm leading-relaxed text-ink-muted">
                      {line}
                    </p>
                  ))}
                </div>
              )}
            </>
          )}
        </Card>

        <Card className="min-w-0">
          <SectionHeader
            title="Kinetics"
            description="The raw movement measurements the score is built from. Each is measured directly from the observation series above."
          />
          <dl className="mt-4 space-y-3">
            <Kinetic
              term="Velocity"
              value={rateEstimable ? `${formatPercent(trend.velocity, 2)}/h` : 'Not measurable'}
              unknown={!rateEstimable}
              tone={trend.velocity > 0 ? 'positive' : trend.velocity < 0 ? 'negative' : 'neutral'}
              explanation="Fractional growth per hour. +10%/h is roughly a tripling over a day."
            />
            <Kinetic
              term="Acceleration"
              value={rateEstimable ? formatPercent(trend.acceleration, 2) : 'Not measurable'}
              unknown={!rateEstimable}
              tone={trend.acceleration > 0 ? 'positive' : trend.acceleration < 0 ? 'warning' : 'neutral'}
              explanation="Change in velocity. Positive means still speeding up; negative means the wave is already breaking."
            />
            <Kinetic
              term="Consistency"
              value={rateEstimable ? formatPercent(trend.consistency, 0) : 'Not measurable'}
              unknown={!rateEstimable}
              bar={rateEstimable ? trend.consistency : undefined}
              explanation="How steadily interest climbs rather than arriving as one spike. Spikes are usually bots or a single viral post."
            />
            <Kinetic
              term="Novelty"
              value={formatPercent(trend.novelty, 0)}
              bar={trend.novelty}
              explanation="Distance from every other trend currently tracked. Low novelty means the idea is a variation on something already being tokenised."
            />
            <Kinetic
              term="Audience"
              value={formatCompact(trend.audienceEstimate)}
              explanation="Largest audience any single source estimated for this trend. An estimate from platform-reported reach, not a measured count."
            />
            <Kinetic
              term="Engagement"
              value={formatPercent(trend.engagement, 0)}
              bar={trend.engagement}
              explanation="Interaction intensity per unit of reach, where the source reports enough to derive it."
            />
            <Kinetic
              term="Memeability"
              // Memeability is only ever written by the AI enrichment pass, which
              // writes the summary in the same call. No summary means no pass has
              // run, so the stored 0 is an unset default rather than a verdict of
              // "not memeable" — and must not be dressed up as a model judgement.
              value={enriched ? formatPercent(trend.memeability, 0) : 'Not assessed'}
              unknown={!enriched}
              bar={enriched ? trend.memeability : undefined}
              explanation={
                enriched
                  ? 'Model-assessed ease of turning the idea into a name and an image. A judgement, not a measurement.'
                  : 'No AI enrichment pass has run for this trend, so no model has judged it. The score was computed with this component at zero.'
              }
            />
          </dl>
          <div className="mt-4 border-t border-border pt-3">
            <SampleSize n={observationCount} minimum={8} />
            <span className="ml-2 text-xs text-ink-subtle">observations behind these figures</span>
          </div>
        </Card>
      </div>

      <Card padded={false}>
        <div className="px-4 pt-4 sm:px-5">
          <SectionHeader
            title="Source observations"
            description="Every raw reading behind the chart. Excerpts are untrusted text captured from third-party sources and are shown verbatim as plain text."
          />
        </div>
        <div className="px-4 py-4 sm:px-5">
          {observations.length === 0 ? (
            <EmptyState
              title="No observations yet"
              description="Nothing has been recorded against this trend. Trigger a discovery run from the Opportunities page, or wait for the scheduled run."
            />
          ) : (
            <DataTable>
              <thead>
                <tr>
                  <Th>Source</Th>
                  <Th>Observed</Th>
                  <Th align="right">Raw value</Th>
                  <Th align="right">Normalised</Th>
                  <Th>Excerpt</Th>
                  <Th>Link</Th>
                </tr>
              </thead>
              <tbody>
                {observations.slice(0, 200).map((o, i) => (
                  <tr key={`${o.source}-${o.observedAt}-${i}`} className="transition-colors hover:bg-surface-hover/60">
                    <Td>
                      <Badge tone="info">{humanise(o.source)}</Badge>
                    </Td>
                    <Td className="whitespace-nowrap">
                      <div className="text-ink-muted">{formatDateTime(o.observedAt)}</div>
                      <div className="text-xs text-ink-subtle">{formatRelative(o.observedAt)}</div>
                    </Td>
                    <Td align="right" className="tnum whitespace-nowrap">
                      {formatCompact(o.rawValue)}
                    </Td>
                    <Td align="right" className="tnum min-w-[6rem]">
                      {formatPercent(o.normalisedValue, 0)}
                      <ScoreBar value={o.normalisedValue} className="mt-1.5" />
                    </Td>
                    <Td className="min-w-[18rem] max-w-[28rem]">
                      <span className="line-clamp-3 text-xs leading-relaxed text-ink-muted">{o.excerpt ?? '—'}</span>
                    </Td>
                    <Td>
                      {o.url ? (
                        <a
                          className="text-xs text-accent-soft hover:underline"
                          href={o.url}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          Open <span aria-hidden="true">↗</span>
                        </a>
                      ) : (
                        <span className="text-xs text-ink-subtle">—</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
          {observations.length > 200 && (
            <p className="mt-3 text-xs text-ink-subtle">
              Showing the 200 most recent of {formatNumber(observations.length)} observations.
            </p>
          )}
        </div>
      </Card>

      <Card padded={false}>
        <div className="px-4 pt-4 sm:px-5">
          <SectionHeader
            title="Concepts from this trend"
            description="Token concepts the generator produced from this trend, and what happened to each."
          />
        </div>
        <div className="px-4 py-4 sm:px-5">
          {concepts.length === 0 ? (
            <EmptyState
              title="No concepts generated yet"
              description="Concepts are only generated for trends clearing the generation threshold. If this trend clears it, the next generation run will produce candidates here."
            />
          ) : (
            <DataTable>
              <thead>
                <tr>
                  <Th>Concept</Th>
                  <Th>Status</Th>
                  <Th align="right">Opportunity</Th>
                  <Th align="right">Originality</Th>
                  <Th align="right">Saturation</Th>
                  <Th align="right">AI panel</Th>
                  <Th>Created</Th>
                  <Th>Outcome</Th>
                </tr>
              </thead>
              <tbody>
                {concepts.map((c) => (
                  <tr key={c.id} className="transition-colors hover:bg-surface-hover/60">
                    <Td>
                      <Link to={`/candidates/${c.id}`} className="text-sm font-medium text-ink hover:text-accent-soft">
                        {c.name ?? 'Unnamed concept'}
                      </Link>
                      {c.symbol && <span className="ml-2 text-xs text-ink-subtle">${c.symbol}</span>}
                    </Td>
                    <Td>
                      <Badge tone={CONCEPT_TONE[c.status] ?? 'neutral'}>{humanise(c.status)}</Badge>
                    </Td>
                    <Td align="right" className="tnum">
                      {formatScore(c.opportunity_score, 1)}
                    </Td>
                    <Td align="right" className="tnum">
                      {c.originality_score === null ? '—' : formatPercent(c.originality_score, 0)}
                    </Td>
                    <Td align="right" className="tnum">
                      {c.saturation_score === null ? '—' : formatPercent(c.saturation_score, 0)}
                    </Td>
                    <Td align="right" className="tnum">
                      {formatScore(c.ai_panel_score, 1)}
                    </Td>
                    <Td className="whitespace-nowrap text-xs">{formatDateTime(c.created_at)}</Td>
                    <Td className="min-w-[16rem] max-w-[24rem]">
                      {c.rejection_reason ? (
                        <div className="text-xs leading-relaxed">
                          <span className="font-medium text-negative">
                            <span aria-hidden="true">✕</span> {humanise(c.rejection_reason)}
                          </span>
                          {c.rejection_detail && <div className="mt-0.5 text-ink-subtle">{c.rejection_detail}</div>}
                        </div>
                      ) : (
                        <span className="text-xs text-ink-subtle">—</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </div>
      </Card>
    </div>
  );
}

function Kinetic({
  term,
  value,
  explanation,
  bar,
  tone = 'neutral',
  unknown = false,
}: {
  term: string;
  value: string;
  explanation: string;
  bar?: number;
  tone?: Tone;
  /** The figure could not be measured. Suppresses the value tone so an unknown never reads as a good or bad reading. */
  unknown?: boolean;
}) {
  return (
    <div className="border-b border-border/60 pb-3 last:border-b-0 last:pb-0">
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-sm font-medium text-ink">{term}</dt>
        <dd
          className={
            'tnum text-sm font-semibold ' +
            (unknown
              ? 'text-warning'
              : tone === 'positive'
                ? 'text-positive'
                : tone === 'negative'
                  ? 'text-negative'
                  : tone === 'warning'
                    ? 'text-warning'
                    : 'text-ink')
          }
        >
          {value}
        </dd>
      </div>
      {bar !== undefined && <ScoreBar value={bar} className="mt-1.5" />}
      <p className="mt-1 text-xs leading-relaxed text-ink-subtle">{explanation}</p>
    </div>
  );
}

interface TooltipPayloadItem {
  name?: string | number;
  value?: string | number | Array<string | number>;
  color?: string;
  payload?: Record<string, unknown>;
}

function InterestTooltip({
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
          <li key={String(item.name)} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block h-0.5 w-3 rounded-full"
              style={{ background: item.color }}
            />
            <span className="text-ink-muted">{humanise(String(item.name ?? ''))}</span>
            <span className="tnum ml-auto text-ink">
              {typeof item.value === 'number' ? formatPercent(item.value, 1) : '—'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ContributionTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayloadItem[] }) {
  const first = payload?.[0]?.payload as Contribution | undefined;
  if (!active || !first) return null;
  return (
    <div className="card-raised max-w-xs px-3 py-2 text-xs shadow-lg">
      <div className="font-medium text-ink">{humanise(first.component)}</div>
      <div className="tnum mt-1 text-ink-muted">
        value {formatPercent(first.value, 0)} × weight {formatScore(first.weight, 2)} ={' '}
        <span className={first.contribution >= 0 ? 'text-accent-soft' : 'text-negative'}>
          {first.contribution >= 0 ? '+' : ''}
          {formatScore(first.contribution, 2)}
        </span>
      </div>
      {COMPONENT_HELP[first.component] && (
        <p className="mt-1 leading-relaxed text-ink-subtle">{COMPONENT_HELP[first.component]}</p>
      )}
    </div>
  );
}

export default TrendDetailPage;
