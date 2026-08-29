import { sanitiseExternalText } from '@solcoin/shared';
import { systemClock, type Clock } from '../../core/clock.js';
import { safeErrorText } from '../../core/errors.js';
import { componentLogger } from '../../core/logger.js';
import { HttpClient, HttpError, type RateLimitConfig } from '../http.js';
import type { MarketProvider, PriceProvider, ProviderStatus, TokenMarketData } from '../types.js';

/**
 * pump.fun's own frontend API — the only clean source of *bonding-curve* state.
 *
 * Every other market source in this stack (Jupiter, DexScreener) can only see a
 * token once it has a DEX pair. A pump.fun coin spends its entire pre-graduation
 * life with no pair at all, so for the window that matters most to this platform
 * — the first minutes after launch — this file is the only thing that can answer
 * "how far along the curve is it?". It is deliberately narrow: curve state,
 * launch stream, live-stream list, SOL price, and recent trades. Holder counts,
 * candles and replies are *not* available here any more (see below) and come
 * from Jupiter or the RPC instead.
 *
 * Hosts:
 *   https://frontend-api-v3.pump.fun   coins, launch stream, sol-price
 *   https://swap-api.pump.fun          per-mint trade tape (a DIFFERENT host,
 *                                      therefore a second HttpClient and a
 *                                      second rate-limit budget)
 *
 * `frontend-api.pump.fun` (no `-v3`) is dead and answers HTTP 530 for every
 * path; anything still pointing at it is a bug, not a transient outage.
 *
 * Endpoints used (all verified live 2026-08-29):
 *   GET /coins/{mint}
 *   GET /coins?offset=&limit=&sort=&order=&includeNsfw=&searchTerm=
 *   GET /coins/currently-live?offset=&limit=
 *   GET /sol-price
 *   GET https://swap-api.pump.fun/v2/coins/{mint}/trades?limit=
 *
 * Endpoints that are GONE. Calling them wastes quota and trips the breaker:
 *   /trades/*, /candlesticks/*, /replies/*, /balances/*,
 *   /coins/king-of-the-hill, /metas/current, /coins/top-holders/*  -> 404
 *   swap-api /v1/coins/{mint}/trades                               -> 410 Gone
 * There is no holder-count endpoint on any pump.fun host, which is why
 * `TokenMarketData.holders` is always absent from this provider rather than
 * being guessed at from the trade tape.
 *
 * Live observations that differ from the documented shape, and which the parser
 * is written against:
 *
 *  - Reserve and supply fields are RAW base units, not UI amounts:
 *    `virtual_token_reserves` 1_073_000_000_000_000 with `base_decimals` 6 is
 *    1.073e9 tokens, and `virtual_sol_reserves` 30_000_000_000 with
 *    `quote_decimals` 9 is 30 SOL. Everything is converted on the way in.
 *  - THE CURVE IS NO LONGER ALWAYS SOL-QUOTED. `quote_mint` is now a real field:
 *    `11111111111111111111111111111111` means native SOL, but USDC-quoted coins
 *    (`EPjFWdd5…TDt1v`, `quote_decimals: 6`) are live in the launch feed today.
 *    `virtual_sol_reserves` is a plain alias of `virtual_quote_reserves` and is
 *    denominated in the QUOTE asset's base units despite its name — reading it
 *    as lamports understates a USDC coin's curve by 1000x. Everything here is
 *    scaled by `quote_decimals` and labelled "quote", not "sol".
 *  - Three market caps ship on every coin and they are not interchangeable:
 *    `market_cap` is always normalised to SOL, `market_cap_quote` is in the
 *    quote asset, and `usd_market_cap` / `market_cap_usd` are USD (the latter
 *    two differ by a fraction of a percent — different snapshot times).
 *    Curve maths must use `market_cap_quote`; pricing uses `market_cap`.
 *  - `king_of_the_hill_timestamp` no longer appears on any response observed;
 *    the field is still read if present but is normally absent.
 *  - A graduated coin keeps `program: "pump"` while its trades report
 *    `program: "pump_amm"`. So `program === 'pump_amm'` is NOT a reliable
 *    graduation test — `complete` and the presence of `pump_swap_pool` are.
 *  - `limit` is silently capped at 70, and `offset` beyond roughly 1_050 returns
 *    an empty array rather than an error. At current launch rates that is only
 *    ~25 minutes of history, which is the hard ceiling on the graduation-rate
 *    window computed by `marketRegime()`.
 *  - `mayhem_state` (`active`/`paused`/`completed`) is undocumented and rides on
 *    roughly a QUARTER of the live launch feed. It matters because a Mayhem coin's
 *    curve can be wound back behind its genesis allocation: ~9% of sampled coins
 *    report `real_token_reserves` ABOVE the 79.31% initial allocation (a few even
 *    above total supply) while carrying a perfectly standard 1e9 supply. Those
 *    are reported as `curve-rewound`, not `bad-supply`.
 *  - Non-launch entries exist: `/coins/So111...112` returns wSOL with
 *    `complete: true`, no `program`, and no reserves at all. Curve maths must
 *    degrade to `undefined` for these, not to zero.
 *  - `/coins/{mint}` for an unknown mint returns HTTP 404 with a JSON body
 *    `{statusCode, message, error}`. It is accepted as a status rather than
 *    retried, so a missing coin costs one request and never opens the breaker.
 *  - swap-api trade numerics (`priceUsd`, `amountSol`, `baseAmount`, …) are
 *    high-precision DECIMAL STRINGS, not numbers, and the payload carries
 *    `fillPrice*` and a `pagination` cursor that the docs omit.
 *
 * `liquidityUsd` is deliberately never populated. Jupiter fills that same field
 * with two-sided pool TVL; the closest pump.fun analogue is the one-sided SOL
 * balance of the curve, and for a graduated coin the curve reserves read zero —
 * which would surface as "no liquidity" for the most liquid coins on the
 * platform. The raw curve balances are exposed on `pumpfun` extras instead.
 */

const BASE_URL = 'https://frontend-api-v3.pump.fun';
const SWAP_API_BASE_URL = 'https://swap-api.pump.fun';

const SOURCE = 'pumpfun';
const LABEL = 'pump.fun frontend API';

/**
 * pump.fun publishes no quota. 60 requests/minute is the rate this platform has
 * sustained without a single 429, and it is comfortably below what the site's
 * own frontend generates for one browsing user. Burst is held at 10 because the
 * edge appears to measure a short window: emptying a 60-token bucket in one
 * second is the one pattern that has produced 503s.
 */
const DEFAULT_RATE_LIMIT: RateLimitConfig = { requests: 60, intervalMs: 60_000, burst: 10 };

/**
 * Backing off "hard" on 429/503 means two things here: few retries, so a
 * throttled call fails fast instead of hammering, and a breaker that latches
 * after three consecutive failures for two minutes. Cloudflare fronts this host
 * and an IP that keeps pushing through a 503 gets escalated to a challenge,
 * which no amount of retrying recovers from.
 */
const DEFAULT_MAX_RETRIES = 2;
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 120_000;

/** Coin state changes every block; this cache exists to protect quota only. */
const DEFAULT_CACHE_TTL_MS = 5_000;
/** SOL/USD only scales conversions, so a slightly stale rate is harmless. */
const SOL_PRICE_TTL_MS = 20_000;

/** Hard server-side cap on `limit`; larger values are silently truncated to 70. */
const MAX_PAGE_LIMIT = 70;
/** Largest `offset` that still returns rows; beyond this the API returns []. */
const MAX_PAGE_OFFSET = 1_000;
/** swap-api page size. Larger values have not been observed to be honoured. */
const MAX_TRADES_LIMIT = 200;

/**
 * Tokens the standard pump.fun curve puts up for sale, in UI units.
 *
 * Verified against every freshly-created coin observed: `real_token_reserves`
 * is exactly 793_100_000_000_000 raw at 6 decimals. The remaining
 * 206_900_000 of the 1e9 supply is held back for the migration liquidity, which
 * is why progress is measured against 793.1M and not against total supply.
 */
const STANDARD_CURVE_TOKENS_UI = 793_100_000;
const STANDARD_TOTAL_SUPPLY_UI = 1_000_000_000;
/**
 * The share of supply the curve sells. Used to generalise progress to coins
 * whose total supply is not the standard 1e9 — the protocol reserves a fixed
 * *fraction* for migration, so scaling by supply is the defensible derivation.
 */
const CURVE_SUPPLY_FRACTION = STANDARD_CURVE_TOKENS_UI / STANDARD_TOTAL_SUPPLY_UI;

/** Solana mints are base58 and always land in this length range. */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Base58 transaction signatures are 64 bytes and encode to this length range. */
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;

/**
 * Quote mints that mean "the curve is priced in SOL". pump.fun uses the System
 * Program address as the native-SOL sentinel; wrapped SOL is accepted too since
 * either could appear as the AMM side after migration.
 */
const NATIVE_QUOTE_MINTS = new Set([
  '11111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
]);

const LAMPORTS_DECIMALS = 9;
const DEFAULT_BASE_DECIMALS = 6;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type PumpFunSort = 'created_timestamp' | 'market_cap' | 'last_trade_timestamp';
export type PumpFunOrder = 'ASC' | 'DESC';

/** pump.fun-only fields with no home on `TokenMarketData`. */
export interface PumpFunCoinExtras {
  /** Sanitised. Deployer-written free text; a classic injection carrier. */
  description?: string;
  imageUri?: string;
  metadataUri?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  creator?: string;
  /** `pump` (bonding curve) or `pump_amm`. Absent on non-launch entries. */
  program?: string;
  tokenProgram?: string;
  bondingCurveAddress?: string;
  associatedBondingCurve?: string;
  /** PumpSwap pool, present once the coin has migrated. */
  pumpSwapPool?: string;
  /**
   * True when the coin trades on the AMM rather than the curve. Derived from
   * `pump_swap_pool` / `complete` as well as `program`, because a migrated coin
   * has been observed still reporting `program: "pump"`.
   */
  onAmm: boolean;
  /**
   * Curve balances in UI units (whole tokens and whole quote units), not raw
   * base units. The quote side is only SOL when `quoteIsSol` is true.
   */
  virtualQuoteReserves?: number;
  virtualTokenReserves?: number;
  realQuoteReserves?: number;
  realTokenReserves?: number;
  /** The curve's quote asset. `11111…111` is native SOL. */
  quoteMint?: string;
  /** False for the USDC-quoted coins now appearing in the launch feed. */
  quoteIsSol: boolean;
  /** Total supply in UI units. */
  totalSupply?: number;
  baseDecimals?: number;
  quoteDecimals?: number;
  /** Market cap normalised to SOL (the API's `market_cap`), whatever the quote. */
  marketCapSol?: number;
  /** Market cap in the quote asset (`market_cap_quote`). Equals SOL when quoted in SOL. */
  marketCapQuote?: number;
  athMarketCapUsd?: number;
  athMarketCapAtMs?: number;
  /** Normally absent: the king-of-the-hill field is no longer populated. */
  kingOfTheHillAtMs?: number;
  lastTradeAtMs?: number;
  replyCount?: number;
  nsfw?: boolean;
  isCurrentlyLive?: boolean;
  /**
   * pump.fun "Mayhem" cycle state (`active` / `paused` / `completed`), absent on
   * ordinary coins. Roughly a quarter of the live launch feed carries one, and a
   * mayhem coin's curve can be wound BACKWARDS behind its genesis allocation, so
   * this is a first-class caveat on every curve number below — not decoration.
   */
  mayhemState?: string;
  /** Set when `bondingCurveProgress` was withheld, explaining which check failed. */
  curveProgressUnavailableReason?:
    | 'no-reserves'
    | 'inconsistent-snapshot'
    | 'bad-supply'
    | 'curve-rewound';
}

export interface PumpFunTokenMarketData extends TokenMarketData {
  pumpfun: PumpFunCoinExtras;
}

export interface PumpFunSolPrice {
  priceUsd: number;
  asOfMs: number;
  /** The API's own staleness flag; true means it is serving a cached quote. */
  stale: boolean;
}

export interface PumpFunTrade {
  /** Sortable slot-index cursor; also the pagination key. */
  slotIndexId?: string;
  signature: string;
  timestampMs: number;
  userAddress: string;
  side: 'buy' | 'sell';
  /** `pump` for curve fills, `pump_amm` for AMM fills. */
  program?: string;
  priceUsd?: number;
  priceSol?: number;
  amountUsd?: number;
  amountSol?: number;
  /** Token amount, UI units. */
  baseAmount?: number;
  /** Quote (SOL) amount, UI units. */
  quoteAmount?: number;
}

export interface PumpFunTradeStats {
  mint: string;
  trades: PumpFunTrade[];
  buys: number;
  sells: number;
  volumeSol: number;
  volumeUsd: number;
  uniqueTraders: number;
  /** Span actually covered by the sample; the tape is capped, not windowed. */
  windowMs: number;
  firstTradeAtMs?: number;
  lastTradeAtMs?: number;
}

export interface PumpFunMarketRegime {
  /** Launch rate implied by the newest page of coins. */
  launchesPerHour: number;
  /**
   * Fraction of the graduation sample that has reached `complete`. This is a
   * LOWER BOUND, not the eventual graduation rate — see `marketRegime()`.
   */
  graduationRate: number;
  /** Coins in the graduation sample. */
  sampleSize: number;
  observedAt: number;
  /** Coins used for the launch-rate estimate (a separate, newest-first sample). */
  launchSampleSize: number;
  /** Age of the youngest and oldest coin in the graduation sample, in ms. */
  graduationSampleAgeMs?: { youngest: number; oldest: number };
  /** How many of the graduation sample were `complete`. */
  graduatedCount: number;
}

export interface PumpFunListOptions {
  sort?: PumpFunSort;
  order?: PumpFunOrder;
  limit?: number;
  offset?: number;
  includeNsfw?: boolean;
  searchTerm?: string;
  signal?: AbortSignal;
  cacheTtlMs?: number;
}

export interface PumpFunProviderOptions {
  clock?: Clock;
  timeoutMs?: number;
  cacheTtlMs?: number;
  baseUrl?: string;
  swapApiBaseUrl?: string;
  rateLimit?: RateLimitConfig;
  /** Injectable clients, for tests. */
  http?: HttpClient;
  swapHttp?: HttpClient;
}

/**
 * pump.fun answers both market-state and SOL-price questions from the same
 * host and the same quota, so one adapter implements both roles rather than two
 * adapters each believing they own 60 rpm.
 */
export interface PumpFunProvider extends MarketProvider, PriceProvider {
  readonly kind: 'market';
  /** Single coin, or null when the mint is unknown to pump.fun. */
  getCoin(mint: string, options?: { signal?: AbortSignal }): Promise<PumpFunTokenMarketData | null>;
  getTokens(mints: readonly string[], options?: { signal?: AbortSignal }): Promise<PumpFunTokenMarketData[]>;
  searchTokens(
    query: string,
    options?: { limit?: number; signal?: AbortSignal },
  ): Promise<PumpFunTokenMarketData[]>;
  recentLaunches(options?: { limit?: number; signal?: AbortSignal }): Promise<PumpFunTokenMarketData[]>;
  /** Raw paging over /coins, for callers that need a specific sort or offset. */
  listCoins(options?: PumpFunListOptions): Promise<PumpFunTokenMarketData[]>;
  /** Coins whose creators are currently live-streaming. */
  currentlyLive(options?: { limit?: number; offset?: number; signal?: AbortSignal }): Promise<PumpFunTokenMarketData[]>;
  getSolPrice(options?: { signal?: AbortSignal }): Promise<PumpFunSolPrice | null>;
  getTrades(mint: string, options?: { limit?: number; signal?: AbortSignal }): Promise<PumpFunTrade[]>;
  /** Aggregate of the most recent trade page. Cheap volume/flow proxy. */
  getRecentTradeStats(
    mint: string,
    options?: { limit?: number; signal?: AbortSignal },
  ): Promise<PumpFunTradeStats | null>;
  marketRegime(options?: {
    launchSampleSize?: number;
    graduationSampleSize?: number;
    signal?: AbortSignal;
  }): Promise<PumpFunMarketRegime>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPumpFunProvider(deps: PumpFunProviderOptions = {}): PumpFunProvider {
  const log = componentLogger('provider.pumpfun');
  const clock = deps.clock ?? systemClock;
  const base = (deps.baseUrl ?? BASE_URL).replace(/\/+$/, '');
  const swapBase = (deps.swapApiBaseUrl ?? SWAP_API_BASE_URL).replace(/\/+$/, '');

  const stats: { lastSuccessAt?: number; lastFailureAt?: number; lastError?: string } = {};
  const onResult = (r: { ok: boolean; error?: string }): void => {
    if (r.ok) stats.lastSuccessAt = clock.now();
    else {
      stats.lastFailureAt = clock.now();
      stats.lastError = r.error;
    }
  };

  /**
   * Cloudflare fronts both hosts. Requests have not been challenged in practice,
   * but the default `solcoin/0.1` agent string is exactly the shape that trips
   * browser-integrity checks from some egress ranges, so both clients present a
   * browser UA plus an Origin/Referer consistent with the site's own frontend.
   */
  const browserHeaders: Record<string, string> = {
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    accept: 'application/json',
    'accept-language': 'en-US,en;q=0.9',
    origin: 'https://pump.fun',
    referer: 'https://pump.fun/',
  };

  const http =
    deps.http ??
    new HttpClient({
      name: 'pumpfun',
      baseUrl: `${base}/`,
      defaultHeaders: browserHeaders,
      timeoutMs: deps.timeoutMs ?? 15_000,
      maxRetries: DEFAULT_MAX_RETRIES,
      rateLimit: { ...(deps.rateLimit ?? DEFAULT_RATE_LIMIT) },
      circuitThreshold: CIRCUIT_THRESHOLD,
      circuitCooldownMs: CIRCUIT_COOLDOWN_MS,
      cacheTtlMs: deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
      clock,
      onResult,
    });

  /**
   * swap-api is a separate host with its own edge and therefore its own budget.
   * Sharing one limiter across both would halve the effective rate on each for
   * no reason; two limiters cannot overdraw each other.
   */
  const swapHttp =
    deps.swapHttp ??
    new HttpClient({
      name: 'pumpfun-swap',
      baseUrl: `${swapBase}/`,
      defaultHeaders: browserHeaders,
      timeoutMs: deps.timeoutMs ?? 15_000,
      maxRetries: DEFAULT_MAX_RETRIES,
      rateLimit: { ...(deps.rateLimit ?? DEFAULT_RATE_LIMIT) },
      circuitThreshold: CIRCUIT_THRESHOLD,
      circuitCooldownMs: CIRCUIT_COOLDOWN_MS,
      cacheTtlMs: deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
      clock,
      onResult,
    });

  // -------------------------------------------------------------------------
  // SOL price
  // -------------------------------------------------------------------------

  let solPriceCache: { value: PumpFunSolPrice; at: number } | null = null;

  async function fetchSolPrice(signal?: AbortSignal): Promise<PumpFunSolPrice | null> {
    const now = clock.now();
    if (solPriceCache && now - solPriceCache.at < SOL_PRICE_TTL_MS) return solPriceCache.value;
    try {
      const body = await http.request<unknown>('sol-price', {
        ...(signal ? { signal } : {}),
        cacheTtlMs: SOL_PRICE_TTL_MS,
      });
      if (!isRecord(body)) return solPriceCache?.value ?? null;
      const priceUsd = finiteNumber(body['solPrice']);
      if (priceUsd === undefined || priceUsd <= 0) return solPriceCache?.value ?? null;
      const value: PumpFunSolPrice = {
        priceUsd,
        asOfMs: finiteNumber(body['asOfTimestamp']) ?? clock.now(),
        stale: body['stale'] === true,
      };
      solPriceCache = { value, at: clock.now() };
      return value;
    } catch (e) {
      log.debug({ err: safeErrorText(e, 160) }, 'sol-price lookup failed');
      // A stale rate beats no conversion, but only within this process.
      return solPriceCache?.value ?? null;
    }
  }

  // -------------------------------------------------------------------------
  // Coin fetching
  // -------------------------------------------------------------------------

  async function getCoin(
    mint: string,
    options?: { signal?: AbortSignal },
  ): Promise<PumpFunTokenMarketData | null> {
    const trimmed = mint.trim();
    if (!MINT_RE.test(trimmed)) return null;
    // 404 is a normal answer here ("not a pump.fun coin"), so it is accepted
    // rather than thrown: throwing would burn retries and count toward the
    // breaker for what is really a successful negative lookup.
    const body = await http.request<unknown>(`coins/${encodeURIComponent(trimmed)}`, {
      ...(options?.signal ? { signal: options.signal } : {}),
      acceptStatuses: [404],
    });
    if (!isRecord(body) || typeof body['mint'] !== 'string') return null;
    const sol = await fetchSolPrice(options?.signal);
    return toTokenMarketData(body, { observedAt: clock.now(), solUsd: sol?.priceUsd ?? null, log });
  }

  async function listCoins(options: PumpFunListOptions = {}): Promise<PumpFunTokenMarketData[]> {
    const limit = clampInt(options.limit ?? 50, 1, MAX_PAGE_LIMIT);
    const offset = clampInt(options.offset ?? 0, 0, MAX_PAGE_OFFSET);
    const query: Record<string, string | number | boolean> = {
      offset,
      limit,
      sort: options.sort ?? 'created_timestamp',
      order: options.order ?? 'DESC',
      includeNsfw: options.includeNsfw ?? false,
    };
    if (options.searchTerm) {
      // Free text against the same endpoint: this is how saturation analysis
      // asks "how many pump.fun coins already exist for this theme?".
      query['searchTerm'] = options.searchTerm;
    }
    const body = await http.request<unknown>('coins', {
      query,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.cacheTtlMs !== undefined ? { cacheTtlMs: options.cacheTtlMs } : {}),
    });
    return mapCoins(body, options.signal);
  }

  async function mapCoins(body: unknown, signal?: AbortSignal): Promise<PumpFunTokenMarketData[]> {
    const items = Array.isArray(body) ? body : [];
    if (items.length === 0) return [];
    const sol = await fetchSolPrice(signal);
    const observedAt = clock.now();
    const out: PumpFunTokenMarketData[] = [];
    let skipped = 0;
    for (const item of items) {
      const mapped = toTokenMarketData(item, { observedAt, solUsd: sol?.priceUsd ?? null, log });
      if (mapped) out.push(mapped);
      else skipped++;
    }
    if (skipped > 0) log.debug({ received: items.length, skipped }, 'dropped malformed pump.fun coins');
    return out;
  }

  // -------------------------------------------------------------------------
  // Trades (swap-api)
  // -------------------------------------------------------------------------

  async function getTrades(
    mint: string,
    options?: { limit?: number; signal?: AbortSignal },
  ): Promise<PumpFunTrade[]> {
    const trimmed = mint.trim();
    if (!MINT_RE.test(trimmed)) return [];
    const limit = clampInt(options?.limit ?? 50, 1, MAX_TRADES_LIMIT);
    const body = await swapHttp.request<unknown>(`v2/coins/${encodeURIComponent(trimmed)}/trades`, {
      query: { limit },
      ...(options?.signal ? { signal: options.signal } : {}),
      acceptStatuses: [404],
    });
    if (!isRecord(body) || !Array.isArray(body['trades'])) return [];
    const out: PumpFunTrade[] = [];
    for (const raw of body['trades']) {
      const trade = toTrade(raw);
      if (trade) out.push(trade);
    }
    return out;
  }

  async function recentLaunches(options?: {
    limit?: number;
    signal?: AbortSignal;
  }): Promise<PumpFunTokenMarketData[]> {
    const wanted = clampInt(options?.limit ?? 50, 1, MAX_PAGE_OFFSET + MAX_PAGE_LIMIT);
    const out: PumpFunTokenMarketData[] = [];
    const seen = new Set<string>();
    // Pages beyond the offset ceiling come back empty; stop rather than spin.
    // `offset` advances by the number of rows actually REQUESTED, not by the
    // page cap: asking for a short final page and then stepping a full 70 would
    // skip the rows in between whenever dedupe leaves the loop short of `wanted`.
    for (let offset = 0; out.length < wanted && offset <= MAX_PAGE_OFFSET; ) {
      const pageLimit = Math.min(MAX_PAGE_LIMIT, wanted - out.length);
      offset += pageLimit;
      const page = await listCoins({
        sort: 'created_timestamp',
        order: 'DESC',
        offset: offset - pageLimit,
        limit: pageLimit,
        // NSFW coins are still launches and still consume attention, so they
        // belong in the saturation and regime samples even though they would
        // never be a launch candidate for us.
        includeNsfw: true,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      if (page.length === 0) break;
      for (const coin of page) {
        // The feed shifts under pagination as new coins are created, so the same
        // mint can appear on two consecutive pages.
        if (seen.has(coin.mint)) continue;
        seen.add(coin.mint);
        out.push(coin);
      }
    }
    return out.slice(0, wanted);
  }

  // -------------------------------------------------------------------------
  // Provider surface
  // -------------------------------------------------------------------------

  const identity = {
    id: SOURCE,
    label: LABEL,
    kind: 'market' as const,
    // No credential exists for this API: it is the site's own public frontend
    // backend. This provider is therefore never 'unconfigured'.
    requiresCredentials: false,
  };
  const setupHint = 'No credentials required. Public pump.fun frontend API, self-limited to 60 requests/minute.';

  return {
    id: SOURCE,
    label: LABEL,
    kind: 'market',

    async healthCheck(): Promise<ProviderStatus> {
      const started = clock.now();
      try {
        // /sol-price is the cheapest path on the host and its response also
        // warms the rate every other call in this file needs anyway.
        const body = await http.request<unknown>('sol-price', { cacheTtlMs: 0, maxRetries: 1 });
        const priceUsd = isRecord(body) ? finiteNumber(body['solPrice']) : undefined;
        const stale = isRecord(body) && body['stale'] === true;
        if (priceUsd !== undefined && priceUsd > 0) {
          solPriceCache = {
            value: {
              priceUsd,
              asOfMs: (isRecord(body) ? finiteNumber(body['asOfTimestamp']) : null) ?? clock.now(),
              stale,
            },
            at: clock.now(),
          };
        }
        return {
          ...identity,
          // A stale quote still proves the host is reachable, but it means the
          // upstream oracle is lagging, which is a real degradation for anything
          // pricing a launch off it.
          state: priceUsd === undefined || priceUsd <= 0 ? 'degraded' : stale ? 'degraded' : 'ok',
          detail:
            priceUsd === undefined || priceUsd <= 0
              ? '/sol-price responded without a usable price'
              : `reachable; SOL $${priceUsd.toFixed(2)}${stale ? ' (upstream reports the quote is stale)' : ''}`,
          setupHint,
          latencyMs: clock.now() - started,
          lastSuccessAt: clock.now(),
          ...optional('lastFailureAt', stats.lastFailureAt),
        };
      } catch (e) {
        return {
          ...identity,
          state: 'down',
          detail: describeFailure(e),
          setupHint,
          latencyMs: clock.now() - started,
          ...optional('lastSuccessAt', stats.lastSuccessAt),
          lastFailureAt: clock.now(),
        };
      }
    },

    getCoin,

    async getTokens(
      mints: readonly string[],
      options?: { signal?: AbortSignal },
    ): Promise<PumpFunTokenMarketData[]> {
      // There is no batch lookup: /coins/{mint} is one request per mint. At 60
      // rpm a large set is expensive, so callers wanting bulk market data should
      // use Jupiter and reach for this provider only for curve state.
      const out: PumpFunTokenMarketData[] = [];
      for (const mint of dedupeMints(mints)) {
        try {
          const coin = await getCoin(mint, options);
          if (coin) out.push(coin);
        } catch (e) {
          // One dead mint must not void the whole batch; the caller gets the
          // coins that did resolve and the failure is recorded for health.
          log.debug({ mint, err: safeErrorText(e, 160) }, 'pump.fun coin lookup failed');
        }
      }
      return out;
    },

    async searchTokens(
      query: string,
      options?: { limit?: number; signal?: AbortSignal },
    ): Promise<PumpFunTokenMarketData[]> {
      const q = query.trim();
      if (!q) return [];
      return listCoins({
        searchTerm: q,
        sort: 'market_cap',
        order: 'DESC',
        limit: options?.limit ?? 50,
        includeNsfw: true,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    },

    recentLaunches,

    listCoins,

    async currentlyLive(options?: {
      limit?: number;
      offset?: number;
      signal?: AbortSignal;
    }): Promise<PumpFunTokenMarketData[]> {
      const body = await http.request<unknown>('coins/currently-live', {
        query: {
          offset: clampInt(options?.offset ?? 0, 0, MAX_PAGE_OFFSET),
          limit: clampInt(options?.limit ?? 50, 1, MAX_PAGE_LIMIT),
        },
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      return mapCoins(body, options?.signal);
    },

    async getSolPriceUsd(options?: { signal?: AbortSignal }): Promise<number | null> {
      const price = await fetchSolPrice(options?.signal);
      return price?.priceUsd ?? null;
    },

    async getSolPrice(options?: { signal?: AbortSignal }): Promise<PumpFunSolPrice | null> {
      return fetchSolPrice(options?.signal);
    },

    getTrades,

    async getRecentTradeStats(
      mint: string,
      options?: { limit?: number; signal?: AbortSignal },
    ): Promise<PumpFunTradeStats | null> {
      const trades = await getTrades(mint, options);
      if (trades.length === 0) return null;
      let buys = 0;
      let sells = 0;
      let volumeSol = 0;
      let volumeUsd = 0;
      let first = Number.POSITIVE_INFINITY;
      let last = 0;
      const traders = new Set<string>();
      for (const t of trades) {
        if (t.side === 'buy') buys++;
        else sells++;
        volumeSol += Math.abs(t.amountSol ?? 0);
        volumeUsd += Math.abs(t.amountUsd ?? 0);
        if (t.userAddress) traders.add(t.userAddress);
        if (t.timestampMs < first) first = t.timestampMs;
        if (t.timestampMs > last) last = t.timestampMs;
      }
      const firstTradeAtMs = Number.isFinite(first) ? first : undefined;
      return {
        mint: mint.trim(),
        trades,
        buys,
        sells,
        volumeSol,
        volumeUsd,
        uniqueTraders: traders.size,
        // The tape is a fixed-size page, not a time window: on a busy coin these
        // 50 trades may span two seconds. Callers must divide by windowMs rather
        // than treat the totals as a per-minute figure.
        windowMs: firstTradeAtMs !== undefined && last > 0 ? last - firstTradeAtMs : 0,
        ...optional('firstTradeAtMs', firstTradeAtMs),
        ...optional('lastTradeAtMs', last > 0 ? last : undefined),
      };
    },

    async marketRegime(options?: {
      launchSampleSize?: number;
      graduationSampleSize?: number;
      signal?: AbortSignal;
    }): Promise<PumpFunMarketRegime> {
      const launchSampleSize = clampInt(options?.launchSampleSize ?? 100, 2, 300);
      const graduationSampleSize = clampInt(options?.graduationSampleSize ?? 150, 1, 300);
      const observedAt = clock.now();

      const newest = await recentLaunches({
        limit: launchSampleSize,
        ...(options?.signal ? { signal: options.signal } : {}),
      });

      const launchesPerHour = estimateLaunchesPerHour(newest);

      /**
       * Graduation sample: the OLDEST coins still reachable through the feed.
       *
       * The offset ceiling (~1_050 rows) is the binding constraint here. At
       * current launch rates that is roughly the last 25 minutes, so this is an
       * "already graduated within minutes" rate — a strict lower bound on the
       * eventual graduation rate, not an estimate of it. It is still the most
       * informative regime signal available from this host, because it moves
       * sharply between a hot market and a dead one, and no deeper history is
       * retrievable at any price.
       */
      const graduationStart = Math.max(0, MAX_PAGE_OFFSET - graduationSampleSize);
      const sample: PumpFunTokenMarketData[] = [];
      const seen = new Set<string>();
      for (
        let offset = graduationStart;
        sample.length < graduationSampleSize && offset <= MAX_PAGE_OFFSET;

      ) {
        // Step by the rows requested, not the page cap — see `recentLaunches`.
        const pageLimit = Math.min(MAX_PAGE_LIMIT, graduationSampleSize - sample.length);
        offset += pageLimit;
        const page = await listCoins({
          sort: 'created_timestamp',
          order: 'DESC',
          offset: offset - pageLimit,
          limit: pageLimit,
          includeNsfw: true,
          // Deep pages change slowly relative to the head of the feed.
          cacheTtlMs: 30_000,
          ...(options?.signal ? { signal: options.signal } : {}),
        });
        if (page.length === 0) break;
        for (const coin of page) {
          if (seen.has(coin.mint)) continue;
          seen.add(coin.mint);
          sample.push(coin);
        }
      }

      const graduatedCount = sample.reduce((n, c) => n + (c.graduated === true ? 1 : 0), 0);
      const ages = sample
        .map((c) => c.createdAtMs)
        .filter((t): t is number => typeof t === 'number' && t > 0)
        .map((t) => observedAt - t);

      return {
        launchesPerHour,
        // No sample means no rate. Reporting 0 would read as "nothing graduates",
        // which is a claim this measurement did not make.
        graduationRate: sample.length > 0 ? graduatedCount / sample.length : 0,
        sampleSize: sample.length,
        observedAt,
        launchSampleSize: newest.length,
        graduatedCount,
        ...optional(
          'graduationSampleAgeMs',
          ages.length > 0 ? { youngest: Math.min(...ages), oldest: Math.max(...ages) } : undefined,
        ),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Module-level convenience
// ---------------------------------------------------------------------------

let sharedProvider: PumpFunProvider | null = null;

/**
 * Market-regime snapshot without wiring a provider.
 *
 * The lazily-created provider is process-wide so that repeated calls share one
 * rate limiter and one cache; passing `provider` (as the service layer does)
 * bypasses it entirely.
 */
export function getMarketRegime(options?: {
  provider?: PumpFunProvider;
  launchSampleSize?: number;
  graduationSampleSize?: number;
  signal?: AbortSignal;
}): Promise<PumpFunMarketRegime> {
  const provider = options?.provider ?? (sharedProvider ??= createPumpFunProvider());
  return provider.marketRegime({
    ...(options?.launchSampleSize !== undefined ? { launchSampleSize: options.launchSampleSize } : {}),
    ...(options?.graduationSampleSize !== undefined
      ? { graduationSampleSize: options.graduationSampleSize }
      : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
  });
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function toTokenMarketData(
  raw: unknown,
  ctx: { observedAt: number; solUsd: number | null; log: ReturnType<typeof componentLogger> },
): PumpFunTokenMarketData | null {
  if (!isRecord(raw)) return null;
  const mint = asString(raw['mint']);
  if (!mint || !MINT_RE.test(mint)) return null;

  const baseDecimals = intInRange(finiteNumber(raw['base_decimals']), 0, 18) ?? DEFAULT_BASE_DECIMALS;
  const quoteDecimals = intInRange(finiteNumber(raw['quote_decimals']), 0, 18) ?? LAMPORTS_DECIMALS;

  const virtualTokenReserves = toUi(raw['virtual_token_reserves'], baseDecimals);
  // `virtual_sol_reserves` and `virtual_quote_reserves` carry the same number;
  // the "sol" name is historical and wrong for a USDC-quoted curve.
  const virtualQuoteReserves = toUi(raw['virtual_quote_reserves'] ?? raw['virtual_sol_reserves'], quoteDecimals);
  const realTokenReserves = toUi(raw['real_token_reserves'], baseDecimals);
  const realQuoteReserves = toUi(raw['real_quote_reserves'] ?? raw['real_sol_reserves'], quoteDecimals);
  const quoteMint = asBase58(raw['quote_mint']);
  const quoteIsSol = quoteMint === undefined || NATIVE_QUOTE_MINTS.has(quoteMint);
  // `total_supply_str` exists because the raw value exceeds 2^53 for some
  // decimal configurations; prefer it and fall back to the number.
  const totalSupply =
    toUi(asString(raw['total_supply_str']), baseDecimals) ?? toUi(raw['total_supply'], baseDecimals);

  const complete = typeof raw['complete'] === 'boolean' ? raw['complete'] : undefined;
  const pumpSwapPool = asString(raw['pump_swap_pool']);
  // Server-authored enum ('pump' | 'pump_amm'), but it is still a free string on
  // the wire and it reaches saturation analysis, so it is capped and sanitised
  // like any other external text rather than trusted as a closed set.
  const program = sanitiseOptional(asString(raw['program']), 32);
  const onAmm = program === 'pump_amm' || pumpSwapPool !== null || complete === true;

  const marketCapSol = finiteNumber(raw['market_cap']);
  const marketCapQuote = finiteNumber(raw['market_cap_quote']) ?? (quoteIsSol ? marketCapSol : undefined);
  const marketCapUsd = finiteNumber(raw['usd_market_cap']) ?? finiteNumber(raw['market_cap_usd']);

  // Enum-ish, server-authored ('active' | 'paused' | 'completed'), but sanitised
  // and length-capped anyway rather than trusted as a closed set.
  const mayhemState = sanitiseOptional(asString(raw['mayhem_state']), 32);

  const curve = computeCurveProgress({
    complete,
    realTokenReserves,
    virtualTokenReserves,
    virtualQuoteReserves,
    totalSupply,
    marketCapQuote,
    mayhemState,
  });

  // Price is derived from market cap over supply rather than from the reserve
  // ratio, because the reserve fields read zero for graduated coins while the
  // market cap keeps tracking the AMM. Cross-checked against the swap-api tape:
  // market_cap/supply matched the live fill price to four significant figures
  // for both a curve coin and a migrated one.
  const priceSol =
    ratio(marketCapSol, totalSupply) ??
    (quoteIsSol ? ratio(virtualQuoteReserves, virtualTokenReserves) : undefined);
  const priceUsd =
    ratio(marketCapUsd, totalSupply) ??
    (priceSol !== undefined && ctx.solUsd !== null && ctx.solUsd > 0 ? priceSol * ctx.solUsd : undefined);

  const extras: PumpFunCoinExtras = {
    // Every one of these is written by whoever deployed the coin. A token whose
    // description is a prompt-injection payload costs its author nothing, and
    // this text reaches a model during concept and saturation analysis.
    ...optional('description', sanitiseOptional(asString(raw['description']), 1_000)),
    ...optional('imageUri', sanitiseOptional(asString(raw['image_uri']), 300)),
    ...optional('metadataUri', sanitiseOptional(asString(raw['metadata_uri']), 300)),
    ...optional('website', sanitiseOptional(asString(raw['website']), 300)),
    ...optional('twitter', sanitiseOptional(asString(raw['twitter']), 300)),
    ...optional('telegram', sanitiseOptional(asString(raw['telegram']), 300)),
    // Addresses are base58 from the chain, not free text; validated, not sanitised.
    ...optional('creator', asBase58(raw['creator'])),
    ...optional('program', program),
    ...optional('tokenProgram', asBase58(raw['token_program'])),
    ...optional('bondingCurveAddress', asBase58(raw['bonding_curve'])),
    ...optional('associatedBondingCurve', asBase58(raw['associated_bonding_curve'])),
    ...optional('pumpSwapPool', pumpSwapPool !== null ? asBase58(raw['pump_swap_pool']) : undefined),
    onAmm,
    ...optional('virtualQuoteReserves', virtualQuoteReserves),
    ...optional('virtualTokenReserves', virtualTokenReserves),
    ...optional('realQuoteReserves', realQuoteReserves),
    ...optional('realTokenReserves', realTokenReserves),
    ...optional('quoteMint', quoteMint),
    quoteIsSol,
    ...optional('totalSupply', totalSupply),
    baseDecimals,
    quoteDecimals,
    ...optional('marketCapSol', marketCapSol),
    ...optional('marketCapQuote', marketCapQuote),
    ...optional('athMarketCapUsd', finiteNumber(raw['ath_market_cap'])),
    ...optional('athMarketCapAtMs', epochMs(raw['ath_market_cap_timestamp'])),
    ...optional('kingOfTheHillAtMs', epochMs(raw['king_of_the_hill_timestamp'])),
    ...optional('lastTradeAtMs', epochMs(raw['last_trade_timestamp'])),
    ...optional('replyCount', finiteNumber(raw['reply_count'])),
    ...optional('nsfw', asBoolean(raw['nsfw'])),
    ...optional('isCurrentlyLive', asBoolean(raw['is_currently_live'])),
    ...optional('mayhemState', mayhemState),
    ...optional('curveProgressUnavailableReason', curve.reason),
  };

  return {
    mint,
    // Attacker-controlled: anyone can mint a coin named after an injection
    // payload, and these strings flow into saturation analysis and model prompts.
    ...optional('name', sanitiseOptional(asString(raw['name']), 120)),
    ...optional('symbol', sanitiseOptional(asString(raw['symbol']), 32)),
    ...optional('priceSol', priceSol),
    ...optional('priceUsd', priceUsd),
    ...optional('marketCapUsd', marketCapUsd),
    // liquidityUsd intentionally absent — see the file header.
    // Volume, trade counts and holders are not on this payload at all. They are
    // left absent rather than derived from the capped trade tape, which would
    // silently mean "last 50 fills" while reading as "24h".
    ...optional('createdAtMs', epochMs(raw['created_timestamp'])),
    // Graduation only means something for a coin that had a curve. Non-launch
    // entries (wSOL and friends) also carry `complete: true`, so they are left
    // absent rather than reported as graduated.
    ...optional('graduated', realTokenReserves !== undefined ? complete : undefined),
    // Once migrated, the PumpSwap pool is the venue that matters; before that the
    // bonding curve is the only place the coin trades. Every candidate is shape-
    // validated as base58: this field is handed to callers as an address to act
    // on, so an unvalidated string here would flow straight into a lookup.
    ...optional(
      'poolAddress',
      asBase58(raw['pump_swap_pool']) ?? asBase58(raw['pool_address']) ?? asBase58(raw['bonding_curve']),
    ),
    ...optional('bondingCurveProgress', curve.progress),
    source: SOURCE,
    observedAt: ctx.observedAt,
    pumpfun: extras,
  };
}

/**
 * Bonding-curve progress, or `undefined` when it cannot be trusted.
 *
 * progress = 1 - real_token_reserves / initial_real_token_reserves
 *
 * The initial figure is 793.1M tokens for a standard 1e9-supply coin (verified
 * against every fresh launch observed). For a non-standard supply it is scaled
 * by the same 79.31% fraction rather than assumed constant, since the protocol
 * withholds a fixed proportion of supply for migration liquidity.
 *
 * Three things make the answer untrustworthy, and each returns `undefined`
 * rather than a plausible-looking number, because this value feeds entry timing
 * directly and a wrong 0.2 is far worse than a missing one:
 *
 *  1. No reserve or supply data at all (non-launch entries such as wSOL).
 *  2. A supply that implies a non-positive curve allocation.
 *  3. A reserve snapshot that contradicts the price snapshot. This is a real,
 *     observed failure: a coin sorted near the top by market cap reported
 *     `complete: false` with untouched 793.1M reserves alongside a $522M market
 *     cap. The reserves imply a market cap of `vQuote/vTokens * supply`; when
 *     that disagrees with the reported quote-denominated cap by more than half,
 *     one of the two fields is stale and the curve reading is discarded. The
 *     comparison must use `market_cap_quote`, never `market_cap`: the latter is
 *     normalised to SOL, so on a USDC-quoted coin it differs from the
 *     reserve-implied figure by the whole SOL/USD rate and every such coin
 *     would be wrongly rejected.
 */
function computeCurveProgress(input: {
  complete: boolean | undefined;
  realTokenReserves: number | undefined;
  virtualTokenReserves: number | undefined;
  virtualQuoteReserves: number | undefined;
  totalSupply: number | undefined;
  marketCapQuote: number | undefined;
  mayhemState: string | undefined;
}): { progress?: number; reason?: PumpFunCoinExtras['curveProgressUnavailableReason'] } {
  const { realTokenReserves, totalSupply, virtualQuoteReserves, virtualTokenReserves, marketCapQuote } =
    input;

  // Presence of reserve fields is what distinguishes a coin that has a curve
  // from a non-launch entry the API happens to index. wSOL comes back with
  // `complete: true` and no reserves at all; calling that "100% bonded" would be
  // pure invention, so the reserve check runs before the `complete` shortcut.
  if (realTokenReserves === undefined || realTokenReserves < 0) return { reason: 'no-reserves' };

  // A completed curve is 1 by definition, and its reserves are drained to zero,
  // so this must come before the ratio is computed.
  if (input.complete === true) return { progress: 1 };

  const initial =
    totalSupply !== undefined && totalSupply > 0
      ? totalSupply * CURVE_SUPPLY_FRACTION
      : STANDARD_CURVE_TOKENS_UI;
  if (!(initial > 0)) return { reason: 'bad-supply' };

  // Reserves ABOVE the genesis allocation. Measured live, this is ~9% of the
  // launch feed, and it is not a bad supply figure: every such coin observed
  // carried the standard 1e9 supply and a `mayhem_state`. The Mayhem mechanic
  // lets a curve be sold back behind where it started, so `real_token_reserves`
  // legitimately exceeds the 79.31% genesis allocation and the baseline for the
  // current cycle is not recoverable from this payload.
  //
  // Progress is withheld rather than clamped to 0: "0% bonded" and "wound back
  // behind the start of a mayhem cycle" are different claims, and this value
  // feeds entry timing. The reason code separates the two causes so an operator
  // is not sent looking for a supply bug that does not exist.
  if (realTokenReserves > initial * 1.001) {
    return { reason: input.mayhemState !== undefined ? 'curve-rewound' : 'bad-supply' };
  }

  if (
    virtualQuoteReserves !== undefined &&
    virtualTokenReserves !== undefined &&
    virtualTokenReserves > 0 &&
    totalSupply !== undefined &&
    totalSupply > 0 &&
    marketCapQuote !== undefined &&
    marketCapQuote > 0
  ) {
    const impliedMarketCapQuote = (virtualQuoteReserves / virtualTokenReserves) * totalSupply;
    const disagreement = Math.abs(impliedMarketCapQuote - marketCapQuote) / marketCapQuote;
    if (disagreement > 0.5) return { reason: 'inconsistent-snapshot' };
  }

  return { progress: clamp01(1 - realTokenReserves / initial) };
}

function toTrade(raw: unknown): PumpFunTrade | null {
  if (!isRecord(raw)) return null;
  // Shape-validated, not merely non-empty: a signature is quoted back to callers
  // as an on-chain reference and gets pasted into explorer links.
  const signature = asSignature(raw['tx']) ?? asSignature(raw['signature']);
  const userAddress = asBase58(raw['userAddress']);
  const type = asString(raw['type']);
  if (!signature || !userAddress || (type !== 'buy' && type !== 'sell')) return null;
  // `timestamp` is an ISO-8601 string on v2 (it was epoch seconds on the dead
  // v1 path), so both forms are accepted and anything else drops the trade.
  const timestampMs = epochMs(raw['timestamp']) ?? isoMs(asString(raw['timestamp']));
  if (timestampMs === undefined) return null;

  return {
    ...optional('slotIndexId', asString(raw['slotIndexId'])),
    signature,
    timestampMs,
    userAddress,
    side: type,
    ...optional('program', sanitiseOptional(asString(raw['program']), 32)),
    // Every numeric on this endpoint is a high-precision decimal STRING.
    ...optional('priceUsd', finiteNumber(raw['priceUsd'])),
    ...optional('priceSol', finiteNumber(raw['priceSol'])),
    ...optional('amountUsd', finiteNumber(raw['amountUsd'])),
    ...optional('amountSol', finiteNumber(raw['amountSol'])),
    ...optional('baseAmount', finiteNumber(raw['baseAmount'])),
    ...optional('quoteAmount', finiteNumber(raw['quoteAmount'])),
  };
}

/**
 * Launches per hour from the timestamp spread of a newest-first sample.
 *
 * With n coins spanning `span` milliseconds there are n-1 inter-arrival gaps, so
 * the rate is (n-1)/span. Using n/span would over-count by one launch per
 * sample. Coins created inside the same second are common, so a degenerate span
 * yields 0 rather than an infinite rate.
 */
function estimateLaunchesPerHour(sample: readonly TokenMarketData[]): number {
  const times = sample
    .map((c) => c.createdAtMs)
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0);
  if (times.length < 2) return 0;
  const span = Math.max(...times) - Math.min(...times);
  if (span <= 0) return 0;
  return ((times.length - 1) / span) * 3_600_000;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dedupeMints(mints: readonly string[]): string[] {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Base58 address, validated by shape. Never sanitised — it is not free text. */
function asBase58(value: unknown): string | undefined {
  const s = asString(value);
  return s && MINT_RE.test(s) ? s : undefined;
}

/** Base58 transaction signature, validated by shape for the same reason. */
function asSignature(value: unknown): string | undefined {
  const s = asString(value);
  return s && SIGNATURE_RE.test(s) ? s : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function intInRange(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !Number.isInteger(value) || value < min || value > max) return undefined;
  return value;
}

/** Raw base units -> UI amount. Undefined in, undefined out. */
function toUi(value: unknown, decimals: number): number | undefined {
  const raw = finiteNumber(value);
  if (raw === undefined || raw < 0) return undefined;
  return raw / 10 ** decimals;
}

/** Unix milliseconds, rejecting the zero sentinel the API uses for "never". */
function epochMs(value: unknown): number | undefined {
  const n = finiteNumber(value);
  if (n === undefined || n <= 0) return undefined;
  // A few fields (`updated_at`) are seconds rather than milliseconds. Anything
  // below this threshold is far too small to be a plausible ms timestamp.
  return n < 1e11 ? n * 1000 : n;
}

function isoMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function ratio(numerator: number | undefined, denominator: number | undefined): number | undefined {
  if (numerator === undefined || denominator === undefined || !(denominator > 0)) return undefined;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : undefined;
}

function sanitiseOptional(value: string | null, maxLength: number): string | undefined {
  if (!value) return undefined;
  const clean = sanitiseExternalText(value, maxLength);
  return clean.length > 0 ? clean : undefined;
}

/**
 * Spread-in helper: `...optional('k', v)` adds nothing when `v` is null or
 * undefined, keeping absent upstream fields absent rather than explicitly
 * undefined (these records are persisted, and an explicit null reads as
 * "measured as nothing").
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

/** Distinguish the failure modes an operator can actually act on. */
function describeFailure(e: unknown): string {
  if (e instanceof HttpError) {
    if (e.status === 530) {
      return 'HTTP 530 — this is the signature of the retired frontend-api.pump.fun host; check the configured base URL.';
    }
    if (e.status === 429) return 'rate limited (429); the self-imposed 60/min budget may be too high for this egress IP';
    if (e.status === 503) return 'HTTP 503 from the pump.fun edge; backing off';
    if (e.status === 403 && /cloudflare|browser integrity|error\s*(code)?\s*:?\s*1010/i.test(e.bodyText)) {
      return 'Cloudflare browser-integrity check rejected the request; egress IP may be blocked.';
    }
  }
  return safeErrorText(e, 200);
}
