import { mean, sanitiseExternalText } from '@solcoin/shared';
import type { HealthState, TrendSourceId } from '@solcoin/shared';
import { systemClock, type Clock } from '../../core/clock.js';
import { safeErrorText } from '../../core/errors.js';
import { componentLogger } from '../../core/logger.js';
import { HttpClient, HttpError } from '../http.js';
import type { ProviderStatus, RawTrendSignal, TrendProvider } from '../types.js';

/**
 * GDELT DOC 2.0. Zero authentication required.
 *
 * GDELT monitors world news in 65 languages and republishes, per query, the
 * share of *all* monitored articles that mention it. That normalisation is the
 * whole reason this provider exists: every other source in the platform reports
 * an absolute count that has to be baselined against its own history before it
 * means anything, whereas GDELT's `timelinevol` values are already a fraction
 * of a global denominator and are therefore comparable across terms, across
 * days, and across languages with no further work.
 *
 * ## This is a confirmation source, not a discovery source
 *
 * **GDELT has no discovery endpoint.** There is no "what is trending" call: the
 * API only answers queries you already have. So `discover()` cannot invent
 * anything, and it does not try — it takes seed terms supplied by the caller
 * (harvested from Bluesky, Hacker News, Wikipedia, or entered by the operator)
 * and measures each one. With no seed terms it returns an empty array. That is
 * the correct behaviour, not a degraded one: fabricating queries here would mean
 * fabricating the evidence the rest of the pipeline treats as independent
 * confirmation.
 *
 * `measure()` is the primary entry point. A term that is loud on social media
 * *and* has rising news coverage is a genuinely different claim from one that
 * is only loud on social media, and SOURCE_INDEPENDENCE weights the 'news'
 * family at 0.9 for exactly that reason.
 *
 * ## Reachability
 *
 * GDELT's edge terminates TLS abruptly under load and for malformed queries:
 * the observed failure is a connection reset mid-handshake or mid-body rather
 * than an HTTP status. Some sandboxed and proxied networks see this on almost
 * every request. Every path here therefore degrades to `degraded`/`down` and an
 * empty result — a GDELT outage must never propagate as an exception, because
 * the platform is expected to run fine without it.
 *
 * GDELT also answers failures with a **plain text** body rather than JSON, so
 * responses are fetched as text and parsed here rather than trusting the
 * transport's JSON path. The two failure bodies were captured live (over port
 * 80, which this sandbox can reach) and they differ in status:
 *
 *   - a **malformed query** returns **HTTP 200** with e.g. `Your search
 *     contained a keyword that was too short.` — the transport sees a success,
 *     so only `parseGdeltBody` can catch it;
 *   - **throttling** returns **HTTP 429** with `Please limit requests to one
 *     every 5 seconds …` — the transport raises `HttpError` and never reaches
 *     `parseGdeltBody`, so the 429 is caught explicitly below.
 *
 * Both are handled, because the distinction drives the health state: a throttle
 * is a live host asking us to slow down (`degraded`), an unreachable one is not.
 */

const SOURCE: TrendSourceId = 'gdelt';

const BASE_URL = 'https://api.gdeltproject.org/api/v2/doc/';

const DOC_PATH = 'doc';

/**
 * Politeness limit.
 *
 * The task brief called this quota undocumented, but GDELT *does* state it — in
 * the body of its own throttle response, which reads "Please limit requests to
 * one every 5 seconds". One request per five seconds is 12/min, so that is the
 * ceiling used here rather than a faster guess. Burst is 2 because a single
 * `measure` is two calls (timeline + article list) and they should be allowed
 * to go out together; sustained traffic then settles back to the stated rate.
 */
const RATE_LIMIT = { requests: 12, intervalMs: 60_000, burst: 2 } as const;

/**
 * GDELT recomputes on a 15-minute ingest cycle and `timelinevol` is reported at
 * hour resolution for week-scale spans, so a 10-minute cache never hides a
 * movement while removing the repeat traffic that would otherwise trip the
 * 5-second throttle.
 */
const CACHE_TTL_MS = 10 * 60_000;

/**
 * How long to stop calling GDELT after it has told us we are over its rate.
 *
 * The stated limit is one request every five seconds; being throttled means we
 * already exceeded it, and the transport's retry ladder (sub-second jitter)
 * lands every retry back inside the same five-second window. A `discover` pass
 * measures several terms in sequence, so without a cooldown one throttle turns
 * into a burst of guaranteed-throttled follow-ups against a host that just
 * asked us to back off. Thirty seconds clears the window several times over
 * while still allowing the next scheduler tick through.
 */
const THROTTLE_COOLDOWN_MS = 30_000;

/**
 * Spans DOC 2.0 accepts. The API keeps a **rolling three-month window** and
 * nothing older, so `3m` is the hard ceiling: asking for more does not fail
 * loudly, it silently returns the same three months, which would make a longer
 * request look like a longer history than it is.
 */
const ALLOWED_TIMESPANS = ['1h', '6h', '12h', '1d', '3d', '7d', '2w', '1m', '3m'] as const;
export type GdeltTimespan = (typeof ALLOWED_TIMESPANS)[number];

/** Article-list ceiling imposed by the API. */
const MAX_ARTICLE_RECORDS = 250;

/**
 * Points averaged into `rawValue`.
 *
 * A single hourly bucket of global coverage share is extremely noisy — an
 * ordinary term flips between 0 and 0.07% hour to hour — so the headline value
 * is the mean over the trailing day rather than the last point. The last point
 * is preserved in metadata for callers that want it, and `history` carries the
 * full unsmoothed series so downstream velocity fitting sees the real data.
 */
const RAW_VALUE_TRAILING_POINTS = 24;

export interface GdeltProviderDeps {
  clock?: Clock;
  timeoutMs?: number;
  /**
   * Terms `discover()` will measure.
   *
   * GDELT answers queries and nothing else, so this is the only way discovery
   * can happen. Supply either a fixed list (operator keywords, watchlist
   * subjects) or a function the scheduler re-evaluates each pass so terms
   * harvested from the discovery-capable providers flow in automatically.
   * Omitted or empty means `discover()` returns `[]`.
   */
  seedTerms?: readonly string[] | (() => readonly string[] | Promise<readonly string[]>);
  /**
   * Ceiling on terms measured per `discover()` pass. Each term costs two
   * requests at one per five seconds, so eight terms is roughly 80 seconds of
   * wall clock — deliberately small, because this source is polled to confirm a
   * shortlist, not to sweep a corpus.
   */
  maxDiscoverTerms?: number;
  /** Window for the coverage timeline. Capped at the API's three-month retention. */
  timespan?: GdeltTimespan;
  /** Articles pulled per term for provenance and source diversity. */
  articleRecords?: number;
}

// ---------------------------------------------------------------------------
// Query construction
// ---------------------------------------------------------------------------

/**
 * GDELT's query language treats `:`, parentheses, a leading `-`, and the bare
 * words OR/AND as operators, and an unbalanced quote aborts the request at the
 * TLS layer rather than returning an error. Seed terms arrive from scraped
 * external text, so they are stripped down to plain words before use — a term
 * that tried to smuggle `domain:` or a negation would otherwise silently change
 * what we are measuring.
 *
 * A multi-word term is then wrapped in double quotes: unquoted words are ANDed
 * across the whole article, so `"labubu doll"` unquoted matches any article
 * containing both words anywhere, which is a different and much broader claim
 * than the phrase.
 */
export function buildGdeltQuery(term: string): string | null {
  const cleaned = term
    .replace(/["'`()]/g, ' ')
    .replace(/[:<>~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 3) return null;

  // Drop bare boolean keywords that would restructure the query.
  const words = cleaned.split(' ').filter((w) => !/^(and|or|not)$/i.test(w) && !w.startsWith('-'));
  if (words.length === 0) return null;

  const phrase = words.join(' ');
  if (phrase.length < 3) return null;
  // GDELT's phrase index rejects very long strings; a real trend term is short.
  const bounded = phrase.slice(0, 100).trim();
  return words.length > 1 ? `"${bounded}"` : bounded;
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

/** `"20260829T120000Z"` -> epoch milliseconds. */
export function parseGdeltDate(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isFinite(ms) ? ms : null;
}

function parseTimeline(payload: unknown): Array<{ t: number; v: number }> {
  if (!isRecord(payload)) return [];
  const timeline = payload['timeline'];
  if (!Array.isArray(timeline)) return [];
  // GDELT returns one series for a plain query ("Volume Intensity") but several
  // when the query uses a comparison operator. The first is the one our
  // single-term queries produce.
  const series = timeline.find((s) => isRecord(s) && Array.isArray(s['data']));
  if (!isRecord(series)) return [];
  const data = series['data'];
  if (!Array.isArray(data)) return [];

  const points: Array<{ t: number; v: number }> = [];
  for (const entry of data) {
    if (!isRecord(entry)) continue;
    const t = parseGdeltDate(entry['date']);
    const v = asFinite(entry['value']);
    if (t === null || v === null || v < 0) continue;
    points.push({ t, v });
  }
  points.sort((a, b) => a.t - b.t);
  return points;
}

interface GdeltArticle {
  url: string;
  title: string;
  seenAt: number | null;
  domain?: string;
  language?: string;
  country?: string;
  image?: string;
}

function parseArticles(payload: unknown): GdeltArticle[] {
  if (!isRecord(payload)) return [];
  const articles = payload['articles'];
  // A query with no coverage omits the key entirely rather than sending [].
  if (!Array.isArray(articles)) return [];

  const out: GdeltArticle[] = [];
  for (const entry of articles) {
    if (!isRecord(entry)) continue;
    const url = asNonEmptyString(entry['url']);
    const title = asNonEmptyString(entry['title']);
    if (!url || !title || !/^https?:\/\//i.test(url)) continue;

    const article: GdeltArticle = {
      url,
      title,
      seenAt: parseGdeltDate(entry['seendate']),
    };
    const domain = asNonEmptyString(entry['domain']);
    const language = asNonEmptyString(entry['language']);
    const country = asNonEmptyString(entry['sourcecountry']);
    const image = asNonEmptyString(entry['socialimage']);
    if (domain) article.domain = domain;
    if (language) article.language = language;
    if (country) article.country = country;
    if (image && /^https?:\/\//i.test(image)) article.image = image;
    out.push(article);
  }
  return out;
}

function tally(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * Most frequent keys first.
 *
 * A "top domains" list built from insertion order would just be the ten most
 * recently published articles, which says nothing about who is carrying the
 * story. Names are sanitised because `domain` and `sourcecountry` are strings
 * chosen by the publisher, not values from a closed vocabulary.
 */
function topByCount(counts: Map<string, number>, n: number): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([key]) => sanitiseExternalText(key, 80));
}

type GdeltPayload = { ok: true; value: unknown } | { ok: false; reason: string; throttled: boolean };

/**
 * GDELT answers throttling and query errors with HTTP 200 and a human-readable
 * plain-text body, so a status check is not enough to tell success from
 * failure. Anything that is not parseable JSON is treated as a failure and the
 * body is inspected only to decide whether it was a throttle (retry later) or a
 * malformed query (do not retry).
 */
function parseGdeltBody(text: string): GdeltPayload {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: 'empty response body', throttled: false };
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    const throttled = /limit requests|one every|too many|high-traffic/i.test(trimmed);
    return { ok: false, reason: trimmed.slice(0, 200), throttled };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false, reason: 'unparseable JSON body', throttled: false };
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function createGdeltProvider(deps: GdeltProviderDeps = {}): TrendProvider {
  const log = componentLogger('provider.gdelt');
  const clock = deps.clock ?? systemClock;
  const maxDiscoverTerms = Math.max(0, Math.floor(deps.maxDiscoverTerms ?? 8));
  const requestedSpan = deps.timespan ?? '7d';
  const timespan: GdeltTimespan = ALLOWED_TIMESPANS.includes(requestedSpan) ? requestedSpan : '7d';
  const articleRecords = Math.min(MAX_ARTICLE_RECORDS, Math.max(1, Math.floor(deps.articleRecords ?? 250)));

  const client = new HttpClient({
    name: 'gdelt',
    baseUrl: BASE_URL,
    rateLimit: { ...RATE_LIMIT },
    cacheTtlMs: CACHE_TTL_MS,
    timeoutMs: deps.timeoutMs ?? 25_000,
    // GDELT is slow under load and resets connections rather than answering;
    // a low breaker threshold stops the scheduler burning its budget on a host
    // that is currently refusing us, and the cooldown is long enough for the
    // upstream throttle window to clear.
    circuitThreshold: 4,
    circuitCooldownMs: 5 * 60_000,
    clock,
  });

  let lastSuccessAt: number | undefined;
  let lastFailureAt: number | undefined;
  let lastError: string | undefined;
  let lastThrottledAt: number | undefined;
  /** Epoch ms before which GDELT has told us not to call again. */
  let throttledUntil = 0;

  function recordThrottle(reason: string): void {
    const now = clock.now();
    lastFailureAt = now;
    lastThrottledAt = now;
    lastError = reason;
    throttledUntil = now + THROTTLE_COOLDOWN_MS;
  }

  async function fetchMode(
    mode: 'timelinevol' | 'artlist',
    query: string,
    extra: Record<string, string | number>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (clock.now() < throttledUntil) {
      log.debug({ mode, untilMs: throttledUntil }, 'skipping gdelt request during throttle cooldown');
      return null;
    }

    try {
      const text = await client.request<string>(DOC_PATH, {
        responseType: 'text',
        query: { query, mode, format: 'json', timespan, ...extra },
        ...(signal ? { signal } : {}),
      });
      const parsed = parseGdeltBody(text);
      if (!parsed.ok) {
        // The 200-with-text path in practice means a malformed query; the
        // throttle check stays because the body is the only thing that
        // distinguishes them and GDELT is free to change the status again.
        if (parsed.throttled) recordThrottle(parsed.reason);
        else {
          lastFailureAt = clock.now();
          lastError = parsed.reason;
        }
        log.warn({ mode, throttled: parsed.throttled, reason: parsed.reason }, 'gdelt returned a non-JSON body');
        return null;
      }
      lastSuccessAt = clock.now();
      return parsed.value;
    } catch (e) {
      // Throttling arrives as HTTP 429 with the explanation in the body, so the
      // transport raises before `parseGdeltBody` ever runs. Read it here rather
      // than reporting the host as unreachable: a host that answers is up.
      if (e instanceof HttpError && e.status === 429) {
        const reason = e.bodyText.trim().slice(0, 200) || 'rate limited (HTTP 429)';
        recordThrottle(reason);
        log.warn({ mode, reason }, 'gdelt throttled the request');
        return null;
      }
      // Otherwise the common failure is a TLS/connection reset, which
      // HttpClient has already normalised into a retryable AppError. Swallow
      // it: an unreachable GDELT is an expected operating condition.
      lastFailureAt = clock.now();
      lastError = safeErrorText(e, 200);
      log.warn({ mode, err: lastError }, 'gdelt request failed');
      return null;
    }
  }

  async function measureTerm(term: string, signal?: AbortSignal): Promise<RawTrendSignal | null> {
    const query = buildGdeltQuery(term);
    if (!query) return null;

    const observedAt = clock.now();

    // Sequential, not parallel: two concurrent calls would both reserve from a
    // two-token burst and then arrive at GDELT inside its 5-second window. The
    // timeline is also the more valuable of the two, so it goes first and the
    // article list is skipped entirely when there is no coverage to describe.
    const timelinePayload = await fetchMode('timelinevol', query, {}, signal);
    const history = parseTimeline(timelinePayload);
    if (history.length === 0) return null;

    const values = history.map((p) => p.v);
    const nonZero = values.filter((v) => v > 0);
    // A term GDELT recognises but has never seen in coverage yields an all-zero
    // series. That is a real measurement of "no news coverage", but it carries
    // no signal and would otherwise occupy a discovery slot.
    if (nonZero.length === 0) return null;

    const trailing = values.slice(-RAW_VALUE_TRAILING_POINTS);
    const rawValue = trailing.length > 0 ? mean(trailing) : 0;
    const latest = history[history.length - 1];

    const articlesPayload = await fetchMode(
      'artlist',
      query,
      { maxrecords: articleRecords, timespan: '1d' },
      signal,
    );
    const articles = parseArticles(articlesPayload);

    const domains = new Map<string, number>();
    const countries = new Map<string, number>();
    const languages = new Set<string>();
    for (const a of articles) {
      if (a.domain) tally(domains, a.domain.toLowerCase());
      if (a.country) tally(countries, a.country);
      if (a.language) languages.add(a.language);
    }

    // Most recent article first is GDELT's own ordering; use it as the summary
    // so an operator reading the signal sees what the coverage is actually about.
    const lead = articles[0];

    const signalOut: RawTrendSignal = {
      source: SOURCE,
      // Keyed on the constructed query rather than the raw term, so two seed
      // terms that normalise to the same GDELT phrase deduplicate.
      externalId: `q:${query}`,
      title: sanitiseExternalText(term, 300),
      url: `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&format=html&timespan=${timespan}`,
      // Percentage of all monitored global articles. Already normalised by
      // GDELT against its full corpus, so no local baselining is applied.
      rawValue,
      history,
      observedAt,
      // Seed terms are harvested from the discovery providers, i.e. from
      // stranger-authored text, so the keyword is sanitised and bounded like
      // any other external string rather than passed through raw.
      keywords: [sanitiseExternalText(term.toLowerCase(), 120)],
      metadata: {
        query,
        timespan,
        unit: 'percent_of_monitored_articles',
        latestValue: latest?.v ?? null,
        latestAt: latest?.t ?? null,
        peakValue: Math.max(...values),
        nonZeroBuckets: nonZero.length,
        bucketCount: history.length,
        articleCount: articles.length,
        // The article list is capped, so a full page means "at least this many"
        // and the count must not be read as a total.
        articleCountCensored: articles.length >= articleRecords,
        distinctDomains: domains.size,
        distinctCountries: countries.size,
        distinctLanguages: languages.size,
        topDomains: topByCount(domains, 10),
        topCountries: topByCount(countries, 10),
      },
    };

    if (lead) {
      // Headlines are stranger-authored text arriving from thousands of
      // uncontrolled domains; they are sanitised before they are stored.
      signalOut.summary = sanitiseExternalText(lead.title, 400);
    }

    // `engagement` and `audience` stay unset. GDELT reports coverage, not
    // readership or interaction: it knows an article exists, not that anyone
    // read it. Deriving either from article counts would be invention, and the
    // opportunity scorer already substitutes a neutral value for a missing one.

    const stage = classifyStage(history);
    if (stage) signalOut.sourceStage = stage;

    return signalOut;
  }

  async function resolveSeedTerms(): Promise<string[]> {
    const source = deps.seedTerms;
    if (!source) return [];
    try {
      const resolved = typeof source === 'function' ? await source() : source;
      if (!Array.isArray(resolved)) return [];
      const seen = new Set<string>();
      const out: string[] = [];
      for (const term of resolved) {
        if (typeof term !== 'string') continue;
        const key = term.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(term.trim());
      }
      return out;
    } catch (e) {
      log.warn({ err: safeErrorText(e, 160) }, 'seed term resolution failed');
      return [];
    }
  }

  return {
    id: 'gdelt',
    label: 'GDELT global news coverage',
    kind: 'trend',
    sourceId: SOURCE,

    async healthCheck(): Promise<ProviderStatus> {
      const started = clock.now();
      // A fixed, always-covered term keeps the probe deterministic and lets the
      // 10-minute response cache absorb repeat health checks, so this costs at
      // most one request per cache window.
      const payload = await fetchMode('timelinevol', 'climate', {}, undefined);
      const reachable = parseTimeline(payload).length > 0;

      // A throttle is a live host telling us to slow down, which is materially
      // different from an unreachable one.
      const throttled = lastThrottledAt !== undefined && clock.now() - lastThrottledAt < 10 * 60_000;

      let state: HealthState;
      if (reachable) state = 'ok';
      else if (throttled) state = 'degraded';
      else state = 'down';

      const seeded = deps.seedTerms !== undefined;
      const status: ProviderStatus = {
        id: 'gdelt',
        label: 'GDELT global news coverage',
        kind: 'trend',
        state,
        detail: reachable
          ? seeded
            ? 'DOC 2.0 reachable; discovery will measure the configured seed terms.'
            : 'DOC 2.0 reachable. No seed terms configured, so discover() returns nothing — GDELT has no discovery endpoint and only answers supplied queries. measure() is unaffected.'
          : throttled
            ? `DOC 2.0 is up but throttling us${lastError ? `: ${lastError}` : '.'} Requests are paused for ${Math.round(THROTTLE_COOLDOWN_MS / 1000)}s at a time until it clears.`
            : `DOC 2.0 unreachable${lastError ? `: ${lastError}` : '.'} GDELT resets TLS connections under load and from some sandboxed networks; the platform runs without it.`,
        // GDELT DOC 2.0 is entirely anonymous. There is no key, no signup, and
        // therefore nothing an operator could configure to change this.
        requiresCredentials: false,
        latencyMs: clock.now() - started,
      };
      if (lastSuccessAt !== undefined) status.lastSuccessAt = lastSuccessAt;
      if (lastFailureAt !== undefined) status.lastFailureAt = lastFailureAt;
      return status;
    },

    /**
     * Measure the caller's seed terms.
     *
     * Returns `[]` when no terms are configured. See the file header: this is
     * not a failure mode, it is the only honest behaviour for an API that has
     * no "what is trending" endpoint.
     */
    async discover(options: { limit: number; signal?: AbortSignal }): Promise<RawTrendSignal[]> {
      const limit = Math.max(1, Math.floor(options.limit));
      const terms = await resolveSeedTerms();
      if (terms.length === 0 || maxDiscoverTerms === 0) return [];

      const budgeted = terms.slice(0, Math.min(maxDiscoverTerms, limit));
      const out: RawTrendSignal[] = [];
      for (const term of budgeted) {
        if (options.signal?.aborted) break;
        // Serial, because the shared rate limiter would queue these anyway and
        // running them in sequence keeps a mid-pass abort from leaving
        // half-issued requests in flight.
        const signal = await measureTerm(term, options.signal);
        if (signal) out.push(signal);
      }

      return out.sort((a, b) => b.rawValue - a.rawValue).slice(0, limit);
    },

    /** The primary entry point: cross-platform confirmation for one term. */
    async measure(term: string, options: { signal?: AbortSignal }): Promise<RawTrendSignal | null> {
      const trimmed = term.trim();
      if (!trimmed) return null;
      return measureTerm(trimmed, options.signal);
    },
  };
}

/**
 * Compare the trailing quarter of the coverage series against what came before
 * it.
 *
 * Ratios rather than absolute deltas because the values are already a
 * normalised share: a term at 0.001% doubling and a term at 0.5% doubling are
 * the same event at different scales, and the stage label should say the same
 * thing about both.
 */
function classifyStage(history: ReadonlyArray<{ t: number; v: number }>): RawTrendSignal['sourceStage'] {
  if (history.length < 8) return undefined;
  const cut = Math.floor(history.length * 0.75);
  const earlier = history.slice(0, cut).map((p) => p.v);
  const recent = history.slice(cut).map((p) => p.v);
  if (earlier.length === 0 || recent.length === 0) return undefined;

  const before = mean(earlier);
  const after = mean(recent);
  // No prior coverage at all and coverage now is the clearest 'trending' case
  // there is, and the ratio below cannot express it.
  if (before <= 0) return after > 0 ? 'trending' : undefined;

  const ratio = after / before;
  if (ratio >= 1.5) return 'trending';
  if (ratio <= 0.7) return 'cooling';
  return 'saturating';
}

/** The rolling window DOC 2.0 retains. Exposed so callers do not ask for more. */
export const GDELT_MAX_TIMESPAN: GdeltTimespan = '3m';

/**
 * Buckets summarised into `rawValue`. At week-scale spans GDELT reports at hour
 * resolution, so this is a trailing day; at `1m`/`3m` it reports daily and the
 * same count covers a longer stretch. Exposed so a dashboard can label the
 * figure honestly instead of assuming hours.
 */
export const GDELT_RAW_VALUE_BUCKETS = RAW_VALUE_TRAILING_POINTS;
