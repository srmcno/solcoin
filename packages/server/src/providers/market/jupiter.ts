import { sanitiseExternalText } from '@solcoin/shared';
import { systemClock, type Clock } from '../../core/clock.js';
import { safeErrorText } from '../../core/errors.js';
import { componentLogger } from '../../core/logger.js';
import { HttpClient, HttpError, type RateLimitConfig } from '../http.js';
import type {
  HolderProvider,
  MarketProvider,
  PriceProvider,
  ProviderStatus,
  TokenMarketData,
} from '../types.js';

/**
 * Jupiter Token API v2 + Price API v3 — the platform's primary market source.
 *
 * One host answers every question the launch pipeline asks about a mint: price,
 * market cap, liquidity, holder count, per-window buy/sell flow, the mint/freeze
 * authority audit, top-holder concentration, launchpad provenance and Jupiter's
 * own `organicScore` (its estimate of how much of the activity is real rather
 * than wash traded). Nothing else in the stack gives all of that in one call,
 * which is why this file is the highest-leverage adapter in the platform.
 *
 * Endpoints used (all verified live 2026-08-29 against lite-api.jup.ag):
 *   GET /tokens/v2/search?query=<up to 100 comma-separated mints | free text>
 *   GET /tokens/v2/recent
 *   GET /tokens/v2/toporganicscore/{5m|1h|6h|24h}?limit=
 *   GET /price/v3?ids=<up to 50 comma-separated mints>
 *
 * Live observations that differ from the published docs, and which the parser
 * is written against:
 *
 *  - There is no `organicVolume` field. Each stats window carries
 *    `buyOrganicVolume` and `sellOrganicVolume` separately; organic volume is
 *    their sum (see `readWindow`). `numOrganicBuyers` and `numNetBuyers` do
 *    exist as documented.
 *  - `firstPool.createdAt`, `graduatedAt`, `createdAt` and `updatedAt` are ISO-8601
 *    STRINGS, not epoch milliseconds.
 *  - `audit` is sparse: a fresh pump.fun mint returned only
 *    `{mintAuthorityDisabled, freezeAuthorityDisabled, devMints}` with no
 *    `topHoldersPercentage` and no `devBalancePercentage`. Absent means unknown,
 *    never zero.
 *  - `holderCount` is absent for tokens minted seconds ago, and `stats*` windows
 *    are absent for tokens with no trading in that window.
 *  - `audit.topHoldersPercentage` is a PERCENT (26.4 for a mid-cap pump token,
 *    0.58 for wSOL), while `HolderProvider.top10Share` is consumed downstream as
 *    a FRACTION (monitoring.service computes it as sum/total). It is divided by
 *    100 on the way out.
 *  - `stats*.priceChange` / `holderChange` / `liquidityChange` / `volumeChange`
 *    are percentages, not ratios (wSOL 24h priceChange 1.78 == +1.78%).
 *  - /price/v2 is REMOVED and returns 404. Only v3 exists.
 *
 * All volume figures from Jupiter are USD. `TokenMarketData` wants SOL, so they
 * are divided by the SOL/USD price. If that price cannot be obtained the SOL
 * fields are left undefined — a guessed volume would flow straight into launch
 * sizing, so absence is the only honest answer. The full USD figures are always
 * preserved on `JupiterTokenExtras`.
 */

const LITE_BASE_URL = 'https://lite-api.jup.ag';
/** Paid tier. Same paths, different host, requires the key header. */
const PRO_BASE_URL = 'https://api.jup.ag';
const CREDENTIAL_KEY = 'market.jupiter.api_key';

export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Keyless quota is 30 requests/minute as ONE sliding window shared by every
 * Jupiter endpoint — /price and /tokens draw on the same budget. That is why
 * this file builds exactly one HttpClient and routes every method through it:
 * two clients would each believe they owned 30 rpm and together earn a 429.
 *
 * Burst is held well below the sustained rate: the upstream window is a sliding
 * one, so spending all 30 tokens in a second leaves the next 59 seconds blocked
 * upstream even though the local bucket has refilled.
 */
const FREE_RATE_LIMIT: RateLimitConfig = { requests: 30, intervalMs: 60_000, burst: 6 };

/**
 * Paid tier. Jupiter's entry paid plan is an order of magnitude above keyless;
 * 600/min with a burst of 30 stays inside the smallest paid plan while making
 * the batching below effectively unbounded.
 */
const PRO_RATE_LIMIT: RateLimitConfig = { requests: 600, intervalMs: 60_000, burst: 30 };

/**
 * Batch ceilings imposed by the API. /tokens/v2/search takes up to 100 mints in
 * one `query` (verified with 30; 100 is the documented cap), /price/v3 up to 50
 * ids. At the keyless 30 rpm that is 3,000 tokens/minute of market data or
 * 1,500 tokens/minute of price — far more than the poller needs.
 */
const MAX_SEARCH_BATCH = 100;
const MAX_PRICE_BATCH = 50;

/** /tokens/v2/recent returns a fixed page of the 30 newest first-pool tokens. */
const RECENT_PAGE_SIZE = 30;
const MAX_TOP_ORGANIC_LIMIT = 100;

/**
 * Prices move continuously, so this cache exists to protect the 30 rpm budget
 * rather than to serve stale data: it collapses the health probe, the SOL-price
 * lookup and repeated polls of the same mint inside one scheduler tick into a
 * single upstream request.
 */
const DEFAULT_CACHE_TTL_MS = 15_000;

/** SOL/USD is only used to convert volumes; a slightly stale rate is harmless. */
const SOL_PRICE_TTL_MS = 20_000;

/** Solana mints are base58 and always land in this length range. */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type JupiterStatsWindow = '5m' | '1h' | '6h' | '24h';
export type JupiterOrganicScoreLabel = 'high' | 'medium' | 'low';

/** One `stats5m`/`stats1h`/`stats6h`/`stats24h` block, normalised. */
export interface JupiterWindowStats {
  /** Percent change over the window (Jupiter reports percent, not ratio). */
  priceChangePct?: number;
  holderChangePct?: number;
  liquidityChangePct?: number;
  volumeChangePct?: number;
  buyVolumeUsd?: number;
  sellVolumeUsd?: number;
  /** buyVolumeUsd + sellVolumeUsd, when either side is present. */
  totalVolumeUsd?: number;
  /**
   * Jupiter ships organic volume split by side; this is the sum. Organic volume
   * is its estimate of the flow left after wash/bot activity is discounted, so
   * `organicVolumeUsd / totalVolumeUsd` is a directly usable authenticity ratio.
   */
  organicVolumeUsd?: number;
  numBuys?: number;
  numSells?: number;
  numTraders?: number;
  numOrganicBuyers?: number;
  numNetBuyers?: number;
}

/** `audit` block. Every field is optional upstream; absent means unknown. */
export interface JupiterAudit {
  mintAuthorityDisabled?: boolean;
  freezeAuthorityDisabled?: boolean;
  /** Percent (0..100) of supply held by the top holders. */
  topHoldersPercentage?: number;
  /** Percent (0..100) of supply still held by the deployer. */
  devBalancePercentage?: number;
  /** How many of the dev's previous tokens graduated — a serial-rugger signal. */
  devMigrations?: number;
  /** How many tokens the dev has minted in total. */
  devMints?: number;
}

/**
 * Jupiter-specific fields with no home on `TokenMarketData`.
 *
 * Carried as a nested, clearly-typed extra rather than by widening the shared
 * contract, so consumers that only know `TokenMarketData` are unaffected.
 */
export interface JupiterTokenExtras {
  /** 0..100 authenticity score. Jupiter's own anti-wash-trading metric. */
  organicScore?: number;
  organicScoreLabel?: JupiterOrganicScoreLabel;
  isVerified?: boolean;
  /** e.g. "pump.fun", "bonk.fun". Absent for tokens with no known launchpad. */
  launchpad?: string;
  /** Deployer wallet, when the launchpad exposes it. */
  dev?: string;
  decimals?: number;
  tokenProgram?: string;
  circSupply?: number;
  totalSupply?: number;
  fdvUsd?: number;
  audit: JupiterAudit;
  /** Present windows only; a window with no trading is omitted upstream. */
  stats: Partial<Record<JupiterStatsWindow, JupiterWindowStats>>;
  firstPoolAddress?: string;
  firstPoolCreatedAtMs?: number;
  graduatedPool?: string;
  graduatedAtMs?: number;
  /** Sanitised; these are operator-supplied strings from token metadata. */
  tags?: string[];
  website?: string;
  twitter?: string;
  telegram?: string;
  /** Which Jupiter tier answered: 'lite' (keyless) or 'pro' (API key). */
  tier: 'lite' | 'pro';
}

export interface JupiterTokenMarketData extends TokenMarketData {
  jupiter: JupiterTokenExtras;
}

export interface JupiterPrice {
  mint: string;
  usdPrice: number;
  decimals?: number;
  blockId?: number;
  /** Percent change over 24h. */
  priceChange24hPct?: number;
  observedAt: number;
}

export interface JupiterProviderOptions {
  /** Optional: a key upgrades this provider to the paid host and quota. */
  getCredential?: (key: string) => Promise<string | null>;
  clock?: Clock;
  timeoutMs?: number;
  cacheTtlMs?: number;
  liteBaseUrl?: string;
  proBaseUrl?: string;
  freeRateLimit?: RateLimitConfig;
  proRateLimit?: RateLimitConfig;
  /**
   * Supply SOL/USD from elsewhere (e.g. an oracle already polled by the
   * scheduler) to keep volume conversion from spending Jupiter quota.
   */
  solPriceUsd?: (options?: { signal?: AbortSignal }) => Promise<number | null>;
  /** Injectable client, for tests. Bypasses tier selection entirely. */
  http?: HttpClient;
}

/**
 * Jupiter answers market, holder and price questions from the same quota, so it
 * implements all three provider roles rather than being split into three
 * adapters that would each need their own rate limiter.
 */
export interface JupiterProvider extends MarketProvider, HolderProvider, PriceProvider {
  readonly kind: 'market';
  /** Same as getTokens, but typed with the Jupiter-only fields. */
  getTokensDetailed(
    mints: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<JupiterTokenMarketData[]>;
  /** Cheap price-only lookup; 50 mints per request instead of 100. */
  getPrices(
    mints: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<Map<string, JupiterPrice>>;
  /** Highest-organic-score tokens over a window — the least-manipulated movers. */
  topOrganicScore(
    window: JupiterStatsWindow,
    options?: { limit?: number; signal?: AbortSignal },
  ): Promise<JupiterTokenMarketData[]>;
  recentLaunches(options?: { limit?: number; signal?: AbortSignal }): Promise<JupiterTokenMarketData[]>;
  searchTokens(
    query: string,
    options?: { limit?: number; signal?: AbortSignal },
  ): Promise<JupiterTokenMarketData[]>;
}

const LABEL = 'Jupiter Token/Price API';
const SOURCE = 'jupiter';

export function createJupiterProvider(deps: JupiterProviderOptions = {}): JupiterProvider {
  const log = componentLogger('provider.jupiter');
  const clock = deps.clock ?? systemClock;
  const liteBase = (deps.liteBaseUrl ?? LITE_BASE_URL).replace(/\/+$/, '');
  const proBase = (deps.proBaseUrl ?? PRO_BASE_URL).replace(/\/+$/, '');

  const stats: { lastSuccessAt?: number; lastFailureAt?: number; lastError?: string } = {};
  const onResult = (r: { ok: boolean; error?: string }) => {
    if (r.ok) stats.lastSuccessAt = clock.now();
    else {
      stats.lastFailureAt = clock.now();
      stats.lastError = r.error;
    }
  };

  /**
   * Exactly one client per tier, created lazily and reused forever.
   *
   * `tierKey` records which credential the live client was built for, so a key
   * that appears (or is rotated away) mid-process swaps the client instead of
   * silently continuing to spend the wrong quota against the wrong host.
   */
  let client: { http: HttpClient; tier: 'lite' | 'pro' } | null =
    deps.http ? { http: deps.http, tier: 'lite' } : null;
  let tierKey: string | null = null;
  const clientIsInjected = deps.http !== undefined;

  function buildClient(apiKey: string | null): { http: HttpClient; tier: 'lite' | 'pro' } {
    const pro = apiKey !== null && apiKey.length > 0;
    return {
      tier: pro ? 'pro' : 'lite',
      http: new HttpClient({
        name: pro ? 'jupiter-pro' : 'jupiter',
        baseUrl: `${pro ? proBase : liteBase}/`,
        defaultHeaders: {
          // Cloudflare in front of *.jup.ag answers non-browser User-Agents with
          // HTTP 403 "error 1010" (browser integrity check). The default
          // solcoin/0.1 agent string trips it from some egress ranges, so every
          // Jupiter request presents a browser UA. This is the single most
          // common cause of "Jupiter is down" reports.
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          accept: 'application/json',
          ...(pro && apiKey ? { 'x-api-key': apiKey } : {}),
        },
        timeoutMs: deps.timeoutMs ?? 15_000,
        rateLimit: pro
          ? { ...(deps.proRateLimit ?? PRO_RATE_LIMIT) }
          : { ...(deps.freeRateLimit ?? FREE_RATE_LIMIT) },
        cacheTtlMs: deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
        clock,
        onResult,
      }),
    };
  }

  async function getClient(): Promise<{ http: HttpClient; tier: 'lite' | 'pro' }> {
    if (clientIsInjected && client) return client;
    const apiKey = deps.getCredential ? await deps.getCredential(CREDENTIAL_KEY).catch(() => null) : null;
    const key = apiKey ?? '';
    if (client && tierKey === key) return client;
    tierKey = key;
    client = buildClient(apiKey && apiKey.length > 0 ? apiKey : null);
    log.info({ tier: client.tier }, 'jupiter client initialised');
    return client;
  }

  async function get<T>(path: string, options: { query?: Record<string, string | number>; signal?: AbortSignal; cacheTtlMs?: number }): Promise<{ body: T; tier: 'lite' | 'pro' }> {
    const c = await getClient();
    const body = await c.http.request<T>(path, {
      ...(options.query ? { query: options.query } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.cacheTtlMs !== undefined ? { cacheTtlMs: options.cacheTtlMs } : {}),
    });
    return { body, tier: c.tier };
  }

  // -------------------------------------------------------------------------
  // SOL price, memoised so volume conversion does not eat the request budget
  // -------------------------------------------------------------------------

  let solPriceCache: { value: number; at: number } | null = null;

  async function fetchSolPriceUsd(signal?: AbortSignal): Promise<number | null> {
    if (deps.solPriceUsd) {
      // An injected oracle costs no Jupiter quota, so it is never memoised here.
      return deps.solPriceUsd(signal ? { signal } : {}).catch(() => null);
    }
    const now = clock.now();
    if (solPriceCache && now - solPriceCache.at < SOL_PRICE_TTL_MS) return solPriceCache.value;
    try {
      const prices = await requestPrices([WRAPPED_SOL_MINT], signal);
      const sol = prices.get(WRAPPED_SOL_MINT);
      if (!sol || !(sol.usdPrice > 0)) return solPriceCache?.value ?? null;
      solPriceCache = { value: sol.usdPrice, at: now };
      return sol.usdPrice;
    } catch (e) {
      log.debug({ err: safeErrorText(e, 160) }, 'sol price lookup failed; volumes will omit SOL fields');
      // A stale rate beats no conversion at all, but only within this process.
      return solPriceCache?.value ?? null;
    }
  }

  async function requestPrices(mints: readonly string[], signal?: AbortSignal): Promise<Map<string, JupiterPrice>> {
    const out = new Map<string, JupiterPrice>();
    const unique = normaliseMints(mints);
    for (const batch of chunk(unique, MAX_PRICE_BATCH)) {
      const { body } = await get<unknown>('price/v3', {
        query: { ids: batch.join(',') },
        ...(signal ? { signal } : {}),
      });
      if (!isRecord(body)) continue;
      const observedAt = clock.now();
      for (const [mint, raw] of Object.entries(body)) {
        if (!isRecord(raw)) continue;
        const usdPrice = finiteNumber(raw['usdPrice']);
        // A price of exactly zero is not a tradeable quote; drop it rather than
        // let it propagate into a market-cap calculation.
        if (usdPrice === null || usdPrice <= 0) continue;
        out.set(mint, {
          mint,
          usdPrice,
          ...optional('decimals', finiteNumber(raw['decimals'])),
          ...optional('blockId', finiteNumber(raw['blockId'])),
          ...optional('priceChange24hPct', finiteNumber(raw['priceChange24h'])),
          observedAt,
        });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Token search / mapping
  // -------------------------------------------------------------------------

  /** Runs one `query` verbatim; the endpoint accepts mints or free text alike. */
  async function searchRaw(query: string, signal?: AbortSignal): Promise<{ items: unknown[]; tier: 'lite' | 'pro' }> {
    const { body, tier } = await get<unknown>('tokens/v2/search', {
      query: { query },
      ...(signal ? { signal } : {}),
    });
    return { items: Array.isArray(body) ? body : [], tier };
  }

  async function mapTokens(
    items: readonly unknown[],
    tier: 'lite' | 'pro',
    signal?: AbortSignal,
  ): Promise<JupiterTokenMarketData[]> {
    if (items.length === 0) return [];
    const solUsd = await fetchSolPriceUsd(signal);
    const observedAt = clock.now();
    const out: JupiterTokenMarketData[] = [];
    let skipped = 0;
    for (const item of items) {
      const mapped = toTokenMarketData(item, { observedAt, solUsd, tier });
      if (mapped) out.push(mapped);
      else skipped++;
    }
    if (skipped > 0) log.debug({ received: items.length, skipped }, 'dropped malformed jupiter tokens');
    return out;
  }

  async function getTokensDetailed(
    mints: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<JupiterTokenMarketData[]> {
    const unique = normaliseMints(mints);
    if (unique.length === 0) return [];

    const collected: unknown[] = [];
    let tier: 'lite' | 'pro' = 'lite';
    for (const batch of chunk(unique, MAX_SEARCH_BATCH)) {
      const result = await searchRaw(batch.join(','), options?.signal);
      tier = result.tier;
      collected.push(...result.items);
    }
    const mapped = await mapTokens(collected, tier, options?.signal);

    // The endpoint is a search, not a strict lookup: a mint that has never been
    // indexed simply does not come back, and a query could in principle match
    // something adjacent. Restricting to the requested set keeps the response a
    // faithful answer to the question that was asked.
    const wanted = new Set(unique);
    return mapped.filter((t) => wanted.has(t.mint));
  }

  const base = {
    id: SOURCE,
    label: LABEL,
    kind: 'market' as const,
    // Jupiter works fully without a key, so this provider is never
    // 'unconfigured'. A key only raises the ceiling.
    requiresCredentials: false,
  };
  const setupHint =
    'Works with no credentials at 30 requests/minute. Optionally store a Jupiter API key as ' +
    `${CREDENTIAL_KEY} to switch to ${PRO_BASE_URL} and a paid quota.`;

  return {
    id: SOURCE,
    label: LABEL,
    kind: 'market',

    async healthCheck(): Promise<ProviderStatus> {
      const started = clock.now();
      let tier: 'lite' | 'pro' = 'lite';
      try {
        // Cheapest possible probe: a one-id price lookup, which also warms the
        // SOL/USD memo that every getTokens() call needs anyway.
        const c = await getClient();
        tier = c.tier;
        const prices = await requestPrices([WRAPPED_SOL_MINT]);
        const sol = prices.get(WRAPPED_SOL_MINT);
        if (sol) solPriceCache = { value: sol.usdPrice, at: clock.now() };
        return {
          ...base,
          state: sol ? 'ok' : 'degraded',
          detail: sol
            ? `${tier} tier reachable; SOL $${sol.usdPrice.toFixed(2)}`
            : 'price/v3 responded but returned no price for wSOL',
          setupHint,
          latencyMs: clock.now() - started,
          lastSuccessAt: clock.now(),
          ...optional('lastFailureAt', stats.lastFailureAt),
        };
      } catch (e) {
        const cloudflare = isCloudflareBrowserCheck(e);
        return {
          ...base,
          state: 'down',
          detail: cloudflare
            ? 'Cloudflare browser-integrity check (error 1010) rejected the request; egress IP may be blocked.'
            : safeErrorText(e, 200),
          setupHint,
          latencyMs: clock.now() - started,
          ...optional('lastSuccessAt', stats.lastSuccessAt),
          lastFailureAt: clock.now(),
        };
      }
    },

    async getTokens(mints: readonly string[], options?: { signal?: AbortSignal }): Promise<TokenMarketData[]> {
      return getTokensDetailed(mints, options);
    },

    getTokensDetailed,

    async searchTokens(
      query: string,
      options?: { limit?: number; signal?: AbortSignal },
    ): Promise<JupiterTokenMarketData[]> {
      const q = query.trim();
      if (!q) return [];
      // Free text against the same endpoint: this is how saturation analysis
      // asks "how many tokens already exist for this theme?".
      const { items, tier } = await searchRaw(q, options?.signal);
      const mapped = await mapTokens(items, tier, options?.signal);
      const limit = clampInt(options?.limit ?? mapped.length, 0, mapped.length);
      return mapped.slice(0, limit);
    },

    async recentLaunches(options?: { limit?: number; signal?: AbortSignal }): Promise<JupiterTokenMarketData[]> {
      const { body, tier } = await get<unknown>('tokens/v2/recent', {
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      const items = Array.isArray(body) ? body : [];
      const mapped = await mapTokens(items, tier, options?.signal);
      // The page is fixed at 30 newest-first; a smaller limit is a client-side
      // trim, and a larger one cannot be honoured by this endpoint.
      const limit = clampInt(options?.limit ?? RECENT_PAGE_SIZE, 0, mapped.length);
      return mapped.slice(0, limit);
    },

    async topOrganicScore(
      window: JupiterStatsWindow,
      options?: { limit?: number; signal?: AbortSignal },
    ): Promise<JupiterTokenMarketData[]> {
      const limit = clampInt(options?.limit ?? 50, 1, MAX_TOP_ORGANIC_LIMIT);
      const { body, tier } = await get<unknown>(`tokens/v2/toporganicscore/${window}`, {
        query: { limit },
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      const items = Array.isArray(body) ? body : [];
      return (await mapTokens(items, tier, options?.signal)).slice(0, limit);
    },

    async getPrices(
      mints: readonly string[],
      options?: { signal?: AbortSignal },
    ): Promise<Map<string, JupiterPrice>> {
      return requestPrices(mints, options?.signal);
    },

    async getSolPriceUsd(options?: { signal?: AbortSignal }): Promise<number | null> {
      return fetchSolPriceUsd(options?.signal);
    },

    async getHolders(
      mint: string,
      options?: { signal?: AbortSignal },
    ): Promise<{ count: number; top10Share?: number; balances?: number[]; source: string } | null> {
      if (!MINT_RE.test(mint)) return null;
      const [token] = await getTokensDetailed([mint], options);
      if (!token) return null;
      const count = token.holders;
      // Jupiter reports an aggregate only. Without a count there is no holder
      // snapshot to record, and inventing one would corrupt the concentration
      // history, so this returns null rather than a zero-holder token.
      if (count === undefined || !Number.isFinite(count)) return null;
      const pct = token.jupiter.audit.topHoldersPercentage;
      return {
        count,
        // Percent -> fraction: monitoring.service stores top10Share alongside
        // values it computes itself as sum(top10)/sum(all), which is 0..1.
        ...optional('top10Share', pct !== undefined ? clamp01(pct / 100) : undefined),
        // `balances` is deliberately absent: Jupiter exposes no per-holder
        // distribution, and a synthesised one would make the Gini meaningless.
        source: SOURCE,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function toTokenMarketData(
  raw: unknown,
  ctx: { observedAt: number; solUsd: number | null; tier: 'lite' | 'pro' },
): JupiterTokenMarketData | null {
  if (!isRecord(raw)) return null;
  const mint = asString(raw['id']);
  if (!mint || !MINT_RE.test(mint)) return null;

  const audit = readAudit(raw['audit']);
  const stats: Partial<Record<JupiterStatsWindow, JupiterWindowStats>> = {};
  for (const [window, key] of [
    ['5m', 'stats5m'],
    ['1h', 'stats1h'],
    ['6h', 'stats6h'],
    ['24h', 'stats24h'],
  ] as const) {
    const parsed = readWindow(raw[key]);
    if (parsed) stats[window] = parsed;
  }

  /** USD -> SOL. Undefined when the SOL rate is unknown; never a guessed value. */
  const toSol = (v: number | undefined): number | undefined =>
    v !== undefined && ctx.solUsd !== null && ctx.solUsd > 0 ? v / ctx.solUsd : undefined;

  const priceUsd = finiteNumber(raw['usdPrice']) ?? undefined;
  const day = stats['24h'];
  const numBuys = day?.numBuys;
  const numSells = day?.numSells;

  const graduatedAtMs = parseIsoMs(asString(raw['graduatedAt']));
  // Address-shaped fields are shape-checked, not sanitised: they key market
  // records and become explorer links, so a value that is not a base58 pubkey
  // is not an address and is dropped rather than cleaned into a lookalike.
  const graduatedPool = asAddress(raw['graduatedPool']) ?? undefined;
  const launchpad = asString(raw['launchpad']) ?? undefined;
  const firstPool = isRecord(raw['firstPool']) ? raw['firstPool'] : null;
  const firstPoolAddress = firstPool ? (asAddress(firstPool['id']) ?? undefined) : undefined;
  const firstPoolCreatedAtMs = firstPool ? parseIsoMs(asString(firstPool['createdAt'])) : null;

  const extras: JupiterTokenExtras = {
    ...optional('organicScore', finiteNumber(raw['organicScore'])),
    ...optional('organicScoreLabel', readOrganicLabel(raw['organicScoreLabel'])),
    ...optional('isVerified', asBoolean(raw['isVerified'])),
    ...optional('launchpad', launchpad ? sanitiseExternalText(launchpad, 64) : undefined),
    ...optional('dev', asAddress(raw['dev'])),
    ...optional('decimals', finiteNumber(raw['decimals'])),
    ...optional('tokenProgram', asAddress(raw['tokenProgram'])),
    ...optional('circSupply', finiteNumber(raw['circSupply'])),
    ...optional('totalSupply', finiteNumber(raw['totalSupply'])),
    ...optional('fdvUsd', finiteNumber(raw['fdv'])),
    audit,
    stats,
    ...optional('firstPoolAddress', firstPoolAddress),
    ...optional('firstPoolCreatedAtMs', firstPoolCreatedAtMs),
    ...optional('graduatedPool', graduatedPool),
    ...optional('graduatedAtMs', graduatedAtMs),
    ...optional('tags', readTags(raw['tags'])),
    // Socials come from token metadata the deployer wrote, so they are
    // untrusted text even though they look like URLs.
    ...optional('website', sanitiseOptional(asString(raw['website']), 200)),
    ...optional('twitter', sanitiseOptional(asString(raw['twitter']), 200)),
    ...optional('telegram', sanitiseOptional(asString(raw['telegram']), 200)),
    tier: ctx.tier,
  };

  return {
    mint,
    // Name and symbol are attacker-controlled: anyone can mint a token whose
    // name is a prompt-injection payload, and these strings reach a model.
    ...optional('name', sanitiseOptional(asString(raw['name']), 120)),
    ...optional('symbol', sanitiseOptional(asString(raw['symbol']), 32)),
    ...optional('priceUsd', priceUsd),
    ...optional('priceSol', priceUsd !== undefined ? toSol(priceUsd) : undefined),
    ...optional('marketCapUsd', finiteNumber(raw['mcap'])),
    ...optional('liquidityUsd', finiteNumber(raw['liquidity'])),
    ...optional('volume5mSol', toSol(stats['5m']?.totalVolumeUsd)),
    ...optional('volume1hSol', toSol(stats['1h']?.totalVolumeUsd)),
    ...optional('volume24hSol', toSol(day?.totalVolumeUsd)),
    ...optional('volume24hUsd', day?.totalVolumeUsd),
    ...optional(
      'txCount24h',
      numBuys !== undefined || numSells !== undefined ? (numBuys ?? 0) + (numSells ?? 0) : undefined,
    ),
    ...optional('buys24h', numBuys),
    ...optional('sells24h', numSells),
    ...optional('holders', finiteNumber(raw['holderCount'])),
    // First-pool creation is the token's real market birth. `createdAt` on the
    // payload is when Jupiter indexed it, which for wSOL is 2024 — three years
    // after the pool actually existed — so it is not used here.
    ...optional('createdAtMs', firstPoolCreatedAtMs),
    // Graduation only means something for launchpad tokens; for everything else
    // the concept does not apply and the field stays absent rather than false.
    ...optional(
      'graduated',
      graduatedAtMs !== null || graduatedPool !== undefined
        ? true
        : launchpad !== undefined
          ? false
          : undefined,
    ),
    // The graduated AMM pool is the venue that matters once it exists; before
    // that, the bonding-curve pool is the only place the token trades.
    ...optional('poolAddress', graduatedPool ?? firstPoolAddress),
    // bondingCurveProgress is intentionally absent: Jupiter does not publish
    // curve state, and deriving it from mcap would be a guess.
    source: SOURCE,
    observedAt: ctx.observedAt,
    jupiter: extras,
  };
}

function readWindow(raw: unknown): JupiterWindowStats | null {
  if (!isRecord(raw)) return null;
  const buyVolumeUsd = finiteNumber(raw['buyVolume']) ?? undefined;
  const sellVolumeUsd = finiteNumber(raw['sellVolume']) ?? undefined;
  const buyOrganic = finiteNumber(raw['buyOrganicVolume']) ?? undefined;
  const sellOrganic = finiteNumber(raw['sellOrganicVolume']) ?? undefined;

  const out: JupiterWindowStats = {
    ...optional('priceChangePct', finiteNumber(raw['priceChange'])),
    ...optional('holderChangePct', finiteNumber(raw['holderChange'])),
    ...optional('liquidityChangePct', finiteNumber(raw['liquidityChange'])),
    ...optional('volumeChangePct', finiteNumber(raw['volumeChange'])),
    ...optional('buyVolumeUsd', buyVolumeUsd),
    ...optional('sellVolumeUsd', sellVolumeUsd),
    ...optional(
      'totalVolumeUsd',
      buyVolumeUsd !== undefined || sellVolumeUsd !== undefined
        ? (buyVolumeUsd ?? 0) + (sellVolumeUsd ?? 0)
        : undefined,
    ),
    ...optional(
      'organicVolumeUsd',
      buyOrganic !== undefined || sellOrganic !== undefined ? (buyOrganic ?? 0) + (sellOrganic ?? 0) : undefined,
    ),
    ...optional('numBuys', finiteNumber(raw['numBuys'])),
    ...optional('numSells', finiteNumber(raw['numSells'])),
    ...optional('numTraders', finiteNumber(raw['numTraders'])),
    ...optional('numOrganicBuyers', finiteNumber(raw['numOrganicBuyers'])),
    ...optional('numNetBuyers', finiteNumber(raw['numNetBuyers'])),
  };
  return Object.keys(out).length > 0 ? out : null;
}

function readAudit(raw: unknown): JupiterAudit {
  if (!isRecord(raw)) return {};
  return {
    ...optional('mintAuthorityDisabled', asBoolean(raw['mintAuthorityDisabled'])),
    ...optional('freezeAuthorityDisabled', asBoolean(raw['freezeAuthorityDisabled'])),
    ...optional('topHoldersPercentage', finiteNumber(raw['topHoldersPercentage'])),
    ...optional('devBalancePercentage', finiteNumber(raw['devBalancePercentage'])),
    ...optional('devMigrations', finiteNumber(raw['devMigrations'])),
    ...optional('devMints', finiteNumber(raw['devMints'])),
  };
}

function readOrganicLabel(raw: unknown): JupiterOrganicScoreLabel | undefined {
  const s = asString(raw)?.toLowerCase();
  return s === 'high' || s === 'medium' || s === 'low' ? s : undefined;
}

function readTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const t of raw) {
    const s = asString(t);
    if (s) out.push(sanitiseExternalText(s, 40));
  }
  return out.length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Dedupe, drop anything that is not a plausible base58 mint, preserve order. */
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
 * A base58 Solana pubkey, or null. Applied to every address-shaped field so a
 * malformed value is rejected outright rather than sanitised into a
 * plausible-looking address that would silently mislead downstream lookups.
 */
function asAddress(value: unknown): string | null {
  const s = asString(value);
  return s !== null && MINT_RE.test(s) ? s : null;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // Some Jupiter fields have been observed as numeric strings on other tiers.
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseIsoMs(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function sanitiseOptional(value: string | null, maxLength: number): string | undefined {
  if (!value) return undefined;
  const clean = sanitiseExternalText(value, maxLength);
  return clean.length > 0 ? clean : undefined;
}

/**
 * Spread-in helper: `...optional('k', v)` adds nothing when `v` is null or
 * undefined, which keeps absent upstream fields absent rather than explicitly
 * undefined (they are persisted, and `null` reads as "measured as nothing").
 */
function optional<K extends string, V>(key: K, value: V | null | undefined): Partial<Record<K, V>> {
  return value === null || value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>);
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Cloudflare's browser-integrity block, which presents as a 403 HTML page. */
function isCloudflareBrowserCheck(e: unknown): boolean {
  if (!(e instanceof HttpError) || e.status !== 403) return false;
  return /error\s*(code)?\s*:?\s*1010|browser integrity|cloudflare/i.test(e.bodyText);
}
