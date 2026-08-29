import {
  DEFAULT_ECONOMICS,
  LaunchFeatures,
  betaPosterior,
  createRng,
  defaultSettings,
  gini,
  lamportsToSol,
  mean as meanOf,
  median,
  quantile,
  shrinkToPrior,
  predictLaunch,
  topShare,
  wilsonInterval,
  TIME,
  type QualityGateSettings,
  type PlatformSettings,
  type PredictionResult,
  type RejectionReason,
  type Rng,
} from '@solcoin/shared';
import { componentLogger } from '../core/logger.js';
import { parseJson } from '../core/json.js';
import type { Db } from '../db/client.js';
import type { PredictionService } from './prediction.service.js';

/**
 * Historical replay and the strategy lab.
 *
 * ## What this module can and cannot tell you
 *
 * A backtest of a launch strategy is a fundamentally weaker instrument than a
 * backtest of, say, an equity strategy, and the difference is not a detail to
 * be buried in a footnote. Three problems are structural and cannot be
 * engineered away:
 *
 *  1. **Selection bias.** Outcomes exist only for tokens this platform actually
 *     launched, and it launched them *because* the live gate liked them. The
 *     realised outcome set is therefore a non-random sample of the candidate
 *     space, selected on exactly the variables a replayed strategy is being
 *     scored on. Any strategy evaluated against that set is being marked on a
 *     paper its predecessor chose.
 *
 *  2. **Counterfactuals are unmeasurable.** "What would have happened if we had
 *     launched X" has no observation attached to it, ever. It can only be
 *     modelled, and the model was fitted on the biased sample from (1). This
 *     module therefore refuses to blend the two: realised figures come only
 *     from launches that really happened, modelled figures are reported in a
 *     separate, explicitly labelled block, and the two are never summed into a
 *     single headline number.
 *
 *  3. **Non-stationarity.** Launch volume, graduation rates and fee schedules on
 *     pump.fun move on a timescale of weeks. A strategy that would have
 *     performed well over a past window is evidence about that window, not a
 *     forecast. Every result carries this caveat because operators reliably
 *     forget it when shown an equity curve.
 *
 * Consequently there is no `equityCurve()` here and no single "this strategy
 * earns X" number. Every result is a tuple of (realised, observed sample size,
 * unobserved count, modelled projection, caveats), and the caveats travel with
 * the data rather than living in documentation nobody reads.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Below this many observed launches, per-launch fee statistics are noise. Token
 * fee outcomes are dominated by a handful of large tails: with fewer than ten
 * observations there is a good chance the sample contains no tail at all, in
 * which case the mean understates the truth by an order of magnitude, or
 * contains exactly one, in which case it overstates it by a similar factor.
 */
const MIN_OBSERVED_FOR_PROJECTION = 10;

/**
 * Below this many observed launches on *both* sides, two strategies cannot be
 * told apart on realised outcomes and are reported as indistinguishable
 * regardless of the point estimates.
 */
const MIN_OBSERVED_FOR_COMPARISON = 10;

/** Resamples used for the clustered bootstrap in strategy comparison. */
const COMPARISON_BOOTSTRAP_DRAWS = 2000;

/** Fixed seeds: a lab result that changes between runs is not a lab result. */
const COMPARISON_SEED = 'backtest:compare:v1';
const PROJECTION_SEED = 'backtest:projection:v1';

/**
 * Ceiling on how many unobserved candidates get re-scored by the live model in
 * one replay. Re-scoring runs a 4000-draw Monte Carlo per candidate; beyond
 * this the cost stops being worth it and the total is extrapolated from the
 * scored subset, which the result labels explicitly.
 */
const MAX_MODELLED_CANDIDATES = 750;

const DAYS_PER_MONTH = 30.436875;

const BASE_CAVEATS: readonly string[] = [
  'SELECTION BIAS: outcomes exist only for tokens this platform actually launched. Those launches were chosen by the live quality gate, so the realised sample is selected on the same variables any replayed strategy is scored on. A replay measures a strategy against its predecessor’s choices, not against the market.',
  'COUNTERFACTUALS ARE NOT MEASURED: a candidate the replayed strategy would have launched but the platform did not has no outcome and never will. Such candidates are counted as UNOBSERVED and contribute nothing to realised figures. Any number attached to them is a model output, labelled as such.',
  'NON-STATIONARITY: launch volume, graduation rates and creator-fee economics on pump.fun change over weeks. Past graduation rates do not predict future ones, and a strategy that replays well over one window is evidence about that window only.',
  'The replayed gate is an approximation of the live pipeline. It re-applies numeric thresholds to the feature vector stored at decision time, but it cannot reproduce AI panel deliberation, human approval or rejection, wallet-balance and rate-limit interruptions, or any launch that failed for operational reasons.',
];

const MODELLED_CAVEATS: readonly string[] = [
  'MODELLED, NOT MEASURED: the figures in this block are the current model’s expectation for candidates that were never launched. No trade, no holder and no lamport behind them exists.',
  'The model re-scoring these candidates was trained on outcomes from this same history, so it is being asked about data it has partly memorised. Treat the modelled total as an optimistic upper reference, not a forecast.',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A replayable strategy: every threshold the live quality gate reads, plus the
 * daily launch cap, which is a limit rather than a gate but changes the answer
 * more than any individual threshold does.
 */
export interface StrategyConfig extends QualityGateSettings {
  maxLaunchesPerDay: number;
}

export interface StrategyPreset {
  name: string;
  description: string;
  config: StrategyConfig;
}

export interface ReplayOptions {
  strategy: StrategyConfig;
  sinceMs: number;
  untilMs?: number;
}

/** Distribution summary for a heavy-tailed quantity. Never a mean on its own. */
export interface SkewSummary {
  n: number;
  totalSol: number;
  meanSol: number;
  medianSol: number;
  p10Sol: number;
  p25Sol: number;
  p75Sol: number;
  p90Sol: number;
  p99Sol: number;
  maxSol: number;
  /** Share of the total contributed by the best 1% / 5% / 10% of launches. */
  top1PercentShare: number;
  top5PercentShare: number;
  top10PercentShare: number;
  /** Concentration index; 1.0 means a single launch produced everything. */
  gini: number;
}

/** Explicitly separated from every realised figure in the same result. */
export interface ModelledProjection {
  label: 'MODELLED — no outcome was observed for these candidates';
  unobservedCandidates: number;
  /** How many of them the live model could actually score. */
  scoredCandidates: number;
  /** True when only a subset was scored and the total was scaled up. */
  extrapolated: boolean;
  modelVersion: string;
  modelTrainedOnOutcomes: number;
  /**
   * Null — not zero — when no unobserved candidate carried a usable feature
   * vector. Zero would read as "the model expects nothing from them", which is
   * a claim; null says the model was never able to form one.
   */
  modelledFeesSol: number | null;
  modelledMedianFeesSol: number | null;
  modelledCostSol: number;
  modelledNetSol: number | null;
  caveats: string[];
}

export interface ReplayResult {
  strategy: StrategyConfig;
  windowStartMs: number;
  windowEndMs: number;
  windowDays: number;

  candidatesConsidered: number;
  wouldHaveLaunched: number;
  ofWhichObserved: number;
  ofWhichUnobserved: number;
  /** Fraction of would-be launches with a real outcome, with a Wilson interval. */
  observedFraction: { point: number; lower: number; upper: number; n: number };

  realisedFeesSol: number;
  realisedCostSol: number;
  realisedNetSol: number;
  /** Per-launch realised net across the observed launches. Mean alone lies here. */
  realisedPerLaunch: SkewSummary | null;
  /**
   * Graduation rate among observed launches, as a Beta posterior, never a bare
   * ratio. Null when nothing was observed: a posterior on zero trials is the
   * prior, and returning the prior under a field named `observed…` would report
   * an assumption as a measurement.
   */
  observedGraduationRate: { successes: number; n: number; mean: number; lower: number; upper: number } | null;

  launchesPerDay: number;
  rejectionReasonBreakdown: Record<string, number>;

  /** Candidates the strategy accepted but whose approval a human would have gated. */
  wouldHaveRequiredHumanReview: number;
  /** Candidates in the window with no stored prediction; not replayable at all. */
  candidatesWithoutStoredPrediction: number;
  /** Checks skipped because the stored feature vector lacked the input. */
  unevaluableChecks: Record<string, number>;
  /** Launches that really happened in the window, for orientation. */
  actualLaunchesInWindow: number;

  modelled: ModelledProjection | null;
  caveats: string[];
}

export interface StrategyComparisonEntry {
  name: string;
  description?: string;
  launches: number;
  observedLaunches: number;
  realisedNetSol: number;
  modelledNetSol: number | null;
  observedFraction: number;
  /**
   * Per-launch mean net shrunk toward the all-launch mean by sample size. Null
   * when this strategy has no observed launches at all: shrinkage on zero
   * observations returns the global mean unchanged, which would print a
   * plausible per-launch figure for a strategy that was never measured.
   */
  shrunkMeanNetPerLaunchSol: number | null;
  /**
   * True only when the clustered bootstrap separates this strategy from its
   * reference (the leader, or the runner-up for the leader itself) at 95%.
   */
  distinguishable: boolean;
  distinguishabilityNote: string;
  replay: ReplayResult;
}

export interface StrategyComparison {
  windowStartMs: number;
  windowEndMs: number;
  /** Ranked by realised net, descending. Ranking is not a recommendation. */
  strategies: StrategyComparisonEntry[];
  /** Distinct observed launches available to separate any two strategies. */
  sharedObservedLaunches: number;
  anyDistinguishable: boolean;
  note: string;
  caveats: string[];
}

export interface ProjectionOptions {
  strategy: StrategyConfig;
  months: number;
  draws: number;
  /** History to estimate the launch rate and the fee distribution from. */
  sinceMs?: number;
}

export interface ProjectionResult {
  sufficient: true;
  months: number;
  draws: number;
  observedLaunches: number;
  expectedLaunches: number;
  launchesPerMonth: number;
  /** Cumulative net profit in SOL over the whole horizon. */
  cumulativeNetSol: { p5: number; p25: number; p50: number; p75: number; p95: number };
  probabilityNetPositive: number;
  /** The empirical distribution the simulation resamples from. */
  bootstrapSource: SkewSummary;
  caveats: string[];
}

export interface InsufficientResult {
  sufficient: false;
  reason: string;
  n: number;
  required: number;
  caveats: string[];
}

export interface SweepOptions {
  parameter: 'minOpportunityScore' | 'maxSaturationScore' | 'minExpectedValueSol';
  values: number[];
  sinceMs: number;
  untilMs?: number;
  /** Strategy the parameter is varied within. Defaults to the Balanced preset. */
  base?: StrategyConfig;
}

export interface SweepPoint {
  value: number;
  launches: number;
  observedLaunches: number;
  realisedNetSol: number;
  observedFraction: number;
  /**
   * Shrunk toward the global per-launch mean; a 1-launch cell is not a signal.
   * Null at a threshold that produced no observed launches, so an empty cell in
   * the sweep never renders as a number.
   */
  shrunkMeanNetPerLaunchSol: number | null;
  /** True when this point rests on too few observations to mean anything. */
  underpowered: boolean;
  caveats: string[];
}

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface CandidateRow {
  concept_id: string;
  decided_at: number;
  hard_collision: number;
  risk_flags: string | null;
  concept_opportunity_score: number;
  concept_originality_score: number;
  concept_saturation_score: number;
  prediction_id: string;
  model_version: string;
  features: string;
  p_ten_holders: number;
  expected_value_sol: number;
  probability_profitable: number;
  expected_creator_fees_sol: number;
  launch_id: string | null;
  launch_status: string | null;
  total_cost_lamports: number | null;
  extra_cost_lamports: number;
  mint: string | null;
  graduated_at: number | null;
  lifecycle: string | null;
  peak_holders: number | null;
  holders: number | null;
  collected_lamports: number | null;
  accrued_lamports: number | null;
  outcome_fees_sol: number | null;
}

interface RealisedOutcome {
  launchId: string;
  feesSol: number;
  costSol: number;
  netSol: number;
  graduated: boolean;
}

interface ReplayCandidate {
  conceptId: string;
  decisionAtMs: number;
  predictionId: string;
  modelVersion: string;
  features: LaunchFeatures | null;
  /** 0..100. Recovered from the stored feature vector where possible. */
  opportunityScore: number;
  originalityScore: number;
  saturationScore: number;
  /** Number of independent trend sources, or null when unrecoverable. */
  sourceBreadth: number | null;
  trendAgeHours: number | null;
  pTenHolders: number;
  expectedValueSol: number;
  probabilityProfitable: number;
  hardCollision: boolean;
  blockingRiskFlags: number;
  advisoryRiskFlags: number;
  storedExpectedFeesSol: number;
  outcome: RealisedOutcome | null;
}

interface SimulationOutput {
  candidatesConsidered: number;
  selected: ReplayCandidate[];
  rejectionReasonBreakdown: Record<string, number>;
  unevaluableChecks: Record<string, number>;
  requiredHumanReview: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class BacktestService {
  private readonly log = componentLogger('backtest');

  /**
   * Memo of live-model re-scores keyed by prediction id. A comparison runs the
   * same candidate through several strategies; re-running a 4000-draw Monte
   * Carlo each time would be slow *and* would produce identical numbers, since
   * `predictLaunch` is seeded deterministically.
   */
  private readonly rescoreCache = new Map<string, PredictionResult>();

  constructor(
    private readonly db: Db,
    private readonly predictions: PredictionService,
    private readonly now: () => number = Date.now,
  ) {}

  // -------------------------------------------------------------------------
  // 1. Replay
  // -------------------------------------------------------------------------

  /**
   * Re-apply a strategy to the recorded history and report what it would have
   * done, split strictly into what can be measured and what can only be modelled.
   */
  async replay(options: ReplayOptions): Promise<ReplayResult> {
    const untilMs = options.untilMs ?? this.now();
    const sinceMs = Math.min(options.sinceMs, untilMs);
    return this.replayFrom(this.loadCandidates(sinceMs, untilMs), options.strategy, sinceMs, untilMs).result;
  }

  /**
   * The body of `replay`, over an already-loaded candidate list.
   *
   * Split out so that comparing n strategies reads the history once rather than
   * n times: the replay is deterministic given the same rows, and re-reading
   * them mid-comparison would also let a concurrent write change the population
   * one strategy is scored on but not another's.
   */
  private replayFrom(
    candidates: readonly ReplayCandidate[],
    strategy: StrategyConfig,
    sinceMs: number,
    untilMs: number,
  ): { result: ReplayResult; observedLaunchIds: Set<string> } {
    const windowDays = Math.max((untilMs - sinceMs) / TIME.day, 1 / 24);
    const simulation = this.simulate(candidates, strategy);

    const observed = simulation.selected.filter((c) => c.outcome !== null);
    const unobserved = simulation.selected.filter((c) => c.outcome === null);

    const netValues = observed.map((c) => c.outcome!.netSol);
    const realisedFeesSol = observed.reduce((acc, c) => acc + c.outcome!.feesSol, 0);
    const realisedCostSol = observed.reduce((acc, c) => acc + c.outcome!.costSol, 0);
    const graduations = observed.filter((c) => c.outcome!.graduated).length;

    const observedFractionInterval = wilsonInterval(observed.length, simulation.selected.length);

    const caveats = [...BASE_CAVEATS];
    if (simulation.selected.length > 0 && observed.length === 0) {
      caveats.push(
        `NO REALISED OUTCOMES: this strategy selected ${simulation.selected.length} candidate(s) in the window and none of them was ever launched. Every realised figure below is zero because nothing was measured, not because the strategy earned nothing.`,
      );
    } else if (observed.length > 0 && observed.length < MIN_OBSERVED_FOR_PROJECTION) {
      caveats.push(
        `SMALL SAMPLE: only ${observed.length} of the ${simulation.selected.length} selected candidates have realised outcomes. Fee outcomes are dominated by rare large tails, so at this sample size the realised total is roughly as likely to be an order of magnitude low as it is to be representative.`,
      );
    }
    if (simulation.requiredHumanReview > 0) {
      caveats.push(
        `${simulation.requiredHumanReview} selected candidate(s) carried an advisory risk flag and would have been held for human approval under this strategy. They are counted as launched here because inventing a human’s decision would be worse than stating the ambiguity.`,
      );
    }
    const unevaluableTotal = Object.values(simulation.unevaluableChecks).reduce((a, b) => a + b, 0);
    if (unevaluableTotal > 0) {
      caveats.push(
        `${unevaluableTotal} threshold check(s) were skipped because the stored feature vector did not contain the input (see unevaluableChecks). A skipped check never rejects, so this replay is marginally more permissive than the live gate would have been.`,
      );
    }

    const modelled = unobserved.length > 0 ? this.modelUnobserved(unobserved) : null;

    const result: ReplayResult = {
      strategy,
      windowStartMs: sinceMs,
      windowEndMs: untilMs,
      windowDays,

      candidatesConsidered: simulation.candidatesConsidered,
      wouldHaveLaunched: simulation.selected.length,
      ofWhichObserved: observed.length,
      ofWhichUnobserved: unobserved.length,
      observedFraction: {
        point: observedFractionInterval.point,
        lower: observedFractionInterval.lower,
        upper: observedFractionInterval.upper,
        n: simulation.selected.length,
      },

      realisedFeesSol,
      realisedCostSol,
      realisedNetSol: realisedFeesSol - realisedCostSol,
      realisedPerLaunch: netValues.length > 0 ? summariseSkew(netValues) : null,
      // 1 graduation out of 3 launches is not a 33% graduation rate. The Beta
      // posterior with a weak pessimistic prior keeps that honest. With nothing
      // observed at all there is no rate to report and the field is null.
      observedGraduationRate:
        observed.length > 0
          ? { successes: graduations, ...betaPosterior(graduations, observed.length, 1, 3) }
          : null,

      launchesPerDay: simulation.selected.length / windowDays,
      rejectionReasonBreakdown: simulation.rejectionReasonBreakdown,

      wouldHaveRequiredHumanReview: simulation.requiredHumanReview,
      candidatesWithoutStoredPrediction: this.countCandidatesWithoutPrediction(sinceMs, untilMs),
      unevaluableChecks: simulation.unevaluableChecks,
      actualLaunchesInWindow: this.countActualLaunches(sinceMs, untilMs),

      modelled,
      caveats,
    };

    return { result, observedLaunchIds: new Set(observed.map((c) => c.outcome!.launchId)) };
  }

  // -------------------------------------------------------------------------
  // 2. Strategy comparison
  // -------------------------------------------------------------------------

  /**
   * Replay several strategies over the same window and rank them.
   *
   * The hard part is not the ranking, it is saying honestly whether the ranking
   * means anything. Two strategies replayed over the same history are scored on
   * heavily overlapping sets of launches, so an independent two-sample test is
   * invalid: it would treat shared observations as independent evidence and
   * declare differences significant that are just one lucky token counted twice.
   *
   * The test used instead is a clustered bootstrap over launches with common
   * random numbers: each resample draws launches from the shared observed pool
   * once, and every strategy is re-scored on that same resample. Shared launches
   * therefore move together, exactly as they do in reality, and the resulting
   * difference distribution reflects only the genuinely non-overlapping evidence.
   */
  async compareStrategies(
    strategies: Array<{ name: string; description?: string; config: StrategyConfig }>,
    options: { sinceMs: number; untilMs?: number },
  ): Promise<StrategyComparison> {
    const untilMs = options.untilMs ?? this.now();
    const sinceMs = Math.min(options.sinceMs, untilMs);

    // Read the history once; every strategy is scored on exactly these rows.
    const candidates = this.loadCandidates(sinceMs, untilMs);

    const replays = strategies.map((strategy) => {
      const replayed = this.replayFrom(candidates, strategy.config, sinceMs, untilMs);
      return {
        name: strategy.name,
        description: strategy.description,
        result: replayed.result,
        observedIds: replayed.observedLaunchIds,
      };
    });

    // The universe every strategy is scored against: launches observed in the
    // window, each with its realised net. This is the bootstrap population.
    const universe = candidates
      .filter((c) => c.outcome !== null)
      .map((c) => ({ launchId: c.outcome!.launchId, netSol: c.outcome!.netSol }));

    const globalMeanNet = universe.length > 0 ? meanOf(universe.map((u) => u.netSol)) : 0;

    const ranked = [...replays].sort((a, b) => b.result.realisedNetSol - a.result.realisedNetSol);

    const entries: StrategyComparisonEntry[] = ranked.map((entry, index) => {
      // Each strategy is compared against the leader; the leader is compared
      // against the runner-up, so "distinguishable" always means "separable
      // from its nearest rival", never "separable from itself".
      const reference = index === 0 ? ranked[1] : ranked[0];
      const separation = reference
        ? this.bootstrapSeparation(universe, entry.observedIds, reference.observedIds)
        : { separable: false, note: 'Only one strategy was supplied, so there is nothing to distinguish it from.' };

      const observedCount = entry.result.ofWhichObserved;
      const referenceObserved = reference?.result.ofWhichObserved ?? 0;
      const underpowered =
        observedCount < MIN_OBSERVED_FOR_COMPARISON || referenceObserved < MIN_OBSERVED_FOR_COMPARISON;

      return {
        name: entry.name,
        description: entry.description,
        launches: entry.result.wouldHaveLaunched,
        observedLaunches: observedCount,
        realisedNetSol: entry.result.realisedNetSol,
        modelledNetSol: entry.result.modelled?.modelledNetSol ?? null,
        observedFraction: entry.result.observedFraction.point,
        // A strategy that selected two launches has a per-launch mean built from
        // two numbers; shrinking it toward the all-launch mean stops that cell
        // from topping the table on one lucky token.
        shrunkMeanNetPerLaunchSol: shrinkToPrior(meanNet, observedCount, globalMeanNet, MIN_OBSERVED_FOR_COMPARISON),
        distinguishable: !underpowered && separation.separable,
        distinguishabilityNote: underpowered
          ? `Indistinguishable: ${observedCount} observed launch(es) here and ${referenceObserved} for the comparison strategy, against a minimum of ${MIN_OBSERVED_FOR_COMPARISON} on both sides.`
          : separation.note,
        replay: entry.result,
      };
    });

    const anyDistinguishable = entries.some((e) => e.distinguishable);

    return {
      windowStartMs: sinceMs,
      windowEndMs: untilMs,
      strategies: entries,
      sharedObservedLaunches: universe.length,
      anyDistinguishable,
      note: anyDistinguishable
        ? 'At least one strategy is separable from its nearest rival under a clustered bootstrap. The separation is still conditional on a launch history the live gate selected, so it is evidence about this window, not a general ranking.'
        : `No strategy is statistically separable from any other on this history: ${universe.length} observed launch(es) with heavy-tailed outcomes cannot resolve the differences in the table. The ordering below is a point estimate and should not be used to choose between them.`,
      caveats: [
        ...BASE_CAVEATS,
        'Strategies replayed over the same history are scored on overlapping sets of launches. Comparisons here use a clustered bootstrap that resamples launches once and re-scores every strategy on the same resample; treating the strategies as independent samples would badly overstate the significance of any difference.',
        'Ranking by realised net rewards the strategy that happened to include whichever token produced the largest fee tail. With a small observed sample this is mostly a measurement of luck.',
      ],
    };
  }

  // -------------------------------------------------------------------------
  // 3. Presets
  // -------------------------------------------------------------------------

  /**
   * Three coherent positions on the same trade-off, not three arbitrary knob
   * settings. Each encodes a thesis about where the value is, and each takes a
   * different risk when that thesis is wrong.
   */
  defaultStrategies(): StrategyPreset[] {
    const platform = defaultSettings();
    const gate = platform.qualityGate;

    return [
      {
        name: 'Selective',
        description:
          'Thesis: creator fees are so concentrated in a few winners that the only decision that matters is refusing the rest. Launch at most one token a day, only into fast-moving and largely unclaimed trends, and only when the model expects a clear positive return. Risk: with one launch a day and a tail-dominated payoff, the strategy can go weeks without touching a winner while still paying the per-launch cost, and the small sample it generates starves the model of the outcomes it needs to improve.',
        config: {
          ...gate,
          minOpportunityScore: 72,
          minOriginalityScore: 0.75,
          maxSaturationScore: 0.28,
          minProbabilityTenHolders: 0.32,
          minExpectedValueSol: 0.02,
          minProbabilityProfitable: 0.25,
          minSourceBreadth: 3,
          maxTrendAgeHours: 48,
          blockOnHardCollision: true,
          humanReviewOnAnyRiskFlag: true,
          maxLaunchesPerDay: 1,
        },
      },
      {
        name: 'Balanced',
        description:
          'Thesis: the shipped defaults are a reasonable prior. Thresholds sit where the platform ships them, with the default daily cap. Risk: it is a compromise, so it is beaten by Selective in a market where only the very best candidates pay and by Exploratory in a market whose winners the current model cannot yet recognise — and it will not tell you which market you are in.',
        config: { ...gate, maxLaunchesPerDay: platform.limits.maxLaunchesPerDay },
      },
      {
        name: 'Exploratory',
        description:
          'Thesis: the model is trained on too few outcomes to be trusted as a filter, so the binding constraint is information, not selection. Accept weaker candidates and more of them, tolerate crowded trends, and buy outcomes to learn from. Risk: this is the only preset that can lose money steadily rather than in bursts — more launches means more certain cost against a payoff that still depends on rare tails, and a permissive gate raises the chance of launching into a saturated or reputationally awkward space.',
        config: {
          ...gate,
          minOpportunityScore: 45,
          minOriginalityScore: 0.5,
          maxSaturationScore: 0.65,
          minProbabilityTenHolders: 0.08,
          minExpectedValueSol: -0.01,
          minProbabilityProfitable: 0.05,
          minSourceBreadth: 1,
          maxTrendAgeHours: 120,
          // Never relaxed: a hard name collision is a trader-confusion problem,
          // not a return problem, and exploration is no excuse for it.
          blockOnHardCollision: true,
          humanReviewOnAnyRiskFlag: true,
          maxLaunchesPerDay: 5,
        },
      },
    ];
  }

  /** Build a replayable strategy from live platform settings. */
  strategyFromSettings(settings: PlatformSettings): StrategyConfig {
    return { ...settings.qualityGate, maxLaunchesPerDay: settings.limits.maxLaunchesPerDay };
  }

  // -------------------------------------------------------------------------
  // 4. Monte Carlo projection
  // -------------------------------------------------------------------------

  /**
   * Project cumulative net profit forward by bootstrap resampling.
   *
   * **Why bootstrap and not a fitted normal.** Per-launch creator fees are not
   * approximately normal and are not close enough for the difference to be
   * academic. The distribution is a point mass near zero (most tokens never get
   * an organic buyer) with a long right tail (a graduate earns hundreds of times
   * the median). Fitting a normal to that sample does two damaging things at
   * once: it assigns real probability to impossible outcomes below zero fees,
   * and it truncates the upper tail, which is where essentially all of the
   * expected value lives. The p95 of a fitted normal on this data is routinely
   * an order of magnitude below the p95 of the empirical distribution.
   *
   * Resampling observed launches with replacement makes no shape assumption at
   * all. Its own limitation is the honest one and is stated in the caveats: the
   * bootstrap cannot produce an outcome larger than the largest one ever
   * observed, so with a short history it understates the extreme upside rather
   * than inventing it. Fee and cost are resampled as a *pair*, because a launch
   * with a dev buy costs more and tends to earn differently; breaking the pair
   * would decorrelate them and flatter the result.
   */
  async monteCarloProjection(options: ProjectionOptions): Promise<ProjectionResult | InsufficientResult> {
    const untilMs = this.now();
    const sinceMs = options.sinceMs ?? 0;
    const months = Math.max(1, Math.floor(options.months));
    const draws = Math.max(200, Math.floor(options.draws));

    const candidates = this.loadCandidates(sinceMs, untilMs);
    const observed = candidates.filter((c) => c.outcome !== null).map((c) => c.outcome!);

    if (observed.length < MIN_OBSERVED_FOR_PROJECTION) {
      return {
        sufficient: false,
        reason: `A projection needs at least ${MIN_OBSERVED_FOR_PROJECTION} launches with realised outcomes to resample from; ${observed.length} are available. Below that the sample very likely contains either no fee tail at all or exactly one, and a bootstrap would faithfully reproduce whichever accident it was handed. No projection is offered.`,
        n: observed.length,
        required: MIN_OBSERVED_FOR_PROJECTION,
        caveats: [...BASE_CAVEATS],
      };
    }

    // Launch rate under this strategy, taken from what the strategy would have
    // done over the observed history rather than from its daily cap: the cap is
    // an upper bound, and candidate supply is usually the real constraint.
    const replayForRate = this.simulate(candidates, options.strategy);
    const historyDays = Math.max((untilMs - (candidates[0]?.decisionAtMs ?? sinceMs)) / TIME.day, 1);
    const perDay = Math.min(replayForRate.selected.length / historyDays, options.strategy.maxLaunchesPerDay);
    const launchesPerMonth = perDay * DAYS_PER_MONTH;

    const rng = createRng(`${PROJECTION_SEED}:${months}:${draws}`);
    const cumulative: number[] = new Array(draws);
    let positive = 0;
    let launchTotal = 0;

    for (let d = 0; d < draws; d++) {
      let net = 0;
      let launches = 0;
      for (let m = 0; m < months; m++) {
        // Launch count is itself uncertain: candidate supply arrives in bursts
        // as trends do. Poisson is the minimal honest model of that arrival.
        const count = poisson(rng, launchesPerMonth);
        launches += count;
        for (let i = 0; i < count; i++) {
          const pick = observed[rng.int(0, observed.length)];
          if (!pick) continue;
          net += pick.feesSol - pick.costSol;
        }
      }
      cumulative[d] = net;
      launchTotal += launches;
      if (net > 0) positive++;
    }

    const netValues = cumulative.map((v) => v ?? 0);

    return {
      sufficient: true,
      months,
      draws,
      observedLaunches: observed.length,
      expectedLaunches: launchTotal / draws,
      launchesPerMonth,
      cumulativeNetSol: {
        p5: quantile(netValues, 0.05),
        p25: quantile(netValues, 0.25),
        p50: quantile(netValues, 0.5),
        p75: quantile(netValues, 0.75),
        p95: quantile(netValues, 0.95),
      },
      probabilityNetPositive: positive / draws,
      bootstrapSource: summariseSkew(observed.map((o) => o.netSol)),
      caveats: [
        ...BASE_CAVEATS,
        `The resampled population is ${observed.length} launch(es) this platform actually made. A bootstrap cannot generate an outcome better than the best one in that sample, so the p95 here is a floor on the plausible upside, not a ceiling.`,
        'Outcomes are resampled independently across launches and months. Real launches are correlated — a strong market lifts many at once, a dead one sinks them together — so the true spread of cumulative profit is wider than the interval shown.',
        'The launch rate is extrapolated from how often this strategy found an acceptable candidate in the past. If trend supply or the candidate pipeline changes, the launch count changes with it and every figure here moves proportionally.',
        'Fees are simulated at the historical fee schedule and SOL price. Neither is fixed, and a change to either rescales the entire projection.',
      ],
    };
  }

  // -------------------------------------------------------------------------
  // 5. Threshold sweep
  // -------------------------------------------------------------------------

  /**
   * "Would stricter thresholds have improved returns?"
   *
   * The shape of the answer is more informative than any single point: a curve
   * that rises monotonically with strictness usually means one large winner sits
   * above every threshold tested, not that strictness works. Each point carries
   * its observed count and an `underpowered` flag for exactly that reason.
   */
  async sweepThreshold(options: SweepOptions): Promise<SweepPoint[]> {
    const untilMs = options.untilMs ?? this.now();
    const sinceMs = Math.min(options.sinceMs, untilMs);
    const base = options.base ?? this.balancedConfig();

    const candidates = this.loadCandidates(sinceMs, untilMs);
    const universeNet = candidates.filter((c) => c.outcome !== null).map((c) => c.outcome!.netSol);
    const globalMeanNet = universeNet.length > 0 ? meanOf(universeNet) : 0;

    const points: SweepPoint[] = [];
    for (const value of options.values) {
      const strategy: StrategyConfig = { ...base, [options.parameter]: value };
      const simulation = this.simulate(candidates, strategy);
      const observed = simulation.selected.filter((c) => c.outcome !== null);
      const realisedNetSol = observed.reduce((acc, c) => acc + c.outcome!.netSol, 0);
      const meanNet = observed.length > 0 ? realisedNetSol / observed.length : globalMeanNet;
      const underpowered = observed.length < MIN_OBSERVED_FOR_COMPARISON;

      const caveats = [...BASE_CAVEATS];
      caveats.push(
        'A sweep re-uses one history at every point, so neighbouring points are not independent observations and the curve is far smoother than the underlying uncertainty. Read its shape, not its peak.',
      );
      if (underpowered) {
        caveats.push(
          `Underpowered: ${observed.length} observed launch(es) at this threshold. The realised net is a sum over that handful and carries no information about the threshold itself.`,
        );
      }
      if (observed.length > 0 && summariseSkew(observed.map((c) => c.outcome!.netSol)).top1PercentShare > 0.5) {
        caveats.push(
          'More than half of the realised net at this point comes from the single best launch. Moving the threshold past that one token would collapse the figure entirely.',
        );
      }

      points.push({
        value,
        launches: simulation.selected.length,
        observedLaunches: observed.length,
        realisedNetSol,
        observedFraction: simulation.selected.length > 0 ? observed.length / simulation.selected.length : 0,
        shrunkMeanNetPerLaunchSol: shrinkToPrior(meanNet, observed.length, globalMeanNet, MIN_OBSERVED_FOR_COMPARISON),
        underpowered,
        caveats,
      });
    }

    return points;
  }

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  /**
   * Load every replayable candidate in the window, in decision order.
   *
   * Only the *latest* prediction per concept is used, and its stored feature
   * vector is the source of truth for the threshold checks. That vector was
   * frozen at decision time, whereas the denormalised scores on `concepts` and
   * `trends` are updated as new observations arrive; reading those would leak
   * post-decision information into the replay and quietly flatter every result.
   */
  private loadCandidates(sinceMs: number, untilMs: number): ReplayCandidate[] {
    const rows = this.db.$raw
      .prepare(
        `SELECT c.id AS concept_id,
                c.created_at AS decided_at,
                c.hard_collision,
                c.risk_flags,
                c.opportunity_score AS concept_opportunity_score,
                c.originality_score AS concept_originality_score,
                c.saturation_score AS concept_saturation_score,
                p.id AS prediction_id,
                p.model_version,
                p.features,
                p.p_ten_holders,
                p.expected_value_sol,
                p.probability_profitable,
                p.expected_creator_fees_sol,
                l.id AS launch_id,
                l.status AS launch_status,
                l.total_cost_lamports,
                COALESCE((SELECT SUM(amount_lamports) FROM expenses
                           WHERE ref_type = 'launch' AND ref_id = l.id
                             AND kind NOT IN ('launch_sol','network_fee','priority_fee')), 0) AS extra_cost_lamports,
                t.mint,
                t.graduated_at,
                t.lifecycle,
                t.peak_holders,
                t.holders,
                t.creator_fees_collected_lamports AS collected_lamports,
                t.creator_fees_accrued_lamports AS accrued_lamports,
                o.actual_creator_fees_sol AS outcome_fees_sol
           FROM concepts c
           JOIN predictions p
             ON p.id = (SELECT id FROM predictions WHERE concept_id = c.id ORDER BY created_at DESC LIMIT 1)
           LEFT JOIN launches l
             ON l.id = (SELECT id FROM launches WHERE concept_id = c.id AND status = 'confirmed'
                         ORDER BY created_at ASC LIMIT 1)
           LEFT JOIN tokens t ON t.mint = l.mint_address
           LEFT JOIN prediction_outcomes o
             ON o.prediction_id = p.id
            AND o.horizon_hours = (SELECT MAX(horizon_hours) FROM prediction_outcomes WHERE prediction_id = p.id)
          WHERE c.created_at >= ? AND c.created_at < ?
          ORDER BY c.created_at ASC, c.id ASC`,
      )
      .all(sinceMs, untilMs) as CandidateRow[];

    return rows.map((row) => this.toCandidate(row));
  }

  private toCandidate(row: CandidateRow): ReplayCandidate {
    const parsed = LaunchFeatures.safeParse(parseJson<unknown>(row.features, null));
    const features = parsed.success ? parsed.data : null;

    if (!parsed.success) {
      this.log.debug({ conceptId: row.concept_id }, 'stored feature vector could not be parsed; falling back to concept columns');
    }

    const flags = parseJson<Array<{ severity?: string }>>(row.risk_flags, []);
    const blocking = Array.isArray(flags) ? flags.filter((f) => f?.severity === 'block').length : 0;
    const advisory = Array.isArray(flags) ? flags.filter((f) => f?.severity === 'review').length : 0;

    return {
      conceptId: row.concept_id,
      decisionAtMs: row.decided_at,
      predictionId: row.prediction_id,
      modelVersion: row.model_version,
      features,
      // `trend_level` is the opportunity score divided by 100 and clamped, so
      // multiplying back recovers it exactly for any score in 0..100.
      opportunityScore: features ? features.trend_level * 100 : row.concept_opportunity_score,
      originalityScore: features ? features.originality : row.concept_originality_score,
      saturationScore: features ? features.saturation : row.concept_saturation_score,
      // `trend_source_breadth` is sourceCount/6 clamped to 1, so the count is
      // recoverable up to six sources and saturates above that. Six or more
      // independent sources clears every breadth threshold the gate allows, so
      // the saturation costs nothing here.
      sourceBreadth: features ? Math.round(features.trend_source_breadth * 6) : null,
      trendAgeHours: features ? features.trend_age_hours : null,
      pTenHolders: row.p_ten_holders,
      expectedValueSol: row.expected_value_sol,
      probabilityProfitable: row.probability_profitable,
      hardCollision: row.hard_collision === 1,
      blockingRiskFlags: blocking,
      advisoryRiskFlags: advisory,
      storedExpectedFeesSol: row.expected_creator_fees_sol,
      outcome: this.toOutcome(row),
    };
  }

  /**
   * A realised outcome exists only for a confirmed launch with a token row.
   * Anything else is unobserved, including launches that failed on-chain: a
   * failed launch tells us about execution, not about the strategy's judgement.
   */
  private toOutcome(row: CandidateRow): RealisedOutcome | null {
    if (!row.launch_id || row.launch_status !== 'confirmed' || !row.mint) return null;

    const lamports = (row.collected_lamports ?? 0) + (row.accrued_lamports ?? 0);
    // The outcome row is a measurement at a fixed horizon; the token row is a
    // running total. Fees only accumulate, so the larger is the current truth
    // and a stale outcome row cannot understate a still-earning token.
    const feesSol = Math.max(lamportsToSol(lamports), row.outcome_fees_sol ?? 0);
    const costSol = lamportsToSol((row.total_cost_lamports ?? 0) + row.extra_cost_lamports);

    return {
      launchId: row.launch_id,
      feesSol,
      costSol,
      netSol: feesSol - costSol,
      graduated: row.graduated_at !== null || row.lifecycle === 'graduated',
    };
  }

  private countCandidatesWithoutPrediction(sinceMs: number, untilMs: number): number {
    const row = this.db.$raw
      .prepare(
        `SELECT COUNT(*) AS n FROM concepts c
          WHERE c.created_at >= ? AND c.created_at < ?
            AND NOT EXISTS (SELECT 1 FROM predictions WHERE concept_id = c.id)`,
      )
      .get(sinceMs, untilMs) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  private countActualLaunches(sinceMs: number, untilMs: number): number {
    const row = this.db.$raw
      .prepare(`SELECT COUNT(*) AS n FROM launches WHERE status = 'confirmed' AND created_at >= ? AND created_at < ?`)
      .get(sinceMs, untilMs) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  // -------------------------------------------------------------------------
  // The replayed gate
  // -------------------------------------------------------------------------

  /**
   * Re-apply a strategy to an ordered candidate list.
   *
   * The check order mirrors `QualityGateService.evaluate` so that the rejection
   * reason attributed here is the one the live gate would have attributed: a
   * candidate that fails three checks is rejected for the first, and reordering
   * the checks would silently redistribute the breakdown.
   *
   * The daily cap is applied last and in chronological order, because it is a
   * function of what the strategy already did that day rather than of the
   * candidate.
   */
  private simulate(candidates: readonly ReplayCandidate[], strategy: StrategyConfig): SimulationOutput {
    const rejections: Record<string, number> = {};
    const unevaluable: Record<string, number> = {};
    const selected: ReplayCandidate[] = [];
    const perDay = new Map<string, number>();
    let requiredHumanReview = 0;

    const reject = (reason: RejectionReason): void => {
      rejections[reason] = (rejections[reason] ?? 0) + 1;
    };
    const skip = (check: string): void => {
      unevaluable[check] = (unevaluable[check] ?? 0) + 1;
    };

    for (const candidate of candidates) {
      // --- Hard blocks, never relaxed. -------------------------------------
      if (candidate.blockingRiskFlags > 0) {
        reject('safety_block');
        continue;
      }
      if (strategy.blockOnHardCollision && candidate.hardCollision) {
        reject('duplicate_concept');
        continue;
      }
      if (candidate.trendAgeHours === null) {
        skip('trendFreshness');
      } else if (candidate.trendAgeHours > strategy.maxTrendAgeHours) {
        reject('trend_expired');
        continue;
      }

      // --- Soft thresholds. -------------------------------------------------
      if (candidate.opportunityScore < strategy.minOpportunityScore) {
        reject('below_opportunity_threshold');
        continue;
      }
      if (candidate.originalityScore < strategy.minOriginalityScore) {
        reject('below_originality_threshold');
        continue;
      }
      if (candidate.saturationScore > strategy.maxSaturationScore) {
        reject('above_saturation_threshold');
        continue;
      }
      if (candidate.sourceBreadth === null) {
        skip('sourceBreadth');
      } else if (candidate.sourceBreadth < strategy.minSourceBreadth) {
        reject('below_opportunity_threshold');
        continue;
      }
      if (candidate.pTenHolders < strategy.minProbabilityTenHolders) {
        reject('below_expected_value');
        continue;
      }
      if (candidate.expectedValueSol < strategy.minExpectedValueSol) {
        reject('below_expected_value');
        continue;
      }
      if (candidate.probabilityProfitable < strategy.minProbabilityProfitable) {
        reject('below_expected_value');
        continue;
      }

      // --- Rate limit. ------------------------------------------------------
      const day = utcDayKey(candidate.decisionAtMs);
      const used = perDay.get(day) ?? 0;
      if (used >= strategy.maxLaunchesPerDay) {
        reject('daily_limit_reached');
        continue;
      }
      perDay.set(day, used + 1);

      // Held for approval rather than rejected: whether a human would have said
      // yes is not recorded anywhere and must not be guessed.
      if (strategy.humanReviewOnAnyRiskFlag && candidate.advisoryRiskFlags > 0) requiredHumanReview++;

      selected.push(candidate);
    }

    return {
      candidatesConsidered: candidates.length,
      selected,
      rejectionReasonBreakdown: rejections,
      unevaluableChecks: unevaluable,
      requiredHumanReview,
    };
  }

  private balancedConfig(): StrategyConfig {
    const balanced = this.defaultStrategies().find((s) => s.name === 'Balanced');
    const platform = defaultSettings();
    return balanced?.config ?? { ...platform.qualityGate, maxLaunchesPerDay: platform.limits.maxLaunchesPerDay };
  }

  // -------------------------------------------------------------------------
  // Modelling the unobserved
  // -------------------------------------------------------------------------

  /**
   * What the *current* model expects from candidates that were never launched.
   *
   * This exists because "we would have launched 40 more things and we have no
   * idea what they would have done" is unhelpful, and because re-scoring past
   * feature vectors with today's model is the one legitimate use of the stored
   * features. It is not a revenue estimate and is kept in its own block, with
   * its own caveats, so it can never be mistaken for one.
   */
  private modelUnobserved(unobserved: readonly ReplayCandidate[]): ModelledProjection {
    const bundle = this.predictions.getBundle();
    const scorable = unobserved.filter((c) => c.features !== null);
    const scored = scorable.slice(0, MAX_MODELLED_CANDIDATES);

    let feesSum = 0;
    const medians: number[] = [];
    for (const candidate of scored) {
      const cached = this.rescoreCache.get(candidate.predictionId);
      const result =
        cached ??
        predictLaunch(bundle, candidate.features!, DEFAULT_ECONOMICS, `backtest:${candidate.predictionId}`);
      if (!cached) this.rescoreCache.set(candidate.predictionId, result);
      feesSum += result.creatorFeesSol.mean;
      medians.push(result.creatorFeesSol.median);
    }

    // When the scoring cap binds, scale to the full unobserved count rather
    // than reporting a partial total that reads like a complete one.
    const extrapolated = scored.length > 0 && scored.length < unobserved.length;
    const scale = scored.length > 0 ? unobserved.length / scored.length : 0;
    const modelledFeesSol = feesSum * scale;
    const modelledMedianFeesSol = medians.length > 0 ? median(medians) * unobserved.length : 0;
    const modelledCostSol = unobserved.length * (DEFAULT_ECONOMICS.launchCostSol + DEFAULT_ECONOMICS.candidateCostSol);

    const caveats = [...MODELLED_CAVEATS];
    if (scorable.length < unobserved.length) {
      caveats.push(
        `${unobserved.length - scorable.length} unobserved candidate(s) had no usable stored feature vector and could not be scored at all; the totals here are scaled from the ${scorable.length} that could.`,
      );
    }
    if (extrapolated) {
      caveats.push(
        `Only ${scored.length} of ${unobserved.length} unobserved candidates were re-scored; the totals are that subset scaled by ${scale.toFixed(2)}x.`,
      );
    }
    if (bundle.trainedOn < 30) {
      caveats.push(
        `The model has seen ${bundle.trainedOn} labelled outcome(s). At that sample size its predictions are essentially the hand-written domain priors it was seeded with, so this block is closer to an assumption than to a measurement.`,
      );
    }
    caveats.push(
      `The modelled mean is far above the modelled median (${modelledFeesSol.toFixed(4)} vs ${modelledMedianFeesSol.toFixed(4)} SOL in total) because fee outcomes are tail-driven. The median is what a typical candidate would have produced; the mean assumes the tail arrives on schedule.`,
    );

    return {
      label: 'MODELLED — no outcome was observed for these candidates',
      unobservedCandidates: unobserved.length,
      scoredCandidates: scored.length,
      extrapolated,
      modelVersion: bundle.version,
      modelTrainedOnOutcomes: bundle.trainedOn,
      modelledFeesSol,
      modelledMedianFeesSol,
      modelledCostSol,
      modelledNetSol: modelledFeesSol - modelledCostSol,
      caveats,
    };
  }

  // -------------------------------------------------------------------------
  // Distinguishability
  // -------------------------------------------------------------------------

  /**
   * Clustered bootstrap with common random numbers.
   *
   * Each resample draws launches from the shared observed pool once and scores
   * both strategies on that same resample, so launches the two strategies have
   * in common cancel out of the difference exactly as they should. The two are
   * called separable only when the 95% interval of the difference in realised
   * net excludes zero.
   */
  private bootstrapSeparation(
    universe: ReadonlyArray<{ launchId: string; netSol: number }>,
    a: ReadonlySet<string>,
    b: ReadonlySet<string>,
  ): { separable: boolean; note: string } {
    const exclusive = universe.filter((u) => a.has(u.launchId) !== b.has(u.launchId)).length;
    if (universe.length === 0 || exclusive === 0) {
      return {
        separable: false,
        note: 'The two strategies selected the same observed launches, so no realised evidence distinguishes them. Any difference in the table comes from unobserved candidates, which have no outcomes.',
      };
    }

    const rng = createRng(COMPARISON_SEED);
    const diffs: number[] = new Array(COMPARISON_BOOTSTRAP_DRAWS);
    for (let d = 0; d < COMPARISON_BOOTSTRAP_DRAWS; d++) {
      let netA = 0;
      let netB = 0;
      for (let i = 0; i < universe.length; i++) {
        const pick = universe[rng.int(0, universe.length)];
        if (!pick) continue;
        if (a.has(pick.launchId)) netA += pick.netSol;
        if (b.has(pick.launchId)) netB += pick.netSol;
      }
      diffs[d] = netA - netB;
    }

    const values = diffs.map((v) => v ?? 0);
    const lower = quantile(values, 0.025);
    const upper = quantile(values, 0.975);
    const separable = lower > 0 || upper < 0;

    return {
      separable,
      note: separable
        ? `Separable: the 95% bootstrap interval for the difference in realised net is ${lower.toFixed(4)} to ${upper.toFixed(4)} SOL and excludes zero, on ${exclusive} launch(es) the two strategies do not share.`
        : `Indistinguishable: the 95% bootstrap interval for the difference in realised net is ${lower.toFixed(4)} to ${upper.toFixed(4)} SOL and spans zero. ${exclusive} launch(es) differ between the two strategies, which is not enough to resolve them.`,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Summarise a heavy-tailed quantity.
 *
 * The mean of a token-fee sample is not a typical outcome and reporting it
 * alone is the single most misleading thing this file could do: in a sample
 * where one launch produced 90% of the revenue, the mean describes no launch
 * that happened. Median, percentiles and the top-1/5/10% contribution shares
 * together say what the mean cannot, namely how much of the total rests on how
 * few observations.
 */
function summariseSkew(values: readonly number[]): SkewSummary {
  const total = values.reduce((a, b) => a + b, 0);
  // Contribution shares are only meaningful over non-negative magnitudes; a
  // negative net (a launch that cost more than it earned) would otherwise make
  // a "share of total" exceed one or flip sign.
  const magnitudes = values.map((v) => Math.max(0, v));
  return {
    n: values.length,
    totalSol: total,
    meanSol: meanOf(values),
    medianSol: median(values),
    p10Sol: quantile(values, 0.1),
    p25Sol: quantile(values, 0.25),
    p75Sol: quantile(values, 0.75),
    p90Sol: quantile(values, 0.9),
    p99Sol: quantile(values, 0.99),
    maxSol: values.length > 0 ? Math.max(...values) : 0,
    top1PercentShare: topShare(magnitudes, 0.01),
    top5PercentShare: topShare(magnitudes, 0.05),
    top10PercentShare: topShare(magnitudes, 0.1),
    gini: gini(magnitudes),
  };
}

/** UTC calendar day, which is the boundary the live daily launch cap uses. */
function utcDayKey(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

/**
 * Poisson draw. Knuth's product method underflows once `exp(-lambda)` reaches
 * the denormal range, so above lambda 30 the normal approximation is used —
 * its error there is far smaller than the bootstrap noise it is added to.
 */
function poisson(rng: Rng, lambda: number): number {
  if (!(lambda > 0)) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * rng.normal()));
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng.next();
  } while (p > limit);
  return k - 1;
}
