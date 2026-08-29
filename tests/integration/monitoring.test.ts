import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, flushEvents, type TestHarness } from '../helpers.js';
import { MonitoringService } from '../../packages/server/src/services/monitoring.service.js';
import type { TokenMarketData } from '../../packages/server/src/providers/types.js';

/**
 * Lifecycle classification and monitoring cost control.
 *
 * The classification drives what the operator sees and what the learning loop
 * records as an outcome, so a token that is quietly dead must not read as
 * "active", and a token that recovers must be able to climb back out.
 */

const HOUR = 3_600_000;
let harness: TestHarness;
let service: MonitoringService;

/**
 * A token row references a concept and a launch, so the parents are seeded
 * first. In production those always exist by the time a token is registered.
 */
function register(mint: string, createdOffsetHours = 0): void {
  const at = harness.clock.now();
  harness.db.$raw
    .prepare(
      `INSERT INTO concepts (id, name, symbol, description, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
    )
    .run(`cpt_${mint}`, `Token ${mint}`, 'TKN', 'test concept', 'launched', at, at);
  harness.db.$raw
    .prepare(
      `INSERT INTO launches (id, concept_id, idempotency_key, network, adapter, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(`lch_${mint}`, `cpt_${mint}`, `idem_${mint}`, 'simulation', 'simulation', 'confirmed', at, at);

  service.registerToken({
    mint,
    launchId: `lch_${mint}`,
    conceptId: `cpt_${mint}`,
    trendId: null,
    network: 'simulation',
    name: `Token ${mint}`,
    symbol: 'TKN',
    metadataUri: null,
    imageUri: null,
    creatorAddress: 'Creator1111111111111111111111111111111111',
    createdOnChainAt: harness.clock.now() - createdOffsetHours * HOUR,
  });
}

function observe(mint: string, data: Partial<TokenMarketData>): void {
  service.applyObservation(mint, {
    mint,
    source: 'test',
    observedAt: harness.clock.now(),
    ...data,
  });
}

function lifecycleOf(mint: string): string {
  const row = harness.db.$raw.prepare('SELECT lifecycle FROM tokens WHERE mint = ?').get(mint) as { lifecycle: string };
  return row.lifecycle;
}

beforeEach(() => {
  harness = createHarness();
  service = new MonitoringService(harness.db, harness.settings, harness.events, () => harness.clock.now());
});

afterEach(() => harness.cleanup());

describe('lifecycle classification', () => {
  it('starts a fresh token as new and gives it a grace period', () => {
    register('mint_new');
    expect(lifecycleOf('mint_new')).toBe('new');

    harness.clock.advance(1 * HOUR);
    observe('mint_new', { volume24hSol: 0, holders: 0, txCount24h: 0 });
    expect(lifecycleOf('mint_new')).toBe('new');
  });

  it('marks a token that never traded as failed once the grace period passes', () => {
    register('mint_dead', 30);
    observe('mint_dead', { volume24hSol: 0, holders: 0, txCount24h: 0 });
    expect(lifecycleOf('mint_dead')).toBe('failed');
  });

  it('recognises early traction from the first trades', () => {
    register('mint_early', 1);
    observe('mint_early', { volume24hSol: 0.5, holders: 4, txCount24h: 6 });
    expect(lifecycleOf('mint_early')).toBe('early_traction');
  });

  it('recognises momentum from holders plus sustained volume', () => {
    register('mint_hot', 3);
    observe('mint_hot', { volume24hSol: 40, holders: 150, txCount24h: 400 });
    expect(lifecycleOf('mint_hot')).toBe('high_momentum');
  });

  it('classifies decline relative to the token own peak, not an absolute figure', () => {
    register('mint_fade', 2);
    observe('mint_fade', { volume24hSol: 100, holders: 200, txCount24h: 500 });
    expect(lifecycleOf('mint_fade')).toBe('high_momentum');

    harness.clock.advance(8 * HOUR);
    // A tenth of its own peak: declining, even though 8 SOL would be healthy
    // for a token that had never done better.
    observe('mint_fade', { volume24hSol: 8, holders: 120, txCount24h: 40 });
    expect(lifecycleOf('mint_fade')).toBe('declining');
  });

  it('marks a token dormant after the configured quiet period', () => {
    register('mint_quiet', 1);
    observe('mint_quiet', { volume24hSol: 5, holders: 20, txCount24h: 30 });

    harness.clock.advance(100 * HOUR);
    observe('mint_quiet', { volume24hSol: 0, holders: 20, txCount24h: 0 });
    expect(lifecycleOf('mint_quiet')).toBe('dormant');
  });

  it('lets a dormant token climb back out if it revives', () => {
    register('mint_revive', 1);
    observe('mint_revive', { volume24hSol: 5, holders: 20, txCount24h: 30 });
    harness.clock.advance(100 * HOUR);
    observe('mint_revive', { volume24hSol: 0, holders: 20, txCount24h: 0 });
    expect(lifecycleOf('mint_revive')).toBe('dormant');

    // On-chain tokens do not die; the platform's attention is what was reduced.
    harness.clock.advance(1 * HOUR);
    observe('mint_revive', { volume24hSol: 60, holders: 140, txCount24h: 300 });
    expect(lifecycleOf('mint_revive')).not.toBe('dormant');
  });

  it('reports graduation and keeps reporting honestly once it goes quiet', () => {
    register('mint_grad', 5);
    observe('mint_grad', { volume24hSol: 500, holders: 900, txCount24h: 3000, graduated: true });
    expect(lifecycleOf('mint_grad')).toBe('graduated');

    harness.clock.advance(200 * HOUR);
    observe('mint_grad', { volume24hSol: 0, holders: 850, txCount24h: 0, graduated: true });
    expect(lifecycleOf('mint_grad')).toBe('dormant');
  });
});

describe('monitoring cost control', () => {
  it('polls a fresh token often and a dormant one rarely', () => {
    register('mint_a');
    observe('mint_a', { volume24hSol: 2, holders: 5, txCount24h: 10 });
    const hot = harness.db.$raw.prepare('SELECT monitor_tier, next_poll_at FROM tokens WHERE mint = ?').get('mint_a') as {
      monitor_tier: string;
      next_poll_at: number;
    };
    expect(hot.monitor_tier).toBe('hot');

    register('mint_b', 1);
    observe('mint_b', { volume24hSol: 1, holders: 3, txCount24h: 4 });
    harness.clock.advance(200 * HOUR);
    observe('mint_b', { volume24hSol: 0, holders: 3, txCount24h: 0 });
    const cold = harness.db.$raw.prepare('SELECT monitor_tier, next_poll_at FROM tokens WHERE mint = ?').get('mint_b') as {
      monitor_tier: string;
      next_poll_at: number;
    };
    expect(cold.monitor_tier).toBe('dormant');
    // The dormant token must be scheduled much further out than the hot one.
    expect(cold.next_poll_at - harness.clock.now()).toBeGreaterThan(hot.next_poll_at - (harness.clock.now() - 200 * HOUR));
  });

  it('backs off a mint no provider recognises instead of hammering them', async () => {
    register('mint_unknown');
    const before = harness.db.$raw.prepare('SELECT next_poll_at FROM tokens WHERE mint = ?').get('mint_unknown') as {
      next_poll_at: number;
    };
    // No provider returns data for a very fresh mint; that is normal, not an error.
    await service.pollBatch(['mint_unknown'], []);
    const after = harness.db.$raw
      .prepare('SELECT next_poll_at, poll_failure_count FROM tokens WHERE mint = ?')
      .get('mint_unknown') as { next_poll_at: number; poll_failure_count: number };
    expect(after.poll_failure_count).toBe(1);
    expect(after.next_poll_at).toBeGreaterThan(before.next_poll_at);
  });

  it('surfaces the polling load so the cost is visible', async () => {
    for (const mint of ['m1', 'm2', 'm3']) register(mint);
    const tiers = await service.tierSummary();
    expect(tiers.length).toBeGreaterThan(0);
    const hotTier = tiers.find((t) => t.tier === 'hot');
    expect(hotTier?.count).toBe(3);
    expect(hotTier?.pollsPerHour).toBeGreaterThan(0);
  });

  it('serves the hottest tokens first when the batch is capped', () => {
    register('m_hot');
    observe('m_hot', { volume24hSol: 50, holders: 200, txCount24h: 400 });
    register('m_cold', 1);
    observe('m_cold', { volume24hSol: 1, holders: 2, txCount24h: 2 });
    harness.clock.advance(200 * HOUR);
    observe('m_cold', { volume24hSol: 0, holders: 2, txCount24h: 0 });
    harness.clock.advance(200 * HOUR);

    const due = service.dueForPoll(10);
    const hotIndex = due.findIndex((d) => d.mint === 'm_hot');
    const coldIndex = due.findIndex((d) => d.mint === 'm_cold');
    expect(hotIndex).toBeGreaterThanOrEqual(0);
    if (coldIndex >= 0) expect(hotIndex).toBeLessThan(coldIndex);
  });
});

describe('events', () => {
  it('emits the first trade exactly once', async () => {
    const seen: unknown[] = [];
    harness.events.on('token.first_trade', (p) => seen.push(p));

    register('mint_evt');
    observe('mint_evt', { volume24hSol: 1, holders: 2, txCount24h: 3 });
    harness.clock.advance(HOUR);
    observe('mint_evt', { volume24hSol: 2, holders: 4, txCount24h: 8 });

    // The bus dispatches through microtasks so one failing subscriber cannot
    // break the emitter; the test has to let them run.
    await flushEvents();
    expect(seen).toHaveLength(1);
  });

  it('emits graduation exactly once', async () => {
    const seen: unknown[] = [];
    harness.events.on('token.graduated', (p) => seen.push(p));

    register('mint_g', 2);
    observe('mint_g', { volume24hSol: 300, holders: 500, txCount24h: 900, graduated: true, marketCapUsd: 120_000 });
    harness.clock.advance(HOUR);
    observe('mint_g', { volume24hSol: 280, holders: 520, txCount24h: 850, graduated: true, marketCapUsd: 130_000 });

    await flushEvents();
    expect(seen).toHaveLength(1);
  });
});

describe('cumulative volume', () => {
  /**
   * Providers report a rolling 24-hour window. A lifetime total has to be
   * derived from those windows, and the window means two different things
   * either side of the token's first day: while the token is younger than the
   * window it is cumulative since launch, and after that it is a rate.
   *
   * Recording the largest window ever seen is neither — it is the peak day,
   * which `peak_volume_24h_sol` already answers, while the analytics sum this
   * column as total organic volume.
   */
  function totals(mint: string): { total: number; peak: number } {
    const row = harness.db.$raw
      .prepare('SELECT volume_total_sol, peak_volume_24h_sol FROM tokens WHERE mint = ?')
      .get(mint) as { volume_total_sol: number; peak_volume_24h_sol: number };
    return { total: row.volume_total_sol, peak: row.peak_volume_24h_sol };
  }

  describe('while the token is younger than the window', () => {
    it('counts everything the first observation reports', () => {
      register('mint_vol_first');
      observe('mint_vol_first', { volume24hSol: 40, holders: 12, txCount24h: 90 });
      expect(totals('mint_vol_first').total).toBeCloseTo(40, 6);
    });

    it('follows a cumulative figure rather than integrating it as a rate', () => {
      register('mint_vol_young');
      // A token launched an hour ago trading a steady 1 SOL/hour. Its reported
      // "last 24 hours" is its whole life, so it climbs 1, 2, 3...
      let traded = 0;
      for (let hour = 1; hour <= 12; hour++) {
        traded = hour;
        observe('mint_vol_young', { volume24hSol: traded, holders: hour, txCount24h: hour * 10 });
        harness.clock.advance(1 * HOUR);
      }
      // Treating that cumulative figure as a rate records roughly half of it.
      expect(totals('mint_vol_young').total).toBeCloseTo(12, 4);
    });

    it('adds nothing when a young token reports the same figure again', () => {
      register('mint_vol_flat');
      observe('mint_vol_flat', { volume24hSol: 24, holders: 9, txCount24h: 50 });
      for (let i = 0; i < 6; i++) {
        harness.clock.advance(1 * HOUR);
        // Cumulative and unchanged means nothing new traded.
        observe('mint_vol_flat', { volume24hSol: 24, holders: 9, txCount24h: 50 });
      }
      expect(totals('mint_vol_flat').total).toBeCloseTo(24, 4);
    });

    it('ignores a figure revised downwards rather than subtracting', () => {
      register('mint_vol_revised');
      observe('mint_vol_revised', { volume24hSol: 30, holders: 8, txCount24h: 40 });
      harness.clock.advance(1 * HOUR);
      observe('mint_vol_revised', { volume24hSol: 25, holders: 8, txCount24h: 40 });
      expect(totals('mint_vol_revised').total).toBeCloseTo(30, 4);
    });
  });

  describe('once the token is older than the window', () => {
    it('accumulates across days rather than keeping the best one', () => {
      // Two days old already, so every observation is a genuine rolling window.
      register('mint_vol_days', 48);
      observe('mint_vol_days', { volume24hSol: 40, holders: 12, txCount24h: 90 });
      harness.clock.advance(24 * HOUR);
      observe('mint_vol_days', { volume24hSol: 40, holders: 20, txCount24h: 180 });
      harness.clock.advance(24 * HOUR);
      observe('mint_vol_days', { volume24hSol: 40, holders: 26, txCount24h: 240 });

      const { total, peak } = totals('mint_vol_days');
      expect(total).toBeCloseTo(120, 4);
      // The best single day is a separate question and still answered.
      expect(peak).toBeCloseTo(40, 6);
    });

    it('does not double-count the overlap between successive windows', () => {
      register('mint_vol_overlap', 48);
      observe('mint_vol_overlap', { volume24hSol: 24, holders: 9, txCount24h: 50 });
      // Six more polls an hour apart, each reporting the same rolling window.
      for (let i = 0; i < 6; i++) {
        harness.clock.advance(1 * HOUR);
        observe('mint_vol_overlap', { volume24hSol: 24, holders: 9, txCount24h: 50 });
      }
      // The first window, then six hours of it: 24 + 6 × (24/24) = 30.
      expect(totals('mint_vol_overlap').total).toBeCloseTo(30, 4);
    });

    it('does not lose elapsed time to an observation that carries no volume', () => {
      register('mint_vol_gap', 48);
      observe('mint_vol_gap', { volume24hSol: 24, holders: 5, txCount24h: 30 });
      harness.clock.advance(6 * HOUR);
      // A provider that answered without a volume figure must not advance the
      // accounting marker, or those six hours would be silently dropped.
      observe('mint_vol_gap', { holders: 6 });
      harness.clock.advance(6 * HOUR);
      observe('mint_vol_gap', { volume24hSol: 24, holders: 7, txCount24h: 60 });

      // 24 for the first window, then twelve hours of it: 24 + 12 = 36.
      expect(totals('mint_vol_gap').total).toBeCloseTo(36, 4);
    });

    it('never counts more than the window actually reported', () => {
      register('mint_vol_cap', 48);
      observe('mint_vol_cap', { volume24hSol: 10, holders: 4, txCount24h: 20 });
      harness.clock.advance(10 * 24 * HOUR);
      // Ten days later the window still only evidences 10 SOL, not 100.
      observe('mint_vol_cap', { volume24hSol: 10, holders: 4, txCount24h: 20 });
      expect(totals('mint_vol_cap').total).toBeCloseTo(20, 4);
    });
  });

  it('carries a young token across the window boundary without a discontinuity', () => {
    register('mint_vol_cross');
    // Steady 1 SOL/hour from launch, observed every hour for 30 hours. The
    // cumulative reading saturates at 24 once the window stops covering the
    // token's whole life, and the rate branch takes over from there.
    for (let hour = 1; hour <= 30; hour++) {
      observe('mint_vol_cross', { volume24hSol: Math.min(hour, 24), holders: hour, txCount24h: hour * 5 });
      harness.clock.advance(1 * HOUR);
    }
    // 30 hours at 1 SOL/hour is 30 SOL, and that is what should be recorded.
    expect(totals('mint_vol_cross').total).toBeCloseTo(30, 3);
  });
});
