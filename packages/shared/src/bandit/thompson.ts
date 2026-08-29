import { createRng, type Rng } from '../math/random.js';
import { betaPosterior, clamp } from '../math/stats.js';

/**
 * Contextual-free Thompson sampling over discrete strategy arms.
 *
 * Used for the exploration budget: rather than a fixed "10% of launches are
 * experimental", the platform samples from the posterior of each arm's success
 * rate and picks the sampled maximum. Arms that look bad get tried less often
 * but never fall to zero, which is exactly the exploration/exploitation
 * behaviour we want without hand-tuning a percentage.
 */
export interface BanditArm {
  key: string;
  label: string;
  successes: number;
  failures: number;
  /** Optional running mean reward for value-based (not just binary) arms. */
  rewardSum: number;
  rewardCount: number;
  /** Prior pseudo-counts. */
  priorAlpha: number;
  priorBeta: number;
  active: boolean;
}

export function createArm(key: string, label: string, priorAlpha = 1, priorBeta = 3): BanditArm {
  return {
    key,
    label,
    successes: 0,
    failures: 0,
    rewardSum: 0,
    rewardCount: 0,
    priorAlpha,
    priorBeta,
    active: true,
  };
}

export interface ArmSample {
  key: string;
  label: string;
  sampled: number;
  posteriorMean: number;
  lower: number;
  upper: number;
  n: number;
  meanReward: number;
}

export function sampleArms(arms: readonly BanditArm[], rng: Rng): ArmSample[] {
  return arms
    .filter((a) => a.active)
    .map((a) => {
      const alpha = a.priorAlpha + a.successes;
      const beta = a.priorBeta + a.failures;
      const post = betaPosterior(a.successes, a.successes + a.failures, a.priorAlpha, a.priorBeta);
      return {
        key: a.key,
        label: a.label,
        sampled: rng.beta(alpha, beta),
        posteriorMean: post.mean,
        lower: post.lower,
        upper: post.upper,
        n: a.successes + a.failures,
        meanReward: a.rewardCount > 0 ? a.rewardSum / a.rewardCount : 0,
      };
    })
    .sort((a, b) => b.sampled - a.sampled);
}

export function selectArm(arms: readonly BanditArm[], seed: string | number): ArmSample | undefined {
  const samples = sampleArms(arms, createRng(seed));
  return samples[0];
}

export function recordOutcome(arm: BanditArm, success: boolean, reward = 0): BanditArm {
  return {
    ...arm,
    successes: arm.successes + (success ? 1 : 0),
    failures: arm.failures + (success ? 0 : 1),
    rewardSum: arm.rewardSum + reward,
    rewardCount: arm.rewardCount + 1,
  };
}

/**
 * How much exploration is currently justified?
 *
 * Early on, almost everything is exploration because nothing is known. As
 * evidence accumulates the platform naturally exploits more, but never drops
 * below a floor so that regime changes can still be discovered.
 */
export function explorationRate(
  totalLaunches: number,
  options: { floor?: number; ceiling?: number; halfLife?: number } = {},
): number {
  const floor = options.floor ?? 0.1;
  const ceiling = options.ceiling ?? 0.6;
  const halfLife = options.halfLife ?? 40;
  const decayed = ceiling * (halfLife / (halfLife + Math.max(0, totalLaunches)));
  return clamp(Math.max(floor, decayed), 0, 1);
}

/**
 * Upper-confidence-bound value for ranking arms in the UI, so a human can see
 * "this looks best" versus "this is merely untested".
 */
export function ucb(arm: BanditArm, totalPulls: number, c = 1.4): number {
  const n = arm.successes + arm.failures;
  if (n === 0) return 1;
  const meanValue = arm.successes / n;
  return clamp(meanValue + c * Math.sqrt(Math.log(Math.max(2, totalPulls)) / n), 0, 2);
}
