import {
  BASE_RATES,
  LaunchFeatures,
  PREDICTION_HEADS,
  TIME,
  auc,
  betaPosterior,
  brierScore,
  calibrationBins,
  clamp,
  encodeFeatures,
  lamportsToSol,
  logLoss,
  mean,
  neutralFeatures,
  predictProbability,
  shrinkPrediction,
  updateLinearModel,
  updateLogNormalModel,
  wilsonInterval,
  type PredictionHead,
  type SuccessModelBundle,
} from '@solcoin/shared';
import { AppError } from '../core/errors.js';
import type { EventBus } from '../core/events.js';
import { newId } from '../core/ids.js';
import { parseJson } from '../core/json.js';
import { componentLogger } from '../core/logger.js';
import type { Db } from '../db/client.js';
import type { PredictionService } from './prediction.service.js';

/**
 * The prediction-versus-reality learning loop.
 *
 * This service is the only place where the platform is allowed to claim it has
 * learned something, so the bar for that claim is set deliberately high:
 *
 *  - An outcome is recorded only once its horizon has genuinely elapsed.
 *    Measuring a 168-hour outcome at hour 20 does not produce a noisy label, it
 *    produces a *systematically wrong* one — almost every token looks like a
 *    failure four hours in — and a model trained on those labels learns that
 *    nothing ever works.
 *  - Labels that cannot be measured are stored as NULL, never as zero. A silent
 *    zero is indistinguishable from a measured failure once it is in the table.
 *  - A model update is validated on a held-out, temporally later split before it
 *    is allowed to become the active model. An online update that degrades
 *    calibration is strictly worse than no update at all: it keeps the same
 *    interface, keeps the same confidence, and is wrong more often.
 *  - Every rate this service reports arrives with its sample size and an
 *    interval. Nothing here reports 1/1 as 100%.
 */

/**
 * Outcome horizons.
 *
 * 24h captures whether anyone showed up at all — the decision most launches are
 * settled by. 72h captures the realistic window in which a meme token either
 * compounds or dies. 168h is the point past which essentially no pump.fun token
 * that has not already graduated ever does; it is the terminal label.
 */
export const STANDARD_HORIZON_HOURS = [24, 72, 168] as const;

/**
 * Recency half-life for training weights.
 *
 * The market regime — launch rate, bot behaviour, who is buying — turns over in
 * weeks, not years. A launch from three months ago is genuine evidence but it is
 * evidence about a different market, so it is worth roughly an eighth of a
 * launch from last week. Thirty days is short enough to track the regime and
 * long enough that a quiet fortnight does not erase the model's memory.
 */
const RECENCY_HALF_LIFE_MS = 30 * TIME.day;

/** Below this, a calibration verdict would be describing noise, not the model. */
const MIN_VERDICT_SAMPLES = 20;

/** Below this, the observed base rate is less trustworthy than the domain prior. */
const MIN_BASE_RATE_SAMPLES = 30;

/** Default floor for a training run; ~6 of these land in the validation split. */
const DEFAULT_MIN_SAMPLES = 24;

/** Most recent quarter of samples is held out — see the temporal-split comment. */
const HOLDOUT_FRACTION = 0.25;

/** A validation set smaller than this cannot distinguish an improvement from luck. */
const MIN_HOLDOUT_SAMPLES = 6;

/** Design-vector width for the current encoder; stored models must match it. */
const ENCODED_FEATURE_WIDTH = encodeFeatures(neutralFeatures()).values.length;

// ---------------------------------------------------------------------------
// Public result shapes
// ---------------------------------------------------------------------------

export interface HeadMetrics {
  /** Labelled samples for this head. */
  n: number;
  logLoss: number;
  brier: number;
  /** 0.5 when one class is absent — AUC is undefined without both. */
  auc: number;
  meanPredicted: number;
  observedRate: number;
}

export interface BundleMetrics {
  samples: number;
  /** Mean log loss across heads that had labels; the activation criterion. */
  meanLogLoss: number;
  byHead: Record<PredictionHead, HeadMetrics>;
}

export interface TrainingResult {
  trained: boolean;
  version: string;
  samples: number;
  metricsBefore: BundleMetrics | null;
  metricsAfter: BundleMetrics | null;
  activated: boolean;
  reason: string;
}

export type CalibrationVerdict =
  | 'well calibrated'
  | 'overconfident'
  | 'underconfident'
  | 'insufficient data';

export interface HeadCalibration extends HeadMetrics {
  head: PredictionHead;
  /** Wilson interval on the realised frequency, at 95%. */
  observedLower: number;
  observedUpper: number;
  verdict: CalibrationVerdict;
  explanation: string;
  bins: Array<{ binLower: number; binUpper: number; n: number; predicted: number; observed: number }>;
}

export interface CalibrationReport {
  /** The model version evaluated, or 'all' when every version is pooled. */
  modelVersion: string;
  generatedAt: number;
  /** Launches contributing at least one label. */
  n: number;
  heads: HeadCalibration[];
  note: string;
}

export interface PredictionError {
  predictionId: string;
  outcomeId: string;
  conceptId: string | null;
  tokenMint: string | null;
  name: string | null;
  symbol: string | null;
  modelVersion: string;
  predictedAt: number;
  horizonHours: number;
  predicted: Record<PredictionHead, number>;
  actual: Record<PredictionHead, 0 | 1 | null>;
  /** predicted − actual, per head. Positive means the model was too optimistic. */
  signedError: Record<PredictionHead, number | null>;
  expectedCreatorFeesSol: number;
  actualCreatorFeesSol: number | null;
  /** actual − expected. Positive means the launch beat the forecast. */
  creatorFeesErrorSol: number | null;
  expectedVolume24hSol: number;
  actualVolume24hSol: number | null;
  peakHolders: number | null;
  explanation: string;
}

export interface ObservedRate {
  /** The rate to use. Either measured, or the domain prior when evidence is thin. */
  rate: number;
  lower: number;
  upper: number;
  /** Samples backing `rate`. Zero when `rate` is a prior — a prior has no sample. */
  n: number;
  /** Labels actually observed, whether or not they were enough to be used. */
  observedN: number;
  successes: number;
  sufficient: boolean;
  source: 'observed' | 'prior';
}

export interface ObservedBaseRates {
  first_buy: ObservedRate;
  ten_holders: ObservedRate;
  hundred_holders: ObservedRate;
  graduation: ObservedRate;
  /** Labelled launches available. Zero when none of the heads reached threshold. */
  n: number;
  sufficient: boolean;
  reason: string;
}

export interface WeightShift {
  head: string;
  feature: string;
  label: string;
  /** The encoded domain prior this weight started at. */
  before: number;
  /** The weight the model holds now. */
  after: number;
  delta: number;
  reading: string;
}

export interface LearningSummary {
  modelVersion: string;
  modelCreatedAt: number;
  /** Labelled outcomes folded into the active bundle. */
  trainedOn: number;
  outcomes: {
    total: number;
    applied: number;
    pending: number;
    byHorizon: Array<{ horizonHours: number; n: number }>;
    labelledLaunches: number;
  };
  calibration: Array<{ head: PredictionHead; n: number; verdict: CalibrationVerdict; explanation: string }>;
  baseRates: ObservedBaseRates;
  movedWeights: WeightShift[];
  /** How much of this to believe, stated plainly. */
  trust: string;
}

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

type Label = 0 | 1 | null;

interface LabelledSample {
  outcomeId: string;
  predictionId: string;
  conceptId: string | null;
  tokenMint: string | null;
  modelVersion: string;
  horizonHours: number;
  predictedAt: number;
  /** Encoded design vector, rebuilt from the features stored at decision time. */
  x: number[];
  /** Recency weight; see RECENCY_HALF_LIFE_MS. */
  weight: number;
  labels: Record<PredictionHead, Label>;
  /** The probabilities the platform actually published for this launch. */
  predicted: Record<PredictionHead, number>;
  volume24hSol: number | null;
  lifespanHours: number | null;
  /** True when the token was still alive at the horizon, so lifespan is a floor. */
  lifespanCensored: boolean;
  creatorFeesSol: number | null;
  expectedCreatorFeesSol: number;
  expectedVolume24hSol: number;
  drivers: Driver[];
}

interface Driver {
  feature: string;
  value: number;
  weight: number;
  contribution: number;
}

interface LaunchRow {
  prediction_id: string;
  confirmed_at: number;
  mint: string;
  first_trade_at: number | null;
  last_trade_at: number | null;
  graduated_at: number | null;
  dormant_at: number | null;
  lifecycle: string;
  peak_holders: number;
  peak_volume_24h_sol: number;
  creator_fees_accrued_lamports: number;
  creator_fees_collected_lamports: number;
  last_fee_check_at: number | null;
  token_updated_at: number;
  /** Lifetime observation count; zero means this token was never polled. */
  obs_total: number;
}

export class LearningService {
  private readonly log = componentLogger('learning');

  constructor(
    private readonly db: Db,
    private readonly predictions: PredictionService,
    private readonly events: EventBus,
    private readonly now: () => number = Date.now,
  ) {}

  // -------------------------------------------------------------------------
  // 1. Outcome recording
  // -------------------------------------------------------------------------

  /**
   * Measure realised outcomes for every launch whose `horizonHours` window has
   * fully elapsed and that has no outcome row at that horizon yet.
   *
   * Everything is measured *as of the horizon boundary*, not as of now, so an
   * outcome recorded late reads exactly the same as one recorded on time. That
   * is what makes the 24h and 168h labels comparable across a backfill.
   */
  async recordOutcomes(options: { horizonHours: number }): Promise<{ recorded: number }> {
    const horizonHours = options.horizonHours;
    if (!Number.isFinite(horizonHours) || horizonHours <= 0) {
      throw new AppError('validation_failed', `horizonHours must be a positive number, received ${String(horizonHours)}`);
    }
    const horizonMs = horizonHours * TIME.hour;
    const at = this.now();
    // The guard that matters: a launch only becomes eligible once the entire
    // window sits in the past. Anything confirmed after this cutoff would be
    // labelled on a partially observed window.
    const cutoff = at - horizonMs;

    const candidates = this.db.$raw
      .prepare(
        `SELECT l.prediction_id      AS prediction_id,
                l.confirmed_at       AS confirmed_at,
                t.mint               AS mint,
                t.first_trade_at     AS first_trade_at,
                t.last_trade_at      AS last_trade_at,
                t.graduated_at       AS graduated_at,
                t.dormant_at         AS dormant_at,
                t.lifecycle          AS lifecycle,
                t.peak_holders       AS peak_holders,
                t.peak_volume_24h_sol AS peak_volume_24h_sol,
                t.creator_fees_accrued_lamports   AS creator_fees_accrued_lamports,
                t.creator_fees_collected_lamports AS creator_fees_collected_lamports,
                t.last_fee_check_at  AS last_fee_check_at,
                t.updated_at         AS token_updated_at,
                (SELECT COUNT(*) FROM market_observations mo WHERE mo.token_mint = t.mint) AS obs_total
           FROM launches l
           JOIN tokens t ON t.launch_id = l.id
          WHERE l.status = 'confirmed'
            AND l.prediction_id IS NOT NULL
            AND l.confirmed_at IS NOT NULL
            AND l.confirmed_at <= ?
            AND NOT EXISTS (
                  SELECT 1 FROM prediction_outcomes po
                   WHERE po.prediction_id = l.prediction_id
                     AND po.horizon_hours = ?)
          ORDER BY l.confirmed_at ASC`,
      )
      .all(cutoff, horizonHours) as unknown as LaunchRow[];

    if (candidates.length === 0) return { recorded: 0 };

    // Peak holders and trading evidence inside the outcome window.
    const windowStats = this.db.$raw.prepare(
      `SELECT COUNT(*)                          AS n,
              MAX(holders)                      AS peak_holders,
              MAX(COALESCE(volume_24h_sol, 0))  AS peak_volume,
              MAX(COALESCE(tx_count_24h, 0))    AS peak_tx,
              MAX(COALESCE(buys_24h, 0))        AS peak_buys
         FROM market_observations
        WHERE token_mint = ? AND observed_at >= ? AND observed_at <= ?`,
    );

    const insert = this.db.$raw.prepare(
      `INSERT INTO prediction_outcomes
         (id, prediction_id, token_mint, horizon_hours, y_first_buy, y_ten_holders, y_hundred_holders,
          y_graduation, actual_volume_24h_sol, actual_creator_fees_sol, actual_lifespan_hours,
          applied_to_model, applied_model_version, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,NULL,?)
       ON CONFLICT(prediction_id, horizon_hours) DO NOTHING`,
    );

    let recorded = 0;
    this.db.$raw.transaction(() => {
      for (const row of candidates) {
        const confirmedAt = asNumber(row.confirmed_at);
        const windowEnd = confirmedAt + horizonMs;
        // Defence in depth: the SQL cutoff should already guarantee this, but a
        // clock that moved backwards or a hand-edited confirmed_at must never
        // produce a label measured over a window that has not happened yet.
        if (windowEnd > at) {
          this.log.warn(
            { mint: row.mint, horizonHours, windowEnd, at },
            'skipping outcome whose horizon has not elapsed',
          );
          continue;
        }

        const stats = windowStats.get(row.mint, confirmedAt, windowEnd) as
          | { n: number; peak_holders: number | null; peak_volume: number | null; peak_tx: number | null; peak_buys: number | null }
          | undefined;
        // Volume is a 24h rolling figure, so the volume label is always measured
        // over the first day regardless of the label horizon. That keeps the
        // volume head's target identical across the 24/72/168 rows for one launch.
        const volumeWindowEnd = Math.min(confirmedAt + 24 * TIME.hour, windowEnd);
        const volumeStats =
          volumeWindowEnd > confirmedAt
            ? (windowStats.get(row.mint, confirmedAt, volumeWindowEnd) as
                | { n: number; peak_volume: number | null }
                | undefined)
            : undefined;

        const observedInWindow = asNumber(stats?.n);
        const peakHoldersInWindow = observedInWindow > 0 ? asNumber(stats?.peak_holders) : null;
        const tradedInWindow =
          observedInWindow > 0 &&
          (asNumber(stats?.peak_volume) > 0 || asNumber(stats?.peak_tx) > 0 || asNumber(stats?.peak_buys) > 0);

        const firstTradeAt = asNumberOrNull(row.first_trade_at);
        const lastTradeAt = asNumberOrNull(row.last_trade_at);
        const graduatedAt = asNumberOrNull(row.graduated_at);
        const tokenUpdatedAt = asNumber(row.token_updated_at);
        const peakHoldersNow = asNumber(row.peak_holders);

        // First trade and graduation are monotone one-way events with recorded
        // timestamps, so their labels are exact at any horizon. The one case that
        // must not be labelled is a token that was never polled at all: an
        // absent first_trade_at then means "nobody looked", not "nobody bought".
        const obsTotal = asNumber(row.obs_total);
        const yFirstBuy: Label =
          firstTradeAt !== null
            ? firstTradeAt <= windowEnd || tradedInWindow
              ? 1
              : 0
            : tradedInWindow
              ? 1
              : obsTotal > 0
                ? 0
                : null;
        const yGraduation: Label =
          graduatedAt !== null && graduatedAt <= windowEnd ? 1 : obsTotal > 0 || firstTradeAt !== null ? 0 : null;

        // Holder peaks come from the observation series inside the window. When
        // the series is empty we can still label honestly in two cases, both of
        // which rely on peak_holders being monotone non-decreasing over time:
        // a current peak of zero means the peak was zero then too, and a token
        // untouched since before the window boundary carries its window value.
        const holderPeak =
          peakHoldersInWindow !== null
            ? peakHoldersInWindow
            : obsTotal === 0
              ? null
              : peakHoldersNow === 0 || tokenUpdatedAt <= windowEnd
                ? peakHoldersNow
                : null;
        const yTenHolders: Label = holderPeak === null ? null : holderPeak >= 10 ? 1 : 0;
        const yHundredHolders: Label = holderPeak === null ? null : holderPeak >= 100 ? 1 : 0;

        const observedVolume = asNumber(volumeStats?.n) > 0 ? asNumber(volumeStats?.peak_volume) : null;
        // A token whose all-time peak 24h volume is zero had zero volume in the
        // first day too; that is a measurement, not a guess. Otherwise unknown.
        const actualVolume24hSol =
          observedVolume !== null
            ? observedVolume
            : obsTotal === 0 && firstTradeAt === null
              ? null
              : asNumber(row.peak_volume_24h_sol) === 0 || tokenUpdatedAt <= windowEnd
                ? asNumber(row.peak_volume_24h_sol)
                : null;

        // Fees are cumulative and monotone, so this is the amount earned to date
        // rather than strictly as of the horizon. Running the recorder close to
        // the boundary keeps the two the same; a long backfill will attribute a
        // little post-horizon revenue to the horizon, which is why the fee figure
        // is reported for the UI and used for the volume head only indirectly.
        const feeLamports =
          asNumber(row.creator_fees_collected_lamports) + asNumber(row.creator_fees_accrued_lamports);
        const actualCreatorFeesSol =
          feeLamports > 0 || row.last_fee_check_at !== null ? lamportsToSol(feeLamports) : null;

        // Lifespan is right-censored at the horizon: a token still trading at
        // hour 168 has a lifespan of *at least* 168 hours, not exactly 168.
        // train() detects and drops those samples rather than teaching the model
        // that every survivor dies precisely at the measurement boundary.
        const stillActive = row.dormant_at === null && row.lifecycle !== 'dormant' && row.lifecycle !== 'failed';
        let actualLifespanHours: number | null = null;
        if (firstTradeAt !== null && firstTradeAt <= windowEnd) {
          const endMs = stillActive ? windowEnd : Math.min(lastTradeAt ?? firstTradeAt, windowEnd);
          actualLifespanHours = clamp((endMs - firstTradeAt) / TIME.hour, 0, horizonHours);
        } else if (yFirstBuy === 0) {
          // Measured: it never traded, so it never lived.
          actualLifespanHours = 0;
        }

        const info = insert.run(
          newId('out', at),
          row.prediction_id,
          row.mint,
          horizonHours,
          yFirstBuy,
          yTenHolders,
          yHundredHolders,
          yGraduation,
          actualVolume24hSol,
          actualCreatorFeesSol,
          actualLifespanHours,
          at,
        );
        if (info.changes > 0) recorded++;
      }
    })();

    if (recorded > 0) {
      this.log.info({ horizonHours, recorded }, 'recorded realised launch outcomes');
    }
    return { recorded };
  }

  // -------------------------------------------------------------------------
  // 2. Training
  // -------------------------------------------------------------------------

  /**
   * Fold unapplied outcomes into the model, but only if doing so demonstrably
   * helps.
   *
   * The procedure is: split the samples temporally, apply the online update to
   * the older portion, score the old and new bundles on the newer portion, and
   * accept the update only if log loss did not get worse. If it is accepted, the
   * *shipped* bundle is then refit from the original weights over every sample,
   * so no evidence is wasted — the held-out split decides whether to update, not
   * what the final weights are.
   */
  async train(options: { minSamples?: number } = {}): Promise<TrainingResult> {
    const minSamples = Math.max(2, options.minSamples ?? DEFAULT_MIN_SAMPLES);
    const bundle = this.predictions.getBundle();
    const samples = this.loadSamples({ unappliedOnly: true, bundle });

    if (samples.length < minSamples) {
      return {
        trained: false,
        version: bundle.version,
        samples: samples.length,
        metricsBefore: null,
        metricsAfter: null,
        activated: false,
        reason: `only ${samples.length} unapplied labelled outcome${samples.length === 1 ? '' : 's'}; ${minSamples} required before an update is meaningful`,
      };
    }

    // Temporal split. Random splitting would leak the current regime into the
    // validation set and flatter every update; the question being asked is
    // "does this update help on launches the update has not seen yet", which is
    // a question about later launches specifically.
    const holdoutSize = Math.max(MIN_HOLDOUT_SAMPLES, Math.round(samples.length * HOLDOUT_FRACTION));
    if (samples.length - holdoutSize < 2 || holdoutSize < MIN_HOLDOUT_SAMPLES) {
      return {
        trained: false,
        version: bundle.version,
        samples: samples.length,
        metricsBefore: null,
        metricsAfter: null,
        activated: false,
        reason: `${samples.length} samples cannot be split into a trainable set and a validation set of at least ${MIN_HOLDOUT_SAMPLES}`,
      };
    }
    const trainSplit = samples.slice(0, samples.length - holdoutSize);
    const holdout = samples.slice(samples.length - holdoutSize);

    const metricsBefore = scoreBundle(bundle, holdout);
    const candidate = this.applyUpdates(bundle, trainSplit, `${bundle.version}+candidate`);
    const metricsAfter = scoreBundle(candidate, holdout);

    if (metricsBefore.samples === 0 || metricsAfter.samples === 0) {
      return {
        trained: false,
        version: bundle.version,
        samples: samples.length,
        metricsBefore,
        metricsAfter,
        activated: false,
        reason: 'the validation split carried no usable labels, so the update could not be checked',
      };
    }

    // Tolerance covers float noise only. Anything that genuinely raises log loss
    // is rejected: a miscalibrated model is worse than a stale one because it
    // still speaks with the same confidence, and downstream gates act on it.
    const improved = metricsAfter.meanLogLoss <= metricsBefore.meanLogLoss + 1e-6;
    const totalTrained = bundle.trainedOn + samples.length;
    const version = `v2-trained-${totalTrained}`;

    if (!improved) {
      const delta = metricsAfter.meanLogLoss - metricsBefore.meanLogLoss;
      // The rejected candidate is still persisted (inactive) so the decision is
      // auditable, and the outcomes stay unapplied so a later, larger batch can
      // try again with the same evidence.
      this.predictions.saveBundle(
        { ...candidate, version, createdAt: this.now(), trainedOn: totalTrained },
        {
          activate: false,
          notes: `Rejected: held-out log loss rose from ${metricsBefore.meanLogLoss.toFixed(4)} to ${metricsAfter.meanLogLoss.toFixed(4)}.`,
          metrics: { before: metricsBefore, after: metricsAfter, holdout: holdout.length },
        },
      );
      return {
        trained: true,
        version: bundle.version,
        samples: samples.length,
        metricsBefore,
        metricsAfter,
        activated: false,
        reason: `update rejected: held-out log loss worsened by ${delta.toFixed(4)} (${metricsBefore.meanLogLoss.toFixed(4)} → ${metricsAfter.meanLogLoss.toFixed(4)}) on ${holdout.length} launches`,
      };
    }

    // Accepted. Refit from the original weights over every sample so the held-out
    // launches contribute to the shipped model too.
    const shipped = this.applyUpdates(bundle, samples, version);
    shipped.createdAt = this.now();
    shipped.trainedOn = totalTrained;

    // Replace the hand-set base rates with measured ones once there is enough
    // evidence. These drive the small-sample shrinkage in predictLaunch, so a
    // wrong base rate quietly biases every prediction.
    const observed = await this.observedBaseRates();
    for (const head of PREDICTION_HEADS) {
      const rate = observed[head];
      if (rate.source === 'observed') shipped.baseRates[head] = clamp(rate.rate, 0.0005, 0.999);
    }

    this.predictions.saveBundle(shipped, {
      activate: true,
      notes: `Trained on ${samples.length} outcomes (${trainSplit.length} fit / ${holdout.length} validated). Held-out log loss ${metricsBefore.meanLogLoss.toFixed(4)} → ${metricsAfter.meanLogLoss.toFixed(4)}. Shipped weights are refit over all ${samples.length} samples.`,
      metrics: { before: metricsBefore, after: metricsAfter, holdout: holdout.length, shippedOn: samples.length },
    });

    this.markApplied(samples.map((s) => s.predictionId), version);

    this.events.emit('model.retrained', {
      version,
      trainedOn: totalTrained,
      logLoss: metricsAfter.meanLogLoss,
    });
    this.log.info(
      { version, samples: samples.length, before: metricsBefore.meanLogLoss, after: metricsAfter.meanLogLoss },
      'activated a retrained model bundle',
    );

    return {
      trained: true,
      version,
      samples: samples.length,
      metricsBefore,
      metricsAfter,
      activated: true,
      reason: `held-out log loss improved from ${metricsBefore.meanLogLoss.toFixed(4)} to ${metricsAfter.meanLogLoss.toFixed(4)} on ${holdout.length} launches`,
    };
  }

  // -------------------------------------------------------------------------
  // 3. Calibration
  // -------------------------------------------------------------------------

  /**
   * Score the probabilities the platform actually published against what
   * happened. Omit `modelVersion` to pool every version.
   *
   * Calibration is judged by comparing the mean predicted probability with the
   * realised frequency, using a Wilson interval on the frequency so that normal
   * sampling noise is not reported as miscalibration. "Overconfident" here means
   * predicting higher probabilities than reality delivered.
   */
  async evaluate(modelVersion?: string): Promise<CalibrationReport> {
    const bundle = this.predictions.getBundle();
    const samples = this.loadSamples({ unappliedOnly: false, bundle, modelVersion });
    const heads: HeadCalibration[] = [];

    for (const head of PREDICTION_HEADS) {
      const pairs = samples
        .filter((s) => s.labels[head] !== null)
        .map((s) => ({ p: s.predicted[head], y: s.labels[head] as 0 | 1 }));
      const n = pairs.length;
      const successes = pairs.reduce((acc, d) => acc + d.y, 0);
      const meanPredicted = n > 0 ? mean(pairs.map((d) => d.p)) : 0;
      const interval = wilsonInterval(successes, n);

      let verdict: CalibrationVerdict = 'insufficient data';
      let explanation = `Only ${n} labelled launch${n === 1 ? '' : 'es'} for this outcome. At least ${MIN_VERDICT_SAMPLES} are needed before the difference between forecast and reality means anything.`;

      if (n >= MIN_VERDICT_SAMPLES) {
        const observedPct = (interval.point * 100).toFixed(1);
        const predictedPct = (meanPredicted * 100).toFixed(1);
        const rangePct = `${(interval.lower * 100).toFixed(1)}–${(interval.upper * 100).toFixed(1)}%`;
        if (meanPredicted > interval.upper) {
          verdict = 'overconfident';
          explanation = `The model averaged ${predictedPct}% but only ${observedPct}% happened (95% interval ${rangePct} over ${n} launches). It is promising more than the market delivers.`;
        } else if (meanPredicted < interval.lower) {
          verdict = 'underconfident';
          explanation = `The model averaged ${predictedPct}% and ${observedPct}% happened (95% interval ${rangePct} over ${n} launches). It is talking these launches down.`;
        } else {
          verdict = 'well calibrated';
          explanation = `The model averaged ${predictedPct}% and ${observedPct}% happened, inside the 95% interval ${rangePct} over ${n} launches.`;
        }
      }

      heads.push({
        head,
        n,
        logLoss: logLoss(pairs),
        brier: brierScore(pairs),
        auc: auc(pairs),
        meanPredicted,
        observedRate: interval.point,
        observedLower: interval.lower,
        observedUpper: interval.upper,
        verdict,
        explanation,
        bins: calibrationBins(pairs, 10),
      });
    }

    return {
      modelVersion: modelVersion ?? 'all',
      generatedAt: this.now(),
      n: samples.length,
      heads,
      note:
        samples.length === 0
          ? 'No launch has both a stored prediction and a measured outcome yet, so there is nothing to calibrate against.'
          : 'Each launch contributes once, at its longest elapsed horizon. Probabilities are the ones published at decision time, not re-scored with the current model.',
    };
  }

  // -------------------------------------------------------------------------
  // 4. Per-launch errors
  // -------------------------------------------------------------------------

  /**
   * Prediction versus reality for individual launches, newest first, each with
   * an explanation built from the feature contributions that were stored with
   * the prediction.
   */
  async predictionErrors(limit = 50): Promise<PredictionError[]> {
    const bundle = this.predictions.getBundle();
    const cap = clamp(Math.floor(limit), 1, 500);
    const samples = this.loadSamples({ unappliedOnly: false, bundle, newestFirst: true, limit: cap });
    if (samples.length === 0) return [];

    const mints = samples.map((s) => s.tokenMint).filter((m): m is string => typeof m === 'string' && m.length > 0);
    const meta = new Map<string, { name: string; symbol: string; peak_holders: number }>();
    if (mints.length > 0) {
      const rows = this.db.$raw
        .prepare(
          `SELECT mint, name, symbol, peak_holders FROM tokens WHERE mint IN (${mints.map(() => '?').join(',')})`,
        )
        .all(...mints) as unknown as Array<{ mint: string; name: string; symbol: string; peak_holders: number }>;
      for (const r of rows) meta.set(r.mint, { name: r.name, symbol: r.symbol, peak_holders: asNumber(r.peak_holders) });
    }

    return samples.map((s) => {
      const info = s.tokenMint ? meta.get(s.tokenMint) : undefined;
      const signedError = {} as Record<PredictionHead, number | null>;
      for (const head of PREDICTION_HEADS) {
        const y = s.labels[head];
        signedError[head] = y === null ? null : s.predicted[head] - y;
      }
      return {
        predictionId: s.predictionId,
        outcomeId: s.outcomeId,
        conceptId: s.conceptId,
        tokenMint: s.tokenMint,
        name: info?.name ?? null,
        symbol: info?.symbol ?? null,
        modelVersion: s.modelVersion,
        predictedAt: s.predictedAt,
        horizonHours: s.horizonHours,
        predicted: s.predicted,
        actual: s.labels,
        signedError,
        expectedCreatorFeesSol: s.expectedCreatorFeesSol,
        actualCreatorFeesSol: s.creatorFeesSol,
        creatorFeesErrorSol: s.creatorFeesSol === null ? null : s.creatorFeesSol - s.expectedCreatorFeesSol,
        expectedVolume24hSol: s.expectedVolume24hSol,
        actualVolume24hSol: s.volume24hSol,
        peakHolders: info?.peak_holders ?? null,
        explanation: explainOutcome(s, info?.peak_holders ?? null),
      };
    });
  }

  // -------------------------------------------------------------------------
  // 5. Observed base rates
  // -------------------------------------------------------------------------

  /**
   * The realised base rates, which replace the hand-set priors once there is
   * enough evidence to beat them.
   *
   * The posterior is anchored on the domain prior with a pseudo-count of 20, so
   * a run of four lucky launches cannot move the graduation rate from 1.2% to
   * 100%. Until a head clears MIN_BASE_RATE_SAMPLES, the prior is returned
   * verbatim with n = 0 — a prior is backed by no samples and must never be read
   * as a measurement. The true count stays visible in `observedN`.
   */
  async observedBaseRates(): Promise<ObservedBaseRates> {
    const bundle = this.predictions.getBundle();
    const samples = this.loadSamples({ unappliedOnly: false, bundle });
    const priors: Record<PredictionHead, number> = {
      first_buy: BASE_RATES.firstBuy,
      ten_holders: BASE_RATES.tenHolders,
      hundred_holders: BASE_RATES.hundredHolders,
      graduation: BASE_RATES.graduation,
    };
    const priorStrength = 20;

    const build = (head: PredictionHead): ObservedRate => {
      const labelled = samples.filter((s) => s.labels[head] !== null);
      const observedN = labelled.length;
      const successes = labelled.reduce((acc, s) => acc + (s.labels[head] as 0 | 1), 0);
      const prior = priors[head];
      if (observedN < MIN_BASE_RATE_SAMPLES) {
        return {
          rate: prior,
          lower: 0,
          upper: 1,
          n: 0,
          observedN,
          successes,
          sufficient: false,
          source: 'prior',
        };
      }
      const posterior = betaPosterior(successes, observedN, prior * priorStrength, (1 - prior) * priorStrength);
      return {
        rate: posterior.mean,
        lower: posterior.lower,
        upper: posterior.upper,
        n: observedN,
        observedN,
        successes,
        sufficient: true,
        source: 'observed',
      };
    };

    const first_buy = build('first_buy');
    const ten_holders = build('ten_holders');
    const hundred_holders = build('hundred_holders');
    const graduation = build('graduation');
    const sufficient = first_buy.sufficient || ten_holders.sufficient || hundred_holders.sufficient || graduation.sufficient;

    return {
      first_buy,
      ten_holders,
      hundred_holders,
      graduation,
      n: sufficient ? samples.length : 0,
      sufficient,
      reason: sufficient
        ? `Measured over ${samples.length} launches with realised outcomes.`
        : `Only ${samples.length} launch${samples.length === 1 ? '' : 'es'} have measured outcomes; ${MIN_BASE_RATE_SAMPLES} are required per outcome before an observed rate replaces the prior. The values returned are the encoded priors.`,
    };
  }

  // -------------------------------------------------------------------------
  // 6. Dashboard summary
  // -------------------------------------------------------------------------

  /** What the model has learned so far, and how much of it to believe. */
  async summary(): Promise<LearningSummary> {
    const bundle = this.predictions.getBundle();
    const [calibration, baseRates] = await Promise.all([this.evaluate(), this.observedBaseRates()]);

    const counts = this.db.$raw
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN applied_to_model = 1 THEN 1 ELSE 0 END) AS applied,
                COUNT(DISTINCT prediction_id) AS launches
           FROM prediction_outcomes`,
      )
      .get() as { total: number; applied: number | null; launches: number } | undefined;
    const byHorizon = this.db.$raw
      .prepare(
        `SELECT horizon_hours AS horizonHours, COUNT(*) AS n
           FROM prediction_outcomes GROUP BY horizon_hours ORDER BY horizon_hours ASC`,
      )
      .all() as unknown as Array<{ horizonHours: number; n: number }>;

    const total = asNumber(counts?.total);
    const applied = asNumber(counts?.applied);

    return {
      modelVersion: bundle.version,
      modelCreatedAt: bundle.createdAt,
      trainedOn: bundle.trainedOn,
      outcomes: {
        total,
        applied,
        pending: Math.max(0, total - applied),
        byHorizon: byHorizon.map((r) => ({ horizonHours: asNumber(r.horizonHours), n: asNumber(r.n) })),
        labelledLaunches: asNumber(counts?.launches),
      },
      calibration: calibration.heads.map((h) => ({
        head: h.head,
        n: h.n,
        verdict: h.verdict,
        explanation: h.explanation,
      })),
      baseRates,
      movedWeights: movedWeights(bundle, 8),
      trust: trustStatement(bundle, calibration, baseRates),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Load labelled samples, one row per launch.
   *
   * A launch has up to three outcome rows (24/72/168h) describing the same
   * event, so training on all of them would triple its influence and mix
   * contradictory labels. Only the longest *available* horizon is used: it is a
   * strictly more informative version of the shorter ones ("did it ever reach a
   * hundred holders" subsumes "had it after a day").
   */
  private loadSamples(options: {
    unappliedOnly: boolean;
    bundle: SuccessModelBundle;
    modelVersion?: string;
    newestFirst?: boolean;
    limit?: number;
  }): LabelledSample[] {
    const unappliedFilter = options.unappliedOnly ? 'AND h.applied_to_model = 0' : '';
    const clauses = [`po.horizon_hours = (SELECT MAX(h.horizon_hours) FROM prediction_outcomes h
                        WHERE h.prediction_id = po.prediction_id ${unappliedFilter})`];
    const params: unknown[] = [];
    if (options.unappliedOnly) clauses.push('po.applied_to_model = 0');
    if (options.modelVersion) {
      clauses.push('p.model_version = ?');
      params.push(options.modelVersion);
    }

    const sql = `SELECT po.id AS outcome_id, po.prediction_id, po.token_mint, po.horizon_hours,
                        po.y_first_buy, po.y_ten_holders, po.y_hundred_holders, po.y_graduation,
                        po.actual_volume_24h_sol, po.actual_creator_fees_sol, po.actual_lifespan_hours,
                        p.concept_id, p.features, p.model_version, p.drivers,
                        p.created_at AS predicted_at,
                        p.p_first_buy, p.p_ten_holders, p.p_hundred_holders, p.p_graduation,
                        p.expected_creator_fees_sol, p.expected_volume_24h_sol
                   FROM prediction_outcomes po
                   JOIN predictions p ON p.id = po.prediction_id
                  WHERE ${clauses.join(' AND ')}
                  ORDER BY p.created_at ${options.newestFirst ? 'DESC' : 'ASC'}
                  ${options.limit ? `LIMIT ${Math.floor(options.limit)}` : ''}`;

    const rows = this.db.$raw.prepare(sql).all(...params) as unknown as Array<Record<string, unknown>>;
    const at = this.now();
    const expectedWidth = ENCODED_FEATURE_WIDTH;
    const out: LabelledSample[] = [];

    for (const row of rows) {
      const parsed = LaunchFeatures.safeParse(parseJson<unknown>(row.features as string, null));
      if (!parsed.success) {
        // Skipping is the only honest option: substituting neutral features
        // would invent a decision the model never made.
        this.log.warn({ predictionId: row.prediction_id }, 'stored feature vector is unreadable; sample skipped');
        continue;
      }
      const encoded = encodeFeatures(parsed.data);
      if (encoded.values.length !== expectedWidth || encoded.values.length !== options.bundle.volume24h.weights.length) {
        this.log.warn(
          { predictionId: row.prediction_id, width: encoded.values.length, expected: options.bundle.volume24h.weights.length },
          'feature vector width does not match the model bundle; sample skipped',
        );
        continue;
      }

      const predictedAt = asNumber(row.predicted_at, at);
      const ageMs = Math.max(0, at - predictedAt);
      const horizonHours = asNumber(row.horizon_hours);
      const lifespan = asNumberOrNull(row.actual_lifespan_hours);

      out.push({
        outcomeId: String(row.outcome_id),
        predictionId: String(row.prediction_id),
        conceptId: row.concept_id === null || row.concept_id === undefined ? null : String(row.concept_id),
        tokenMint: row.token_mint === null || row.token_mint === undefined ? null : String(row.token_mint),
        modelVersion: String(row.model_version ?? 'unknown'),
        horizonHours,
        predictedAt,
        x: encoded.values,
        weight: Math.pow(0.5, ageMs / RECENCY_HALF_LIFE_MS),
        labels: {
          first_buy: asLabel(row.y_first_buy),
          ten_holders: asLabel(row.y_ten_holders),
          hundred_holders: asLabel(row.y_hundred_holders),
          graduation: asLabel(row.y_graduation),
        },
        predicted: {
          first_buy: asNumber(row.p_first_buy),
          ten_holders: asNumber(row.p_ten_holders),
          hundred_holders: asNumber(row.p_hundred_holders),
          graduation: asNumber(row.p_graduation),
        },
        volume24hSol: asNumberOrNull(row.actual_volume_24h_sol),
        lifespanHours: lifespan,
        // The window edge means "still alive", not "died exactly now".
        lifespanCensored: lifespan !== null && horizonHours > 0 && lifespan >= horizonHours * 0.995,
        creatorFeesSol: asNumberOrNull(row.actual_creator_fees_sol),
        expectedCreatorFeesSol: asNumber(row.expected_creator_fees_sol),
        expectedVolume24hSol: asNumber(row.expected_volume_24h_sol),
        drivers: parseJson<Driver[]>(row.drivers as string, []),
      });
    }
    return out;
  }

  /** Online update of every head over `samples`, returning a new bundle. */
  private applyUpdates(base: SuccessModelBundle, samples: LabelledSample[], version: string): SuccessModelBundle {
    const classification = { ...base.classification };
    for (const head of PREDICTION_HEADS) {
      let state = base.classification[head];
      for (const s of samples) {
        const y = s.labels[head];
        if (y === null) continue;
        state = updateLinearModel(state, s.x, y, s.weight);
      }
      classification[head] = state;
    }

    let volume24h = base.volume24h;
    for (const s of samples) {
      // Only rows whose full 24h window elapsed carry a comparable volume label.
      if (s.volume24hSol === null || s.horizonHours < 24) continue;
      volume24h = updateLogNormalModel(volume24h, s.x, s.volume24hSol, s.weight);
    }

    let lifespanHours = base.lifespanHours;
    for (const s of samples) {
      // Censored survivors are dropped rather than clamped: feeding "lifespan =
      // 168h" for tokens that were merely still alive at the boundary would pin
      // the lifespan head to the measurement horizon instead of reality.
      if (s.lifespanHours === null || s.lifespanCensored) continue;
      lifespanHours = updateLogNormalModel(lifespanHours, s.x, s.lifespanHours, s.weight);
    }

    return {
      ...base,
      version,
      classification,
      volume24h,
      lifespanHours,
      baseRates: { ...base.baseRates },
    };
  }

  private markApplied(predictionIds: string[], version: string): void {
    const unique = [...new Set(predictionIds)];
    if (unique.length === 0) return;
    // Every unapplied row for a trained prediction is marked, not just the row
    // that was used, so a shorter horizon cannot be re-fed later as if it were
    // new evidence about the same launch.
    const chunkSize = 400;
    this.db.$raw.transaction(() => {
      for (let i = 0; i < unique.length; i += chunkSize) {
        const chunk = unique.slice(i, i + chunkSize);
        this.db.$raw
          .prepare(
            `UPDATE prediction_outcomes SET applied_to_model = 1, applied_model_version = ?
              WHERE applied_to_model = 0 AND prediction_id IN (${chunk.map(() => '?').join(',')})`,
          )
          .run(version, ...chunk);
      }
    })();
  }
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/**
 * Score a bundle on held-out samples.
 *
 * Probabilities are shrunk toward the base rate exactly as `predictLaunch` does,
 * because the comparison must be between the numbers the platform would actually
 * publish, not between raw logits nobody ever sees.
 */
function scoreBundle(bundle: SuccessModelBundle, samples: LabelledSample[]): BundleMetrics {
  const byHead = {} as Record<PredictionHead, HeadMetrics>;
  const headLosses: number[] = [];
  let scored = 0;

  for (const head of PREDICTION_HEADS) {
    const pairs: Array<{ p: number; y: 0 | 1 }> = [];
    for (const s of samples) {
      const y = s.labels[head];
      if (y === null) continue;
      const raw = predictProbability(bundle.classification[head], s.x);
      pairs.push({ p: shrinkPrediction(raw, bundle.trainedOn, bundle.baseRates[head]), y });
    }
    const n = pairs.length;
    const loss = logLoss(pairs);
    byHead[head] = {
      n,
      logLoss: loss,
      brier: brierScore(pairs),
      auc: auc(pairs),
      meanPredicted: n > 0 ? mean(pairs.map((d) => d.p)) : 0,
      observedRate: n > 0 ? mean(pairs.map((d) => d.y)) : 0,
    };
    if (n > 0) {
      headLosses.push(loss);
      scored = Math.max(scored, n);
    }
  }

  return { samples: scored, meanLogLoss: headLosses.length > 0 ? mean(headLosses) : 0, byHead };
}

const HEAD_LABELS: Record<PredictionHead, string> = {
  first_buy: 'any organic buyer',
  ten_holders: 'ten holders',
  hundred_holders: 'a hundred holders',
  graduation: 'graduation',
};

/**
 * Build the per-launch explanation from the contributions stored with the
 * prediction.
 *
 * `predictions.drivers` holds the decomposition of the ten-holders head, which
 * is the platform's headline call, so that head is explained whenever it has a
 * label. The text names the specific features that carried or sank the estimate
 * rather than restating the numbers.
 */
function explainOutcome(sample: LabelledSample, peakHolders: number | null): string {
  const head: PredictionHead =
    sample.labels.ten_holders !== null
      ? 'ten_holders'
      : (PREDICTION_HEADS.filter((h) => sample.labels[h] !== null).sort(
          (a, b) =>
            Math.abs(sample.predicted[b] - (sample.labels[b] as number)) -
            Math.abs(sample.predicted[a] - (sample.labels[a] as number)),
        )[0] ?? 'ten_holders');

  const y = sample.labels[head];
  const p = sample.predicted[head];
  const pct = `${(p * 100).toFixed(0)}%`;
  const outcomeLabel = HEAD_LABELS[head];

  if (y === null) {
    return `Predicted ${pct} chance of ${outcomeLabel}; the outcome could not be measured at the ${sample.horizonHours}h horizon, so this launch is not scored.`;
  }

  const drivers = [...sample.drivers].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const positives = drivers.filter((d) => d.contribution > 0);
  const negatives = drivers.filter((d) => d.contribution < 0);
  const reached =
    peakHolders !== null
      ? y === 1
        ? `it reached ${peakHolders} holders`
        : `it peaked at ${peakHolders} holder${peakHolders === 1 ? '' : 's'}`
      : y === 1
        ? 'it happened'
        : 'it did not happen';

  const opening = `Predicted ${pct} chance of ${outcomeLabel}; ${reached}`;
  const error = p - y;

  if (drivers.length === 0) {
    return `${opening} — no single feature stood out in this prediction; it sat close to the ${(p * 100).toFixed(0)}% base rate the model starts from.`;
  }

  // A miss in the pessimistic direction: whatever the model weighted against
  // this launch is the thing that was wrong about it.
  if (y === 1 && error < -0.15) {
    const drag = negatives[0];
    const lift = positives[0];
    if (drag) {
      return `${opening} — the model marked it down mostly for ${humanise(drag.feature)} (${drag.contribution.toFixed(2)} to the log-odds), and that read was wrong here${lift ? `; it under-weighted ${humanise(lift.feature)}, which is what actually carried it` : ''}.`;
    }
    return `${opening} — nothing in the feature vector flagged this one; ${lift ? `${humanise(lift.feature)} was its strongest signal and the model still under-weighted it` : 'the model simply started from too low a base rate'}.`;
  }

  // A miss in the optimistic direction: the features it leaned on did not pay.
  if (y === 0 && error > 0.15) {
    const lift = positives[0];
    const second = positives[1];
    if (lift) {
      return `${opening} — the estimate rested on ${humanise(lift.feature)} (+${lift.contribution.toFixed(2)} to the log-odds)${second ? ` and ${humanise(second.feature)} (+${second.contribution.toFixed(2)})` : ''}, neither of which translated into holders.`;
    }
    return `${opening} — the estimate came from the base rate rather than from any strong feature, and the base rate was too generous for this launch.`;
  }

  // The call was directionally right.
  const carrier = y === 1 ? positives[0] : negatives[0];
  if (carrier) {
    return `${opening} — the call was right, and ${humanise(carrier.feature)} (${carrier.contribution >= 0 ? '+' : ''}${carrier.contribution.toFixed(2)} to the log-odds) was what drove it.`;
  }
  return `${opening} — the call was right, though it came from the base rate rather than from any particular feature.`;
}

/** Features whose learned weights have drifted furthest from their priors. */
function movedWeights(bundle: SuccessModelBundle, topK: number): WeightShift[] {
  if (bundle.trainedOn === 0) return [];
  const shifts: WeightShift[] = [];

  // Both head types expose the same three arrays; only those are read here.
  const collect = (
    headKey: string,
    headLabel: string,
    model: { featureNames: string[]; weights: number[]; priorWeights: number[] },
  ): void => {
    for (let i = 0; i < model.featureNames.length; i++) {
      const feature = model.featureNames[i];
      const after = model.weights[i];
      const before = model.priorWeights[i];
      if (feature === undefined || after === undefined || before === undefined) continue;
      const delta = after - before;
      // Anything smaller is AdaGrad noise, not a change of mind.
      if (Math.abs(delta) < 0.02) continue;
      shifts.push({
        head: headKey,
        feature,
        label: humanise(feature),
        before,
        after,
        delta,
        reading: readWeightShift(humanise(feature), headLabel, before, after),
      });
    }
  };

  for (const head of PREDICTION_HEADS) collect(head, HEAD_LABELS[head], bundle.classification[head]);
  collect('volume24h', '24h volume', bundle.volume24h);

  return shifts.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, topK);
}

function readWeightShift(label: string, headLabel: string, before: number, after: number): string {
  const range = `${before.toFixed(2)} → ${after.toFixed(2)}`;
  if (before >= 0 && after < 0) {
    return `${label} has flipped sign for ${headLabel}: the model now reads it as a warning rather than a plus (${range}).`;
  }
  if (before <= 0 && after > 0) {
    return `${label} has flipped sign for ${headLabel}: what the priors treated as a drag now reads as a positive (${range}).`;
  }
  const stronger = Math.abs(after) > Math.abs(before);
  return `${label} counts ${stronger ? 'more' : 'less'} toward ${headLabel} than the priors assumed (${range}).`;
}

/**
 * The honesty statement that sits at the top of the learning dashboard.
 *
 * It is written to talk the reader *down* from the model, because the failure
 * mode of an evolving model is that its outputs look identical whether they rest
 * on four launches or four hundred.
 */
function trustStatement(
  bundle: SuccessModelBundle,
  calibration: CalibrationReport,
  baseRates: ObservedBaseRates,
): string {
  const n = bundle.trainedOn;
  const parts: string[] = [];

  if (n === 0) {
    parts.push(
      'The model has folded in no real outcomes yet. Every probability it produces is the hand-set domain prior with feature adjustments on top — an argued guess, not a measurement.',
    );
  } else if (n < 10) {
    parts.push(
      `The model has learned from ${n} launch${n === 1 ? '' : 'es'}. That is far too few to have moved the priors meaningfully; treat the outputs as priors that have been nudged, and expect rank ordering to be unreliable.`,
    );
  } else if (n < MIN_BASE_RATE_SAMPLES) {
    parts.push(
      `The model has learned from ${n} launches. Directional signals may be real but the absolute probabilities are still dominated by the priors; a 30% and a 45% forecast are not meaningfully different at this sample size.`,
    );
  } else if (n < 150) {
    parts.push(
      `The model has learned from ${n} launches. Common outcomes (a first buyer, ten holders) are now measured rather than assumed; rare outcomes such as graduation still rest almost entirely on the prior, because a few hundred launches contain only a handful of them.`,
    );
  } else {
    parts.push(
      `The model has learned from ${n} launches, enough for the frequent outcomes to be genuinely estimated. Graduation remains the weakest head simply because graduations are rare, so its interval stays wide however much data arrives.`,
    );
  }

  const scored = calibration.heads.filter((h) => h.verdict !== 'insufficient data');
  if (scored.length === 0) {
    parts.push('No head has the 20 labelled launches needed for a calibration verdict, so nothing here has been checked against reality yet.');
  } else {
    const bad = scored.filter((h) => h.verdict !== 'well calibrated');
    parts.push(
      bad.length === 0
        ? `All ${scored.length} scoreable head${scored.length === 1 ? '' : 's'} came back well calibrated on the launches measured so far.`
        : `${bad.map((h) => `${HEAD_LABELS[h.head]} is ${h.verdict} (${h.n} launches)`).join('; ')}. Act on those forecasts with that bias in mind.`,
    );
  }

  parts.push(
    baseRates.sufficient
      ? 'Base rates in use are measured from realised launches rather than assumed.'
      : 'Base rates in use are still the encoded priors; not enough outcomes have been measured to replace them.',
  );

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const FEATURE_LABELS: Record<string, string> = {
  trend_level: 'trend interest level',
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
  competing_best_marketcap: 'strongest competitor size',
  competing_quality: 'competitor strength',
  originality: 'concept originality',
  name_quality: 'name quality',
  ticker_length: 'ticker length',
  ticker_quality: 'ticker quality',
  ai_panel_score: 'evaluation panel score',
  ai_panel_disagreement: 'panel disagreement',
  meme_intensity: 'meme intensity',
  cultural_relevance: 'cultural fit',
  artwork_quality: 'artwork quality',
  launch_hour_utc: 'launch hour',
  launch_day_of_week: 'launch day',
  market_launch_rate: 'market launch rate',
  market_graduation_rate: 'market graduation rate',
  market_sol_momentum: 'SOL momentum',
  market_regime: 'market risk appetite',
  x_velocity_x_unsaturated: 'fast growth in an unsaturated space',
  x_velocity_x_originality: 'fast growth with an original concept',
  x_early_x_breadth: 'early and broadly confirmed',
};

/**
 * Feature name to plain English. The equivalent table in the prediction service
 * is private to that module; duplicating the map here keeps this service from
 * reaching into another service's internals for a presentation detail.
 */
function humanise(name: string): string {
  const label = FEATURE_LABELS[name];
  if (label) return label;
  if (name.startsWith('category#')) return 'trend category';
  if (name.startsWith('primary_source#')) return 'trend source';
  if (name.startsWith('concept_archetype#')) return 'concept archetype';
  return name.replace(/_/g, ' ');
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** SQLite integer to a binary label, preserving NULL as "not measured". */
function asLabel(value: unknown): Label {
  const n = asNumberOrNull(value);
  if (n === null) return null;
  return n > 0 ? 1 : 0;
}
