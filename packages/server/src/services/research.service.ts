import { HARD_LIMITS, clamp, type TrendSourceId } from '@solcoin/shared';
import { componentLogger } from '../core/logger.js';
import { safeErrorText } from '../core/errors.js';
import type { TrendProvider, RawTrendSignal, MarketProvider } from '../providers/types.js';
import type { SettingsService } from './settings.service.js';
import type { GuardService } from './guard.service.js';
import type { TrendService, ScoredTrend } from './trend.service.js';
import type { Db } from '../db/client.js';
import { newId } from '../core/ids.js';

/**
 * Discovery orchestration.
 *
 * Runs every enabled trend provider, folds their signals into the trend graph,
 * then performs the step that actually creates the platform's edge:
 * **cross-platform confirmation**. A term that surfaced on one platform is
 * measured against the sources that support lookup, so a genuine cultural
 * moment (visible on four independent populations) separates from a single
 * platform's noise.
 *
 * Confirmation is budgeted: measurement calls are the scarcest resource in the
 * whole system (YouTube allows 100 searches a day, Jupiter 30 requests a
 * minute), so they are spent only on candidates that already look promising.
 */

export interface DiscoveryResult {
  providersRun: number;
  providersFailed: number;
  signals: number;
  trendsCreated: number;
  trendsUpdated: number;
  quarantined: number;
  confirmationsAttempted: number;
  confirmationsFound: number;
  scored: number;
  topScore: number;
  errors: Array<{ provider: string; error: string }>;
  durationMs: number;
}

export class ResearchService {
  private readonly log = componentLogger('research');

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly guard: GuardService,
    private readonly trends: TrendService,
    private readonly now: () => number = Date.now,
  ) {}

  async discover(options: {
    providers: TrendProvider[];
    marketProviders?: MarketProvider[];
    signal?: AbortSignal;
  }): Promise<DiscoveryResult> {
    const started = this.now();
    const result: DiscoveryResult = {
      providersRun: 0,
      providersFailed: 0,
      signals: 0,
      trendsCreated: 0,
      trendsUpdated: 0,
      quarantined: 0,
      confirmationsAttempted: 0,
      confirmationsFound: 0,
      scored: 0,
      topScore: 0,
      errors: [],
      durationMs: 0,
    };

    const operational = this.guard.checkOperational('research');
    if (!operational.allowed) {
      result.errors.push({ provider: 'guard', error: operational.reason ?? 'Research is not permitted right now.' });
      result.durationMs = this.now() - started;
      return result;
    }

    const config = this.settings.get();
    const enabled = new Set<TrendSourceId>(config.research.enabledSources);
    const active = options.providers.filter((p) => enabled.has(p.sourceId));

    if (active.length === 0) {
      result.errors.push({ provider: 'config', error: 'No trend sources are enabled.' });
      result.durationMs = this.now() - started;
      return result;
    }

    // Providers run concurrently: they hit different hosts with independent
    // rate limits, and a slow one must not delay the rest.
    const perProviderLimit = Math.max(10, Math.floor(HARD_LIMITS.maxTrendsPerDiscovery / active.length));
    const outcomes = await Promise.allSettled(
      active.map(async (provider) => {
        const signals = await provider.discover({ limit: perProviderLimit, signal: options.signal });
        return { provider, signals };
      }),
    );

    const allSignals: RawTrendSignal[] = [];
    for (const [index, outcome] of outcomes.entries()) {
      const provider = active[index]!;
      if (outcome.status === 'fulfilled') {
        result.providersRun++;
        allSignals.push(...outcome.value.signals);
      } else {
        result.providersFailed++;
        const error = safeErrorText(outcome.reason, 200);
        result.errors.push({ provider: provider.id, error });
        this.log.warn({ provider: provider.id, err: error }, 'trend provider failed during discovery');
      }
    }

    result.signals = allSignals.length;

    const ingest = await this.trends.ingest(allSignals);
    result.trendsCreated = ingest.created;
    result.trendsUpdated = ingest.updated;
    result.quarantined = ingest.quarantined;

    // First scoring pass, so confirmation spend targets the strongest candidates.
    const firstPass = await this.trends.rescoreAll({ limit: config.research.maxActiveTrends });

    const confirmation = await this.confirmTopCandidates(active, options.signal);
    result.confirmationsAttempted = confirmation.attempted;
    result.confirmationsFound = confirmation.found;

    // Second pass folds the confirmations in. Running it unconditionally would
    // be wasteful; running it only when confirmations landed keeps the cost
    // proportional to the information gained.
    const finalPass = confirmation.found > 0 ? await this.trends.rescoreAll({ limit: config.research.maxActiveTrends }) : firstPass;
    result.scored = finalPass.scored;
    result.topScore = finalPass.topScore;

    result.durationMs = this.now() - started;
    this.log.info(
      {
        signals: result.signals,
        created: result.trendsCreated,
        confirmed: result.confirmationsFound,
        topScore: Number(result.topScore.toFixed(1)),
        durationMs: result.durationMs,
      },
      'discovery cycle complete',
    );
    return result;
  }

  /**
   * Spend measurement calls confirming the most promising candidates.
   *
   * The budget is deliberately small. Confirmation is only worth paying for on
   * trends that are already interesting *and* thinly sourced — confirming a
   * trend that five platforms already show adds nothing.
   */
  private async confirmTopCandidates(
    providers: TrendProvider[],
    signal?: AbortSignal,
  ): Promise<{ attempted: number; found: number }> {
    const measurers = providers.filter((p) => typeof p.measure === 'function');
    if (measurers.length === 0) return { attempted: 0, found: 0 };

    const candidates = await this.trends.listTop({ limit: 12, status: 'active' });
    const worthConfirming = candidates.filter((t) => t.sourceCount < 3 && t.opportunityScore >= 35).slice(0, 6);

    let attempted = 0;
    let found = 0;

    for (const trend of worthConfirming) {
      if (signal?.aborted) break;
      const alreadySeen = new Set(trend.sources);
      const targets = measurers.filter((m) => !alreadySeen.has(m.sourceId)).slice(0, 2);

      for (const provider of targets) {
        attempted++;
        try {
          const measurement = await provider.measure!(trend.title, { signal });
          if (measurement && measurement.rawValue > 0) {
            await this.trends.ingest([measurement]);
            found++;
          }
        } catch (e) {
          this.log.debug(
            { provider: provider.id, trend: trend.slug, err: safeErrorText(e, 120) },
            'confirmation lookup failed',
          );
        }
      }
    }

    return { attempted, found };
  }

  /**
   * Trends that qualify for concept generation.
   *
   * Deliberately narrow: generation is the most expensive step per candidate,
   * so it runs on the trends most likely to justify it, and a trend that
   * already has live candidates is skipped rather than regenerated.
   */
  async selectForGeneration(limit?: number): Promise<ScoredTrend[]> {
    const config = this.settings.get().research;
    const threshold = config.conceptGenerationThreshold;
    const maxTrendAge = this.settings.get().qualityGate.maxTrendAgeHours;

    const rows = this.db.$raw
      .prepare(
        `SELECT t.id FROM trends t
          WHERE t.status = 'active'
            AND t.opportunity_score >= ?
            AND (? - t.first_seen_at) / 3600000.0 <= ?
            AND NOT EXISTS (
              SELECT 1 FROM concepts c
               WHERE c.trend_id = t.id
                 AND c.status IN ('draft','evaluating','candidate','awaiting_approval','approved','queued','launching','launched')
            )
          ORDER BY t.opportunity_score DESC
          LIMIT ?`,
      )
      .all(threshold, this.now(), maxTrendAge, limit ?? 5) as Array<{ id: string }>;

    const trends: ScoredTrend[] = [];
    for (const row of rows) {
      const trend = await this.trends.getById(row.id);
      if (trend) trends.push(trend);
    }
    return trends;
  }

  /** Record an aggregate market snapshot for the regime features. */
  recordMarketSnapshot(input: {
    launchesPerHour: number;
    graduationRate: number;
    solPriceUsd?: number;
    solPriceChange24h?: number;
    medianTimeToFirstBuyMinutes?: number;
    categoryBreakdown?: Record<string, number>;
    source: string;
  }): void {
    // Risk appetite is a blend of how much is being launched (activity) and how
    // much of it succeeds (follow-through). High launch volume with a collapsed
    // graduation rate is a worse regime than moderate volume with good
    // follow-through, and this composite captures that.
    const activity = clamp(Math.log1p(input.launchesPerHour) / Math.log1p(400), 0, 1);
    const followThrough = clamp(input.graduationRate / 0.03, 0, 1);
    const momentum = input.solPriceChange24h !== undefined ? clamp(0.5 + input.solPriceChange24h / 0.2, 0, 1) : 0.5;
    const regimeScore = clamp(0.35 * activity + 0.4 * followThrough + 0.25 * momentum, 0, 1);

    this.db.$raw
      .prepare(
        `INSERT INTO market_snapshots (id, observed_at, launches_per_hour, graduation_rate,
                                       median_time_to_first_buy_minutes, sol_price_usd, sol_price_change_24h,
                                       regime_score, category_breakdown, source, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        newId('mks', this.now()),
        this.now(),
        input.launchesPerHour,
        input.graduationRate,
        input.medianTimeToFirstBuyMinutes ?? null,
        input.solPriceUsd ?? null,
        input.solPriceChange24h ?? null,
        regimeScore,
        input.categoryBreakdown ? JSON.stringify(input.categoryBreakdown) : null,
        input.source,
        this.now(),
      );
  }

  /** Latest market conditions, with honest neutral defaults when unknown. */
  latestMarketConditions(): {
    launchesPerHour: number;
    graduationRate: number;
    solMomentum: number;
    regime: number;
    solPriceUsd: number | null;
    observedAt: number | null;
    stale: boolean;
  } {
    const row = this.db.$raw
      .prepare('SELECT * FROM market_snapshots ORDER BY observed_at DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;

    if (!row) {
      // Neutral values, not optimistic ones. An unknown market must not make a
      // candidate look better than a measured average one.
      return {
        launchesPerHour: 100,
        graduationRate: 0.012,
        solMomentum: 0.5,
        regime: 0.5,
        solPriceUsd: null,
        observedAt: null,
        stale: true,
      };
    }

    const observedAt = Number(row.observed_at);
    return {
      launchesPerHour: Number(row.launches_per_hour ?? 100),
      graduationRate: Number(row.graduation_rate ?? 0.012),
      solMomentum:
        row.sol_price_change_24h !== null && row.sol_price_change_24h !== undefined
          ? clamp(0.5 + Number(row.sol_price_change_24h) / 0.2, 0, 1)
          : 0.5,
      regime: Number(row.regime_score ?? 0.5),
      solPriceUsd: row.sol_price_usd !== null ? Number(row.sol_price_usd) : null,
      observedAt,
      stale: this.now() - observedAt > 6 * 3_600_000,
    };
  }
}
