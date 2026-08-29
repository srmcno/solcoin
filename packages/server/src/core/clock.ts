/**
 * Injectable clock.
 *
 * Every timestamp in the system flows through this so that tests, backtests and
 * simulations can run against a controlled timeline without touching Date.now.
 */
export interface Clock {
  now(): number;
  date(): Date;
  /** Resolves after `ms`, or immediately for a fake clock that has been advanced. */
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  date: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

export function createFixedClock(startMs: number): Clock & { advance(ms: number): void; set(ms: number): void } {
  let current = startMs;
  return {
    now: () => current,
    date: () => new Date(current),
    sleep: async (ms) => {
      current += Math.max(0, ms);
    },
    advance: (ms) => {
      current += ms;
    },
    set: (ms) => {
      current = ms;
    },
  };
}

export function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function utcDayKey(ms: number): string {
  return new Date(startOfUtcDay(ms)).toISOString().slice(0, 10);
}
