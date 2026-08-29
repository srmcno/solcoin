import { sanitiseExternalText } from '@solcoin/shared';
import { systemClock, type Clock } from '../../core/clock.js';
import { safeErrorText } from '../../core/errors.js';
import { componentLogger } from '../../core/logger.js';
import { HttpClient, HttpError, type RateLimitConfig } from '../http.js';
import type { MarketProvider, ProviderStatus, TokenMarketData } from '../types.js';

/**
 * DexScreener — keyless pair-level market data.
 *
 * Complementary to Jupiter rather than redundant with it. Jupiter answers
 * "what is this token worth"; DexScreener answers "where does it actually
 * trade": every pool on every DEX, with per-pool liquidity, transaction counts
 * and the socials the deployer attached. It is also the only free source of
 * DexScreener's own `metas/trending` meme taxonomy, which is a direct measure
 * of how crowded a narrative already is.
 *
 * Endpoints used (verified live 2026-08-29):
 *   GET /token-pairs/v1/solana/{mint}          — every pair for one mint
 *   GET /tokens/v1/solana/{up to 30 mints}     — batch lookup
 *   GET /latest/dex/search?q={query}           — free-text search
 *   GET /token-profiles/latest/v1              — newly-profiled tokens
 *   GET /token-boosts/top/v1                   — paid-promotion leaderboard
 *   GET /metas/trending/v1                     — named meme narratives
 *
 * Gotchas confirmed against the live API:
 *
 *  - The legacy `/latest/dex/tokens/{address}` path is CHAIN-AGNOSTIC. It
 *    matches the address on every chain DexScreener indexes, so an address that
 *    also exists on an EVM chain returns that chain's pairs mixed in with
 *    Solana's. Everything here uses the chain-scoped `/token-pairs/v1/solana/`
 *    and `/tokens/v1/solana/` paths instead. `/latest/dex/search` is also
 *    cross-chain (one sample returned bsc, ethereum and robinhood pairs
 *    alongside solana), so its results are filtered on `chainId === 'solana'`.
 *  - `/tokens/v1/solana/{mints}` returns only ONE pair per mint — the top pair
 *    — not every pair. A mint with 21 pairs on `/token-pairs/v1` came back as a
 *    single entry. Volume summed from the batch endpoint is therefore the
 *    canonical pool's volume, not the token's. `getTokens` records which of the
 *    two it did in `dexscreener.aggregation` so no caller has to guess, and
 *    `{ allPairs: true }` forces the accurate (one-request-per-mint) path.
 *  - `/token-pairs/v1/solana/{mint}` returns pools where the mint is the QUOTE
 *    token as well as pools where it is the base. Verified live: USDC came back
 *    with 13 quote-side pools out of 30, and the highest-liquidity one was
 *    TRUMP/USDC. Every descriptive field on a pair — `baseToken`, `priceUsd`,
 *    `marketCap`, `fdv`, `priceChange`, and the `txns` buy/sell split —
 *    describes the BASE token, so aggregating a quote-side pool would have
 *    reported USDC as "OFFICIAL TRUMP" at $2.66. `aggregate` therefore builds
 *    the token view from base-side pools only and counts the rest in
 *    `dexscreener.quoteSidePairCount`.
 *  - `priceUsd`, `priceNative` and `liquidity.base`/`.quote` come back as
 *    STRINGS, while `volume`, `txns`, `marketCap` and `fdv` are numbers.
 *  - `liquidity`, `info`, `marketCap`, `fdv` and `pairCreatedAt` are all
 *    optional; brand-new pairs routinely omit several of them.
 *  - Observed `cache-control` was `max-age=30` on `/token-pairs/v1` and
 *    `max-age=60` on `/latest/dex/search` — the pairs family is documented as
 *    60 but serves 30. The client TTL follows the observed header: caching for
 *    longer than the origin does would hand the poller data the origin already
 *    considers stale.
 *
 * All volume figures are USD. `TokenMarketData` wants SOL, so an injected
 * SOL/USD getter converts them; when that price is unknown the SOL fields are
 * left undefined rather than guessed, and the USD figures remain on the extras.
 */

const BASE_URL = 'https://api.dexscreener.com';
const SOURCE = 'dexscreener';
const LABEL = 'DexScreener';

/**
 * Two quotas, two clients.
 *
 * DexScreener publishes 300 req/min for the pair-data family (/latest/dex/*,
 * /token-pairs/*, /tokens/*) and 60 req/min for the discovery family
 * (/token-profiles/*, /token-boosts/*, /metas/*). They are enforced separately,
 * so a single shared bucket would either throttle pair polling to a sixth of
 * its allowance or let discovery calls blow the 60/min ceiling.
 */
const PAIRS_RATE_LIMIT: RateLimitConfig = { requests: 300, intervalMs: 60_000, burst: 30 };
const DISCOVERY_RATE_LIMIT: RateLimitConfig = { requests: 60, intervalMs: 60_000, burst: 10 };

/** Observed `cache-control: max-age=30` on /token-pairs/v1. */
const PAIRS_CACHE_TTL_MS = 30_000;
/** Observed `max-age=60`; these lists move on the order of minutes. */
const DISCOVERY_CACHE_TTL_MS = 60_000;

/** `/tokens/v1/solana/{addresses}` accepts at most 30 comma-separated mints. */
const MAX_BATCH_MINTS = 30;

/** Solana mints are base58 and always land in this length range. */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const SOLANA_CHAIN_ID = 'solana';

export type DexScreenerWindow = 'm5' | 'h1' | 'h6' | 'h24';

/** One pool, normalised. Values are USD unless the name says otherwise. */
export interface DexScreenerPair {
  pairAddress: string;
  dexId: string;
  url?: string;
  baseMint: string;
  baseName?: string;
  baseSymbol?: string;
  quoteMint?: string;
  quoteSymbol?: string;
  priceUsd?: number;
  /** Price denominated in the quote token, not necessarily SOL. */
  priceNative?: number;
  liquidityUsd?: number;
  liquidityBase?: number;
  liquidityQuote?: number;
  marketCapUsd?: number;
  fdvUsd?: number;
  pairCreatedAtMs?: number;
  volumeUsd: Partial<Record<DexScreenerWindow, number>>;
  /** Percent change per window. */
  priceChangePct: Partial<Record<DexScreenerWindow, number>>;
  txns: Partial<Record<DexScreenerWindow, { buys: number; sells: number }>>;
  /** Sanitised; deployer-supplied. */
  websites?: string[];
  socials?: Array<{ type: string; url: string }>;
  imageUrl?: string;
}

export interface DexScreenerExtras {
  /**
   * 'all-pairs' — every pool for the mint was fetched and volume is the true
   * token-wide total. 'top-pair-only' — the batch endpoint answered with the
   * single canonical pool, so volume understates the token.
   */
  aggregation: 'all-pairs' | 'top-pair-only';
  /** Base-side pools only — the ones that describe this mint. */
  pairCount: number;
  /**
   * Pools that hold this mint as the QUOTE token. They are excluded from every
   * aggregate because their price, market cap, price change and buy/sell split
   * all describe the base token, not this one. Counted here so the omission is
   * visible rather than silent.
   */
  quoteSidePairCount?: number;
  /** The highest-liquidity base-side pool; the one whose price is reported. */
  canonicalPair: DexScreenerPair;
  /** Every base-side pool considered, highest liquidity first. */
  pairs: DexScreenerPair[];
  /** Distinct DEXes the token trades on — a real depth-of-market signal. */
  dexIds: string[];
  volume5mUsd?: number;
  volume1hUsd?: number;
  volume6hUsd?: number;
  volume24hUsd?: number;
  priceChange5mPct?: number;
  priceChange1hPct?: number;
  priceChange6hPct?: number;
  priceChange24hPct?: number;
  buys5m?: number;
  sells5m?: number;
  buys1h?: number;
  sells1h?: number;
}

export interface DexScreenerTokenMarketData extends TokenMarketData {
  dexscreener: DexScreenerExtras;
}

/** An entry from `/token-profiles/latest/v1` or `/token-boosts/*`. */
export interface DexScreenerTokenProfile {
  mint: string;
  url?: string;
  /** Sanitised: deployer-written marketing copy, shown to models. */
  description?: string;
  links: Array<{ type: string; url: string }>;
  /** Boost endpoints only: how much promotion has been bought. */
  boostAmount?: number;
  totalBoostAmount?: number;
}

/** An entry from `/metas/trending/v1` — a named narrative, not a token. */
export interface DexScreenerMeta {
  slug: string;
  name: string;
  description?: string;
  /** How many tokens already exist under this narrative — saturation, directly. */
  tokenCount: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
  volumeUsd?: number;
  marketCapChangePct: Partial<Record<DexScreenerWindow, number>>;
  observedAt: number;
}

export interface DexScreenerProviderOptions {
  clock?: Clock;
  timeoutMs?: number;
  baseUrl?: string;
  /**
   * SOL/USD, used only to express volumes in SOL. Returning null (or omitting
   * this entirely) leaves every SOL-denominated field undefined, which is the
   * correct answer when the rate is unknown.
   */
  solPriceUsd?: (options?: { signal?: AbortSignal }) => Promise<number | null>;
  pairsCacheTtlMs?: number;
  discoveryCacheTtlMs?: number;
  pairsRateLimit?: RateLimitConfig;
  discoveryRateLimit?: RateLimitConfig;
  /** Injectable clients, for tests. */
  http?: HttpClient;
  discoveryHttp?: HttpClient;
}

export interface DexScreenerProvider extends MarketProvider {
  getTokens(
    mints: readonly string[],
    options?: { signal?: AbortSignal; allPairs?: boolean },
  ): Promise<DexScreenerTokenMarketData[]>;
  searchTokens(
    query: string,
    options?: { limit?: number; signal?: AbortSignal },
  ): Promise<DexScreenerTokenMarketData[]>;
  /** Every pool for one mint, highest liquidity first. */
  getPairs(mint: string, options?: { signal?: AbortSignal }): Promise<DexScreenerPair[]>;
  /** Newest tokens with a filled-in DexScreener profile. Solana only. */
  latestTokenProfiles(options?: { signal?: AbortSignal }): Promise<DexScreenerTokenProfile[]>;
  /** Tokens whose teams are paying for placement — a promotion-spend signal. */
  topBoostedTokens(options?: { signal?: AbortSignal }): Promise<DexScreenerTokenProfile[]>;
  /** Trending meme narratives with token counts, for saturation analysis. */
  trendingMetas(options?: { signal?: AbortSignal }): Promise<DexScreenerMeta[]>;
}

export function createDexScreenerProvider(deps: DexScreenerProviderOptions = {}): DexScreenerProvider {
  const log = componentLogger('provider.dexscreener');
  const clock = deps.clock ?? systemClock;
  const baseUrl = `${(deps.baseUrl ?? BASE_URL).replace(/\/+$/, '')}/`;

  const stats: { lastSuccessAt?: number; lastFailureAt?: number } = {};
  const onResult = (r: { ok: boolean }) => {
    if (r.ok) stats.lastSuccessAt = clock.now();
    else stats.lastFailureAt = clock.now();
  };

  const pairsHttp =
    deps.http ??
    new HttpClient({
      name: 'dexscreener',
      baseUrl,
      timeoutMs: deps.timeoutMs ?? 15_000,
      rateLimit: { ...(deps.pairsRateLimit ?? PAIRS_RATE_LIMIT) },
      // Matches the origin's own max-age: polling faster than this returns the
      // identical CDN-cached body and only burns quota.
      cacheTtlMs: deps.pairsCacheTtlMs ?? PAIRS_CACHE_TTL_MS,
      clock,
      onResult,
    });

  const discoveryHttp =
    deps.discoveryHttp ??
    new HttpClient({
      name: 'dexscreener-discovery',
      baseUrl,
      timeoutMs: deps.timeoutMs ?? 15_000,
      rateLimit: { ...(deps.discoveryRateLimit ?? DISCOVERY_RATE_LIMIT) },
      cacheTtlMs: deps.discoveryCacheTtlMs ?? DISCOVERY_CACHE_TTL_MS,
      clock,
      onResult,
    });

  async function solPriceUsd(signal?: AbortSignal): Promise<number | null> {
    if (!deps.solPriceUsd) return null;
    try {
      const price = await deps.solPriceUsd(signal ? { signal } : {});
      return price !== null && Number.isFinite(price) && price > 0 ? price : null;
    } catch (e) {
      log.debug({ err: safeErrorText(e, 160) }, 'sol price getter failed; SOL fields omitted');
      return null;
    }
  }

  async function fetchPairsForMint(mint: string, signal?: AbortSignal): Promise<DexScreenerPair[]> {
    // Chain-scoped path. Never `/latest/dex/tokens/{mint}`: see the file header.
    const body = await pairsHttp.request<unknown>(`token-pairs/v1/${SOLANA_CHAIN_ID}/${encodeURIComponent(mint)}`, {
      ...(signal ? { signal } : {}),
    });
    return readPairs(body).filter((p) => p.baseMint === mint || p.quoteMint === mint);
  }

  async function getPairs(mint: string, options?: { signal?: AbortSignal }): Promise<DexScreenerPair[]> {
    if (!MINT_RE.test(mint.trim())) return [];
    const pairs = await fetchPairsForMint(mint.trim(), options?.signal);
    return sortByLiquidity(pairs);
  }

  async function getTokens(
    mints: readonly string[],
    options?: { signal?: AbortSignal; allPairs?: boolean },
  ): Promise<DexScreenerTokenMarketData[]> {
    const unique = normaliseMints(mints);
    if (unique.length === 0) return [];

    const solUsd = await solPriceUsd(options?.signal);
    const observedAt = clock.now();
    const out: DexScreenerTokenMarketData[] = [];

    // One mint is always fetched the accurate way: a single extra request buys
    // true token-wide volume, and the monitoring poller works one token at a
    // time. Larger sets default to the batch endpoint so a 300-token sweep is
    // 10 requests instead of 300.
    if (options?.allPairs === true || unique.length === 1) {
      for (const mint of unique) {
        try {
          const pairs = await fetchPairsForMint(mint, options?.signal);
          const token = aggregate(mint, pairs, 'all-pairs', { observedAt, solUsd });
          if (token) out.push(token);
        } catch (e) {
          // A mint DexScreener has never indexed 404s. That is "no data", not a
          // provider failure, and must not abort the rest of the sweep.
          if (e instanceof HttpError && e.status === 404) continue;
          throw e;
        }
      }
      return out;
    }

    for (const batch of chunk(unique, MAX_BATCH_MINTS)) {
      let body: unknown;
      try {
        body = await pairsHttp.request<unknown>(`tokens/v1/${SOLANA_CHAIN_ID}/${batch.join(',')}`, {
          ...(options?.signal ? { signal: options.signal } : {}),
        });
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) continue;
        throw e;
      }
      const pairs = readPairs(body);
      const byMint = new Map<string, DexScreenerPair[]>();
      for (const pair of pairs) {
        // The batch endpoint keys results by base token; a mint that only ever
        // appears as the quote side is not answerable here.
        const existing = byMint.get(pair.baseMint);
        if (existing) existing.push(pair);
        else byMint.set(pair.baseMint, [pair]);
      }
      for (const mint of batch) {
        const forMint = byMint.get(mint);
        if (!forMint || forMint.length === 0) continue;
        const token = aggregate(mint, forMint, 'top-pair-only', { observedAt, solUsd });
        if (token) out.push(token);
      }
    }
    return out;
  }

  const base = {
    id: SOURCE,
    label: LABEL,
    kind: 'market' as const,
    // Fully keyless; there is nothing an operator could configure.
    requiresCredentials: false,
  };

  return {
    id: SOURCE,
    label: LABEL,
    kind: 'market',

    async healthCheck(): Promise<ProviderStatus> {
      const started = clock.now();
      try {
        // wSOL is guaranteed to have pairs, and the response is shared with the
        // 30s cache, so repeated probes cost one request per half-minute.
        const pairs = await fetchPairsForMint('So11111111111111111111111111111111111111112');
        return {
          ...base,
          state: pairs.length > 0 ? 'ok' : 'degraded',
          detail:
            pairs.length > 0
              ? `token-pairs reachable (${pairs.length} wSOL pairs)`
              : 'token-pairs responded but returned no pairs for wSOL',
          latencyMs: clock.now() - started,
          lastSuccessAt: clock.now(),
          ...optional('lastFailureAt', stats.lastFailureAt),
        };
      } catch (e) {
        return {
          ...base,
          state: 'down',
          detail: safeErrorText(e, 200),
          latencyMs: clock.now() - started,
          ...optional('lastSuccessAt', stats.lastSuccessAt),
          lastFailureAt: clock.now(),
        };
      }
    },

    getTokens,
    getPairs,

    async searchTokens(
      query: string,
      options?: { limit?: number; signal?: AbortSignal },
    ): Promise<DexScreenerTokenMarketData[]> {
      const q = query.trim();
      if (!q) return [];

      const body = await pairsHttp.request<unknown>('latest/dex/search', {
        query: { q },
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      // Search spans every indexed chain; anything not on Solana is noise here
      // and would corrupt a saturation count with unrelated EVM tokens.
      const pairs = readPairs(isRecord(body) ? body['pairs'] : undefined);

      const solUsd = await solPriceUsd(options?.signal);
      const observedAt = clock.now();

      const byMint = new Map<string, DexScreenerPair[]>();
      for (const pair of pairs) {
        const existing = byMint.get(pair.baseMint);
        if (existing) existing.push(pair);
        else byMint.set(pair.baseMint, [pair]);
      }

      const out: DexScreenerTokenMarketData[] = [];
      for (const [mint, forMint] of byMint) {
        // Search returns a ranked page, not a token's full pool set, so the
        // aggregation is honestly labelled as partial.
        const token = aggregate(mint, forMint, 'top-pair-only', { observedAt, solUsd });
        if (token) out.push(token);
      }
      // Highest liquidity first: search ranking mixes chains and relevance, and
      // liquidity is the ordering a saturation review actually wants.
      out.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
      const limit = clampInt(options?.limit ?? out.length, 0, out.length);
      return out.slice(0, limit);
    },

    async recentLaunches(options?: { limit?: number; signal?: AbortSignal }): Promise<TokenMarketData[]> {
      // DexScreener has no "newest pairs" endpoint on the free API. The nearest
      // thing is the latest token profiles, which is a curated list, not the
      // launch stream — so those are resolved to real market data here rather
      // than being passed off as a launch feed. Jupiter's /tokens/v2/recent is
      // the true launch stream; this exists so the interface is honest about
      // what DexScreener can actually see.
      const profiles = await fetchProfiles('token-profiles/latest/v1', options?.signal);
      const mints = profiles.map((p) => p.mint).slice(0, clampInt(options?.limit ?? 30, 0, MAX_BATCH_MINTS));
      if (mints.length === 0) return [];
      return getTokens(mints, options?.signal ? { signal: options.signal } : {});
    },

    async latestTokenProfiles(options?: { signal?: AbortSignal }): Promise<DexScreenerTokenProfile[]> {
      return fetchProfiles('token-profiles/latest/v1', options?.signal);
    },

    async topBoostedTokens(options?: { signal?: AbortSignal }): Promise<DexScreenerTokenProfile[]> {
      return fetchProfiles('token-boosts/top/v1', options?.signal);
    },

    async trendingMetas(options?: { signal?: AbortSignal }): Promise<DexScreenerMeta[]> {
      const body = await discoveryHttp.request<unknown>('metas/trending/v1', {
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      if (!Array.isArray(body)) return [];
      const observedAt = clock.now();
      const out: DexScreenerMeta[] = [];
      for (const raw of body) {
        if (!isRecord(raw)) continue;
        const slug = asString(raw['slug']);
        const name = asString(raw['name']);
        const tokenCount = finiteNumber(raw['tokenCount']);
        if (!slug || !name || tokenCount === null) continue;
        out.push({
          slug: sanitiseExternalText(slug, 80),
          name: sanitiseExternalText(name, 80),
          // Meta descriptions are user-facing copy DexScreener sources from the
          // community ("pspspspspsp"), so they are untrusted like any other
          // external string.
          ...optional('description', sanitiseOptional(asString(raw['description']), 300)),
          tokenCount,
          ...optional('marketCapUsd', finiteNumber(raw['marketCap'])),
          ...optional('liquidityUsd', finiteNumber(raw['liquidity'])),
          ...optional('volumeUsd', finiteNumber(raw['volume'])),
          marketCapChangePct: readWindowNumbers(raw['marketCapChange']),
          observedAt,
        });
      }
      return out;
    },
  };

  async function fetchProfiles(path: string, signal?: AbortSignal): Promise<DexScreenerTokenProfile[]> {
    const body = await discoveryHttp.request<unknown>(path, { ...(signal ? { signal } : {}) });
    if (!Array.isArray(body)) return [];
    const out: DexScreenerTokenProfile[] = [];
    for (const raw of body) {
      if (!isRecord(raw)) continue;
      // These lists are cross-chain: a single page mixed robinhood, bsc and
      // solana entries.
      if (asString(raw['chainId']) !== SOLANA_CHAIN_ID) continue;
      const mint = asString(raw['tokenAddress']);
      if (!mint || !MINT_RE.test(mint)) continue;
      out.push({
        mint,
        ...optional('url', sanitiseOptional(asString(raw['url']), 300)),
        // Deployer-written marketing copy that reaches a model: untrusted.
        ...optional('description', sanitiseOptional(asString(raw['description']), 600)),
        links: readLinks(raw['links']),
        ...optional('boostAmount', finiteNumber(raw['amount'])),
        ...optional('totalBoostAmount', finiteNumber(raw['totalAmount'])),
      });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Collapse a mint's pools into one market view.
 *
 * Price, market cap and liquidity come from the single highest-liquidity pool:
 * that is the pool a trade of any size actually executes against, and averaging
 * prices across a deep pool and a dust pool produces a number that exists
 * nowhere. Volume and transaction counts are SUMMED across every pool, because
 * a token's real activity is the sum of what happened everywhere it trades and
 * taking only the canonical pool would understate a token that migrated venues
 * mid-window.
 *
 * Only pools where `mint` is the BASE token are considered. DexScreener
 * describes every pair from the base token's point of view, so a pool that
 * holds this mint as the quote asset carries the other token's price, market
 * cap, price change and buy/sell direction; folding one in produces a record
 * that is confidently about the wrong token.
 */
function aggregate(
  mint: string,
  pairs: readonly DexScreenerPair[],
  aggregation: 'all-pairs' | 'top-pair-only',
  ctx: { observedAt: number; solUsd: number | null },
): DexScreenerTokenMarketData | null {
  const all = sortByLiquidity(pairs);
  const sorted = all.filter((p) => p.baseMint === mint);
  const quoteSidePairCount = all.length - sorted.length;
  const canonical = sorted[0];
  // Every pool DexScreener knows holds this mint as the quote asset, so it has
  // no market view of the token itself. Null means "no data", which is the
  // honest answer; a quote-side pool would answer about a different token.
  if (!canonical) return null;

  const sumVolume = (w: DexScreenerWindow): number | undefined => {
    let total: number | undefined;
    for (const p of sorted) {
      const v = p.volumeUsd[w];
      if (v === undefined) continue;
      total = (total ?? 0) + v;
    }
    return total;
  };
  const sumTxns = (w: DexScreenerWindow): { buys: number; sells: number } | undefined => {
    let buys: number | undefined;
    let sells: number | undefined;
    for (const p of sorted) {
      const t = p.txns[w];
      if (!t) continue;
      buys = (buys ?? 0) + t.buys;
      sells = (sells ?? 0) + t.sells;
    }
    return buys === undefined || sells === undefined ? undefined : { buys, sells };
  };

  const toSol = (usd: number | undefined): number | undefined =>
    usd !== undefined && ctx.solUsd !== null && ctx.solUsd > 0 ? usd / ctx.solUsd : undefined;

  const volume5mUsd = sumVolume('m5');
  const volume1hUsd = sumVolume('h1');
  const volume6hUsd = sumVolume('h6');
  const volume24hUsd = sumVolume('h24');
  const txns24h = sumTxns('h24');
  const txns5m = sumTxns('m5');
  const txns1h = sumTxns('h1');

  // Liquidity is additive: it is the depth a seller could actually hit, and it
  // genuinely exists in every pool at once.
  let liquidityUsd: number | undefined;
  for (const p of sorted) {
    if (p.liquidityUsd === undefined) continue;
    liquidityUsd = (liquidityUsd ?? 0) + p.liquidityUsd;
  }

  // Earliest pool creation is the token's market birth; later pools are
  // migrations or secondary venues.
  let createdAtMs: number | undefined;
  for (const p of sorted) {
    if (p.pairCreatedAtMs === undefined) continue;
    createdAtMs = createdAtMs === undefined ? p.pairCreatedAtMs : Math.min(createdAtMs, p.pairCreatedAtMs);
  }

  const dexIds = [...new Set(sorted.map((p) => p.dexId).filter((d) => d.length > 0))];

  const extras: DexScreenerExtras = {
    aggregation,
    pairCount: sorted.length,
    ...optional('quoteSidePairCount', quoteSidePairCount > 0 ? quoteSidePairCount : undefined),
    canonicalPair: canonical,
    pairs: sorted,
    dexIds,
    ...optional('volume5mUsd', volume5mUsd),
    ...optional('volume1hUsd', volume1hUsd),
    ...optional('volume6hUsd', volume6hUsd),
    ...optional('volume24hUsd', volume24hUsd),
    // Price change is read from the canonical pool only: a percentage cannot be
    // summed, and the deepest pool is the one that sets the reference price.
    ...optional('priceChange5mPct', canonical.priceChangePct.m5),
    ...optional('priceChange1hPct', canonical.priceChangePct.h1),
    ...optional('priceChange6hPct', canonical.priceChangePct.h6),
    ...optional('priceChange24hPct', canonical.priceChangePct.h24),
    ...optional('buys5m', txns5m?.buys),
    ...optional('sells5m', txns5m?.sells),
    ...optional('buys1h', txns1h?.buys),
    ...optional('sells1h', txns1h?.sells),
  };

  return {
    mint,
    ...optional('name', canonical.baseName),
    ...optional('symbol', canonical.baseSymbol),
    ...optional('priceUsd', canonical.priceUsd),
    // priceNative is only SOL when the pool's quote token is SOL. For a
    // USDC-quoted pool it is a USDC price, so it is never assumed to be SOL;
    // the conversion goes through the USD price instead.
    ...optional('priceSol', toSol(canonical.priceUsd)),
    ...optional('marketCapUsd', canonical.marketCapUsd ?? canonical.fdvUsd),
    ...optional('liquidityUsd', liquidityUsd),
    ...optional('volume5mSol', toSol(volume5mUsd)),
    ...optional('volume1hSol', toSol(volume1hUsd)),
    ...optional('volume24hSol', toSol(volume24hUsd)),
    ...optional('volume24hUsd', volume24hUsd),
    ...optional('txCount24h', txns24h ? txns24h.buys + txns24h.sells : undefined),
    ...optional('buys24h', txns24h?.buys),
    ...optional('sells24h', txns24h?.sells),
    // DexScreener exposes no holder count and no bonding-curve state; those
    // fields stay absent rather than being invented.
    ...optional('createdAtMs', createdAtMs),
    // A pump.fun token that has a pumpswap/raydium/orca pool has left the
    // bonding curve by definition — that is what migration means. Absence of
    // such a pool here is not evidence of the opposite (the token may simply be
    // unindexed), so `false` is never asserted.
    ...optional('graduated', dexIds.some(isGraduatedDex) ? true : undefined),
    poolAddress: canonical.pairAddress,
    source: SOURCE,
    observedAt: ctx.observedAt,
    dexscreener: extras,
  };
}

/**
 * DEXes that only ever hold post-bonding-curve liquidity. `pumpswap` is
 * pump.fun's own AMM, which a token reaches only after graduating.
 */
function isGraduatedDex(dexId: string): boolean {
  return dexId === 'pumpswap' || dexId === 'raydium' || dexId === 'orca' || dexId === 'meteora';
}

function sortByLiquidity(pairs: readonly DexScreenerPair[]): DexScreenerPair[] {
  return [...pairs].sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function readPairs(body: unknown): DexScreenerPair[] {
  if (!Array.isArray(body)) return [];
  const out: DexScreenerPair[] = [];
  for (const raw of body) {
    const pair = readPair(raw);
    // A malformed pair is dropped; the rest of the page is still usable data.
    if (pair) out.push(pair);
  }
  return out;
}

function readPair(raw: unknown): DexScreenerPair | null {
  if (!isRecord(raw)) return null;
  // Chain guard: /latest/dex/search and the legacy token path both return other
  // chains' pairs, and an EVM pair here would poison every aggregate below.
  if (asString(raw['chainId']) !== SOLANA_CHAIN_ID) return null;

  // Addresses are structural: they key market records and are pasted into
  // explorer links, so they are shape-checked rather than sanitised. Anything
  // that is not a base58 pubkey is not an address and the pair is unusable.
  const pairAddress = asAddress(raw['pairAddress']);
  const baseToken = isRecord(raw['baseToken']) ? raw['baseToken'] : null;
  const baseMint = baseToken ? asAddress(baseToken['address']) : null;
  if (!pairAddress || !baseMint) return null;

  const quoteToken = isRecord(raw['quoteToken']) ? raw['quoteToken'] : null;
  const liquidity = isRecord(raw['liquidity']) ? raw['liquidity'] : null;
  const info = isRecord(raw['info']) ? raw['info'] : null;

  return {
    pairAddress,
    dexId: sanitiseOptional(asString(raw['dexId']), 32) ?? '',
    ...optional('url', sanitiseOptional(asString(raw['url']), 300)),
    baseMint,
    // Token names and symbols are attacker-controlled — anyone can mint a token
    // whose name is a prompt-injection payload — and they reach a model.
    ...optional('baseName', sanitiseOptional(asString(baseToken?.['name']), 120)),
    ...optional('baseSymbol', sanitiseOptional(asString(baseToken?.['symbol']), 32)),
    ...optional('quoteMint', quoteToken ? asAddress(quoteToken['address']) : undefined),
    ...optional('quoteSymbol', sanitiseOptional(quoteToken ? asString(quoteToken['symbol']) : null, 32)),
    // priceUsd / priceNative arrive as strings ("0.005923").
    ...optional('priceUsd', finiteNumber(raw['priceUsd'])),
    ...optional('priceNative', finiteNumber(raw['priceNative'])),
    ...optional('liquidityUsd', finiteNumber(liquidity?.['usd'])),
    ...optional('liquidityBase', finiteNumber(liquidity?.['base'])),
    ...optional('liquidityQuote', finiteNumber(liquidity?.['quote'])),
    ...optional('marketCapUsd', finiteNumber(raw['marketCap'])),
    ...optional('fdvUsd', finiteNumber(raw['fdv'])),
    // pairCreatedAt is already epoch MILLISECONDS here, unlike Jupiter's ISO
    // strings.
    ...optional('pairCreatedAtMs', finiteNumber(raw['pairCreatedAt'])),
    volumeUsd: readWindowNumbers(raw['volume']),
    priceChangePct: readWindowNumbers(raw['priceChange']),
    txns: readTxns(raw['txns']),
    ...optional('websites', readUrlList(info?.['websites'])),
    ...optional('socials', readSocials(info?.['socials'])),
    ...optional('imageUrl', sanitiseOptional(asString(info?.['imageUrl']), 300)),
  };
}

const WINDOWS: DexScreenerWindow[] = ['m5', 'h1', 'h6', 'h24'];

function readWindowNumbers(raw: unknown): Partial<Record<DexScreenerWindow, number>> {
  const out: Partial<Record<DexScreenerWindow, number>> = {};
  if (!isRecord(raw)) return out;
  for (const w of WINDOWS) {
    const v = finiteNumber(raw[w]);
    if (v !== null) out[w] = v;
  }
  return out;
}

function readTxns(raw: unknown): Partial<Record<DexScreenerWindow, { buys: number; sells: number }>> {
  const out: Partial<Record<DexScreenerWindow, { buys: number; sells: number }>> = {};
  if (!isRecord(raw)) return out;
  for (const w of WINDOWS) {
    const entry = raw[w];
    if (!isRecord(entry)) continue;
    const buys = finiteNumber(entry['buys']);
    const sells = finiteNumber(entry['sells']);
    if (buys === null || sells === null) continue;
    out[w] = { buys, sells };
  }
  return out;
}

function readUrlList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const entry of raw) {
    const url = isRecord(entry) ? asString(entry['url']) : asString(entry);
    const clean = sanitiseOptional(url, 300);
    if (clean) out.push(clean);
  }
  return out.length > 0 ? out : undefined;
}

function readSocials(raw: unknown): Array<{ type: string; url: string }> | undefined {
  const links = readLinks(raw);
  return links.length > 0 ? links : undefined;
}

/** Shared by pair `info.socials` and profile/boost `links`. */
function readLinks(raw: unknown): Array<{ type: string; url: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ type: string; url: string }> = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const url = sanitiseOptional(asString(entry['url']), 300);
    if (!url) continue;
    // Profiles use `label` ("Website"), pair socials use `type` ("twitter").
    const type = asString(entry['type']) ?? asString(entry['label']) ?? 'link';
    out.push({ type: sanitiseExternalText(type, 32).toLowerCase(), url });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseMints(mints: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of mints) {
    if (typeof m !== 'string') continue;
    const trimmed = m.trim();
    if (!MINT_RE.test(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * A base58 Solana pubkey, or null. Used for every address-shaped field so a
 * malformed or injected value is rejected outright instead of being sanitised
 * into a plausible-looking but meaningless address.
 */
function asAddress(value: unknown): string | null {
  const s = asString(value);
  return s !== null && MINT_RE.test(s) ? s : null;
}

/** DexScreener mixes numeric strings and numbers in the same payload. */
function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function sanitiseOptional(value: string | null | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const clean = sanitiseExternalText(value, maxLength);
  return clean.length > 0 ? clean : undefined;
}

/** `...optional('k', v)` contributes nothing when the value is absent. */
function optional<K extends string, V>(key: K, value: V | null | undefined): Partial<Record<K, V>> {
  return value === null || value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>);
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
