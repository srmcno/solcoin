import { clamp, mean, quantile } from '../math/stats.js';
import { createRng, type Rng } from '../math/random.js';
import { encodeFeatures, type LaunchFeatures } from '../domain/features.js';
import {
  createLinearModel,
  createLogNormalModel,
  explain,
  logNormalMedian,
  logNormalMu,
  predictProbability,
  shrinkPrediction,
  type LinearModelState,
  type LogNormalModelState,
} from './linear.js';
import {
  BASE_RATES,
  PRIOR_BIASES,
  PRIOR_FIRST_BUY,
  PRIOR_GRADUATION,
  PRIOR_HUNDRED_HOLDERS,
  PRIOR_LIFESPAN_BIAS,
  PRIOR_LIFESPAN_LOG,
  PRIOR_LIFESPAN_SIGMA,
  PRIOR_TEN_HOLDERS,
  PRIOR_VOLUME_BIAS_24H,
  PRIOR_VOLUME_LOG,
  PRIOR_VOLUME_SIGMA,
} from './priors.js';

export const PREDICTION_HEADS = [
  'first_buy',
  'ten_holders',
  'hundred_holders',
  'graduation',
] as const;
export type PredictionHead = (typeof PREDICTION_HEADS)[number];

export interface SuccessModelBundle {
  version: string;
  createdAt: number;
  classification: Record<PredictionHead, LinearModelState>;
  volume24h: LogNormalModelState;
  lifespanHours: LogNormalModelState;
  /** Observed base rates, updated as outcomes accumulate. */
  baseRates: Record<PredictionHead, number>;
  /** Total labelled outcomes the bundle has seen. */
  trainedOn: number;
}

export function createModelBundle(featureNames: readonly string[], version = 'v1-priors'): SuccessModelBundle {
  return {
    version,
    createdAt: 0,
    classification: {
      first_buy: createLinearModel(featureNames, PRIOR_FIRST_BUY, { bias: PRIOR_BIASES.firstBuy }),
      ten_holders: createLinearModel(featureNames, PRIOR_TEN_HOLDERS, { bias: PRIOR_BIASES.tenHolders }),
      hundred_holders: createLinearModel(featureNames, PRIOR_HUNDRED_HOLDERS, {
        bias: PRIOR_BIASES.hundredHolders,
      }),
      graduation: createLinearModel(featureNames, PRIOR_GRADUATION, { bias: PRIOR_BIASES.graduation }),
    },
    volume24h: createLogNormalModel(featureNames, PRIOR_VOLUME_LOG, {
      bias: PRIOR_VOLUME_BIAS_24H,
      sigma: PRIOR_VOLUME_SIGMA,
    }),
    lifespanHours: createLogNormalModel(featureNames, PRIOR_LIFESPAN_LOG, {
      bias: PRIOR_LIFESPAN_BIAS,
      sigma: PRIOR_LIFESPAN_SIGMA,
    }),
    baseRates: {
      first_buy: BASE_RATES.firstBuy,
      ten_holders: BASE_RATES.tenHolders,
      hundred_holders: BASE_RATES.hundredHolders,
      graduation: BASE_RATES.graduation,
    },
    trainedOn: 0,
  };
}

export interface EconomicAssumptions {
  /** Creator fee rate on bonding-curve trades, as a fraction of trade volume. */
  creatorFeeRateCurve: number;
  /** Creator fee rate on post-graduation AMM trades. */
  creatorFeeRateAmm: number;
  /** All-in SOL cost of one launch (rent + fees + optional dev buy). */
  launchCostSol: number;
  /** Off-chain cost of producing one candidate, in SOL-equivalent. */
  candidateCostSol: number;
  /** SOL cost of one fee-collection transaction. */
  feeCollectionCostSol: number;
  /** Fraction of 24h volume that a *successful* token repeats over its life. */
  lifetimeVolumeMultiplier: number;
  /** Current SOL price in USD, for reporting only. */
  solPriceUsd: number;
}

export const DEFAULT_ECONOMICS: EconomicAssumptions = {
  // Verified on-chain 2026-08-29: the bonding-curve creator share is 30 bps of
  // trade volume (out of 125 bps total).
  creatorFeeRateCurve: 0.003,
  // Canonical PumpSwap pools pay a market-cap-indexed creator share, from 95 bps
  // just after graduation down to 5 bps for very large caps. A freshly graduated
  // coin sits near the top of that curve, so this is the blended rate a typical
  // graduate earns across its active life.
  creatorFeeRateAmm: 0.006,
  launchCostSol: 0.025,
  candidateCostSol: 0.004,
  feeCollectionCostSol: 0.00002,
  lifetimeVolumeMultiplier: 3.2,
  solPriceUsd: 0,
};

export interface PredictionResult {
  modelVersion: string;
  probabilities: Record<PredictionHead, number>;
  /** Median 24h organic volume in SOL. */
  volume24hMedianSol: number;
  volume1hMedianSol: number;
  volume7dMedianSol: number;
  lifespanHoursMedian: number;
  /** Monte Carlo distribution of creator fees in SOL. */
  creatorFeesSol: {
    mean: number;
    median: number;
    p10: number;
    p90: number;
    p99: number;
  };
  /** Expected value in SOL, net of all modelled costs. */
  expectedValueSol: number;
  /** Probability the launch is net-positive after costs. */
  probabilityProfitable: number;
  /** Fraction of expected value contributed by the top 1% of simulated outcomes. */
  tailConcentration: number;
  /** Confidence in the prediction itself, 0..1, based on evidence volume. */
  confidence: number;
  /** Top feature contributions for the headline head, for the transparency UI. */
  drivers: Array<{ feature: string; value: number; weight: number; contribution: number }>;
}

const MONTE_CARLO_DRAWS = 4000;

/**
 * Predict the full outcome distribution for a candidate.
 *
 * Point estimates are useless here: token outcomes are extremely heavy-tailed,
 * so expected value is computed by simulating the joint outcome (does it get an
 * organic buyer at all → how much volume → how long does it live) rather than
 * multiplying means together.
 */
export function predictLaunch(
  bundle: SuccessModelBundle,
  features: LaunchFeatures,
  economics: EconomicAssumptions = DEFAULT_ECONOMICS,
  seed: string | number = 'prediction',
): PredictionResult {
  const { values: x } = encodeFeatures(features);
  const rng = createRng(seed);

  const probabilities = {} as Record<PredictionHead, number>;
  for (const head of PREDICTION_HEADS) {
    const model = bundle.classification[head];
    const raw = predictProbability(model, x);
    probabilities[head] = shrinkPrediction(raw, bundle.trainedOn, bundle.baseRates[head]);
  }
  // Enforce monotonicity: reaching 100 holders implies reaching 10, etc.
  probabilities.ten_holders = Math.min(probabilities.ten_holders, probabilities.first_buy);
  probabilities.hundred_holders = Math.min(probabilities.hundred_holders, probabilities.ten_holders);
  probabilities.graduation = Math.min(probabilities.graduation, probabilities.hundred_holders);

  const volume24hMedianSol = logNormalMedian(bundle.volume24h, x);
  const lifespanHoursMedian = clamp(logNormalMedian(bundle.lifespanHours, x), 0.5, 2160);

  const sim = simulateCreatorFees(bundle, x, probabilities, economics, rng);

  const totalCost = economics.launchCostSol + economics.candidateCostSol;
  const expectedValueSol = sim.mean - totalCost;

  const confidence = clamp(
    0.25 + 0.5 * (bundle.trainedOn / (bundle.trainedOn + 30)) + 0.25 * clamp(features.trend_source_breadth, 0, 1),
    0.1,
    0.95,
  );

  return {
    modelVersion: bundle.version,
    probabilities,
    volume24hMedianSol,
    // Volume arrives front-loaded: roughly a fifth of day-one turnover lands in
    // the first hour for tokens that get any attention at all.
    volume1hMedianSol: volume24hMedianSol * 0.22,
    volume7dMedianSol: volume24hMedianSol * economics.lifetimeVolumeMultiplier,
    lifespanHoursMedian,
    creatorFeesSol: {
      mean: sim.mean,
      median: sim.median,
      p10: sim.p10,
      p90: sim.p90,
      p99: sim.p99,
    },
    expectedValueSol,
    probabilityProfitable: sim.probabilityProfitable,
    tailConcentration: sim.tailConcentration,
    confidence,
    drivers: explain(bundle.classification.ten_holders, x, 8),
  };
}

interface SimulationSummary {
  mean: number;
  median: number;
  p10: number;
  p90: number;
  p99: number;
  probabilityProfitable: number;
  tailConcentration: number;
}

/**
 * Monte Carlo over the joint outcome of a launch.
 *
 * The structure mirrors how these tokens actually behave: most get nothing, a
 * minority get a burst of curve trading, and a small fraction graduate to an
 * AMM pool where fee accrual continues for as long as the token stays alive.
 */
function simulateCreatorFees(
  bundle: SuccessModelBundle,
  x: readonly number[],
  probabilities: Record<PredictionHead, number>,
  economics: EconomicAssumptions,
  rng: Rng,
): SimulationSummary {
  const muVol = logNormalMu(bundle.volume24h, x);
  const sigmaVol = bundle.volume24h.sigma;
  const muLife = logNormalMu(bundle.lifespanHours, x);
  const sigmaLife = bundle.lifespanHours.sigma;
  const totalCost = economics.launchCostSol + economics.candidateCostSol;

  const draws: number[] = new Array(MONTE_CARLO_DRAWS);
  let profitable = 0;

  for (let i = 0; i < MONTE_CARLO_DRAWS; i++) {
    // Stage 1: does anybody trade it at all?
    if (rng.next() > probabilities.first_buy) {
      draws[i] = 0;
      continue;
    }
    // Stage 2: 24h organic volume, conditional on getting a first buyer.
    // Conditioning shifts the distribution up: the unconditional model already
    // includes the mass at zero, so we re-centre by the survival probability.
    const conditioningShift = -Math.log(Math.max(0.05, probabilities.first_buy));
    const vol24 = Math.max(0, Math.expm1(muVol + conditioningShift + sigmaVol * rng.normal()));

    // Stage 3: lifespan drives how much of the tail volume actually materialises.
    const lifeHours = clamp(Math.expm1(muLife + sigmaLife * rng.normal()), 0.5, 4380);
    // Volume decays roughly geometrically after day one.
    const decayDays = clamp(lifeHours / 24, 0.05, 90);
    const tailVolume = vol24 * clamp(economics.lifetimeVolumeMultiplier * (1 - Math.exp(-decayDays / 2.5)), 0, 40);

    const curveVolume = vol24 + tailVolume;

    // Stage 4: graduation unlocks the AMM fee stream on continuing volume.
    const graduated = rng.next() < probabilities.graduation / Math.max(probabilities.first_buy, 1e-6);
    const ammVolume = graduated ? curveVolume * (1.5 + 4 * rng.next()) : 0;

    const fees =
      curveVolume * economics.creatorFeeRateCurve + ammVolume * economics.creatorFeeRateAmm;

    // Fee collection is only worth doing when it clears its own transaction cost;
    // model a realistic number of claims over the token's life.
    const claims = fees > 0 ? Math.min(12, Math.ceil(decayDays / 3)) : 0;
    const net = Math.max(0, fees - claims * economics.feeCollectionCostSol);

    draws[i] = net;
    if (net > totalCost) profitable++;
  }

  const sorted = [...draws].sort((a, b) => a - b);
  const total = draws.reduce((a, b) => a + b, 0);
  const top1Count = Math.max(1, Math.floor(MONTE_CARLO_DRAWS * 0.01));
  const top1Sum = sorted.slice(-top1Count).reduce((a, b) => a + b, 0);

  return {
    mean: mean(draws),
    median: quantile(sorted, 0.5),
    p10: quantile(sorted, 0.1),
    p90: quantile(sorted, 0.9),
    p99: quantile(sorted, 0.99),
    probabilityProfitable: profitable / MONTE_CARLO_DRAWS,
    tailConcentration: total > 0 ? top1Sum / total : 0,
  };
}
