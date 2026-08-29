import { clamp, detectInjection, median, sanitiseExternalText } from '@solcoin/shared';
import type { HealthState, TrendSourceId } from '@solcoin/shared';
import { systemClock, type Clock } from '../../core/clock.js';
import { safeErrorText } from '../../core/errors.js';
import { componentLogger } from '../../core/logger.js';
import { HttpClient } from '../http.js';
import type { ProviderStatus, RawTrendSignal, TrendProvider } from '../types.js';

/**
 * Mastodon / Fediverse trends. Zero authentication required.
 *
 * Why this source earns its place: `/api/v1/trends/tags` ships a **seven-day
 * daily history with every tag**, so a single request yields velocity and
 * acceleration rather than just a current level. Most social APIs make you poll
 * for hours to learn the same thing.
 *
 * Why several instances: a Mastodon server computes trends only from posts it
 * has actually federated, so `fosstodon.org` sees a FOSS-flavoured slice of the
 * network and `mastodon.social` a general-interest one. Polling a handful of
 * unrelated instances and merging turns a community-specific chart into
 * something closer to a network-wide one. It also gives fault tolerance: one
 * dead host degrades the signal instead of destroying it.
 *
 * Caveat baked into the maths below: `history[0]` is the *current, incomplete*
 * UTC day. Comparing it raw against yesterday systematically understates every
 * trend, so it is projected to a full day before any ratio is taken.
 */

const SOURCE: TrendSourceId = 'mastodon';

/**
 * Instances chosen to be large, long-lived, and *editorially unrelated* to each
 * other. mastodon.social is the flagship general instance, mstdn.social a large
 * independent generalist, fosstodon.org a technology community. Two instances
 * from the same interest niche would double-count the same population, which is
 * exactly what SOURCE_INDEPENDENCE already penalises the Fediverse family for.
 */
const DEFAULT_INSTANCES = ['mastodon.social', 'fosstodon.org', 'mstdn.social'] as const;

const DAY_MS = 86_400_000;

/** Mastodon's documented default is 300 requests / 5 minutes per IP for public
 * endpoints. 60/min keeps us at a fifth of that ceiling, which leaves room for
 * the retry budget in HttpClient without ever approaching a ban. */
const RATE_LIMIT = { requests: 60, intervalMs: 60_000, burst: 10 } as const;

/** Instances recompute trends roughly hourly; anything shorter than this is
 * spent re-downloading identical bytes. */
const CACHE_TTL_MS = 5 * 60_000;

export interface MastodonProviderDeps {
  /** Hostnames only, no scheme. Empty list ⇒ provider reports `unconfigured`. */
  instances?: readonly string[];
  clock?: Clock;
  /** Also poll `/api/v1/trends/links` (news articles). On by default. */
  includeLinks?: boolean;
  /**
   * Also poll `/api/v1/trends/statuses`. Off by default: individual posts carry
   * no history array, so they add untrusted free text without adding velocity —
   * the one thing this source is uniquely good for.
   */
  includeStatuses?: boolean;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Defensive parsing helpers. Every field below is `unknown` until proven.
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Mastodon serialises every history counter as a decimal *string*. */
function asCount(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : 0;
  if (typeof v !== 'string') return 0;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

interface HistoryPoint {
  /** UTC-midnight epoch milliseconds. */
  t: number;
  uses: number;
  accounts: number;
}

/**
 * Parse a Mastodon `history` array into oldest-first points.
 *
 * The API returns newest-first; RawTrendSignal.history is defined oldest-first
 * because every downstream kinetics routine assumes ascending time.
 */
function parseHistory(raw: unknown): HistoryPoint[] {
  if (!Array.isArray(raw)) return [];
  const points: HistoryPoint[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const daySeconds = asCount(entry['day']);
    if (daySeconds <= 0) continue;
    points.push({ t: daySeconds * 1000, uses: asCount(entry['uses']), accounts: asCount(entry['accounts']) });
  }
  points.sort((a, b) => a.t - b.t);
  return points;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    // Ampersand last, so "&amp;lt;" cannot be decoded twice into a real tag.
    .replace(/&amp;/gi, '&');
}

/**
 * Split a CamelCase / snake_case hashtag into searchable words.
 *
 * Hashtags arrive glued together (`ScreenshotSaturday`), which defeats every
 * downstream token overlap and similarity check. Splitting on case boundaries
 * recovers the words a human would have typed.
 */
function hashtagKeywords(name: string): string[] {
  const spaced = name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const seen = new Set<string>();
  for (const word of spaced.toLowerCase().split(/\s+/)) {
    if (word.length > 1) seen.add(word);
  }
  return [...seen];
}

/**
 * Scale an in-progress UTC day up to a full-day estimate.
 *
 * Without this, a tag polled at 02:00 UTC looks like it collapsed overnight.
 * The elapsed fraction is floored at 0.15 (~3.5h) so a poll just after midnight
 * cannot multiply a handful of posts into a fake explosion.
 */
function projectPartialDay(uses: number, dayStartMs: number, nowMs: number): number {
  const elapsed = (nowMs - dayStartMs) / DAY_MS;
  return uses / clamp(elapsed, 0.15, 1);
}

/**
 * Lifecycle hint from the projected current day against the preceding week.
 *
 * The median of the prior days (not the mean) is used so one viral spike three
 * days ago does not permanently mark the tag as cooling.
 */
function classifyStage(points: readonly HistoryPoint[], nowMs: number): RawTrendSignal['sourceStage'] | undefined {
  const latest = points[points.length - 1];
  if (!latest || points.length < 2) return undefined;
  const prior = points.slice(0, -1).map((p) => p.uses);
  const baseline = median(prior);
  const projected = projectPartialDay(latest.uses, latest.t, nowMs);
  // A tag with no prior history at all is brand new — that is trending, not
  // a division by zero.
  if (baseline < 1) return projected >= 1 ? 'trending' : undefined;
  const ratio = projected / baseline;
  if (ratio >= 2) return 'trending';
  if (ratio <= 0.6) return 'cooling';
  return 'saturating';
}

/**
 * Distinct posters per post, clamped to 0..1.
 *
 * `accounts / uses` answers "is this broad or is it three people spamming?".
 * It is computed on the newest day with any activity so it describes the tag
 * *now*; falling back to whole-window totals keeps it defined for a tag whose
 * current day is still empty.
 */
function computeEngagement(points: readonly HistoryPoint[]): number | undefined {
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (p && p.uses > 0) return clamp(p.accounts / p.uses, 0, 1);
  }
  const totalUses = points.reduce((acc, p) => acc + p.uses, 0);
  if (totalUses <= 0) return undefined;
  const totalAccounts = points.reduce((acc, p) => acc + p.accounts, 0);
  return clamp(totalAccounts / totalUses, 0, 1);
}

// ---------------------------------------------------------------------------
// Merge state
// ---------------------------------------------------------------------------

interface MergedTag {
  /** Display form, taken from the instance that ranked it highest. */
  displayName: string;
  url: string | null;
  instances: Set<string>;
  bestRank: number;
  /** UTC day (ms) -> best single-instance counters for that day. See `mergeDays`. */
  byDay: Map<number, { uses: number; accounts: number }>;
}

interface MergedLink {
  url: string;
  title: string;
  description: string | null;
  provider: string | null;
  publishedAtMs: number | null;
  instances: Set<string>;
  bestRank: number;
  byDay: Map<number, { uses: number; accounts: number }>;
}

interface MergedStatus {
  uri: string;
  url: string | null;
  content: string;
  createdAtMs: number | null;
  instances: Set<string>;
  bestRank: number;
  reblogs: number;
  favourites: number;
  replies: number;
}

/**
 * Fold one instance's daily counters into the merged per-day view.
 *
 * The counters are combined with `max`, not `sum`, for the same reason the
 * status counters below are: an instance counts every post carrying the tag
 * that it has federated, and the large instances federate the same posts.
 * Verified live on 2026-08-29, `#BicycleMovies` reported 574 uses on
 * mastodon.social and 571 on mstdn.social for the same UTC day — one set of
 * posts, counted twice. Summing published 1,145 for it, and worse, made
 * `rawValue` scale with the *number of instances configured*: because those
 * daily values are persisted as observations, an operator adding an instance
 * would have manufactured a step change across the stored history of every tag
 * at once, indistinguishable from a real surge.
 *
 * `max` is a lower bound on the true union. It can understate a tag whose
 * activity is genuinely split across communities, which is the honest failure
 * direction — it never invents activity that no single instance observed.
 * Breadth is not lost either: it is reported separately and truthfully as
 * `instanceCount`.
 */
function mergeDays(target: Map<number, { uses: number; accounts: number }>, points: readonly HistoryPoint[]): void {
  for (const p of points) {
    const existing = target.get(p.t);
    if (existing) {
      existing.uses = Math.max(existing.uses, p.uses);
      existing.accounts = Math.max(existing.accounts, p.accounts);
    } else {
      target.set(p.t, { uses: p.uses, accounts: p.accounts });
    }
  }
}

function toPoints(byDay: Map<number, { uses: number; accounts: number }>): HistoryPoint[] {
  return [...byDay.entries()]
    .map(([t, v]) => ({ t, uses: v.uses, accounts: v.accounts }))
    .sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface InstanceState {
  host: string;
  client: HttpClient;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastError?: string;
}

/** Reject anything that is not a bare hostname before it reaches a URL. */
function normaliseHost(input: string): string | null {
  const trimmed = input.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!trimmed || trimmed.includes('/') || trimmed.includes('@')) return null;
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function createMastodonProvider(deps: MastodonProviderDeps = {}): TrendProvider {
  const log = componentLogger('provider.mastodon');
  const clock = deps.clock ?? systemClock;
  const includeLinks = deps.includeLinks ?? true;
  const includeStatuses = deps.includeStatuses ?? false;

  const hosts: string[] = [];
  for (const raw of deps.instances ?? DEFAULT_INSTANCES) {
    const host = normaliseHost(raw);
    if (!host) {
      log.warn({ instance: raw }, 'ignoring malformed mastodon instance');
      continue;
    }
    if (!hosts.includes(host)) hosts.push(host);
  }

  // One client per instance: the rate limit, the circuit breaker and the
  // response cache are all per-host concerns. Sharing a client would let a
  // single dead instance open the breaker for the healthy ones.
  const instances: InstanceState[] = hosts.map((host) => ({
    host,
    client: new HttpClient({
      name: `mastodon:${host}`,
      baseUrl: `https://${host}/`,
      rateLimit: { ...RATE_LIMIT },
      cacheTtlMs: CACHE_TTL_MS,
      timeoutMs: deps.timeoutMs ?? 12_000,
      // Two retries only: with several instances in play, moving on is cheaper
      // than waiting out one that is struggling.
      maxRetries: 2,
      clock,
    }),
  }));

  const configured = instances.length > 0;

  async function fetchJson(state: InstanceState, path: string, limit: number, signal?: AbortSignal): Promise<unknown> {
    try {
      const result = await state.client.request<unknown>(path, {
        query: { limit },
        // 401/403 mean this instance has locked its public trends down, and 404
        // means it does not implement the endpoint. Both are permanent facts
        // about the host, not failures — accepting them keeps a configuration
        // difference from tripping the circuit breaker.
        acceptStatuses: [401, 403, 404],
        ...(signal ? { signal } : {}),
      });
      state.lastSuccessAt = clock.now();
      return result;
    } catch (e) {
      state.lastFailureAt = clock.now();
      state.lastError = safeErrorText(e, 160);
      log.warn({ instance: state.host, path, err: state.lastError }, 'mastodon instance unreachable');
      return null;
    }
  }

  function collectTags(payload: unknown, host: string, into: Map<string, MergedTag>): void {
    if (!Array.isArray(payload)) return;
    let rank = 0;
    for (const item of payload) {
      if (!isRecord(item)) continue;
      const name = asString(item['name']);
      if (!name) continue;
      rank += 1;
      const points = parseHistory(item['history']);
      // Tags federate with inconsistent casing (`Caturday` vs `caturday`), so
      // the merge key is case-folded while the display form is preserved.
      const key = name.toLowerCase();
      const existing = into.get(key);
      if (existing) {
        existing.instances.add(host);
        if (rank < existing.bestRank) {
          existing.bestRank = rank;
          existing.displayName = name;
        }
        mergeDays(existing.byDay, points);
      } else {
        const byDay = new Map<number, { uses: number; accounts: number }>();
        mergeDays(byDay, points);
        into.set(key, {
          displayName: name,
          url: asString(item['url']),
          instances: new Set([host]),
          bestRank: rank,
          byDay,
        });
      }
    }
  }

  function collectLinks(payload: unknown, host: string, into: Map<string, MergedLink>): void {
    if (!Array.isArray(payload)) return;
    let rank = 0;
    for (const item of payload) {
      if (!isRecord(item)) continue;
      const url = asString(item['url']);
      const title = asString(item['title']);
      if (!url || !title) continue;
      rank += 1;
      const points = parseHistory(item['history']);
      const published = asString(item['published_at']);
      const publishedMs = published ? Date.parse(published) : Number.NaN;
      const existing = into.get(url);
      if (existing) {
        existing.instances.add(host);
        if (rank < existing.bestRank) existing.bestRank = rank;
        mergeDays(existing.byDay, points);
      } else {
        const byDay = new Map<number, { uses: number; accounts: number }>();
        mergeDays(byDay, points);
        into.set(url, {
          url,
          title,
          description: asString(item['description']),
          provider: asString(item['provider_name']),
          publishedAtMs: Number.isFinite(publishedMs) ? publishedMs : null,
          instances: new Set([host]),
          bestRank: rank,
          byDay,
        });
      }
    }
  }

  function collectStatuses(payload: unknown, host: string, into: Map<string, MergedStatus>): void {
    if (!Array.isArray(payload)) return;
    let rank = 0;
    for (const item of payload) {
      if (!isRecord(item)) continue;
      // `uri` is the canonical, instance-independent identity of a post; `url`
      // is a presentation link that varies per instance.
      const uri = asString(item['uri']);
      const content = asString(item['content']);
      if (!uri || !content) continue;
      rank += 1;
      const created = asString(item['created_at']);
      const createdMs = created ? Date.parse(created) : Number.NaN;
      const reblogs = asCount(item['reblogs_count']);
      const favourites = asCount(item['favourites_count']);
      const replies = asCount(item['replies_count']);
      const existing = into.get(uri);
      if (existing) {
        existing.instances.add(host);
        if (rank < existing.bestRank) existing.bestRank = rank;
        // Counters are NOT summed: each instance reports its own partial view of
        // the same post's interactions, so summing would multiply one boost by
        // the number of instances that happened to see it. The best-informed
        // instance is the one with the highest count.
        existing.reblogs = Math.max(existing.reblogs, reblogs);
        existing.favourites = Math.max(existing.favourites, favourites);
        existing.replies = Math.max(existing.replies, replies);
      } else {
        into.set(uri, {
          uri,
          url: asString(item['url']),
          content,
          createdAtMs: Number.isFinite(createdMs) ? createdMs : null,
          instances: new Set([host]),
          bestRank: rank,
          reblogs,
          favourites,
          replies,
        });
      }
    }
  }

  function tagToSignal(tag: MergedTag, rank: number | null, observedAt: number): RawTrendSignal {
    const points = toPoints(tag.byDay);
    const latest = points[points.length - 1];
    const displayName = sanitiseExternalText(tag.displayName, 120);
    const signal: RawTrendSignal = {
      source: SOURCE,
      externalId: `tag:${tag.displayName.toLowerCase()}`,
      title: `#${displayName}`,
      rawValue: latest?.uses ?? 0,
      observedAt,
      history: points.map((p) => ({ t: p.t, v: p.uses })),
      // Derived from the sanitised name, not the raw one: a tag is external
      // text like any other, and keywords are persisted and reused as search
      // terms, so control and invisible characters must not survive into them.
      keywords: hashtagKeywords(displayName),
      metadata: {
        kind: 'tag',
        instances: [...tag.instances],
        instanceCount: tag.instances.size,
        bestInstanceRank: tag.bestRank,
        weekUses: points.reduce((acc, p) => acc + p.uses, 0),
        weekAccounts: points.reduce((acc, p) => acc + p.accounts, 0),
      },
    };
    // measure() has no ranked list to position the tag in, so rank stays unset
    // rather than being faked as 0.
    if (rank !== null) signal.rank = rank;
    if (tag.url) signal.url = tag.url;
    const engagement = computeEngagement(points);
    if (engagement !== undefined) signal.engagement = engagement;
    if (latest) signal.audience = latest.accounts;
    const stage = classifyStage(points, observedAt);
    if (stage) signal.sourceStage = stage;
    return signal;
  }

  function linkToSignal(link: MergedLink, rank: number, observedAt: number): RawTrendSignal | null {
    // Headlines and descriptions are attacker-controlled free text: a hostile
    // article title is the cheapest way to get instructions in front of a model.
    const title = sanitiseExternalText(link.title, 300);
    const summary = link.description ? sanitiseExternalText(link.description, 600) : null;
    const detection = detectInjection(`${title}\n${summary ?? ''}`);
    if (detection.quarantine) {
      log.warn(
        { url: link.url, score: detection.score, labels: detection.matches.map((m) => m.label) },
        'dropped mastodon link with injection-shaped text',
      );
      return null;
    }
    const points = toPoints(link.byDay);
    const latest = points[points.length - 1];
    const signal: RawTrendSignal = {
      source: SOURCE,
      externalId: `link:${link.url}`,
      title,
      url: link.url,
      rawValue: latest?.uses ?? 0,
      observedAt,
      rank,
      history: points.map((p) => ({ t: p.t, v: p.uses })),
      metadata: {
        kind: 'link',
        instances: [...link.instances],
        instanceCount: link.instances.size,
        bestInstanceRank: link.bestRank,
        publisher: link.provider ? sanitiseExternalText(link.provider, 120) : undefined,
        publishedAtMs: link.publishedAtMs ?? undefined,
        injectionScore: detection.score,
      },
    };
    if (summary) signal.summary = summary;
    const engagement = computeEngagement(points);
    if (engagement !== undefined) signal.engagement = engagement;
    if (latest) signal.audience = latest.accounts;
    const stage = classifyStage(points, observedAt);
    if (stage) signal.sourceStage = stage;
    return signal;
  }

  function statusToSignal(status: MergedStatus, rank: number, observedAt: number): RawTrendSignal | null {
    const text = sanitiseExternalText(stripHtml(status.content), 800);
    if (!text) return null;
    const detection = detectInjection(text);
    if (detection.quarantine) {
      log.warn(
        { uri: status.uri, score: detection.score, labels: detection.matches.map((m) => m.label) },
        'dropped mastodon status with injection-shaped text',
      );
      return null;
    }
    // Boosts are the strongest reach signal, favourites the weakest; replies sit
    // between because they cost more effort than a favourite but do not spread.
    const rawValue = status.reblogs * 3 + status.replies * 2 + status.favourites;
    const signal: RawTrendSignal = {
      source: SOURCE,
      externalId: `status:${status.uri}`,
      title: text.slice(0, 140),
      summary: text,
      rawValue,
      observedAt,
      rank,
      audience: status.reblogs,
      metadata: {
        kind: 'status',
        instances: [...status.instances],
        instanceCount: status.instances.size,
        bestInstanceRank: status.bestRank,
        reblogs: status.reblogs,
        favourites: status.favourites,
        replies: status.replies,
        createdAtMs: status.createdAtMs ?? undefined,
        injectionScore: detection.score,
      },
    };
    if (status.url) signal.url = status.url;
    // Interactions per boost: a post with many replies per boost is argued over
    // rather than simply spread.
    if (status.reblogs > 0) {
      signal.engagement = clamp(status.replies / (status.reblogs + status.replies), 0, 1);
    }
    return signal;
  }

  return {
    id: 'mastodon',
    label: 'Mastodon (Fediverse trends)',
    kind: 'trend',
    sourceId: SOURCE,

    async healthCheck(): Promise<ProviderStatus> {
      if (!configured) {
        return {
          id: 'mastodon',
          label: 'Mastodon (Fediverse trends)',
          kind: 'trend',
          state: 'unconfigured',
          detail: 'No Mastodon instances configured.',
          requiresCredentials: false,
          setupHint: 'Set at least one instance hostname, e.g. mastodon.social. No account or API key is needed.',
        };
      }

      const started = clock.now();
      // limit=1 is the cheapest possible probe and shares the response cache
      // with nothing, so it never masks a real outage.
      const results = await Promise.all(
        instances.map(async (state) => {
          const payload = await fetchJson(state, 'api/v1/trends/tags', 1);
          return { host: state.host, ok: Array.isArray(payload) };
        }),
      );
      const live = results.filter((r) => r.ok);
      const dead = results.filter((r) => !r.ok).map((r) => r.host);
      const state: HealthState = live.length === 0 ? 'down' : live.length === results.length ? 'ok' : 'degraded';

      const status: ProviderStatus = {
        id: 'mastodon',
        label: 'Mastodon (Fediverse trends)',
        kind: 'trend',
        state,
        detail:
          live.length === 0
            ? `No instance answered (${results.map((r) => r.host).join(', ')}).`
            : `${live.length}/${results.length} instances answering${dead.length > 0 ? `; unreachable: ${dead.join(', ')}` : ''}.`,
        requiresCredentials: false,
        latencyMs: clock.now() - started,
      };
      const lastSuccess = Math.max(0, ...instances.map((i) => i.lastSuccessAt ?? 0));
      const lastFailure = Math.max(0, ...instances.map((i) => i.lastFailureAt ?? 0));
      if (lastSuccess > 0) status.lastSuccessAt = lastSuccess;
      if (lastFailure > 0) status.lastFailureAt = lastFailure;
      return status;
    },

    async discover(options: { limit: number; signal?: AbortSignal }): Promise<RawTrendSignal[]> {
      // Contract: an unconfigured provider yields nothing and raises nothing.
      if (!configured) return [];

      const limit = Math.max(1, Math.floor(options.limit));
      const tags = new Map<string, MergedTag>();
      const links = new Map<string, MergedLink>();
      const statuses = new Map<string, MergedStatus>();

      await Promise.all(
        instances.map(async (state) => {
          // Sequential within an instance so the two or three calls share the
          // same token bucket without queuing against themselves; parallel
          // across instances because they are independent hosts.
          const tagPayload = await fetchJson(state, 'api/v1/trends/tags', 20, options.signal);
          collectTags(tagPayload, state.host, tags);

          if (includeLinks) {
            const linkPayload = await fetchJson(state, 'api/v1/trends/links', 10, options.signal);
            collectLinks(linkPayload, state.host, links);
          }
          if (includeStatuses) {
            const statusPayload = await fetchJson(state, 'api/v1/trends/statuses', 10, options.signal);
            collectStatuses(statusPayload, state.host, statuses);
          }
        }),
      );

      const observedAt = clock.now();

      const tagSignals = [...tags.values()]
        .sort((a, b) => latestUses(b.byDay) - latestUses(a.byDay) || a.bestRank - b.bestRank)
        .map((tag, index) => tagToSignal(tag, index + 1, observedAt));

      const linkSignals = [...links.values()]
        .sort((a, b) => latestUses(b.byDay) - latestUses(a.byDay) || a.bestRank - b.bestRank)
        .map((link, index) => linkToSignal(link, index + 1, observedAt))
        .filter((s): s is RawTrendSignal => s !== null);

      const statusSignals = [...statuses.values()]
        .sort((a, b) => b.reblogs + b.favourites - (a.reblogs + a.favourites) || a.bestRank - b.bestRank)
        .map((status, index) => statusToSignal(status, index + 1, observedAt))
        .filter((s): s is RawTrendSignal => s !== null);

      // Hashtags are the only part of this source with a usable history array,
      // so they get the majority of the slots. Links are supporting news
      // context; without a cap, one loud news cycle would fill the whole page.
      const tagQuota = Math.max(1, Math.round(limit * (includeStatuses ? 0.6 : 0.7)));
      const linkQuota = includeLinks ? Math.round(limit * (includeStatuses ? 0.25 : 0.3)) : 0;

      const out: RawTrendSignal[] = [
        ...tagSignals.slice(0, tagQuota),
        ...linkSignals.slice(0, linkQuota),
        ...statusSignals.slice(0, Math.max(0, limit - tagQuota - linkQuota)),
      ];

      // Backfill from whichever category has leftovers, so an instance that
      // returns no links still produces a full page of tags.
      if (out.length < limit) {
        const used = new Set(out.map((s) => s.externalId));
        for (const candidate of [...tagSignals, ...linkSignals, ...statusSignals]) {
          if (out.length >= limit) break;
          if (used.has(candidate.externalId)) continue;
          used.add(candidate.externalId);
          out.push(candidate);
        }
      }

      return out.slice(0, limit);
    },

    async measure(term: string, options: { signal?: AbortSignal }): Promise<RawTrendSignal | null> {
      if (!configured) return null;
      // Mastodon hashtags are alphanumerics and underscores only; anything else
      // cannot be a tag, so there is nothing to look up.
      const tagName = term.trim().replace(/^#/, '').replace(/[^\p{L}\p{N}_]+/gu, '');
      if (!tagName) return null;

      const merged = new Map<string, MergedTag>();
      await Promise.all(
        instances.map(async (state) => {
          // `/api/v1/tags/{name}` is public on default Mastodon configurations
          // and returns the same seven-day history object as the trends list.
          // Instances that require a token for it answer 401/403, which
          // `fetchJson` accepts rather than counting as an outage.
          const payload = await fetchJson(state, `api/v1/tags/${encodeURIComponent(tagName)}`, 1, options.signal);
          if (!isRecord(payload) || !asString(payload['name'])) return;
          collectTags([payload], state.host, merged);
        }),
      );

      const tag = merged.get(tagName.toLowerCase()) ?? [...merged.values()][0];
      if (!tag) return null;

      // Confirmed against live instances (mastodon.social, 2026-08-29):
      // `/api/v1/tags/{name}` answers 200 with a synthesised record — empty id,
      // a well-formed url, seven days of `"uses":"0"` — for a tag nobody has
      // ever posted. Returning that would hand downstream a
      // fabricated "measured zero" indistinguishable from a genuine reading, so
      // a tag with no recorded activity in the whole window is reported as
      // absent instead.
      const observed = toPoints(tag.byDay);
      if (observed.reduce((acc, p) => acc + p.uses, 0) <= 0) return null;

      return tagToSignal(tag, null, clock.now());
    },
  };
}

function latestUses(byDay: Map<number, { uses: number; accounts: number }>): number {
  let latestDay = -1;
  let uses = 0;
  for (const [day, value] of byDay) {
    if (day > latestDay) {
      latestDay = day;
      uses = value.uses;
    }
  }
  return uses;
}
