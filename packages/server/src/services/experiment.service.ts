import {
  betaPosterior,
  createRng,
  hashSeed,
  mean,
  median,
  quantile,
  shrinkToPrior,
  topShare,
  ucb,
  recordOutcome as applyArmOutcome,
  sampleArms,
  type BanditArm,
} from '@solcoin/shared';
import { AppError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { parseJson } from '../core/json.js';
import { componentLogger } from '../core/logger.js';
import type { Db } from '../db/client.js';
import { AUDIT_ACTIONS, type AuditLog } from '../security/audit.js';

/**
 * Controlled experimentation over launch attributes.
 *
 * The platform is constantly tempted to conclude things from tiny samples: a
 * ticker style "works" because two of its three launches happened to catch a
 * bid. This service exists to make that mistake structurally difficult.
 *
 * Three rules are enforced here rather than left to the caller:
 *
 *  1. **Assignment is deterministic in the subject id.** Re-running the
 *     pipeline over the same concept must land on the same arm. If a
 *     re-evaluation could reassign, the arm a concept ends up in would
 *     correlate with how many times it was re-evaluated — and re-evaluation is
 *     itself a function of how promising the concept looked. That is textbook
 *     selection bias and it would silently destroy the causal claim the
 *     experiment is supposed to support.
 *  2. **Every reported rate carries n and a credible interval.** A 2-of-3 arm
 *     reports a Beta posterior mean near 0.5 with a very wide interval, not
 *     "67%".
 *  3. **`conclusive` is a high bar.** Every arm must reach its pre-registered
 *     minimum sample size *and* one arm must win the posterior comparison with
 *     probability above 0.9. Anything short of that is reported, in plain
 *     English, as "not yet distinguishable from chance".
 */

// ---------------------------------------------------------------------------
// Tunables. Each is a statistical judgement the operator may interrogate.
// ---------------------------------------------------------------------------

/**
 * Monte Carlo draws used to estimate P(arm is best).
 *
 * The estimator's own standard error is at most sqrt(0.25 / N) ~= 0.0035 at
 * this many draws, which is an order of magnitude smaller than the 0.9
 * decision threshold. More draws would only cost time.
 */
const PROBABILITY_BEST_DRAWS = 20_000;

/** An arm must clear this posterior probability of being best to be conclusive. */
const CONCLUSIVE_PROBABILITY = 0.9;

/**
 * Empirical-Bayes shrinkage strength for per-arm metric means: an arm is pulled
 * toward the pooled mean of the whole experiment as though it carried five
 * extra launches at the pooled average. Memecoin payoffs are heavy-tailed, so
 * without this a single outlier launch decides which arm "wins" on value.
 */
const METRIC_SHRINK_STRENGTH = 5;

/**
 * Below this many completed outcomes, tail statistics (top-share, high
 * percentiles) describe individual launches rather than a distribution, so they
 * are reported with `tailStatisticsMeaningful: false`.
 */
const MIN_N_FOR_TAIL_STATS = 10;

/**
 * Difference in outcome coverage (recorded outcomes / assignments) between the
 * best- and worst-covered arm above which differential attrition is called out.
 *
 * Assignment is randomised, but an outcome only exists for a concept the
 * pipeline went on to launch, and that decision happens *after* assignment. If
 * one arm loses a materially larger share of its subjects before the outcome is
 * recorded, the arms that remain are no longer comparable groups and the
 * difference between them is partly selection rather than effect.
 */
const ATTRITION_COVERAGE_GAP = 0.2;

/** Below this many assignments per arm, coverage is too noisy to read as attrition. */
const MIN_ASSIGNED_FOR_ATTRITION_CHECK = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Primary outcome measure. Mirrors the `metric` column's documented values. */
export type ExperimentMetric = 'creator_fees_sol' | 'ten_holders' | 'volume_24h_sol' | (string & {});

export type ExperimentStatus = 'draft' | 'running' | 'completed' | 'abandoned';

export interface ExperimentActor {
  /** Defaults to 'user' when an id is present, 'system' otherwise. */
  type?: 'user' | 'system' | 'job';
  id?: string;
  label?: string;
}

export interface ExperimentArmInput {
  key: string;
  label: string;
  /** How this arm modifies generation; handed back verbatim to the pipeline. */
  config: Record<string, unknown>;
}

export interface CreateExperimentInput {
  name: string;
  hypothesis: string;
  /** The attribute being varied, e.g. 'ticker_style'. */
  factor: string;
  metric: ExperimentMetric;
  arms: ExperimentArmInput[];
  /** Pre-registered sample size per arm. Registering it up front is what stops
   *  the experiment being stopped the moment it happens to look good. */
  minSamplesPerArm: number;
  createdBy?: string;
}

export interface ExperimentRecord {
  id: string;
  name: string;
  hypothesis: string;
  factor: string;
  status: ExperimentStatus;
  metric: ExperimentMetric;
  minSamplesPerArm: number;
  startedAt: number | null;
  endedAt: number | null;
  conclusion: string | null;
  createdBy: string | null;
  createdAt: number;
  arms: Array<{ id: string; key: string; label: string; config: Record<string, unknown>; active: boolean }>;
}

export interface ArmAssignment {
  experimentId: string;
  armId: string;
  armKey: string;
  config: Record<string, unknown>;
  /**
   * False when the subject id is not a row in `concepts` and therefore cannot
   * be stored (the assignments table has a foreign key to it). The arm is still
   * a pure function of the subject id, so the decision is reproducible — it
   * simply cannot carry an outcome later.
   */
  persisted: boolean;
}

/** A proportion with its sample size and interval. Never reported bare. */
export interface ArmRate {
  /** Beta posterior mean, not successes/n: a 1-of-1 arm reports ~0.5, not 1.0. */
  posteriorMean: number;
  lower: number;
  upper: number;
  successes: number;
  n: number;
}

export interface ArmResult {
  armId: string;
  key: string;
  label: string;
  config: Record<string, unknown>;
  /** Subjects assigned, including those whose outcome window has not closed. */
  assigned: number;
  /** Assignments with a recorded outcome. The success rate uses this n. */
  n: number;
  /**
   * Fraction of this arm's assignments that reached a recorded outcome, or null
   * when nothing was assigned. Coverage that differs between arms is the
   * warning sign for differential attrition: see `ExperimentResults.caveats`.
   */
  outcomeCoverage: number | null;
  successRate: ArmRate;
  /**
   * Metric distribution. Mean is reported next to the median and percentiles
   * because a memecoin metric is heavy-tailed enough that the mean routinely
   * describes none of the launches in the arm.
   *
   * Every field is null when `valueCount` is 0. An arm with no metric values
   * has no mean, and reporting 0 would be a fabricated number sitting in the
   * same column as measured ones.
   */
  metric: {
    /**
     * Outcomes that carried a numeric metric value. This is the n behind every
     * figure in this block, and it can be smaller than `n` above: an outcome
     * can be recorded as a success or failure with a null value.
     */
    valueCount: number;
    meanValue: number | null;
    /** Mean pulled toward the pooled mean of the experiment by sample size. */
    shrunkMeanValue: number | null;
    medianValue: number | null;
    p25: number | null;
    p75: number | null;
    p90: number | null;
    maxValue: number | null;
    /** Share of the arm's total metric contributed by its top 10% of launches. */
    topTenPercentShare: number | null;
    /** mean/median. Above ~2 the mean is a statement about the tail. */
    meanToMedianRatio: number | null;
    /**
     * False below `MIN_N_FOR_TAIL_STATS` values, where p90, the max and the
     * top-decile share describe individual launches rather than a tail.
     */
    tailStatisticsMeaningful: boolean;
  };
  /**
   * Posterior probability that this arm has the highest true success rate,
   * estimated by Monte Carlo over the arms' Beta posteriors. An arm with no
   * outcomes keeps its wide prior and therefore a non-trivial share here: that
   * is the honest answer, not a defect.
   */
  probabilityBest: number;
  /** True once this arm alone has reached the pre-registered sample size. */
  reachedMinSamples: boolean;
}

export interface ExperimentResults {
  experimentId: string;
  name: string;
  hypothesis: string;
  factor: string;
  metric: ExperimentMetric;
  status: ExperimentStatus;
  minSamplesPerArm: number;
  totalAssigned: number;
  totalOutcomes: number;
  /** Outcomes that carried a numeric metric value; the n behind `pooledMeanValue`. */
  totalMetricValues: number;
  /**
   * Mean metric across every arm, and the target the per-arm means are shrunk
   * toward. Null when no outcome carried a value, in which case no arm has a
   * shrunk mean either.
   */
  pooledMeanValue: number | null;
  arms: ArmResult[];
  /** The arm with the highest probability of being best, if any outcome exists. */
  leader: { key: string; probabilityBest: number } | null;
  /** Both gates: every arm at its pre-registered n, and a >0.9 posterior winner. */
  conclusive: boolean;
  /** Plain English, written to refuse over-claiming on small samples. */
  interpretation: string;
  /**
   * The limits of this comparison, in plain English: what randomisation does
   * and does not buy, where selection can still enter, and which figures on
   * this page are too thin to lean on. Written out rather than left implicit
   * because the page is read by someone deciding whether to change the
   * pipeline, and an unqualified table invites a causal reading it has not
   * earned.
   */
  caveats: string[];
  monteCarloDraws: number;
}

export interface BanditArmView {
  dimension: string;
  key: string;
  label: string;
  /** Beta posterior mean success rate, with the arm's own prior applied. */
  posteriorMean: number;
  lower: number;
  upper: number;
  n: number;
  successes: number;
  failures: number;
  meanReward: number;
  rewardCount: number;
  /** Optimistic ranking value: high for genuinely good arms *and* untested ones. */
  ucb: number;
  /**
   * One Thompson draw taken at read time. It is deliberately not stable between
   * calls — it is a sample, not a statistic.
   */
  sampled: number;
  active: boolean;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface ExperimentRow {
  id: string;
  name: string;
  hypothesis: string;
  factor: string;
  status: string;
  metric: string;
  min_samples_per_arm: number;
  started_at: number | null;
  ended_at: number | null;
  conclusion: string | null;
  created_by: string | null;
  created_at: number;
}

interface ArmRow {
  id: string;
  experiment_id: string;
  key: string;
  label: string;
  config: string;
  successes: number;
  failures: number;
  reward_sum: number;
  reward_count: number;
  prior_alpha: number;
  prior_beta: number;
  active: number;
}

interface BanditArmRow {
  id: string;
  dimension: string;
  key: string;
  label: string;
  successes: number;
  failures: number;
  reward_sum: number;
  reward_count: number;
  prior_alpha: number;
  prior_beta: number;
  active: number;
  updated_at: number;
}

export class ExperimentService {
  private readonly log = componentLogger('experiments');

  constructor(
    private readonly db: Db,
    private readonly audit: AuditLog,
    private readonly now: () => number = Date.now,
  ) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Register an experiment in `draft`. Nothing is assigned until `start`.
   *
   * The arm count, the metric and `minSamplesPerArm` are all fixed here, before
   * any data exists. That ordering is the whole point: a stopping rule chosen
   * after seeing the numbers is not a stopping rule.
   */
  async create(input: CreateExperimentInput): Promise<ExperimentRecord> {
    const name = input.name.trim();
    const hypothesis = input.hypothesis.trim();
    if (!name) throw new AppError('validation_failed', 'An experiment needs a name.');
    if (!hypothesis) {
      throw new AppError(
        'validation_failed',
        'An experiment needs a stated hypothesis. Recording it up front is what stops the result being rationalised afterwards.',
      );
    }
    if (!input.factor.trim()) throw new AppError('validation_failed', 'An experiment needs a factor to vary.');

    // A single arm is not an experiment; it is a policy with extra bookkeeping.
    if (input.arms.length < 2) {
      throw new AppError(
        'validation_failed',
        `An experiment needs at least 2 arms to compare; ${input.arms.length} was supplied. With one arm there is nothing to compare against.`,
      );
    }
    const keys = new Set(input.arms.map((a) => a.key.trim()));
    if (keys.size !== input.arms.length) {
      throw new AppError('validation_failed', 'Arm keys must be unique within an experiment.');
    }
    if (input.arms.some((a) => !a.key.trim() || !a.label.trim())) {
      throw new AppError('validation_failed', 'Every arm needs a non-empty key and label.');
    }
    if (!Number.isFinite(input.minSamplesPerArm) || input.minSamplesPerArm < 1) {
      throw new AppError('validation_failed', 'minSamplesPerArm must be a positive number of launches.');
    }

    const createdAt = this.now();
    const id = newId('exp', createdAt);
    const arms = input.arms.map((arm, index) => ({
      id: newId('arm', createdAt + index),
      key: arm.key.trim(),
      label: arm.label.trim(),
      config: arm.config ?? {},
    }));

    this.db.$raw.transaction(() => {
      this.db.$raw
        .prepare(
          `INSERT INTO experiments
             (id, name, hypothesis, factor, status, metric, min_samples_per_arm, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, name, hypothesis, input.factor.trim(), 'draft', input.metric, Math.round(input.minSamplesPerArm), input.createdBy ?? null, createdAt, createdAt);

      const insertArm = this.db.$raw.prepare(
        `INSERT INTO experiment_arms (id, experiment_id, "key", label, config, created_at) VALUES (?,?,?,?,?,?)`,
      );
      for (const arm of arms) insertArm.run(arm.id, id, arm.key, arm.label, JSON.stringify(arm.config), createdAt);
    })();

    // 'experiment.created' has no entry in AUDIT_ACTIONS (which only names the
    // start and conclusion transitions); the action column is free text, and a
    // stable literal keeps the log queryable.
    this.audit.record({
      actorType: input.createdBy ? 'user' : 'system',
      actorId: input.createdBy ?? null,
      action: 'experiment.created',
      targetType: 'experiment',
      targetId: id,
      parameters: {
        name,
        hypothesis,
        factor: input.factor.trim(),
        metric: input.metric,
        minSamplesPerArm: Math.round(input.minSamplesPerArm),
        arms: arms.map((a) => a.key),
      },
    });

    this.log.info({ experimentId: id, arms: arms.length }, 'experiment registered');
    return this.require(id);
  }

  /** Move a draft (or paused) experiment into `running` so `assign` can see it. */
  async start(id: string, actor: ExperimentActor): Promise<ExperimentRecord> {
    const row = this.requireRow(id);
    if (row.status === 'running') return this.require(id);
    if (row.status !== 'draft') {
      throw new AppError(
        'conflict',
        `Experiment ${id} is ${row.status} and cannot be started. A concluded experiment must be superseded by a new one rather than reopened, so its sample stays a single pre-registered run.`,
      );
    }

    const at = this.now();
    this.db.$raw
      .prepare(`UPDATE experiments SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`)
      .run(at, at, id);

    this.audit.record({
      actorType: actor.type ?? (actor.id ? 'user' : 'system'),
      actorId: actor.id ?? null,
      actorLabel: actor.label ?? null,
      action: AUDIT_ACTIONS.experimentStarted,
      targetType: 'experiment',
      targetId: id,
      parameters: { name: row.name, factor: row.factor, metric: row.metric, minSamplesPerArm: row.min_samples_per_arm },
    });
    return this.require(id);
  }

  /**
   * Conclude an experiment.
   *
   * The results as computed at the moment of stopping are written into the
   * audit entry, so the recorded conclusion can later be checked against the
   * evidence that actually existed when it was drawn.
   */
  async stop(id: string, conclusion: string, actor: ExperimentActor): Promise<ExperimentRecord> {
    const row = this.requireRow(id);
    if (row.status === 'completed') return this.require(id);

    const results = await this.results(id);
    const at = this.now();
    this.db.$raw
      .prepare(`UPDATE experiments SET status = 'completed', ended_at = ?, conclusion = ?, updated_at = ? WHERE id = ?`)
      .run(at, conclusion, at, id);

    this.audit.record({
      actorType: actor.type ?? (actor.id ? 'user' : 'system'),
      actorId: actor.id ?? null,
      actorLabel: actor.label ?? null,
      action: AUDIT_ACTIONS.experimentConcluded,
      targetType: 'experiment',
      targetId: id,
      reason: conclusion,
      parameters: {
        conclusive: results.conclusive,
        interpretation: results.interpretation,
        // The caveats are stored with the conclusion, not just shown next to it:
        // an audit of this decision needs to see what the evidence could not
        // support at the moment it was drawn.
        caveats: results.caveats,
        arms: results.arms.map((a) => ({
          key: a.key,
          assigned: a.assigned,
          n: a.n,
          successes: a.successRate.successes,
          posteriorMean: a.successRate.posteriorMean,
          probabilityBest: a.probabilityBest,
          metricValueCount: a.metric.valueCount,
          medianValue: a.metric.medianValue,
          shrunkMeanValue: a.metric.shrunkMeanValue,
        })),
      },
    });

    this.log.info({ experimentId: id, conclusive: results.conclusive }, 'experiment concluded');
    return this.require(id);
  }

  // -------------------------------------------------------------------------
  // Assignment
  // -------------------------------------------------------------------------

  /**
   * Assign a subject to an arm of a running experiment.
   *
   * Determinism is the load-bearing property. The arm is chosen from a hash of
   * `experimentId:subjectId`, and any assignment already on record is returned
   * unchanged. A concept that is regenerated, re-scored or replayed therefore
   * stays in the arm it started in. Without that, the arm a concept ends up in
   * would depend on how often it was re-evaluated — which is itself a proxy for
   * how promising it looked — and the between-arm comparison would be measuring
   * the pipeline's attention rather than the factor under test.
   *
   * Balancing is applied only where the decision can be persisted. When the
   * counts differ by more than one the under-filled arm is preferred, which
   * keeps power roughly even across arms; ties and the unpersistable case fall
   * back to the pure hash, which is unbiased in expectation and stable.
   */
  async assign(conceptId: string, experimentId?: string): Promise<ArmAssignment | null> {
    const experiment = experimentId ? this.row(experimentId) : this.oldestRunning();
    if (!experiment) return null;
    if (experiment.status !== 'running') return null;

    const arms = this.armRows(experiment.id).filter((a) => a.active === 1);
    if (arms.length < 2) {
      // An experiment whose arms were deactivated down to one can no longer
      // produce a comparison; silently assigning everything to the survivor
      // would look like a running experiment while measuring nothing.
      this.log.warn({ experimentId: experiment.id, activeArms: arms.length }, 'running experiment has fewer than two active arms');
      return null;
    }

    const existing = this.db.$raw
      .prepare('SELECT arm_id FROM experiment_assignments WHERE experiment_id = ? AND concept_id = ?')
      .get(experiment.id, conceptId) as { arm_id: string } | undefined;
    if (existing) {
      const armRow = arms.find((a) => a.id === existing.arm_id) ?? this.armRows(experiment.id).find((a) => a.id === existing.arm_id);
      if (armRow) {
        return {
          experimentId: experiment.id,
          armId: armRow.id,
          armKey: armRow.key,
          config: parseJson<Record<string, unknown>>(armRow.config, {}),
          persisted: true,
        };
      }
    }

    // The assignments table has a foreign key to `concepts`, so a subject that
    // is not a concept row (the pipeline also experiments at the trend level)
    // cannot be stored. It still gets a stable arm from the hash.
    const storable = this.conceptExists(conceptId);
    const hashIndex = hashSeed(`${experiment.id}:${conceptId}`) % arms.length;
    let chosen = arms[hashIndex] ?? arms[0]!;

    if (storable) {
      const counts = this.assignmentCounts(experiment.id);
      const withCounts = arms.map((arm) => ({ arm, n: counts.get(arm.id) ?? 0 }));
      const lowest = Math.min(...withCounts.map((a) => a.n));
      const highest = Math.max(...withCounts.map((a) => a.n));
      if (highest - lowest > 1) {
        const starved = withCounts.filter((a) => a.n === lowest);
        // Break ties with the same hash so the choice stays a function of the
        // subject rather than of row order.
        chosen = starved[hashSeed(conceptId) % starved.length]?.arm ?? chosen;
      }
    }

    if (!storable) {
      return {
        experimentId: experiment.id,
        armId: chosen.id,
        armKey: chosen.key,
        config: parseJson<Record<string, unknown>>(chosen.config, {}),
        persisted: false,
      };
    }

    const at = this.now();
    try {
      this.db.$raw
        .prepare(
          `INSERT INTO experiment_assignments (id, experiment_id, arm_id, concept_id, assigned_at) VALUES (?,?,?,?,?)
           ON CONFLICT(experiment_id, concept_id) DO NOTHING`,
        )
        .run(newId('exa', at), experiment.id, chosen.id, conceptId, at);
    } catch {
      // A concurrent writer may have inserted first. Re-read rather than
      // overwrite: the first assignment is the one that counts.
      this.log.debug({ experimentId: experiment.id, conceptId }, 'assignment insert raced; re-reading');
    }

    const persisted = this.db.$raw
      .prepare('SELECT arm_id FROM experiment_assignments WHERE experiment_id = ? AND concept_id = ?')
      .get(experiment.id, conceptId) as { arm_id: string } | undefined;
    const finalArm = arms.find((a) => a.id === persisted?.arm_id) ?? chosen;

    return {
      experimentId: experiment.id,
      armId: finalArm.id,
      armKey: finalArm.key,
      config: parseJson<Record<string, unknown>>(finalArm.config, {}),
      persisted: true,
    };
  }

  /**
   * Record the realised metric for an assigned subject.
   *
   * Outcomes are written once. A second call for the same assignment is
   * rejected rather than allowed to overwrite, because re-recording an outcome
   * after seeing the interim results is how an experiment gets talked into a
   * conclusion.
   */
  async recordOutcome(
    conceptId: string,
    value: number,
    success: boolean,
  ): Promise<{ recorded: boolean; reason?: string; experimentId?: string; armKey?: string; assignmentsUpdated: number }> {
    if (!Number.isFinite(value)) {
      throw new AppError('validation_failed', 'An outcome value must be a finite number.');
    }

    const assignments = this.db.$raw
      .prepare(
        `SELECT a.id, a.experiment_id, a.arm_id, a.outcome_at, m."key" AS arm_key
           FROM experiment_assignments a
           JOIN experiment_arms m ON m.id = a.arm_id
          WHERE a.concept_id = ?
          ORDER BY a.assigned_at DESC`,
      )
      .all(conceptId) as Array<{
      id: string;
      experiment_id: string;
      arm_id: string;
      outcome_at: number | null;
      arm_key: string;
    }>;

    if (assignments.length === 0) {
      return {
        recorded: false,
        reason: `No experiment assignment exists for ${conceptId}; nothing to record against.`,
        assignmentsUpdated: 0,
      };
    }

    // A subject normally belongs to one experiment at a time, but a caller that
    // assigned explicitly can have put it in several. Every open assignment
    // gets the outcome: an experiment that ran on this launch is entitled to
    // the evidence, and dropping it would quietly shrink that arm's sample.
    const open = assignments.filter((a) => a.outcome_at === null);
    if (open.length === 0) {
      const latest = assignments[0]!;
      return {
        recorded: false,
        reason: `The outcome for ${conceptId} was already recorded at ${new Date(latest.outcome_at!).toISOString()}; outcomes are written once.`,
        experimentId: latest.experiment_id,
        armKey: latest.arm_key,
        assignmentsUpdated: 0,
      };
    }

    const at = this.now();
    this.db.$raw.transaction(() => {
      const updateAssignment = this.db.$raw.prepare(
        'UPDATE experiment_assignments SET outcome_value = ?, outcome_success = ?, outcome_at = ? WHERE id = ?',
      );
      // The arm counters are a denormalised fast path for Thompson sampling;
      // `results` recomputes from the assignments, which stay the source of truth.
      const updateArm = this.db.$raw.prepare(
        `UPDATE experiment_arms
            SET successes = successes + ?, failures = failures + ?, reward_sum = reward_sum + ?, reward_count = reward_count + 1
          WHERE id = ?`,
      );
      for (const assignment of open) {
        updateAssignment.run(value, success ? 1 : 0, at, assignment.id);
        updateArm.run(success ? 1 : 0, success ? 0 : 1, value, assignment.arm_id);
      }
    })();

    const primary = open[0]!;
    return {
      recorded: true,
      experimentId: primary.experiment_id,
      armKey: primary.arm_key,
      assignmentsUpdated: open.length,
    };
  }

  // -------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------

  /**
   * Compute the current state of the evidence.
   *
   * The arm comparison is run on the *binary* success outcome rather than on
   * the metric mean. That is deliberate: creator fees and volume are heavy
   * tailed enough that a mean comparison across a handful of launches is
   * effectively a comparison of which arm caught the single biggest winner.
   * The metric distribution is still reported in full — median, percentiles and
   * tail concentration — so the size of the effect remains visible.
   */
  async results(experimentId: string): Promise<ExperimentResults> {
    const experiment = this.requireRow(experimentId);
    const armRows = this.armRows(experimentId);

    const outcomeRows = this.db.$raw
      .prepare(
        `SELECT arm_id, outcome_value, outcome_success, outcome_at FROM experiment_assignments WHERE experiment_id = ?`,
      )
      .all(experimentId) as Array<{
      arm_id: string;
      outcome_value: number | null;
      outcome_success: number | null;
      outcome_at: number | null;
    }>;

    const perArm = new Map<string, { assigned: number; successes: number; n: number; values: number[] }>();
    for (const arm of armRows) perArm.set(arm.id, { assigned: 0, successes: 0, n: 0, values: [] });
    for (const row of outcomeRows) {
      const bucket = perArm.get(row.arm_id);
      if (!bucket) continue;
      bucket.assigned += 1;
      if (row.outcome_at === null) continue;
      bucket.n += 1;
      if (row.outcome_success === 1) bucket.successes += 1;
      if (row.outcome_value !== null && Number.isFinite(row.outcome_value)) bucket.values.push(row.outcome_value);
    }

    const totalAssigned = outcomeRows.length;
    const totalOutcomes = outcomeRows.filter((r) => r.outcome_at !== null).length;
    // Pooled mean across every arm; the shrinkage target for per-arm means.
    const pooledValues = outcomeRows
      .filter((r) => r.outcome_at !== null && r.outcome_value !== null && Number.isFinite(r.outcome_value))
      .map((r) => r.outcome_value as number);
    // Null, not 0, when nothing has been measured: a shrinkage target that does
    // not exist must not masquerade as a pooled mean of zero.
    const pooledMean = pooledValues.length > 0 ? mean(pooledValues) : null;

    const probabilityBest = this.probabilityBestByArm(experimentId, armRows, perArm);

    const arms: ArmResult[] = armRows.map((arm) => {
      const bucket = perArm.get(arm.id) ?? { assigned: 0, successes: 0, n: 0, values: [] };
      const posterior = betaPosterior(bucket.successes, bucket.n, arm.prior_alpha, arm.prior_beta);
      const values = bucket.values;
      const valueCount = values.length;
      const armMean = valueCount > 0 ? mean(values) : null;
      const armMedian = valueCount > 0 ? median(values) : null;
      return {
        armId: arm.id,
        key: arm.key,
        label: arm.label,
        config: parseJson<Record<string, unknown>>(arm.config, {}),
        assigned: bucket.assigned,
        n: bucket.n,
        outcomeCoverage: bucket.assigned > 0 ? bucket.n / bucket.assigned : null,
        successRate: {
          posteriorMean: posterior.mean,
          lower: posterior.lower,
          upper: posterior.upper,
          successes: bucket.successes,
          n: bucket.n,
        },
        metric: {
          valueCount,
          meanValue: armMean,
          shrunkMeanValue:
            armMean !== null && pooledMean !== null
              ? shrinkToPrior(armMean, valueCount, pooledMean, METRIC_SHRINK_STRENGTH)
              : null,
          medianValue: armMedian,
          p25: valueCount > 0 ? quantile(values, 0.25) : null,
          p75: valueCount > 0 ? quantile(values, 0.75) : null,
          p90: valueCount > 0 ? quantile(values, 0.9) : null,
          // reduce rather than Math.max(...values): the spread form throws on a
          // long-running experiment once the argument list outgrows the stack.
          maxValue: valueCount > 0 ? values.reduce((hi, v) => (v > hi ? v : hi), values[0]!) : null,
          topTenPercentShare: valueCount > 0 ? topShare(values, 0.1) : null,
          meanToMedianRatio: armMean !== null && armMedian !== null && armMedian > 0 ? armMean / armMedian : null,
          tailStatisticsMeaningful: valueCount >= MIN_N_FOR_TAIL_STATS,
        },
        probabilityBest: probabilityBest.get(arm.id) ?? 0,
        reachedMinSamples: bucket.n >= experiment.min_samples_per_arm,
      };
    });

    const ranked = [...arms].sort((a, b) => b.probabilityBest - a.probabilityBest);
    const leaderArm = totalOutcomes > 0 ? ranked[0] ?? null : null;
    const allReachedMinSamples = arms.length > 0 && arms.every((a) => a.reachedMinSamples);
    const conclusive = allReachedMinSamples && (leaderArm?.probabilityBest ?? 0) > CONCLUSIVE_PROBABILITY;

    return {
      experimentId,
      name: experiment.name,
      hypothesis: experiment.hypothesis,
      factor: experiment.factor,
      metric: experiment.metric,
      status: experiment.status as ExperimentStatus,
      minSamplesPerArm: experiment.min_samples_per_arm,
      totalAssigned,
      totalOutcomes,
      totalMetricValues: pooledValues.length,
      pooledMeanValue: pooledMean,
      arms,
      leader: leaderArm ? { key: leaderArm.key, probabilityBest: leaderArm.probabilityBest } : null,
      conclusive,
      interpretation: this.interpret(experiment, arms, leaderArm, conclusive, totalOutcomes),
      caveats: this.caveats(experiment, arms, totalOutcomes),
      monteCarloDraws: PROBABILITY_BEST_DRAWS,
    };
  }

  /**
   * P(arm has the highest true success rate), by Monte Carlo over the Beta
   * posteriors.
   *
   * The RNG is seeded from the experiment id alone, so the same evidence always
   * produces the same probabilities. An operator re-reading a result page must
   * not see the numbers wobble; a decision that moves because a random seed
   * moved is not a decision worth auditing.
   */
  private probabilityBestByArm(
    experimentId: string,
    armRows: ArmRow[],
    perArm: Map<string, { successes: number; n: number }>,
  ): Map<string, number> {
    const wins = new Map<string, number>();
    for (const arm of armRows) wins.set(arm.id, 0);
    if (armRows.length === 0) return wins;

    const params = armRows.map((arm) => {
      const bucket = perArm.get(arm.id) ?? { successes: 0, n: 0 };
      return {
        id: arm.id,
        alpha: arm.prior_alpha + bucket.successes,
        beta: arm.prior_beta + Math.max(0, bucket.n - bucket.successes),
      };
    });

    const rng = createRng(`experiment-results:${experimentId}`);
    for (let draw = 0; draw < PROBABILITY_BEST_DRAWS; draw++) {
      let bestId = params[0]!.id;
      let bestValue = -1;
      for (const param of params) {
        const sampled = rng.beta(param.alpha, param.beta);
        if (sampled > bestValue) {
          bestValue = sampled;
          bestId = param.id;
        }
      }
      wins.set(bestId, (wins.get(bestId) ?? 0) + 1);
    }

    const out = new Map<string, number>();
    for (const [id, count] of wins) out.set(id, count / PROBABILITY_BEST_DRAWS);
    return out;
  }

  /**
   * The sentence an operator actually reads.
   *
   * It is written to refuse the conclusion whenever the evidence does not
   * support it, and to name the specific reason — too few samples, or samples
   * that simply do not separate the arms.
   */
  private interpret(
    experiment: ExperimentRow,
    arms: ArmResult[],
    leader: ArmResult | null,
    conclusive: boolean,
    totalOutcomes: number,
  ): string {
    if (arms.length === 0) return 'This experiment has no arms, so there is nothing to compare.';
    if (totalOutcomes === 0) {
      const assigned = arms.reduce((acc, a) => acc + a.assigned, 0);
      return assigned === 0
        ? 'Nothing has been assigned to this experiment yet, so there is no evidence either way.'
        : `${assigned} launch(es) are assigned but none has a recorded outcome yet, so there is no evidence either way.`;
    }

    const smallest = arms.reduce((min, a) => (a.n < min.n ? a : min), arms[0]!);
    const perArmCounts = arms.map((a) => `${a.key}: ${a.n}`).join(', ');

    if (!arms.every((a) => a.reachedMinSamples)) {
      const leaderNote = leader
        ? ` ${leader.key} is nominally ahead (posterior success rate ${(leader.successRate.posteriorMean * 100).toFixed(0)}%, 95% CI ${(leader.successRate.lower * 100).toFixed(0)}-${(leader.successRate.upper * 100).toFixed(0)}%, P(best) ${(leader.probabilityBest * 100).toFixed(0)}%), but that is a provisional reading, not a result.`
        : '';
      return (
        `With ${smallest.n} launch${smallest.n === 1 ? '' : 'es'} in the smallest arm (${perArmCounts}) against a pre-registered ${experiment.min_samples_per_arm} per arm, ` +
        `this is not yet distinguishable from chance.${leaderNote}`
      );
    }

    if (!conclusive && leader) {
      return (
        `Every arm has reached the pre-registered ${experiment.min_samples_per_arm} launches (${perArmCounts}), but the arms still overlap: ` +
        `the leader ${leader.key} is best with probability ${(leader.probabilityBest * 100).toFixed(0)}%, short of the ${(CONCLUSIVE_PROBABILITY * 100).toFixed(0)}% required. ` +
        `On this evidence ${experiment.factor} has no demonstrated effect on ${experiment.metric}; either run it longer or accept that the effect, if any, is too small to detect at this sample size.`
      );
    }

    if (conclusive && leader) {
      const { meanValue, medianValue, meanToMedianRatio, valueCount, tailStatisticsMeaningful } = leader.metric;
      let medianNote: string;
      if (meanValue === null || medianValue === null) {
        // The success comparison is conclusive but no outcome carried a metric
        // value, so the *size* of the win is simply unknown. Say so.
        medianNote = ` No ${experiment.metric} value was recorded for any of ${leader.key}'s outcomes, so the size of the effect is unknown even though its direction is not.`;
      } else if (tailStatisticsMeaningful && meanToMedianRatio !== null && meanToMedianRatio > 2) {
        medianNote = ` Note that ${leader.key}'s mean ${experiment.metric} (${meanValue.toFixed(4)}) is ${meanToMedianRatio.toFixed(1)}x its median (${medianValue.toFixed(4)}) over ${valueCount} valued outcomes, so the size of the win rests on the tail rather than on a typical launch.`;
      } else {
        medianNote = ` Its median ${experiment.metric} is ${medianValue.toFixed(4)} against a mean of ${meanValue.toFixed(4)}, over ${valueCount} valued outcome${valueCount === 1 ? '' : 's'}.`;
      }
      return (
        `${leader.key} is the best arm with probability ${(leader.probabilityBest * 100).toFixed(0)}%, on ${perArmCounts} launches, ` +
        `with a posterior success rate of ${(leader.successRate.posteriorMean * 100).toFixed(0)}% (95% CI ${(leader.successRate.lower * 100).toFixed(0)}-${(leader.successRate.upper * 100).toFixed(0)}%).` +
        medianNote +
        ' This is a difference between randomised arms, not between the launches the pipeline chose to make: see the caveats for what still stands between it and a causal claim.'
      );
    }

    return `Every arm has reached its sample size (${perArmCounts}) but no arm leads; the factor ${experiment.factor} appears not to matter for ${experiment.metric}.`;
  }

  /**
   * The standing limits of the comparison, listed next to it.
   *
   * Randomised assignment buys a causal claim about the factor, but only over
   * the subjects that survive to a recorded outcome, and only to the precision
   * the sample supports. Both of those qualifications are invisible in a table
   * of per-arm rates, so they are written out here and returned with every
   * result rather than kept in a doc comment nobody reads at decision time.
   */
  private caveats(experiment: ExperimentRow, arms: ArmResult[], totalOutcomes: number): string[] {
    const out: string[] = [];

    out.push(
      `Arms are allocated by a hash of the subject id, independently of anything the pipeline scored, so a difference between arms is evidence about ${experiment.factor} itself and not merely a correlation with it. That guarantee covers assignment only.`,
    );
    out.push(
      `An outcome exists only for a concept that was launched and then measured, and the launch decision is made after assignment. This comparison is therefore conditioned on a post-assignment event: if ${experiment.factor} also changes how likely a concept is to be launched or to be observed, part of any measured difference is selection rather than effect.`,
    );

    if (totalOutcomes === 0) {
      out.push(
        'No outcome has been recorded yet. The per-arm probabilities below come entirely from the arms\' priors and describe the priors, not the world.',
      );
      return out;
    }

    // Differential attrition: randomisation is undone if the arms lose
    // materially different shares of their subjects before the outcome.
    const measurable = arms.filter((a) => a.assigned >= MIN_ASSIGNED_FOR_ATTRITION_CHECK && a.outcomeCoverage !== null);
    if (measurable.length >= 2) {
      const best = measurable.reduce((hi, a) => (a.outcomeCoverage! > hi.outcomeCoverage! ? a : hi), measurable[0]!);
      const worst = measurable.reduce((lo, a) => (a.outcomeCoverage! < lo.outcomeCoverage! ? a : lo), measurable[0]!);
      const gap = best.outcomeCoverage! - worst.outcomeCoverage!;
      if (gap > ATTRITION_COVERAGE_GAP) {
        out.push(
          `Outcome coverage differs sharply between arms: ${best.key} has outcomes for ${best.n}/${best.assigned} assignments (${(best.outcomeCoverage! * 100).toFixed(0)}%) against ${worst.key}'s ${worst.n}/${worst.assigned} (${(worst.outcomeCoverage! * 100).toFixed(0)}%). Differential attrition of this size means the arms being compared are no longer the groups that were randomised, and the difference between them should be read as partly selection until the gap is explained.`,
        );
      }
    }

    const thinTails = arms.filter((a) => a.metric.valueCount > 0 && !a.metric.tailStatisticsMeaningful);
    if (thinTails.length > 0) {
      out.push(
        `Tail statistics (p90, max, top-decile share) are marked unreliable for ${thinTails.map((a) => `${a.key} (${a.metric.valueCount} valued outcome${a.metric.valueCount === 1 ? '' : 's'})`).join(', ')}: below ${MIN_N_FOR_TAIL_STATS} values they describe individual launches, not a distribution.`,
      );
    }

    const noValues = arms.filter((a) => a.n > 0 && a.metric.valueCount === 0);
    if (noValues.length > 0) {
      out.push(
        `${noValues.map((a) => a.key).join(', ')} recorded outcomes with no ${experiment.metric} value attached, so ${noValues.length === 1 ? 'its' : 'their'} metric columns are null rather than zero. A null there means unmeasured, not "earned nothing".`,
      );
    }

    out.push(
      `Per-arm means are reported both raw and shrunk toward the pooled mean of the experiment (as though each arm carried ${METRIC_SHRINK_STRENGTH} extra launches at the pooled average). Compare arms on the shrunk figure: ${experiment.metric} is heavy-tailed enough that one outsized launch will otherwise decide which arm looks best.`,
    );
    out.push(
      `The arm comparison and P(best) are computed on the binary success outcome, not on mean ${experiment.metric}. A mean comparison across this few heavy-tailed launches would mostly report which arm happened to catch the single biggest winner.`,
    );

    return out;
  }

  // -------------------------------------------------------------------------
  // Standalone bandit arms
  // -------------------------------------------------------------------------

  /**
   * The exploration policy's arms for one dimension, with honest uncertainty.
   *
   * Both the posterior interval and the UCB are exposed because they answer
   * different questions: the interval says how much is known, the UCB says what
   * is worth trying next. An arm with n = 0 has a wide interval and a high UCB,
   * and reading only one of the two invites the wrong conclusion.
   */
  async banditArms(dimension: string): Promise<BanditArmView[]> {
    const rows = this.db.$raw
      .prepare('SELECT * FROM bandit_arms WHERE dimension = ? ORDER BY "key" ASC')
      .all(dimension) as BanditArmRow[];
    if (rows.length === 0) return [];

    const arms: BanditArm[] = rows.map((row) => this.toBanditArm(row));
    const totalPulls = arms.reduce((acc, a) => acc + a.successes + a.failures, 0);
    // Seeded on the read so the draw is reproducible within a single tick while
    // still varying between ticks, which is what Thompson sampling requires.
    const samples = sampleArms(arms, createRng(`bandit:${dimension}:${this.now()}`));
    const sampledByKey = new Map(samples.map((s) => [s.key, s]));

    return rows.map((row, index) => {
      const arm = arms[index]!;
      const sample = sampledByKey.get(row.key);
      const posterior = betaPosterior(row.successes, row.successes + row.failures, row.prior_alpha, row.prior_beta);
      return {
        dimension: row.dimension,
        key: row.key,
        label: row.label,
        posteriorMean: posterior.mean,
        lower: posterior.lower,
        upper: posterior.upper,
        n: row.successes + row.failures,
        successes: row.successes,
        failures: row.failures,
        meanReward: row.reward_count > 0 ? row.reward_sum / row.reward_count : 0,
        rewardCount: row.reward_count,
        ucb: ucb(arm, totalPulls),
        // An inactive arm is excluded from sampling; report its posterior mean
        // rather than inventing a draw for it.
        sampled: sample?.sampled ?? posterior.mean,
        active: row.active === 1,
        updatedAt: row.updated_at,
      };
    });
  }

  /**
   * Fold one observation into a bandit arm.
   *
   * The arm is created on first sight: the strategy space is discovered as the
   * pipeline explores it, and refusing an unknown key here would silently drop
   * evidence. The counter arithmetic goes through the shared `recordOutcome`
   * helper so the bandit's update rule lives in exactly one place.
   */
  async updateBanditArm(dimension: string, key: string, success: boolean, reward = 0): Promise<BanditArmView> {
    if (!Number.isFinite(reward)) {
      throw new AppError('validation_failed', 'A bandit reward must be a finite number.');
    }
    const at = this.now();

    this.db.$raw.transaction(() => {
      const existing = this.db.$raw
        .prepare('SELECT * FROM bandit_arms WHERE dimension = ? AND "key" = ?')
        .get(dimension, key) as BanditArmRow | undefined;

      if (!existing) {
        const seeded = applyArmOutcome(
          {
            key,
            label: key,
            successes: 0,
            failures: 0,
            rewardSum: 0,
            rewardCount: 0,
            priorAlpha: 1,
            priorBeta: 3,
            active: true,
          },
          success,
          reward,
        );
        this.db.$raw
          .prepare(
            `INSERT INTO bandit_arms
               (id, dimension, "key", label, successes, failures, reward_sum, reward_count, prior_alpha, prior_beta, active, updated_at, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(newId('ban', at), dimension, key, key, seeded.successes, seeded.failures, seeded.rewardSum, seeded.rewardCount, seeded.priorAlpha, seeded.priorBeta, 1, at, at);
        return;
      }

      const updated = applyArmOutcome(this.toBanditArm(existing), success, reward);
      this.db.$raw
        .prepare('UPDATE bandit_arms SET successes = ?, failures = ?, reward_sum = ?, reward_count = ?, updated_at = ? WHERE id = ?')
        .run(updated.successes, updated.failures, updated.rewardSum, updated.rewardCount, at, existing.id);
    })();

    const views = await this.banditArms(dimension);
    const view = views.find((v) => v.key === key);
    if (!view) {
      throw new AppError('internal', `Bandit arm ${dimension}/${key} could not be read back after being updated.`);
    }
    return view;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async get(id: string): Promise<ExperimentRecord | null> {
    return this.row(id) ? this.require(id) : null;
  }

  async list(status?: ExperimentStatus): Promise<ExperimentRecord[]> {
    const rows = (
      status
        ? this.db.$raw.prepare('SELECT * FROM experiments WHERE status = ? ORDER BY created_at DESC').all(status)
        : this.db.$raw.prepare('SELECT * FROM experiments ORDER BY created_at DESC').all()
    ) as ExperimentRow[];
    return rows.map((row) => this.toRecord(row, this.armRows(row.id)));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private toBanditArm(row: BanditArmRow): BanditArm {
    return {
      key: row.key,
      label: row.label,
      successes: row.successes,
      failures: row.failures,
      rewardSum: row.reward_sum,
      rewardCount: row.reward_count,
      priorAlpha: row.prior_alpha,
      priorBeta: row.prior_beta,
      active: row.active === 1,
    };
  }

  private row(id: string): ExperimentRow | undefined {
    return this.db.$raw.prepare('SELECT * FROM experiments WHERE id = ?').get(id) as ExperimentRow | undefined;
  }

  private requireRow(id: string): ExperimentRow {
    const row = this.row(id);
    if (!row) throw new AppError('not_found', `No experiment ${id}.`);
    return row;
  }

  private require(id: string): ExperimentRecord {
    const row = this.requireRow(id);
    return this.toRecord(row, this.armRows(id));
  }

  private toRecord(row: ExperimentRow, arms: ArmRow[]): ExperimentRecord {
    return {
      id: row.id,
      name: row.name,
      hypothesis: row.hypothesis,
      factor: row.factor,
      status: row.status as ExperimentStatus,
      metric: row.metric,
      minSamplesPerArm: row.min_samples_per_arm,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      conclusion: row.conclusion,
      createdBy: row.created_by,
      createdAt: row.created_at,
      arms: arms.map((arm) => ({
        id: arm.id,
        key: arm.key,
        label: arm.label,
        config: parseJson<Record<string, unknown>>(arm.config, {}),
        active: arm.active === 1,
      })),
    };
  }

  private armRows(experimentId: string): ArmRow[] {
    return this.db.$raw
      .prepare('SELECT * FROM experiment_arms WHERE experiment_id = ? ORDER BY "key" ASC')
      .all(experimentId) as ArmRow[];
  }

  /** The longest-running experiment wins, so a subject joins one experiment at
   *  a time and two overlapping experiments cannot confound each other. */
  private oldestRunning(): ExperimentRow | undefined {
    return this.db.$raw
      .prepare(`SELECT * FROM experiments WHERE status = 'running' ORDER BY started_at ASC, created_at ASC LIMIT 1`)
      .get() as ExperimentRow | undefined;
  }

  private conceptExists(conceptId: string): boolean {
    const row = this.db.$raw.prepare('SELECT 1 AS present FROM concepts WHERE id = ?').get(conceptId) as
      | { present: number }
      | undefined;
    return row !== undefined;
  }

  private assignmentCounts(experimentId: string): Map<string, number> {
    const rows = this.db.$raw
      .prepare('SELECT arm_id, COUNT(*) AS n FROM experiment_assignments WHERE experiment_id = ? GROUP BY arm_id')
      .all(experimentId) as Array<{ arm_id: string; n: number }>;
    return new Map(rows.map((r) => [r.arm_id, r.n]));
  }
}
