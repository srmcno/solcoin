import type { HealthState, TrendCategory, TrendSourceId } from '@solcoin/shared';

/**
 * Provider contracts.
 *
 * Every external dependency implements one of these interfaces, so the platform
 * can run with any subset configured and degrade honestly rather than
 * fabricating data. `available()` reporting `unconfigured` is a first-class
 * state that the dashboard surfaces — it is never treated as an error.
 */

export interface ProviderStatus {
  id: string;
  label: string;
  kind: 'trend' | 'market' | 'ai' | 'rpc' | 'storage' | 'notification';
  state: HealthState;
  detail: string;
  /** True when the provider needs credentials the operator has not supplied. */
  requiresCredentials: boolean;
  /** Human-readable description of what unlocks this provider. */
  setupHint?: string;
  latencyMs?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  /** Requests remaining in the current window, when the provider reports it. */
  quotaRemaining?: number;
  quotaResetAt?: number;
}

export interface Provider {
  readonly id: string;
  readonly label: string;
  readonly kind: ProviderStatus['kind'];
  /** Cheap liveness probe. Must not consume meaningful quota. */
  healthCheck(): Promise<ProviderStatus>;
}

// ---------------------------------------------------------------------------
// Trend providers
// ---------------------------------------------------------------------------

/**
 * A single raw signal from an external platform.
 *
 * `text` fields carry content written by strangers and are treated as untrusted
 * throughout: they are sanitised on ingest and only ever presented to models
 * inside an explicit data fence.
 */
export interface RawTrendSignal {
  source: TrendSourceId;
  /** Stable identifier within the source, for deduplication. */
  externalId: string;
  title: string;
  summary?: string;
  url?: string;
  /** Platform-native magnitude: upvotes, pageviews, post count, coverage %. */
  rawValue: number;
  /** Optional prior points, when the source ships history (e.g. Mastodon tags). */
  history?: Array<{ t: number; v: number }>;
  /** Engagement intensity if derivable, 0..1. */
  engagement?: number;
  /** Estimated audience reached. */
  audience?: number;
  /** Position in a ranked list, when the source is ranked. */
  rank?: number;
  observedAt: number;
  /** Source's own lifecycle hint, where it provides one. */
  sourceStage?: 'trending' | 'saturating' | 'cooling';
  category?: TrendCategory;
  keywords?: string[];
  metadata?: Record<string, unknown>;
}

export interface TrendProvider extends Provider {
  readonly kind: 'trend';
  readonly sourceId: TrendSourceId;
  /** Discover currently-rising items. */
  discover(options: { limit: number; signal?: AbortSignal }): Promise<RawTrendSignal[]>;
  /**
   * Measure a specific term. Optional: not every source supports lookup, and a
   * provider that cannot must return null rather than guessing.
   */
  measure?(term: string, options: { signal?: AbortSignal }): Promise<RawTrendSignal | null>;
}

// ---------------------------------------------------------------------------
// Market providers
// ---------------------------------------------------------------------------

export interface TokenMarketData {
  mint: string;
  name?: string;
  symbol?: string;
  priceSol?: number;
  priceUsd?: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
  volume5mSol?: number;
  volume1hSol?: number;
  volume24hSol?: number;
  /**
   * The same 24-hour volume in USD. Aggregators report volume in USD and it is
   * converted to SOL for display; saturation scoring compares against USD
   * thresholds, so the unconverted figure is carried rather than reconstructed
   * from a SOL price that may not be the one the conversion used.
   */
  volume24hUsd?: number;
  txCount24h?: number;
  buys24h?: number;
  sells24h?: number;
  holders?: number;
  createdAtMs?: number;
  graduated?: boolean;
  poolAddress?: string;
  bondingCurveProgress?: number;
  source: string;
  observedAt: number;
}

export interface MarketProvider extends Provider {
  readonly kind: 'market';
  /** Fetch current market data for one or more mints. */
  getTokens(mints: readonly string[], options?: { signal?: AbortSignal }): Promise<TokenMarketData[]>;
  /** Search recently-launched tokens matching a term, for saturation analysis. */
  searchTokens?(
    query: string,
    options?: { limit?: number; signal?: AbortSignal },
  ): Promise<TokenMarketData[]>;
  /** Sample the recent launch stream, for market-regime features. */
  recentLaunches?(options?: { limit?: number; signal?: AbortSignal }): Promise<TokenMarketData[]>;
}

export interface HolderProvider extends Provider {
  /** Count and distribution of holders for a mint. */
  getHolders(
    mint: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ count: number; top10Share?: number; balances?: number[]; source: string } | null>;
}

export interface PriceProvider extends Provider {
  getSolPriceUsd(options?: { signal?: AbortSignal }): Promise<number | null>;
}

// ---------------------------------------------------------------------------
// AI providers
// ---------------------------------------------------------------------------

export type AiTier = 'triage' | 'generation' | 'decision';

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiCompletionRequest {
  /** System prompt. Always platform-authored; never contains external content. */
  system: string;
  messages: AiMessage[];
  model: string;
  maxOutputTokens: number;
  temperature?: number;
  /** JSON Schema the response must satisfy. */
  responseSchema?: Record<string, unknown>;
  /** Identifies the call for cost attribution. */
  purpose: string;
  refType?: string;
  refId?: string;
  signal?: AbortSignal;
}

export interface AiCompletionResponse {
  text: string;
  /** Parsed object when a response schema was supplied. */
  parsed?: unknown;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
  latencyMs: number;
  stopReason?: string;
}

export interface AiProvider extends Provider {
  readonly kind: 'ai';
  complete(request: AiCompletionRequest): Promise<AiCompletionResponse>;
  /** Models this provider can serve, with pricing for cost accounting. */
  models(): Array<{ id: string; inputCostPerMTok: number; outputCostPerMTok: number; tier: AiTier }>;
}

export interface ImageProvider extends Provider {
  generate(request: {
    prompt: string;
    size?: string;
    refType?: string;
    refId?: string;
    signal?: AbortSignal;
  }): Promise<{ data: Buffer; mimeType: string; costUsd: number; model: string }>;
}

// ---------------------------------------------------------------------------
// Storage (metadata / image hosting)
// ---------------------------------------------------------------------------

export interface MetadataStorageProvider extends Provider {
  readonly kind: 'storage';
  /** Upload artwork plus token metadata, returning the URI used at mint time. */
  upload(input: {
    image: Buffer;
    imageMimeType: string;
    name: string;
    symbol: string;
    description: string;
    website?: string;
    twitter?: string;
    telegram?: string;
    signal?: AbortSignal;
  }): Promise<{ metadataUri: string; imageUri: string; provider: string }>;
}
