/**
 * Encoded domain knowledge: the starting weights for every prediction head.
 *
 * These are deliberately conservative and are the *only* hand-tuned numbers in
 * the decision path. As real launches accumulate, the online updates move the
 * weights away from these priors; the priors remain as the L2 anchor so that
 * sparse evidence cannot produce wild coefficients.
 *
 * Feature names refer to the standardised design vector from `encodeFeatures`.
 */

export const PRIOR_FIRST_BUY: Record<string, number> = {
  trend_velocity: 0.45,
  trend_acceleration: 0.18,
  trend_source_breadth: 0.3,
  trend_audience: 0.35,
  trend_level: 0.2,
  trend_consistency: 0.12,
  saturation: -0.35,
  competing_recent_count: -0.12,
  originality: 0.15,
  name_quality: 0.22,
  ticker_quality: 0.15,
  ai_panel_score: 0.3,
  ai_panel_disagreement: -0.1,
  meme_intensity: 0.2,
  artwork_quality: 0.18,
  market_launch_rate: -0.15,
  x_velocity_x_unsaturated: 0.2,
  x_early_x_breadth: 0.1,
};

export const PRIOR_TEN_HOLDERS: Record<string, number> = {
  trend_velocity: 0.5,
  trend_acceleration: 0.22,
  trend_source_breadth: 0.4,
  trend_audience: 0.42,
  trend_novelty: 0.2,
  trend_consistency: 0.16,
  saturation: -0.5,
  competing_recent_count: -0.18,
  competing_quality: -0.2,
  originality: 0.25,
  name_quality: 0.28,
  ticker_quality: 0.2,
  ai_panel_score: 0.38,
  ai_panel_disagreement: -0.14,
  meme_intensity: 0.28,
  cultural_relevance: 0.24,
  artwork_quality: 0.24,
  trend_age_hours: -0.18,
  market_launch_rate: -0.2,
  market_regime: 0.18,
  x_velocity_x_unsaturated: 0.28,
  x_velocity_x_originality: 0.14,
  x_early_x_breadth: 0.16,
};

export const PRIOR_HUNDRED_HOLDERS: Record<string, number> = {
  trend_velocity: 0.55,
  trend_acceleration: 0.28,
  trend_source_breadth: 0.5,
  trend_audience: 0.5,
  trend_novelty: 0.26,
  trend_consistency: 0.2,
  saturation: -0.62,
  competing_recent_count: -0.22,
  competing_quality: -0.26,
  competing_best_marketcap: -0.12,
  originality: 0.3,
  name_quality: 0.32,
  ticker_quality: 0.24,
  ai_panel_score: 0.44,
  ai_panel_disagreement: -0.18,
  meme_intensity: 0.32,
  cultural_relevance: 0.3,
  artwork_quality: 0.28,
  trend_age_hours: -0.24,
  trend_expected_remaining_hours: 0.2,
  market_launch_rate: -0.24,
  market_regime: 0.24,
  market_graduation_rate: 0.16,
  x_velocity_x_unsaturated: 0.34,
  x_velocity_x_originality: 0.18,
  x_early_x_breadth: 0.2,
};

export const PRIOR_GRADUATION: Record<string, number> = {
  trend_velocity: 0.6,
  trend_acceleration: 0.3,
  trend_source_breadth: 0.55,
  trend_audience: 0.55,
  trend_novelty: 0.3,
  saturation: -0.7,
  competing_quality: -0.3,
  originality: 0.34,
  name_quality: 0.34,
  ai_panel_score: 0.5,
  ai_panel_disagreement: -0.2,
  meme_intensity: 0.34,
  cultural_relevance: 0.34,
  artwork_quality: 0.3,
  trend_age_hours: -0.28,
  trend_expected_remaining_hours: 0.24,
  market_regime: 0.3,
  market_graduation_rate: 0.24,
  x_velocity_x_unsaturated: 0.4,
  x_velocity_x_originality: 0.22,
};

export const PRIOR_VOLUME_LOG: Record<string, number> = {
  trend_velocity: 0.5,
  trend_acceleration: 0.24,
  trend_source_breadth: 0.42,
  trend_audience: 0.5,
  trend_novelty: 0.2,
  saturation: -0.55,
  competing_quality: -0.24,
  originality: 0.22,
  name_quality: 0.26,
  ai_panel_score: 0.4,
  meme_intensity: 0.3,
  cultural_relevance: 0.26,
  artwork_quality: 0.22,
  trend_age_hours: -0.22,
  market_regime: 0.24,
  market_launch_rate: -0.18,
  x_velocity_x_unsaturated: 0.3,
};

export const PRIOR_LIFESPAN_LOG: Record<string, number> = {
  trend_expected_remaining_hours: 0.5,
  trend_consistency: 0.25,
  trend_source_breadth: 0.3,
  trend_audience: 0.28,
  saturation: -0.3,
  originality: 0.2,
  ai_panel_score: 0.24,
  cultural_relevance: 0.3,
  trend_age_hours: -0.15,
};

/**
 * Base rates. These are intentionally pessimistic: the overwhelming majority of
 * permissionless token launches receive no organic attention at all, and any
 * system that starts from an optimistic prior will over-launch before it has
 * evidence. They are replaced by observed rates once enough launches exist.
 */
/**
 * Untrained base rates, used until the model has scored real outcomes.
 *
 * `graduation` is measured, not estimated: 0.198% pooled across 832,941
 * launches observed 2026-05-08 to 2026-06-10, Wilson 95% interval
 * 0.189-0.208%, from the survival analysis published as arXiv:2607.02823.
 * Its authors note that figure is a lower bound on the true 24-hour rate.
 *
 * It was 0.012 here — six times too high, and optimistic in the direction
 * that costs money. A graduation prior inflates every revenue projection the
 * platform makes, and it does so for exactly as long as the model has no real
 * outcomes to learn from, which is the whole first phase of operation.
 *
 * The tempting argument against using the market rate is that this platform
 * selects candidates through a quality gate, so its launches should graduate
 * more often than a random one. That may turn out to be true. Assuming it
 * before measuring it is assuming the conclusion: any lift from selection has
 * to be *learned* from scored outcomes, not written into the prior it will be
 * measured against.
 *
 * The other three rates are left as they were. There is no comparably rigorous
 * public figure for them, and replacing one sourced number while leaving
 * unsourced ones beside it is not an improvement worth pretending to.
 */
export const BASE_RATES = {
  firstBuy: 0.42,
  tenHolders: 0.16,
  hundredHolders: 0.035,
  graduation: 0.00198,
} as const;

/** Bias terms chosen so a perfectly average candidate predicts the base rate. */
export const PRIOR_BIASES = {
  firstBuy: Math.log(BASE_RATES.firstBuy / (1 - BASE_RATES.firstBuy)),
  tenHolders: Math.log(BASE_RATES.tenHolders / (1 - BASE_RATES.tenHolders)),
  hundredHolders: Math.log(BASE_RATES.hundredHolders / (1 - BASE_RATES.hundredHolders)),
  graduation: Math.log(BASE_RATES.graduation / (1 - BASE_RATES.graduation)),
} as const;

/**
 * Median 24h organic volume in SOL for a launch with entirely average features.
 * log1p(2.5) — i.e. a couple of SOL of turnover, which is what an unremarkable
 * launch actually sees.
 */
export const PRIOR_VOLUME_BIAS_24H = Math.log1p(2.5);
export const PRIOR_VOLUME_SIGMA = 2.3;

/** Median lifespan in hours for an average launch. */
export const PRIOR_LIFESPAN_BIAS = Math.log1p(30);
export const PRIOR_LIFESPAN_SIGMA = 1.3;
