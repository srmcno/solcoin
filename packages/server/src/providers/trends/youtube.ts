import { contentTokens, sanitiseExternalText } from '@solcoin/shared';
import type { TrendCategory, TrendSourceId } from '@solcoin/shared';
import { systemClock, utcDayKey, type Clock } from '../../core/clock.js';
import { safeErrorText } from '../../core/errors.js';
import { componentLogger } from '../../core/logger.js';
import { HttpClient, HttpError } from '../http.js';
import type { ProviderStatus, RawTrendSignal, TrendProvider } from '../types.js';

/**
 * YouTube Data API v3 — credentialed, optional.
 *
 * Endpoints:
 *   GET /youtube/v3/videos?part=snippet,statistics&chart=mostPopular
 *       &regionCode={CC}&videoCategoryId=0&maxResults=50   (discover)
 *   GET /youtube/v3/search?part=snippet&q=&order=viewCount
 *       &publishedAfter={ISO}&type=video&maxResults=50      (measure, step 1)
 *
 * Quota model, which drives almost every design decision in this file:
 *
 *  - The project's daily bucket is 10,000 units, resets at midnight Pacific in
 *    Google's own accounting. This provider meters per **UTC** day instead,
 *    because the rest of the platform keys everything on UTC days and a ledger
 *    that disagrees with the scheduler is worse than one that is a few hours out
 *    of phase with Google. The consequence is documented: around the Pacific
 *    reset our counter can be pessimistic (we refuse while Google would allow)
 *    but never optimistic in a way that would get the key throttled — it can
 *    only over-refuse for part of one day.
 *  - `videos.list` costs 1 unit. Polling 30 region charts hourly is
 *    30 * 24 = 720 units/day, comfortably inside the bucket, which is why
 *    discover() sweeps every configured region rather than stopping early:
 *    the cross-region footprint of a video is the most valuable thing this
 *    source produces and truncating the sweep would bias it toward whichever
 *    regions happen to be first in the list.
 *  - `search.list` is metered separately and is hard-capped at 100 calls/day.
 *    NOTE for whoever maintains this: Google's published quota table lists
 *    search.list at **100 units**, not 1. Either reading produces the same
 *    ceiling — 100 search calls would consume the entire 10,000-unit day — so
 *    the hard 100-calls/day counter below is the binding constraint under both
 *    accountings and is enforced independently of the unit ledger. Search is
 *    reserved for confirming candidates that another source already surfaced;
 *    once the budget is spent measure() returns null and logs why rather than
 *    burning the discovery budget.
 *
 * API gotchas handled here:
 *  - `statistics.*` are JSON **strings**, not numbers ("1234567").
 *  - `likeCount` and `commentCount` are absent entirely when the uploader has
 *    disabled likes/comments; that is not the same as zero, so engagement is
 *    left undefined rather than computed from a fabricated zero.
 *  - `search.list` returns **no statistics** — only snippet. A view count for a
 *    search hit therefore requires a second `videos.list` call with the
 *    collected ids (1 more unit, batched, up to 50 ids in one call).
 *  - An invalid key returns HTTP 400 with `error.errors[].reason = 'badRequest'`
 *    (verified 2026-08-29), *not* 401/403; a quota exhaustion returns 403 with
 *    reason `quotaExceeded`. Both are mapped to states rather than exceptions.
 */

const SOURCE_ID: TrendSourceId = 'youtube';
const CREDENTIAL_KEY = 'trends.youtube.api_key';
const API_BASE = 'https://www.googleapis.com/youtube/v3/';

/** Google's default per-project daily allowance. */
const DAILY_UNIT_BUDGET = 10_000;
const VIDEOS_LIST_UNIT_COST = 1;
const SEARCH_LIST_UNIT_COST = 1;
/** Independent hard cap on search.list calls per day. See header comment. */
const SEARCH_CALLS_PER_DAY = 100;
/**
 * Units held back so a burst of measure() calls can never leave discover()
 * unable to run at all. Discovery is the job that pays for itself.
 */
const DISCOVERY_UNIT_RESERVE = 200;

/** videos.list and search.list both cap maxResults at 50. */
const MAX_PAGE = 50;

/**
 * The daily unit budget — not requests per minute — is the binding constraint;
 * the per-minute ceiling is measured in millions of units. This limiter exists
 * only to smooth the region sweep into a polite stream instead of 30 parallel
 * connections, and to keep us well clear of the per-user QPS guard.
 */
const RATE_LIMIT = { requests: 60, intervalMs: 60_000, burst: 10 } as const;

/**
 * Charts are recomputed on the order of hours; 15 minutes makes a repeated
 * health probe or a re-run of the same job free instead of costing a unit.
 */
const DEFAULT_CACHE_TTL_MS = 900_000;

/**
 * Default region sweep: 30 charts, i.e. 720 units/day at hourly cadence.
 *
 * Chosen for population and internet-culture reach across distinct language
 * markets rather than for GDP, because a trend that charts in both Brazil and
 * Indonesia is genuinely global while one charting in the US and Canada is one
 * media market counted twice.
 */
const DEFAULT_REGIONS: readonly string[] = [
  'US', 'GB', 'CA', 'AU', 'IE', 'IN', 'PH', 'SG', 'ZA', 'NG',
  'DE', 'FR', 'ES', 'IT', 'NL', 'SE', 'PL', 'PT', 'TR', 'UA',
  'BR', 'MX', 'AR', 'CO', 'JP', 'KR', 'TW', 'TH', 'ID', 'VN',
];

/** How far back measure()'s search looks, when the caller does not say. */
const DEFAULT_MEASURE_WINDOW_HOURS = 48;

export interface YouTubeProviderDeps {
  getCredential: (key: string) => Promise<string | null>;
  clock?: Clock;
  /** Region charts to sweep. Each one costs 1 unit per poll. */
  regionCodes?: readonly string[];
  /** Recency window for measure()'s search.list call. */
  measureWindowHours?: number;
  timeoutMs?: number;
  cacheTtlMs?: number;
  /** Override the API host (proxy / test double). */
  baseUrl?: string;
  /** Injectable client, for tests. A correctly configured one is built if absent. */
  http?: HttpClient;
}

export function createYouTubeProvider(deps: YouTubeProviderDeps): TrendProvider {
  const log = componentLogger('provider.youtube');
  const clock = deps.clock ?? systemClock;
  const regions = normaliseRegions(deps.regionCodes ?? DEFAULT_REGIONS);
  const measureWindowHours = positive(deps.measureWindowHours) ?? DEFAULT_MEASURE_WINDOW_HOURS;

  const stats: { lastSuccessAt?: number; lastFailureAt?: number; lastError?: string } = {};

  /**
   * In-memory quota ledger, rolled over on the first call of a new UTC day.
   * In-memory means a process restart forgets what was spent — deliberately
   * accepted, because the alternative is a storage dependency in a provider,
   * and Google's own 403 remains the authoritative backstop.
   */
  const ledger = { day: utcDayKey(clock.now()), units: 0, searchCalls: 0 };

  function rollDay(): void {
    const today = utcDayKey(clock.now());
    if (ledger.day === today) return;
    ledger.day = today;
    ledger.units = 0;
    ledger.searchCalls = 0;
  }

  function unitsRemaining(): number {
    rollDay();
    return Math.max(0, DAILY_UNIT_BUDGET - ledger.units);
  }

  function searchCallsRemaining(): number {
    rollDay();
    return Math.max(0, SEARCH_CALLS_PER_DAY - ledger.searchCalls);
  }

  /** Next UTC midnight — when this provider's ledger resets. */
  function quotaResetAt(): number {
    const d = clock.date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  }

  const http =
    deps.http ??
    new HttpClient({
      name: 'youtube',
      baseUrl: (deps.baseUrl ?? API_BASE).replace(/\/*$/, '/'),
      timeoutMs: deps.timeoutMs ?? 15_000,
      // A 4xx from Google is a configuration answer, not a transient fault, and
      // HttpClient only retries retryable errors — so a low retry count here
      // only bounds how many units a flapping 5xx can burn.
      maxRetries: 2,
      rateLimit: { ...RATE_LIMIT },
      cacheTtlMs: deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
      clock,
      onResult: (r) => {
        if (r.ok) stats.lastSuccessAt = clock.now();
        else {
          stats.lastFailureAt = clock.now();
          stats.lastError = r.error;
        }
      },
    });

  /** Charge the ledger *before* the call, so a failed call still counts. */
  function spend(units: number): void {
    rollDay();
    ledger.units += units;
  }

  async function mostPopular(
    key: string,
    regionCode: string,
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    spend(VIDEOS_LIST_UNIT_COST);
    return http.request<unknown>('videos', {
      query: {
        part: 'snippet,statistics',
        chart: 'mostPopular',
        regionCode,
        // '0' is the API's "no category filter" sentinel for a chart query.
        videoCategoryId: 0,
        maxResults: clampInt(maxResults, 1, MAX_PAGE),
        key,
      },
      ...(signal ? { signal } : {}),
    });
  }

  const label = 'YouTube Data API v3';
  const base = { id: 'youtube', label, kind: 'trend' as const, requiresCredentials: true };
  const setupHint =
    'Create a Google Cloud project, enable "YouTube Data API v3", then store the API key as ' +
    `${CREDENTIAL_KEY}. The free daily allowance is 10,000 quota units.`;

  return {
    id: 'youtube',
    label,
    kind: 'trend',
    sourceId: SOURCE_ID,

    async healthCheck(): Promise<ProviderStatus> {
      const started = clock.now();
      const key = await deps.getCredential(CREDENTIAL_KEY);
      if (!key) {
        // The common case. No key is a configuration state, never an error.
        return {
          ...base,
          state: 'unconfigured',
          detail: 'No YouTube API key configured; this source is inactive.',
          setupHint,
        };
      }

      rollDay();
      const remaining = unitsRemaining();
      // Read after the probe below, so the unit it spends is reflected.
      const quota = () => ({ quotaRemaining: unitsRemaining(), quotaResetAt: quotaResetAt() });

      if (remaining < VIDEOS_LIST_UNIT_COST) {
        // Probing with no budget left would itself be the thing that breaks the
        // day, so report from the ledger without touching the network.
        return {
          ...base,
          state: 'degraded',
          detail: `Daily quota exhausted (${ledger.units}/${DAILY_UNIT_BUDGET} units); resets at 00:00 UTC.`,
          setupHint,
          ...quota(),
          ...(stats.lastSuccessAt !== undefined ? { lastSuccessAt: stats.lastSuccessAt } : {}),
          ...(stats.lastFailureAt !== undefined ? { lastFailureAt: stats.lastFailureAt } : {}),
        };
      }

      const probeRegion = regions[0] ?? 'US';
      try {
        // maxResults=1 is the cheapest form of discover()'s own call and shares
        // its response cache; it still costs exactly 1 unit (cost is per call,
        // not per result), which is why the cache TTL matters.
        const payload = await mostPopular(key, probeRegion, 1);
        const items = readItems(payload);
        const searchLeft = searchCallsRemaining();
        return {
          ...base,
          state: items.length > 0 ? 'ok' : 'degraded',
          detail:
            items.length > 0
              ? `Chart reachable for ${probeRegion}; ${searchLeft}/${SEARCH_CALLS_PER_DAY} search calls left today.`
              : `Chart for ${probeRegion} responded but returned no videos.`,
          setupHint,
          latencyMs: clock.now() - started,
          ...quota(),
          lastSuccessAt: clock.now(),
          ...(stats.lastFailureAt !== undefined ? { lastFailureAt: stats.lastFailureAt } : {}),
        };
      } catch (e) {
        const reason = googleErrorReason(e);
        return {
          ...base,
          // A bad or unauthorised key is a configuration problem the operator
          // must fix, so it is reported as 'down' with the upstream reason
          // rather than hidden behind a generic network failure.
          state: reason === 'quotaExceeded' ? 'degraded' : 'down',
          detail: reason ? `${reason}: ${safeErrorText(e, 160)}` : safeErrorText(e, 200),
          setupHint,
          latencyMs: clock.now() - started,
          ...quota(),
          ...(stats.lastSuccessAt !== undefined ? { lastSuccessAt: stats.lastSuccessAt } : {}),
          lastFailureAt: clock.now(),
        };
      }
    },

    async discover(options: { limit: number; signal?: AbortSignal }): Promise<RawTrendSignal[]> {
      const want = clampInt(options.limit, 0, 5_000);
      if (want === 0) return [];

      const key = await deps.getCredential(CREDENTIAL_KEY);
      // Contract: unconfigured providers return nothing. They never throw and
      // they never invent data to look busy.
      if (!key) return [];

      const observedAt = clock.now();
      /** video id -> accumulated cross-region observation. */
      const merged = new Map<string, MergedVideo>();
      let regionsPolled = 0;
      let regionsFailed = 0;

      for (const regionCode of regions) {
        if (options.signal?.aborted) break;
        if (unitsRemaining() < VIDEOS_LIST_UNIT_COST) {
          log.warn(
            { spent: ledger.units, budget: DAILY_UNIT_BUDGET, regionsPolled },
            'youtube daily quota exhausted mid-sweep; returning partial results',
          );
          break;
        }

        let payload: unknown;
        try {
          payload = await mostPopular(key, regionCode, MAX_PAGE, options.signal);
        } catch (e) {
          const reason = googleErrorReason(e);
          if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
            // Google is the authority on the budget; believe it over our ledger
            // and stop immediately so the remaining regions do not each earn a
            // 403 and trip the circuit breaker.
            ledger.units = DAILY_UNIT_BUDGET;
            log.warn({ regionCode, reason }, 'youtube reported quota exhaustion; ending sweep');
            break;
          }
          if (isCredentialError(e)) {
            log.warn({ reason }, 'youtube rejected the API key; treating source as unconfigured for this run');
            break;
          }
          // One bad region (an unsupported regionCode is a 400) must not cost us
          // the other twenty-nine.
          regionsFailed++;
          log.debug({ regionCode, err: safeErrorText(e, 160) }, 'youtube region chart failed');
          continue;
        }

        regionsPolled++;
        const items = readItems(payload);
        for (let i = 0; i < items.length; i++) {
          const parsed = parseVideo(items[i]);
          if (!parsed) continue; // malformed item: skipped, never fatal
          const rank = i + 1;
          const existing = merged.get(parsed.id);
          if (existing) {
            existing.regions.push(regionCode);
            if (rank < existing.bestRank) {
              existing.bestRank = rank;
              existing.bestRankRegion = regionCode;
            }
            // Statistics are global, not per-region; keep the highest reading,
            // which is simply the freshest of the two responses.
            if (parsed.viewCount > existing.video.viewCount) existing.video = parsed;
          } else {
            merged.set(parsed.id, {
              video: parsed,
              regions: [regionCode],
              bestRank: rank,
              bestRankRegion: regionCode,
            });
          }
        }
      }

      if (merged.size === 0) return [];

      const ranked = [...merged.values()].sort((a, b) => {
        // Cross-region footprint first: a video charting in twelve countries is
        // a global trend, while a #1 in a single market is a local one, and the
        // platform is looking for trends with a worldwide audience.
        if (b.regions.length !== a.regions.length) return b.regions.length - a.regions.length;
        if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
        return b.video.viewCount - a.video.viewCount;
      });

      const out: RawTrendSignal[] = [];
      for (const entry of ranked.slice(0, want)) {
        out.push(toSignal(entry, observedAt, regionsPolled));
      }

      if (regionsFailed > 0) {
        log.debug({ regionsPolled, regionsFailed, videos: out.length }, 'youtube sweep completed with failures');
      }
      return out;
    },

    async measure(term: string, options: { signal?: AbortSignal }): Promise<RawTrendSignal | null> {
      const q = term.trim();
      if (!q) return null;

      const key = await deps.getCredential(CREDENTIAL_KEY);
      if (!key) return null;

      if (searchCallsRemaining() <= 0) {
        log.info(
          { term: q, cap: SEARCH_CALLS_PER_DAY, day: ledger.day },
          'youtube search budget spent for today; measure() refused (search.list is capped at 100 calls/day and is reserved for confirming already-surfaced candidates)',
        );
        return null;
      }
      if (unitsRemaining() <= DISCOVERY_UNIT_RESERVE) {
        log.info(
          { term: q, remaining: unitsRemaining(), reserve: DISCOVERY_UNIT_RESERVE },
          'youtube unit budget down to the discovery reserve; measure() refused',
        );
        return null;
      }

      const publishedAfter = new Date(clock.now() - measureWindowHours * 3_600_000).toISOString();

      let searchPayload: unknown;
      try {
        rollDay();
        ledger.searchCalls++;
        spend(SEARCH_LIST_UNIT_COST);
        searchPayload = await http.request<unknown>('search', {
          query: {
            part: 'snippet',
            q,
            // viewCount ordering surfaces the videos that actually carried the
            // term, which is what a magnitude measurement needs; relevance
            // ordering would return well-matched but unwatched videos.
            order: 'viewCount',
            publishedAfter,
            type: 'video',
            maxResults: MAX_PAGE,
            key,
          },
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (e) {
        const reason = googleErrorReason(e);
        if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
          ledger.searchCalls = SEARCH_CALLS_PER_DAY;
          ledger.units = DAILY_UNIT_BUDGET;
        }
        log.debug({ term: q, reason, err: safeErrorText(e, 160) }, 'youtube search failed');
        return null;
      }

      const hits = readItems(searchPayload);
      const ids: string[] = [];
      let newestPublishedAt: number | null = null;
      for (const hit of hits) {
        if (!isRecord(hit)) continue;
        // search.list nests the video id under `id.videoId`, unlike videos.list
        // where `id` is the bare string.
        const idObj = isRecord(hit['id']) ? hit['id'] : null;
        const videoId = idObj ? asString(idObj['videoId']) : null;
        if (!videoId) continue;
        ids.push(videoId);
        const snippet = isRecord(hit['snippet']) ? hit['snippet'] : null;
        const published = snippet ? parseTimestamp(asString(snippet['publishedAt'])) : null;
        if (published !== null) {
          newestPublishedAt = newestPublishedAt === null ? published : Math.max(newestPublishedAt, published);
        }
      }

      if (ids.length === 0) {
        // A real, honest answer: nobody uploaded about this term in the window.
        return {
          source: SOURCE_ID,
          externalId: `youtube:search:${q.toLowerCase()}`,
          title: sanitiseExternalText(q, 120),
          rawValue: 0,
          observedAt: clock.now(),
          metadata: { matchedVideos: 0, windowHours: measureWindowHours, publishedAfter },
        };
      }

      // search.list carries no statistics at all, so the view counts that make
      // this measurement meaningful require a second call. One videos.list can
      // take all 50 ids for a single unit, which is why the ids are batched
      // rather than fetched per video.
      let statsPayload: unknown = null;
      if (unitsRemaining() >= VIDEOS_LIST_UNIT_COST) {
        try {
          spend(VIDEOS_LIST_UNIT_COST);
          statsPayload = await http.request<unknown>('videos', {
            query: { part: 'snippet,statistics', id: ids.join(','), maxResults: MAX_PAGE, key },
            ...(options.signal ? { signal: options.signal } : {}),
          });
        } catch (e) {
          log.debug({ term: q, err: safeErrorText(e, 160) }, 'youtube stats lookup failed after search');
        }
      }

      let views = 0;
      let likes = 0;
      let comments = 0;
      let withEngagement = 0;
      let counted = 0;
      const channels = new Set<string>();
      for (const item of readItems(statsPayload)) {
        const video = parseVideo(item);
        if (!video) continue;
        counted++;
        views += video.viewCount;
        if (video.channelId) channels.add(video.channelId);
        if (video.likeCount !== null || video.commentCount !== null) {
          likes += video.likeCount ?? 0;
          comments += video.commentCount ?? 0;
          withEngagement++;
        }
      }

      const observedAt = clock.now();
      const signal: RawTrendSignal = {
        source: SOURCE_ID,
        externalId: `youtube:search:${q.toLowerCase()}`,
        title: sanitiseExternalText(q, 120),
        // Total views across the matched uploads in the window: the closest
        // thing YouTube exposes to "how much attention did this term get".
        rawValue: views,
        audience: views,
        observedAt,
        metadata: {
          matchedVideos: ids.length,
          // Fewer than matchedVideos when the stats call was skipped or partial.
          statsResolved: counted,
          distinctChannels: channels.size,
          windowHours: measureWindowHours,
          publishedAfter,
          searchCallsRemaining: searchCallsRemaining(),
          sampleTruncated: ids.length >= MAX_PAGE,
          ...(newestPublishedAt !== null ? { newestPublishedAt } : {}),
        },
      };
      // Only meaningful when at least one video actually reported interactions;
      // uploads with likes and comments disabled would otherwise drag it to 0.
      if (views > 0 && withEngagement > 0) signal.engagement = clamp01((likes + comments) / views);
      return signal;
    },
  };
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

interface ParsedVideo {
  id: string;
  title: string;
  description: string | null;
  channelId: string | null;
  channelTitle: string | null;
  publishedAt: number | null;
  categoryId: string | null;
  tags: string[];
  viewCount: number;
  likeCount: number | null;
  commentCount: number | null;
}

interface MergedVideo {
  video: ParsedVideo;
  regions: string[];
  bestRank: number;
  bestRankRegion: string;
}

/**
 * YouTube's assignable video categories onto TrendCategory.
 *
 * Only the unambiguous ones are mapped. 'Howto & Style', 'People & Blogs' and
 * the film-genre ids (30-44, which appear on movie pages rather than uploads)
 * describe format, not subject, so they are deliberately absent: an absent
 * category is honest, a guessed one silently biases the downstream category
 * priors. Id 28 'Science & Technology' maps to 'science' rather than 'ai_tech'
 * for the same reason — the payload does not establish AI specificity.
 */
const CATEGORY_MAP: Record<string, TrendCategory> = {
  '1': 'entertainment', // Film & Animation
  '10': 'music',
  '15': 'animals', // Pets & Animals
  '17': 'sports',
  '19': 'other', // Travel & Events
  '20': 'gaming',
  '23': 'entertainment', // Comedy
  '24': 'entertainment',
  '25': 'politics_news', // News & Politics
  '27': 'science', // Education
  '28': 'science', // Science & Technology
};

function parseVideo(item: unknown): ParsedVideo | null {
  if (!isRecord(item)) return null;
  const id = asString(item['id']);
  if (!id) return null;

  const snippet = isRecord(item['snippet']) ? item['snippet'] : null;
  const rawTitle = snippet ? asString(snippet['title']) : null;
  if (!rawTitle) return null;

  // Video titles are attacker-controlled free text on a public upload form.
  const title = sanitiseExternalText(rawTitle, 200);
  if (!title) return null;

  const statistics = isRecord(item['statistics']) ? item['statistics'] : null;
  // Every statistics value arrives as a decimal string.
  const viewCount = statistics ? numericString(statistics['viewCount']) : null;

  const descriptionRaw = snippet ? asString(snippet['description']) : null;
  const tagsRaw = snippet && Array.isArray(snippet['tags']) ? snippet['tags'] : [];
  const tags: string[] = [];
  for (const tag of tagsRaw) {
    const clean = typeof tag === 'string' ? sanitiseExternalText(tag, 60) : '';
    if (clean) tags.push(clean);
    if (tags.length >= 15) break;
  }

  return {
    id,
    title,
    description: descriptionRaw ? sanitiseExternalText(descriptionRaw, 500) : null,
    channelId: snippet ? asString(snippet['channelId']) : null,
    channelTitle: snippet ? sanitiseOrNull(asString(snippet['channelTitle']), 120) : null,
    publishedAt: snippet ? parseTimestamp(asString(snippet['publishedAt'])) : null,
    categoryId: snippet ? asString(snippet['categoryId']) : null,
    tags,
    viewCount: viewCount ?? 0,
    likeCount: statistics ? numericString(statistics['likeCount']) : null,
    commentCount: statistics ? numericString(statistics['commentCount']) : null,
  };
}

function toSignal(entry: MergedVideo, observedAt: number, regionsPolled: number): RawTrendSignal {
  const v = entry.video;

  const signal: RawTrendSignal = {
    source: SOURCE_ID,
    externalId: `youtube:${v.id}`,
    title: v.title,
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`,
    rawValue: v.viewCount,
    // Views are literally the audience that reached this video, which is the
    // one place in the platform where `audience` is measured rather than
    // estimated.
    audience: v.viewCount,
    rank: entry.bestRank,
    observedAt,
    metadata: {
      videoId: v.id,
      regions: entry.regions,
      regionCount: entry.regions.length,
      regionsPolled,
      bestRankRegion: entry.bestRankRegion,
      ...(v.channelTitle ? { channelTitle: v.channelTitle } : {}),
      ...(v.channelId ? { channelId: v.channelId } : {}),
      ...(v.publishedAt !== null ? { publishedAt: v.publishedAt } : {}),
      ...(v.likeCount !== null ? { likeCount: v.likeCount } : {}),
      ...(v.commentCount !== null ? { commentCount: v.commentCount } : {}),
      // Absent counts mean the uploader disabled the feature, not zero.
      likesDisabled: v.likeCount === null,
      commentsDisabled: v.commentCount === null,
    },
  };

  if (v.description) signal.summary = v.description;

  /**
   * (likes + comments) / views. Both numerator terms are deliberate: a comment
   * is a far higher-effort signal than a like, but YouTube's like:view ratio is
   * so much larger that weighting comments up would make the metric almost
   * entirely a comment ratio. Left unset when the uploader disabled both, since
   * treating "disabled" as "zero engagement" would rank a hugely popular video
   * as dead.
   */
  if (v.viewCount > 0 && (v.likeCount !== null || v.commentCount !== null)) {
    signal.engagement = clamp01(((v.likeCount ?? 0) + (v.commentCount ?? 0)) / v.viewCount);
  }

  const category = v.categoryId ? CATEGORY_MAP[v.categoryId] : undefined;
  if (category) signal.category = category;

  // Uploader tags are the closest thing to author-supplied keywords; they are
  // untrusted, already sanitised, and merged with tokens from the title so a
  // tagless upload still contributes something.
  const fromText = contentTokens(`${v.title} ${v.description ?? ''}`);
  const keywords = [...new Set([...v.tags.map((t) => t.toLowerCase()), ...fromText])].slice(0, 12);
  if (keywords.length > 0) signal.keywords = keywords;

  return signal;
}

// ---------------------------------------------------------------------------
// Defensive readers
// ---------------------------------------------------------------------------

function readItems(payload: unknown): unknown[] {
  if (!isRecord(payload)) return [];
  const items = payload['items'];
  return Array.isArray(items) ? items : [];
}

/**
 * Google's error envelope is `{ error: { code, message, errors: [{ reason }] } }`
 * and the useful part is `errors[0].reason` ('badRequest' for an invalid key,
 * 'quotaExceeded' / 'dailyLimitExceeded' when the bucket is empty). HttpClient
 * surfaces the raw body on HttpError, so it is parsed back out here.
 */
function googleErrorReason(e: unknown): string | null {
  if (!(e instanceof HttpError)) return null;
  try {
    const parsed: unknown = JSON.parse(e.bodyText);
    if (!isRecord(parsed)) return null;
    const error = isRecord(parsed['error']) ? parsed['error'] : null;
    if (!error) return null;
    const errors = Array.isArray(error['errors']) ? error['errors'] : [];
    const first = errors.length > 0 ? errors[0] : null;
    if (isRecord(first)) {
      const reason = asString(first['reason']);
      if (reason) return reason;
    }
    return asString(error['status']);
  } catch {
    return null;
  }
}

function isCredentialError(e: unknown): boolean {
  if (!(e instanceof HttpError)) return false;
  // An invalid key is a 400 here, not a 401 — see the header comment.
  if (e.status === 401 || e.status === 403) return true;
  const reason = googleErrorReason(e);
  return e.status === 400 && (reason === 'badRequest' || reason === 'keyInvalid');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sanitiseOrNull(value: string | null, maxLength: number): string | null {
  if (!value) return null;
  const clean = sanitiseExternalText(value, maxLength);
  return clean.length > 0 ? clean : null;
}

/** statistics.* are decimal strings; tolerate a number in case that changes. */
function numericString(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

function parseTimestamp(raw: string | null): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** Uppercase, de-duplicate and drop anything that is not an ISO 3166-1 alpha-2. */
function normaliseRegions(input: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const code = raw.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code) || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out.length > 0 ? out : ['US'];
}

function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
