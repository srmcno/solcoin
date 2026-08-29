import { TIME, clamp, gini, lamportsToSol, type TokenLifecycle } from '@solcoin/shared';
import { newId } from '../core/ids.js';
import { componentLogger } from '../core/logger.js';
import type { Db } from '../db/client.js';
import type { EventBus } from '../core/events.js';
import type { MarketProvider, TokenMarketData } from '../providers/types.js';
import type { SettingsService } from './settings.service.js';

/**
 * Token performance monitoring.
 *
 * Monitoring costs money — every poll is an API call against a rate limit — and
 * the value of polling decays fast. A token that has had no trade in three days
 * will almost certainly never have another, and continuing to poll it at the
 * same rate as a token launched ten minutes ago wastes the quota that the fresh
 * token needs.
 *
 * So tokens move through monitoring tiers with decreasing frequency, and
 * "dormant" is an explicit, reversible state that reduces polling to a trickle
 * rather than stopping it. Historical data is never deleted: a token that comes
 * back to life months later is a genuinely interesting datapoint.
 *
 * On-chain tokens cannot be deleted, so nothing here pretends to "kill" a
 * token. What is being managed is the platform's own attention.
 */

export type MonitorTier = 'hot' | 'warm' | 'cool' | 'dormant';

export interface MonitoringResult {
  polled: number;
  updated: number;
  failed: number;
  lifecycleChanges: Array<{ mint: string; from: TokenLifecycle; to: TokenLifecycle }>;
  tierChanges: number;
}

export class MonitoringService {
  private readonly log = componentLogger('monitoring');

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly events: EventBus,
    private readonly now: () => number = Date.now,
  ) {}

  /** Register a newly launched token so monitoring begins immediately. */
  registerToken(input: {
    mint: string;
    launchId: string;
    conceptId: string;
    trendId: string | null;
    network: string;
    name: string;
    symbol: string;
    metadataUri: string | null;
    imageUri: string | null;
    creatorAddress: string;
    createdOnChainAt: number;
  }): void {
    this.db.$raw
      .prepare(
        `INSERT INTO tokens (mint, launch_id, concept_id, trend_id, network, name, symbol, metadata_uri,
                             image_uri, creator_address, lifecycle, created_on_chain_at, monitor_tier,
                             next_poll_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(mint) DO NOTHING`,
      )
      .run(
        input.mint,
        input.launchId,
        input.conceptId,
        input.trendId,
        input.network,
        input.name,
        input.symbol,
        input.metadataUri,
        input.imageUri,
        input.creatorAddress,
        'new',
        input.createdOnChainAt,
        'hot',
        this.now(),
        this.now(),
        this.now(),
      );
  }

  /** Tokens whose next poll is due, ordered so the hottest are served first. */
  dueForPoll(limit = 60): Array<{ mint: string; tier: MonitorTier; lifecycle: TokenLifecycle; network: string }> {
    const rows = this.db.$raw
      .prepare(
        `SELECT mint, monitor_tier, lifecycle, network FROM tokens
          WHERE (next_poll_at IS NULL OR next_poll_at <= ?)
          ORDER BY CASE monitor_tier WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 WHEN 'cool' THEN 2 ELSE 3 END,
                   next_poll_at ASC
          LIMIT ?`,
      )
      .all(this.now(), limit) as Array<{ mint: string; monitor_tier: string; lifecycle: string; network: string }>;
    return rows.map((r) => ({
      mint: r.mint,
      tier: r.monitor_tier as MonitorTier,
      lifecycle: r.lifecycle as TokenLifecycle,
      network: r.network,
    }));
  }

  /**
   * Poll a batch of tokens and fold the results in.
   *
   * Providers are tried in order and the first one returning data for a mint
   * wins, because a fresh mint is often absent from aggregators for the first
   * few minutes while being fully visible on the launchpad's own API.
   */
  async pollBatch(
    mints: string[],
    providers: MarketProvider[],
    options: { solPriceUsd?: number } = {},
  ): Promise<MonitoringResult> {
    const result: MonitoringResult = { polled: mints.length, updated: 0, failed: 0, lifecycleChanges: [], tierChanges: 0 };
    if (mints.length === 0) return result;

    const collected = new Map<string, TokenMarketData>();
    for (const provider of providers) {
      const missing = mints.filter((m) => !collected.has(m));
      if (missing.length === 0) break;
      try {
        const data = await provider.getTokens(missing);
        for (const item of data) {
          if (item?.mint) collected.set(item.mint, item);
        }
      } catch (e) {
        this.log.warn({ provider: provider.id, err: String(e).slice(0, 200) }, 'market provider failed during a poll batch');
      }
    }

    for (const mint of mints) {
      const data = collected.get(mint);
      if (!data) {
        result.failed++;
        this.recordPollFailure(mint);
        continue;
      }
      const change = this.applyObservation(mint, data, options.solPriceUsd);
      result.updated++;
      if (change.lifecycleChange) result.lifecycleChanges.push(change.lifecycleChange);
      if (change.tierChanged) result.tierChanges++;
    }

    return result;
  }

  /** Fold one market observation into the token's state. */
  applyObservation(
    mint: string,
    data: TokenMarketData,
    solPriceUsd?: number,
  ): { lifecycleChange?: { mint: string; from: TokenLifecycle; to: TokenLifecycle }; tierChanged: boolean } {
    const existing = this.db.$raw.prepare('SELECT * FROM tokens WHERE mint = ?').get(mint) as
      | Record<string, unknown>
      | undefined;
    if (!existing) return { tierChanged: false };

    const observedAt = data.observedAt || this.now();

    this.db.$raw
      .prepare(
        `INSERT INTO market_observations
           (id, token_mint, observed_at, source, price_sol, price_usd, market_cap_usd, liquidity_usd,
            volume_5m_sol, volume_1h_sol, volume_24h_sol, holders, tx_count_24h, buys_24h, sells_24h,
            bonding_curve_progress, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(token_mint, source, observed_at) DO NOTHING`,
      )
      .run(
        newId('mob', observedAt),
        mint,
        observedAt,
        data.source,
        data.priceSol ?? null,
        data.priceUsd ?? null,
        data.marketCapUsd ?? null,
        data.liquidityUsd ?? null,
        data.volume5mSol ?? null,
        data.volume1hSol ?? null,
        data.volume24hSol ?? null,
        data.holders ?? null,
        data.txCount24h ?? null,
        data.buys24h ?? null,
        data.sells24h ?? null,
        data.bondingCurveProgress ?? null,
        this.now(),
      );

    const previousLifecycle = String(existing.lifecycle) as TokenLifecycle;
    const previousHolders = Number(existing.holders ?? 0);
    const volume24h = data.volume24hSol ?? Number(existing.volume_24h_sol ?? 0);
    const holders = data.holders ?? previousHolders;
    const hadFirstTrade = existing.first_trade_at !== null && existing.first_trade_at !== undefined;

    /*
     * Two distinct questions, deliberately not conflated.
     *
     * "Has it ever traded?" can be inferred from holders: more than one holder
     * means somebody bought at some point, even if no volume figure survived.
     *
     * "Is it trading now?" cannot. Holders are a stock, not a flow — they
     * persist long after the last trade. Treating a holder count as current
     * activity means a token with twenty holders and no volume never goes
     * quiet, so it never becomes dormant, and the platform keeps polling a dead
     * token at full rate forever.
     */
    const hasEverTraded = (data.txCount24h ?? 0) > 0 || volume24h > 0 || holders > 1;
    const isTradingNow = (data.txCount24h ?? 0) > 0 || volume24h > 0;

    const firstTradeAt = !hadFirstTrade && hasEverTraded ? observedAt : (existing.first_trade_at as number | null);
    const lastTradeAt = isTradingNow ? observedAt : (existing.last_trade_at as number | null);

    const graduated = data.graduated === true;
    const graduatedAt = graduated ? ((existing.graduated_at as number | null) ?? observedAt) : (existing.graduated_at as number | null);

    const nextLifecycle = this.classify({
      createdAt: Number(existing.created_on_chain_at ?? existing.created_at),
      firstTradeAt,
      lastTradeAt,
      holders,
      peakHolders: Math.max(Number(existing.peak_holders ?? 0), holders),
      volume24hSol: volume24h,
      peakVolume24hSol: Math.max(Number(existing.peak_volume_24h_sol ?? 0), volume24h),
      graduated,
      previous: previousLifecycle,
    });

    const tier = this.tierFor(nextLifecycle, Number(existing.created_on_chain_at ?? existing.created_at), lastTradeAt);
    const previousTier = String(existing.monitor_tier) as MonitorTier;

    this.db.$raw
      .prepare(
        `UPDATE tokens SET
           lifecycle = ?, holders = ?, peak_holders = MAX(peak_holders, ?),
           market_cap_usd = COALESCE(?, market_cap_usd), peak_market_cap_usd = MAX(peak_market_cap_usd, COALESCE(?, 0)),
           price_sol = COALESCE(?, price_sol), liquidity_usd = COALESCE(?, liquidity_usd),
           volume_1h_sol = COALESCE(?, volume_1h_sol), volume_24h_sol = ?,
           peak_volume_24h_sol = MAX(peak_volume_24h_sol, ?),
           volume_total_sol = MAX(volume_total_sol, ?),
           tx_count = MAX(tx_count, COALESCE(?, 0)), buy_count = MAX(buy_count, COALESCE(?, 0)),
           sell_count = MAX(sell_count, COALESCE(?, 0)),
           first_trade_at = COALESCE(first_trade_at, ?), last_trade_at = COALESCE(?, last_trade_at),
           graduated_at = COALESCE(graduated_at, ?),
           pool_address = COALESCE(?, pool_address),
           monitor_tier = ?, next_poll_at = ?, poll_failure_count = 0, data_source = ?,
           dormant_at = CASE WHEN ? = 'dormant' AND dormant_at IS NULL THEN ? ELSE dormant_at END,
           updated_at = ?
         WHERE mint = ?`,
      )
      .run(
        nextLifecycle,
        holders,
        holders,
        data.marketCapUsd ?? null,
        data.marketCapUsd ?? null,
        data.priceSol ?? null,
        data.liquidityUsd ?? null,
        data.volume1hSol ?? null,
        volume24h,
        volume24h,
        Math.max(Number(existing.volume_total_sol ?? 0), volume24h),
        data.txCount24h ?? null,
        data.buys24h ?? null,
        data.sells24h ?? null,
        firstTradeAt,
        lastTradeAt,
        graduatedAt,
        data.poolAddress ?? null,
        tier,
        this.nextPollAt(tier),
        data.source,
        nextLifecycle,
        this.now(),
        this.now(),
        mint,
      );

    if (!hadFirstTrade && firstTradeAt) {
      this.events.emit('token.first_trade', { mint, atMs: firstTradeAt });
    }
    if (graduated && !existing.graduated_at) {
      this.events.emit('token.graduated', { mint, marketCapUsd: data.marketCapUsd ?? 0 });
    }
    const highVolumeThreshold = this.settings.get().notifications.highVolumeSol;
    if (volume24h >= highVolumeThreshold && Number(existing.volume_24h_sol ?? 0) < highVolumeThreshold) {
      this.events.emit('token.high_volume', { mint, volume24hSol: volume24h });
    }

    const lifecycleChange =
      nextLifecycle !== previousLifecycle ? { mint, from: previousLifecycle, to: nextLifecycle } : undefined;
    if (lifecycleChange) {
      this.events.emit('token.lifecycle_changed', { mint, from: previousLifecycle, to: nextLifecycle });
    }

    return { lifecycleChange, tierChanged: tier !== previousTier };
  }

  /**
   * Data-driven lifecycle classification.
   *
   * The thresholds are expressed relative to the token's own history (has it
   * lost most of its peak volume?) rather than as absolute SOL amounts, so the
   * classification stays meaningful across very different market conditions.
   */
  classify(input: {
    createdAt: number;
    firstTradeAt: number | null;
    lastTradeAt: number | null;
    holders: number;
    peakHolders: number;
    volume24hSol: number;
    peakVolume24hSol: number;
    graduated: boolean;
    previous: TokenLifecycle;
  }): TokenLifecycle {
    const ageHours = (this.now() - input.createdAt) / TIME.hour;
    const quietHours = input.lastTradeAt ? (this.now() - input.lastTradeAt) / TIME.hour : ageHours;
    const dormantAfter = this.settings.get().monitoring.dormantAfterQuietHours;

    if (input.graduated) {
      // Graduation is a milestone, not a terminal state: a graduated token that
      // goes quiet still needs to be classified honestly.
      if (quietHours > dormantAfter) return 'dormant';
      return input.volume24hSol > 0 ? 'graduated' : 'declining';
    }

    if (!input.firstTradeAt) {
      // No trade ever. Give it a grace period before calling it a failure —
      // organic discovery is not instant.
      if (ageHours < 2) return 'new';
      return ageHours > 24 ? 'failed' : 'new';
    }

    if (quietHours > dormantAfter) return 'dormant';

    const volumeRatio = input.peakVolume24hSol > 0 ? input.volume24hSol / input.peakVolume24hSol : 0;
    const holderRatio = input.peakHolders > 0 ? input.holders / input.peakHolders : 0;

    if (volumeRatio < 0.15 && holderRatio < 0.8 && ageHours > 6) return 'declining';

    if (input.holders >= 100 && input.volume24hSol > 0) {
      return volumeRatio > 0.6 ? 'high_momentum' : 'active';
    }
    if (input.holders >= 25) return volumeRatio > 0.5 ? 'growing' : 'active';
    if (input.holders >= 3) return 'early_traction';
    if (ageHours < 6) return 'new';
    return input.volume24hSol > 0 ? 'early_traction' : 'failed';
  }

  /** Monitoring frequency follows attention, not age alone. */
  private tierFor(lifecycle: TokenLifecycle, createdAt: number, lastTradeAt: number | null): MonitorTier {
    const config = this.settings.get().monitoring;
    const ageHours = (this.now() - createdAt) / TIME.hour;

    if (lifecycle === 'dormant' || lifecycle === 'failed') return 'dormant';
    if (lifecycle === 'high_momentum' || lifecycle === 'growing') return 'hot';
    if (ageHours <= config.hotWindowHours) return 'hot';

    const quietHours = lastTradeAt ? (this.now() - lastTradeAt) / TIME.hour : ageHours;
    if (quietHours > 24) return 'cool';
    if (ageHours <= config.warmWindowHours) return 'warm';
    return 'cool';
  }

  private nextPollAt(tier: MonitorTier): number {
    const config = this.settings.get().monitoring;
    const seconds = {
      hot: config.hotIntervalSeconds,
      warm: config.warmIntervalSeconds,
      cool: config.coolIntervalSeconds,
      dormant: config.dormantIntervalSeconds,
    }[tier];
    // Jitter prevents every token in a tier from becoming due in the same tick,
    // which would spike straight into a provider rate limit.
    const jitter = 1 + (Math.random() - 0.5) * 0.2;
    return this.now() + seconds * 1000 * jitter;
  }

  private recordPollFailure(mint: string): void {
    // Back off on repeated failures rather than hammering a provider for a mint
    // it does not know about — very common for a freshly created token.
    this.db.$raw
      .prepare(
        `UPDATE tokens SET poll_failure_count = poll_failure_count + 1,
                           next_poll_at = ? + MIN(3600000, 60000 * (poll_failure_count + 1)),
                           updated_at = ?
         WHERE mint = ?`,
      )
      .run(this.now(), this.now(), mint);
  }

  /** Record a holder-distribution snapshot, including concentration risk. */
  recordHolders(mint: string, input: { count: number; balances?: number[]; top10Share?: number; source: string }): void {
    const distribution = input.balances ?? [];
    const computedGini = distribution.length > 1 ? gini(distribution) : null;
    const top10 =
      input.top10Share ??
      (distribution.length > 0
        ? (() => {
            const sorted = [...distribution].sort((a, b) => b - a);
            const total = sorted.reduce((a, b) => a + b, 0);
            if (total <= 0) return null;
            return sorted.slice(0, 10).reduce((a, b) => a + b, 0) / total;
          })()
        : null);

    this.db.$raw
      .prepare(
        `INSERT INTO holder_snapshots (id, token_mint, observed_at, holder_count, top10_share, gini, source, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(newId('hld', this.now()), mint, this.now(), input.count, top10, computedGini, input.source, this.now());

    if (computedGini !== null) {
      this.db.$raw.prepare('UPDATE tokens SET holder_gini = ?, updated_at = ? WHERE mint = ?').run(computedGini, this.now(), mint);
    }
  }

  async getToken(mint: string): Promise<Record<string, unknown> | null> {
    return (this.db.$raw.prepare('SELECT * FROM tokens WHERE mint = ?').get(mint) as Record<string, unknown>) ?? null;
  }

  async listTokens(options: { lifecycle?: string; network?: string; limit?: number; offset?: number } = {}): Promise<
    Array<Record<string, unknown>>
  > {
    return this.db.$raw
      .prepare(
        `SELECT * FROM tokens
          WHERE (? IS NULL OR lifecycle = ?) AND (? IS NULL OR network = ?)
          ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(
        options.lifecycle ?? null,
        options.lifecycle ?? null,
        options.network ?? null,
        options.network ?? null,
        options.limit ?? 50,
        options.offset ?? 0,
      ) as Array<Record<string, unknown>>;
  }

  async getObservations(mint: string, sinceMs?: number, limit = 500): Promise<Array<Record<string, unknown>>> {
    return this.db.$raw
      .prepare(
        `SELECT * FROM market_observations WHERE token_mint = ? AND observed_at >= ?
          ORDER BY observed_at ASC LIMIT ?`,
      )
      .all(mint, sinceMs ?? 0, limit) as Array<Record<string, unknown>>;
  }

  /**
   * Sweep tokens into dormancy that have gone quiet.
   *
   * Run on a schedule so a token that simply stopped being polled (because its
   * provider was down) is still classified correctly.
   */
  markDormant(): number {
    const config = this.settings.get().monitoring;
    const cutoff = this.now() - config.dormantAfterQuietHours * TIME.hour;
    return this.db.$raw
      .prepare(
        `UPDATE tokens SET lifecycle = 'dormant', monitor_tier = 'dormant', dormant_at = COALESCE(dormant_at, ?),
                           next_poll_at = ?, updated_at = ?
          WHERE lifecycle NOT IN ('dormant','failed')
            AND COALESCE(last_trade_at, created_on_chain_at, created_at) < ?
            AND volume_24h_sol <= 0`,
      )
      .run(this.now(), this.now() + config.dormantIntervalSeconds * 1000, this.now(), cutoff).changes;
  }

  /** Monitoring cost/attention summary for the health dashboard. */
  async tierSummary(): Promise<Array<{ tier: string; count: number; pollsPerHour: number }>> {
    const config = this.settings.get().monitoring;
    const rows = this.db.$raw
      .prepare('SELECT monitor_tier AS tier, COUNT(*) AS count FROM tokens GROUP BY monitor_tier')
      .all() as Array<{ tier: string; count: number }>;
    const intervals: Record<string, number> = {
      hot: config.hotIntervalSeconds,
      warm: config.warmIntervalSeconds,
      cool: config.coolIntervalSeconds,
      dormant: config.dormantIntervalSeconds,
    };
    return rows.map((r) => ({
      tier: r.tier,
      count: r.count,
      pollsPerHour: (r.count * 3600) / (intervals[r.tier] ?? 3600),
    }));
  }
}
