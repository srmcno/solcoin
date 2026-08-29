import {
  createRng,
  explorationRate,
  hashSeed,
  sampleArms,
  type BanditArm,
  type PredictionResult,
  type RejectionReason,
} from '@solcoin/shared';
import { componentLogger } from '../core/logger.js';
import type { Db } from '../db/client.js';
import type { SettingsService } from './settings.service.js';
import type { ScoredTrend } from './trend.service.js';

/**
 * The quality gate.
 *
 * This is the component that makes the platform selective rather than prolific.
 * Its most important property is that **launching zero tokens today is a normal,
 * correct outcome.** Nothing here tries to fill a quota; the gate either finds a
 * candidate that clears every threshold or it does not.
 *
 * Two paths through the gate:
 *  - the **exploit** path, with the operator's full thresholds; and
 *  - the **explore** path, with looser (but still real) thresholds, used for a
 *    fraction of launches so the platform keeps learning about regions of the
 *    space its current model is pessimistic about.
 *
 * The exploration fraction is not a hardcoded percentage. It decays as evidence
 * accumulates — when the model has seen almost nothing, almost everything is
 * exploration, because a confident rejection from an uninformed model is worth
 * very little.
 */

export interface GateInput {
  conceptId: string;
  trend: ScoredTrend;
  concept: {
    originalityScore: number;
    saturationScore: number;
    hardCollision: boolean;
    riskFlags: Array<{ flag: string; severity: string; label: string }>;
    status: string;
  };
  prediction: PredictionResult;
  /** Total launches observed, used to size the exploration budget. */
  totalLaunches: number;
}

export interface GateDecision {
  passed: boolean;
  /** True when the candidate passed via the exploration budget. */
  isExploration: boolean;
  explorationArm?: string;
  reason?: RejectionReason;
  detail?: string;
  /** Every threshold evaluated, so the UI can show exactly what happened. */
  checks: Array<{
    name: string;
    passed: boolean;
    value: number | string;
    threshold: number | string;
    comparison: string;
    detail?: string;
  }>;
  /** Rank score used to order candidates that all passed. */
  rankScore: number;
  summary: string;
}

export class QualityGateService {
  private readonly log = componentLogger('quality-gate');

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly now: () => number = Date.now,
  ) {}

  evaluate(input: GateInput): GateDecision {
    const config = this.settings.get();
    const gate = config.qualityGate;
    const exploration = config.exploration;

    const checks: GateDecision['checks'] = [];
    const hardFailures: Array<{ reason: RejectionReason; detail: string }> = [];

    // --- Hard blocks. These are never relaxed, not even for exploration. -----

    const blockingFlags = input.concept.riskFlags.filter((f) => f.severity === 'block');
    checks.push({
      name: 'Safety screening',
      passed: blockingFlags.length === 0,
      value: blockingFlags.length,
      threshold: 0,
      comparison: 'must be',
      detail: blockingFlags.map((f) => f.label).join('; ') || 'No blocking flags.',
    });
    if (blockingFlags.length > 0) {
      hardFailures.push({ reason: 'safety_block', detail: blockingFlags.map((f) => f.label).join('; ') });
    }

    if (gate.blockOnHardCollision) {
      checks.push({
        name: 'Name/ticker collision',
        passed: !input.concept.hardCollision,
        value: input.concept.hardCollision ? 'collision' : 'clear',
        threshold: 'clear',
        comparison: 'must be',
      });
      if (input.concept.hardCollision) {
        hardFailures.push({
          reason: 'duplicate_concept',
          detail: 'An existing token is close enough in name or ticker that traders would confuse the two.',
        });
      }
    }

    checks.push({
      name: 'Trend freshness',
      passed: input.trend.ageHours <= gate.maxTrendAgeHours,
      value: Number(input.trend.ageHours.toFixed(1)),
      threshold: gate.maxTrendAgeHours,
      comparison: 'at most',
      detail: `hours since the trend was first observed`,
    });
    if (input.trend.ageHours > gate.maxTrendAgeHours) {
      hardFailures.push({
        reason: 'trend_expired',
        detail: `The trend is ${input.trend.ageHours.toFixed(1)}h old, beyond the ${gate.maxTrendAgeHours}h window where an early launch still has an advantage.`,
      });
    }

    if (hardFailures.length > 0) {
      const first = hardFailures[0]!;
      return {
        passed: false,
        isExploration: false,
        reason: first.reason,
        detail: first.detail,
        checks,
        rankScore: 0,
        summary: `Rejected: ${first.detail}`,
      };
    }

    // --- Soft thresholds, which the exploration path may relax. -------------

    const isExplorationCandidate = exploration.enabled && this.shouldExplore(input);
    const opportunityThreshold = isExplorationCandidate
      ? Math.min(gate.minOpportunityScore, exploration.explorationMinOpportunityScore)
      : gate.minOpportunityScore;
    const saturationThreshold = isExplorationCandidate
      ? Math.max(gate.maxSaturationScore, exploration.explorationMaxSaturation)
      : gate.maxSaturationScore;

    const softChecks: Array<{ check: GateDecision['checks'][number]; reason: RejectionReason }> = [
      {
        check: {
          name: 'Opportunity score',
          passed: input.trend.opportunityScore >= opportunityThreshold,
          value: Number(input.trend.opportunityScore.toFixed(1)),
          threshold: opportunityThreshold,
          comparison: 'at least',
        },
        reason: 'below_opportunity_threshold',
      },
      {
        check: {
          name: 'Originality',
          passed: input.concept.originalityScore >= gate.minOriginalityScore,
          value: Number(input.concept.originalityScore.toFixed(3)),
          threshold: gate.minOriginalityScore,
          comparison: 'at least',
        },
        reason: 'below_originality_threshold',
      },
      {
        check: {
          name: 'Saturation',
          passed: input.concept.saturationScore <= saturationThreshold,
          value: Number(input.concept.saturationScore.toFixed(3)),
          threshold: saturationThreshold,
          comparison: 'at most',
        },
        reason: 'above_saturation_threshold',
      },
      {
        check: {
          name: 'Source breadth',
          passed: input.trend.sourceCount >= gate.minSourceBreadth,
          value: input.trend.sourceCount,
          threshold: gate.minSourceBreadth,
          comparison: 'at least',
          detail: 'independent platforms confirming the trend',
        },
        reason: 'below_opportunity_threshold',
      },
      {
        check: {
          name: 'Probability of ten holders',
          passed: input.prediction.probabilities.ten_holders >= gate.minProbabilityTenHolders,
          value: Number(input.prediction.probabilities.ten_holders.toFixed(3)),
          threshold: gate.minProbabilityTenHolders,
          comparison: 'at least',
        },
        reason: 'below_expected_value',
      },
      {
        check: {
          name: 'Expected value',
          passed: input.prediction.expectedValueSol >= gate.minExpectedValueSol,
          value: Number(input.prediction.expectedValueSol.toFixed(5)),
          threshold: gate.minExpectedValueSol,
          comparison: 'at least',
          detail: 'SOL, net of launch and generation costs',
        },
        reason: 'below_expected_value',
      },
      {
        check: {
          name: 'Probability of profit',
          passed: input.prediction.probabilityProfitable >= gate.minProbabilityProfitable,
          value: Number(input.prediction.probabilityProfitable.toFixed(3)),
          threshold: gate.minProbabilityProfitable,
          comparison: 'at least',
        },
        reason: 'below_expected_value',
      },
    ];

    for (const { check } of softChecks) checks.push(check);

    const failed = softChecks.find((c) => !c.check.passed);
    if (failed) {
      const detail = `${failed.check.name} was ${failed.check.value}, ${failed.check.comparison} ${failed.check.threshold} required${
        isExplorationCandidate ? ' (exploration thresholds applied)' : ''
      }.`;
      return {
        passed: false,
        isExploration: isExplorationCandidate,
        reason: failed.reason,
        detail,
        checks,
        rankScore: 0,
        summary: `Rejected: ${detail}`,
      };
    }

    const reviewFlags = input.concept.riskFlags.filter((f) => f.severity === 'review');
    const rankScore = this.rankScore(input);
    const arm = isExplorationCandidate ? this.selectExplorationArm(input.conceptId) : undefined;

    return {
      passed: true,
      isExploration: isExplorationCandidate,
      explorationArm: arm,
      checks,
      rankScore,
      summary: [
        `Passed all ${checks.length} gate checks${isExplorationCandidate ? ' on the exploration path' : ''}.`,
        `Expected value ${input.prediction.expectedValueSol >= 0 ? '+' : ''}${input.prediction.expectedValueSol.toFixed(4)} SOL,`,
        `${(input.prediction.probabilities.ten_holders * 100).toFixed(0)}% chance of ten holders.`,
        reviewFlags.length ? `${reviewFlags.length} advisory flag${reviewFlags.length === 1 ? '' : 's'} require human review.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    };
  }

  /**
   * Should this candidate be considered on the exploration path?
   *
   * Deterministic per concept, so the same candidate always gets the same
   * answer — a re-evaluation must not flip a decision by luck. The exploration
   * rate itself decays with accumulated evidence.
   */
  private shouldExplore(input: GateInput): boolean {
    const config = this.settings.get().exploration;
    const rate = explorationRate(input.totalLaunches, {
      floor: config.minExplorationRate,
      ceiling: config.maxExplorationRate,
    });
    const rng = createRng(hashSeed(`explore:${input.conceptId}`));
    return rng.next() < rate;
  }

  /**
   * Pick the exploration arm via Thompson sampling over the bandit table.
   *
   * Arms are creative or timing directions the platform is uncertain about.
   * Sampling rather than picking the best-so-far keeps under-tested arms alive.
   */
  private selectExplorationArm(conceptId: string): string | undefined {
    const rows = this.db.$raw
      .prepare(`SELECT * FROM bandit_arms WHERE active = 1 AND dimension = 'exploration_strategy'`)
      .all() as Array<Record<string, unknown>>;
    if (rows.length === 0) return undefined;

    const arms: BanditArm[] = rows.map((r) => ({
      key: String(r.key),
      label: String(r.label),
      successes: Number(r.successes ?? 0),
      failures: Number(r.failures ?? 0),
      rewardSum: Number(r.reward_sum ?? 0),
      rewardCount: Number(r.reward_count ?? 0),
      priorAlpha: Number(r.prior_alpha ?? 1),
      priorBeta: Number(r.prior_beta ?? 3),
      active: true,
    }));

    const sampled = sampleArms(arms, createRng(hashSeed(`arm:${conceptId}`)));
    return sampled[0]?.key;
  }

  /**
   * Rank candidates that all passed.
   *
   * Expected value is the objective, but ranking on EV alone concentrates every
   * launch in whatever the model is currently most optimistic about. Confidence
   * and originality act as tie-breakers that favour candidates whose value is
   * better-evidenced and less derivative.
   */
  private rankScore(input: GateInput): number {
    const ev = input.prediction.expectedValueSol;
    const confidence = input.prediction.confidence;
    const originality = input.concept.originalityScore;
    const freshness = Math.exp(-input.trend.ageHours / 48);
    // EV is in SOL and can be small; scale it into a comparable range before
    // combining, so the tie-breakers cannot dominate the objective.
    const evComponent = Math.tanh(ev * 40);
    return evComponent * (0.55 + 0.2 * confidence + 0.15 * originality + 0.1 * freshness);
  }

  /** Seed the default exploration arms on first run. */
  ensureDefaultArms(): void {
    const defaults: Array<{ key: string; label: string }> = [
      { key: 'early_low_confidence', label: 'Very early trends the model is unsure about' },
      { key: 'high_saturation_differentiated', label: 'Crowded spaces with a sharply differentiated angle' },
      { key: 'off_hours', label: 'Launch windows outside peak activity' },
      { key: 'niche_audience', label: 'Small but highly engaged audiences' },
      { key: 'absurdist', label: 'Absurdist concepts with no obvious market logic' },
    ];
    const insert = this.db.$raw.prepare(
      `INSERT INTO bandit_arms (id, dimension, key, label, created_at, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(dimension, key) DO NOTHING`,
    );
    for (const arm of defaults) {
      insert.run(`ban_${arm.key}`, 'exploration_strategy', arm.key, arm.label, this.now(), this.now());
    }
  }
}
