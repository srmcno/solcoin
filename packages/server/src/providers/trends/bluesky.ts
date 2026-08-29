import { contentTokens, sanitiseExternalText } from '@solcoin/shared';
import type { TrendCategory, TrendSourceId } from '@solcoin/shared';
import { systemClock, type Clock } from '../../core/clock.js';
import { safeErrorText } from '../../core/errors.js';
import { componentLogger } from '../../core/logger.js';
import { HttpClient, HttpError } from '../http.js';
import type { ProviderStatus, RawTrendSignal, TrendProvider } from '../types.js';

/**
 * Bluesky — public AppView, zero-auth.
 *
 * Endpoints:
 *   GET /xrpc/app.bsky.unspecced.getTrends?limit=25   (discover)
 *   GET /xrpc/app.bsky.feed.searchPosts?q=&limit=&sort=latest  (measure)
 *
 * Live observations, 2026-08-29, against https://public.api.bsky.app:
 *
 *  - getTrends returned HTTP 200 with `{ recIdStr, trends: [...] }`. Each trend
 *    carried: topic (short hex id), displayName, description, link, startedAt,
 *    postCount, status, category, actors[]. Note `recIdStr` is undocumented and
 *    is ignored here.
 *  - `link` is a RELATIVE path ("/profile/did:plc:…/feed/<topic>"), not an
 *    absolute URL, so it must be resolved against https://bsky.app.
 *  - `status` values seen in one sample were 'cooling' and **'stale'**. 'stale'
 *    is not in the documented set and is not representable in
 *    RawTrendSignal.sourceStage; it means "past cooling", so it is folded into
 *    'cooling' (see mapStage). 'hot' is emitted by some AppView versions and is
 *    the same stage as 'trending'.
 *  - `category` values seen: business, culture, entertainment, other, politics,
 *    science-tech, sports.
 *  - searchPosts returned **HTTP 403 from BunnyCDN** (an HTML error page, not an
 *    XRPC error body) for every query and parameter combination tried from this
 *    host — the endpoint is edge-gated for unauthenticated/datacenter callers
 *    while getTrends is not. measure() therefore treats 403 as "lookup not
 *    available here" and returns null rather than throwing, and its parser was
 *    written defensively against the app.bsky.feed.defs#postView lexicon rather
 *    than against a captured response.
 *
 * `status` is the highest-value field in the payload: it is Bluesky's own
 * lifecycle classification of the trend, computed from data the platform cannot
 * see, and it is mapped straight onto RawTrendSignal.sourceStage.
 */

const SOURCE_ID: TrendSourceId = 'bluesky';
const APPVIEW_BASE = 'https://public.api.bsky.app';
const WEB_BASE = 'https://bsky.app';

/**
 * The public AppView publishes no per-IP quota, but it is an unauthenticated
 * community endpoint and the polite ceiling people converge on is ~1 req/s.
 * 60/min sustained with a burst of 10 lets a discover() plus a handful of
 * measure() lookups run back-to-back without ever queueing behind the bucket.
 */
const RATE_LIMIT = { requests: 60, intervalMs: 60_000, burst: 10 } as const;

/** getTrends is capped at 25 by the lexicon; asking for more is a 400. */
const MAX_TRENDS_LIMIT = 25;
/** searchPosts caps at 100 per page. */
const MAX_SEARCH_LIMIT = 100;

/** Trends recompute on the order of minutes; 2 min keeps probes near-free. */
const DEFAULT_CACHE_TTL_MS = 120_000;

/**
 * How long a 401/403 on searchPosts suppresses further lookups.
 *
 * Long enough that a persistent edge block costs one wasted request per hour
 * instead of one per measure() call, short enough that the provider recovers on
 * its own if the block is lifted.
 */
const SEARCH_BLOCK_COOLDOWN_MS = 60 * 60_000;

/**
 * Posts/hour at which engagement saturates to ~0.5.
 *
 * Chosen from the observed sample: topics ranged from ~170 to ~4000 posts over
 * lifetimes of hours to a day, i.e. tens of posts/hour for ordinary topics and
 * hundreds for the loudest. 60/h therefore puts the median trend near the middle
 * of the 0..1 range instead of pinning everything at one end.
 */
const VELOCITY_HALF_SATURATION = 60;

export interface BlueskyProviderOptions {
  clock?: Clock;
  timeoutMs?: number;
  cacheTtlMs?: number;
  /** Override the AppView host (e.g. a self-hosted AppView). */
  baseUrl?: string;
  /** Injectable client, for tests. A correctly configured one is built if absent. */
  http?: HttpClient;
}

export function createBlueskyProvider(deps: BlueskyProviderOptions = {}): TrendProvider {
  const log = componentLogger('provider.bluesky');
  const clock = deps.clock ?? systemClock;
  const baseUrl = (deps.baseUrl ?? APPVIEW_BASE).replace(/\/+$/, '');

  const stats: { lastSuccessAt?: number; lastFailureAt?: number; lastError?: string } = {};
  /**
   * Set when searchPosts is observed to be edge-blocked, so we stop retrying it
   * on every lookup. The block is a CDN/edge policy rather than a property of
   * the query, so it is latched — but only until `searchBlockedUntil`, because
   * an edge policy can be lifted and a process that lives for weeks must not
   * disable measure() forever on the strength of one response.
   */
  let searchBlockedUntil = 0;
  const searchBlocked = (): boolean => clock.now() < searchBlockedUntil;

  const http =
    deps.http ??
    new HttpClient({
      name: 'bluesky',
      baseUrl: `${baseUrl}/`,
      timeoutMs: deps.timeoutMs ?? 15_000,
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

  async function getTrends(limit: number, signal?: AbortSignal): Promise<unknown> {
    return http.request<unknown>('xrpc/app.bsky.unspecced.getTrends', {
      query: { limit: clampInt(limit, 1, MAX_TRENDS_LIMIT) },
      ...(signal ? { signal } : {}),
    });
  }

  return {
    id: 'bluesky',
    label: 'Bluesky (public AppView)',
    kind: 'trend',
    sourceId: SOURCE_ID,

    async healthCheck(): Promise<ProviderStatus> {
      const started = clock.now();
      const base = {
        id: 'bluesky',
        label: 'Bluesky (public AppView)',
        kind: 'trend' as const,
        // The public AppView is unauthenticated by design; there is no key an
        // operator could add, so this provider is never 'unconfigured'.
        requiresCredentials: false,
      };

      try {
        // limit=1 is the cheapest form of the same call discover() makes. It
        // is a distinct URL, so it has its own cache entry rather than sharing
        // discover()'s — the point is that the probe itself costs one row.
        const payload = await getTrends(1);
        const trends = readTrendArray(payload);
        const latencyMs = clock.now() - started;
        return {
          ...base,
          state: trends.length > 0 ? 'ok' : 'degraded',
          detail:
            trends.length > 0
              ? searchBlocked()
                ? 'getTrends reachable; searchPosts blocked upstream (measure disabled until retry window)'
                : 'getTrends reachable'
              : 'getTrends responded but returned no trends',
          latencyMs,
          ...(stats.lastSuccessAt !== undefined ? { lastSuccessAt: stats.lastSuccessAt } : {}),
          ...(stats.lastFailureAt !== undefined ? { lastFailureAt: stats.lastFailureAt } : {}),
        };
      } catch (e) {
        return {
          ...base,
          state: 'down',
          detail: safeErrorText(e, 200),
          latencyMs: clock.now() - started,
          ...(stats.lastSuccessAt !== undefined ? { lastSuccessAt: stats.lastSuccessAt } : {}),
          lastFailureAt: clock.now(),
        };
      }
    },

    async discover(options: { limit: number; signal?: AbortSignal }): Promise<RawTrendSignal[]> {
      const want = clampInt(options.limit, 0, MAX_TRENDS_LIMIT);
      if (want === 0) return [];

      const payload = await getTrends(want, options.signal);
      const observedAt = clock.now();
      const raw = readTrendArray(payload);

      const out: RawTrendSignal[] = [];
      for (let i = 0; i < raw.length; i++) {
        const signal = toTrendSignal(raw[i], i + 1, observedAt);
        // A malformed entry is dropped; the rest of the page is still good data.
        if (signal) out.push(signal);
      }

      if (out.length < raw.length) {
        log.debug({ received: raw.length, kept: out.length }, 'dropped malformed bluesky trends');
      }
      return out.slice(0, want);
    },

    async measure(term: string, options: { signal?: AbortSignal }): Promise<RawTrendSignal | null> {
      const q = term.trim();
      if (!q) return null;
      // Once the edge has refused searchPosts there is nothing to retry inside
      // the cooldown: the block is per-caller, not per-query.
      if (searchBlocked()) return null;

      let payload: unknown;
      try {
        payload = await http.request<unknown>('xrpc/app.bsky.feed.searchPosts', {
          // sort=latest gives a recent-window sample, which is what a velocity
          // measurement needs; sort=top would bias towards old viral posts.
          query: { q, limit: MAX_SEARCH_LIMIT, sort: 'latest' },
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (e) {
        if (e instanceof HttpError && (e.status === 403 || e.status === 401)) {
          searchBlockedUntil = clock.now() + SEARCH_BLOCK_COOLDOWN_MS;
          log.warn(
            { status: e.status, retryAfterMs: SEARCH_BLOCK_COOLDOWN_MS },
            'bluesky searchPosts refused by the AppView edge; measure() disabled until the cooldown expires',
          );
          return null;
        }
        // A 4xx that is not retryable (400 on a malformed query, 404) is a
        // "cannot measure" answer, not a provider outage worth failing a job
        // over. A 429 or 408 is neither: the client already exhausted its
        // retries, and reporting "no data" for a term we were throttled on
        // would be a fabricated measurement, so those propagate.
        if (e instanceof HttpError && e.status < 500 && !e.retryable) {
          log.debug({ status: e.status, err: safeErrorText(e, 160) }, 'bluesky searchPosts rejected query');
          return null;
        }
        throw e;
      }

      const posts = readPostArray(payload);
      if (posts.length === 0) return null;

      const observedAt = clock.now();
      let likes = 0;
      let reposts = 0;
      let replies = 0;
      let counted = 0;
      const authors = new Set<string>();
      let newestAt: number | null = null;
      let oldestAt: number | null = null;

      for (const post of posts) {
        if (!isRecord(post)) continue;
        counted++;
        likes += finiteNumber(post['likeCount']) ?? 0;
        reposts += finiteNumber(post['repostCount']) ?? 0;
        replies += finiteNumber(post['replyCount']) ?? 0;

        const author = isRecord(post['author']) ? post['author'] : null;
        const did = author ? asString(author['did']) : null;
        if (did) authors.add(did);

        const at = parseTimestamp(asString(post['indexedAt']));
        if (at !== null) {
          newestAt = newestAt === null ? at : Math.max(newestAt, at);
          oldestAt = oldestAt === null ? at : Math.min(oldestAt, at);
        }
      }

      if (counted === 0) return null;

      // A repost is a stronger endorsement than a like (it costs the reposter
      // audience attention), and a reply is stronger still, so they are weighted
      // above raw likes before the per-post average is squashed into 0..1.
      const weighted = (likes + 2 * reposts + 1.5 * replies) / counted;
      const engagement = weighted / (weighted + 10);

      /**
       * The sampled window is the span of the page we got back. With sort=latest
       * and a full page, that window is short for a busy term and long for a
       * quiet one, which makes posts-per-hour a genuine velocity measure rather
       * than a restatement of the page size.
       */
      const windowMs = newestAt !== null && oldestAt !== null ? Math.max(newestAt - oldestAt, 0) : 0;
      const postsPerHour = windowMs > 0 ? (counted / windowMs) * 3_600_000 : null;

      const hitsTotal = finiteNumber(isRecord(payload) ? payload['hitsTotal'] : undefined);

      return {
        source: SOURCE_ID,
        externalId: `bluesky:search:${q.toLowerCase()}`,
        title: sanitiseExternalText(q, 120),
        // hitsTotal, when the AppView supplies it, is the real corpus size; the
        // sampled page count is only a floor, so prefer the former.
        rawValue: hitsTotal ?? counted,
        engagement: clamp01(engagement),
        // Distinct authors in the sample is the only audience-shaped number the
        // endpoint exposes; it is a floor, never an impression count.
        audience: authors.size,
        observedAt,
        metadata: {
          sampledPosts: counted,
          distinctAuthors: authors.size,
          likes,
          reposts,
          replies,
          ...(postsPerHour !== null ? { postsPerHour: Math.round(postsPerHour * 100) / 100 } : {}),
          ...(windowMs > 0 ? { sampleWindowMs: windowMs } : {}),
          ...(hitsTotal !== null ? { hitsTotal } : {}),
          sampleTruncated: counted >= MAX_SEARCH_LIMIT,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Bluesky's own trend-stage classification.
 *
 * 'hot' and 'trending' are the same stage under different AppView versions.
 * 'stale' was observed live and is not in any published list: it sits past
 * 'cooling', and since RawTrendSignal has no colder stage it folds into
 * 'cooling' (with the original preserved in metadata.sourceStatusRaw). Anything
 * unrecognised becomes undefined — an absent stage is honest, a guessed one is
 * a fabricated signal that would feed straight into launch decisions.
 */
function mapStage(status: string | null): RawTrendSignal['sourceStage'] | undefined {
  switch (status?.toLowerCase()) {
    case 'hot':
    case 'trending':
      return 'trending';
    case 'saturating':
    case 'saturated':
      return 'saturating';
    case 'cooling':
    case 'stale':
      return 'cooling';
    default:
      return undefined;
  }
}

/**
 * Bluesky's category vocabulary onto TrendCategory.
 *
 * 'science-tech' is one bucket upstream covering both; it maps to 'science'
 * rather than 'ai_tech' because 'ai_tech' asserts an AI/tech specificity the
 * payload does not establish, and an over-specific category biases the
 * downstream category priors.
 */
const CATEGORY_MAP: Record<string, TrendCategory> = {
  politics: 'politics_news',
  news: 'politics_news',
  business: 'finance',
  finance: 'finance',
  crypto: 'crypto_native',
  culture: 'internet_culture',
  'internet-culture': 'internet_culture',
  entertainment: 'entertainment',
  music: 'music',
  sports: 'sports',
  gaming: 'gaming',
  'video-games': 'gaming',
  'science-tech': 'science',
  science: 'science',
  tech: 'ai_tech',
  technology: 'ai_tech',
  animals: 'animals',
  food: 'food',
  other: 'other',
};

function mapCategory(raw: string | null): TrendCategory | undefined {
  if (!raw) return undefined;
  return CATEGORY_MAP[raw.toLowerCase().trim()];
}

function toTrendSignal(entry: unknown, rank: number, observedAt: number): RawTrendSignal | null {
  if (!isRecord(entry)) return null;

  const topic = asString(entry['topic']);
  const displayNameRaw = asString(entry['displayName']) ?? topic;
  if (!displayNameRaw) return null;

  const title = sanitiseExternalText(displayNameRaw, 200);
  if (!title) return null;

  const postCount = finiteNumber(entry['postCount']) ?? 0;
  const startedAt = parseTimestamp(asString(entry['startedAt']));
  const statusRaw = asString(entry['status']);
  const stage = mapStage(statusRaw);
  const category = mapCategory(asString(entry['category']));

  const descriptionRaw = asString(entry['description']);
  const summary = descriptionRaw ? sanitiseExternalText(descriptionRaw, 500) : null;

  /**
   * Posts per hour since the trend started, squashed into 0..1. Post count alone
   * conflates "loud for an hour" with "steady for a day"; velocity separates
   * them, which is exactly the distinction that matters for a launch window.
   */
  let engagement: number | undefined;
  if (startedAt !== null && postCount > 0) {
    const ageHours = Math.max((observedAt - startedAt) / 3_600_000, 1 / 60);
    const perHour = postCount / ageHours;
    engagement = clamp01(perHour / (perHour + VELOCITY_HALF_SATURATION));
  }

  // `link` is relative ("/profile/<did>/feed/<topic>"); the AppView returns no
  // absolute URL, so it is resolved against the web app.
  const link = asString(entry['link']);
  const url = link ? resolveBskyUrl(link) : null;

  const actors = Array.isArray(entry['actors']) ? entry['actors'] : [];

  const signal: RawTrendSignal = {
    source: SOURCE_ID,
    // The topic id is stable per trend; fall back to the title only when the
    // AppView omits it, so history still lines up across polls.
    externalId: `bluesky:${topic ?? title.toLowerCase()}`,
    title,
    rawValue: postCount,
    rank,
    observedAt,
    metadata: {
      topic: topic ?? null,
      ...(statusRaw ? { sourceStatusRaw: statusRaw } : {}),
      ...(startedAt !== null ? { startedAt } : {}),
      // Sample of accounts driving the trend, not a total; useful as a weak
      // "who is behind this" hint, never as an audience number.
      actorSampleCount: actors.length,
    },
  };

  if (summary) {
    signal.summary = summary;
    signal.keywords = contentTokens(`${title} ${summary}`).slice(0, 10);
  } else {
    signal.keywords = contentTokens(title).slice(0, 10);
  }
  if (url) signal.url = url;
  if (engagement !== undefined) signal.engagement = engagement;
  if (stage) signal.sourceStage = stage;
  if (category) signal.category = category;

  return signal;
}

function resolveBskyUrl(link: string): string | null {
  try {
    const url = new URL(link, `${WEB_BASE}/`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Defensive readers
// ---------------------------------------------------------------------------

function readTrendArray(payload: unknown): unknown[] {
  if (!isRecord(payload)) return [];
  const trends = payload['trends'];
  return Array.isArray(trends) ? trends : [];
}

function readPostArray(payload: unknown): unknown[] {
  if (!isRecord(payload)) return [];
  const posts = payload['posts'];
  return Array.isArray(posts) ? posts : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseTimestamp(raw: string | null): number | null {
  if (!raw) return null;
  // startedAt carries microsecond precision ("…:27.578916+00:00"); Date.parse
  // handles it, truncating to milliseconds.
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
