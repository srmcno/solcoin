import {
  DEFAULT_ECONOMICS,
  LaunchFeatures,
  createModelBundle,
  encodeFeatures,
  logScale01,
  neutralFeatures,
  predictLaunch,
  clamp,
  type EconomicAssumptions,
  type PredictionResult,
  type SuccessModelBundle,
} from '@solcoin/shared';
import { newId } from '../core/ids.js';
import { componentLogger } from '../core/logger.js';
import { parseJson } from '../core/json.js';
import type { Db } from '../db/client.js';
import type { ScoredTrend } from './trend.service.js';

/**
 * Prediction and model lifecycle.
 *
 * The model bundle is versioned and persisted. Every prediction stores the
 * feature vector it was computed from *and* the model version, which is what
 * makes the learning loop honest: an old decision can be re-scored with a new
 * model, and a new model's claimed improvement can be checked against the
 * decisions the old one actually made.
 */

export interface FeatureContext {
  trend: ScoredTrend;
  concept: {
    id: string;
    symbol: string;
    archetype: string;
    originalityScore: number;
    saturationScore: number;
    nameQuality: number;
    tickerQuality: number;
    memeIntensity: number;
    culturalRelevance: number;
    artworkQuality: number;
  };
  panel: { score: number; disagreement: number };
  competition: { recentCount: number; bestMarketCapUsd: number; quality: number };
  market: { launchesPerHour: number; graduationRate: number; solMomentum: number; regime: number };
  /** Decision time, so a backtest can build features as of a past moment. */
  atMs: number;
}

export class PredictionService {
  private readonly log = componentLogger('prediction');
  private bundle: SuccessModelBundle | null = null;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** The active model, loaded from the database or seeded from the priors. */
  getBundle(): SuccessModelBundle {
    if (this.bundle) return this.bundle;
    const row = this.db.$raw
      .prepare(`SELECT * FROM model_versions WHERE kind = 'success_bundle' AND active = 1 ORDER BY created_at DESC LIMIT 1`)
      .get() as Record<string, unknown> | undefined;

    if (row) {
      const parsed = parseJson<SuccessModelBundle | null>(row.state as string, null);
      if (parsed && parsed.classification && parsed.volume24h) {
        this.bundle = parsed;
        return parsed;
      }
      this.log.warn('the stored model bundle could not be read; falling back to the prior model');
    }

    const featureNames = encodeFeatures(neutralFeatures()).names;
    const fresh = createModelBundle(featureNames, 'v1-priors');
    fresh.createdAt = this.now();
    this.saveBundle(fresh, { activate: true, notes: 'Seeded from encoded domain priors. No launch outcomes observed yet.' });
    this.bundle = fresh;
    return fresh;
  }

  saveBundle(
    bundle: SuccessModelBundle,
    options: { activate?: boolean; notes?: string; metrics?: unknown } = {},
  ): void {
    const timestamp = this.now();
    this.db.$raw.transaction(() => {
      if (options.activate) {
        this.db.$raw.prepare(`UPDATE model_versions SET active = 0 WHERE kind = 'success_bundle'`).run();
      }
      this.db.$raw
        .prepare(
          `INSERT INTO model_versions (id, version, kind, state, trained_on, metrics, notes, active, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(version) DO UPDATE SET state = excluded.state, trained_on = excluded.trained_on,
                                              metrics = excluded.metrics, notes = excluded.notes,
                                              active = excluded.active`,
        )
        .run(
          newId('mdl', timestamp),
          bundle.version,
          'success_bundle',
          JSON.stringify(bundle),
          bundle.trainedOn,
          options.metrics ? JSON.stringify(options.metrics) : null,
          options.notes ?? null,
          options.activate ? 1 : 0,
          timestamp,
        );
    })();
    if (options.activate) this.bundle = bundle;
  }

  invalidate(): void {
    this.bundle = null;
  }

  /**
   * Assemble the canonical feature vector.
   *
   * Everything is derived from measured data or from platform-computed scores;
   * nothing here is a model's self-assessment except the panel score, which is
   * explicitly labelled as such and paired with its disagreement.
   */
  buildFeatures(context: FeatureContext): LaunchFeatures {
    const at = new Date(context.atMs);
    const base = neutralFeatures();

    return LaunchFeatures.parse({
      ...base,
      trend_level: clamp(context.trend.opportunityScore / 100, 0, 1),
      trend_velocity: context.trend.velocity,
      trend_acceleration: context.trend.acceleration,
      trend_consistency: context.trend.consistency,
      trend_age_hours: context.trend.ageHours,
      trend_expected_remaining_hours: context.trend.remainingLifespanHours,
      trend_source_breadth: clamp(context.trend.sourceCount / 6, 0, 1),
      trend_audience: logScale01(context.trend.audienceEstimate, 5_000_000),
      trend_novelty: context.trend.novelty,

      saturation: context.concept.saturationScore,
      competing_recent_count: context.competition.recentCount,
      competing_best_marketcap: logScale01(context.competition.bestMarketCapUsd, 2_000_000),
      competing_quality: context.competition.quality,

      originality: context.concept.originalityScore,
      name_quality: context.concept.nameQuality,
      ticker_length: context.concept.symbol.length,
      ticker_quality: context.concept.tickerQuality,
      ai_panel_score: context.panel.score,
      ai_panel_disagreement: context.panel.disagreement,
      meme_intensity: context.concept.memeIntensity,
      cultural_relevance: context.concept.culturalRelevance,
      artwork_quality: context.concept.artworkQuality,

      launch_hour_utc: at.getUTCHours(),
      launch_day_of_week: at.getUTCDay(),
      market_launch_rate: logScale01(context.market.launchesPerHour, 400),
      market_graduation_rate: context.market.graduationRate,
      market_sol_momentum: context.market.solMomentum,
      market_regime: context.market.regime,

      category: context.trend.category,
      primary_source: context.trend.sources[0] ?? 'manual',
      concept_archetype: context.concept.archetype,
    });
  }

  /** Predict and persist. The stored features are the audit record. */
  async predict(
    conceptId: string,
    features: LaunchFeatures,
    economics: EconomicAssumptions = DEFAULT_ECONOMICS,
  ): Promise<{ predictionId: string; result: PredictionResult }> {
    const bundle = this.getBundle();
    // Seeding the Monte Carlo from the concept id makes the prediction
    // reproducible: re-running it later yields the same numbers, so a
    // discrepancy means the model changed, not that the dice fell differently.
    const result = predictLaunch(bundle, features, economics, `pred:${conceptId}`);

    const predictionId = newId('prd', this.now());
    this.db.$raw
      .prepare(
        `INSERT INTO predictions
           (id, concept_id, model_version, features, p_first_buy, p_ten_holders, p_hundred_holders, p_graduation,
            expected_volume_1h_sol, expected_volume_24h_sol, expected_volume_7d_sol, expected_creator_fees_sol,
            creator_fees_p10_sol, creator_fees_p90_sol, creator_fees_median_sol, expected_lifespan_hours,
            expected_value_sol, probability_profitable, tail_concentration, confidence, drivers, economics, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        predictionId,
        conceptId,
        bundle.version,
        JSON.stringify(features),
        result.probabilities.first_buy,
        result.probabilities.ten_holders,
        result.probabilities.hundred_holders,
        result.probabilities.graduation,
        result.volume1hMedianSol,
        result.volume24hMedianSol,
        result.volume7dMedianSol,
        result.creatorFeesSol.mean,
        result.creatorFeesSol.p10,
        result.creatorFeesSol.p90,
        result.creatorFeesSol.median,
        result.lifespanHoursMedian,
        result.expectedValueSol,
        result.probabilityProfitable,
        result.tailConcentration,
        result.confidence,
        JSON.stringify(result.drivers),
        JSON.stringify(economics),
        this.now(),
      );

    return { predictionId, result };
  }

  async getPrediction(conceptId: string): Promise<Record<string, unknown> | null> {
    const row = this.db.$raw
      .prepare('SELECT * FROM predictions WHERE concept_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(conceptId) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  async listModelVersions(): Promise<Array<Record<string, unknown>>> {
    return this.db.$raw
      .prepare('SELECT id, version, kind, trained_on, metrics, notes, active, created_at FROM model_versions ORDER BY created_at DESC LIMIT 50')
      .all() as Array<Record<string, unknown>>;
  }

}

/**
 * Turn a stored prediction row into the sentences a person actually asks for:
 * what made this look good, how large the payoff might be, and how much of that
 * is measurement rather than prior.
 */
export function explainPrediction(prediction: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const p = (key: string): number => {
    const n = Number(prediction[key]);
    return Number.isFinite(n) ? n : 0;
  };
  lines.push(
    `Modelled ${(p('p_first_buy') * 100).toFixed(0)}% chance of any organic buyer, ${(p('p_ten_holders') * 100).toFixed(0)}% of reaching ten holders, and ${(p('p_graduation') * 100).toFixed(1)}% of graduating.`,
  );
  lines.push(
    `Expected creator fees ${p('expected_creator_fees_sol').toFixed(4)} SOL, with a 10th-to-90th percentile range of ${p('creator_fees_p10_sol').toFixed(4)} to ${p('creator_fees_p90_sol').toFixed(4)} SOL. The median outcome is ${p('creator_fees_median_sol').toFixed(4)} SOL.`,
  );
  lines.push(
    `Net expected value ${p('expected_value_sol') >= 0 ? '+' : ''}${p('expected_value_sol').toFixed(4)} SOL after costs; ${(p('probability_profitable') * 100).toFixed(0)}% chance of being profitable at all.`,
  );
  if (p('tail_concentration') > 0.4) {
    lines.push(
      `${(p('tail_concentration') * 100).toFixed(0)}% of the expected value comes from the top 1% of simulated outcomes, so this is a low-probability, high-payoff candidate rather than a reliable earner.`,
    );
  }
  // The decomposition is of the ten-holders head; naming the top few features
  // is more use to an operator than the coefficient table behind them.
  const drivers = parseJson<Array<{ feature?: unknown; contribution?: unknown }>>(
    prediction.drivers as string | null,
    [],
  ).filter((d): d is { feature: string; contribution: number } => {
    return typeof d?.feature === 'string' && Number.isFinite(Number(d?.contribution));
  });
  const positive = drivers.filter((d) => d.contribution > 0).slice(0, 3);
  const negative = drivers.filter((d) => d.contribution < 0).slice(0, 3);
  if (positive.length) {
    lines.push(`Strongest positive signals: ${positive.map((d) => humaniseFeature(d.feature)).join(', ')}.`);
  }
  if (negative.length) {
    lines.push(`Strongest negative signals: ${negative.map((d) => humaniseFeature(d.feature)).join(', ')}.`);
  }

  const confidence = p('confidence');
  lines.push(
    confidence < 0.5
      ? `Model confidence is ${(confidence * 100).toFixed(0)}%, which is low: the model has seen too few real outcomes for these numbers to be measurements rather than informed priors.`
      : `Model confidence ${(confidence * 100).toFixed(0)}% (version ${String(prediction.model_version)}).`,
  );
  return lines;
}

const FEATURE_LABELS: Record<string, string> = {
  trend_velocity: 'trend growth rate',
  trend_acceleration: 'trend acceleration',
  trend_consistency: 'signal consistency',
  trend_source_breadth: 'cross-platform confirmation',
  trend_audience: 'audience size',
  trend_novelty: 'trend novelty',
  trend_age_hours: 'trend age',
  trend_expected_remaining_hours: 'remaining attention window',
  saturation: 'on-chain saturation',
  competing_recent_count: 'recent competitor count',
  competing_quality: 'competitor strength',
  originality: 'concept originality',
  name_quality: 'name quality',
  ticker_quality: 'ticker quality',
  ai_panel_score: 'evaluation panel score',
  ai_panel_disagreement: 'panel disagreement',
  meme_intensity: 'meme intensity',
  cultural_relevance: 'cultural fit',
  artwork_quality: 'artwork quality',
  market_launch_rate: 'market launch rate',
  market_regime: 'market risk appetite',
  x_velocity_x_unsaturated: 'fast growth in an unsaturated space',
  x_velocity_x_originality: 'fast growth with an original concept',
  x_early_x_breadth: 'early and broadly confirmed',
};

export function humaniseFeature(name: string): string {
  if (FEATURE_LABELS[name]) return FEATURE_LABELS[name];
  if (name.startsWith('category#')) return 'category';
  if (name.startsWith('primary_source#')) return 'trend source';
  if (name.startsWith('concept_archetype#')) return 'concept archetype';
  return name.replace(/_/g, ' ');
}
