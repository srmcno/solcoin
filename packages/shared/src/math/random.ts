/**
 * Deterministic pseudo-random generation.
 *
 * Every stochastic decision the platform makes (Monte Carlo EV, Thompson
 * sampling, experiment assignment, simulation fills) runs through a seeded
 * generator so that any decision can be replayed exactly during an audit.
 */

export interface Rng {
  /** Uniform in [0,1). */
  next(): number;
  /** Standard normal via Box-Muller. */
  normal(): number;
  /** Uniform integer in [lo, hi). */
  int(lo: number, hi: number): number;
  /** Gamma(shape, 1) via Marsaglia-Tsang. */
  gamma(shape: number): number;
  /** Beta(alpha, beta). */
  beta(alpha: number, beta: number): number;
  /** Pick one element, optionally weighted. */
  pick<T>(items: readonly T[], weights?: readonly number[]): T | undefined;
  /** Fisher-Yates shuffle (returns a new array). */
  shuffle<T>(items: readonly T[]): T[];
}

/** 32-bit string hash used to derive stable seeds from arbitrary identifiers. */
export function hashSeed(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, good enough for simulation and sampling. */
export function createRng(seed: number | string): Rng {
  let state = (typeof seed === 'string' ? hashSeed(seed) : seed >>> 0) || 0x9e3779b9;
  let spare: number | null = null;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const normal = (): number => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = next() * 2 - 1;
      v = next() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * mul;
    return u * mul;
  };

  const gamma = (shape: number): number => {
    if (shape <= 0) return 0;
    if (shape < 1) {
      // Boost: Gamma(a) = Gamma(a+1) * U^(1/a)
      return gamma(shape + 1) * Math.pow(next() || Number.EPSILON, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x = 0;
      let v = 0;
      do {
        x = normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = next();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u || Number.EPSILON) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };

  const beta = (alpha: number, betaParam: number): number => {
    const x = gamma(alpha);
    const y = gamma(betaParam);
    const denom = x + y;
    return denom > 0 ? x / denom : 0.5;
  };

  return {
    next,
    normal,
    int: (lo, hi) => (hi <= lo ? lo : lo + Math.floor(next() * (hi - lo))),
    gamma,
    beta,
    pick<T>(items: readonly T[], weights?: readonly number[]): T | undefined {
      if (items.length === 0) return undefined;
      if (!weights || weights.length !== items.length) return items[Math.floor(next() * items.length)];
      const total = weights.reduce((a, b) => a + Math.max(0, b), 0);
      if (total <= 0) return items[Math.floor(next() * items.length)];
      let r = next() * total;
      for (let i = 0; i < items.length; i++) {
        r -= Math.max(0, weights[i] ?? 0);
        if (r <= 0) return items[i];
      }
      return items[items.length - 1];
    },
    shuffle<T>(items: readonly T[]): T[] {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const a = out[i]!;
        const b = out[j]!;
        out[i] = b;
        out[j] = a;
      }
      return out;
    },
  };
}
