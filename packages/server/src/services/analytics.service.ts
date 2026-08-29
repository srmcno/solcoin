import {
  LAMPORTS_PER_SOL,
  NUMERIC_FEATURE_KEYS,
  PlatformSettings,
  TIME,
  betaPosterior,
  defaultSettings,
  gini,
  lamportsToSol,
  mean,
  median,
  quantile,
  shrinkToPrior,
  sum,
  topShare,
  wilsonInterval,
} from '@solcoin/shared';
import { parseJson } from '../core/json.js';
import { componentLogger } from '../core/logger.js';
import type { Db } from '../db/client.js';
import type { SettingsService } from './settings.service.js';

/**
 * Portfolio, revenue and ROI analytics.
 *
 * The governing constraint of this module is that memecoin outcomes are
 * extremely heavy-tailed: a handful of tokens earn essentially all of the
 * revenue and the rest earn dust. Two consequences run through every method
 * here:
 *
 *  1. **No bare averages.** A mean over a power-law sample describes almost
 *     none of its members. Wherever a mean is reported it is reported next to a
 *     median, percentiles and the concentration of the tail, so the operator
 *     can see that the average is being dragged by one or two tokens.
 *  2. **No rate without its sample size and interval.** "50% success rate" from
 *     two launches is noise. Binomial rates carry a Wilson or Beta interval and
 *     an `n`; group means are shrunk toward the global mean so a single lucky
 *     launch cannot top a leaderboard.
 *
 * Where the data cannot answer a question, these methods say so explicitly
 * (`sufficient: false` with a reason) rather than returning a zero that a
 * dashboard would render as a measurement.
 */

// --------------------------------------------------------------------------
// Tunables. These are named constants rather than magic numbers because each
// one is a statistical judgement the operator is entitled to interrogate.
// --------------------------------------------------------------------------

/**
 * Below this many observations a group statistic is labelled unreliable. Eight
 * is where a Beta(1,1) posterior on a proportion first narrows to roughly
 * ±0.3 — still wide, but no longer uninformative.
 */
const MIN_RELIABLE_N = 8;

/**
 * Empirical-Bayes shrinkage strength for group means: a group is pulled toward
 * the global mean as if it carried five additional launches at the global
 * average. With typical group sizes of 5-30 this is strong enough to stop a
 * single outlier winning a leaderboard and weak enough that a genuinely good
 * segment still surfaces once it has ~15 launches.
 */
const SHRINK_STRENGTH = 5;

/**
 * A launch counts as a success when its token reached at least ten distinct
 * holders. This is the same bar as the model's `ten_holders` target, chosen
 * because it is the smallest milestone that cannot be reached by the creator's
 * own dev buy plus a couple of bots.
 */
const SUCCESS_MIN_PEAK_HOLDERS = 10;

/** Lifetime fees below this are indistinguishable from noise, in SOL. */
const DEFAULT_DUST_THRESHOLD_SOL = 0.001;

/** Spearman correlations below this sample size are not worth acting on. */
const MIN_CORRELATION_N = 20;

/** A forecast needs at least this many realised launches to be anything but fiction. */
const MIN_FORECAST_LAUNCHES = 5;

/** Mean length of a Gregorian month, for annualising a daily rate. */
const DAYS_PER_MONTH = 30.436875;

/** On-chain launch spend is recorded on the launch row; these expense kinds
 * mirror it and would double-count if both were summed. */
const ON_CHAIN_EXPENSE_KINDS = ['launch_sol', 'network_fee', 'priority_fee'] as const;

// --------------------------------------------------------------------------
// Result types
// --------------------------------------------------------------------------

/** A proportion with its sample size and an honest interval. Never used bare. */
export interface RateEstimate {
  /** Point estimate (raw successes/trials, or the posterior mean for Beta). */
  point: number;
  lower: number;
  upper: number;
  successes: number;
  n: number;
  method: 'wilson' | 'beta_posterior';
  /** False when n < MIN_RELIABLE_N; the interval is then near-uninformative. */
  reliable: boolean;
}

export interface OverviewMetrics {
  network: string;
  asOfMs: number;

  /**
   * Creator fees. Collections are wallet-level on-chain events and cannot be
   * split by network from the fee ledger alone (see `caveats`), so the
   * network-scoped figure comes from per-token attribution instead.
   */
  fees: {
    collectedLamports: number;
    collectedSol: number;
    collectedTodayLamports: number;
    collectedTodaySol: number;
    collected7dLamports: number;
    collected7dSol: number;
    collected30dLamports: number;
    collected30dSol: number;
    /** Earned but not yet claimed, from per-token attribution on this network. */
    outstandingAccruedLamports: number;
    outstandingAccruedSol: number;
    /** Collected + outstanding: everything earned to date on this network. */
    lifetimeRevenueLamports: number;
    lifetimeRevenueSol: number;
    /** Collections attributed to tokens on this network. */
    attributedToNetworkLamports: number;
    collectionCount: number;
  };

  launches: {
    attempted: number;
    confirmed: number;
    failed: number;
    /** Confirmed / attempted — an execution-reliability rate, not a success rate. */
    executionRate: RateEstimate;
  };

  tokens: {
    launched: number;
    active: number;
    graduated: number;
    dormant: number;
  };

  /**
   * Fraction of launched tokens that attracted real organic interest
   * (>= SUCCESS_MIN_PEAK_HOLDERS holders). Wilson interval, because at the
   * sample sizes this platform operates at the normal approximation is wrong.
   */
  successfulLaunchRate: RateEstimate;
  graduationRate: RateEstimate;

  volume: {
    totalOrganicSol: number;
    /** Tokens contributing to the volume figure. */
    n: number;
  };

  /**
   * Revenue per launch. The mean and the median are both here on purpose: for
   * this distribution they routinely differ by an order of magnitude, and the
   * mean alone is not a description of a typical launch.
   */
  revenuePerLaunch: {
    meanSol: number;
    medianSol: number;
    p90Sol: number;
    /** Share of all revenue earned by the best-earning tenth of tokens. */
    topTenPercentShare: number;
    /** meanSol / medianSol; null when the median is zero. Above ~2 the mean is a tail statistic. */
    meanToMedianRatio: number | null;
    n: number;
    reliable: boolean;
  };

  pipeline: {
    candidatesAwaitingApproval: number;
    conceptsInFlight: number;
    opportunitiesDiscoveredToday: number;
    trendsActive: number;
  };

  spend: {
    /** On-chain launch spend recorded on the launch rows. */
    onChainLaunchSol: number;
    /** Everything else recorded in the expense ledger, excluding on-chain kinds. */
    operatingSol: number;
    operatingUsd: number;
    totalSol: number;
    /** Latest observed SOL price, or null when none has been recorded. */
    solPriceUsd: number | null;
    /** Null when no SOL price is known — USD costs cannot be converted honestly. */
    totalSolIncludingUsd: number | null;
  };

  /**
   * Lifetime revenue minus lifetime cost, in SOL. Null when USD-denominated
   * costs exist but no SOL price has ever been recorded, because guessing a
   * conversion rate would fabricate the headline number of the whole system.
   */
  netProfitSol: number | null;
  /** Net profit ignoring USD costs entirely; always computable. */
  netProfitSolExcludingUsdCosts: number;

  /** Things the numbers above cannot tell you. Render these next to them. */
  caveats: string[];
}

export interface RevenueDistributionOptions {
  network?: string;
  /** Only tokens created at or after this time. Defaults to all history. */
  sinceMs?: number;
  untilMs?: number;
  /** Lifetime fees below this count as "earned nothing". Defaults to 0.001 SOL. */
  dustThresholdSol?: number;
  /** Include fees accrued but not yet claimed. Default true (economic view). */
  includeAccrued?: boolean;
}

export interface RevenueDistributionStats {
  totalSol: number;
  meanSol: number;
  medianSol: number;
  p10Sol: number;
  p25Sol: number;
  p75Sol: number;
  p90Sol: number;
  p99Sol: number;
  maxSol: number;
  /** Share of all revenue earned by the top 1% / 5% / 10% of tokens. */
  topOnePercentShare: number;
  topFivePercentShare: number;
  topTenPercentShare: number;
  /**
   * How many tokens the "top 1%" actually spans. With fewer than 100 tokens
   * this is a single token, and the share is that token's share — important
   * context before quoting the number.
   */
  topOnePercentSpansTokens: number;
  /** How many tokens the top 5% / 10% actually span, for the same reason. */
  topFivePercentSpansTokens: number;
  topTenPercentSpansTokens: number;
  /** 0 = every token earned the same, 1 = one token earned everything. */
  gini: number;
  /** Fraction (and count) of tokens whose lifetime fees are below the dust threshold. */
  dustFraction: number;
  dustCount: number;
  dustThresholdSol: number;
  /** Tokens that earned exactly nothing. */
  zeroCount: number;
  /**
   * meanSol / medianSol. Anything above ~2 means the average is a statement
   * about the tail, not about a typical launch.
   */
  meanToMedianRatio: number | null;
  includesAccrued: boolean;
  /**
   * False when n < MIN_RELIABLE_N. Below that the shape statistics are
   * arithmetic on a handful of points rather than descriptions of a
   * distribution: a single token makes `gini` 0 and `topOnePercentShare` 1 at
   * the same time, which is not a finding about concentration.
   */
  reliable: boolean;
  minReliableN: number;
  /** Which of the numbers above the sample size cannot actually support. */
  caveats: string[];
}

export type RevenueDistribution =
  | { sufficient: false; reason: string; n: number }
  | ({ sufficient: true; n: number } & RevenueDistributionStats);

export interface CostByKind {
  kind: string;
  lamports: number;
  sol: number;
  usd: number;
  n: number;
}

export interface PnLOptions {
  sinceMs: number;
  network: string;
  untilMs?: number;
}

export interface PnL {
  network: string;
  sinceMs: number;
  untilMs: number;

  /** Cash-basis revenue: fees actually claimed in the window. */
  revenueRealisedSol: number;
  revenueRealisedLamports: number;
  feeCollectionCount: number;
  /** Fees earned by tokens launched in the window but not yet claimed. */
  revenueAccruedUnclaimedSol: number;

  costs: {
    onChainLaunchSol: number;
    operatingSol: number;
    operatingUsd: number;
    /** Every expense row in the window, including the on-chain kinds, for audit. */
    expenseLedgerSol: number;
    expenseLedgerUsd: number;
    byKind: CostByKind[];
    solPriceUsd: number | null;
    totalSol: number;
    /** Null when USD costs exist and no SOL price is known. */
    totalSolIncludingUsd: number | null;
  };

  /** Revenue less direct on-chain launch cost. */
  grossProfitSol: number;
  /** Gross profit less operating costs. Null when USD costs cannot be converted. */
  netProfitSol: number | null;
  netProfitSolExcludingUsdCosts: number;
  /** netProfit / totalCost. Null when no cost was incurred, or no SOL price. */
  roi: number | null;

  launches: number;
  successes: number;
  /**
   * Net profit divided by launch count. This is an allocation of an aggregate,
   * not a description of a launch: read it next to `perLaunchFeesSol`, where
   * the median is routinely an order of magnitude below the mean.
   */
  profitPerLaunchSol: number | null;
  /**
   * The distribution of what the launches in this window actually earned.
   * Present so no caller has to infer a typical launch from a mean.
   */
  perLaunchFeesSol: {
    meanSol: number;
    medianSol: number;
    p90Sol: number;
    /** Share of cohort revenue earned by its best-earning tenth. */
    topTenPercentShare: number;
    n: number;
    reliable: boolean;
  };
  /**
   * Fraction of launches whose own lifetime fees covered their own direct cost,
   * including USD-denominated costs converted at the latest known SOL price.
   * When no SOL price is known those costs are omitted and a caveat says so.
   */
  breakEvenRate: RateEstimate;
  costPerSuccessfulLaunchSol: number | null;
  organicVolumeSol: number;
  /**
   * Fees earned per 1,000 SOL of organic volume by the launches in this window
   * — numerator and denominator are the same cohort, so this is a take rate
   * rather than a ratio of two differently-scoped totals.
   */
  revenuePer1000SolVolume: number | null;

  /** True when at least one launch fell in the window. */
  sufficient: boolean;
  reason?: string;
  caveats: string[];
}

export type Dimension =
  | 'category'
  | 'trend_source'
  | 'launch_hour_utc'
  | 'launch_day_of_week'
  | 'concept_archetype'
  | 'saturation_bucket'
  | 'opportunity_bucket'
  | 'exploration_arm';

export interface DimensionOptions {
  network?: string;
  sinceMs?: number;
  untilMs?: number;
  /** Drop groups below this size entirely instead of returning them flagged. */
  minN?: number;
  includeAccrued?: boolean;
}

export interface DimensionStats {
  dimension: Dimension;
  key: string;
  label: string;
  n: number;
  successes: number;
  successRate: RateEstimate;
  medianFeesSol: number;
  meanFeesSol: number;
  /**
   * Mean shrunk toward the global mean by sample size. This is the column to
   * sort and to act on: the raw mean of a two-launch group is not an estimate
   * of anything.
   */
  shrunkMeanFeesSol: number;
  totalFeesSol: number;
  p90FeesSol: number;
  graduations: number;
  reliable: boolean;
  minReliableN: number;
}

export type TimeSeriesMetric =
  | 'creator_fees_sol'
  | 'launches'
  | 'organic_volume_sol'
  | 'spend_sol'
  | 'ai_spend_usd'
  | 'trends_discovered';

export type TimeBucket = 'hour' | 'day' | 'week';

export interface TimeSeriesOptions {
  bucket: TimeBucket;
  sinceMs: number;
  network: string;
  untilMs?: number;
}

export interface TimeSeriesPoint {
  /** Bucket start, unix ms, UTC-aligned (weeks start Monday). */
  t: number;
  value: number;
  /** Rows contributing to the bucket. n = 0 with value = 0 means "nothing happened". */
  n: number;
}

export interface SignalCorrelation {
  feature: string;
  /** Spearman rank correlation with realised creator fees, -1..1. */
  correlation: number;
  /**
   * Fisher-z 95% interval on the correlation. Null when n < 4, and also null
   * when the sample correlation is exactly ±1: the z-transform diverges there,
   * so any interval it produced would be an artefact of the clamp rather than
   * a measure of uncertainty.
   */
  lower: number | null;
  upper: number | null;
  n: number;
  reliable: boolean;
  /** True when the feature never varied in this sample, so no correlation exists. */
  degenerate: boolean;
  caveat: string;
}

export interface ForecastScenario {
  label: 'low' | 'base' | 'high';
  basis: string;
  creatorFeesSol: number;
  costsSol: number;
  netIncomeSol: number;
}

export interface ForecastDetail {
  sufficient: true;
  n: number;
  windowDays: number;
  perLaunchFeesSol: {
    meanSol: number;
    medianSol: number;
    p25Sol: number;
    p75Sol: number;
    p90Sol: number;
    n: number;
  };
  launchesPerMonth: number;
  observedLaunchesPerMonth: number;
  configuredMaxLaunchesPerMonth: number;
  launchRateBasis: string;
  costPerLaunchSol: number;
  fixedMonthlyCostSol: number;
  monthlyOperatingUsd: number;
  solPriceUsd: number | null;
  scenarios: { low: ForecastScenario; base: ForecastScenario; high: ForecastScenario };
  caveats: string[];
}

export type ProfitabilityForecast = ForecastDetail | { sufficient: false; reason: string; n: number };

// --------------------------------------------------------------------------
// Internal row shapes
// --------------------------------------------------------------------------

interface LaunchRow {
  launch_id: string;
  created_at: number;
  confirmed_at: number | null;
  total_cost_lamports: number;
  concept_id: string;
  category: string | null;
  archetype: string | null;
  saturation_score: number | null;
  opportunity_score: number | null;
  exploration_arm: string | null;
  is_exploration: number;
  features: string | null;
  mint: string | null;
  peak_holders: number | null;
  holders: number | null;
  graduated_at: number | null;
  lifecycle: string | null;
  volume_total_sol: number | null;
  collected_lamports: number | null;
  accrued_lamports: number | null;
  outcome_fees_sol: number | null;
  extra_cost_lamports: number;
  extra_cost_usd: number;
}

/** One analysable launch: costs, realised fees and its decision-time features. */
interface LaunchSample {
  launchId: string;
  createdAt: number;
  costSol: number;
  costUsd: number;
  feesSol: number;
  success: boolean;
  graduated: boolean;
  volumeSol: number;
  features: Record<string, unknown>;
  concept: {
    category: string;
    archetype: string;
    saturation: number | null;
    opportunity: number | null;
    explorationArm: string | null;
  };
}

export class AnalyticsService {
  private readonly log = componentLogger('analytics');

  /**
   * `settings` is optional so the analytics layer can be constructed for
   * read-only reporting (exports, CLI) without the audit and event plumbing a
   * full SettingsService needs. When it is absent the settings row is read
   * directly, falling back to the schema defaults.
   */
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    private readonly settings?: SettingsService,
  ) {}

  // ------------------------------------------------------------------------
  // 1. Overview
  // ------------------------------------------------------------------------

  /**
   * The headline dashboard numbers for one network.
   *
   * Every rate here carries its interval and its `n`. The revenue-per-launch
   * pair (mean and median) is deliberately not collapsed into one number:
   * `revenueDistribution()` exists because that single number is misleading.
   */
  async overview(network: string): Promise<OverviewMetrics> {
    const asOfMs = this.now();
    const dayStart = startOfUtcDay(asOfMs);
    const caveats: string[] = [];

    // Fee collections are claims against wallet-level vaults; the fee ledger
    // has no network column, so windowed collection totals span every network
    // the wallet has operated on. Single-network deployments are unaffected.
    const collectedSince = (since: number): { lamports: number; n: number } => {
      const row = this.db.$raw
        .prepare(
          `SELECT COALESCE(SUM(lamports), 0) AS lamports, COUNT(*) AS n
             FROM creator_fee_events
            WHERE kind = 'collection' AND observed_at >= ?`,
        )
        .get(since) as { lamports: number; n: number } | undefined;
      return { lamports: row?.lamports ?? 0, n: row?.n ?? 0 };
    };

    const collectedAll = collectedSince(0);
    const collectedToday = collectedSince(dayStart);
    const collected7d = collectedSince(asOfMs - 7 * TIME.day);
    const collected30d = collectedSince(asOfMs - 30 * TIME.day);
    if (collectedAll.n > 0) {
      caveats.push(
        'Creator fees are claimed from wallet-level vaults, so the windowed fee totals are not network-scoped. The per-network figure is the attributed total.',
      );
    }

    const tokenTotals = this.db.$raw
      .prepare(
        `SELECT COUNT(*) AS launched,
                COALESCE(SUM(creator_fees_collected_lamports), 0) AS collected,
                COALESCE(SUM(creator_fees_accrued_lamports), 0) AS accrued,
                COALESCE(SUM(volume_total_sol), 0) AS volume,
                SUM(CASE WHEN lifecycle IN ('new','early_traction','growing','high_momentum','active') THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN lifecycle = 'graduated' OR graduated_at IS NOT NULL THEN 1 ELSE 0 END) AS graduated,
                SUM(CASE WHEN lifecycle = 'dormant' THEN 1 ELSE 0 END) AS dormant,
                SUM(CASE WHEN peak_holders >= ? OR lifecycle = 'graduated' OR graduated_at IS NOT NULL THEN 1 ELSE 0 END) AS successes
           FROM tokens WHERE network = ?`,
      )
      .get(SUCCESS_MIN_PEAK_HOLDERS, network) as
      | {
          launched: number;
          collected: number;
          accrued: number;
          volume: number;
          active: number | null;
          graduated: number | null;
          dormant: number | null;
          successes: number | null;
        }
      | undefined;

    const launched = tokenTotals?.launched ?? 0;
    const successes = tokenTotals?.successes ?? 0;
    const graduated = tokenTotals?.graduated ?? 0;

    const launchCounts = this.db.$raw
      .prepare(
        `SELECT COUNT(*) AS attempted,
                SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
                SUM(CASE WHEN status IN ('failed','abandoned') THEN 1 ELSE 0 END) AS failed,
                COALESCE(SUM(total_cost_lamports), 0) AS cost
           FROM launches WHERE network = ?`,
      )
      .get(network) as
      | { attempted: number; confirmed: number | null; failed: number | null; cost: number }
      | undefined;

    // Per-token lifetime fees drive both the mean and the median; computing
    // them from the same vector guarantees the two describe the same sample.
    const perToken = this.tokenFeeValues({ network, includeAccrued: true });

    const pipeline = this.db.$raw
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM concepts WHERE status = 'awaiting_approval') AS awaiting,
           (SELECT COUNT(*) FROM concepts WHERE status IN ('draft','evaluating','candidate','approved','queued','launching')) AS inFlight,
           (SELECT COUNT(*) FROM trends WHERE first_seen_at >= ?) AS discoveredToday,
           (SELECT COUNT(*) FROM trends WHERE status = 'active') AS activeTrends`,
      )
      .get(dayStart) as
      | { awaiting: number; inFlight: number; discoveredToday: number; activeTrends: number }
      | undefined;

    const expenses = this.expenseTotals(0, asOfMs);
    const solPriceUsd = this.latestSolPriceUsd();

    const onChainLaunchSol = lamportsToSol(launchCounts?.cost ?? 0);
    const operatingSol = lamportsToSol(expenses.operatingLamports);
    const operatingUsd = expenses.operatingUsd;
    const totalSpendSol = onChainLaunchSol + operatingSol;
    const totalSpendInclUsd = this.addUsdCost(totalSpendSol, operatingUsd, solPriceUsd);
    if (operatingUsd > 0 && solPriceUsd === null) {
      caveats.push(
        `USD-denominated costs of ${operatingUsd.toFixed(2)} exist but no SOL price has been recorded, so no SOL-denominated total or net profit can be computed without inventing an exchange rate.`,
      );
    }

    const lifetimeRevenueLamports = (tokenTotals?.collected ?? 0) + (tokenTotals?.accrued ?? 0);
    const lifetimeRevenueSol = lamportsToSol(lifetimeRevenueLamports);

    if (launched < MIN_RELIABLE_N) {
      caveats.push(
        `Only ${launched} tokens have launched on ${network}; every rate below is dominated by its prior, and the revenue distribution is not yet meaningful.`,
      );
    }

    const perLaunchMean = perToken.length > 0 ? mean(perToken) : 0;
    const perLaunchMedian = perToken.length > 0 ? median(perToken) : 0;
    const perLaunchRatio = perLaunchMedian > 0 ? perLaunchMean / perLaunchMedian : null;
    if (perLaunchRatio !== null && perLaunchRatio >= 2) {
      caveats.push(
        `Mean revenue per launch (${perLaunchMean.toFixed(4)} SOL) is ${perLaunchRatio.toFixed(1)}x the median (${perLaunchMedian.toFixed(4)} SOL), and the top decile of tokens earned ${(topShare(perToken, 0.1) * 100).toFixed(0)}% of all revenue. The mean describes the tail, not a typical launch; use revenueDistribution() before planning against it.`,
      );
    } else if (perLaunchRatio === null && perToken.length > 0) {
      caveats.push(
        'The median token earned nothing, so revenue per launch has no meaningful central value; all of it sits in the tail.',
      );
    }
    if ((tokenTotals?.accrued ?? 0) > 0) {
      caveats.push(
        'Lifetime revenue and net profit include fees accrued but not yet claimed. Unclaimed fees are an on-chain balance, not cash, and a claim can fail or be partially collected.',
      );
    }

    return {
      network,
      asOfMs,
      fees: {
        collectedLamports: collectedAll.lamports,
        collectedSol: lamportsToSol(collectedAll.lamports),
        collectedTodayLamports: collectedToday.lamports,
        collectedTodaySol: lamportsToSol(collectedToday.lamports),
        collected7dLamports: collected7d.lamports,
        collected7dSol: lamportsToSol(collected7d.lamports),
        collected30dLamports: collected30d.lamports,
        collected30dSol: lamportsToSol(collected30d.lamports),
        outstandingAccruedLamports: tokenTotals?.accrued ?? 0,
        outstandingAccruedSol: lamportsToSol(tokenTotals?.accrued ?? 0),
        lifetimeRevenueLamports,
        lifetimeRevenueSol,
        attributedToNetworkLamports: tokenTotals?.collected ?? 0,
        collectionCount: collectedAll.n,
      },
      launches: {
        attempted: launchCounts?.attempted ?? 0,
        confirmed: launchCounts?.confirmed ?? 0,
        failed: launchCounts?.failed ?? 0,
        executionRate: this.rate(launchCounts?.confirmed ?? 0, launchCounts?.attempted ?? 0, 'wilson'),
      },
      tokens: {
        launched,
        active: tokenTotals?.active ?? 0,
        graduated,
        dormant: tokenTotals?.dormant ?? 0,
      },
      successfulLaunchRate: this.rate(successes, launched, 'wilson'),
      graduationRate: this.rate(graduated, launched, 'wilson'),
      volume: { totalOrganicSol: tokenTotals?.volume ?? 0, n: launched },
      revenuePerLaunch: {
        meanSol: perLaunchMean,
        medianSol: perLaunchMedian,
        p90Sol: perToken.length > 0 ? quantile(perToken, 0.9) : 0,
        topTenPercentShare: perToken.length > 0 ? topShare(perToken, 0.1) : 0,
        meanToMedianRatio: perLaunchRatio,
        n: perToken.length,
        reliable: perToken.length >= MIN_RELIABLE_N,
      },
      pipeline: {
        candidatesAwaitingApproval: pipeline?.awaiting ?? 0,
        conceptsInFlight: pipeline?.inFlight ?? 0,
        opportunitiesDiscoveredToday: pipeline?.discoveredToday ?? 0,
        trendsActive: pipeline?.activeTrends ?? 0,
      },
      spend: {
        onChainLaunchSol,
        operatingSol,
        operatingUsd,
        totalSol: totalSpendSol,
        solPriceUsd,
        totalSolIncludingUsd: totalSpendInclUsd,
      },
      netProfitSol: totalSpendInclUsd === null ? null : lifetimeRevenueSol - totalSpendInclUsd,
      netProfitSolExcludingUsdCosts: lifetimeRevenueSol - totalSpendSol,
      caveats,
    };
  }

  // ------------------------------------------------------------------------
  // 2. Revenue distribution
  // ------------------------------------------------------------------------

  /**
   * The shape of per-token lifetime revenue.
   *
   * This is the most important analytic in the system, and it exists because
   * **mean revenue per launch is a misleading statistic on its own**. Token
   * revenue follows a power law: the median token earns dust, the mean is set
   * almost entirely by the largest one or two tokens, and a dashboard that
   * shows only the mean will read as "every launch earns X" when in truth
   * nothing earns X. Reporting the median, the percentile spread, the top-1/5/10%
   * contribution and the Gini coefficient together makes the skew visible, and
   * makes it obvious when a good month was one lucky token rather than a
   * repeatable process.
   */
  async revenueDistribution(options: RevenueDistributionOptions = {}): Promise<RevenueDistribution> {
    const includeAccrued = options.includeAccrued ?? true;
    const dustThresholdSol = options.dustThresholdSol ?? DEFAULT_DUST_THRESHOLD_SOL;
    const values = this.tokenFeeValues({ ...options, includeAccrued });
    const n = values.length;

    if (n === 0) {
      return {
        sufficient: false,
        n: 0,
        reason:
          'No tokens match this filter, so there is no revenue distribution to describe. This is an absence of data, not a distribution of zeros.',
      };
    }

    const total = sum(values);
    const meanSol = mean(values);
    const medianSol = median(values);
    const dustCount = values.filter((v) => v < dustThresholdSol).length;
    const zeroCount = values.filter((v) => v <= 0).length;

    // `topShare` takes ceil(frac * n) tokens with a floor of one, so below 100
    // tokens the "top 1%" is literally the single best token. Surfacing the
    // span stops that being read as a percentile of a large population.
    const spanOf = (frac: number): number => Math.max(1, Math.ceil(frac * n));
    const topOnePercentSpansTokens = spanOf(0.01);
    const topFivePercentSpansTokens = spanOf(0.05);
    const topTenPercentSpansTokens = spanOf(0.1);

    // The shape statistics below are only descriptions of a distribution once
    // there is a distribution to describe. Rather than suppress them at small
    // n — an operator with three tokens still wants to see their three numbers
    // — they are returned flagged, with the specific failure named.
    const reliable = n >= MIN_RELIABLE_N;
    const caveats: string[] = [];
    if (!reliable) {
      caveats.push(
        `Only ${n} token${n === 1 ? '' : 's'} match${n === 1 ? 'es' : ''} this filter (below the ${MIN_RELIABLE_N} needed for a distribution to be described). The percentiles, Gini coefficient and tail shares below are arithmetic on these ${n} values, not estimates of the underlying distribution.`,
      );
    }
    if (n < 100) {
      caveats.push(
        `The "top 1%" here is ${topOnePercentSpansTokens} token${topOnePercentSpansTokens === 1 ? '' : 's'}, the top 5% is ${topFivePercentSpansTokens} and the top 10% is ${topTenPercentSpansTokens}; below 100 tokens these are the best few tokens, not percentiles of a population.`,
      );
    }
    if (n < 20) {
      caveats.push(
        'p90 and p99 are interpolated between the two largest observations, so they restate the maximum rather than estimate a tail.',
      );
    }
    if (n === 1) {
      caveats.push(
        'With a single token the Gini coefficient is 0 (perfect equality) and the top-1% share is 1 (perfect concentration) at the same time. Neither is a finding about concentration; both are artefacts of n = 1.',
      );
    }

    return {
      sufficient: true,
      n,
      totalSol: total,
      meanSol,
      medianSol,
      p10Sol: quantile(values, 0.1),
      p25Sol: quantile(values, 0.25),
      p75Sol: quantile(values, 0.75),
      p90Sol: quantile(values, 0.9),
      p99Sol: quantile(values, 0.99),
      // Reduce rather than Math.max(...values): the spread would blow the call
      // stack once the portfolio grows past ~100k tokens.
      maxSol: values.reduce((acc, v) => (v > acc ? v : acc), values[0] ?? 0),
      topOnePercentShare: topShare(values, 0.01),
      topFivePercentShare: topShare(values, 0.05),
      topTenPercentShare: topShare(values, 0.1),
      topOnePercentSpansTokens,
      topFivePercentSpansTokens,
      topTenPercentSpansTokens,
      gini: gini(values),
      dustFraction: dustCount / n,
      dustCount,
      dustThresholdSol,
      zeroCount,
      meanToMedianRatio: medianSol > 0 ? meanSol / medianSol : null,
      includesAccrued: includeAccrued,
      reliable,
      minReliableN: MIN_RELIABLE_N,
      caveats,
    };
  }

  // ------------------------------------------------------------------------
  // 3. Profit and loss
  // ------------------------------------------------------------------------

  /**
   * Cash-basis profit and loss over a window.
   *
   * Revenue is what was actually claimed in the window; fees earned but still
   * sitting in the vaults are reported separately rather than booked, because
   * an unclaimed balance is not money until a claim transaction lands.
   *
   * Costs come from two ledgers that must not be added blindly: the on-chain
   * spend recorded on each launch row, and the expense ledger. The expense
   * kinds that mirror on-chain spend are excluded from the operating total so
   * a launch is never counted twice.
   */
  async profitAndLoss(options: PnLOptions): Promise<PnL> {
    const untilMs = options.untilMs ?? this.now();
    const { sinceMs, network } = options;
    const caveats: string[] = [];

    const revenueRow = this.db.$raw
      .prepare(
        `SELECT COALESCE(SUM(lamports), 0) AS lamports, COUNT(*) AS n
           FROM creator_fee_events
          WHERE kind = 'collection' AND observed_at >= ? AND observed_at < ?`,
      )
      .get(sinceMs, untilMs) as { lamports: number; n: number } | undefined;
    const revenueRealisedLamports = revenueRow?.lamports ?? 0;
    const revenueRealisedSol = lamportsToSol(revenueRealisedLamports);
    if ((revenueRow?.n ?? 0) > 0) {
      caveats.push(
        'Fee claims are wallet-level and carry no network attribution, so revenue in this window may include tokens from another network if the same wallet operated on more than one.',
      );
    }

    const samples = this.launchSamples({ network, sinceMs, untilMs, includeAccrued: true });
    const launches = samples.length;
    const successes = samples.filter((s) => s.success).length;
    const accruedUnclaimed = lamportsToSol(
      (this.db.$raw
        .prepare(
          `SELECT COALESCE(SUM(creator_fees_accrued_lamports), 0) AS lamports
             FROM tokens WHERE network = ? AND created_at >= ? AND created_at < ?`,
        )
        .get(network, sinceMs, untilMs) as { lamports: number } | undefined)?.lamports ?? 0,
    );

    const launchCostRow = this.db.$raw
      .prepare(
        `SELECT COALESCE(SUM(total_cost_lamports), 0) AS lamports
           FROM launches WHERE network = ? AND created_at >= ? AND created_at < ?`,
      )
      .get(network, sinceMs, untilMs) as { lamports: number } | undefined;
    const onChainLaunchSol = lamportsToSol(launchCostRow?.lamports ?? 0);

    const expenses = this.expenseTotals(sinceMs, untilMs);
    const operatingSol = lamportsToSol(expenses.operatingLamports);
    const solPriceUsd = this.latestSolPriceUsd();
    const totalSol = onChainLaunchSol + operatingSol;
    const totalSolIncludingUsd = this.addUsdCost(totalSol, expenses.operatingUsd, solPriceUsd);
    if (expenses.operatingUsd > 0 && solPriceUsd === null) {
      caveats.push(
        'USD costs (AI inference, data providers) cannot be converted to SOL because no SOL price has been recorded; net profit and ROI are reported as null rather than guessed.',
      );
    }
    // The expense ledger has no network column, so operating costs are
    // platform-wide even when revenue is filtered to one network.
    if (expenses.operatingLamports > 0 || expenses.operatingUsd > 0) {
      caveats.push('Operating costs are recorded platform-wide and are not attributable to a single network.');
    }

    const grossProfitSol = revenueRealisedSol - onChainLaunchSol;
    const netProfitSol = totalSolIncludingUsd === null ? null : revenueRealisedSol - totalSolIncludingUsd;
    const netProfitExclUsd = revenueRealisedSol - totalSol;
    const denominator = totalSolIncludingUsd ?? null;
    const roi = denominator !== null && denominator > 0 && netProfitSol !== null ? netProfitSol / denominator : null;

    // Break-even is per launch: did this token's own lifetime fees cover its
    // own direct cost? It answers a different question from aggregate ROI —
    // aggregate ROI can be positive because of one winner while almost every
    // individual launch lost money.
    // A launch's own cost includes the USD-denominated work that produced it
    // (inference, artwork). Ignoring that because it is denominated in dollars
    // would call launches profitable that only look profitable in one currency.
    const fullCostSol = (s: LaunchSample): number =>
      s.costSol + (solPriceUsd !== null && solPriceUsd > 0 ? s.costUsd / solPriceUsd : 0);
    const withCostSamples = samples.filter((s) => fullCostSol(s) > 0);
    const brokeEven = withCostSamples.filter((s) => s.feesSol >= fullCostSol(s)).length;
    const withCost = withCostSamples.length;
    const unconvertedUsd = sum(samples.map((s) => s.costUsd));
    if (unconvertedUsd > 0 && (solPriceUsd === null || solPriceUsd <= 0)) {
      caveats.push(
        `Break-even is computed against on-chain cost only: ${unconvertedUsd.toFixed(2)} USD of per-launch cost could not be converted without a recorded SOL price, so the break-even rate is an upper bound.`,
      );
    }

    const organicVolumeSol = sum(samples.map((s) => s.volumeSol));
    const cohortFees = samples.map((s) => s.feesSol);
    const cohortFeesTotal = sum(cohortFees);

    if (launches === 0) {
      caveats.push('No launches fell in this window, so the per-launch statistics have no sample.');
    } else {
      const cohortMedian = median(cohortFees);
      if (cohortMedian <= 0) {
        caveats.push(
          `The median launch in this window earned nothing; all cohort revenue came from ${cohortFees.filter((f) => f > 0).length} of ${launches} launches. Profit per launch is an allocation of an aggregate, not what a launch earns.`,
        );
      } else if (mean(cohortFees) / cohortMedian >= 2) {
        caveats.push(
          `Mean cohort fees per launch are ${(mean(cohortFees) / cohortMedian).toFixed(1)}x the median. Profit per launch divides an aggregate by a count and describes no individual launch; read breakEvenRate and perLaunchFeesSol instead.`,
        );
      }
      if (launches < MIN_RELIABLE_N) {
        caveats.push(
          `Only ${launches} launches fell in this window, below the ${MIN_RELIABLE_N} at which per-launch statistics stop being dominated by chance.`,
        );
      }
    }

    return {
      network,
      sinceMs,
      untilMs,
      revenueRealisedSol,
      revenueRealisedLamports,
      feeCollectionCount: revenueRow?.n ?? 0,
      revenueAccruedUnclaimedSol: accruedUnclaimed,
      costs: {
        onChainLaunchSol,
        operatingSol,
        operatingUsd: expenses.operatingUsd,
        expenseLedgerSol: lamportsToSol(expenses.allLamports),
        expenseLedgerUsd: expenses.allUsd,
        byKind: expenses.byKind,
        solPriceUsd,
        totalSol,
        totalSolIncludingUsd,
      },
      grossProfitSol,
      netProfitSol,
      netProfitSolExcludingUsdCosts: netProfitExclUsd,
      roi,
      launches,
      successes,
      profitPerLaunchSol: launches > 0 && netProfitSol !== null ? netProfitSol / launches : null,
      perLaunchFeesSol: {
        meanSol: launches > 0 ? mean(cohortFees) : 0,
        medianSol: launches > 0 ? median(cohortFees) : 0,
        p90Sol: launches > 0 ? quantile(cohortFees, 0.9) : 0,
        topTenPercentShare: launches > 0 ? topShare(cohortFees, 0.1) : 0,
        n: launches,
        reliable: launches >= MIN_RELIABLE_N,
      },
      breakEvenRate: this.rate(brokeEven, withCost, 'wilson'),
      costPerSuccessfulLaunchSol: successes > 0 && totalSolIncludingUsd !== null ? totalSolIncludingUsd / successes : null,
      organicVolumeSol,
      revenuePer1000SolVolume: organicVolumeSol > 0 ? (cohortFeesTotal / organicVolumeSol) * 1000 : null,
      sufficient: launches > 0,
      reason: launches === 0 ? 'No launches in the window; only ledger totals are meaningful.' : undefined,
      caveats,
    };
  }

  // ------------------------------------------------------------------------
  // 4. Segmentation
  // ------------------------------------------------------------------------

  /**
   * Group launches by one decision dimension and compare them honestly.
   *
   * Two deliberate choices make this table safe to act on:
   *  - Success rates use a Beta posterior with a weak prior, so a 1-for-1 group
   *    reports ~0.5 with a wide interval instead of a triumphant 100%.
   *  - Results are sorted by the **shrunk** mean, not the raw mean. Sorting by
   *    the raw mean would put whichever group happened to contain the single
   *    best token at the top of every table forever.
   */
  async byDimension(dimension: Dimension, options: DimensionOptions = {}): Promise<DimensionStats[]> {
    const samples = this.launchSamples({ ...options, includeAccrued: options.includeAccrued ?? true });
    if (samples.length === 0) return [];

    const globalMean = mean(samples.map((s) => s.feesSol));
    const groups = new Map<string, { label: string; items: LaunchSample[] }>();

    for (const sample of samples) {
      const bucket = this.dimensionKey(dimension, sample);
      if (!bucket) continue;
      const existing = groups.get(bucket.key);
      if (existing) existing.items.push(sample);
      else groups.set(bucket.key, { label: bucket.label, items: [sample] });
    }

    const minN = options.minN ?? 1;
    const out: DimensionStats[] = [];
    for (const [key, group] of groups) {
      const n = group.items.length;
      if (n < minN) continue;
      const fees = group.items.map((s) => s.feesSol);
      const successes = group.items.filter((s) => s.success).length;
      const groupMean = mean(fees);
      out.push({
        dimension,
        key,
        label: group.label,
        n,
        successes,
        successRate: this.rate(successes, n, 'beta_posterior'),
        medianFeesSol: median(fees),
        meanFeesSol: groupMean,
        shrunkMeanFeesSol: shrinkToPrior(groupMean, n, globalMean, SHRINK_STRENGTH),
        totalFeesSol: sum(fees),
        p90FeesSol: quantile(fees, 0.9),
        graduations: group.items.filter((s) => s.graduated).length,
        reliable: n >= MIN_RELIABLE_N,
        minReliableN: MIN_RELIABLE_N,
      });
    }

    // Ties broken by n so that, between two equally shrunk groups, the better
    // evidenced one ranks first.
    out.sort((a, b) => b.shrunkMeanFeesSol - a.shrunkMeanFeesSol || b.n - a.n);
    return out;
  }

  // ------------------------------------------------------------------------
  // 5. Time series
  // ------------------------------------------------------------------------

  /**
   * A bucketed series for charting. Empty buckets are emitted with `n: 0` so a
   * gap in activity is visible as a gap rather than being interpolated away by
   * the chart library.
   *
   * Scope notes, because not every source table carries a network:
   *  - `spend_sol`, `ai_spend_usd` and `trends_discovered` are platform-wide.
   *  - `creator_fees_sol` counts wallet-level claims, excluding only claims
   *    explicitly attributed to a token on another network.
   *  - `organic_volume_sol` attributes each token's *lifetime* volume to the
   *    bucket it launched in, because the schema stores cumulative volume per
   *    token rather than per-interval flow.
   */
  async timeSeries(metric: TimeSeriesMetric, options: TimeSeriesOptions): Promise<TimeSeriesPoint[]> {
    const untilMs = options.untilMs ?? this.now();
    const { bucket, sinceMs, network } = options;
    if (untilMs <= sinceMs) return [];

    const query = this.timeSeriesQuery(metric, bucket);
    const params: unknown[] = query.needsNetwork ? [network, sinceMs, untilMs] : [sinceMs, untilMs];
    const rows = this.db.$raw.prepare(query.sql).all(...(params as never[])) as Array<{
      bucket: number;
      value: number | null;
      n: number;
    }>;

    const byBucket = new Map<number, { value: number; n: number }>();
    for (const row of rows) byBucket.set(row.bucket, { value: row.value ?? 0, n: row.n });

    const width = bucketWidthMs(bucket);
    const out: TimeSeriesPoint[] = [];
    for (let t = bucketStart(sinceMs, bucket); t < untilMs; t += width) {
      const hit = byBucket.get(t);
      out.push({ t, value: hit?.value ?? 0, n: hit?.n ?? 0 });
    }
    return out;
  }

  // ------------------------------------------------------------------------
  // 6. Signal predictiveness
  // ------------------------------------------------------------------------

  /**
   * Spearman rank correlation between each stored decision-time feature and the
   * creator fees the launch actually earned.
   *
   * Rank correlation rather than Pearson because the fee distribution is
   * heavy-tailed: one 10 SOL token would otherwise decide every coefficient.
   * Ties get average ranks, so repeated feature values (a categorical-ish
   * feature such as `launch_hour_utc`, or a saturated 0/1 score) do not bias
   * the coefficient.
   *
   * The returned `caveat` is part of the data, not decoration: these are
   * observational correlations over a sample the platform itself selected — it
   * only launched candidates that passed the quality gate — so the range of
   * every feature is truncated and any relationship outside that range is
   * unobserved. Correlation here is not causation and not a lever.
   */
  async signalPredictiveness(): Promise<SignalCorrelation[]> {
    const rows = this.db.$raw
      .prepare(
        `SELECT p.features AS features,
                o.actual_creator_fees_sol AS outcome_fees_sol,
                t.creator_fees_collected_lamports AS collected_lamports,
                t.creator_fees_accrued_lamports AS accrued_lamports
           FROM launches l
           JOIN concepts c ON c.id = l.concept_id
           JOIN predictions p
             ON p.id = COALESCE(l.prediction_id,
                                (SELECT id FROM predictions WHERE concept_id = l.concept_id ORDER BY created_at DESC LIMIT 1))
           LEFT JOIN tokens t ON t.mint = l.mint_address
           LEFT JOIN prediction_outcomes o
             ON o.prediction_id = p.id
            AND o.horizon_hours = (SELECT MAX(horizon_hours) FROM prediction_outcomes WHERE prediction_id = p.id)
          WHERE l.status = 'confirmed'
            AND (o.id IS NOT NULL OR t.mint IS NOT NULL)`,
      )
      .all() as Array<{
      features: string | null;
      outcome_fees_sol: number | null;
      collected_lamports: number | null;
      accrued_lamports: number | null;
    }>;

    const observations: Array<{ features: Record<string, unknown>; fees: number }> = [];
    for (const row of rows) {
      const features = this.parseFeatures(row.features);
      if (!features) continue;
      const fees =
        row.outcome_fees_sol !== null && Number.isFinite(row.outcome_fees_sol)
          ? row.outcome_fees_sol
          : lamportsToSol((row.collected_lamports ?? 0) + (row.accrued_lamports ?? 0));
      observations.push({ features, fees });
    }

    const caveat =
      'Observational, not causal. The sample contains only candidates the platform chose to launch, so every feature is range-restricted by the quality gate and any apparent effect is confounded with that selection — the launches that would have tested the other end of each feature were never made. Outcomes are also right-censored: recently launched tokens are still accruing fees, so their revenue is understated relative to older ones, and any feature that drifted over time will correlate with that instead. Every feature is scored against the same outcome on the same sample, so the strongest of a long list is partly the winner of a multiple-comparisons draw. Treat a strong coefficient as a hypothesis to test with a deliberate exploration arm, never as a lever to pull.';

    if (observations.length === 0) return [];

    // Feature keys come from the data, not only from the current schema, so a
    // model version that added a feature is still analysable.
    const keys = new Set<string>(NUMERIC_FEATURE_KEYS);
    for (const observation of observations) {
      for (const [key, value] of Object.entries(observation.features)) {
        if (typeof value === 'number' && Number.isFinite(value)) keys.add(key);
      }
    }

    const out: SignalCorrelation[] = [];
    for (const key of [...keys].sort()) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const observation of observations) {
        const value = observation.features[key];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        xs.push(value);
        ys.push(observation.fees);
      }
      if (xs.length === 0) continue;

      const degenerate = new Set(xs).size < 2 || new Set(ys).size < 2;
      const correlation = degenerate ? 0 : spearman(xs, ys);
      const interval = degenerate ? { lower: null, upper: null } : fisherInterval(correlation, xs.length);
      const perfect = !degenerate && Math.abs(correlation) >= 1;
      let featureCaveat = caveat;
      if (degenerate) {
        featureCaveat = `This feature (or the fee outcome) never varied across the ${xs.length} observed launches, so no correlation is defined and 0 here means "unmeasurable", not "unrelated". ${caveat}`;
      } else if (perfect) {
        featureCaveat = `The ${xs.length} observed launches rank identically on this feature and on realised fees, giving a sample correlation of exactly ${correlation > 0 ? '+1' : '-1'}. A perfect rank order over a sample this small is what a coincidence looks like, and no confidence interval is defined for it, so none is reported. ${caveat}`;
      } else if (interval.lower === null) {
        featureCaveat = `Fewer than four launches carry this feature, so no interval can be computed and the coefficient is not interpretable. ${caveat}`;
      }
      out.push({
        feature: key,
        correlation,
        lower: interval.lower,
        upper: interval.upper,
        n: xs.length,
        // An interval is part of what makes a coefficient actionable; without
        // one the number is never "reliable", however large n happens to be.
        reliable: !degenerate && !perfect && interval.lower !== null && xs.length >= MIN_CORRELATION_N,
        degenerate,
        caveat: featureCaveat,
      });
    }

    // Strongest absolute relationships first; unreliable ones stay in the list
    // flagged rather than being silently dropped.
    out.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
    return out;
  }

  // ------------------------------------------------------------------------
  // 7. Forecast
  // ------------------------------------------------------------------------

  /**
   * Expected monthly economics, projected from the last 30 days.
   *
   * The low/base/high band comes from the observed per-launch fee quantiles
   * (p25 / mean / p75) rather than an arbitrary ±X%: an invented percentage
   * band would imply a symmetric, thin-tailed distribution, which is precisely
   * what this one is not. The base case uses the *mean* because the expected
   * total of N launches is N × mean; the median scenario is deliberately the
   * low-ish case since the median launch earns far less than the average one.
   */
  async forecast(): Promise<ProfitabilityForecast> {
    const untilMs = this.now();
    const windowDays = 30;
    const sinceMs = untilMs - windowDays * TIME.day;
    const settings = this.platformSettings();
    const network = settings.execution.network;

    const samples = this.launchSamples({ network, sinceMs, untilMs, includeAccrued: true });
    if (samples.length < MIN_FORECAST_LAUNCHES) {
      return {
        sufficient: false,
        n: samples.length,
        reason: `A projection needs at least ${MIN_FORECAST_LAUNCHES} launches with realised outcomes in the last ${windowDays} days; ${samples.length} are available on ${network}. Any number produced from this sample would be an assumption dressed as a forecast.`,
      };
    }

    const fees = samples.map((s) => s.feesSol);
    const perLaunch = {
      meanSol: mean(fees),
      medianSol: median(fees),
      p25Sol: quantile(fees, 0.25),
      p75Sol: quantile(fees, 0.75),
      p90Sol: quantile(fees, 0.9),
      n: fees.length,
    };

    const observedLaunchesPerMonth = (samples.length / windowDays) * DAYS_PER_MONTH;
    const configuredMaxLaunchesPerMonth = settings.limits.maxLaunchesPerDay * DAYS_PER_MONTH;
    // Project forward at the rate actually achieved, capped by the configured
    // ceiling. Using the ceiling alone would forecast a throughput the platform
    // has never demonstrated.
    const launchesPerMonth = Math.min(observedLaunchesPerMonth, configuredMaxLaunchesPerMonth);

    const costPerLaunchSol = mean(samples.map((s) => s.costSol));
    const expenses = this.expenseTotals(sinceMs, untilMs);
    // Costs not attributable to a launch (infrastructure, market data) recur
    // whether or not anything launches, so they are a fixed monthly line.
    const fixedMonthlyCostSol =
      (lamportsToSol(expenses.nonLaunchLamports) / windowDays) * DAYS_PER_MONTH;
    const monthlyOperatingUsd = (expenses.operatingUsd / windowDays) * DAYS_PER_MONTH;
    const solPriceUsd = this.latestSolPriceUsd();
    const usdAsSol = solPriceUsd !== null && solPriceUsd > 0 ? monthlyOperatingUsd / solPriceUsd : 0;

    const costsSol = launchesPerMonth * costPerLaunchSol + fixedMonthlyCostSol + usdAsSol;
    const scenario = (label: ForecastScenario['label'], perLaunchSol: number, basis: string): ForecastScenario => {
      const creatorFeesSol = launchesPerMonth * perLaunchSol;
      return { label, basis, creatorFeesSol, costsSol, netIncomeSol: creatorFeesSol - costsSol };
    };

    const caveats = [
      `Projected from ${samples.length} launches over ${windowDays} days on ${network}. A sample this small cannot observe the tail that produces most revenue, so the true upside is wider than the high case and the true downside is a month with no winner at all.`,
      'Tokens launched inside the window are still accruing fees, so their lifetime revenue is understated and this projection is conservative for that reason.',
      `Launch throughput is projected at the observed rate (${observedLaunchesPerMonth.toFixed(1)}/month), capped by the configured ceiling of ${configuredMaxLaunchesPerMonth.toFixed(1)}/month.`,
    ];
    const scenarios = {
      low: scenario('low', perLaunch.p25Sol, 'p25 of observed per-launch fees'),
      base: scenario('base', perLaunch.meanSol, 'mean of observed per-launch fees (the expectation of a sum of launches)'),
      high: scenario('high', perLaunch.p75Sol, 'p75 of observed per-launch fees'),
    };
    // When the mean exceeds the p75 the distribution is being carried by one or
    // two tokens, and the quantile-derived "high" case is then lower than the
    // expectation. That inversion is information, not a bug, and saying so is
    // better than reordering the scenarios to look tidy.
    if (scenarios.base.creatorFeesSol > scenarios.high.creatorFeesSol) {
      caveats.push(
        'The mean per-launch fee exceeds the 75th percentile, so the base case is above the high case. This is what extreme skew looks like: three quarters of launches earn less than the average, and the expectation is set by rare winners. The high case is a quantile scenario, not an upper bound.',
      );
    }
    if (solPriceUsd === null && monthlyOperatingUsd > 0) {
      caveats.push(
        `USD operating costs of ${monthlyOperatingUsd.toFixed(2)}/month are excluded from the SOL cost line because no SOL price has been recorded; net income is overstated by that amount.`,
      );
    }

    return {
      sufficient: true,
      n: samples.length,
      windowDays,
      perLaunchFeesSol: perLaunch,
      launchesPerMonth,
      observedLaunchesPerMonth,
      configuredMaxLaunchesPerMonth,
      launchRateBasis: 'observed rate over the last 30 days, capped by limits.maxLaunchesPerDay',
      costPerLaunchSol,
      fixedMonthlyCostSol,
      monthlyOperatingUsd,
      solPriceUsd,
      scenarios,
      caveats,
    };
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------

  private rate(successes: number, trials: number, method: 'wilson' | 'beta_posterior'): RateEstimate {
    if (method === 'wilson') {
      const interval = wilsonInterval(successes, trials);
      return {
        // With no trials the Wilson point is 0; the [0,1] interval is what
        // carries the message that nothing is known.
        point: trials > 0 ? interval.point : 0,
        lower: interval.lower,
        upper: interval.upper,
        successes,
        n: trials,
        method,
        reliable: trials >= MIN_RELIABLE_N,
      };
    }
    // Beta(1,1) is uniform: a 1-for-1 group reports ~0.67, not 1.0, and a
    // 0-for-1 group reports ~0.33, not 0.
    const posterior = betaPosterior(successes, trials, 1, 1);
    return {
      point: posterior.mean,
      lower: posterior.lower,
      upper: posterior.upper,
      successes,
      n: trials,
      method,
      reliable: trials >= MIN_RELIABLE_N,
    };
  }

  /** Per-token lifetime creator fees in SOL, one entry per token. */
  private tokenFeeValues(options: RevenueDistributionOptions): number[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.network) {
      clauses.push('network = ?');
      params.push(options.network);
    }
    if (options.sinceMs !== undefined) {
      clauses.push('created_at >= ?');
      params.push(options.sinceMs);
    }
    if (options.untilMs !== undefined) {
      clauses.push('created_at < ?');
      params.push(options.untilMs);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.$raw
      .prepare(
        `SELECT creator_fees_collected_lamports AS collected, creator_fees_accrued_lamports AS accrued
           FROM tokens ${where}`,
      )
      .all(...(params as never[])) as Array<{ collected: number; accrued: number }>;

    const includeAccrued = options.includeAccrued ?? true;
    return rows.map((r) => lamportsToSol(r.collected + (includeAccrued ? r.accrued : 0)));
  }

  /**
   * The analysable launch sample: confirmed launches that produced a token row,
   * joined to the concept, the decision-time prediction and the realised
   * outcome. Launches without a token row are excluded because their revenue is
   * unknown rather than zero.
   */
  private launchSamples(options: {
    network?: string;
    sinceMs?: number;
    untilMs?: number;
    includeAccrued?: boolean;
  }): LaunchSample[] {
    const clauses = ["l.status = 'confirmed'", 't.mint IS NOT NULL'];
    const params: unknown[] = [];
    if (options.network) {
      clauses.push('l.network = ?');
      params.push(options.network);
    }
    if (options.sinceMs !== undefined) {
      clauses.push('l.created_at >= ?');
      params.push(options.sinceMs);
    }
    if (options.untilMs !== undefined) {
      clauses.push('l.created_at < ?');
      params.push(options.untilMs);
    }

    // The lamport-denominated expense kinds that mirror on-chain launch spend
    // are excluded from the per-launch extra cost: `total_cost_lamports` on the
    // launch row already accounts for them, and adding both would double the
    // cost of every launch and silently halve the measured ROI.
    const rows = this.db.$raw
      .prepare(
        `SELECT l.id AS launch_id, l.created_at, l.confirmed_at, l.total_cost_lamports,
                c.id AS concept_id, c.category, c.archetype, c.saturation_score, c.opportunity_score,
                c.exploration_arm, c.is_exploration,
                p.features AS features,
                t.mint, t.peak_holders, t.holders, t.graduated_at, t.lifecycle, t.volume_total_sol,
                t.creator_fees_collected_lamports AS collected_lamports,
                t.creator_fees_accrued_lamports AS accrued_lamports,
                o.actual_creator_fees_sol AS outcome_fees_sol,
                COALESCE((SELECT SUM(amount_lamports) FROM expenses
                           WHERE ref_type = 'launch' AND ref_id = l.id
                             AND kind NOT IN ('launch_sol','network_fee','priority_fee')), 0) AS extra_cost_lamports,
                COALESCE((SELECT SUM(amount_usd) FROM expenses
                           WHERE ref_type IN ('launch','concept') AND ref_id IN (l.id, c.id)), 0) AS extra_cost_usd
           FROM launches l
           JOIN concepts c ON c.id = l.concept_id
           LEFT JOIN predictions p
             ON p.id = COALESCE(l.prediction_id,
                                (SELECT id FROM predictions WHERE concept_id = l.concept_id ORDER BY created_at DESC LIMIT 1))
           LEFT JOIN tokens t ON t.mint = l.mint_address
           LEFT JOIN prediction_outcomes o
             ON o.prediction_id = p.id
            AND o.horizon_hours = (SELECT MAX(horizon_hours) FROM prediction_outcomes WHERE prediction_id = p.id)
          WHERE ${clauses.join(' AND ')}`,
      )
      .all(...(params as never[])) as LaunchRow[];

    const includeAccrued = options.includeAccrued ?? true;
    return rows.map((row) => {
      const lamports = (row.collected_lamports ?? 0) + (includeAccrued ? row.accrued_lamports ?? 0 : 0);
      // A recorded outcome is the measured number at a fixed horizon; the token
      // row is the running total. Prefer the larger, since fees only accumulate
      // and a stale outcome row would otherwise understate a live token.
      const feesSol = Math.max(lamportsToSol(lamports), row.outcome_fees_sol ?? 0);
      const peakHolders = row.peak_holders ?? row.holders ?? 0;
      const graduated = row.graduated_at !== null || row.lifecycle === 'graduated';
      return {
        launchId: row.launch_id,
        createdAt: row.created_at,
        costSol: lamportsToSol(row.total_cost_lamports + row.extra_cost_lamports),
        costUsd: row.extra_cost_usd,
        feesSol,
        success: graduated || peakHolders >= SUCCESS_MIN_PEAK_HOLDERS,
        graduated,
        volumeSol: row.volume_total_sol ?? 0,
        features: this.parseFeatures(row.features) ?? {},
        concept: {
          category: row.category ?? 'other',
          archetype: row.archetype ?? 'unknown',
          saturation: row.saturation_score,
          opportunity: row.opportunity_score,
          explorationArm: row.is_exploration === 1 ? row.exploration_arm ?? 'unlabelled' : null,
        },
      };
    });
  }

  /**
   * Map a launch onto a group key. Feature-derived dimensions fall back to the
   * concept row when the stored feature vector is missing or malformed, and
   * return null when neither source can answer, so a launch is dropped from the
   * table rather than silently bucketed as "unknown" and distorting a group.
   */
  private dimensionKey(dimension: Dimension, sample: LaunchSample): { key: string; label: string } | null {
    switch (dimension) {
      case 'category': {
        const value = readString(sample.features, 'category') ?? sample.concept.category;
        return { key: value, label: value };
      }
      case 'trend_source': {
        const value = readString(sample.features, 'primary_source');
        return value ? { key: value, label: value } : null;
      }
      case 'concept_archetype': {
        const value = readString(sample.features, 'concept_archetype') ?? sample.concept.archetype;
        return { key: value, label: value };
      }
      case 'launch_hour_utc': {
        const raw = readNumber(sample.features, 'launch_hour_utc') ?? new Date(sample.createdAt).getUTCHours();
        const hour = Math.trunc(raw);
        if (hour < 0 || hour > 23) return null;
        return { key: String(hour), label: `${String(hour).padStart(2, '0')}:00 UTC` };
      }
      case 'launch_day_of_week': {
        const raw = readNumber(sample.features, 'launch_day_of_week') ?? new Date(sample.createdAt).getUTCDay();
        const day = Math.trunc(raw);
        if (day < 0 || day > 6) return null;
        return { key: String(day), label: DAY_NAMES[day] ?? String(day) };
      }
      case 'saturation_bucket': {
        const value = readNumber(sample.features, 'saturation') ?? sample.concept.saturation;
        if (value === null || value === undefined) return null;
        return bandOf(value, SATURATION_BANDS);
      }
      case 'opportunity_bucket': {
        // Opportunity is stored 0..100 on the concept; the feature vector holds
        // the same quantity scaled to 0..1 as `trend_level`.
        const featureValue = readNumber(sample.features, 'trend_level');
        const score = sample.concept.opportunity ?? (featureValue !== null ? featureValue * 100 : null);
        if (score === null) return null;
        return bandOf(score, OPPORTUNITY_BANDS);
      }
      case 'exploration_arm': {
        const arm = sample.concept.explorationArm;
        return arm ? { key: arm, label: arm } : { key: 'exploit', label: 'exploit (not an exploration arm)' };
      }
      default:
        return null;
    }
  }

  private timeSeriesQuery(metric: TimeSeriesMetric, bucket: TimeBucket): { sql: string; needsNetwork: boolean } {
    switch (metric) {
      case 'creator_fees_sol':
        return {
          needsNetwork: true,
          sql: `SELECT ${bucketSql('e.observed_at', bucket)} AS bucket,
                       SUM(e.lamports) / ${LAMPORTS_PER_SOL}.0 AS value, COUNT(*) AS n
                  FROM creator_fee_events e
                 WHERE e.kind = 'collection'
                   AND (e.token_mint IS NULL
                        OR EXISTS (SELECT 1 FROM tokens t WHERE t.mint = e.token_mint AND t.network = ?))
                   AND e.observed_at >= ? AND e.observed_at < ?
                 GROUP BY bucket`,
        };
      case 'launches':
        return {
          needsNetwork: true,
          sql: `SELECT ${bucketSql('COALESCE(l.confirmed_at, l.created_at)', bucket)} AS bucket,
                       COUNT(*) AS value, COUNT(*) AS n
                  FROM launches l
                 WHERE l.status = 'confirmed' AND l.network = ?
                   AND COALESCE(l.confirmed_at, l.created_at) >= ? AND COALESCE(l.confirmed_at, l.created_at) < ?
                 GROUP BY bucket`,
        };
      case 'organic_volume_sol':
        return {
          needsNetwork: true,
          sql: `SELECT ${bucketSql('t.created_at', bucket)} AS bucket,
                       SUM(t.volume_total_sol) AS value, COUNT(*) AS n
                  FROM tokens t
                 WHERE t.network = ? AND t.created_at >= ? AND t.created_at < ?
                 GROUP BY bucket`,
        };
      case 'spend_sol':
        return {
          needsNetwork: false,
          sql: `SELECT ${bucketSql('x.incurred_at', bucket)} AS bucket,
                       SUM(x.amount_lamports) / ${LAMPORTS_PER_SOL}.0 AS value, COUNT(*) AS n
                  FROM expenses x
                 WHERE x.incurred_at >= ? AND x.incurred_at < ?
                 GROUP BY bucket`,
        };
      case 'ai_spend_usd':
        return {
          needsNetwork: false,
          sql: `SELECT ${bucketSql('r.created_at', bucket)} AS bucket,
                       SUM(r.cost_usd) AS value, COUNT(*) AS n
                  FROM ai_requests r
                 WHERE r.created_at >= ? AND r.created_at < ?
                 GROUP BY bucket`,
        };
      case 'trends_discovered':
        return {
          needsNetwork: false,
          sql: `SELECT ${bucketSql('t.first_seen_at', bucket)} AS bucket,
                       COUNT(*) AS value, COUNT(*) AS n
                  FROM trends t
                 WHERE t.first_seen_at >= ? AND t.first_seen_at < ?
                 GROUP BY bucket`,
        };
      default:
        return { needsNetwork: false, sql: 'SELECT 0 AS bucket, 0 AS value, 0 AS n WHERE 0' };
    }
  }

  /**
   * Expense ledger totals for a window, split so callers cannot double-count.
   * `operating*` excludes the kinds that mirror on-chain launch spend already
   * recorded on the launch rows.
   */
  private expenseTotals(
    sinceMs: number,
    untilMs: number,
  ): {
    byKind: CostByKind[];
    allLamports: number;
    allUsd: number;
    operatingLamports: number;
    operatingUsd: number;
    /**
     * Operating lamports **not** already charged to a launch. Expense rows
     * carry `ref_type` values other than 'launch' and NULL ('concept',
     * 'trend', 'token', 'model', 'system', 'wallet'), and the per-launch cost
     * in `launchSamples` only picks up `ref_type = 'launch'`. Counting only
     * `ref_type IS NULL` here would drop every other kind from the cost side
     * entirely and overstate profit.
     */
    nonLaunchLamports: number;
  } {
    const rows = this.db.$raw
      .prepare(
        `SELECT kind,
                COALESCE(SUM(amount_lamports), 0) AS lamports,
                COALESCE(SUM(amount_usd), 0) AS usd,
                COUNT(*) AS n,
                COALESCE(SUM(CASE WHEN ref_type IS NULL OR ref_type <> 'launch' THEN amount_lamports ELSE 0 END), 0) AS non_launch_lamports
           FROM expenses
          WHERE incurred_at >= ? AND incurred_at < ?
          GROUP BY kind
          ORDER BY lamports DESC, usd DESC`,
      )
      .all(sinceMs, untilMs) as Array<{
      kind: string;
      lamports: number;
      usd: number;
      n: number;
      non_launch_lamports: number;
    }>;

    const onChain = new Set<string>(ON_CHAIN_EXPENSE_KINDS);
    let allLamports = 0;
    let allUsd = 0;
    let operatingLamports = 0;
    let operatingUsd = 0;
    let nonLaunchLamports = 0;
    const byKind: CostByKind[] = [];

    for (const row of rows) {
      allLamports += row.lamports;
      allUsd += row.usd;
      if (!onChain.has(row.kind)) {
        operatingLamports += row.lamports;
        operatingUsd += row.usd;
        nonLaunchLamports += row.non_launch_lamports;
      }
      byKind.push({ kind: row.kind, lamports: row.lamports, sol: lamportsToSol(row.lamports), usd: row.usd, n: row.n });
    }

    return { byKind, allLamports, allUsd, operatingLamports, operatingUsd, nonLaunchLamports };
  }

  /**
   * The most recently observed SOL price, from either the market snapshots or a
   * priced fee event. Returns null when the platform has never seen one —
   * callers must then report USD and SOL costs separately rather than invent a
   * conversion.
   */
  private latestSolPriceUsd(): number | null {
    const snapshot = this.db.$raw
      .prepare(
        `SELECT sol_price_usd AS price, observed_at AS at FROM market_snapshots
          WHERE sol_price_usd IS NOT NULL AND sol_price_usd > 0 ORDER BY observed_at DESC LIMIT 1`,
      )
      .get() as { price: number; at: number } | undefined;
    const feeEvent = this.db.$raw
      .prepare(
        `SELECT sol_price_usd AS price, observed_at AS at FROM creator_fee_events
          WHERE sol_price_usd IS NOT NULL AND sol_price_usd > 0 ORDER BY observed_at DESC LIMIT 1`,
      )
      .get() as { price: number; at: number } | undefined;

    if (snapshot && feeEvent) return snapshot.at >= feeEvent.at ? snapshot.price : feeEvent.price;
    return snapshot?.price ?? feeEvent?.price ?? null;
  }

  /** Add a USD cost to a SOL total, or return null when no rate is known. */
  private addUsdCost(solTotal: number, usdTotal: number, solPriceUsd: number | null): number | null {
    if (usdTotal === 0) return solTotal;
    if (solPriceUsd === null || solPriceUsd <= 0) return null;
    return solTotal + usdTotal / solPriceUsd;
  }

  /** Features are operator-visible JSON written by an older model version; a
   * parse failure must degrade the analysis, never abort it. */
  private parseFeatures(raw: string | null): Record<string, unknown> | null {
    if (!raw) return null;
    const parsed = parseJson<unknown>(raw, null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.log.warn('a stored prediction feature vector could not be parsed and was excluded from the analysis');
      return null;
    }
    return parsed as Record<string, unknown>;
  }

  private platformSettings(): PlatformSettings {
    if (this.settings) return this.settings.get();
    const row = this.db.$raw.prepare('SELECT value FROM settings WHERE id = ?').get('current') as
      | { value: string }
      | undefined;
    const parsed = row ? PlatformSettings.safeParse(parseJson(row.value, {})) : null;
    return parsed?.success ? parsed.data : defaultSettings();
  }
}

// --------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const SATURATION_BANDS: ReadonlyArray<{ upper: number; key: string; label: string }> = [
  { upper: 0.2, key: 'very_low', label: 'saturation < 0.2' },
  { upper: 0.4, key: 'low', label: 'saturation 0.2-0.4' },
  { upper: 0.6, key: 'moderate', label: 'saturation 0.4-0.6' },
  { upper: 0.8, key: 'high', label: 'saturation 0.6-0.8' },
  { upper: Infinity, key: 'very_high', label: 'saturation >= 0.8' },
];

const OPPORTUNITY_BANDS: ReadonlyArray<{ upper: number; key: string; label: string }> = [
  { upper: 40, key: 'below_40', label: 'opportunity < 40' },
  { upper: 55, key: '40_55', label: 'opportunity 40-55' },
  { upper: 70, key: '55_70', label: 'opportunity 55-70' },
  { upper: 85, key: '70_85', label: 'opportunity 70-85' },
  { upper: Infinity, key: '85_plus', label: 'opportunity >= 85' },
];

function bandOf(
  value: number,
  bands: ReadonlyArray<{ upper: number; key: string; label: string }>,
): { key: string; label: string } {
  for (const band of bands) {
    if (value < band.upper) return { key: band.key, label: band.label };
  }
  const last = bands[bands.length - 1]!;
  return { key: last.key, label: last.label };
}

function readNumber(features: Record<string, unknown>, key: string): number | null {
  const value = features[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(features: Record<string, unknown>, key: string): string | null {
  const value = features[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function startOfUtcDay(ms: number): number {
  return Math.floor(ms / TIME.day) * TIME.day;
}

function bucketWidthMs(bucket: TimeBucket): number {
  return bucket === 'hour' ? TIME.hour : bucket === 'day' ? TIME.day : TIME.week;
}

/**
 * The unix epoch fell on a Thursday, so week buckets are shifted by three days
 * to land on Monday 00:00 UTC — the boundary an operator reading a weekly chart
 * expects.
 */
const WEEK_MONDAY_OFFSET_MS = 3 * TIME.day;

function bucketStart(ms: number, bucket: TimeBucket): number {
  if (bucket === 'week') {
    return Math.floor((ms + WEEK_MONDAY_OFFSET_MS) / TIME.week) * TIME.week - WEEK_MONDAY_OFFSET_MS;
  }
  const width = bucketWidthMs(bucket);
  return Math.floor(ms / width) * width;
}

/** SQL bucket expression. `bucket` is a closed union, never caller-supplied text. */
function bucketSql(column: string, bucket: TimeBucket): string {
  if (bucket === 'week') {
    return `((${column} + ${WEEK_MONDAY_OFFSET_MS}) / ${TIME.week}) * ${TIME.week} - ${WEEK_MONDAY_OFFSET_MS}`;
  }
  const width = bucketWidthMs(bucket);
  return `(${column} / ${width}) * ${width}`;
}

/**
 * Average ranks, so ties share the mean of the ranks they span. Without this a
 * feature with many repeated values (an hour of day, a saturated 0/1 score)
 * would get an arbitrary ordering and a biased correlation.
 */
function averageRanks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.value === order[i]!.value) j++;
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k]!.index] = averageRank;
    i = j + 1;
  }
  return ranks;
}

function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx < 1e-12 || syy < 1e-12) return 0;
  const r = sxy / Math.sqrt(sxx * syy);
  return Math.max(-1, Math.min(1, r));
}

/** Spearman is Pearson on average ranks. */
function spearman(xs: readonly number[], ys: readonly number[]): number {
  return pearson(averageRanks(xs), averageRanks(ys));
}

/**
 * Fisher z-transform confidence interval for a correlation. Approximate for
 * Spearman (the standard error is mildly optimistic under strong ties) but far
 * better than reporting a coefficient with no uncertainty at all.
 */
function fisherInterval(r: number, n: number): { lower: number | null; upper: number | null } {
  if (n < 4) return { lower: null, upper: null };
  // atanh(±1) diverges. Clamping r to something like ±0.999999 and carrying on
  // produces an interval whose width is set by the clamp, not by the data: a
  // perfect rank correlation over eleven launches would report a 95% interval
  // of [0.999996, 0.9999997]. That is fabricated precision — a perfectly
  // monotone sample of eleven points is entirely consistent with a much weaker
  // population relationship. There is no interval to report here, so report none.
  if (!Number.isFinite(r) || Math.abs(r) >= 1) return { lower: null, upper: null };
  const z = Math.atanh(r);
  const se = 1 / Math.sqrt(n - 3);
  return { lower: Math.tanh(z - 1.959963985 * se), upper: Math.tanh(z + 1.959963985 * se) };
}
