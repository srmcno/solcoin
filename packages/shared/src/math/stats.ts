/**
 * Small, dependency-free statistics kernel.
 *
 * Everything here is deliberately explicit and testable: the platform makes
 * money-affecting decisions from these numbers, so they must be auditable.
 */

export function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : sum(xs) / xs.length;
}

export function variance(xs: readonly number[], sample = true): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) acc += (x - m) ** 2;
  return acc / (sample ? n - 1 : n);
}

export function stddev(xs: readonly number[], sample = true): number {
  return Math.sqrt(variance(xs, sample));
}

/** Linear-interpolated quantile (type 7, matching numpy/R default). */
export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const pos = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const loVal = sorted[lo] ?? 0;
  const hiVal = sorted[hi] ?? loVal;
  if (lo === hi) return loVal;
  return loVal + (hiVal - loVal) * (pos - lo);
}

export function median(xs: readonly number[]): number {
  return quantile(xs, 0.5);
}

/** Median absolute deviation, scaled to be a consistent estimator of sigma. */
export function mad(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}

/** Robust z-score using median/MAD; falls back to mean/stddev when MAD is degenerate. */
export function robustZ(x: number, xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const scale = mad(xs);
  if (scale > 1e-9) return (x - median(xs)) / scale;
  const sd = stddev(xs);
  if (sd > 1e-9) return (x - mean(xs)) / sd;
  return 0;
}

export function logistic(x: number): number {
  // Numerically stable sigmoid.
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

export function logit(p: number): number {
  const eps = 1e-9;
  const c = clamp(p, eps, 1 - eps);
  return Math.log(c / (1 - c));
}

/** log(1+x) that stays accurate for tiny x. */
export function log1p(x: number): number {
  return Math.log1p(x);
}

/** Squash an unbounded non-negative magnitude into [0,1] with a configurable knee. */
export function saturating(x: number, knee: number): number {
  if (knee <= 0) return 0;
  const v = Math.max(0, x);
  return v / (v + knee);
}

/** Map a value into [0,1] using log scaling; `full` is the value that maps to ~1. */
export function logScale01(x: number, full: number): number {
  if (full <= 1) return clamp(x > 0 ? 1 : 0, 0, 1);
  const v = Math.max(0, x);
  return clamp(Math.log1p(v) / Math.log1p(full), 0, 1);
}

/**
 * Theil-Sen robust slope estimator. Resistant to the spikes and dropouts that
 * are endemic in social-media counts.
 *
 * Returns slope in units of `y` per unit of `x`.
 */
export function theilSenSlope(points: ReadonlyArray<{ x: number; y: number }>): number {
  const n = points.length;
  if (n < 2) return 0;
  const slopes: number[] = [];
  // Cap pair count so a pathological series cannot blow up the event loop.
  const maxPairs = 20000;
  const stride = n * (n - 1) / 2 > maxPairs ? Math.ceil(n / Math.sqrt(2 * maxPairs)) : 1;
  for (let i = 0; i < n; i += stride) {
    for (let j = i + 1; j < n; j += stride) {
      const a = points[i]!;
      const b = points[j]!;
      const dx = b.x - a.x;
      if (Math.abs(dx) < 1e-12) continue;
      slopes.push((b.y - a.y) / dx);
    }
  }
  if (slopes.length === 0) return 0;
  return median(slopes);
}

/** Ordinary least squares slope + intercept + r². */
export function linearFit(points: ReadonlyArray<{ x: number; y: number }>): {
  slope: number;
  intercept: number;
  r2: number;
} {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: n === 1 ? points[0]!.y : 0, r2: 0 };
  const mx = mean(points.map((p) => p.x));
  const my = mean(points.map((p) => p.y));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const p of points) {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
  }
  if (sxx < 1e-12) return { slope: 0, intercept: my, r2: 0 };
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy < 1e-12 ? 0 : clamp((sxy * sxy) / (sxx * syy), 0, 1);
  return { slope, intercept, r2 };
}

/** Exponentially weighted moving average over an ordered series. */
export function ewma(values: readonly number[], alpha: number): number {
  if (values.length === 0) return 0;
  const a = clamp(alpha, 0, 1);
  let acc = values[0]!;
  for (let i = 1; i < values.length; i++) acc = a * values[i]! + (1 - a) * acc;
  return acc;
}

/** Wilson score interval for a binomial proportion — honest small-sample bounds. */
export function wilsonInterval(
  successes: number,
  trials: number,
  z = 1.959963985,
): { point: number; lower: number; upper: number } {
  if (trials <= 0) return { point: 0, lower: 0, upper: 1 };
  const p = successes / trials;
  const denom = 1 + (z * z) / trials;
  const centre = p + (z * z) / (2 * trials);
  const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * trials)) / trials);
  return {
    point: p,
    lower: clamp((centre - spread) / denom, 0, 1),
    upper: clamp((centre + spread) / denom, 0, 1),
  };
}

/**
 * Beta posterior for a rate, with a configurable prior. Used everywhere the
 * platform reports "success rate by category" so that 1/1 does not read as 100%.
 */
export function betaPosterior(
  successes: number,
  trials: number,
  priorAlpha = 1,
  priorBeta = 1,
): { alpha: number; beta: number; mean: number; lower: number; upper: number; n: number } {
  const alpha = priorAlpha + Math.max(0, successes);
  const beta = priorBeta + Math.max(0, trials - successes);
  const m = alpha / (alpha + beta);
  const v = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  const sd = Math.sqrt(v);
  // Normal approximation to the Beta credible interval; adequate for dashboards
  // and clamped to the unit interval.
  return {
    alpha,
    beta,
    mean: m,
    lower: clamp(m - 1.959963985 * sd, 0, 1),
    upper: clamp(m + 1.959963985 * sd, 0, 1),
    n: trials,
  };
}

/** Shrink a group mean toward a global mean by sample size (empirical-Bayes flavour). */
export function shrinkToPrior(
  groupMean: number,
  groupN: number,
  priorMean: number,
  priorStrength: number,
): number {
  const k = Math.max(0, priorStrength);
  if (groupN + k <= 0) return priorMean;
  return (groupMean * groupN + priorMean * k) / (groupN + k);
}

/** Brier score for probabilistic calibration tracking (lower is better). */
export function brierScore(pairs: ReadonlyArray<{ p: number; y: 0 | 1 }>): number {
  if (pairs.length === 0) return 0;
  return mean(pairs.map(({ p, y }) => (clamp(p, 0, 1) - y) ** 2));
}

/** Log loss, the proper scoring rule we optimise the success models against. */
export function logLoss(pairs: ReadonlyArray<{ p: number; y: 0 | 1 }>): number {
  if (pairs.length === 0) return 0;
  const eps = 1e-12;
  return -mean(
    pairs.map(({ p, y }) => {
      const c = clamp(p, eps, 1 - eps);
      return y === 1 ? Math.log(c) : Math.log(1 - c);
    }),
  );
}

/** Reliability diagram bins for calibration inspection. */
export function calibrationBins(
  pairs: ReadonlyArray<{ p: number; y: 0 | 1 }>,
  bins = 10,
): Array<{ binLower: number; binUpper: number; n: number; predicted: number; observed: number }> {
  const out: Array<{ binLower: number; binUpper: number; n: number; predicted: number; observed: number }> = [];
  for (let i = 0; i < bins; i++) {
    const lo = i / bins;
    const hi = (i + 1) / bins;
    const inBin = pairs.filter(({ p }) => (i === bins - 1 ? p >= lo && p <= hi : p >= lo && p < hi));
    out.push({
      binLower: lo,
      binUpper: hi,
      n: inBin.length,
      predicted: inBin.length ? mean(inBin.map((d) => d.p)) : 0,
      observed: inBin.length ? mean(inBin.map((d) => d.y)) : 0,
    });
  }
  return out;
}

/** Area under the ROC curve, computed via the rank-sum identity. */
export function auc(pairs: ReadonlyArray<{ p: number; y: 0 | 1 }>): number {
  const pos = pairs.filter((d) => d.y === 1);
  const neg = pairs.filter((d) => d.y === 0);
  if (pos.length === 0 || neg.length === 0) return 0.5;
  const sorted = [...pairs].sort((a, b) => a.p - b.p);
  // Average ranks over ties.
  const ranks = new Map<number, number>();
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]!.p === sorted[i]!.p) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks.set(k, avgRank);
    i = j + 1;
  }
  let rankSumPos = 0;
  for (let k = 0; k < sorted.length; k++) if (sorted[k]!.y === 1) rankSumPos += ranks.get(k)!;
  return clamp((rankSumPos - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length), 0, 1);
}

/** Concentration index (Gini) — used for holder-distribution risk and revenue skew. */
export function gini(values: readonly number[]): number {
  const xs = values.filter((v) => v >= 0).sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return 0;
  const total = sum(xs);
  if (total <= 0) return 0;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i + 1) * xs[i]!;
  return clamp((2 * cum) / (n * total) - (n + 1) / n, 0, 1);
}

/** Share of total contributed by the top `frac` of a distribution. */
export function topShare(values: readonly number[], frac: number): number {
  const xs = [...values].sort((a, b) => b - a);
  const total = sum(xs);
  if (total <= 0 || xs.length === 0) return 0;
  const k = Math.max(1, Math.ceil(clamp(frac, 0, 1) * xs.length));
  return clamp(sum(xs.slice(0, k)) / total, 0, 1);
}
