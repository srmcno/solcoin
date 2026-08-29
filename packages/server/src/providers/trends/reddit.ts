import { contentTokens, sanitiseExternalText } from '@solcoin/shared';
import type { TrendSourceId } from '@solcoin/shared';
import { systemClock, type Clock } from '../../core/clock.js';
import { safeErrorText } from '../../core/errors.js';
import { componentLogger } from '../../core/logger.js';
import { HttpClient, HttpError } from '../http.js';
import type { ProviderStatus, RawTrendSignal, TrendProvider } from '../types.js';

/**
 * Reddit — credentialed, OFF by default.
 *
 * ## Why this provider is optional and disabled unless configured
 *
 * The old zero-auth trick is dead. Appending `.json` to any Reddit URL used to
 * return the listing with no credentials at all; as of **2026-08-29 that path
 * returns HTTP 403** (verified from this host against
 * `https://www.reddit.com/r/all/rising.json`). OAuth is now mandatory for every
 * read, and obtaining an OAuth app is itself gated: app registration goes
 * through Reddit's Responsible Builder Policy approval, which a human must
 * apply for and wait on. The free tier is **100 queries per minute per OAuth
 * client** and is licensed for non-commercial use only — commercial use is
 * separately priced and negotiated. A platform that launches tokens is not
 * obviously non-commercial, so enabling this source is an operator decision
 * with licensing consequences, not a default.
 *
 * Consequently: no credentials means `state: 'unconfigured'` and an empty
 * `discover()`. That is the expected steady state for most installs, and the
 * rest of the platform is designed to run well without Reddit.
 *
 * ## Auth
 *
 *   POST https://www.reddit.com/api/v1/access_token
 *     Authorization: Basic base64(client_id:client_secret)
 *     Content-Type: application/x-www-form-urlencoded
 *     body: grant_type=client_credentials
 *     User-Agent: platform:app_id:v1.0 (by /u/username)
 *   -> { access_token, token_type: "bearer", expires_in, scope }
 *
 * The token is cached until `expires_in` minus a safety margin. Reddit rejects
 * generic or absent User-Agent strings (and rate-limits shared ones harshly),
 * so the UA is built from operator-supplied identity, never left at a default.
 * Without credentials the endpoint answers `{"message": "Unauthorized",
 * "error": 401}` — verified 2026-08-29.
 *
 * ## Rate-limit reporting
 *
 * Reddit returns `X-Ratelimit-Remaining` / `X-Ratelimit-Used` /
 * `X-Ratelimit-Reset` on every OAuth response, which would be the authoritative
 * source for `ProviderStatus.quotaRemaining`. `HttpClient` returns a parsed body
 * and deliberately does not expose the `Response`, and modifying it for one
 * provider is not a trade worth making. **So this provider reports no
 * header-derived quota.** Instead it meters its own calls against the
 * documented 100 QPM free-tier ceiling and reports that — a floor on what
 * Reddit would tell us, computed locally, never a fabricated reading of the
 * header. If header-accurate reporting is ever needed, the right fix is a
 * response-metadata hook in HttpClient, not a bare fetch here.
 */

const SOURCE_ID: TrendSourceId = 'reddit';
const CLIENT_ID_KEY = 'trends.reddit.client_id';
const CLIENT_SECRET_KEY = 'trends.reddit.client_secret';

const AUTH_BASE = 'https://www.reddit.com/';
const OAUTH_BASE = 'https://oauth.reddit.com/';

/** Documented free-tier ceiling: 100 queries per minute per OAuth client. */
const FREE_TIER_QPM = 100;

/**
 * Held back from the 100 QPM so that a health probe or a token refresh always
 * has room even when a discovery sweep is using the budget aggressively.
 */
const QPM_HEADROOM = 10;

/** Listings cap at 100 items per page; asking for more is silently truncated. */
const MAX_LISTING_LIMIT = 100;

/**
 * Refresh this long before the token actually expires. Reddit's
 * client_credentials tokens have historically been issued with
 * `expires_in: 86400`, so a 5-minute margin costs nothing and removes any
 * chance of racing an expiry mid-sweep.
 */
const TOKEN_REFRESH_MARGIN_MS = 300_000;

/** Listings change constantly; a short cache only collapses duplicate polls. */
const DEFAULT_CACHE_TTL_MS = 60_000;

/**
 * Floor on a post's age when converting score to score-per-hour.
 *
 * Without it a five-minute-old post with 10 points reads as 120 points/hour and
 * outranks a genuinely large thread. Five minutes is roughly the point at which
 * Reddit's own vote fuzzing settles enough for the number to mean anything.
 */
const MIN_AGE_HOURS = 5 / 60;

export interface RedditProviderDeps {
  getCredential: (key: string) => Promise<string | null>;
  clock?: Clock;
  /**
   * Reddit username the OAuth app is registered to. Reddit's API rules require
   * the User-Agent to identify a contactable account; supply it.
   */
  username?: string;
  /** App identifier for the User-Agent. Defaults to the platform name. */
  appId?: string;
  /** Subreddits to additionally poll via /r/{sub}/new. Operator watchlist. */
  subreddits?: readonly string[];
  timeoutMs?: number;
  cacheTtlMs?: number;
  /** Injectable clients, for tests. Correctly configured ones are built if absent. */
  authHttp?: HttpClient;
  oauthHttp?: HttpClient;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export function createRedditProvider(deps: RedditProviderDeps): TrendProvider {
  const log = componentLogger('provider.reddit');
  const clock = deps.clock ?? systemClock;
  const appId = sanitiseUaField(deps.appId) || 'solcoin';
  const username = sanitiseUaField(deps.username);
  const subreddits = normaliseSubreddits(deps.subreddits ?? []);

  /**
   * 'platform:app_id:version (by /u/username)'. The trailing clause is omitted
   * rather than filled with a placeholder when no username is configured: a
   * fake contact is worse than none, and Reddit treats a lying UA as abuse.
   */
  const userAgent = username
    ? `nodejs:${appId}:v1.0 (by /u/${username})`
    : `nodejs:${appId}:v1.0`;
  if (!username) {
    log.warn(
      {},
      'reddit provider has no configured username; the User-Agent cannot identify a contact account, which Reddit\'s API terms require',
    );
  }

  const stats: { lastSuccessAt?: number; lastFailureAt?: number; lastError?: string } = {};
  let token: CachedToken | null = null;
  /** Set when Reddit rejects the credentials, so we stop hammering the token endpoint. */
  let credentialsRejected = false;

  /** Local stand-in for the X-Ratelimit-* headers. See header comment. */
  const window = { startedAt: clock.now(), calls: 0 };

  function noteCall(): void {
    const now = clock.now();
    if (now - window.startedAt >= 60_000) {
      window.startedAt = now;
      window.calls = 0;
    }
    window.calls++;
  }

  function callsRemaining(): number {
    const now = clock.now();
    if (now - window.startedAt >= 60_000) return FREE_TIER_QPM;
    return Math.max(0, FREE_TIER_QPM - window.calls);
  }

  function windowResetAt(): number {
    return window.startedAt + 60_000;
  }

  const authHttp =
    deps.authHttp ??
    new HttpClient({
      name: 'reddit-auth',
      baseUrl: AUTH_BASE,
      timeoutMs: deps.timeoutMs ?? 15_000,
      maxRetries: 2,
      // Token exchanges are rare (one per day per process). A tight limit here
      // means a credential problem cannot turn into a login flood.
      rateLimit: { requests: 10, intervalMs: 60_000, burst: 3 },
      defaultHeaders: { 'user-agent': userAgent },
      clock,
    });

  // A separate client from the auth one on purpose: an outage on
  // www.reddit.com must not open the circuit breaker for oauth.reddit.com, and
  // the two hosts have completely different quotas.
  const oauthHttp =
    deps.oauthHttp ??
    new HttpClient({
      name: 'reddit-oauth',
      baseUrl: OAUTH_BASE,
      timeoutMs: deps.timeoutMs ?? 15_000,
      maxRetries: 2,
      rateLimit: { requests: FREE_TIER_QPM - QPM_HEADROOM, intervalMs: 60_000, burst: 10 },
      cacheTtlMs: deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
      defaultHeaders: { 'user-agent': userAgent },
      clock,
      onResult: (r) => {
        if (r.ok) stats.lastSuccessAt = clock.now();
        else {
          stats.lastFailureAt = clock.now();
          stats.lastError = r.error;
        }
      },
    });

  async function credentials(): Promise<{ id: string; secret: string } | null> {
    const [id, secret] = await Promise.all([
      deps.getCredential(CLIENT_ID_KEY),
      deps.getCredential(CLIENT_SECRET_KEY),
    ]);
    if (!id || !secret) return null;
    return { id, secret };
  }

  /** Returns a bearer token, refreshing when the cached one is near expiry. */
  async function getToken(force = false): Promise<string | null> {
    if (!force && token && token.expiresAt - TOKEN_REFRESH_MARGIN_MS > clock.now()) return token.token;

    const creds = await credentials();
    if (!creds) return null;

    const basic = Buffer.from(`${creds.id}:${creds.secret}`, 'utf8').toString('base64');
    let payload: unknown;
    try {
      noteCall();
      payload = await authHttp.request<unknown>('api/v1/access_token', {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        // Sent as a pre-encoded string so HttpClient does not JSON-serialise it;
        // this endpoint rejects a JSON body.
        body: 'grant_type=client_credentials',
      });
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        credentialsRejected = true;
        token = null;
        log.warn({ status: e.status }, 'reddit rejected the client credentials; source disabled until they change');
        return null;
      }
      throw e;
    }

    if (!isRecord(payload)) return null;
    const accessToken = asString(payload['access_token']);
    if (!accessToken) {
      // Reddit answers 200 with {"error": "invalid_grant"} for some failures.
      log.warn({ error: asString(payload['error']) ?? 'no access_token' }, 'reddit token exchange returned no token');
      return null;
    }
    const expiresIn = finiteNumber(payload['expires_in']) ?? 3600;
    token = { token: accessToken, expiresAt: clock.now() + expiresIn * 1000 };
    credentialsRejected = false;
    return accessToken;
  }

  /**
   * GET an OAuth listing path. Retries exactly once on a 401 with a fresh token,
   * because a token can be revoked server-side before its stated expiry.
   */
  async function listing(
    path: string,
    query: Record<string, string | number>,
    signal?: AbortSignal,
  ): Promise<unknown | null> {
    let bearer = await getToken();
    if (!bearer) return null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        noteCall();
        return await oauthHttp.request<unknown>(path, {
          query,
          headers: { authorization: `bearer ${bearer}` },
          ...(signal ? { signal } : {}),
        });
      } catch (e) {
        if (e instanceof HttpError && e.status === 401 && attempt === 0) {
          const refreshed = await getToken(true);
          if (!refreshed) return null;
          bearer = refreshed;
          continue;
        }
        throw e;
      }
    }
    return null;
  }

  const label = 'Reddit (OAuth)';
  const base = { id: 'reddit', label, kind: 'trend' as const, requiresCredentials: true };
  const setupHint =
    'Register a "script" app at reddit.com/prefs/apps (approval required under Reddit\'s Responsible ' +
    `Builder Policy), then store ${CLIENT_ID_KEY} and ${CLIENT_SECRET_KEY}. Free tier is 100 QPM and ` +
    'non-commercial only; commercial use is separately licensed.';

  return {
    id: 'reddit',
    label,
    kind: 'trend',
    sourceId: SOURCE_ID,

    async healthCheck(): Promise<ProviderStatus> {
      const started = clock.now();
      const creds = await credentials();
      if (!creds) {
        // The expected state for most installs.
        return {
          ...base,
          state: 'unconfigured',
          detail: 'No Reddit OAuth credentials configured; this source is inactive.',
          setupHint,
        };
      }

      const quota = { quotaRemaining: callsRemaining(), quotaResetAt: windowResetAt() };
      try {
        // limit=1 on the same listing discover() uses: one OAuth call, shares
        // the response cache with nothing else because of the differing limit.
        const payload = await listing('r/all/rising', { limit: 1, raw_json: 1 });
        if (payload === null) {
          return {
            ...base,
            state: credentialsRejected ? 'down' : 'unconfigured',
            detail: credentialsRejected
              ? 'Reddit rejected the configured client credentials.'
              : 'Reddit credentials incomplete or token exchange returned no token.',
            setupHint,
            latencyMs: clock.now() - started,
            ...quota,
            lastFailureAt: clock.now(),
          };
        }
        const posts = readChildren(payload);
        return {
          ...base,
          state: posts.length > 0 ? 'ok' : 'degraded',
          detail:
            posts.length > 0
              ? `OAuth listing reachable; ~${callsRemaining()}/${FREE_TIER_QPM} calls left this minute (locally metered, not header-derived).`
              : 'OAuth listing responded but returned no posts.',
          setupHint,
          latencyMs: clock.now() - started,
          ...quota,
          lastSuccessAt: clock.now(),
          ...(stats.lastFailureAt !== undefined ? { lastFailureAt: stats.lastFailureAt } : {}),
        };
      } catch (e) {
        const status = e instanceof HttpError ? e.status : undefined;
        return {
          ...base,
          state: status === 429 ? 'degraded' : 'down',
          detail: safeErrorText(e, 200),
          setupHint,
          latencyMs: clock.now() - started,
          ...quota,
          ...(stats.lastSuccessAt !== undefined ? { lastSuccessAt: stats.lastSuccessAt } : {}),
          lastFailureAt: clock.now(),
        };
      }
    },

    async discover(options: { limit: number; signal?: AbortSignal }): Promise<RawTrendSignal[]> {
      const want = clampInt(options.limit, 0, 1_000);
      if (want === 0) return [];

      const creds = await credentials();
      // Contract: no credentials is a state, not an error. Nothing is returned
      // and nothing is invented.
      if (!creds) return [];
      if (credentialsRejected) return [];

      const perListing = clampInt(Math.max(want, 25), 1, MAX_LISTING_LIMIT);

      /**
       * /r/all/rising is Reddit's own "accelerating right now" classification —
       * the closest thing the API has to a lifecycle hint — so items from it
       * carry sourceStage 'trending'. /r/popular/hot is a broader
       * already-established set and gets no stage, because calling it
       * 'saturating' would be a guess dressed up as source data.
       */
      const sources: Array<{ path: string; stage: RawTrendSignal['sourceStage'] | undefined }> = [
        { path: 'r/all/rising', stage: 'trending' },
        { path: 'r/popular/hot', stage: undefined },
        ...subreddits.map((sub) => ({ path: `r/${sub}/new`, stage: undefined })),
      ];

      const observedAt = clock.now();
      const byId = new Map<string, RawTrendSignal>();
      let listingsOk = 0;
      let listingsFailed = 0;
      let lastFatal: unknown = null;

      for (const source of sources) {
        if (options.signal?.aborted) break;
        if (callsRemaining() <= 0) {
          log.debug({ path: source.path }, 'reddit per-minute budget spent; ending sweep early');
          break;
        }

        let payload: unknown | null;
        try {
          // raw_json=1 stops Reddit HTML-escaping &, < and > in every text
          // field, which would otherwise land escaped in stored titles.
          payload = await listing(source.path, { limit: perListing, raw_json: 1 }, options.signal);
        } catch (e) {
          if (e instanceof HttpError && e.status >= 500) lastFatal = e;
          listingsFailed++;
          log.debug({ path: source.path, err: safeErrorText(e, 160) }, 'reddit listing failed');
          continue;
        }
        if (payload === null) return [];

        listingsOk++;
        const children = readChildren(payload);
        for (let i = 0; i < children.length; i++) {
          const signal = toSignal(children[i], source.path, source.stage, i + 1, observedAt);
          if (!signal) continue; // malformed child: skipped, not fatal
          const existing = byId.get(signal.externalId);
          // A post can appear in both rising and hot; keep whichever carries a
          // source-supplied stage, since that is the more informative reading.
          if (!existing || (!existing.sourceStage && signal.sourceStage)) byId.set(signal.externalId, signal);
        }
      }

      // Every listing failed and at least one was a server error: that is a
      // provider outage the scheduler should record, not an empty result.
      if (listingsOk === 0 && lastFatal) throw lastFatal;
      if (listingsFailed > 0) {
        log.debug({ listingsOk, listingsFailed, posts: byId.size }, 'reddit sweep completed with failures');
      }

      return [...byId.values()]
        // Score-per-hour is the whole point of the ranking: a 400-point post
        // from this morning is a colder signal than a 200-point post from an
        // hour ago.
        .sort((a, b) => b.rawValue - a.rawValue)
        .slice(0, want);
    },

    async measure(term: string, options: { signal?: AbortSignal }): Promise<RawTrendSignal | null> {
      const q = term.trim();
      if (!q) return null;

      const creds = await credentials();
      if (!creds || credentialsRejected) return null;
      if (callsRemaining() <= 0) return null;

      let payload: unknown | null;
      try {
        payload = await listing(
          'search',
          {
            q,
            // Site-wide, newest-first, last 24h: a velocity sample rather than
            // an all-time relevance ranking.
            sort: 'new',
            t: 'day',
            type: 'link',
            limit: MAX_LISTING_LIMIT,
            raw_json: 1,
          },
          options.signal,
        );
      } catch (e) {
        // A search that cannot run is "no measurement", not a platform outage.
        log.debug({ term: q, err: safeErrorText(e, 160) }, 'reddit search failed');
        return null;
      }
      if (payload === null) return null;

      const observedAt = clock.now();
      let posts = 0;
      let score = 0;
      let comments = 0;
      let oldestCreated: number | null = null;
      const subs = new Set<string>();

      for (const child of readChildren(payload)) {
        const post = readPostData(child);
        if (!post) continue;
        posts++;
        score += post.score;
        comments += post.comments;
        subs.add(post.subreddit);
        oldestCreated = oldestCreated === null ? post.createdAt : Math.min(oldestCreated, post.createdAt);
      }

      if (posts === 0) {
        return {
          source: SOURCE_ID,
          externalId: `reddit:search:${q.toLowerCase()}`,
          title: sanitiseExternalText(q, 120),
          rawValue: 0,
          observedAt,
          metadata: { matchedPosts: 0, window: 'day' },
        };
      }

      // Same normalisation as discover(): total score divided by the span the
      // sample actually covers, so a term is comparable with a single post.
      const spanHours = oldestCreated !== null ? Math.max((observedAt - oldestCreated) / 3_600_000, MIN_AGE_HOURS) : 24;

      const signal: RawTrendSignal = {
        source: SOURCE_ID,
        externalId: `reddit:search:${q.toLowerCase()}`,
        title: sanitiseExternalText(q, 120),
        rawValue: round2(score / spanHours),
        observedAt,
        metadata: {
          matchedPosts: posts,
          totalScore: score,
          totalComments: comments,
          distinctSubreddits: subs.size,
          sampleSpanHours: round2(spanHours),
          sampleTruncated: posts >= MAX_LISTING_LIMIT,
          window: 'day',
        },
      };
      if (score > 0) signal.engagement = clamp01(comments / score);
      return signal;
    },
  };
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

interface ParsedPost {
  id: string;
  title: string;
  selftext: string | null;
  score: number;
  comments: number;
  createdAt: number;
  subreddit: string;
  permalink: string | null;
  subscribers: number | null;
  upvoteRatio: number | null;
  over18: boolean;
  stickied: boolean;
  crossposts: number | null;
}

/**
 * Listing envelope: `{ data: { children: [{ kind, data: {...} }] } }`.
 * Anything that is not that shape yields an empty page rather than an error —
 * Reddit serves an HTML interstitial on some failures and it must not crash a
 * sweep.
 */
function readChildren(payload: unknown): unknown[] {
  if (!isRecord(payload)) return [];
  const data = isRecord(payload['data']) ? payload['data'] : null;
  if (!data) return [];
  const children = data['children'];
  return Array.isArray(children) ? children : [];
}

function readPostData(child: unknown): ParsedPost | null {
  if (!isRecord(child)) return null;
  const data = isRecord(child['data']) ? child['data'] : null;
  if (!data) return null;

  const id = asString(data['id']);
  const rawTitle = asString(data['title']);
  if (!id || !rawTitle) return null;

  // Post titles and bodies are the single most injection-prone input the
  // platform ingests: anonymous, long-form and deliberately attention-seeking.
  const title = sanitiseExternalText(rawTitle, 300);
  if (!title) return null;

  // `score` is the canonical field; `ups` is a legacy alias that some listings
  // still populate and that equals score on modern Reddit.
  const score = finiteNumber(data['score']) ?? finiteNumber(data['ups']) ?? 0;
  const createdUtc = finiteNumber(data['created_utc']);
  if (createdUtc === null) return null;

  const selftextRaw = asString(data['selftext']);

  return {
    id,
    title,
    selftext: selftextRaw ? sanitiseExternalText(selftextRaw, 800) : null,
    score,
    comments: finiteNumber(data['num_comments']) ?? 0,
    // created_utc is seconds since epoch, as a float.
    createdAt: createdUtc * 1000,
    subreddit: asString(data['subreddit']) ?? 'unknown',
    permalink: asString(data['permalink']),
    subscribers: finiteNumber(data['subreddit_subscribers']),
    upvoteRatio: finiteNumber(data['upvote_ratio']),
    over18: data['over_18'] === true,
    stickied: data['stickied'] === true || data['pinned'] === true,
    crossposts: finiteNumber(data['num_crossposts']),
  };
}

function toSignal(
  child: unknown,
  listingPath: string,
  stage: RawTrendSignal['sourceStage'] | undefined,
  rank: number,
  observedAt: number,
): RawTrendSignal | null {
  const post = readPostData(child);
  if (!post) return null;

  // Stickied/announcement posts sit at the top of every listing by moderator
  // decree, not by momentum. Including them would put the same subreddit rules
  // thread at rank 1 on every single poll.
  if (post.stickied) return null;

  const ageHours = Math.max((observedAt - post.createdAt) / 3_600_000, MIN_AGE_HOURS);
  const scorePerHour = post.score / ageHours;

  const signal: RawTrendSignal = {
    source: SOURCE_ID,
    externalId: `reddit:${post.id}`,
    title: post.title,
    rawValue: round2(scorePerHour),
    rank,
    observedAt,
    metadata: {
      postId: post.id,
      subreddit: post.subreddit,
      listing: listingPath,
      score: post.score,
      comments: post.comments,
      createdAt: post.createdAt,
      ageHours: round2(ageHours),
      // Not filtered here: an NSFW post is still a real signal, and the risk
      // layer downstream is where content policy is applied.
      nsfw: post.over18,
      ...(post.upvoteRatio !== null ? { upvoteRatio: post.upvoteRatio } : {}),
      ...(post.crossposts !== null ? { crossposts: post.crossposts } : {}),
    },
  };

  if (post.selftext) signal.summary = post.selftext;
  if (post.permalink) {
    // `permalink` is a site-relative path ("/r/x/comments/…"); Reddit returns
    // no absolute URL on listing children.
    const url = resolveRedditUrl(post.permalink);
    if (url) signal.url = url;
  }
  if (stage) signal.sourceStage = stage;

  /**
   * comments/score. Reddit's own convention: a thread with more comments than
   * upvotes is contentious or conversational rather than merely approved, and
   * that distinction predicts whether a topic has legs. Undefined when the
   * score is zero or negative, where the ratio is meaningless rather than high.
   */
  if (post.score > 0) signal.engagement = clamp01(post.comments / post.score);

  /**
   * Subscriber count is a ceiling on how many people could have seen the post,
   * not an impression count. It is the only reach-shaped number the listing
   * carries and is recorded as such.
   */
  if (post.subscribers !== null && post.subscribers > 0) signal.audience = post.subscribers;

  const keywords = contentTokens(`${post.title} ${post.selftext ?? ''}`).slice(0, 12);
  if (keywords.length > 0) signal.keywords = keywords;

  return signal;
}

function resolveRedditUrl(permalink: string): string | null {
  try {
    const url = new URL(permalink, 'https://www.reddit.com/');
    if (url.protocol !== 'https:' || url.hostname !== 'www.reddit.com') return null;
    return url.toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Subreddit names are [A-Za-z0-9_]{2,21}; anything else is a path-injection risk. */
function normaliseSubreddits(input: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim().replace(/^\/?r\//i, '');
    if (!/^[A-Za-z0-9_]{2,21}$/.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Keep the User-Agent to characters that cannot break the header. */
function sanitiseUaField(value: string | undefined): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
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

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round2(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}
