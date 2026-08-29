import { clamp, logistic } from '../math/stats.js';

/**
 * Online logistic regression with L2 regularisation toward an informative prior.
 *
 * Design rationale: with a handful of launches, a gradient-boosted forest would
 * overfit catastrophically. A linear model with hand-set priors starts out as a
 * transparent heuristic and *becomes* a learned model as evidence accumulates,
 * with no cutover, no separate code path, and full explainability (every
 * prediction decomposes into per-feature contributions).
 */
export interface LinearModelState {
  /** Stable feature names matching the design vector. */
  featureNames: string[];
  /** Learned weights. */
  weights: number[];
  /** Prior weights we shrink toward — the encoded domain knowledge. */
  priorWeights: number[];
  bias: number;
  /** Regularisation strength toward priorWeights. */
  l2: number;
  /** AdaGrad accumulators for per-feature adaptive step sizes. */
  accum: number[];
  accumBias: number;
  learningRate: number;
  /** Number of gradient updates applied. */
  observations: number;
}

export function createLinearModel(
  featureNames: readonly string[],
  priorWeights: Readonly<Record<string, number>> = {},
  options: { bias?: number; l2?: number; learningRate?: number } = {},
): LinearModelState {
  const priors = featureNames.map((n) => priorWeights[n] ?? 0);
  return {
    featureNames: [...featureNames],
    weights: [...priors],
    priorWeights: priors,
    bias: options.bias ?? 0,
    l2: options.l2 ?? 0.15,
    accum: new Array(featureNames.length).fill(0),
    accumBias: 0,
    learningRate: options.learningRate ?? 0.08,
    observations: 0,
  };
}

export function linearScore(model: LinearModelState, x: readonly number[]): number {
  let z = model.bias;
  const n = Math.min(model.weights.length, x.length);
  for (let i = 0; i < n; i++) z += model.weights[i]! * (x[i] ?? 0);
  return z;
}

export function predictProbability(model: LinearModelState, x: readonly number[]): number {
  return logistic(linearScore(model, x));
}

/**
 * Per-feature contribution to the logit, for the decision-transparency UI.
 * Returns the largest-magnitude contributors first.
 */
export function explain(
  model: LinearModelState,
  x: readonly number[],
  topK = 8,
): Array<{ feature: string; value: number; weight: number; contribution: number }> {
  const rows = model.featureNames.map((feature, i) => {
    const value = x[i] ?? 0;
    const weight = model.weights[i] ?? 0;
    return { feature, value, weight, contribution: weight * value };
  });
  return rows
    .filter((r) => Math.abs(r.contribution) > 1e-6)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, topK);
}

/**
 * One AdaGrad step of regularised logistic regression.
 *
 * `weight` lets callers down-weight noisy or partially observed outcomes.
 * Returns a new state; the input is not mutated (so callers can snapshot and
 * evaluate before committing an update).
 */
export function updateLinearModel(
  model: LinearModelState,
  x: readonly number[],
  y: 0 | 1,
  sampleWeight = 1,
): LinearModelState {
  const p = predictProbability(model, x);
  const error = (p - y) * clamp(sampleWeight, 0, 10);
  const weights = [...model.weights];
  const accum = [...model.accum];
  const eps = 1e-8;

  for (let i = 0; i < weights.length; i++) {
    const xi = x[i] ?? 0;
    // Gradient of log-loss + L2 pulling toward the prior, not toward zero.
    const grad = error * xi + model.l2 * (weights[i]! - model.priorWeights[i]!);
    accum[i] = accum[i]! + grad * grad;
    weights[i] = weights[i]! - (model.learningRate / (Math.sqrt(accum[i]!) + eps)) * grad;
  }

  const gradBias = error;
  const accumBias = model.accumBias + gradBias * gradBias;
  const bias = model.bias - (model.learningRate / (Math.sqrt(accumBias) + eps)) * gradBias;

  return { ...model, weights, accum, bias, accumBias, observations: model.observations + 1 };
}

/** Batch fit by repeated passes — used for offline retraining and backtests. */
export function fitLinearModel(
  model: LinearModelState,
  samples: ReadonlyArray<{ x: readonly number[]; y: 0 | 1; weight?: number }>,
  epochs = 12,
): LinearModelState {
  let state = model;
  for (let e = 0; e < epochs; e++) {
    // Deterministic order: reproducibility matters more than shuffling noise here.
    for (const s of samples) state = updateLinearModel(state, s.x, s.y, s.weight ?? 1);
  }
  return state;
}

/**
 * Confidence shrinkage: with few observations, pull predictions toward the
 * prior-implied base rate so the platform is not falsely confident early on.
 */
export function shrinkPrediction(p: number, observations: number, baseRate: number, halfLife = 25): number {
  const trust = observations / (observations + halfLife);
  return clamp(trust * p + (1 - trust) * (0.5 * p + 0.5 * baseRate), 0.0001, 0.9999);
}

/**
 * Log-linear regression head for heavy-tailed magnitudes (volume, fees).
 *
 * Models log(1 + y) as a Gaussian, which makes the predictive distribution
 * log-normal — the right shape for outcomes where the top 5% carry most of
 * the revenue.
 */
export interface LogNormalModelState {
  featureNames: string[];
  weights: number[];
  priorWeights: number[];
  bias: number;
  /** Residual standard deviation in log space. */
  sigma: number;
  l2: number;
  learningRate: number;
  accum: number[];
  accumBias: number;
  observations: number;
  /** Running sum of squared residuals, for sigma re-estimation. */
  residualSumSq: number;
}

export function createLogNormalModel(
  featureNames: readonly string[],
  priorWeights: Readonly<Record<string, number>> = {},
  options: { bias?: number; sigma?: number; l2?: number; learningRate?: number } = {},
): LogNormalModelState {
  const priors = featureNames.map((n) => priorWeights[n] ?? 0);
  return {
    featureNames: [...featureNames],
    weights: [...priors],
    priorWeights: priors,
    bias: options.bias ?? 0,
    sigma: options.sigma ?? 1.8,
    l2: options.l2 ?? 0.15,
    learningRate: options.learningRate ?? 0.06,
    accum: new Array(featureNames.length).fill(0),
    accumBias: 0,
    observations: 0,
    residualSumSq: 0,
  };
}

/** Predicted mean of log(1+y). */
export function logNormalMu(model: LogNormalModelState, x: readonly number[]): number {
  let z = model.bias;
  const n = Math.min(model.weights.length, x.length);
  for (let i = 0; i < n; i++) z += model.weights[i]! * (x[i] ?? 0);
  return z;
}

/** Median prediction — the honest central estimate for a skewed distribution. */
export function logNormalMedian(model: LogNormalModelState, x: readonly number[]): number {
  return Math.max(0, Math.expm1(logNormalMu(model, x)));
}

/** Mean of the log-normal, which is far above the median for large sigma. */
export function logNormalMean(model: LogNormalModelState, x: readonly number[]): number {
  const mu = logNormalMu(model, x);
  return Math.max(0, Math.expm1(mu + (model.sigma * model.sigma) / 2));
}

export function logNormalQuantile(model: LogNormalModelState, x: readonly number[], q: number): number {
  // Inverse normal CDF (Acklam's rational approximation).
  const p = clamp(q, 1e-6, 1 - 1e-6);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  let z: number;
  if (p < pLow) {
    const qq = Math.sqrt(-2 * Math.log(p));
    z = (((((c[0]! * qq + c[1]!) * qq + c[2]!) * qq + c[3]!) * qq + c[4]!) * qq + c[5]!) /
      ((((d[0]! * qq + d[1]!) * qq + d[2]!) * qq + d[3]!) * qq + 1);
  } else if (p <= 1 - pLow) {
    const qq = p - 0.5;
    const r = qq * qq;
    z = (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * qq /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  } else {
    const qq = Math.sqrt(-2 * Math.log(1 - p));
    z = -(((((c[0]! * qq + c[1]!) * qq + c[2]!) * qq + c[3]!) * qq + c[4]!) * qq + c[5]!) /
      ((((d[0]! * qq + d[1]!) * qq + d[2]!) * qq + d[3]!) * qq + 1);
  }
  return Math.max(0, Math.expm1(logNormalMu(model, x) + model.sigma * z));
}

export function updateLogNormalModel(
  model: LogNormalModelState,
  x: readonly number[],
  y: number,
  sampleWeight = 1,
): LogNormalModelState {
  const target = Math.log1p(Math.max(0, y));
  const mu = logNormalMu(model, x);
  const residual = mu - target;
  const error = residual * clamp(sampleWeight, 0, 10);
  const weights = [...model.weights];
  const accum = [...model.accum];
  const eps = 1e-8;
  for (let i = 0; i < weights.length; i++) {
    const xi = x[i] ?? 0;
    const grad = error * xi + model.l2 * (weights[i]! - model.priorWeights[i]!);
    accum[i] = accum[i]! + grad * grad;
    weights[i] = weights[i]! - (model.learningRate / (Math.sqrt(accum[i]!) + eps)) * grad;
  }
  const accumBias = model.accumBias + error * error;
  const bias = model.bias - (model.learningRate / (Math.sqrt(accumBias) + eps)) * error;
  const observations = model.observations + 1;
  const residualSumSq = model.residualSumSq + residual * residual;
  // Re-estimate sigma once there is enough evidence; keep the prior early on.
  const sigma = observations >= 8 ? clamp(Math.sqrt(residualSumSq / observations), 0.4, 4) : model.sigma;
  return { ...model, weights, accum, bias, accumBias, observations, residualSumSq, sigma };
}
