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
