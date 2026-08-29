import { mad, median, sanitiseExternalText } from '@solcoin/shared';
import type { HealthState, TrendSourceId } from '@solcoin/shared';
import { systemClock, type Clock } from '../../core/clock.js';
import { safeErrorText } from '../../core/errors.js';
import { componentLogger } from '../../core/logger.js';
import { HttpClient } from '../http.js';
import type { ProviderStatus, RawTrendSignal, TrendProvider } from '../types.js';

/**
 * Wikimedia pageviews. Zero authentication required.
 *
 * This is the platform's best *confirmation* signal rather than its best
 * discovery signal. Social platforms tell you what people are saying; Wikipedia
 * tells you what they went and looked up afterwards. That second act costs
 * deliberate effort, is almost impossible to astroturf at scale, and is drawn
 * from a population that has essentially no overlap with the Fediverse — which
 * is why SOURCE_INDEPENDENCE weights it at 0.95.
 *
 * Two endpoints, and the agent filter behind them had to be established by
 * measurement rather than from the docs:
 *
 *   - the `top` list takes no `agent` path segment at all, so its filtering is
 *     undocumented at the call site;
 *   - the `per-article` series is requested with `agent=user`, which strips
 *     spiders and known bots.
 *
 * Checked against live data for 2026-08-28, the top-list figure equals the
 * `agent=user` per-article figure exactly — Dolly_Parton 646,774, Toxic_(2026_film)
 * 572,046, Tim_Curry 471,537, Peter_Cullen 362,893, .xyz 304,832 — while
 * `agent=all-agents` for the same articles runs 3-6% higher (679,928 / 608,650 /
 * 489,241 / 380,495). The top list is therefore already bot-filtered and is the
 * same quantity as the history series, which is what makes it sound to publish
 * `rawValue` from the top list and `history` from the per-article call: a
 * downstream velocity taken across both is comparing like with like. Should
 * Wikimedia ever change that, the two would silently diverge, so the agent
 * behind each number is recorded in metadata rather than assumed.
 */

const SOURCE: TrendSourceId = 'wikipedia';

const BASE_URL = 'https://wikimedia.org/api/rest_v1/';

const DAY_MS = 86_400_000;

/**
 * Wikimedia documents ~200 req/s for authenticated REST clients and asks
 * anonymous clients to stay well below that. 100/min is a deliberately
 * conservative ceiling: `discover` never needs more than ~20 calls, so the
 * limiter exists to stop a retry storm or a misconfigured scheduler from ever
 * looking like abuse of a free public service.
 */
const RATE_LIMIT = { requests: 100, intervalMs: 60_000, burst: 25 } as const;

/**
 * Pageview aggregates are recomputed once a day and never change afterwards,
 * so a long cache costs nothing in freshness and removes almost all repeat
 * traffic across the jobs that share this provider.
 */
const CACHE_TTL_MS = 30 * 60_000;

/** Days of history pulled per article for the robust baseline. */
const HISTORY_DAYS = 30;

/**
 * Namespace prefixes that are site machinery, not subjects people are
 * interested in. `Special:Search` and `Wikipedia:Featured_pictures` outrank most
 * real articles every single day; treating them as trends would poison the
 * entire pipeline.
 */
const ADMIN_PREFIXES = ['Special:', 'Wikipedia:', 'Portal:', 'Help:', 'Category:', 'File:', 'Talk:'] as const;

/** Exact titles that are structural rather than topical. */
const ADMIN_EXACT = new Set(['Main_Page', '-']);

export interface WikipediaProviderDeps {
  clock?: Clock;
  /**
   * Contact string embedded in the User-Agent. Wikimedia's UA policy asks for a
   * way to reach the operator; supply a real URL or address so they can ask you
   * to back off instead of silently blocking the IP.
   */
  contact?: string;
  /** Wikimedia project to read. Defaults to English Wikipedia. */
  project?: string;
  /**
   * How many of the day's top articles get a per-article history call. See the
   * budget note on `discover`.
   */
  velocityCandidates?: number;
  timeoutMs?: number;
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

interface TopArticle {
  article: string;
  views: number;
  rank: number;
}

function parseTopArticles(payload: unknown): TopArticle[] {
  if (!isRecord(payload)) return [];
  const items = payload['items'];
  if (!Array.isArray(items)) return [];
  const first = items[0];
  if (!isRecord(first)) return [];
  const articles = first['articles'];
  if (!Array.isArray(articles)) return [];

  const out: TopArticle[] = [];
  for (const entry of articles) {
    if (!isRecord(entry)) continue;
    const article = entry['article'];
    if (typeof article !== 'string' || article.length === 0) continue;
    const views = asFinite(entry['views']);
    if (views === null || views < 0) continue;
    const rank = asFinite(entry['rank']);
    out.push({ article, views, rank: rank ?? out.length + 1 });
  }
  return out;
}

/** `"2026080100"` -> UTC-midnight epoch milliseconds. */
function parseSeriesTimestamp(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^\d{10}$/.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const ms = Date.UTC(year, month - 1, day);
  return Number.isFinite(ms) ? ms : null;
}

function parseSeries(payload: unknown): Array<{ t: number; v: number }> {
  if (!isRecord(payload)) return [];
  const items = payload['items'];
  if (!Array.isArray(items)) return [];
  const points: Array<{ t: number; v: number }> = [];
  for (const entry of items) {
    if (!isRecord(entry)) continue;
    const t = parseSeriesTimestamp(entry['timestamp']);
    const v = asFinite(entry['views']);
    if (t === null || v === null || v < 0) continue;
    points.push({ t, v });
  }
  points.sort((a, b) => a.t - b.t);
  return points;
}

function isAdministrative(article: string): boolean {
  if (ADMIN_EXACT.has(article)) return true;
  return ADMIN_PREFIXES.some((prefix) => article.startsWith(prefix));
}

function utcParts(ms: number): { y: string; m: string; d: string } {
  const date = new Date(ms);
  return {
    y: String(date.getUTCFullYear()),
    m: String(date.getUTCMonth() + 1).padStart(2, '0'),
    d: String(date.getUTCDate()).padStart(2, '0'),
  };
}

function compactDate(ms: number): string {
  const { y, m, d } = utcParts(ms);
  return `${y}${m}${d}`;
}

/**
 * `Toxic_(2026_film)` -> `Toxic (2026 film)`.
 *
 * The underscored form stays the canonical identity: it is what the API needs,
 * and it is unique where a spaced title could collide after normalisation.
 */
function humanTitle(article: string): string {
  return article.replace(/_/g, ' ');
}

/**
 * `dolly_parton` -> `Dolly_Parton`, the spelling Wikipedia uses for most
 * multi-word subjects. Only the leading character of each word is touched, so
 * interior capitals survive (`macos_sequoia` -> `Macos_Sequoia`, and
 * `iPhone_16` -> `IPhone_16`, which is what Wikipedia's own URL form uses).
 */
function titleCase(underscored: string): string {
  return underscored.replace(/(^|_)(\p{L})/gu, (_match, separator: string, ch: string) => separator + ch.toUpperCase());
}

/**
 * Keywords drop the parenthetical disambiguator, which is Wikipedia editorial
 * bookkeeping rather than part of what people are actually searching for.
 *
 * Takes the already-sanitised human title rather than the raw article id: an
 * article title is external text, and keywords are persisted and reused as
 * search terms, so nothing unsanitised may reach them.
 */
function articleKeywords(humanisedTitle: string): string[] {
  const base = humanisedTitle.replace(/\s*\([^)]*\)\s*$/, '');
  const seen = new Set<string>();
  for (const word of base.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length > 1) seen.add(word);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function createWikipediaProvider(deps: WikipediaProviderDeps = {}): TrendProvider {
  const log = componentLogger('provider.wikipedia');
  const clock = deps.clock ?? systemClock;
  const project = deps.project ?? 'en.wikipedia';
  const contact = deps.contact ?? 'https://github.com/solcoin';
  const velocityCandidates = Math.max(0, Math.floor(deps.velocityCandidates ?? 15));

  const client = new HttpClient({
    name: 'wikipedia',
    baseUrl: BASE_URL,
    rateLimit: { ...RATE_LIMIT },
    cacheTtlMs: CACHE_TTL_MS,
    timeoutMs: deps.timeoutMs ?? 15_000,
    clock,
    defaultHeaders: {
      // Wikimedia's UA policy is enforced: generic or absent User-Agents get
      // throttled or 403'd. `Api-User-Agent` is the header their REST gateway
      // reads when the transport owns `User-Agent`, so both are set.
      'user-agent': `solcoin/0.1 (trend research; ${contact})`,
      'api-user-agent': `solcoin/0.1 (trend research; ${contact})`,
    },
  });

  let lastSuccessAt: number | undefined;
  let lastFailureAt: number | undefined;
  let lastError: string | undefined;

  /**
   * Fetch, treating 404 as "no data for this key" rather than an outage.
   *
   * 404 is a *routine* answer here: yesterday's aggregate may not be published
   * yet, and a per-article series 404s for any title Wikipedia does not have.
   * Letting those count as failures would open the circuit breaker during
   * normal operation.
   */
  async function get(path: string, signal?: AbortSignal): Promise<unknown> {
    try {
      const payload = await client.request<unknown>(path, {
        acceptStatuses: [404],
        ...(signal ? { signal } : {}),
      });
      lastSuccessAt = clock.now();
      return payload;
    } catch (e) {
      lastFailureAt = clock.now();
      lastError = safeErrorText(e, 200);
      log.warn({ path, err: lastError }, 'wikimedia request failed');
      return null;
    }
  }

  function topPath(dayMs: number): string {
    const { y, m, d } = utcParts(dayMs);
    return `metrics/pageviews/top/${project}/all-access/${y}/${m}/${d}`;
  }

  function seriesPath(article: string, startMs: number, endMs: number): string {
    // `agent=user` strips crawler and bot traffic, which is the difference
    // between measuring human curiosity and measuring scraper schedules.
    // The title is percent-encoded whole: real titles contain slashes,
    // apostrophes and non-Latin scripts.
    return `metrics/pageviews/per-article/${project}/all-access/user/${encodeURIComponent(article)}/daily/${compactDate(startMs)}/${compactDate(endMs)}`;
  }

  /**
   * Resolve the most recent day that actually has a published top list.
   *
   * Wikimedia aggregates lag roughly a day, and the exact cutover drifts with
   * their batch schedule, so yesterday is tried first and the day before is the
   * documented fallback. Two attempts only — a third would mean the API is
   * broken, not late.
   */
  async function fetchLatestTop(
    signal?: AbortSignal,
  ): Promise<{ dayMs: number; articles: TopArticle[] } | null> {
    const todayUtc = Date.UTC(
      clock.date().getUTCFullYear(),
      clock.date().getUTCMonth(),
      clock.date().getUTCDate(),
    );
    for (const offset of [1, 2]) {
      const dayMs = todayUtc - offset * DAY_MS;
      const payload = await get(topPath(dayMs), signal);
      const articles = parseTopArticles(payload);
      if (articles.length > 0) return { dayMs, articles };
    }
    return null;
  }

  function buildSignal(
    entry: TopArticle,
    dayMs: number,
    series: ReadonlyArray<{ t: number; v: number }>,
    observedAt: number,
  ): RawTrendSignal {
    const title = sanitiseExternalText(humanTitle(entry.article), 300);
    const signal: RawTrendSignal = {
      source: SOURCE,
      // The underscored form is the API's own identifier, so it is the stable
      // key for deduplication across runs.
      externalId: entry.article,
      title,
      url: `https://${project.split('.')[0] ?? 'en'}.wikipedia.org/wiki/${encodeURIComponent(entry.article)}`,
      rawValue: entry.views,
      // Pageviews are, to a good approximation, people who arrived at the page.
      audience: entry.views,
      rank: entry.rank,
      observedAt,
      keywords: articleKeywords(title),
      metadata: {
        article: entry.article,
        project,
        /** The day the top-list figure describes, which is not `observedAt`. */
        dataDayMs: dayMs,
        /**
         * Both numbers are bot-filtered. The top endpoint exposes no agent
         * parameter, but its counts match `agent=user` exactly on every article
         * spot-checked (see the header note), so labelling it `all-agents`
         * would misdescribe the data rather than describe it.
         */
        viewsAgent: 'user',
        historyAgent: 'user',
      },
    };

    // `engagement` is deliberately left unset throughout this provider.
    // Pageviews record arrivals and nothing else — there is no interaction
    // denominator to divide by — and the opportunity scorer already substitutes
    // a neutral 0.5 for a missing value. Inventing a number here would be
    // fabricating evidence.
    applyVelocity(signal, series);
    return signal;
  }

  async function fetchSeries(
    article: string,
    endDayMs: number,
    signal?: AbortSignal,
  ): Promise<Array<{ t: number; v: number }>> {
    // `encodeURIComponent` does not escape dots, so a title of `.` or `..`
    // survives into the path and `new URL()` resolves the segment away — the
    // request would silently go to a *different* endpoint (dropping the `user`
    // segment) instead of the one this function claims to call. Neither string
    // is a real article title, so there is nothing to ask for.
    if (article === '.' || article === '..') return [];
    const startMs = endDayMs - (HISTORY_DAYS - 1) * DAY_MS;
    const payload = await get(seriesPath(article, startMs, endDayMs), signal);
    return parseSeries(payload);
  }

  return {
    id: 'wikipedia',
    label: 'Wikipedia pageviews',
    kind: 'trend',
    sourceId: SOURCE,

    async healthCheck(): Promise<ProviderStatus> {
      const started = clock.now();
      // Cheap by construction: the top list is cached for 30 minutes and is the
      // same response `discover` needs, so probing costs at most one request
      // per cache window.
      const top = await fetchLatestTop();
      const state: HealthState = top ? 'ok' : 'down';

      const status: ProviderStatus = {
        id: 'wikipedia',
        label: 'Wikipedia pageviews',
        kind: 'trend',
        state,
        detail: top
          ? `Top list for ${utcParts(top.dayMs).y}-${utcParts(top.dayMs).m}-${utcParts(top.dayMs).d} available (${top.articles.length} articles).`
          : `No pageview aggregate available${lastError ? `: ${lastError}` : '.'}`,
        // Wikimedia's pageview API is fully anonymous; there is nothing an
        // operator could supply to unlock more of it.
        requiresCredentials: false,
        latencyMs: clock.now() - started,
      };
      if (lastSuccessAt !== undefined) status.lastSuccessAt = lastSuccessAt;
      if (lastFailureAt !== undefined) status.lastFailureAt = lastFailureAt;
      return status;
    },

    async discover(options: { limit: number; signal?: AbortSignal }): Promise<RawTrendSignal[]> {
      const limit = Math.max(1, Math.floor(options.limit));
      const top = await fetchLatestTop(options.signal);
      if (!top) return [];

      const candidates = top.articles.filter((a) => !isAdministrative(a.article)).slice(0, limit);

      /*
       * Per-article call budget.
       *
       * The top list is one request and gives level + rank for everything.
       * Velocity needs one additional request *per article*, so the cost of the
       * pass is 1 + N. At 100 req/min a large N would either stall behind the
       * limiter or crowd out every other provider sharing the scheduler slot,
       * and the marginal value drops fast: rank 40 on the daily top list is
       * rarely a launchable trend regardless of its z-score.
       *
       * So the history calls are spent only on the highest-ranked survivors of
       * the administrative filter. The remaining candidates are still returned
       * with level and rank; they simply carry no `history`, which downstream
       * reads as "no velocity evidence" rather than "velocity is zero".
       */
      const enriched = candidates.slice(0, Math.min(velocityCandidates, candidates.length));
      const seriesByArticle = new Map<string, Array<{ t: number; v: number }>>();
      const results = await Promise.all(
        enriched.map(async (entry) => ({
          article: entry.article,
          series: await fetchSeries(entry.article, top.dayMs, options.signal),
        })),
      );
      for (const result of results) {
        if (result.series.length > 0) seriesByArticle.set(result.article, result.series);
      }

      const observedAt = clock.now();
      return candidates.map((entry) =>
        buildSignal(entry, top.dayMs, seriesByArticle.get(entry.article) ?? [], observedAt),
      );
    },

    async measure(term: string, options: { signal?: AbortSignal }): Promise<RawTrendSignal | null> {
      const trimmed = term.trim();
      if (!trimmed) return null;

      const underscored = trimmed.replace(/\s+/g, '_');
      /*
       * Wikipedia capitalises the first character of a title and is
       * case-sensitive after it, so a term can spell several *different pages*:
       * the canonical article plus redirects, each with its own pageview
       * series. The pageviews API does not follow redirects, and a redirect is
       * not an empty page — it accumulates its own (much smaller) traffic.
       *
       * Measured 2026-08-29: `Dolly_parton` reports 1,516 views for the day
       * `Dolly_Parton` reports 646,774. Taking the first spelling that returns
       * data — only the leading character capitalised — therefore measured the
       * redirect and understated the subject by a factor of 425 while looking
       * like a confident reading. Every plausible spelling is now fetched and
       * the busiest one wins: the canonical article is by construction the page
       * the traffic lands on. Requests are capped at three and are cached, so
       * this costs at most two extra calls against a 100/min budget.
       *
       * The residual limit is stated rather than papered over: a redirect whose
       * title differs by more than casing ("Labubu doll" -> "Labubu") is not
       * resolved, because this API has no title-resolution endpoint. Such a
       * term measures as absent, which is honest, not as zero.
       */
      const attempts = [
        underscored.charAt(0).toUpperCase() + underscored.slice(1),
        titleCase(underscored),
        underscored,
      ].filter((a, i, all) => a.length > 0 && all.indexOf(a) === i && !isAdministrative(a));

      const todayUtc = Date.UTC(
        clock.date().getUTCFullYear(),
        clock.date().getUTCMonth(),
        clock.date().getUTCDate(),
      );
      // Same one-day publication lag as the top list.
      const endDayMs = todayUtc - DAY_MS;

      const candidates = await Promise.all(
        attempts.map(async (article) => {
          const series = await fetchSeries(article, endDayMs, options.signal);
          // Total over the window, not the latest day: a redirect can out-poll
          // its target on a single quiet day, but not across a month.
          return { article, series, total: series.reduce((acc, p) => acc + p.v, 0) };
        }),
      );

      let best: (typeof candidates)[number] | null = null;
      for (const candidate of candidates) {
        // A title that exists but has no recorded views in the whole window is
        // not evidence of anything, and a zero would be indistinguishable
        // downstream from a real reading.
        if (candidate.total <= 0) continue;
        if (!best || candidate.total > best.total) best = candidate;
      }

      const latest = best?.series[best.series.length - 1];
      // No article, or an article with no recorded views: say so rather than
      // returning a zero that downstream cannot distinguish from real data.
      if (!best || !latest) return null;

      // measure() has no top-list entry, so rawValue comes from the same
      // agent=user series as the history — consistent within this signal,
      // and metadata records which agent filter produced it.
      return buildSignalFromSeries(best.article, best.series, latest, clock.now(), project);
    },
  };
}

/** measure()'s counterpart to `buildSignal`, for when there is no ranked list. */
function buildSignalFromSeries(
  article: string,
  series: ReadonlyArray<{ t: number; v: number }>,
  latest: { t: number; v: number },
  observedAt: number,
  project: string,
): RawTrendSignal {
  const title = sanitiseExternalText(humanTitle(article), 300);
  const signal: RawTrendSignal = {
    source: SOURCE,
    externalId: article,
    title,
    url: `https://${project.split('.')[0] ?? 'en'}.wikipedia.org/wiki/${encodeURIComponent(article)}`,
    rawValue: latest.v,
    audience: latest.v,
    observedAt,
    history: series.map((p) => ({ t: p.t, v: p.v })),
    keywords: articleKeywords(title),
    metadata: {
      article,
      project,
      dataDayMs: latest.t,
      viewsAgent: 'user',
      historyAgent: 'user',
      lookup: true,
    },
  };

  applyVelocity(signal, series);
  return signal;
}

/**
 * Minimum log-space MAD, roughly a 16% day-to-day swing.
 *
 * Some articles are pathologically flat (a stub with 40 views every single
 * day). Their MAD collapses towards zero and any ordinary fluctuation divides
 * into a colossal score, so the floor is what stops a quiet page from
 * manufacturing statistical significance out of noise.
 */
const MIN_LOG_SCALE = 0.15;

/**
 * Attach `history` and a robust surge score to a signal, in place.
 *
 * The z-score is computed on `log1p(views)`, not on raw counts, for two
 * reasons. Pageview series are counts spanning several orders of magnitude, and
 * a MAD taken on raw counts is proportional to the article's own traffic — so
 * the resulting score is not comparable between a 1k/day article and a
 * 500k/day one, and routinely lands in the hundreds or thousands, which is not
 * a number anything downstream can threshold. In log space the score reads as
 * "multiples of this article's typical daily variation", which is comparable
 * across articles and stable over time.
 *
 * Median and MAD rather than mean and stddev because a single prior spike (the
 * last time this subject was in the news) would otherwise inflate the baseline
 * and mask a genuine second surge.
 */
function applyVelocity(signal: RawTrendSignal, series: ReadonlyArray<{ t: number; v: number }>): void {
  if (series.length === 0) return;
  signal.history = series.map((p) => ({ t: p.t, v: p.v }));

  const latest = series[series.length - 1];
  const prior = series.slice(0, -1);
  // Fewer than five prior days is not a baseline, it is a coincidence.
  if (!latest || prior.length < 5) return;

  const priorLogs = prior.map((p) => Math.log1p(p.v));
  const baselineLog = median(priorLogs);
  const scale = Math.max(mad(priorLogs), MIN_LOG_SCALE);
  const z = (Math.log1p(latest.v) - baselineLog) / scale;
  const baselineViews = Math.expm1(baselineLog);

  const meta = signal.metadata as Record<string, unknown>;
  meta['velocityZ'] = z;
  meta['baselineDailyViews'] = baselineViews;
  meta['latestUserViews'] = latest.v;
  meta['baselineDays'] = prior.length;
  meta['viewsRatio'] = baselineViews > 0 ? latest.v / baselineViews : null;

  // Thresholds in robust log-sigmas: +3 is a real departure from this article's
  // own normal, while sitting at or below its median means the attention this
  // page is getting has already passed.
  if (z >= 3) signal.sourceStage = 'trending';
  else if (z <= 0) signal.sourceStage = 'cooling';
  else signal.sourceStage = 'saturating';
}

/** Exposed for the scheduler's dashboards: what this provider filters out. */
export const WIKIPEDIA_ADMIN_PREFIXES: readonly string[] = ADMIN_PREFIXES;
