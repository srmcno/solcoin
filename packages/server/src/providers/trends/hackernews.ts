import { clamp, contentTokens, sanitiseExternalText } from '@solcoin/shared';
import type { HealthState, TrendCategory, TrendSourceId } from '@solcoin/shared';
import { systemClock, type Clock } from '../../core/clock.js';
import { safeErrorText } from '../../core/errors.js';
import { componentLogger } from '../../core/logger.js';
import { HttpClient } from '../http.js';
import type { ProviderStatus, RawTrendSignal, TrendProvider } from '../types.js';

/**
 * Hacker News. Zero authentication required.
 *
 * HN is the platform's earliest *leading* indicator for anything technical. A
 * subject that will be on tech Twitter in a week and in the general press in a
 * month is usually on the HN front page today. Its population is small and
 * heavily skewed (SOURCE_INDEPENDENCE weights it 0.6, in the same 'forum'
 * family as Reddit), so it is a discovery source rather than a confirmation
 * source: it tells us where to point Wikipedia, GDELT and search-demand checks.
 *
 * Two transports exist and only one is worth using by default:
 *
 *   - **Algolia** (`hn.algolia.com/api/v1`) serves the whole front page, with
 *     points and comment counts, in a single request, and supports numeric
 *     filters so we can ask directly for "recent stories above N points".
 *   - **Firebase** (`hacker-news.firebaseio.com/v0`) is the canonical source of
 *     truth but is one request per item: `topstories.json` returns ~500 bare
 *     ids and every field then costs another round trip.
 *
 * Algolia is therefore the primary path and Firebase is a fallback used only
 * when Algolia is unreachable, bounded to a small number of items so a degraded
 * run cannot eat the scheduler's whole HTTP budget.
 *
 * ## Why points are not the signal
 *
 * The headline number on HN is cumulative and monotonic, so it measures how
 * long a story has been up at least as much as how interesting it is. A
 * 200-point story submitted 20 hours ago is cooling: it accumulated those
 * points hours ago and is sliding off the front page. A 60-point story
 * submitted an hour ago is going vertical. Ranking those two by points gets the
 * answer exactly backwards, so `rawValue` carries **points per hour since
 * submission** and the raw cumulative count is demoted to metadata.
 */

const SOURCE: TrendSourceId = 'hackernews';

const ALGOLIA_BASE = 'https://hn.algolia.com/api/v1/';

const FIREBASE_BASE = 'https://hacker-news.firebaseio.com/v0/';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Algolia documents roughly 10,000 requests per hour for the HN index, i.e.
 * ~166/min. 100/min leaves clear headroom: a `discover` pass is two requests,
 * so the limiter exists purely to keep a retry storm or the Firebase fallback
 * (which is one request per item) from ever approaching the published ceiling.
 */
const RATE_LIMIT = { requests: 100, intervalMs: 60_000, burst: 20 } as const;

/**
 * The front page reorders every few minutes but points move slowly enough that
 * a 3-minute cache is invisible downstream, while collapsing the repeat traffic
 * from several jobs sharing this provider in the same scheduler tick.
 */
const CACHE_TTL_MS = 3 * 60_000;

/**
 * Floor on the age used as the points-per-hour denominator.
 *
 * Without it, a story posted four minutes ago with three points reports 45
 * points/hour and outranks the actual front page. One hour is also roughly when
 * HN's own ranking stops being dominated by submission noise, so anything
 * younger is treated as "one hour old" rather than as an explosion.
 */
const MIN_AGE_HOURS = 1;

/** Stories above this rate, while still young, are genuinely accelerating. */
const TRENDING_POINTS_PER_HOUR = 25;

/** Below this rate a story is not gaining attention regardless of its total. */
const COOLING_POINTS_PER_HOUR = 5;

/** Lookback for `measure`, matching the rolling quarter other providers use. */
const MEASURE_WINDOW_DAYS = 90;

export interface HackerNewsProviderDeps {
  clock?: Clock;
  timeoutMs?: number;
  /**
   * Minimum points for the "recent risers" query. Low enough to catch a story
   * on its way up, high enough to exclude the long tail of submissions that
   * never leave /newest.
   */
  risingMinPoints?: number;
  /** How far back the "recent risers" query looks. */
  risingWindowHours?: number;
  /**
   * Use the Firebase API when Algolia fails. Off by default: it costs one
   * request per story and returns strictly less information (no comment counts
   * without a second traversal), so it is only worth enabling where HN coverage
   * matters more than the request budget.
   */
  firebaseFallback?: boolean;
  /** Items fetched individually when the Firebase fallback runs. */
  firebaseFallbackItems?: number;
}

// ---------------------------------------------------------------------------
// Defensive parsing
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asFinite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

interface HnStory {
  id: string;
  title: string;
  /** Absent for Ask HN / Show HN text posts, which have no outbound link. */
  linkUrl?: string;
  points: number;
  comments: number;
  createdAtSec: number;
  author?: string;
}

/**
 * `created_at_i` is the documented field but has been observed missing on a
 * small number of very old records, where the ISO `created_at` string is still
 * present. Falling back costs nothing and keeps those hits from being dropped.
 */
function parseCreatedAtSec(hit: Record<string, unknown>): number | null {
  const numeric = asFinite(hit['created_at_i']);
  if (numeric !== null && numeric > 0) return numeric;
  const iso = asNonEmptyString(hit['created_at']);
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * Algolia's index holds comments as well as stories, and a comment carries
 * `points: null` with `title: null`. Requiring both fields is what separates
 * the two without trusting `_tags` to be populated.
 */
function parseAlgoliaHit(raw: unknown): HnStory | null {
  if (!isRecord(raw)) return null;

  // objectID is documented as a string; accept a number too rather than
  // discarding an otherwise-valid hit over a serialisation change.
  const idRaw = raw['objectID'];
  const id = typeof idRaw === 'string' ? idRaw : typeof idRaw === 'number' ? String(idRaw) : null;
  if (!id) return null;

  const title = asNonEmptyString(raw['title']);
  if (!title) return null;

  const points = asFinite(raw['points']);
  if (points === null || points < 0) return null;

  const createdAtSec = parseCreatedAtSec(raw);
  if (createdAtSec === null) return null;

  const comments = asFinite(raw['num_comments']);
  const linkUrl = asNonEmptyString(raw['url']);
  const author = asNonEmptyString(raw['author']);

  const story: HnStory = {
    id,
    title,
    points,
    comments: comments !== null && comments >= 0 ? comments : 0,
    createdAtSec,
  };
  // Only accept an absolute http(s) link; Algolia occasionally carries relative
  // or malformed values that would produce a broken href downstream.
  if (linkUrl && /^https?:\/\//i.test(linkUrl)) story.linkUrl = linkUrl;
  if (author) story.author = author;
  return story;
}

function parseAlgoliaHits(payload: unknown): HnStory[] {
  if (!isRecord(payload)) return [];
  const hits = payload['hits'];
  if (!Array.isArray(hits)) return [];
  const out: HnStory[] = [];
  for (const hit of hits) {
    const story = parseAlgoliaHit(hit);
    if (story) out.push(story);
  }
  return out;
}

/** Firebase item shape differs from Algolia's: `score`, `time`, `descendants`. */
function parseFirebaseItem(raw: unknown): HnStory | null {
  if (!isRecord(raw)) return null;
  if (raw['type'] !== 'story') return null;
  if (raw['deleted'] === true || raw['dead'] === true) return null;

  const id = asFinite(raw['id']);
  const title = asNonEmptyString(raw['title']);
  const score = asFinite(raw['score']);
  const time = asFinite(raw['time']);
  if (id === null || !title || score === null || time === null || time <= 0) return null;

  const descendants = asFinite(raw['descendants']);
  const linkUrl = asNonEmptyString(raw['url']);
  const author = asNonEmptyString(raw['by']);

  const story: HnStory = {
    id: String(id),
    title,
    points: Math.max(0, score),
    comments: descendants !== null && descendants >= 0 ? descendants : 0,
    createdAtSec: time,
  };
  if (linkUrl && /^https?:\/\//i.test(linkUrl)) story.linkUrl = linkUrl;
  if (author) story.author = author;
  return story;
}

// ---------------------------------------------------------------------------
// Derived measures
// ---------------------------------------------------------------------------

function ageHours(story: HnStory, observedAt: number): number {
  const elapsed = (observedAt - story.createdAtSec * 1000) / HOUR_MS;
  // `Math.max` also absorbs a negative age from clock skew between our host and
  // HN's submission timestamps.
  return Math.max(MIN_AGE_HOURS, elapsed);
}

function pointsPerHour(story: HnStory, observedAt: number): number {
  return story.points / ageHours(story, observedAt);
}

/**
 * Comments per point.
 *
 * On HN an upvote is agreement and a comment is argument, so a high ratio marks
 * a story people are fighting about rather than nodding at. That is exactly the
 * property that makes a subject spread beyond its origin community, which is
 * what we are looking for. The ratio routinely exceeds 1 for political or
 * language-war threads; it is clamped rather than allowed to dominate, because
 * beyond parity the extra signal is about the argument, not the subject.
 */
function commentRatio(story: HnStory): number | undefined {
  if (story.points <= 0) return undefined;
  return clamp(story.comments / story.points, 0, 1);
}

function classifyStage(story: HnStory, observedAt: number): RawTrendSignal['sourceStage'] {
  const rate = pointsPerHour(story, observedAt);
  const age = ageHours(story, observedAt);
  if (age <= 12 && rate >= TRENDING_POINTS_PER_HOUR) return 'trending';
  // A day on HN is several lifetimes: whatever the rate, the story is behind
  // the front page by now and the accumulation has already happened.
  if (age >= 24 || rate < COOLING_POINTS_PER_HOUR) return 'cooling';
  return 'saturating';
}

/**
 * Coarse topical routing for the downstream category prior.
 *
 * HN is a technology forum, so `ai_tech` is the honest default rather than a
 * guess — the exceptions below are the handful of subject areas that regularly
 * reach its front page and that the concept generator treats very differently.
 */
const CATEGORY_RULES: Array<{ category: TrendCategory; pattern: RegExp }> = [
  {
    category: 'crypto_native',
    pattern: /\b(bitcoin|ethereum|solana|blockchain|crypto|defi|stablecoin|nft|onchain|zk-?rollup)\b/i,
  },
  { category: 'science', pattern: /\b(physics|biology|astronomy|genome|quantum|nasa|telescope|fusion|neuroscience)\b/i },
  { category: 'gaming', pattern: /\b(game\s?dev|videogame|video game|steam|nintendo|playstation|roguelike|speedrun)\b/i },
  { category: 'politics_news', pattern: /\b(election|senate|parliament|regulation|antitrust|lawsuit|court|sanctions?)\b/i },
  { category: 'finance', pattern: /\b(ipo|valuation|hedge fund|interest rates?|inflation|earnings|layoffs?)\b/i },
];

function classifyCategory(title: string): TrendCategory {
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(title)) return rule.category;
  }
  return 'ai_tech';
}

function itemUrl(id: string): string {
  return `https://news.ycombinator.com/item?id=${encodeURIComponent(id)}`;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function createHackerNewsProvider(deps: HackerNewsProviderDeps = {}): TrendProvider {
  const log = componentLogger('provider.hackernews');
  const clock = deps.clock ?? systemClock;
  const risingMinPoints = Math.max(1, Math.floor(deps.risingMinPoints ?? 20));
  const risingWindowHours = Math.max(1, Math.floor(deps.risingWindowHours ?? 12));
  const firebaseFallback = deps.firebaseFallback ?? false;
  const firebaseFallbackItems = Math.max(0, Math.floor(deps.firebaseFallbackItems ?? 30));
  const timeoutMs = deps.timeoutMs ?? 15_000;

  const algolia = new HttpClient({
    name: 'hackernews-algolia',
    baseUrl: ALGOLIA_BASE,
    rateLimit: { ...RATE_LIMIT },
    cacheTtlMs: CACHE_TTL_MS,
    timeoutMs,
    clock,
  });

  // A separate client so the two transports get independent circuit breakers:
  // Algolia being down is the reason we reach for Firebase, and a shared
  // breaker would have already tripped by then.
  const firebase = new HttpClient({
    name: 'hackernews-firebase',
    baseUrl: FIREBASE_BASE,
    rateLimit: { ...RATE_LIMIT },
    cacheTtlMs: CACHE_TTL_MS,
    timeoutMs,
    clock,
  });

  let lastSuccessAt: number | undefined;
  let lastFailureAt: number | undefined;
  let lastError: string | undefined;

  async function getAlgolia(path: string, query: Record<string, string | number>, signal?: AbortSignal): Promise<unknown> {
    try {
      // HttpClient builds the query through URLSearchParams, which percent-
      // encodes `>` as %3E and `,` as %2C. Verified against the live endpoint:
      // `numericFilters=created_at_i%3E...%2Cpoints%3E...` is accepted and
      // filters correctly, so the raw operators are passed here unescaped.
      const payload = await algolia.request<unknown>(path, { query, ...(signal ? { signal } : {}) });
      lastSuccessAt = clock.now();
      return payload;
    } catch (e) {
      lastFailureAt = clock.now();
      lastError = safeErrorText(e, 200);
      log.warn({ path, err: lastError }, 'algolia hn request failed');
      return null;
    }
  }

  /**
   * Fallback path. Only reached when Algolia returned nothing at all, because
   * it costs `1 + firebaseFallbackItems` requests for information Algolia
   * serves in one.
   */
  async function fetchFirebaseTop(signal?: AbortSignal): Promise<HnStory[]> {
    if (!firebaseFallback || firebaseFallbackItems === 0) return [];
    let ids: unknown;
    try {
      ids = await firebase.request<unknown>('topstories.json', { ...(signal ? { signal } : {}) });
    } catch (e) {
      lastFailureAt = clock.now();
      lastError = safeErrorText(e, 200);
      log.warn({ err: lastError }, 'hn firebase topstories failed');
      return [];
    }
    if (!Array.isArray(ids)) return [];

    const wanted = ids.filter((id): id is number => typeof id === 'number' && Number.isFinite(id)).slice(0, firebaseFallbackItems);

    const items = await Promise.all(
      wanted.map(async (id) => {
        try {
          return await firebase.request<unknown>(`item/${id}.json`, { ...(signal ? { signal } : {}) });
        } catch {
          // One dead item must not sink the batch; the story is simply absent.
          return null;
        }
      }),
    );

    const out: HnStory[] = [];
    for (const item of items) {
      const story = parseFirebaseItem(item);
      if (story) out.push(story);
    }
    if (out.length > 0) lastSuccessAt = clock.now();
    return out;
  }

  function buildSignal(
    story: HnStory,
    observedAt: number,
    extras: { rank?: number; onFrontPage: boolean },
  ): RawTrendSignal {
    const age = ageHours(story, observedAt);
    const rate = pointsPerHour(story, observedAt);
    const engagement = commentRatio(story);
    const title = sanitiseExternalText(story.title, 300);

    const signal: RawTrendSignal = {
      source: SOURCE,
      // The HN item id is stable forever and is the same key in both
      // transports, so a story discovered via Algolia and later via Firebase
      // deduplicates cleanly.
      externalId: story.id,
      title,
      // The discussion page, not `story.linkUrl`: the conversation is the
      // signal, and text posts have no outbound link at all.
      url: itemUrl(story.id),
      rawValue: rate,
      observedAt,
      sourceStage: classifyStage(story, observedAt),
      category: classifyCategory(story.title),
      keywords: contentTokens(title).slice(0, 12),
      metadata: {
        /** Cumulative score. Deliberately not `rawValue` — see the file header. */
        points: story.points,
        comments: story.comments,
        pointsPerHour: rate,
        commentsPerHour: story.comments / age,
        ageHours: age,
        createdAtMs: story.createdAtSec * 1000,
        onFrontPage: extras.onFrontPage,
        transport: 'algolia',
        // A username is chosen by a stranger, so it is sanitised like any other
        // external string even though HN's own charset is narrow.
        author: story.author ? sanitiseExternalText(story.author, 60) : undefined,
        // The submitted link is kept for domain-level analysis but is never
        // used as the signal's own URL.
        submittedUrl: story.linkUrl,
      },
    };

    if (engagement !== undefined) signal.engagement = engagement;
    if (extras.rank !== undefined) signal.rank = extras.rank;

    // `audience` is deliberately unset. HN publishes no view count, and points
    // are voters — a small, self-selected fraction of readers with no stable
    // ratio to reach. Reporting points as audience would understate it by an
    // unknown factor, so downstream is told nothing rather than something false.

    return signal;
  }

  async function fetchFrontPage(signal?: AbortSignal): Promise<HnStory[]> {
    const payload = await getAlgolia('search', { tags: 'front_page', hitsPerPage: 50 }, signal);
    return parseAlgoliaHits(payload);
  }

  /**
   * Stories that cleared a points threshold recently but may not have surfaced
   * on the front page yet — the actual leading edge, and the reason this
   * provider is worth polling more often than once a day.
   */
  async function fetchRisers(observedAt: number, signal?: AbortSignal): Promise<HnStory[]> {
    const cutoff = Math.floor((observedAt - risingWindowHours * HOUR_MS) / 1000);
    const payload = await getAlgolia(
      'search',
      {
        tags: 'story',
        numericFilters: `created_at_i>${cutoff},points>${risingMinPoints}`,
        hitsPerPage: 50,
      },
      signal,
    );
    return parseAlgoliaHits(payload);
  }

  return {
    id: 'hackernews',
    label: 'Hacker News',
    kind: 'trend',
    sourceId: SOURCE,

    async healthCheck(): Promise<ProviderStatus> {
      const started = clock.now();
      // The front-page query is the same request `discover` makes and is cached
      // for three minutes, so probing costs at most one request per window.
      const stories = await fetchFrontPage();
      const state: HealthState = stories.length > 0 ? 'ok' : 'down';

      const status: ProviderStatus = {
        id: 'hackernews',
        label: 'Hacker News',
        kind: 'trend',
        state,
        detail:
          stories.length > 0
            ? `Algolia front page returned ${stories.length} stories.`
            : `No stories from the Algolia HN index${lastError ? `: ${lastError}` : '.'}`,
        // Both HN transports are fully public; there is no key an operator
        // could add to unlock more of either.
        requiresCredentials: false,
        latencyMs: clock.now() - started,
      };
      if (lastSuccessAt !== undefined) status.lastSuccessAt = lastSuccessAt;
      if (lastFailureAt !== undefined) status.lastFailureAt = lastFailureAt;
      return status;
    },

    async discover(options: { limit: number; signal?: AbortSignal }): Promise<RawTrendSignal[]> {
      const limit = Math.max(1, Math.floor(options.limit));
      const observedAt = clock.now();

      const [frontPage, risers] = await Promise.all([
        fetchFrontPage(options.signal),
        fetchRisers(observedAt, options.signal),
      ]);

      // Front page first so its ranked position wins on collision; the risers
      // query has no meaningful ordering to contribute.
      const byId = new Map<string, { story: HnStory; rank?: number; onFrontPage: boolean }>();
      frontPage.forEach((story, index) => {
        byId.set(story.id, { story, rank: index + 1, onFrontPage: true });
      });
      for (const story of risers) {
        if (byId.has(story.id)) continue;
        byId.set(story.id, { story, onFrontPage: false });
      }

      let entries = [...byId.values()];

      if (entries.length === 0) {
        const fallback = await fetchFirebaseTop(options.signal);
        entries = fallback.map((story, index) => ({ story, rank: index + 1, onFrontPage: true }));
        if (entries.length === 0) return [];
        return entries
          .map(({ story, rank, onFrontPage }) => {
            const built = buildSignal(story, observedAt, { rank, onFrontPage });
            (built.metadata as Record<string, unknown>)['transport'] = 'firebase';
            return built;
          })
          .sort((a, b) => b.rawValue - a.rawValue)
          .slice(0, limit);
      }

      return entries
        .map(({ story, rank, onFrontPage }) =>
          buildSignal(story, observedAt, rank === undefined ? { onFrontPage } : { rank, onFrontPage }),
        )
        // Sorted by velocity, not points, so the ranking downstream sees agrees
        // with the quantity in `rawValue`.
        .sort((a, b) => b.rawValue - a.rawValue)
        .slice(0, limit);
    },

    /**
     * Aggregate HN attention for a term over the last quarter.
     *
     * A term has no single HN item, so this sums the velocity of every matching
     * story in the window. `rawValue` stays in the same unit as `discover`
     * (points per hour) so the two are directly comparable, and `history` is
     * bucketed by submission day, giving downstream a real series to fit rather
     * than a single scalar.
     */
    async measure(term: string, options: { signal?: AbortSignal }): Promise<RawTrendSignal | null> {
      const trimmed = term.trim();
      if (!trimmed) return null;

      const observedAt = clock.now();
      const cutoff = Math.floor((observedAt - MEASURE_WINDOW_DAYS * DAY_MS) / 1000);
      const payload = await getAlgolia(
        'search',
        {
          query: trimmed,
          tags: 'story',
          numericFilters: `created_at_i>${cutoff}`,
          hitsPerPage: 50,
        },
        options.signal,
      );

      const stories = parseAlgoliaHits(payload);
      // No coverage is a real answer and must stay distinguishable from zero
      // attention on a story we did find.
      if (stories.length === 0) return null;

      const combinedRate = stories.reduce((acc, s) => acc + pointsPerHour(s, observedAt), 0);
      const totalPoints = stories.reduce((acc, s) => acc + s.points, 0);
      const totalComments = stories.reduce((acc, s) => acc + s.comments, 0);

      // Bucket to UTC days: submissions cluster by working hours, and an hourly
      // series over 90 days would be mostly empty.
      const buckets = new Map<number, number>();
      for (const story of stories) {
        const day = Math.floor((story.createdAtSec * 1000) / DAY_MS) * DAY_MS;
        buckets.set(day, (buckets.get(day) ?? 0) + story.points);
      }
      const history = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));

      const top = stories.reduce((best, s) => (pointsPerHour(s, observedAt) > pointsPerHour(best, observedAt) ? s : best));

      const signal: RawTrendSignal = {
        source: SOURCE,
        externalId: `search:${trimmed.toLowerCase()}`,
        title: sanitiseExternalText(trimmed, 300),
        summary: sanitiseExternalText(top.title, 300),
        url: `https://hn.algolia.com/?query=${encodeURIComponent(trimmed)}&type=story`,
        rawValue: combinedRate,
        history,
        observedAt,
        keywords: contentTokens(trimmed).slice(0, 12),
        metadata: {
          lookup: true,
          storyCount: stories.length,
          totalPoints,
          totalComments,
          windowDays: MEASURE_WINDOW_DAYS,
          topStoryId: top.id,
          topStoryPoints: top.points,
          transport: 'algolia',
        },
      };

      if (totalPoints > 0) signal.engagement = clamp(totalComments / totalPoints, 0, 1);

      // Stage is taken from the single hottest matching story: a term is "still
      // going" on HN exactly when something about it is currently climbing,
      // regardless of how much it accumulated earlier in the quarter.
      signal.sourceStage = classifyStage(top, observedAt);

      return signal;
    },
  };
}
