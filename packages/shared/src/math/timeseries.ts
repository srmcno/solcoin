import { clamp, ewma, linearFit, mean, quantile, theilSenSlope } from './stats.js';

export interface TimePoint {
  /** Unix milliseconds. */
  t: number;
  v: number;
}

/** Sort ascending by time and drop non-finite values. */
export function normaliseSeries(points: readonly TimePoint[]): TimePoint[] {
  return points
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
}

export interface TrendKinetics {
  /** Latest observed value. */
  level: number;
  /** Robust slope in value-units per hour. */
  velocity: number;
  /** Growth rate relative to the series baseline, per hour. Unitless. */
  relativeVelocity: number;
  /** Change in velocity between the older and newer half, per hour². */
  acceleration: number;
  /** 0..1 measure of how monotone/clean the growth is. */
  consistency: number;
  /** Hours spanned by the observations. */
  spanHours: number;
  /** Number of observations used. */
  n: number;
}

/**
 * Derive growth kinetics from a raw interest series.
 *
 * Social counts are spiky and heteroscedastic, so we work on log1p values with
 * a robust (Theil-Sen) slope, and express velocity relative to a baseline so
 * that a subreddit with 50 mentions and one with 50,000 are comparable.
 */
export function computeKinetics(points: readonly TimePoint[]): TrendKinetics {
  const series = normaliseSeries(points);
  const n = series.length;
  if (n === 0) {
    return { level: 0, velocity: 0, relativeVelocity: 0, acceleration: 0, consistency: 0, spanHours: 0, n: 0 };
  }
  const last = series[n - 1]!;
  if (n === 1) {
    return { level: last.v, velocity: 0, relativeVelocity: 0, acceleration: 0, consistency: 0, spanHours: 0, n: 1 };
  }

  const t0 = series[0]!.t;
  const spanHours = (last.t - t0) / 3_600_000;
  const asHours = series.map((p) => ({ x: (p.t - t0) / 3_600_000, y: Math.log1p(Math.max(0, p.v)) }));

  const velocityLog = theilSenSlope(asHours);
  // Baseline = 25th percentile of the series, a stable "quiet level".
  const baseline = Math.max(1, quantile(series.map((p) => p.v), 0.25));
  const velocity = velocityLog * Math.max(1, last.v);
  const relativeVelocity = velocityLog; // slope of log ≈ fractional growth per hour

  // Acceleration: compare the slope of the newer half against the older half.
  const mid = Math.floor(asHours.length / 2);
  const older = asHours.slice(0, Math.max(2, mid));
  const newer = asHours.slice(Math.min(asHours.length - 2, mid));
  const slopeOld = theilSenSlope(older);
  const slopeNew = theilSenSlope(newer);
  const halfSpan = Math.max(0.25, spanHours / 2);
  const acceleration = (slopeNew - slopeOld) / halfSpan;

  // Consistency: r² of the log-linear fit, penalised when the series oscillates.
  const { r2 } = linearFit(asHours);
  const diffs: number[] = [];
  for (let i = 1; i < asHours.length; i++) diffs.push(asHours[i]!.y - asHours[i - 1]!.y);
  const positiveFraction = diffs.length ? diffs.filter((d) => d >= 0).length / diffs.length : 0;
  const consistency = clamp(0.5 * r2 + 0.5 * positiveFraction, 0, 1);

  return {
    level: last.v,
    velocity,
    relativeVelocity,
    acceleration,
    consistency,
    spanHours,
    n,
  };
}

/**
 * Trend lifecycle phase, inferred from kinetics.
 *
 * `emerging` is the phase we want to launch into: real growth, still early.
 */
export type TrendPhase = 'nascent' | 'emerging' | 'peaking' | 'declining' | 'dormant';

export function classifyPhase(k: TrendKinetics, ageHours: number): TrendPhase {
  if (k.n < 3 || k.spanHours < 1) return 'nascent';
  if (k.relativeVelocity > 0.05 && k.acceleration >= -0.01) {
    return ageHours < 72 ? 'emerging' : 'peaking';
  }
  if (k.relativeVelocity > 0.005) return 'peaking';
  if (k.relativeVelocity < -0.02) return 'declining';
  return k.level > 0 ? 'peaking' : 'dormant';
}

/**
 * Estimate remaining attention lifespan in hours.
 *
 * Internet attention decays roughly exponentially once growth stops. We fit an
 * implied decay constant from the observed deceleration and cap the estimate to
 * a plausible range for meme-cycle phenomena.
 */
export function estimateRemainingLifespanHours(k: TrendKinetics, ageHours: number, phase: TrendPhase): number {
  const base = (() => {
    switch (phase) {
      case 'nascent':
        return 96;
      case 'emerging':
        return 120;
      case 'peaking':
        return 60;
      case 'declining':
        return 18;
      case 'dormant':
        return 4;
    }
  })();
  // Faster growth tends to mean a sharper, shorter cycle; steady growth lasts longer.
  const speedPenalty = clamp(1 - Math.abs(k.relativeVelocity) * 1.2, 0.35, 1.2);
  const consistencyBonus = 0.7 + 0.6 * k.consistency;
  const agePenalty = clamp(1 - ageHours / 720, 0.25, 1);
  return clamp(base * speedPenalty * consistencyBonus * agePenalty, 2, 720);
}

/** Smooth a series for charting without lagging badly at the right edge. */
export function smooth(points: readonly TimePoint[], alpha = 0.4): TimePoint[] {
  const series = normaliseSeries(points);
  const out: TimePoint[] = [];
  let acc: number | null = null;
  for (const p of series) {
    acc = acc === null ? p.v : alpha * p.v + (1 - alpha) * acc;
    out.push({ t: p.t, v: acc });
  }
  return out;
}

/** Bucket a series into fixed-width time bins, summing values within a bin. */
export function bucketise(points: readonly TimePoint[], bucketMs: number): TimePoint[] {
  if (bucketMs <= 0) return normaliseSeries(points);
  const buckets = new Map<number, number>();
  for (const p of normaliseSeries(points)) {
    const key = Math.floor(p.t / bucketMs) * bucketMs;
    buckets.set(key, (buckets.get(key) ?? 0) + p.v);
  }
  return [...buckets.entries()].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
}

/** Simple EWMA-based anomaly score: how many robust deviations is the latest point? */
export function anomalyScore(points: readonly TimePoint[], alpha = 0.3): number {
  const series = normaliseSeries(points);
  if (series.length < 4) return 0;
  const values = series.map((p) => p.v);
  const history = values.slice(0, -1);
  const expected = ewma(history, alpha);
  const residuals = history.map((v, i) => Math.abs(v - ewma(history.slice(0, i + 1), alpha)));
  const scale = Math.max(1, mean(residuals));
  return (values[values.length - 1]! - expected) / scale;
}
