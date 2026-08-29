import { describe, expect, it } from 'vitest';
import {
  auc,
  betaPosterior,
  brierScore,
  calibrationBins,
  gini,
  logLoss,
  logistic,
  logit,
  mad,
  median,
  quantile,
  robustZ,
  shrinkToPrior,
  theilSenSlope,
  topShare,
  wilsonInterval,
} from '@solcoin/shared';

describe('statistics kernel', () => {
  it('computes interpolated quantiles matching the standard definition', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantile(xs, 0)).toBe(1);
    expect(quantile(xs, 1)).toBe(10);
    expect(quantile(xs, 0.5)).toBeCloseTo(5.5, 6);
    expect(quantile(xs, 0.25)).toBeCloseTo(3.25, 6);
  });

  it('returns zero rather than NaN for empty inputs', () => {
    expect(median([])).toBe(0);
    expect(mad([])).toBe(0);
    expect(gini([])).toBe(0);
    expect(topShare([], 0.1)).toBe(0);
  });

  it('resists outliers in the robust slope where least squares would not', () => {
    // A clean upward line with one catastrophic spike, which is exactly what a
    // social-media count series looks like when a bot cluster fires.
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
      { x: 4, y: 1000 },
      { x: 5, y: 5 },
      { x: 6, y: 6 },
    ];
    const slope = theilSenSlope(points);
    expect(slope).toBeGreaterThan(0.8);
    expect(slope).toBeLessThan(1.3);
  });

  it('produces a robust z-score that is not dragged by a single spike', () => {
    const baseline = [10, 11, 9, 10, 12, 10, 11];
    expect(robustZ(10, baseline)).toBeLessThan(1);
    expect(robustZ(40, baseline)).toBeGreaterThan(5);
  });

  it('keeps the logistic function stable at extreme inputs', () => {
    expect(logistic(1000)).toBe(1);
    expect(logistic(-1000)).toBe(0);
    expect(Number.isNaN(logistic(-1000))).toBe(false);
    expect(logistic(logit(0.37))).toBeCloseTo(0.37, 9);
  });

  it('never reports a one-of-one success as a certainty', () => {
    const wilson = wilsonInterval(1, 1);
    expect(wilson.point).toBe(1);
    expect(wilson.lower).toBeLessThan(0.9);

    const beta = betaPosterior(1, 1);
    expect(beta.mean).toBeLessThan(0.8);
    expect(beta.n).toBe(1);
  });

  it('tightens the credible interval as evidence accumulates', () => {
    const few = betaPosterior(5, 10);
    const many = betaPosterior(500, 1000);
    expect(many.upper - many.lower).toBeLessThan(few.upper - few.lower);
    expect(many.mean).toBeCloseTo(0.5, 2);
  });

  it('shrinks a small-sample group mean toward the prior', () => {
    // One launch earning 10 SOL against a global mean of 0.1 must not be
    // reported as a 10 SOL category.
    const shrunk = shrinkToPrior(10, 1, 0.1, 5);
    expect(shrunk).toBeLessThan(2);
    // With a large sample the group's own mean dominates.
    expect(shrinkToPrior(10, 500, 0.1, 5)).toBeGreaterThan(9.8);
  });

  it('scores calibration with proper scoring rules', () => {
    const perfect = [
      { p: 1, y: 1 as const },
      { p: 0, y: 0 as const },
    ];
    expect(brierScore(perfect)).toBe(0);
    expect(logLoss(perfect)).toBeLessThan(1e-6);

    const confidentlyWrong = [
      { p: 0.99, y: 0 as const },
      { p: 0.01, y: 1 as const },
    ];
    expect(brierScore(confidentlyWrong)).toBeGreaterThan(0.9);
    expect(logLoss(confidentlyWrong)).toBeGreaterThan(4);
  });

  it('computes AUC correctly including the tied and degenerate cases', () => {
    const separable = [
      { p: 0.9, y: 1 as const },
      { p: 0.8, y: 1 as const },
      { p: 0.2, y: 0 as const },
      { p: 0.1, y: 0 as const },
    ];
    expect(auc(separable)).toBe(1);

    const inverted = separable.map((d) => ({ p: 1 - d.p, y: d.y }));
    expect(auc(inverted)).toBe(0);

    const allTies = [
      { p: 0.5, y: 1 as const },
      { p: 0.5, y: 0 as const },
    ];
    expect(auc(allTies)).toBeCloseTo(0.5, 6);

    // A single-class sample cannot be ranked; 0.5 is the honest answer.
    expect(auc([{ p: 0.9, y: 1 }])).toBe(0.5);
  });

  it('bins calibration data without dropping the boundary value', () => {
    const bins = calibrationBins(
      [
        { p: 0, y: 0 },
        { p: 0.5, y: 1 },
        { p: 1, y: 1 },
      ],
      10,
    );
    expect(bins.reduce((acc, b) => acc + b.n, 0)).toBe(3);
    expect(bins[9]?.n).toBe(1);
  });

  it('measures revenue concentration the way the platform reports it', () => {
    // Ninety tokens earning nothing and ten carrying everything.
    const revenue = [...Array<number>(90).fill(0), ...Array<number>(10).fill(100)];
    expect(gini(revenue)).toBeGreaterThan(0.85);
    expect(topShare(revenue, 0.1)).toBeCloseTo(1, 6);

    const even = Array<number>(100).fill(1);
    expect(gini(even)).toBeLessThan(0.02);
    expect(topShare(even, 0.1)).toBeCloseTo(0.1, 2);
  });
});
