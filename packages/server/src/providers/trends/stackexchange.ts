import { clamp, contentTokens, sanitiseExternalText, saturating } from '@solcoin/shared';
import type { HealthState, TrendCategory, TrendSourceId } from '@solcoin/shared';
import { systemClock, type Clock } from '../../core/clock.js';
import { safeErrorText } from '../../core/errors.js';
import { componentLogger } from '../../core/logger.js';
import { HttpClient } from '../http.js';
import type { ProviderStatus, RawTrendSignal, TrendProvider } from '../types.js';

/**
 * Stack Exchange. Zero authentication required.
 *
 * This is the weakest trend source the platform carries, and it is carried
 * anyway because it is *independent*. Everything else in the 'forum' family
 * measures people talking about technology; Stack Overflow measures people
 * hitting a wall while using it. A tool that suddenly generates a wave of "how
 * do I…" questions has real adoption behind it, and that is not something an
 * announcement, a launch post, or a coordinated push can manufacture.
 * SOURCE_INDEPENDENCE weights it 0.4: it should never carry a decision on its
 * own, only corroborate one.
 *
 * ## Quota is the binding constraint
 *
 * Keyless access is **300 requests per day, per IP**, shared by everything on
 * that address. That is roughly one request every five minutes if nothing else
 * competes, so:
 *
 *   - the rate limit is a strict 10/min, which is a ceiling for bursts rather
 *     than a sustainable rate;
 *   - `discover` is a single request that pulls the full 50-question page;
 *   - `healthCheck` answers from the last observed quota rather than spending a
 *     request, and only probes when it has no recent reading;
 *   - `quota_remaining` from every response is surfaced on `ProviderStatus`, so
 *     an operator can see exhaustion coming instead of discovering it as a
 *     silent zero-result run.
 *
 * ## Transport notes
 *
 * Stack Exchange responses are **always gzip-encoded**, whatever the request
 * asks for; the documentation is explicit that a client which cannot inflate
 * gzip will get unreadable bytes. `accept-encoding: gzip` is sent to state that
 * intent, and this was verified against the live API on Node 22: undici
 * transparently inflates the body even when the header is set explicitly, and
 * `response.text()` yields plain JSON. (The `content-encoding: gzip` response
 * header survives on the Response object, so it is not a reliable way to test
 * whether inflation happened — the body is already decoded.)
 *
 * Responses carry an optional `backoff` field, in seconds, which is a hard
 * instruction rather than a hint: ignoring it is the documented route to a
 * throttle violation and then an IP block. It is honoured here by refusing to
 * issue further requests until it expires, returning empty rather than
 * erroring.
 */

const SOURCE: TrendSourceId = 'stackexchange';

const BASE_URL = 'https://api.stackexchange.com/2.3/';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Deliberately strict. With 300 requests a day the limiter is not there to
 * pace a high-throughput consumer — it is there so that a retry loop or a
 * misconfigured schedule cannot burn a day's quota in under a minute.
 */
const RATE_LIMIT = { requests: 10, intervalMs: 60_000, burst: 3 } as const;

/**
 * The hot list turns over on the order of tens of minutes, and every cache hit
 * is a request not spent, so this is set far longer than for the unmetered
 * sources.
 */
const CACHE_TTL_MS = 10 * 60_000;

/** Keyless daily quota, for the "used" figure on the status card. */
const KEYLESS_DAILY_QUOTA = 300;

/** How long a quota reading stays good enough to answer a health check from. */
const QUOTA_FRESH_MS = 15 * 60_000;

/** Lookback for `measure`, matching the rolling quarter other providers use. */
const MEASURE_WINDOW_DAYS = 90;

/**
 * Interaction-per-view rate at which a question is "normally" engaging.
 *
 * Sampled from the live hot list: a typical question accumulates roughly one
 * answer or vote per 25 views, i.e. a ratio near 0.04. Using that as the knee
 * of the saturating curve puts an ordinary question at 0.5 and reserves the
 * upper half of the range for questions people are actually piling into.
 */
const ENGAGEMENT_KNEE = 0.04;

export interface StackExchangeProviderDeps {
  clock?: Clock;
  timeoutMs?: number;
  /** Stack Exchange site to read. Stack Overflow is the developer-adoption signal. */
  site?: string;
  /** Questions per page. 50 is the sweet spot: one request, plenty of tail. */
  pageSize?: number;
  /**
   * Optional API key. Not required — everything here works keyless — but a
   * registered key raises the quota from 300/day to 10,000/day, which is the
   * only thing that makes frequent polling viable.
   */
  apiKey?: string;
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

/**
 * Stack Exchange HTML-escapes question titles: the live API returns
 * `wasn&#39;t` and `PDF&#39;s`. Decoding happens before sanitising so that a
 * title which encoded `&lt;system&gt;` is neutralised by the sanitiser rather
 * than stored as an escaped tag that some later renderer might decode.
 */
function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_m, hex: string) => codePointOrEmpty(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (_m, dec: string) => codePointOrEmpty(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Ampersand last, or "&amp;lt;" would decode twice into a real tag.
    .replace(/&amp;/g, '&');
}

function codePointOrEmpty(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
  if (code >= 0xd800 && code <= 0xdfff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

interface SeQuestion {
  id: string;
  title: string;
  link: string;
  score: number;
  views: number;
  answers: number;
  createdAtSec: number;
  tags: string[];
}

function parseQuestion(raw: unknown): SeQuestion | null {
  if (!isRecord(raw)) return null;

  const id = asFinite(raw['question_id']);
  const title = asNonEmptyString(raw['title']);
  const createdAtSec = asFinite(raw['creation_date']);
  if (id === null || !title || createdAtSec === null || createdAtSec <= 0) return null;

  const score = asFinite(raw['score']);
  const views = asFinite(raw['view_count']);
  const answers = asFinite(raw['answer_count']);
  const link = asNonEmptyString(raw['link']);

  const tags: string[] = [];
  const rawTags = raw['tags'];
  if (Array.isArray(rawTags)) {
    for (const tag of rawTags) {
      if (typeof tag !== 'string' || tag.length === 0) continue;
      // Tags come from a user-created vocabulary, and they are carried into
      // `keywords` without passing through `contentTokens`, so they are
      // sanitised and length-bounded here rather than trusted as-is.
      const clean = sanitiseExternalText(tag.toLowerCase(), 60);
      if (clean.length > 0) tags.push(clean);
    }
  }

  return {
    id: String(id),
    title,
    // The canonical link is normally present; synthesising it from the id is a
    // safe fallback because Stack Overflow resolves the bare question URL.
    link: link && /^https?:\/\//i.test(link) ? link : `https://stackoverflow.com/q/${id}`,
    score: score ?? 0,
    views: views !== null && views >= 0 ? views : 0,
    answers: answers !== null && answers >= 0 ? answers : 0,
    createdAtSec,
    tags,
  };
}

interface SeEnvelope {
  items: SeQuestion[];
  quotaRemaining?: number;
  quotaMax?: number;
  backoffSeconds?: number;
  errorMessage?: string;
}

function parseEnvelope(payload: unknown): SeEnvelope {
  if (!isRecord(payload)) return { items: [] };

  const out: SeEnvelope = { items: [] };

  const rawItems = payload['items'];
  if (Array.isArray(rawItems)) {
    for (const item of rawItems) {
      const question = parseQuestion(item);
      if (question) out.items.push(question);
    }
  }

  const quotaRemaining = asFinite(payload['quota_remaining']);
  const quotaMax = asFinite(payload['quota_max']);
  const backoff = asFinite(payload['backoff']);
  // Errors arrive as HTTP 400 with this body shape, e.g. error_id 502
  // (throttle violation) or 503 (access denied).
  const errorMessage = asNonEmptyString(payload['error_message']) ?? asNonEmptyString(payload['error_name']);

  if (quotaRemaining !== null && quotaRemaining >= 0) out.quotaRemaining = quotaRemaining;
  if (quotaMax !== null && quotaMax > 0) out.quotaMax = quotaMax;
  if (backoff !== null && backoff > 0) out.backoffSeconds = backoff;
  if (errorMessage) out.errorMessage = errorMessage;

  return out;
}

// ---------------------------------------------------------------------------
// Derived measures
// ---------------------------------------------------------------------------

/**
 * Floor on age, for the same reason as elsewhere in the platform: a question
 * posted two minutes ago with eleven views would otherwise report 330
 * views/hour and outrank everything real on the page.
 */
const MIN_AGE_HOURS = 1;

function ageHours(question: SeQuestion, observedAt: number): number {
  return Math.max(MIN_AGE_HOURS, (observedAt - question.createdAtSec * 1000) / HOUR_MS);
}

/**
 * Answers and votes are the only interactions Stack Exchange exposes, and views
 * are the denominator. `Math.abs` on the score because a heavily downvoted
 * question is still a question people reacted to — for our purposes that is
 * attention, not quality.
 */
function engagementOf(question: SeQuestion): number | undefined {
  if (question.views <= 0) return undefined;
  const interactions = question.answers + Math.abs(question.score);
  return clamp(saturating(interactions / question.views, ENGAGEMENT_KNEE), 0, 1);
}

/**
 * Tag-driven routing. Stack Overflow is a programming site, so `ai_tech` is the
 * honest default; the exceptions are the tag families the concept generator
 * treats differently.
 */
const TAG_CATEGORIES: Array<{ category: TrendCategory; tags: RegExp }> = [
  { category: 'crypto_native', tags: /^(solana|ethereum|blockchain|web3|solidity|bitcoin|smart-contracts|nft)$/ },
  { category: 'gaming', tags: /^(unity3d|unity-game-engine|unreal-engine|godot|game-development|pygame|roblox)$/ },
  { category: 'finance', tags: /^(quantitative-finance|trading|stripe-payments|accounting)$/ },
  { category: 'science', tags: /^(bioinformatics|astronomy|physics|computational-geometry|statistics)$/ },
];

function classifyCategory(tags: readonly string[]): TrendCategory {
  for (const rule of TAG_CATEGORIES) {
    if (tags.some((tag) => rule.tags.test(tag))) return rule.category;
  }
  return 'ai_tech';
}

function nextUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + DAY_MS;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function createStackExchangeProvider(deps: StackExchangeProviderDeps = {}): TrendProvider {
  const log = componentLogger('provider.stackexchange');
  const clock = deps.clock ?? systemClock;
  const site = deps.site ?? 'stackoverflow';
  const pageSize = Math.min(100, Math.max(1, Math.floor(deps.pageSize ?? 50)));
  const apiKey = deps.apiKey?.trim() || undefined;

  const client = new HttpClient({
    name: 'stackexchange',
    baseUrl: BASE_URL,
    rateLimit: { ...RATE_LIMIT },
    cacheTtlMs: CACHE_TTL_MS,
    timeoutMs: deps.timeoutMs ?? 15_000,
    clock,
    defaultHeaders: {
      // Stack Exchange gzips every response regardless; declaring it makes the
      // expectation explicit. Node's fetch inflates transparently — see the
      // transport note in the file header.
      'accept-encoding': 'gzip',
    },
  });

  let lastSuccessAt: number | undefined;
  let lastFailureAt: number | undefined;
  let lastError: string | undefined;
  let quotaRemaining: number | undefined;
  let quotaMax: number | undefined;
  let quotaObservedAt: number | undefined;
  /** Epoch ms before which the API has told us not to call again. */
  let backoffUntil = 0;

  function applyEnvelope(envelope: SeEnvelope): void {
    if (envelope.quotaRemaining !== undefined) {
      quotaRemaining = envelope.quotaRemaining;
      quotaObservedAt = clock.now();
    }
    if (envelope.quotaMax !== undefined) quotaMax = envelope.quotaMax;
    if (envelope.backoffSeconds !== undefined) {
      backoffUntil = clock.now() + envelope.backoffSeconds * 1000;
      log.warn({ seconds: envelope.backoffSeconds }, 'stack exchange requested backoff');
    }
  }

  /**
   * Every call goes through here so quota, backoff and the JSON error envelope
   * are handled in exactly one place. Returns `null` for any failure — a source
   * this weak is never worth propagating an exception for.
   */
  async function get(
    path: string,
    query: Record<string, string | number>,
    signal?: AbortSignal,
  ): Promise<SeEnvelope | null> {
    if (clock.now() < backoffUntil) {
      log.debug({ path, untilMs: backoffUntil }, 'skipping request during requested backoff');
      return null;
    }

    try {
      const payload = await client.request<unknown>(path, {
        query: { site, ...query, ...(apiKey ? { key: apiKey } : {}) },
        // Errors come back as 400 with a structured body worth reading; letting
        // the transport throw would discard the error_id and the quota figure.
        acceptStatuses: [400],
        ...(signal ? { signal } : {}),
      });

      const envelope = parseEnvelope(payload);
      applyEnvelope(envelope);

      if (envelope.errorMessage) {
        lastFailureAt = clock.now();
        lastError = envelope.errorMessage;
        log.warn({ path, err: lastError }, 'stack exchange returned an error envelope');
        return null;
      }

      lastSuccessAt = clock.now();
      return envelope;
    } catch (e) {
      lastFailureAt = clock.now();
      lastError = safeErrorText(e, 200);
      log.warn({ path, err: lastError }, 'stack exchange request failed');
      return null;
    }
  }

  function buildSignal(question: SeQuestion, observedAt: number, apiRank: number): RawTrendSignal {
    const age = ageHours(question, observedAt);
    const viewsPerHour = question.views / age;
    const title = sanitiseExternalText(decodeHtmlEntities(question.title), 300);
    const engagement = engagementOf(question);

    const signal: RawTrendSignal = {
      source: SOURCE,
      externalId: question.id,
      title,
      url: question.link,
      // Views are the platform-native magnitude here: score on a fresh question
      // is almost always 0 or 1 and carries essentially no information, whereas
      // views separate a question thousands of people hit from one nobody did.
      rawValue: question.views,
      // Unlike votes, a view really is one arrival, so this is a direct reach
      // figure rather than an estimate.
      audience: question.views,
      rank: apiRank,
      observedAt,
      category: classifyCategory(question.tags),
      // Tags first: they are Stack Overflow's own curated vocabulary and are far
      // cleaner keywords than anything extracted from the title.
      keywords: [...new Set([...question.tags, ...contentTokens(title)])].slice(0, 15),
      metadata: {
        score: question.score,
        views: question.views,
        answers: question.answers,
        viewsPerHour,
        ageHours: age,
        createdAtMs: question.createdAtSec * 1000,
        tags: question.tags,
        site,
        /**
         * The API's own list position under `sort=hot`. Recorded but weak:
         * against the live endpoint this ordering was observed to track
         * creation time rather than any hotness score (top-of-page questions
         * came back with scores of 0 and view counts in the tens), so
         * `discover` re-sorts by view velocity before returning.
         */
        apiRank,
        apiSort: 'hot',
      },
    };

    if (engagement !== undefined) signal.engagement = engagement;

    // Stack Overflow publishes no per-question time series and no lifecycle
    // hint, so `history` and `sourceStage` stay unset rather than being
    // reconstructed from a single observation.

    return signal;
  }

  return {
    id: 'stackexchange',
    label: 'Stack Exchange hot questions',
    kind: 'trend',
    sourceId: SOURCE,

    async healthCheck(): Promise<ProviderStatus> {
      const started = clock.now();

      // Answer from the last observed quota where possible. A health probe that
      // spends 1 of 300 daily requests every time the dashboard refreshes is
      // itself the outage.
      const fresh = quotaObservedAt !== undefined && clock.now() - quotaObservedAt < QUOTA_FRESH_MS;
      if (!fresh) {
        // `/info` is the cheapest endpoint that still reports quota, and it is
        // cached for ten minutes like everything else here.
        await get('info', {});
      }

      let state: HealthState;
      if (clock.now() < backoffUntil) state = 'degraded';
      else if (quotaRemaining !== undefined && quotaRemaining <= 0) state = 'degraded';
      else if (lastSuccessAt === undefined) state = 'down';
      else if (lastFailureAt !== undefined && lastFailureAt > lastSuccessAt) state = 'degraded';
      else state = 'ok';

      const max = quotaMax ?? KEYLESS_DAILY_QUOTA;
      const detail =
        quotaRemaining !== undefined
          ? `${quotaRemaining}/${max} requests remaining today${apiKey ? ' (keyed)' : ' (keyless, shared per IP)'}.` +
            (clock.now() < backoffUntil ? ` Backing off until ${new Date(backoffUntil).toISOString()}.` : '')
          : `No quota reading yet${lastError ? `: ${lastError}` : '.'}`;

      const status: ProviderStatus = {
        id: 'stackexchange',
        label: 'Stack Exchange hot questions',
        kind: 'trend',
        state,
        detail,
        // Keyless access is fully functional, so this provider is never
        // 'unconfigured' — a key only raises the ceiling.
        requiresCredentials: false,
        setupHint:
          'Optional: register an app at stackapps.com and set the API key to raise the quota from 300/day to 10,000/day.',
        latencyMs: clock.now() - started,
      };
      if (quotaRemaining !== undefined) {
        status.quotaRemaining = quotaRemaining;
        // Stack Exchange resets the daily allowance at UTC midnight.
        status.quotaResetAt = nextUtcMidnight(clock.now());
      }
      if (lastSuccessAt !== undefined) status.lastSuccessAt = lastSuccessAt;
      if (lastFailureAt !== undefined) status.lastFailureAt = lastFailureAt;
      return status;
    },

    async discover(options: { limit: number; signal?: AbortSignal }): Promise<RawTrendSignal[]> {
      const limit = Math.max(1, Math.floor(options.limit));
      const envelope = await get(
        'questions',
        { order: 'desc', sort: 'hot', pagesize: pageSize },
        options.signal,
      );
      if (!envelope || envelope.items.length === 0) return [];

      const observedAt = clock.now();
      return envelope.items
        .map((question, index) => buildSignal(question, observedAt, index + 1))
        // Re-sorted by view velocity because the API's `hot` ordering did not
        // hold up against the live endpoint (see the `apiRank` note). The
        // source's own position is preserved in `rank` and `metadata.apiRank`,
        // so nothing is hidden — only the order we hand downstream changes.
        .sort((a, b) => {
          const av = (a.metadata?.['viewsPerHour'] as number | undefined) ?? 0;
          const bv = (b.metadata?.['viewsPerHour'] as number | undefined) ?? 0;
          return bv - av;
        })
        .slice(0, limit);
    },

    /**
     * Aggregate developer attention for a term over the last quarter.
     *
     * One request against `/search/advanced`, which is the only endpoint that
     * takes free text. Costs 1 of the 300 daily requests, so callers should
     * measure a shortlist, not a corpus.
     */
    async measure(term: string, options: { signal?: AbortSignal }): Promise<RawTrendSignal | null> {
      const trimmed = term.trim();
      if (!trimmed) return null;

      const observedAt = clock.now();
      const fromDate = Math.floor((observedAt - MEASURE_WINDOW_DAYS * DAY_MS) / 1000);

      const envelope = await get(
        'search/advanced',
        {
          q: trimmed,
          order: 'desc',
          sort: 'votes',
          pagesize: pageSize,
          fromdate: fromDate,
        },
        options.signal,
      );
      // A failed call and a term with no questions are different facts, but
      // both mean "no evidence from this source", and null says exactly that.
      if (!envelope || envelope.items.length === 0) return null;

      const questions = envelope.items;
      const totalViews = questions.reduce((acc, q) => acc + q.views, 0);
      const totalAnswers = questions.reduce((acc, q) => acc + q.answers, 0);
      const totalScore = questions.reduce((acc, q) => acc + q.score, 0);

      // Bucket by creation day: a term's question flow over the quarter is the
      // adoption curve, and downstream can fit a slope to it.
      const buckets = new Map<number, number>();
      for (const q of questions) {
        const day = Math.floor((q.createdAtSec * 1000) / DAY_MS) * DAY_MS;
        buckets.set(day, (buckets.get(day) ?? 0) + 1);
      }
      const history = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));

      const top = questions.reduce((best, q) => (q.views > best.views ? q : best));
      const tags = [...new Set(questions.flatMap((q) => q.tags))];

      const signal: RawTrendSignal = {
        source: SOURCE,
        externalId: `search:${trimmed.toLowerCase()}`,
        title: sanitiseExternalText(trimmed, 300),
        summary: sanitiseExternalText(decodeHtmlEntities(top.title), 300),
        url: `https://stackoverflow.com/search?q=${encodeURIComponent(trimmed)}`,
        // Total views across matching questions — the same unit as `discover`.
        rawValue: totalViews,
        audience: totalViews,
        history,
        observedAt,
        category: classifyCategory(tags),
        keywords: [...new Set([...tags.slice(0, 10), ...contentTokens(trimmed)])].slice(0, 15),
        metadata: {
          lookup: true,
          questionCount: questions.length,
          // The page is capped, so this is a floor on matching questions.
          questionCountCensored: questions.length >= pageSize,
          totalViews,
          totalAnswers,
          totalScore,
          windowDays: MEASURE_WINDOW_DAYS,
          topQuestionId: top.id,
          site,
        },
      };

      if (totalViews > 0) {
        signal.engagement = clamp(
          saturating((totalAnswers + Math.abs(totalScore)) / totalViews, ENGAGEMENT_KNEE),
          0,
          1,
        );
      }

      return signal;
    },
  };
}
