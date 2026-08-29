import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { contentTokens, sanitiseExternalText } from '@solcoin/shared';
import type { TrendSourceId } from '@solcoin/shared';
import { systemClock, type Clock } from '../../core/clock.js';
import { safeErrorText } from '../../core/errors.js';
import { componentLogger } from '../../core/logger.js';
import { HttpClient } from '../http.js';
import type { ProviderStatus, RawTrendSignal, TrendProvider } from '../types.js';

/**
 * Generic RSS 2.0 / Atom feed reader — operator-supplied feed list, no credentials.
 *
 * ## What this source is for
 *
 * A feed has no popularity metric. There is no score, no view count, no
 * engagement — only "this publisher chose to publish this, at this time". So
 * `rawValue` here is a **recency-weighted presence** score: 1.0 for an item
 * published within the last hour, decaying linearly to 0 across 24 hours.
 *
 * Be explicit about what that means downstream: **this source contributes
 * breadth, not magnitude.** Its value is that an operator can point it at
 * niche publications the big platforms do not index, so a topic can be
 * corroborated by a source no scraper is watching. Its rawValue must never be
 * compared numerically against a source that measures real audience (YouTube
 * views, Reddit score) — it is a presence indicator on a 0..1 scale, and
 * SOURCE_INDEPENDENCE already weights `rss` low for exactly this reason.
 *
 * ## Supported formats
 *
 * Both, with one dependency-free extractor:
 *   RSS 2.0  <item><title/><link>url</link><pubDate/><description/><guid/>
 *   Atom     <entry><title/><link href=""/><updated/><published/><summary/>
 *                   <content/><id/>
 * Verified against live feeds on 2026-08-29: BBC News (RSS 2.0, CDATA titles
 * and descriptions, relative-free absolute links, RFC 822 pubDate) and
 * hnrss.org (Atom, CDATA titles, `<link href rel="alternate">`, `<content
 * type="html">` with no `<summary>` at all, ISO 8601 `<updated>`/`<published>`).
 * The extractor handles CDATA, HTML inside descriptions, XML entities and
 * namespaced element names (`dc:date`, `content:encoded`).
 *
 * ## SSRF
 *
 * Feed URLs are operator-supplied configuration, which makes this provider a
 * fetch-arbitrary-URL primitive sitting inside the operator's network. An
 * operator who pastes a URL from a support ticket, or an attacker who reaches
 * the settings API, could otherwise use it to read `http://169.254.169.254/`
 * (cloud instance metadata, i.e. cloud credentials) or to port-scan the private
 * network from inside the perimeter. `validateFeedUrl` is the control, and it
 * is deliberately strict — see the comments there.
 */

const SOURCE_ID: TrendSourceId = 'rss';

/**
 * Feeds are polled politely: publishers serve these from ordinary web servers,
 * often for free, and several will block a client that hammers them. One
 * request every two seconds per host, burst 3, is well inside every published
 * feed-etiquette guideline and is far more than a poll cycle needs.
 */
const RATE_LIMIT = { requests: 30, intervalMs: 60_000, burst: 3 } as const;

/** Most feeds carry a `ttl` of 15-60 minutes; 5 minutes never serves stale data. */
const DEFAULT_CACHE_TTL_MS = 300_000;

/** Items older than this contribute nothing and are dropped. */
const DEFAULT_MAX_AGE_HOURS = 24;

/** Full weight for the first hour, then linear decay to zero at MAX_AGE. */
const FULL_WEIGHT_HOURS = 1;

/** Per-feed item cap. A misconfigured feed can otherwise return thousands. */
const MAX_ITEMS_PER_FEED = 50;

/**
 * Hard ceiling on parsed feed text. `HttpClient` has no response size limit, so
 * this is the backstop that stops one enormous feed from pinning the event loop
 * inside the regex extractor.
 */
const MAX_FEED_CHARS = 2_000_000;

/** How long a hostname's DNS-safety verdict is trusted. */
const HOST_VERDICT_TTL_MS = 300_000;

/** Feeds fetched at once. Small: these are third-party servers, not an API. */
const FETCH_CONCURRENCY = 4;

export interface RssProviderDeps {
  clock?: Clock;
  /** Static feed list from configuration. */
  feedUrls?: readonly string[];
  /** Dynamic feed list, consulted per call, for live-editable settings. */
  getFeedUrls?: () => Promise<readonly string[]> | readonly string[];
  /** Items older than this are dropped. Defaults to 24 hours. */
  maxAgeHours?: number;
  timeoutMs?: number;
  cacheTtlMs?: number;
  /**
   * Injectable client factory, for tests. In production one client is built per
   * feed host so that a slow or dead publisher opens only its own circuit
   * breaker and consumes only its own rate-limit bucket.
   */
  httpFactory?: (host: string) => HttpClient;
}

interface FeedOutcome {
  url: string;
  ok: boolean;
  items: number;
  error?: string;
}

export function createRssProvider(deps: RssProviderDeps = {}): TrendProvider {
  const log = componentLogger('provider.rss');
  const clock = deps.clock ?? systemClock;
  const maxAgeHours = positive(deps.maxAgeHours) ?? DEFAULT_MAX_AGE_HOURS;

  const clients = new Map<string, HttpClient>();
  const hostVerdicts = new Map<string, { safe: boolean; reason: string; checkedAt: number }>();
  const stats: { lastSuccessAt?: number; lastFailureAt?: number; lastRun?: FeedOutcome[] } = {};

  function clientFor(host: string): HttpClient {
    const existing = clients.get(host);
    if (existing) return existing;
    const created =
      deps.httpFactory?.(host) ??
      new HttpClient({
        name: `rss:${host}`,
        timeoutMs: deps.timeoutMs ?? 15_000,
        // Feeds are a nice-to-have; one retry, then move on to the next feed
        // rather than spending the job's budget on a flaky publisher.
        maxRetries: 1,
        rateLimit: { ...RATE_LIMIT },
        cacheTtlMs: deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
        clock,
        defaultHeaders: {
          // Some publishers content-negotiate and return HTML to a client that
          // only claims to accept JSON.
          accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        },
      });
    clients.set(host, created);
    return created;
  }

  async function feedUrls(): Promise<string[]> {
    const dynamic = deps.getFeedUrls ? await deps.getFeedUrls() : [];
    const merged = [...(deps.feedUrls ?? []), ...dynamic];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of merged) {
      if (typeof raw !== 'string') continue;
      const url = raw.trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
    return out;
  }

  /** Syntactic check plus a cached DNS resolution check. */
  async function checkUrl(raw: string): Promise<{ url: URL; safe: true } | { safe: false; reason: string }> {
    const syntactic = validateFeedUrl(raw);
    if (!syntactic.ok) return { safe: false, reason: syntactic.reason };

    const host = syntactic.url.hostname;
    const cached = hostVerdicts.get(host);
    if (cached && clock.now() - cached.checkedAt < HOST_VERDICT_TTL_MS) {
      return cached.safe ? { url: syntactic.url, safe: true } : { safe: false, reason: cached.reason };
    }

    const verdict = await resolvesToPublicAddress(host);
    hostVerdicts.set(host, { ...verdict, checkedAt: clock.now() });
    return verdict.safe ? { url: syntactic.url, safe: true } : { safe: false, reason: verdict.reason };
  }

  async function fetchFeed(raw: string, signal?: AbortSignal): Promise<{ items: RawTrendSignal[]; outcome: FeedOutcome }> {
    const checked = await checkUrl(raw);
    if (!checked.safe) {
      // A rejected URL is a configuration error the operator must see, and it
      // is never retried silently.
      log.warn({ feed: redactFeed(raw), reason: checked.reason }, 'rejected unsafe feed URL');
      return { items: [], outcome: { url: raw, ok: false, items: 0, error: checked.reason } };
    }

    const url = checked.url;
    let xml: string;
    try {
      xml = await clientFor(url.hostname).request<string>(url.toString(), {
        responseType: 'text',
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      return { items: [], outcome: { url: raw, ok: false, items: 0, error: safeErrorText(e, 160) } };
    }

    if (typeof xml !== 'string' || xml.length === 0) {
      return { items: [], outcome: { url: raw, ok: false, items: 0, error: 'empty response' } };
    }

    const observedAt = clock.now();
    const parsed = parseFeed(xml.length > MAX_FEED_CHARS ? xml.slice(0, MAX_FEED_CHARS) : xml);
    const items: RawTrendSignal[] = [];
    for (const entry of parsed.items.slice(0, MAX_ITEMS_PER_FEED)) {
      const signal = toSignal(entry, url, parsed.feedTitle, observedAt, maxAgeHours);
      if (signal) items.push(signal);
    }
    return { items, outcome: { url: raw, ok: true, items: items.length } };
  }

  const label = 'RSS / Atom feeds';
  const base = {
    id: 'rss',
    label,
    kind: 'trend' as const,
    // Feeds need configuration, not credentials: there is no key to store, so
    // the dashboard should not tell the operator to go find one.
    requiresCredentials: false,
  };
  const setupHint = 'Add one or more https:// RSS or Atom feed URLs in settings. Private and loopback hosts are refused.';

  return {
    id: 'rss',
    label,
    kind: 'trend',
    sourceId: SOURCE_ID,

    async healthCheck(): Promise<ProviderStatus> {
      const started = clock.now();
      const urls = await feedUrls();
      if (urls.length === 0) {
        return {
          ...base,
          state: 'unconfigured',
          detail: 'No feed URLs configured; this source is inactive.',
          setupHint,
        };
      }

      // Validation only — no feed is fetched. A health probe that pulled every
      // configured feed would cost more than the discovery run it is checking.
      let valid = 0;
      const rejected: string[] = [];
      for (const raw of urls) {
        const checked = await checkUrl(raw);
        if (checked.safe) valid++;
        else rejected.push(`${redactFeed(raw)} (${checked.reason})`);
      }

      const lastRun = stats.lastRun ?? [];
      const failedLastRun = lastRun.filter((o) => !o.ok).length;
      const timing = {
        latencyMs: clock.now() - started,
        ...(stats.lastSuccessAt !== undefined ? { lastSuccessAt: stats.lastSuccessAt } : {}),
        ...(stats.lastFailureAt !== undefined ? { lastFailureAt: stats.lastFailureAt } : {}),
      };

      if (valid === 0) {
        return {
          ...base,
          state: 'down',
          detail: `All ${urls.length} configured feed URLs were rejected: ${rejected.slice(0, 3).join('; ')}`,
          setupHint,
          ...timing,
        };
      }
      if (rejected.length > 0) {
        return {
          ...base,
          state: 'degraded',
          detail: `${valid}/${urls.length} feed URLs usable; rejected: ${rejected.slice(0, 3).join('; ')}`,
          setupHint,
          ...timing,
        };
      }
      if (lastRun.length === 0) {
        // Honest: the URLs are fine, but nothing has actually been fetched yet.
        return { ...base, state: 'unknown', detail: `${valid} feed URLs configured; not yet polled.`, ...timing };
      }
      return {
        ...base,
        state: failedLastRun > 0 ? 'degraded' : 'ok',
        detail:
          failedLastRun > 0
            ? `${lastRun.length - failedLastRun}/${lastRun.length} feeds succeeded on the last poll.`
            : `All ${lastRun.length} feeds succeeded on the last poll.`,
        ...timing,
      };
    },

    async discover(options: { limit: number; signal?: AbortSignal }): Promise<RawTrendSignal[]> {
      const want = clampInt(options.limit, 0, 2_000);
      if (want === 0) return [];

      const urls = await feedUrls();
      // Contract: an unconfigured provider returns nothing and never throws.
      if (urls.length === 0) return [];

      const outcomes: FeedOutcome[] = [];
      const collected: RawTrendSignal[] = [];

      // Bounded concurrency: feeds are independent third-party servers, so they
      // are fetched in parallel, but four at a time keeps memory and socket use
      // predictable when an operator configures fifty feeds.
      let cursor = 0;
      const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, urls.length) }, async () => {
        for (;;) {
          if (options.signal?.aborted) return;
          const index = cursor++;
          const raw = urls[index];
          if (raw === undefined) return;
          const { items, outcome } = await fetchFeed(raw, options.signal);
          outcomes.push(outcome);
          collected.push(...items);
        }
      });
      await Promise.all(workers);

      stats.lastRun = outcomes;
      const succeeded = outcomes.filter((o) => o.ok).length;
      if (succeeded > 0) stats.lastSuccessAt = clock.now();
      if (succeeded < outcomes.length) {
        stats.lastFailureAt = clock.now();
        log.debug(
          { feeds: outcomes.length, succeeded, items: collected.length },
          'rss sweep completed with feed failures',
        );
      }

      // The same story is syndicated by several publishers, and by a publisher's
      // topic feed and front-page feed at once. Deduplicate on the stable item
      // identity so one story counts once.
      const byId = new Map<string, RawTrendSignal>();
      for (const signal of collected) {
        const existing = byId.get(signal.externalId);
        if (!existing || signal.rawValue > existing.rawValue) byId.set(signal.externalId, signal);
      }

      return [...byId.values()].sort((a, b) => b.rawValue - a.rawValue).slice(0, want);
    },

    // No measure(): a feed cannot be queried for a term. Returning a fabricated
    // measurement would be worse than the honest absence of the capability, and
    // TrendProvider makes measure optional precisely for sources like this one.
  };
}

// ---------------------------------------------------------------------------
// SSRF defence
// ---------------------------------------------------------------------------

/**
 * Hostnames that are internal by definition. `.local` is mDNS, `.internal` is
 * the conventional cloud-private zone, `.home.arpa` is the RFC 8375 home
 * network zone, and `.localhost` is reserved to the loopback interface.
 */
const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.intranet'];

interface UrlVerdict {
  ok: true;
  url: URL;
}
interface UrlRejection {
  ok: false;
  reason: string;
}

/**
 * Syntactic half of the SSRF control.
 *
 * Requires https, because a feed fetched over http can be rewritten in flight
 * and its content is then fed to a language model. Rejects embedded
 * credentials, since a feed URL is stored in settings and displayed in logs.
 * Rejects literal private, loopback and link-local addresses, and rejects
 * hostnames in internal-only zones. 169.254.0.0/16 matters most: that is where
 * every major cloud serves instance metadata, and an SSRF that reaches it hands
 * over the machine's cloud credentials.
 */
export function validateFeedUrl(raw: string): UrlVerdict | UrlRejection {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'not a valid absolute URL' };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, reason: `protocol ${url.protocol} is not allowed; use https` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'embedded credentials are not allowed in a feed URL' };
  }

  // WHATWG URL keeps IPv6 literals bracketed in `hostname`.
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return { ok: false, reason: 'missing host' };

  if (host === 'localhost' || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, reason: `host ${host} is an internal name` };
  }

  const literal = classifyAddress(host);
  if (literal === 'private') return { ok: false, reason: `host ${host} is a private or reserved address` };

  return { ok: true, url };
}

/**
 * Resolution half of the SSRF control.
 *
 * A perfectly public-looking hostname can resolve to 127.0.0.1 or to a cloud
 * metadata address — that is the entire trick behind DNS-based SSRF. Every
 * address the name resolves to must be public, not just the first.
 *
 * Known and accepted limitation: this cannot close the DNS-rebinding window,
 * because `fetch` resolves the name again itself and there is no way to pin the
 * checked address to the connection. Closing it properly needs a custom agent
 * with a `lookup` hook, which belongs in HttpClient rather than here. The check
 * still defeats the overwhelmingly more common case of a name that simply
 * points at an internal host.
 */
async function resolvesToPublicAddress(host: string): Promise<{ safe: boolean; reason: string }> {
  // An IP literal has no DNS step; classifyAddress already ruled on it.
  if (classifyAddress(host) === 'public') return { safe: true, reason: 'ok' };

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch (e) {
    return { safe: false, reason: `dns lookup failed: ${safeErrorText(e, 80)}` };
  }
  if (addresses.length === 0) return { safe: false, reason: 'dns returned no addresses' };

  for (const entry of addresses) {
    if (classifyAddress(entry.address) !== 'public') {
      return { safe: false, reason: `resolves to non-public address ${entry.address}` };
    }
  }
  return { safe: true, reason: 'ok' };
}

/**
 * 'private' covers loopback, link-local, RFC1918, CGNAT, multicast and reserved,
 * in both address families — including the IPv6 forms that embed an IPv4
 * address, which are the ones an SSRF attempt actually reaches for.
 */
function classifyAddress(value: string): 'public' | 'private' | 'not-an-ip' {
  const v4 = parseIpv4(value);
  if (v4) return ipv4IsPrivate(v4) ? 'private' : 'public';

  const v6 = parseIpv6(value);
  if (v6) return ipv6IsPrivate(v6) ? 'private' : 'public';

  return 'not-an-ip';
}

/**
 * Parse an IPv6 literal to its 16 bytes, or null if it is not one.
 *
 * Textual prefix matching is not good enough here, and the reason is specific:
 * `new URL()` **re-serialises** an IPv6 host into its canonical hex form, so a
 * URL written as `https://[::ffff:169.254.169.254]/` arrives at this function
 * as `::ffff:a9fe:a9fe`. Any check that looks for a dotted quad in the string
 * never fires on a URL-derived host, and the embedded metadata address sails
 * through. Decoding to bytes is the only reading that survives that rewrite.
 *
 * Accepts `::` compression, an optional trailing dotted quad (the form
 * `dns.lookup` returns for IPv4-mapped results) and a `%zone` suffix.
 */
function parseIpv6(value: string): number[] | null {
  const raw = value.trim().toLowerCase();
  if (!raw.includes(':')) return null;
  const withoutZone = raw.split('%')[0] ?? '';
  const halves = withoutZone.split('::');
  if (halves.length > 2) return null;

  const expand = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    const bytes: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i] ?? '';
      if (i === groups.length - 1 && group.includes('.')) {
        const quad = parseIpv4(group);
        if (!quad) return null;
        bytes.push(quad[0], quad[1], quad[2], quad[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      const n = parseInt(group, 16);
      bytes.push((n >> 8) & 0xff, n & 0xff);
    }
    return bytes;
  };

  const head = expand(halves[0] ?? '');
  if (head === null) return null;
  if (halves.length === 1) return head.length === 16 ? head : null;

  const tail = expand(halves[1] ?? '');
  if (tail === null) return null;
  const fill = 16 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/**
 * Reserved and internal IPv6 space.
 *
 * The embedding prefixes are the dangerous ones and are handled first: an
 * address in `::ffff:0:0/96`, `::/96`, `64:ff9b::/96` (NAT64) or `2002::/16`
 * (6to4) carries an IPv4 address inside it, and that inner address is the one a
 * connection actually reaches — which is exactly how `[::ffff:169.254.169.254]`
 * becomes a route to cloud instance metadata.
 */
function ipv6IsPrivate(bytes: number[]): boolean {
  const at = (i: number): number => bytes[i] ?? 0;
  const embedded = (): [number, number, number, number] => [at(12), at(13), at(14), at(15)];
  const leadingZeroes = (n: number): boolean => {
    for (let i = 0; i < n; i++) if (at(i) !== 0) return false;
    return true;
  };

  if (leadingZeroes(10)) {
    // ::ffff:0:0/96 IPv4-mapped, and ::/96 — which also covers :: and ::1.
    const mapped = at(10) === 0xff && at(11) === 0xff;
    const compat = at(10) === 0 && at(11) === 0;
    if (mapped || compat) return ipv4IsPrivate(embedded());
  }
  // 64:ff9b::/96 and 64:ff9b:1::/48 — NAT64 translation prefixes.
  if (at(0) === 0x00 && at(1) === 0x64 && at(2) === 0xff && at(3) === 0x9b) return true;
  // 2002::/16 6to4: bytes 2..5 are the embedded IPv4 tunnel endpoint.
  if (at(0) === 0x20 && at(1) === 0x02) return ipv4IsPrivate([at(2), at(3), at(4), at(5)]);
  // 2001:0000::/32 Teredo tunnels to an arbitrary IPv4 endpoint.
  if (at(0) === 0x20 && at(1) === 0x01 && at(2) === 0x00 && at(3) === 0x00) return true;
  // 2001:db8::/32 documentation range; must never be routed.
  if (at(0) === 0x20 && at(1) === 0x01 && at(2) === 0x0d && at(3) === 0xb8) return true;
  // fc00::/7 unique-local.
  if ((at(0) & 0xfe) === 0xfc) return true;
  // fe80::/10 link-local.
  if (at(0) === 0xfe && (at(1) & 0xc0) === 0x80) return true;
  // ff00::/8 multicast.
  if (at(0) === 0xff) return true;
  return false;
}

function parseIpv4(value: string): [number, number, number, number] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return [a, b, c, d];
}

function ipv4IsPrivate([a, b, , ]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16/12
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC6598 CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0/24 IETF, 192.0.2/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast (224/4) and reserved (240/4)
  return false;
}

// ---------------------------------------------------------------------------
// Feed parsing (dependency-free, RSS 2.0 + Atom)
// ---------------------------------------------------------------------------

export interface FeedItem {
  title: string;
  link: string | null;
  summary: string | null;
  publishedAt: number | null;
  guid: string | null;
  categories: string[];
  author: string | null;
}

export interface ParsedFeed {
  feedTitle: string | null;
  format: 'rss' | 'atom' | 'unknown';
  items: FeedItem[];
}

/**
 * Extract items from an RSS 2.0 or Atom document.
 *
 * Regex rather than a real XML parser, deliberately: the platform ships no XML
 * dependency, feeds in the wild are frequently not well-formed (unescaped
 * ampersands, stray control bytes, truncated documents), and a strict parser
 * rejects the whole document where this recovers every item it can read. The
 * extracted text is never interpreted as markup — it goes straight through
 * `sanitiseExternalText` into storage — so the usual "don't parse HTML with
 * regex" hazard does not apply here.
 */
export function parseFeed(xml: string): ParsedFeed {
  // Comments can legally contain anything, including fake <item> blocks.
  const doc = xml.replace(/<!--[\s\S]*?-->/g, '');

  /**
   * Decide the format from the root element, and only fall back to looking for
   * an `<entry>` anywhere when neither root marker is present.
   *
   * The order matters: an RSS document may perfectly legally contain the
   * literal text `<entry>` inside a CDATA description (a publisher syndicating
   * HTML, or an article about XML), and treating that as an Atom marker made
   * the extractor look for `<entry>` blocks in a document that has none —
   * silently returning zero items for the whole feed rather than one bad item.
   * Whichever root marker appears first wins, so the same trick cannot be
   * played in the other direction from inside an Atom entry.
   */
  const rssAt = doc.search(/<rss[\s>]/i);
  const feedAt = doc.search(/<feed[\s>]/i);
  const isAtom =
    feedAt >= 0 && (rssAt < 0 || feedAt < rssAt) ? true : rssAt >= 0 ? false : /<entry[\s>]/i.test(doc);
  const blockTag = isAtom ? 'entry' : 'item';
  const blocks = extractBlocks(doc, blockTag);

  // The channel/feed title is whatever <title> appears before the first item.
  const firstBlock = doc.search(new RegExp(`<${blockTag}[\\s>]`, 'i'));
  const head = firstBlock > 0 ? doc.slice(0, firstBlock) : doc;
  const feedTitleRaw = firstTagText(head, 'title');

  const items: FeedItem[] = [];
  for (const block of blocks) {
    const item = parseItem(block, isAtom);
    if (item) items.push(item);
  }

  return {
    feedTitle: feedTitleRaw ? cleanText(feedTitleRaw, 200) : null,
    format: blocks.length === 0 ? 'unknown' : isAtom ? 'atom' : 'rss',
    items,
  };
}

function parseItem(block: string, isAtom: boolean): FeedItem | null {
  const titleRaw = firstTagText(block, 'title');
  const title = titleRaw ? cleanText(titleRaw, 300) : '';
  // An item with no readable title carries nothing a trend engine can use.
  if (!title) return null;

  // Atom prefers <summary>; hnrss and many generators ship only <content>.
  // RSS uses <description>, with content:encoded as the richer variant.
  const summaryRaw =
    (isAtom ? firstTagText(block, 'summary') ?? firstTagText(block, 'content') : null) ??
    firstTagText(block, 'description') ??
    firstTagText(block, 'encoded');
  const summary = summaryRaw ? cleanText(summaryRaw, 800) : null;

  const dateRaw =
    // Atom: <published> is the original publication, <updated> is mandatory.
    firstTagText(block, 'published') ??
    firstTagText(block, 'pubDate') ??
    firstTagText(block, 'updated') ??
    // dc:date appears in RSS 1.0 and in RSS 2.0 feeds from several generators.
    firstTagText(block, 'date');

  const categories: string[] = [];
  for (const match of block.matchAll(/<(?:[a-zA-Z][\w.-]*:)?category\b([^>]*)>([\s\S]*?)<\/(?:[a-zA-Z][\w.-]*:)?category>/gi)) {
    // Atom puts the value in a `term` attribute; RSS puts it in the body.
    const attrTerm = match[1] ? attr(match[1], 'term') : null;
    const value = cleanText(attrTerm ?? match[2] ?? '', 60);
    if (value) categories.push(value);
    if (categories.length >= 8) break;
  }
  // Atom self-closing <category term="x"/> has no closing tag.
  if (categories.length === 0) {
    for (const match of block.matchAll(/<(?:[a-zA-Z][\w.-]*:)?category\b([^>]*)\/>/gi)) {
      const value = cleanText(attr(match[1] ?? '', 'term') ?? '', 60);
      if (value) categories.push(value);
      if (categories.length >= 8) break;
    }
  }

  const authorRaw = firstTagText(block, 'name') ?? firstTagText(block, 'creator');

  return {
    title,
    link: extractLink(block),
    summary,
    publishedAt: parseFeedDate(dateRaw),
    guid: firstTagText(block, 'guid') ?? firstTagText(block, 'id'),
    categories,
    author: authorRaw ? cleanText(authorRaw, 80) : null,
  };
}

/**
 * Item link. RSS puts a URL in the element body; Atom puts it in a `href`
 * attribute and may ship several <link> elements — `rel="self"`, `alternate`,
 * `enclosure`, `replies`. Only `alternate` (or a bare link with no rel, which
 * defaults to alternate) points at the article.
 */
function extractLink(block: string): string | null {
  const candidates: Array<{ href: string; rel: string; type: string }> = [];
  for (const match of block.matchAll(/<(?:[a-zA-Z][\w.-]*:)?link\b([^>]*)>/gi)) {
    const attrs = match[1] ?? '';
    const href = attr(attrs, 'href');
    if (!href) continue;
    candidates.push({
      href,
      rel: (attr(attrs, 'rel') ?? 'alternate').toLowerCase(),
      type: (attr(attrs, 'type') ?? '').toLowerCase(),
    });
  }
  const alternate =
    candidates.find((c) => c.rel === 'alternate' && c.type.includes('html')) ??
    candidates.find((c) => c.rel === 'alternate');
  if (alternate) return normaliseHref(decodeEntities(alternate.href));

  const body = firstTagText(block, 'link');
  if (body) return normaliseHref(cleanText(body, 500));
  return null;
}

function normaliseHref(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    // Only web links are stored; a feed offering javascript: or data: is either
    // broken or hostile.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Every `<tag>…</tag>` block for a tag name, namespace prefix optional. */
function extractBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[a-zA-Z][\\w.-]*:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z][\\w.-]*:)?${tag}>`, 'gi');
  const out: string[] = [];
  for (const match of xml.matchAll(re)) {
    if (typeof match[1] === 'string') out.push(match[1]);
  }
  return out;
}

/** Raw inner text of the first matching element, CDATA still wrapped. */
function firstTagText(xml: string, tag: string): string | null {
  const re = new RegExp(`<(?:[a-zA-Z][\\w.-]*:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z][\\w.-]*:)?${tag}>`, 'i');
  const match = xml.match(re);
  const inner = match?.[1];
  return typeof inner === 'string' && inner.trim().length > 0 ? inner : null;
}

function attr(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return match?.[2] ?? match?.[3] ?? null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  hellip: '…',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Reject non-characters and anything outside the Unicode range rather
      // than throwing from String.fromCodePoint on malformed input.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
      try {
        return String.fromCodePoint(code);
      } catch {
        return '';
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * CDATA-unwrap, strip embedded HTML, decode entities, collapse whitespace, then
 * hand to the platform sanitiser.
 *
 * Order matters: tags are stripped *before* entities are decoded, so a feed that
 * escapes markup as `&lt;b&gt;` keeps that as visible literal text instead of
 * having it silently promoted into a tag and removed.
 */
function cleanText(raw: string, maxLength: number): string {
  let s = raw;
  // A field can hold several CDATA sections; keep each section's contents.
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // <br> and </p> are the only structural markup worth preserving as a break.
  s = s.replace(/<\s*br\s*\/?\s*>/gi, ' ').replace(/<\/\s*p\s*>/gi, ' ');
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/\s+/g, ' ').trim();
  // Everything a feed contains is written by a stranger and ends up in front of
  // a language model.
  return sanitiseExternalText(s, maxLength);
}

/**
 * RSS uses RFC 822 dates ("Sat, 29 Aug 2026 15:27:56 GMT"), Atom uses RFC 3339
 * ("2026-08-29T18:40:56Z"). `Date.parse` handles both. A date more than a day in
 * the future is a broken publisher clock or a deliberate pin-to-top, and is
 * discarded rather than scored as maximally fresh.
 */
function parseFeedDate(raw: string | null): number | null {
  if (!raw) return null;
  const ms = Date.parse(cleanText(raw, 80));
  if (!Number.isFinite(ms)) return null;
  return ms;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function toSignal(
  item: FeedItem,
  feedUrl: URL,
  feedTitle: string | null,
  observedAt: number,
  maxAgeHours: number,
): RawTrendSignal | null {
  const publishedAt = item.publishedAt;
  const futureSkewMs = 24 * 3_600_000;
  const usablePublishedAt =
    publishedAt !== null && publishedAt <= observedAt + futureSkewMs ? publishedAt : null;

  let rawValue: number;
  let ageHours: number | null = null;
  if (usablePublishedAt === null) {
    /**
     * No parseable date. The item is kept — its existence is the breadth this
     * source contributes — but it scores zero, because inventing a recency for
     * it would be inventing the only number this provider produces.
     */
    rawValue = 0;
  } else {
    ageHours = Math.max((observedAt - usablePublishedAt) / 3_600_000, 0);
    if (ageHours > maxAgeHours) return null; // stale: contributes nothing
    rawValue = recencyWeight(ageHours, maxAgeHours);
  }

  const identity = item.guid ?? item.link ?? `${feedUrl.toString()}#${item.title}`;
  const signal: RawTrendSignal = {
    source: SOURCE_ID,
    // guid values are arbitrary publisher strings (URLs, UUIDs, opaque ids), so
    // they are hashed to a bounded, stable id instead of stored verbatim.
    externalId: `rss:${createHash('sha1').update(identity).digest('hex').slice(0, 20)}`,
    title: item.title,
    rawValue: Math.round(rawValue * 1000) / 1000,
    observedAt,
    // No engagement, no audience, no rank: a feed reports none of them, and the
    // absence is the honest answer. Feed order is editorial, not a ranking.
    metadata: {
      feedUrl: feedUrl.toString(),
      feedHost: feedUrl.hostname,
      ...(feedTitle ? { feedTitle } : {}),
      ...(usablePublishedAt !== null ? { publishedAt: usablePublishedAt } : { publishedAtMissing: true }),
      ...(ageHours !== null ? { ageHours: Math.round(ageHours * 100) / 100 } : {}),
      ...(item.author ? { author: item.author } : {}),
      ...(item.categories.length > 0 ? { feedCategories: item.categories } : {}),
      // Deliberately not mapped onto TrendCategory: feed <category> vocabularies
      // are per-publisher free text, and guessing a category here would poison
      // the downstream category priors.
      scoring: 'recency-weighted presence (breadth, not magnitude)',
    },
  };

  if (item.summary) signal.summary = item.summary;
  if (item.link) signal.url = item.link;

  const keywords = contentTokens(`${item.title} ${item.summary ?? ''}`).slice(0, 12);
  if (keywords.length > 0) signal.keywords = keywords;

  return signal;
}

/**
 * 1.0 for the first hour, then a straight line to 0 at `maxAgeHours`.
 *
 * Linear rather than exponential on purpose: the number is a presence weight
 * that a human operator has to be able to reason about ("half weight means
 * roughly twelve hours old"), and an exponential decay would compress almost
 * every item in a daily-publishing feed into the same near-zero band.
 */
function recencyWeight(ageHours: number, maxAgeHours: number): number {
  if (ageHours <= FULL_WEIGHT_HOURS) return 1;
  const span = Math.max(maxAgeHours - FULL_WEIGHT_HOURS, 1e-6);
  return clamp01(1 - (ageHours - FULL_WEIGHT_HOURS) / span);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Feed URLs can carry per-operator tokens in the query string. */
function redactFeed(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return raw.slice(0, 80);
  }
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
