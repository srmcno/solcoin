import { z } from 'zod';

/**
 * The canonical feature vector.
 *
 * Every prediction the platform makes is a pure function of this object plus a
 * versioned model. Persisting it verbatim next to each prediction is what makes
 * the learning loop and after-the-fact model evaluation honest: we can always
 * re-score an old decision with a new model, and vice versa.
 *
 * Feature names are stable API. Add new ones; never repurpose an old one.
 */
export const LaunchFeatures = z.object({
  // --- Trend kinetics -------------------------------------------------------
  /** log1p-scaled current interest level, normalised across the source. */
  trend_level: z.number(),
  /** Fractional growth per hour (slope of log interest). */
  trend_velocity: z.number(),
  /** Change in velocity per hour². */
  trend_acceleration: z.number(),
  /** 0..1 how clean/monotone the growth is. */
  trend_consistency: z.number(),
  /** Hours since the trend was first observed. */
  trend_age_hours: z.number(),
  /** Estimated hours of attention remaining. */
  trend_expected_remaining_hours: z.number(),
  /** Count of independent sources confirming, 0..1 normalised. */
  trend_source_breadth: z.number(),
  /** 0..1 estimated audience size (log-scaled). */
  trend_audience: z.number(),
  /** 0..1 how novel the trend is versus everything seen before. */
  trend_novelty: z.number(),

  // --- Competitive landscape ------------------------------------------------
  /** 0..1 how crowded this idea already is on-chain. */
  saturation: z.number(),
  /** Number of similar tokens launched in the last 24h (raw). */
  competing_recent_count: z.number(),
  /** Best competitor's market cap in USD (log-scaled 0..1). */
  competing_best_marketcap: z.number(),
  /** 0..1 how good the existing competition is. */
  competing_quality: z.number(),

  // --- Concept quality ------------------------------------------------------
  /** 0..1 originality versus the historical concept corpus. */
  originality: z.number(),
  /** 0..1 name memorability/pronounceability heuristic. */
  name_quality: z.number(),
  /** Ticker length in characters. */
  ticker_length: z.number(),
  /** 0..1 whether the ticker is a clean, unique word. */
  ticker_quality: z.number(),
  /** 0..1 ensemble AI panel score. */
  ai_panel_score: z.number(),
  /** 0..1 dispersion of AI panel opinions (high = disagreement). */
  ai_panel_disagreement: z.number(),
  /** 0..1 humour/emotional intensity rating. */
  meme_intensity: z.number(),
  /** 0..1 cultural relevance rating. */
  cultural_relevance: z.number(),
  /** 0..1 visual identity quality. */
  artwork_quality: z.number(),

  // --- Timing / market regime ----------------------------------------------
  /** Hour of day in UTC, 0..23. */
  launch_hour_utc: z.number(),
  /** Day of week, 0=Sunday. */
  launch_day_of_week: z.number(),
  /** Pump.fun launches per hour at decision time (log-scaled 0..1). */
  market_launch_rate: z.number(),
  /** Recent graduation rate across the whole market, 0..1. */
  market_graduation_rate: z.number(),
  /** 0..1 SOL price momentum over 24h, centred at 0.5. */
  market_sol_momentum: z.number(),
  /** 0..1 breadth of market risk appetite. */
  market_regime: z.number(),

  // --- Category one-hots are handled via categorical features ---------------
  category: z.string(),
  primary_source: z.string(),
  concept_archetype: z.string(),
});
export type LaunchFeatures = z.infer<typeof LaunchFeatures>;

export const NUMERIC_FEATURE_KEYS = [
  'trend_level',
  'trend_velocity',
  'trend_acceleration',
  'trend_consistency',
  'trend_age_hours',
  'trend_expected_remaining_hours',
  'trend_source_breadth',
  'trend_audience',
  'trend_novelty',
  'saturation',
  'competing_recent_count',
  'competing_best_marketcap',
  'competing_quality',
  'originality',
  'name_quality',
  'ticker_length',
  'ticker_quality',
  'ai_panel_score',
  'ai_panel_disagreement',
  'meme_intensity',
  'cultural_relevance',
  'artwork_quality',
  'launch_hour_utc',
  'launch_day_of_week',
  'market_launch_rate',
  'market_graduation_rate',
  'market_sol_momentum',
  'market_regime',
] as const satisfies ReadonlyArray<keyof LaunchFeatures>;

export type NumericFeatureKey = (typeof NUMERIC_FEATURE_KEYS)[number];

export const CATEGORICAL_FEATURE_KEYS = ['category', 'primary_source', 'concept_archetype'] as const;
export type CategoricalFeatureKey = (typeof CATEGORICAL_FEATURE_KEYS)[number];

/**
 * Per-feature standardisation so that raw units (hours, counts) do not swamp
 * the model. These are fixed reference scales rather than dataset statistics,
 * which keeps feature encoding stable across model versions and deployments.
 */
export const FEATURE_SCALES: Record<NumericFeatureKey, { centre: number; scale: number }> = {
  trend_level: { centre: 0.5, scale: 0.3 },
  trend_velocity: { centre: 0.08, scale: 0.12 },
  trend_acceleration: { centre: 0, scale: 0.05 },
  trend_consistency: { centre: 0.5, scale: 0.25 },
  trend_age_hours: { centre: 36, scale: 48 },
  trend_expected_remaining_hours: { centre: 72, scale: 72 },
  trend_source_breadth: { centre: 0.35, scale: 0.25 },
  trend_audience: { centre: 0.5, scale: 0.25 },
  trend_novelty: { centre: 0.6, scale: 0.25 },
  saturation: { centre: 0.4, scale: 0.25 },
  competing_recent_count: { centre: 4, scale: 8 },
  competing_best_marketcap: { centre: 0.3, scale: 0.25 },
  competing_quality: { centre: 0.4, scale: 0.25 },
  originality: { centre: 0.7, scale: 0.2 },
  name_quality: { centre: 0.6, scale: 0.2 },
  ticker_length: { centre: 5, scale: 2 },
  ticker_quality: { centre: 0.6, scale: 0.2 },
  ai_panel_score: { centre: 0.6, scale: 0.2 },
  ai_panel_disagreement: { centre: 0.2, scale: 0.15 },
  meme_intensity: { centre: 0.55, scale: 0.2 },
  cultural_relevance: { centre: 0.6, scale: 0.2 },
  artwork_quality: { centre: 0.6, scale: 0.2 },
  launch_hour_utc: { centre: 12, scale: 7 },
  launch_day_of_week: { centre: 3, scale: 2 },
  market_launch_rate: { centre: 0.5, scale: 0.25 },
  market_graduation_rate: { centre: 0.012, scale: 0.02 },
  market_sol_momentum: { centre: 0.5, scale: 0.2 },
  market_regime: { centre: 0.5, scale: 0.25 },
};

/** Neutral features, used when a signal is unavailable rather than guessing. */
export function neutralFeatures(): LaunchFeatures {
  const out: Record<string, number | string> = {};
  for (const key of NUMERIC_FEATURE_KEYS) out[key] = FEATURE_SCALES[key].centre;
  out.category = 'other';
  out.primary_source = 'manual';
  out.concept_archetype = 'unknown';
  return LaunchFeatures.parse(out);
}

/**
 * Encode features into a design vector.
 *
 * Numeric features are standardised; categoricals are hashed into a small
 * fixed-width block so that new categories never change the vector length
 * (which would invalidate every stored model).
 */
export const CATEGORICAL_HASH_WIDTH = 12;

export function encodeFeatures(features: LaunchFeatures): { names: string[]; values: number[] } {
  const names: string[] = [];
  const values: number[] = [];

  for (const key of NUMERIC_FEATURE_KEYS) {
    const { centre, scale } = FEATURE_SCALES[key];
    const raw = features[key];
    const z = scale > 0 ? (raw - centre) / scale : 0;
    names.push(key);
    // Clip to keep a single outlier from dominating an online gradient step.
    values.push(Math.max(-6, Math.min(6, z)));
  }

  // A handful of deliberately chosen interactions that encode domain knowledge:
  // a fast trend that is already saturated is worth much less than either
  // feature alone suggests.
  const vel = values[NUMERIC_FEATURE_KEYS.indexOf('trend_velocity')] ?? 0;
  const sat = values[NUMERIC_FEATURE_KEYS.indexOf('saturation')] ?? 0;
  const orig = values[NUMERIC_FEATURE_KEYS.indexOf('originality')] ?? 0;
  const age = values[NUMERIC_FEATURE_KEYS.indexOf('trend_age_hours')] ?? 0;
  const breadth = values[NUMERIC_FEATURE_KEYS.indexOf('trend_source_breadth')] ?? 0;
  const interactions: Array<[string, number]> = [
    ['x_velocity_x_unsaturated', vel * -sat],
    ['x_velocity_x_originality', vel * orig],
    ['x_early_x_breadth', -age * breadth],
    ['x_velocity_sq', Math.max(-6, Math.min(6, vel * vel))],
  ];
  for (const [name, value] of interactions) {
    names.push(name);
    values.push(Math.max(-6, Math.min(6, value)));
  }

  for (const key of CATEGORICAL_FEATURE_KEYS) {
    const raw = String(features[key] ?? '');
    for (let i = 0; i < CATEGORICAL_HASH_WIDTH; i++) {
      names.push(`${key}#${i}`);
      values.push(0);
    }
    const base = names.length - CATEGORICAL_HASH_WIDTH;
    let h = 2166136261 >>> 0;
    const token = `${key}=${raw}`;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    values[base + (h % CATEGORICAL_HASH_WIDTH)] = 1;
  }

  return { names, values };
}

export function featureVectorLength(): number {
  return NUMERIC_FEATURE_KEYS.length + 4 + CATEGORICAL_FEATURE_KEYS.length * CATEGORICAL_HASH_WIDTH;
}
