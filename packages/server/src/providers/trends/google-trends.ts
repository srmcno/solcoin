import { contentTokens, normalise, sanitiseExternalText, slugify } from '@solcoin/shared';
import type { TrendSourceId } from '@solcoin/shared';
import { systemClock, type Clock } from '../../core/clock.js';
import { AppError, safeErrorText } from '../../core/errors.js';
import { componentLogger } from '../../core/logger.js';
import { HttpClient } from '../http.js';
import type { ProviderStatus, RawTrendSignal, TrendProvider } from '../types.js';

/**
 * Google Trends — daily search trends, zero-auth.
 *
 * Endpoint: GET https://trends.google.com/trending/rss?geo=<GEO>
 *
 * Verified live on 2026-08-29 (HTTP 200, ~10 <item> elements for geo=US).
 * The widely-cited `/trends/trendingsearches/daily/rss?geo=US` path is dead and
 * now 404s; every tutorial still referencing it is stale. An unknown geo code
 * returns HTTP 400 rather than an empty feed, which is why a per-geo failure is
 * isolated instead of failing the whole sweep.
 *
 * Search demand is the single most independent trend family the platform has
 * (SOURCE_INDEPENDENCE weight 1.0): it measures intent from people who never
 * post anything, so it does not co-move with the social sources.
 *
 * Feed shape actually observed (there is no per-item <guid>, and the per-item
 * <link> is the feed's own URL, not a link to the topic — so the item URL has to
 * come from the first news item):
 *
 *   <item>
 *     <title>sevilla vs atlético madrid</title>
 *     <ht:approx_traffic>500+</ht:approx_traffic>
 *     <description/>
 *     <link>https://trends.google.com/trending/rss?geo=US</link>
 *     <pubDate>Sat, 29 Aug 2026 11:30:00 -0700</pubDate>
 *     <ht:picture>…</ht:picture>
 *     <ht:picture_source>BBC</ht:picture_source>
 *     <ht:news_item>
 *       <ht:news_item_title>…</ht:news_item_title>
 *       <ht:news_item_snippet/>
 *       <ht:news_item_url>https://www.bbc.com/…</ht:news_item_url>
 *       <ht:news_item_source>BBC</ht:news_item_source>
 *     </ht:news_item>
 *   </item>
 */

const SOURCE_ID: TrendSourceId = 'google_trends';
const BASE_URL = 'https://trends.google.com/trending/rss';

/**
 * Google publishes no quota for this feed and it is not a documented API, so the
 * only safe posture is to look like a polite feed reader. 20 req/min is roughly
 * one geo per three seconds — far below anything that would draw attention, and
 * still enough to sweep 20 geos inside a single minute-scale job.
 */
const RATE_LIMIT = { requests: 20, intervalMs: 60_000, burst: 5 } as const;

/**
 * The feed is regenerated on a ~30 minute cadence (observed pubDate granularity
 * of :00/:30), so caching for 5 minutes removes duplicate fetches when discover()
 * and healthCheck() run in the same scheduler tick without ever serving data that
 * is stale relative to the upstream refresh.
 */
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

/**
 * Cross-border breadth bonus applied to `audience` only.
 *
 * `ht:approx_traffic` is floored into coarse buckets ("500+", "1000+"), so the
 * raw sum across geos systematically *under*-counts a topic that is trending
 * everywhere. A topic surfacing in N geos is a genuinely different phenomenon
 * from one national story with the same bucket sum, so audience is scaled by
 * breadth while `rawValue` stays the untouched platform-native sum.
 */
const GEO_BREADTH_BONUS = 0.35;

export interface GoogleTrendsProviderOptions {
  /** Geos to sweep, as ISO-3166 alpha-2 codes. Empty disables the provider. */
  geos?: readonly string[];
  /** UI/host language passed as `hl`; affects nothing but news-item wording. */
  hl?: string;
  clock?: Clock;
  timeoutMs?: number;
  cacheTtlMs?: number;
  /** Injectable client, for tests. A correctly configured one is built if absent. */
  http?: HttpClient;
}

export function createGoogleTrendsProvider(deps: GoogleTrendsProviderOptions = {}): TrendProvider {
  const log = componentLogger('provider.google-trends');
  const clock = deps.clock ?? systemClock;
  // Normalise once: Google expects upper-case geo codes and 400s on junk input.
  const geos = [...new Set((deps.geos ?? ['US']).map((g) => g.trim().toUpperCase()).filter(Boolean))];

  const stats: { lastSuccessAt?: number; lastFailureAt?: number; latencyMs?: number; lastError?: string } = {};

  const http =
    deps.http ??
    new HttpClient({
      name: 'google-trends',
      timeoutMs: deps.timeoutMs ?? 15_000,
      rateLimit: { ...RATE_LIMIT },
      cacheTtlMs: deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
      clock,
      onResult: (r) => {
        stats.latencyMs = r.latencyMs;
        if (r.ok) stats.lastSuccessAt = clock.now();
        else {
          stats.lastFailureAt = clock.now();
          stats.lastError = r.error;
        }
      },
    });

  async function fetchGeo(geo: string, signal?: AbortSignal): Promise<string> {
    return http.request<string>(BASE_URL, {
      query: { geo, ...(deps.hl ? { hl: deps.hl } : {}) },
      // Google serves RSS with content-type text/xml; JSON parsing would throw.
      responseType: 'text',
      headers: { accept: 'application/rss+xml, application/xml, text/xml, */*' },
      ...(signal ? { signal } : {}),
    });
  }

  return {
    id: 'google_trends',
    label: 'Google Trends (daily RSS)',
    kind: 'trend',
    sourceId: SOURCE_ID,

    async healthCheck(): Promise<ProviderStatus> {
      const base = {
        id: 'google_trends',
        label: 'Google Trends (daily RSS)',
        kind: 'trend' as const,
        // The feed is public: there is nothing an operator could supply to
        // unlock it, so this provider never reports requiresCredentials.
        requiresCredentials: false,
      };

      const firstGeo = geos[0];
      if (firstGeo === undefined) {
        return {
          ...base,
          state: 'unconfigured',
          detail: 'No geos configured; set providers.googleTrends.geos to enable the sweep.',
          setupHint: 'Add at least one ISO-3166 alpha-2 geo code, e.g. ["US"].',
        };
      }

      const started = clock.now();
      try {
        // Cheap by construction: the cached feed body satisfies this probe and
        // the subsequent discover() call within the cache TTL.
        const xml = await fetchGeo(firstGeo);
        const items = extractItemBlocks(xml).length;
        const latencyMs = clock.now() - started;
        return {
          ...base,
          state: items > 0 ? 'ok' : 'degraded',
          detail:
            items > 0
              ? `${items} trending items for ${firstGeo} (${geos.length} geo(s) configured)`
              : `Feed for ${firstGeo} parsed but contained no items`,
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
      if (geos.length === 0) return [];

      const observedAt = clock.now();
      /** Keyed by normalised title so the same story from several geos merges. */
      const merged = new Map<string, MergedTopic>();
      let failures = 0;

      for (const geo of geos) {
        let xml: string;
        try {
          xml = await fetchGeo(geo, options.signal);
        } catch (e) {
          // One bad geo code (HTTP 400) or one transient failure must not lose
          // the geos that did answer.
          failures++;
          log.warn({ geo, err: safeErrorText(e, 200) }, 'google trends geo fetch failed');
          continue;
        }

        const blocks = extractItemBlocks(xml);
        for (let index = 0; index < blocks.length; index++) {
          const block = blocks[index];
          if (block === undefined) continue;
          const parsed = parseItem(block, geo, index + 1);
          if (!parsed) continue;
          mergeTopic(merged, parsed);
        }
      }

      if (failures === geos.length) {
        throw new AppError('provider_unavailable', `Google Trends sweep failed for all ${geos.length} geo(s)`, {
          retryable: true,
          details: { geos, lastError: stats.lastError },
        });
      }

      const ranked = [...merged.values()].sort((a, b) => {
        // Total search volume first; ties broken by how many geos carried it.
        if (b.totalTraffic !== a.totalTraffic) return b.totalTraffic - a.totalTraffic;
        if (b.geos.size !== a.geos.size) return b.geos.size - a.geos.size;
        return a.bestRank - b.bestRank;
      });

      const limit = Math.max(0, Math.floor(options.limit));
      return ranked.slice(0, limit).map((topic, i) => toSignal(topic, i + 1, geos.length, observedAt));
    },
  };
}

// ---------------------------------------------------------------------------
// Merge model
// ---------------------------------------------------------------------------

interface ParsedItem {
  title: string;
  key: string;
  traffic: number;
  rank: number;
  geo: string;
  summary?: string;
  url?: string;
  publishedAt?: number;
  newsSources: string[];
}

interface MergedTopic {
  key: string;
  title: string;
  totalTraffic: number;
  bestRank: number;
  geos: Set<string>;
  perGeoTraffic: Record<string, number>;
  summary?: string;
  url?: string;
  publishedAt?: number;
  newsSources: Set<string>;
}

function mergeTopic(into: Map<string, MergedTopic>, item: ParsedItem): void {
  const existing = into.get(item.key);
  if (!existing) {
    into.set(item.key, {
      key: item.key,
      title: item.title,
      totalTraffic: item.traffic,
      bestRank: item.rank,
      geos: new Set([item.geo]),
      perGeoTraffic: { [item.geo]: item.traffic },
      ...(item.summary !== undefined ? { summary: item.summary } : {}),
      ...(item.url !== undefined ? { url: item.url } : {}),
      ...(item.publishedAt !== undefined ? { publishedAt: item.publishedAt } : {}),
      newsSources: new Set(item.newsSources),
    });
    return;
  }

  existing.totalTraffic += item.traffic;
  existing.bestRank = Math.min(existing.bestRank, item.rank);
  existing.geos.add(item.geo);
  // A geo repeated inside one sweep would double-count; keep the larger bucket.
  existing.perGeoTraffic[item.geo] = Math.max(existing.perGeoTraffic[item.geo] ?? 0, item.traffic);
  existing.summary ??= item.summary;
  existing.url ??= item.url;
  if (item.publishedAt !== undefined) {
    // Earliest sighting is the better "when did this start" estimate.
    existing.publishedAt =
      existing.publishedAt === undefined ? item.publishedAt : Math.min(existing.publishedAt, item.publishedAt);
  }
  for (const s of item.newsSources) existing.newsSources.add(s);
}

function toSignal(topic: MergedTopic, rank: number, geoCount: number, observedAt: number): RawTrendSignal {
  const breadth = topic.geos.size;
  const audience = Math.round(topic.totalTraffic * (1 + GEO_BREADTH_BONUS * (breadth - 1)));

  const signal: RawTrendSignal = {
    source: SOURCE_ID,
    // Stable across sweeps: the same story keeps its id so history lines up.
    externalId: `google_trends:${slugify(topic.title, 80) || topic.key.slice(0, 80)}`,
    title: topic.title,
    rawValue: topic.totalTraffic,
    audience,
    rank,
    observedAt,
    keywords: contentTokens(topic.title).slice(0, 8),
    metadata: {
      geos: [...topic.geos],
      geoCount: breadth,
      // Fraction of the swept geos carrying this topic: a cheap breadth feature
      // downstream scoring can use without re-deriving it.
      geoBreadth: geoCount > 0 ? breadth / geoCount : 0,
      perGeoTraffic: topic.perGeoTraffic,
      bestGeoRank: topic.bestRank,
      newsSources: [...topic.newsSources].slice(0, 5),
      ...(topic.publishedAt !== undefined ? { publishedAt: topic.publishedAt } : {}),
    },
  };

  if (topic.summary !== undefined) signal.summary = topic.summary;
  if (topic.url !== undefined) signal.url = topic.url;
  return signal;
}

// ---------------------------------------------------------------------------
// Item parsing
// ---------------------------------------------------------------------------

function parseItem(block: string, geo: string, rank: number): ParsedItem | null {
  const rawTitle = extractTag(block, 'title');
  if (!rawTitle) return null;
  const title = sanitiseExternalText(rawTitle, 200);
  // Dedupe key: normalised, then punctuation-folded, because the same story
  // surfaces across geos with cosmetic differences ("sevilla - atlético madrid"
  // vs "sevilla atlético madrid"). Deliberately NOT confusableFold: its
  // leet/repeat folding would merge genuinely distinct search queries.
  const key = normalise(title).replace(/[^a-z0-9]+/g, ' ').trim();
  // A title that sanitises down to nothing (pure control characters, or markup
  // that was entirely neutralised) carries no signal and cannot be deduped.
  if (!key) return null;

  const traffic = parseApproxTraffic(extractTag(block, 'ht:approx_traffic') ?? '');

  const newsTitles = extractAllTags(block, 'ht:news_item_title')
    .map((t) => sanitiseExternalText(t, 300))
    .filter((t) => t.length > 0);
  const newsUrls = extractAllTags(block, 'ht:news_item_url');
  const newsSources = extractAllTags(block, 'ht:news_item_source')
    .map((s) => sanitiseExternalText(s, 80))
    .filter((s) => s.length > 0);

  const item: ParsedItem = { title, key, traffic, rank, geo, newsSources };

  const summary = newsTitles[0];
  if (summary !== undefined) item.summary = summary;

  // The item's own <link> is the feed URL, so the lead news article is the only
  // meaningful destination Google gives us for a topic.
  const url = newsUrls.map(toSafeHttpUrl).find((u): u is string => u !== null);
  if (url !== undefined) item.url = url;

  const published = parseRssDate(extractTag(block, 'pubDate'));
  if (published !== null) item.publishedAt = published;

  return item;
}

/**
 * "500+" -> 500, "2K+" -> 2000, "1M+" -> 1_000_000, "1,000+" -> 1000.
 *
 * Google never publishes an exact figure here — the value is a floor bucket, so
 * everything downstream must treat it as a lower bound on search volume.
 */
export function parseApproxTraffic(raw: string): number {
  const m = raw.trim().match(/^([0-9][0-9.,\s]*)\s*([KMB])?\s*\+?$/i);
  if (!m?.[1]) return 0;
  const digits = m[1].replace(/[,\s]/g, '');
  const n = Number(digits);
  if (!Number.isFinite(n) || n < 0) return 0;
  const unit = m[2]?.toUpperCase();
  const multiplier = unit === 'B' ? 1e9 : unit === 'M' ? 1e6 : unit === 'K' ? 1e3 : 1;
  return Math.round(n * multiplier);
}

function parseRssDate(raw: string | null): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw.trim());
  return Number.isFinite(ms) ? ms : null;
}

function toSafeHttpUrl(raw: string): string | null {
  const trimmed = decodeXmlEntities(raw).trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    // Anything that is not plain HTTP(S) (javascript:, data:) is hostile input.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Minimal RSS reader
//
// A dependency-free extractor rather than a real XML parser: this feed is a
// fixed, flat shape generated by one producer, and pulling in an XML library
// (and its parser CVE surface) to read six tags is a bad trade. Everything the
// extractor returns is treated as untrusted text and sanitised by the caller.
// ---------------------------------------------------------------------------

const CDATA_RE = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Split the channel into `<item>…</item>` bodies, in document order. */
export function extractItemBlocks(xml: string): string[] {
  const out: string[] = [];
  const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi;
  for (const m of xml.matchAll(re)) {
    const body = m[1];
    if (body !== undefined) out.push(body);
  }
  return out;
}

/** First occurrence of `<name>…</name>`; '' for a self-closing empty element. */
export function extractTag(xml: string, name: string): string | null {
  const escaped = escapeRegExp(name);
  const re = new RegExp(`<${escaped}(?:\\s[^>]*)?(?:\\/>|>([\\s\\S]*?)<\\/${escaped}\\s*>)`, 'i');
  const m = xml.match(re);
  if (!m) return null;
  return cleanNodeText(m[1] ?? '');
}

/** Every occurrence of `<name>…</name>`, in document order. */
export function extractAllTags(xml: string, name: string): string[] {
  const escaped = escapeRegExp(name);
  const re = new RegExp(`<${escaped}(?:\\s[^>]*)?(?:\\/>|>([\\s\\S]*?)<\\/${escaped}\\s*>)`, 'gi');
  const out: string[] = [];
  for (const m of xml.matchAll(re)) out.push(cleanNodeText(m[1] ?? ''));
  return out;
}

function cleanNodeText(raw: string): string {
  // CDATA content is literal: unwrap it before entity decoding so that a
  // literal "&amp;" inside CDATA is preserved rather than decoded twice.
  let hadCdata = false;
  const unwrapped = raw.replace(CDATA_RE, (_full, inner: string) => {
    hadCdata = true;
    return inner;
  });
  const text = hadCdata ? unwrapped : decodeXmlEntities(unwrapped);
  return text.replace(/\s+/g, ' ').trim();
}

function decodeXmlEntities(input: string): string {
  return (
    input
      .replace(/&#x([0-9a-fA-F]{1,6});/g, (_m, hex: string) => codePointOrEmpty(parseInt(hex, 16)))
      .replace(/&#(\d{1,7});/g, (_m, dec: string) => codePointOrEmpty(parseInt(dec, 10)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      // &amp; last: decoding it first would let "&amp;lt;" become "<".
      .replace(/&amp;/g, '&')
  );
}

function codePointOrEmpty(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
  // Lone surrogates would produce an unpaired code unit; drop them.
  if (code >= 0xd800 && code <= 0xdfff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}
