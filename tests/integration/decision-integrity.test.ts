import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from '../helpers.js';
import { QualityGateService, type GateInput } from '../../packages/server/src/services/quality-gate.service.js';
import { DEFAULT_ECONOMICS, createModelBundle, encodeFeatures, neutralFeatures, predictLaunch } from '@solcoin/shared';
let h: TestHarness;
beforeEach(() => { h = createHarness(); });
afterEach(() => h.cleanup());
function candidate(): GateInput {
  const features = neutralFeatures();
  return {
    conceptId: 'candidate', totalLaunches: 0,
    concept: { originalityScore: 1, saturationScore: 0, hardCollision: false, riskFlags: [], status: 'evaluating' },
    trend: { id: 'trend', slug: 'trend', title: 'Trend', summary: null, category: 'other', phase: 'emerging', status: 'active', opportunityScore: 100, rawOpportunityScore: 100, saturationScore: 0, velocity: 1, acceleration: 1, consistency: 1, novelty: 1, audienceEstimate: 10000, engagement: 1, memeability: 1, sourceCount: 2, remainingLifespanHours: 24, ageHours: 1, firstSeenAt: h.clock.now() - 3600000, lastSeenAt: h.clock.now(), sources: ['google_trends', 'wikipedia'], keywords: [], scoreBreakdown: {}, aiSummary: null, injectionFlagged: false },
    prediction: { ...predictLaunch(createModelBundle(encodeFeatures(features).names), features, DEFAULT_ECONOMICS), probabilities: { first_buy: 1, ten_holders: 1, hundred_holders: 1, graduation: 0.1 }, expectedValueSol: 1, probabilityProfitable: 0.5, tailConcentration: 0.2 },
  };
}
function evaluate(input: GateInput) { return new QualityGateService(h.db, h.settings, () => h.clock.now()).evaluate(input); }
describe('evidence and tail gates', () => {
  it('accepts fresh independent evidence with positive bounded forecasts', () => expect(evaluate(candidate()).passed).toBe(true));
  it.each([61, -3, NaN])('rejects stale or invalid observation age %s minutes', age => {
    const input = candidate(); input.trend.lastSeenAt = h.clock.now() - age * 60000;
    expect(evaluate(input).reason).toBe('trend_expired');
  });
  it('counts correlated social platforms as one family', () => {
    const input = candidate(); input.trend.sources = ['bluesky', 'mastodon'];
    const decision = evaluate(input);
    expect(decision.passed).toBe(false);
    expect(decision.checks.find(check => check.name === 'Source breadth')?.value).toBe(1);
  });
  it('rejects jackpot-dependent averages regardless of high expected profit', () => {
    const input = candidate(); input.prediction.tailConcentration = 0.9;
    expect(evaluate(input).passed).toBe(false);
  });
});
describe('mainnet operator eligibility', () => {
  it('keeps simulation usable without any eligibility attestation', () => expect(h.guard.checkOperational('launch').allowed).toBe(true));
  it('blocks mainnet until both human confirmations are present', () => {
    h.settings.update({ execution: { network: 'mainnet', phase: 'phase3_mainnet_approval' } }, { type: 'user' });
    expect(h.guard.checkOperational('launch').code).toBe('eligibility_required');
    h.settings.update({ execution: { usEligibilityReviewed: true } }, { type: 'user' });
    expect(h.guard.checkOperational('launch').allowed).toBe(false);
    h.settings.update({ execution: { pumpCommercialPermissionConfirmed: true } }, { type: 'user' });
    expect(h.guard.checkOperational('launch').allowed).toBe(true);
    expect(h.guard.checkOperational('fee_collection').allowed).toBe(true);
  });
  it('does not let a job attest for the operator', () => {
    expect(() => h.settings.update({ execution: { usEligibilityReviewed: true } }, { type: 'job' })).toThrow(/human operator/);
  });
});

describe('queued mainnet evidence', () => {
  it('rejects missing and expired evidence at execution time', () => {
    h.settings.update({ execution: { network: 'mainnet', phase: 'phase3_mainnet_approval' } }, { type: 'user' });
    expect(h.guard.checkLaunchEvidence('missing').code).toBe('stale_evidence');
    const now = h.clock.now();
    h.db.$raw.prepare('INSERT INTO trends (id, slug, title, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run('trend', 'trend', 'Trend', now, now, now, now);
    h.db.$raw.prepare('INSERT INTO concepts (id, trend_id, name, symbol, description, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run('concept', 'trend', 'Test', 'TEST', 'Test', now, now);
    expect(h.guard.checkLaunchEvidence('concept').allowed).toBe(true);
    h.db.$raw.prepare('UPDATE trends SET last_seen_at = ? WHERE id = ?').run(now - 61 * 60000, 'trend');
    expect(h.guard.checkLaunchEvidence('concept').code).toBe('stale_evidence');
  });
});
