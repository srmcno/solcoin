import { SECRET_KEYS } from '../security/secrets.js';
import { componentLogger } from '../core/logger.js';
import { safeErrorText } from '../core/errors.js';
import { newId } from '../core/ids.js';
import type { Db } from '../db/client.js';
import type { SettingsService } from '../services/settings.service.js';
import type { AiProvider, ImageProvider, MarketProvider, Provider, TrendProvider } from './types.js';
import { AiRouter, type AiResponseCache, type AiUsageRecord } from './ai/router.js';
import { createAnthropicProvider } from './ai/anthropic.js';
import { createOpenAiImageProvider, createOpenAiProvider } from './ai/openai.js';
import { createBlueskyProvider } from './trends/bluesky.js';
import { createGdeltProvider } from './trends/gdelt.js';
import { createGoogleTrendsProvider } from './trends/google-trends.js';
import { createHackerNewsProvider } from './trends/hackernews.js';
import { createMastodonProvider } from './trends/mastodon.js';
import { createRedditProvider } from './trends/reddit.js';
import { createRssProvider } from './trends/rss.js';
import { createStackExchangeProvider } from './trends/stackexchange.js';
import { createWikipediaProvider } from './trends/wikipedia.js';
import { createYouTubeProvider } from './trends/youtube.js';
import { createDexScreenerProvider } from './market/dexscreener.js';
import { createJupiterProvider } from './market/jupiter.js';
import { createPumpFunProvider } from './market/pumpfun-api.js';

/**
 * Provider assembly.
 *
 * Every provider is constructed unconditionally; the ones needing credentials
 * report `unconfigured` and return nothing rather than being omitted. That is
 * deliberate: the System Health screen should list a provider the operator
 * *could* enable, with the hint that unlocks it, rather than silently hiding it.
 *
 * Construction failures are caught per provider. One bad constructor must never
 * stop the platform from booting with the rest.
 */

export interface BuildProvidersDeps {
  getCredential: (key: string) => Promise<string | null>;
  settings: SettingsService;
  now: () => number;
  /** Database, used for the persistent AI response cache and usage ledger. */
  db?: Db;
}

export interface BuiltProviders {
  trendProviders: TrendProvider[];
  marketProviders: MarketProvider[];
  aiProviders: Provider[];
  imageProvider: ImageProvider | null;
  aiRouter: AiRouter;
  /** Shared SOL price getter, so every provider agrees on the rate. */
  solPriceUsd: () => Promise<number | null>;
}

export async function buildAllProviders(deps: BuildProvidersDeps): Promise<BuiltProviders> {
  const log = componentLogger('providers');
  const config = deps.settings.get();

  const attempt = <T>(name: string, factory: () => T): T | null => {
    try {
      return factory();
    } catch (e) {
      log.warn({ provider: name, err: safeErrorText(e, 200) }, 'provider could not be constructed');
      return null;
    }
  };

  // pump.fun's own API is both a market provider and the SOL price source, so
  // it is built first and shared.
  const pumpfun = attempt('pumpfun', () => createPumpFunProvider({}));

  let cachedSolPrice: { value: number; at: number } | null = null;
  const solPriceUsd = async (): Promise<number | null> => {
    // One shared, briefly-cached rate: several providers convert USD to SOL and
    // they must not disagree with each other or fetch it independently.
    if (cachedSolPrice && deps.now() - cachedSolPrice.at < 60_000) return cachedSolPrice.value;
    if (!pumpfun) return null;
    try {
      const priceProvider = pumpfun as unknown as { getSolPriceUsd?: () => Promise<number | null> };
      const value = await priceProvider.getSolPriceUsd?.();
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        cachedSolPrice = { value, at: deps.now() };
        return value;
      }
    } catch {
      // A missing SOL price degrades USD reporting; it never blocks anything.
    }
    return null;
  };

  const trendProviders: TrendProvider[] = ([
    attempt('google-trends', () => createGoogleTrendsProvider({ geos: config.research.googleTrendsRegions })),
    attempt('bluesky', () => createBlueskyProvider({})),
    attempt('mastodon', () => createMastodonProvider({ instances: config.research.mastodonInstances })),
    attempt('wikipedia', () => createWikipediaProvider({})),
    attempt('hackernews', () => createHackerNewsProvider({})),
    attempt('gdelt', () =>
      createGdeltProvider({
        // GDELT has no discovery endpoint of its own, so it is seeded with the
        // operator's keywords: it is a confirmation source, not a discovery one.
        seedTerms: () => deps.settings.get().research.customKeywords,
      }),
    ),
    attempt('stackexchange', () => createStackExchangeProvider({})),
    attempt('rss', () => createRssProvider({ getFeedUrls: () => deps.settings.get().research.customRssFeeds })),
    attempt('youtube', () => createYouTubeProvider({ getCredential: deps.getCredential })),
    attempt('reddit', () =>
      createRedditProvider({
        getCredential: deps.getCredential,
        subreddits: deps.settings.get().research.customSubreddits,
      }),
    ),
  ] as Array<TrendProvider | null>).filter((p): p is TrendProvider => p !== null);

  const marketProviders: MarketProvider[] = ([
    attempt('jupiter', () => createJupiterProvider({ getCredential: deps.getCredential, solPriceUsd })),
    attempt('dexscreener', () => createDexScreenerProvider({ solPriceUsd })),
    pumpfun,
  ] as Array<MarketProvider | null>).filter((p): p is MarketProvider => p !== null);

  const aiProviders: AiProvider[] = ([
    attempt('anthropic', () => createAnthropicProvider({ getCredential: deps.getCredential })),
    attempt('openai', () => createOpenAiProvider({ getCredential: deps.getCredential })),
  ] as Array<AiProvider | null>).filter((p): p is AiProvider => p !== null);

  const imageProvider = attempt('openai-image', () =>
    createOpenAiImageProvider({ getCredential: deps.getCredential, model: config.ai.imageModel !== 'none' ? config.ai.imageModel : undefined }),
  );

  const aiRouter = new AiRouter({
    providers: aiProviders,
    settings: () => {
      const ai = deps.settings.get().ai;
      return {
        triageModel: ai.triageModel,
        generationModel: ai.generationModel,
        decisionModel: ai.decisionModel,
        maxOutputTokens: ai.maxOutputTokens,
        cacheTtlMinutes: ai.cacheTtlMinutes,
        maxConcurrentRequests: ai.maxConcurrentRequests,
      };
    },
    canSpend: async (usdEstimate) => {
      if (!deps.db) return { allowed: true };
      const settings = deps.settings.get();
      if (settings.emergencyStop) {
        return { allowed: false, reason: 'Emergency stop is engaged.' };
      }
      const row = deps.db.$raw
        .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM ai_requests WHERE created_at >= ?')
        .get(deps.now() - 86_400_000) as { total: number };
      const spent = row?.total ?? 0;
      if (spent + usdEstimate > settings.limits.maxAiSpendUsdPerDay) {
        return {
          allowed: false,
          reason: `Daily AI budget exhausted: $${spent.toFixed(2)} of $${settings.limits.maxAiSpendUsdPerDay} spent in the last 24 hours.`,
        };
      }
      return { allowed: true };
    },
    recordUsage: async (record: AiUsageRecord) => {
      if (!deps.db) return;
      deps.db.$raw
        .prepare(
          `INSERT INTO ai_requests (id, provider, model, purpose, ref_type, ref_id, prompt_tokens, completion_tokens,
                                    cached_tokens, cost_usd, latency_ms, cache_hit, ok, error, schema_retries, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          newId('air', record.at),
          record.provider,
          record.model,
          record.purpose,
          record.refType ?? null,
          record.refId ?? null,
          record.promptTokens,
          record.completionTokens,
          record.cachedTokens,
          record.costUsd,
          record.latencyMs,
          record.cacheHit ? 1 : 0,
          record.ok ? 1 : 0,
          record.error ?? null,
          record.schemaRetries,
          record.at,
        );
    },
    cache: deps.db ? createDbCache(deps.db, deps.now) : undefined,
    healthTtlMs: 60_000,
  });

  return { trendProviders, marketProviders, aiProviders, imageProvider, aiRouter, solPriceUsd };
}

/**
 * Durable AI response cache.
 *
 * Persisting it means a restart does not re-pay for prompts that were already
 * answered, which matters most during development when the same pipeline is
 * run repeatedly against the same trends.
 */
function createDbCache(db: Db, now: () => number): AiResponseCache {
  return {
    async get(key) {
      const row = db.$raw.prepare('SELECT response, expires_at FROM ai_cache WHERE key = ?').get(key) as
        | { response: string; expires_at: number }
        | undefined;
      if (!row) return null;
      if (row.expires_at < now()) {
        db.$raw.prepare('DELETE FROM ai_cache WHERE key = ?').run(key);
        return null;
      }
      db.$raw.prepare('UPDATE ai_cache SET hits = hits + 1 WHERE key = ?').run(key);
      try {
        return JSON.parse(row.response);
      } catch {
        return null;
      }
    },
    async set(key, value, ttlMs) {
      db.$raw
        .prepare(
          `INSERT INTO ai_cache (key, provider, model, purpose, response, expires_at, created_at)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(key) DO UPDATE SET response = excluded.response, expires_at = excluded.expires_at`,
        )
        .run(key, value.provider, value.model, 'cached', JSON.stringify(value), now() + ttlMs, now());
    },
  };
}

export { AiRouter };
