import {
  SOURCE_INDEPENDENCE,
  classifyPhase,
  clamp,
  computeKinetics,
  estimateRemainingLifespanHours,
  localEmbed,
  logScale01,
  nameConfusability,
  packEmbedding,
  scoreOpportunity,
  slugify,
  unpackEmbedding,
  type TimePoint,
  type TrendCategory,
  type TrendSourceId,
  detectInjection,
  sanitiseExternalText,
} from '@solcoin/shared';
import { newId } from '../core/ids.js';
import { componentLogger } from '../core/logger.js';
import { parseJson } from '../core/json.js';
import type { Db } from '../db/client.js';
import type { EventBus } from '../core/events.js';
import type { RawTrendSignal } from '../providers/types.js';

/**
 * Trend identity, storage and scoring.
 *
 * The hard problem this service solves is **identity**: the same cultural
 * moment shows up as a Google Trends query, a Bluesky topic, a Wikipedia
 * article and a news cluster, with four different names. Treating those as four
 * trends destroys the single most valuable signal the platform has — how many
 * independent populations are talking about the thing.
 *
 * Matching is deliberately layered, cheapest first:
 *   1. exact slug match,
 *   2. high name confusability (handles "Labubu" / "labubu dolls"),
 *   3. lexical embedding cosine above a threshold.
 *
 * Cross-source confirmation is then weighted by *source family*, so two
 * Fediverse instances do not count as two independent confirmations while
 * search demand plus news coverage plus encyclopaedia lookups do.
 */

const MATCH_NAME_THRESHOLD = 0.78;
const MATCH_EMBEDDING_THRESHOLD = 0.72;

export interface IngestResult {
  created: number;
  updated: number;
  observations: number;
  quarantined: number;
  trendIds: string[];
}

export interface ScoredTrend {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  category: TrendCategory;
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
  sources: string[];
  keywords: string[];
  scoreBreakdown: unknown;
  aiSummary: string | null;
  injectionFlagged: boolean;
}

export class TrendService {
  private readonly log = componentLogger('trends');

  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Ingest raw signals, resolving each to an existing trend or creating one.
   *
   * Signals whose text trips the injection detector are counted and dropped
   * before they can reach a model. This is the boundary where untrusted
   * internet content enters the system, so it is where the filter belongs.
   */
  async ingest(signals: readonly RawTrendSignal[]): Promise<IngestResult> {
    const result: IngestResult = { created: 0, updated: 0, observations: 0, quarantined: 0, trendIds: [] };
    if (signals.length === 0) return result;

    const candidates = await this.loadMatchCandidates();

    for (const signal of signals) {
      const title = sanitiseExternalText(signal.title, 200).trim();
      if (!title) continue;

      const summary = signal.summary ? sanitiseExternalText(signal.summary, 600) : null;
      const injection = detectInjection(`${title}\n${summary ?? ''}`);
      if (injection.quarantine) {
        result.quarantined++;
        this.log.warn(
          { source: signal.source, score: injection.score, labels: injection.matches.map((m) => m.label) },
          'dropped a trend signal that looked like a prompt-injection attempt',
        );
        continue;
      }

      const embedding = localEmbed(`${title} ${summary ?? ''}`);
      const match = this.findMatch(title, embedding, candidates);

      let trendId: string;
      if (match) {
        trendId = match.id;
        result.updated++;
      } else {
        trendId = newId('trd', this.now());
        const slug = await this.uniqueSlug(title);
        this.db.$raw
          .prepare(
            `INSERT INTO trends (id, slug, title, summary, category, status, phase, embedding, embedding_model,
                                 keywords, first_seen_at, last_seen_at, injection_flagged, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            trendId,
            slug,
            title,
            summary,
            signal.category ?? 'other',
            'active',
            'nascent',
            packEmbedding(embedding),
            'local-hash-v1',
            JSON.stringify(signal.keywords ?? deriveKeywords(title)),
            signal.observedAt,
            signal.observedAt,
            injection.score > 0.2 ? 1 : 0,
            this.now(),
            this.now(),
          );
        candidates.push({ id: trendId, title, slug, embedding });
        result.created++;
        this.events.emit('trend.discovered', { trendId, title, opportunityScore: 0 });
      }

      result.trendIds.push(trendId);
      result.observations += this.recordObservations(trendId, signal, summary);

      this.db.$raw
        .prepare('UPDATE trends SET last_seen_at = MAX(last_seen_at, ?), updated_at = ? WHERE id = ?')
        .run(signal.observedAt, this.now(), trendId);
    }

    return result;
  }

  /**
   * Store the observation, plus any history the source shipped with it.
   *
   * Sources like Mastodon return seven days of daily counts in a single
   * response. Backfilling that history means a trend discovered a minute ago can
   * still have a meaningful velocity estimate immediately, instead of waiting
   * hours to accumulate points.
   */
  private recordObservations(trendId: string, signal: RawTrendSignal, summary: string | null): number {
    const insert = this.db.$raw.prepare(
      `INSERT INTO trend_observations
         (id, trend_id, source, observed_at, raw_value, normalised_value, rank, engagement, audience,
          excerpt, url, external_id, metadata, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(trend_id, source, external_id) DO UPDATE SET
         raw_value = excluded.raw_value,
         normalised_value = excluded.normalised_value,
         rank = excluded.rank,
         engagement = excluded.engagement,
         observed_at = excluded.observed_at`,
    );

    let count = 0;
    const normalised = logScale01(signal.rawValue, sourceScaleReference(signal.source));

    insert.run(
      newId('tob', signal.observedAt),
      trendId,
      signal.source,
      signal.observedAt,
      signal.rawValue,
      normalised,
      signal.rank ?? null,
      signal.engagement ?? null,
      signal.audience ?? null,
      summary,
      signal.url ? sanitiseExternalText(signal.url, 500) : null,
      signal.externalId,
      signal.metadata ? JSON.stringify(signal.metadata).slice(0, 4000) : null,
      this.now(),
    );
    count++;

    for (const point of signal.history ?? []) {
      if (!Number.isFinite(point.t) || !Number.isFinite(point.v)) continue;
      // History points get a synthetic external id so the unique index dedupes
      // them across repeated polls of the same seven-day window.
      insert.run(
        newId('tob', point.t),
        trendId,
        signal.source,
        point.t,
        point.v,
        logScale01(point.v, sourceScaleReference(signal.source)),
        null,
        null,
        null,
        null,
        null,
        `${signal.externalId}#h${point.t}`,
        null,
        this.now(),
      );
      count++;
    }

    // Also record the first-seen time if this history predates it.
    const earliest = Math.min(signal.observedAt, ...(signal.history ?? []).map((h) => h.t));
    if (Number.isFinite(earliest)) {
      this.db.$raw.prepare('UPDATE trends SET first_seen_at = MIN(first_seen_at, ?) WHERE id = ?').run(earliest, trendId);
    }

    return count;
  }

  /**
   * Recompute kinetics and opportunity scores for the active trend set.
   *
   * `saturationBySlug` is supplied by the market layer; when it is absent a
   * trend keeps its previous saturation rather than being scored as if the
   * space were empty, which would systematically overstate opportunity.
   */
  async rescoreAll(options: {
    saturationByTrendId?: Map<string, number>;
    memeabilityByTrendId?: Map<string, number>;
    limit?: number;
  } = {}): Promise<{ scored: number; topScore: number }> {
    const rows = this.db.$raw
      .prepare(
        `SELECT * FROM trends WHERE status IN ('active','watch') ORDER BY last_seen_at DESC LIMIT ?`,
      )
      .all(options.limit ?? 600) as Array<Record<string, unknown>>;

    if (rows.length === 0) return { scored: 0, topScore: 0 };

    const noveltyBaseline = this.buildNoveltyBaseline(rows);
    let topScore = 0;

    for (const row of rows) {
      const trendId = String(row.id);
      const observations = this.db.$raw
        .prepare(
          `SELECT source, observed_at, raw_value, normalised_value, engagement, audience
             FROM trend_observations WHERE trend_id = ? ORDER BY observed_at ASC LIMIT 2000`,
        )
        .all(trendId) as Array<{
        source: string;
        observed_at: number;
        raw_value: number;
        normalised_value: number;
        engagement: number | null;
        audience: number | null;
      }>;

      if (observations.length === 0) continue;

      // Score on the normalised series so a source with huge raw numbers does
      // not dominate one with small numbers but faster growth.
      const series: TimePoint[] = observations.map((o) => ({ t: o.observed_at, v: o.normalised_value * 1000 }));
      const kinetics = computeKinetics(series);

      const firstSeenAt = Number(row.first_seen_at);
      const ageHours = Math.max(0, (this.now() - firstSeenAt) / 3_600_000);
      const phase = classifyPhase(kinetics, ageHours);
      const remainingLifespanHours = estimateRemainingLifespanHours(kinetics, ageHours, phase);

      const sourcesSeen = [...new Set(observations.map((o) => o.source))] as TrendSourceId[];
      const sourceDiversity = computeSourceDiversity(sourcesSeen);

      const audienceEstimate = Math.max(...observations.map((o) => o.audience ?? 0), 0);
      const engagement = clamp(
        observations.reduce((acc, o) => Math.max(acc, o.engagement ?? 0), 0),
        0,
        1,
      );

      const embedding = row.embedding ? unpackEmbedding(String(row.embedding)) : localEmbed(String(row.title));
      const novelty = noveltyBaseline(trendId, embedding);
      const saturation = options.saturationByTrendId?.get(trendId) ?? numericColumn(row.saturation_score);
      const memeability = options.memeabilityByTrendId?.get(trendId) ?? numericColumn(row.memeability);

      const scored = scoreOpportunity({
        kinetics,
        phase,
        ageHours,
        remainingLifespanHours,
        sourceCount: sourcesSeen.length,
        sourceDiversity,
        audienceEstimate,
        novelty,
        saturation,
        engagement,
        memeability,
      });

      const previousScore = Number(row.opportunity_score ?? 0);
      topScore = Math.max(topScore, scored.score);

      this.db.$raw
        .prepare(
          `UPDATE trends SET
             phase = ?, opportunity_score = ?, raw_opportunity_score = ?, saturation_score = ?,
             velocity = ?, acceleration = ?, consistency = ?, novelty = ?, audience_estimate = ?,
             source_count = ?, engagement = ?, memeability = ?, remaining_lifespan_hours = ?,
             score_breakdown = ?, scored_at = ?, updated_at = ?,
             status = CASE WHEN ? < 0.005 AND ? > 168 THEN 'archived' ELSE status END
           WHERE id = ?`,
        )
        .run(
          phase,
          scored.score,
          scored.rawScore,
          saturation,
          kinetics.relativeVelocity,
          kinetics.acceleration,
          kinetics.consistency,
          novelty,
          audienceEstimate,
          sourcesSeen.length,
          engagement,
          memeability,
          remainingLifespanHours,
          JSON.stringify({ ...scored, kinetics, sources: sourcesSeen }),
          this.now(),
          this.now(),
          kinetics.relativeVelocity,
          ageHours,
          trendId,
        );

      if (Math.abs(scored.score - previousScore) > 5) {
        this.events.emit('trend.scored', { trendId, opportunityScore: scored.score, previousScore });
      }
    }

    return { scored: rows.length, topScore };
  }

  /**
   * Novelty: how different is this trend from everything else currently active?
   *
   * A trend that looks like fifty others is not a new cultural moment, it is a
   * variation on a theme that is already being tokenised.
   */
  private buildNoveltyBaseline(rows: Array<Record<string, unknown>>): (id: string, embedding: number[]) => number {
    const vectors = rows
      .filter((r) => r.embedding)
      .map((r) => ({ id: String(r.id), vec: unpackEmbedding(String(r.embedding)) }));

    return (id: string, embedding: number[]) => {
      let maxSim = 0;
      for (const other of vectors) {
        if (other.id === id) continue;
        let dot = 0;
        const n = Math.min(embedding.length, other.vec.length);
        for (let i = 0; i < n; i++) dot += embedding[i]! * other.vec[i]!;
        if (dot > maxSim) maxSim = dot;
      }
      return clamp(1 - maxSim, 0, 1);
    };
  }

  async listTop(options: { limit?: number; minScore?: number; status?: string } = {}): Promise<ScoredTrend[]> {
    const rows = this.db.$raw
      .prepare(
        `SELECT * FROM trends
          WHERE status = COALESCE(?, status) AND opportunity_score >= ?
          ORDER BY opportunity_score DESC, last_seen_at DESC
          LIMIT ?`,
      )
      .all(options.status ?? null, options.minScore ?? 0, options.limit ?? 50) as Array<Record<string, unknown>>;
    return rows.map((r) => this.toScoredTrend(r));
  }

  async getById(id: string): Promise<ScoredTrend | null> {
    const row = this.db.$raw.prepare('SELECT * FROM trends WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.toScoredTrend(row) : null;
  }

  async getObservations(trendId: string, limit = 500): Promise<
    Array<{ source: string; observedAt: number; rawValue: number; normalisedValue: number; url: string | null; excerpt: string | null }>
  > {
    const rows = this.db.$raw
      .prepare(
        `SELECT source, observed_at, raw_value, normalised_value, url, excerpt
           FROM trend_observations WHERE trend_id = ? ORDER BY observed_at DESC LIMIT ?`,
      )
      .all(trendId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      source: String(r.source),
      observedAt: Number(r.observed_at),
      rawValue: Number(r.raw_value),
      normalisedValue: Number(r.normalised_value),
      url: (r.url as string | null) ?? null,
      excerpt: (r.excerpt as string | null) ?? null,
    }));
  }

  setSaturation(trendId: string, saturation: number): void {
    this.db.$raw
      .prepare('UPDATE trends SET saturation_score = ?, updated_at = ? WHERE id = ?')
      .run(clamp(saturation, 0, 1), this.now(), trendId);
  }

  setAiEnrichment(trendId: string, summary: string, memeability: number, category: TrendCategory, keywords: string[]): void {
    this.db.$raw
      .prepare('UPDATE trends SET ai_summary = ?, memeability = ?, category = ?, keywords = ?, updated_at = ? WHERE id = ?')
      .run(summary.slice(0, 4000), clamp(memeability, 0, 1), category, JSON.stringify(keywords.slice(0, 20)), this.now(), trendId);
  }

  /**
   * Retire trends that have gone quiet, and prune their observations.
   *
   * Without this the observation table grows without bound and the novelty
   * baseline is computed against a corpus of dead trends.
   */
  async prune(options: { archiveAfterQuietHours?: number; deleteObservationsOlderThanDays?: number } = {}): Promise<{
    archived: number;
    observationsDeleted: number;
  }> {
    const quietCutoff = this.now() - (options.archiveAfterQuietHours ?? 168) * 3_600_000;
    const archived = this.db.$raw
      .prepare(`UPDATE trends SET status = 'archived', updated_at = ? WHERE status IN ('active','watch') AND last_seen_at < ?`)
      .run(this.now(), quietCutoff).changes;

    const obsCutoff = this.now() - (options.deleteObservationsOlderThanDays ?? 90) * 86_400_000;
    const observationsDeleted = this.db.$raw
      .prepare(
        `DELETE FROM trend_observations
          WHERE observed_at < ?
            AND trend_id IN (SELECT id FROM trends WHERE status = 'archived')`,
      )
      .run(obsCutoff).changes;

    return { archived, observationsDeleted };
  }

  private toScoredTrend(row: Record<string, unknown>): ScoredTrend {
    const breakdown = parseJson<{ sources?: string[] }>(row.score_breakdown as string | null, {});
    return {
      id: String(row.id),
      slug: String(row.slug),
      title: String(row.title),
      summary: (row.summary as string | null) ?? null,
      category: String(row.category) as TrendCategory,
      phase: String(row.phase),
      status: String(row.status),
      opportunityScore: Number(row.opportunity_score ?? 0),
      rawOpportunityScore: Number(row.raw_opportunity_score ?? 0),
      saturationScore: Number(row.saturation_score ?? 0),
      velocity: Number(row.velocity ?? 0),
      acceleration: Number(row.acceleration ?? 0),
      consistency: Number(row.consistency ?? 0),
      novelty: Number(row.novelty ?? 0),
      audienceEstimate: Number(row.audience_estimate ?? 0),
      engagement: Number(row.engagement ?? 0),
      memeability: Number(row.memeability ?? 0),
      sourceCount: Number(row.source_count ?? 0),
      remainingLifespanHours: Number(row.remaining_lifespan_hours ?? 0),
      ageHours: Math.max(0, (this.now() - Number(row.first_seen_at)) / 3_600_000),
      firstSeenAt: Number(row.first_seen_at),
      lastSeenAt: Number(row.last_seen_at),
      sources: breakdown.sources ?? [],
      keywords: parseJson<string[]>(row.keywords as string | null, []),
      scoreBreakdown: breakdown,
      aiSummary: (row.ai_summary as string | null) ?? null,
      injectionFlagged: Boolean(row.injection_flagged),
    };
  }

  private async loadMatchCandidates(): Promise<Array<{ id: string; title: string; slug: string; embedding: number[] }>> {
    // Only recent, live trends are matching candidates: re-activating a trend
    // from three months ago because a word matched would corrupt its kinetics.
    const cutoff = this.now() - 14 * 86_400_000;
    const rows = this.db.$raw
      .prepare(
        `SELECT id, title, slug, embedding FROM trends
          WHERE status IN ('active','watch') AND last_seen_at >= ?
          ORDER BY last_seen_at DESC LIMIT 1500`,
      )
      .all(cutoff) as Array<{ id: string; title: string; slug: string; embedding: string | null }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      slug: r.slug,
      embedding: r.embedding ? unpackEmbedding(r.embedding) : localEmbed(r.title),
    }));
  }

  private findMatch(
    title: string,
    embedding: number[],
    candidates: Array<{ id: string; title: string; slug: string; embedding: number[] }>,
  ): { id: string } | null {
    const slug = slugify(title);
    let best: { id: string; score: number } | null = null;

    for (const candidate of candidates) {
      if (candidate.slug === slug) return { id: candidate.id };

      const nameScore = nameConfusability(title, candidate.title);
      if (nameScore >= MATCH_NAME_THRESHOLD) {
        if (!best || nameScore > best.score) best = { id: candidate.id, score: nameScore };
        continue;
      }

      let dot = 0;
      const n = Math.min(embedding.length, candidate.embedding.length);
      for (let i = 0; i < n; i++) dot += embedding[i]! * candidate.embedding[i]!;
      if (dot >= MATCH_EMBEDDING_THRESHOLD && (!best || dot > best.score)) {
        best = { id: candidate.id, score: dot };
      }
    }

    return best ? { id: best.id } : null;
  }

  private async uniqueSlug(title: string): Promise<string> {
    const base = slugify(title);
    for (let i = 0; i < 50; i++) {
      const candidate = i === 0 ? base : `${base}-${i}`;
      const existing = this.db.$raw.prepare('SELECT 1 FROM trends WHERE slug = ?').get(candidate);
      if (!existing) return candidate;
    }
    return `${base}-${newId().slice(0, 8).toLowerCase()}`;
  }
}

/**
 * Reference magnitudes used to normalise each source onto a common 0..1 scale.
 *
 * These are order-of-magnitude anchors for "this is a big number for this
 * platform", not precise calibrations: 100,000 Bluesky posts and 5,000,000
 * Wikipedia pageviews are both roughly "very large" for their source.
 */
/**
 * SQLite hands back whatever was written, so a numeric column can arrive as a
 * string, as null, or as text that does not parse. `Number(x) ?? 0` does not
 * catch that last case — NaN is not nullish — and a NaN would propagate
 * silently into a score. Anything that is not a finite number reads as zero.
 */
function numericColumn(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sourceScaleReference(source: TrendSourceId): number {
  switch (source) {
    case 'google_trends':
      return 1_000_000;
    case 'wikipedia':
      return 2_000_000;
    case 'bluesky':
      return 100_000;
    case 'mastodon':
      return 5_000;
    case 'x':
      return 500_000;
    case 'reddit':
      return 2_000;
    case 'hackernews':
      return 200;
    case 'youtube':
      return 5_000_000;
    case 'gdelt':
      return 5;
    case 'stackexchange':
      return 500;
    case 'rss':
      return 1;
    default:
      return 1_000;
  }
}

/**
 * Independence-weighted diversity across source families.
 *
 * Two sources in the same family (two Fediverse instances, two forums) are
 * highly correlated, so the second one adds little. The measure saturates: the
 * jump from one family to two is large, from four to five it is small.
 */
export function computeSourceDiversity(sources: readonly TrendSourceId[]): number {
  const families = new Map<string, number>();
  for (const source of sources) {
    const meta = SOURCE_INDEPENDENCE[source];
    if (!meta) continue;
    families.set(meta.family, Math.max(families.get(meta.family) ?? 0, meta.weight));
  }
  const total = [...families.values()].reduce((a, b) => a + b, 0);
  return clamp(total / (total + 1.8), 0, 1);
}

function deriveKeywords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 8);
}
