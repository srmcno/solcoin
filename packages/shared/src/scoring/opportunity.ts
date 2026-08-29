import { clamp, logScale01, logistic } from '../math/stats.js';
import type { TrendKinetics, TrendPhase } from '../math/timeseries.js';

/**
 * Opportunity scoring.
 *
 * The single question this answers: "is there a rising wave of attention here
 * that nobody has tokenised yet, and is there enough of it left to matter?"
 *
 * Every sub-score is normalised to 0..1 and combined through a weighted logit so
 * the weights are directly comparable, learnable, and explainable. Saturation
 * enters multiplicatively because a saturated opportunity is not merely worse,
 * it is close to worthless regardless of how good the other signals look.
 */

export interface OpportunityInputs {
  kinetics: TrendKinetics;
  phase: TrendPhase;
  /** Hours since first observation anywhere. */
  ageHours: number;
  /** Estimated hours of attention remaining. */
  remainingLifespanHours: number;
  /** Distinct source platforms carrying the trend. */
  sourceCount: number;
  /** Independence-weighted source diversity, 0..1. */
  sourceDiversity: number;
  /** Estimated reachable audience (raw people count). */
  audienceEstimate: number;
  /** 0..1 novelty versus historical trend corpus. */
  novelty: number;
  /** 0..1 on-chain saturation for this concept space. */
  saturation: number;
  /** 0..1 engagement intensity (comments/upvotes per view, normalised). */
  engagement: number;
  /** 0..1 how well this maps to a memetic token concept. */
  memeability: number;
}

export interface OpportunityWeights {
  velocity: number;
  acceleration: number;
  consistency: number;
  breadth: number;
  audience: number;
  novelty: number;
  engagement: number;
  memeability: number;
  earliness: number;
  runway: number;
  bias: number;
  /** Exponent on the (1 - saturation) multiplier. Higher = harsher. */
  saturationExponent: number;
}

export const DEFAULT_OPPORTUNITY_WEIGHTS: OpportunityWeights = {
  velocity: 1.35,
  acceleration: 0.7,
  consistency: 0.45,
  breadth: 0.95,
  audience: 0.8,
  novelty: 0.75,
  engagement: 0.5,
  memeability: 0.85,
  earliness: 0.9,
  runway: 0.6,
  bias: -2.6,
  saturationExponent: 1.6,
};

export interface OpportunityComponents {
  velocity: number;
  acceleration: number;
  consistency: number;
  breadth: number;
  audience: number;
  novelty: number;
  engagement: number;
  memeability: number;
  earliness: number;
  runway: number;
}

export interface OpportunityScore {
  /** 0..100 headline score. */
  score: number;
  /** Raw pre-saturation score, 0..100. */
  rawScore: number;
  /** Multiplier applied for saturation, 0..1. */
  saturationMultiplier: number;
  components: OpportunityComponents;
  /** Per-component contribution to the logit, for explanation. */
  contributions: Array<{ component: string; value: number; weight: number; contribution: number }>;
  phase: TrendPhase;
  /** Human-readable one-liners describing why this scored as it did. */
  rationale: string[];
}

export function computeOpportunityComponents(input: OpportunityInputs): OpportunityComponents {
  const k = input.kinetics;

  // Velocity: fractional growth per hour. 0.10/h (≈ +170%/day) is a strong wave.
  const velocity = clamp(logistic((k.relativeVelocity - 0.02) / 0.045), 0, 1);

  // Acceleration: still speeding up is worth a lot; decelerating is a warning.
  const acceleration = clamp(logistic(k.acceleration / 0.02), 0, 1);

  const consistency = clamp(k.consistency, 0, 1);

  // Breadth: cross-platform confirmation is the strongest anti-noise signal we
  // have. One platform can be a bot cluster; four platforms is a real trend.
  const breadth = clamp(0.6 * logScale01(input.sourceCount, 6) + 0.4 * input.sourceDiversity, 0, 1);

  const audience = logScale01(input.audienceEstimate, 5_000_000);

  const novelty = clamp(input.novelty, 0, 1);
  const engagement = clamp(input.engagement, 0, 1);
  const memeability = clamp(input.memeability, 0, 1);

  // Earliness: the whole thesis. Value decays fast with trend age.
  const earliness = clamp(Math.exp(-Math.max(0, input.ageHours) / 60), 0, 1);

  // Runway: how much attention is left to capture.
  const runway = clamp(logScale01(input.remainingLifespanHours, 240), 0, 1);

  return { velocity, acceleration, consistency, breadth, audience, novelty, engagement, memeability, earliness, runway };
}

export function scoreOpportunity(
  input: OpportunityInputs,
  weights: OpportunityWeights = DEFAULT_OPPORTUNITY_WEIGHTS,
): OpportunityScore {
  const components = computeOpportunityComponents(input);

  const entries: Array<[keyof OpportunityComponents, number]> = [
    ['velocity', weights.velocity],
    ['acceleration', weights.acceleration],
    ['consistency', weights.consistency],
    ['breadth', weights.breadth],
    ['audience', weights.audience],
    ['novelty', weights.novelty],
    ['engagement', weights.engagement],
    ['memeability', weights.memeability],
    ['earliness', weights.earliness],
    ['runway', weights.runway],
  ];

  let logit = weights.bias;
  const contributions = entries.map(([name, weight]) => {
    const value = components[name];
    const contribution = weight * value;
    logit += contribution;
    return { component: name, value, weight, contribution };
  });

  const rawScore = clamp(logistic(logit) * 100, 0, 100);
  const saturationMultiplier = clamp(
    Math.pow(1 - clamp(input.saturation, 0, 1), Math.max(0.1, weights.saturationExponent)),
    0,
    1,
  );
  const score = clamp(rawScore * saturationMultiplier, 0, 100);

  const rationale: string[] = [];
  const sortedContribs = [...contributions].sort((a, b) => b.contribution - a.contribution);
  const top = sortedContribs.slice(0, 3).filter((c) => c.contribution > 0.15);
  const bottom = sortedContribs.slice(-3).filter((c) => c.contribution < 0.12);
  if (top.length) rationale.push(`Driven by ${top.map((c) => describeComponent(c.component, c.value)).join(', ')}.`);
  if (bottom.length) rationale.push(`Held back by ${bottom.map((c) => describeComponent(c.component, c.value)).join(', ')}.`);
  if (input.saturation > 0.5) {
    rationale.push(
      `On-chain saturation of ${(input.saturation * 100).toFixed(0)}% cuts the score by ${(
        (1 - saturationMultiplier) * 100
      ).toFixed(0)}%.`,
    );
  }
  rationale.push(`Trend phase: ${input.phase}, age ${input.ageHours.toFixed(1)}h, est. ${input.remainingLifespanHours.toFixed(0)}h remaining.`);

  return { score, rawScore, saturationMultiplier, components, contributions, phase: input.phase, rationale };
}

function describeComponent(name: string, value: number): string {
  const pct = `${(value * 100).toFixed(0)}%`;
  switch (name) {
    case 'velocity':
      return `growth rate (${pct})`;
    case 'acceleration':
      return `acceleration (${pct})`;
    case 'consistency':
      return `signal consistency (${pct})`;
    case 'breadth':
      return `cross-platform confirmation (${pct})`;
    case 'audience':
      return `audience size (${pct})`;
    case 'novelty':
      return `novelty (${pct})`;
    case 'engagement':
      return `engagement intensity (${pct})`;
    case 'memeability':
      return `meme potential (${pct})`;
    case 'earliness':
      return `earliness (${pct})`;
    case 'runway':
      return `remaining runway (${pct})`;
    default:
      return `${name} (${pct})`;
  }
}
