import { describe, expect, it } from 'vitest';
import {
  classifyPhase,
  computeKinetics,
  computeOriginality,
  computeSaturation,
  createModelBundle,
  encodeFeatures,
  estimateAmmCreatorFeeBps,
  estimateRemainingLifespanHours,
  claimableCurveLamports,
  neutralFeatures,
  nameConfusability,
  predictLaunch,
  scoreNameQuality,
  scoreOpportunity,
  scoreTickerQuality,
  tickerConfusability,
  CURVE_VAULT_RENT_LAMPORTS,
  type CompetitorToken,
} from '@solcoin/shared';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);

function series(values: number[], stepHours = 1): Array<{ t: number; v: number }> {
  return values.map((v, i) => ({ t: NOW - (values.length - 1 - i) * stepHours * HOUR, v }));
}

describe('trend kinetics', () => {
  it('detects exponential growth as high positive velocity', () => {
    const k = computeKinetics(series([10, 15, 23, 35, 52, 78, 118]));
    expect(k.relativeVelocity).toBeGreaterThan(0.3);
    expect(k.consistency).toBeGreaterThan(0.7);
    expect(classifyPhase(k, 6)).toBe('emerging');
  });

  it('detects decline as negative velocity', () => {
    const k = computeKinetics(series([500, 400, 300, 200, 120, 80, 50]));
    expect(k.relativeVelocity).toBeLessThan(0);
    expect(classifyPhase(k, 48)).toBe('declining');
  });

  it('reports a flat series as neither growing nor declining', () => {
    const k = computeKinetics(series([100, 101, 99, 100, 100, 101, 99]));
    expect(Math.abs(k.relativeVelocity)).toBeLessThan(0.02);
  });

  it('treats an old but still-growing trend as peaking rather than emerging', () => {
    const k = computeKinetics(series([10, 15, 23, 35, 52, 78, 118]));
    expect(classifyPhase(k, 200)).toBe('peaking');
  });

  it('degrades gracefully on a single observation', () => {
    const k = computeKinetics([{ t: NOW, v: 42 }]);
    expect(k.n).toBe(1);
    expect(k.velocity).toBe(0);
    expect(Number.isFinite(k.relativeVelocity)).toBe(true);
  });

  it('gives a declining trend less remaining runway than an emerging one', () => {
    const rising = computeKinetics(series([10, 20, 40, 80]));
    const falling = computeKinetics(series([80, 40, 20, 10]));
    const risingLife = estimateRemainingLifespanHours(rising, 6, 'emerging');
    const fallingLife = estimateRemainingLifespanHours(falling, 6, 'declining');
    expect(risingLife).toBeGreaterThan(fallingLife * 2);
  });
});

describe('opportunity scoring', () => {
  const base = {
    kinetics: computeKinetics(series([10, 18, 30, 50, 85, 140])),
    phase: 'emerging' as const,
    ageHours: 8,
    remainingLifespanHours: 120,
    sourceCount: 4,
    sourceDiversity: 0.8,
    audienceEstimate: 500_000,
    novelty: 0.85,
    saturation: 0.05,
    engagement: 0.6,
    memeability: 0.75,
  };

  it('scores a fast, broad, unsaturated, early trend highly', () => {
    const result = scoreOpportunity(base);
    expect(result.score).toBeGreaterThan(65);
    expect(result.rationale.join(' ')).toContain('Driven by');
  });

  it('penalises saturation multiplicatively, not additively', () => {
    const clean = scoreOpportunity(base).score;
    const crowded = scoreOpportunity({ ...base, saturation: 0.8 }).score;
    // At 80% saturation the score must collapse, not merely dip.
    expect(crowded).toBeLessThan(clean * 0.35);
  });

  it('penalises a stale trend even when every other signal is strong', () => {
    const fresh = scoreOpportunity(base).score;
    const stale = scoreOpportunity({ ...base, ageHours: 240 }).score;
    expect(stale).toBeLessThan(fresh);
  });

  it('rewards cross-platform confirmation over single-source noise', () => {
    const broad = scoreOpportunity(base).score;
    const narrow = scoreOpportunity({ ...base, sourceCount: 1, sourceDiversity: 0.15 }).score;
    expect(broad).toBeGreaterThan(narrow);
  });

  it('keeps every score inside the reported range', () => {
    const extremes = [
      { ...base, saturation: 1, novelty: 0, memeability: 0, engagement: 0, sourceCount: 0, sourceDiversity: 0 },
      { ...base, saturation: 0, novelty: 1, memeability: 1, engagement: 1, sourceCount: 10, sourceDiversity: 1 },
    ];
    for (const input of extremes) {
      const result = scoreOpportunity(input);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    }
  });
});

describe('name and ticker confusability', () => {
  it('treats leetspeak and homoglyph variants as the same name', () => {
    expect(nameConfusability('PEPE', 'p3p3')).toBeGreaterThan(0.85);
    expect(nameConfusability('Pepe', 'РЕРЕ')).toBeGreaterThan(0.8);
  });

  it('treats spacing and punctuation as cosmetic', () => {
    expect(nameConfusability('Sleepy Capybara', 'sleepy-capybara')).toBeGreaterThan(0.9);
  });

  it('does not conflate genuinely different names', () => {
    expect(nameConfusability('Sleepy Capybara', 'Angry Ostrich')).toBeLessThan(0.4);
  });

  it('treats a one-character ticker difference as a near-collision', () => {
    expect(tickerConfusability('NAPCAP', 'NAPCAP')).toBe(1);
    expect(tickerConfusability('NAPCAP', 'NAPCAB')).toBeGreaterThan(0.8);
    expect(tickerConfusability('NAPCAP', 'ZQWRTY')).toBeLessThan(0.4);
  });
});

describe('saturation detection', () => {
  const proposal = {
    name: 'Sleepy Capybara',
    symbol: 'NAPCAP',
    description: 'A capybara asleep in a hot spring',
    competitors: [] as CompetitorToken[],
    nowMs: NOW,
  };

  it('reports an empty space as unsaturated', () => {
    const result = computeSaturation(proposal);
    expect(result.score).toBe(0);
    expect(result.competitorCount).toBe(0);
    expect(result.hardCollision).toBe(false);
    expect(result.rationale[0]).toContain('No similar tokens');
  });

  it('flags a near-identical existing token as a hard collision', () => {
    const result = computeSaturation({
      ...proposal,
      competitors: [
        { name: 'Sleepy Capybara', symbol: 'NAPCAP', createdAtMs: NOW - 2 * HOUR, marketCapUsd: 40_000 },
      ],
    });
    // Collision and saturation are separate axes and the distinction matters:
    // one identical token does not make a space crowded, but it does make the
    // launch pointless, so the hard-collision flag is what blocks it while the
    // saturation score stays proportionate to the (small) competitor mass.
    expect(result.hardCollision).toBe(true);
    expect(result.matches[0]?.similarity).toBeGreaterThan(0.9);
    expect(result.score).toBeGreaterThan(0.1);
    expect(result.score).toBeLessThan(0.4);
  });

  it('weights a recent competitor far more heavily than an old one', () => {
    const recent = computeSaturation({
      ...proposal,
      competitors: [{ name: 'Sleepy Capybara', symbol: 'SLPCAP', createdAtMs: NOW - HOUR }],
    });
    const ancient = computeSaturation({
      ...proposal,
      competitors: [{ name: 'Sleepy Capybara', symbol: 'SLPCAP', createdAtMs: NOW - 400 * HOUR }],
    });
    expect(recent.score).toBeGreaterThan(ancient.score * 2);
  });

  it('weights a competitor with real traction more than a dead one', () => {
    const strong = computeSaturation({
      ...proposal,
      competitors: [
        { name: 'Napping Capybara', symbol: 'SNOOZE', createdAtMs: NOW - 3 * HOUR, marketCapUsd: 2_000_000, graduated: true, holders: 4000 },
      ],
    });
    const weak = computeSaturation({
      ...proposal,
      competitors: [{ name: 'Napping Capybara', symbol: 'SNOOZE', createdAtMs: NOW - 3 * HOUR }],
    });
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.competitorQuality).toBeGreaterThan(weak.competitorQuality);
  });

  it('rises monotonically with competitor count but stays bounded', () => {
    const withCount = (n: number) =>
      computeSaturation({
        ...proposal,
        competitors: Array.from({ length: n }, (_, i) => ({
          name: `Sleepy Capybara ${i}`,
          symbol: `NAP${i}`,
          createdAtMs: NOW - i * HOUR,
        })),
      }).score;

    const [one, five, twenty, sixty] = [withCount(1), withCount(5), withCount(20), withCount(60)];
    expect(one).toBeLessThan(five);
    expect(five).toBeLessThan(twenty);
    expect(twenty).toBeLessThanOrEqual(sixty);
    expect(sixty).toBeLessThanOrEqual(1);
    // The marginal effect must shrink: going from 1 to 5 competitors should
    // matter far more than going from 20 to 60.
    expect(five - one).toBeGreaterThan(sixty - twenty);
  });
});

describe('originality scoring', () => {
  it('rewards a concept unlike anything generated before', () => {
    const result = computeOriginality({
      name: 'Sleepy Capybara',
      symbol: 'NAPCAP',
      description: 'A capybara asleep in a hot spring, refusing to be woken',
      priorConcepts: [
        { id: '1', name: 'Angry Ostrich', symbol: 'OSTRICH', description: 'a furious bird', createdAtMs: NOW, launched: false },
      ],
      nowMs: NOW,
    });
    expect(result.score).toBeGreaterThan(0.6);
    expect(result.isDuplicate).toBe(false);
  });

  it('marks a re-run of a previous concept as a duplicate', () => {
    const result = computeOriginality({
      name: 'Sleepy Capybara',
      symbol: 'NAPCAP',
      description: 'A capybara asleep in a hot spring',
      priorConcepts: [
        { id: '1', name: 'Sleepy Capybara', symbol: 'NAPCAP', description: 'A capybara asleep in a hot spring', createdAtMs: NOW, launched: true },
      ],
      nowMs: NOW,
    });
    expect(result.isDuplicate).toBe(true);
    expect(result.score).toBeLessThan(0.2);
  });

  it('penalises the naming clichés that saturate every token list', () => {
    const cliched = computeOriginality({
      name: 'Baby Pepe Inu 2.0',
      symbol: 'BPINU',
      description: 'Guaranteed to moon, the next 1000x',
      priorConcepts: [],
      nowMs: NOW,
    });
    expect(cliched.clichePenalty).toBeGreaterThan(0.4);
    expect(cliched.cliches.length).toBeGreaterThan(2);
    expect(cliched.score).toBeLessThan(0.5);
  });

  it('rates a short pronounceable name above an unpronounceable one', () => {
    expect(scoreNameQuality('Napcap').score).toBeGreaterThan(scoreNameQuality('Xkrzchtnw Vbqlk').score);
    expect(scoreTickerQuality('NAPCAP').score).toBeGreaterThan(scoreTickerQuality('XK9').score);
  });
});

describe('prediction and expected value', () => {
  const bundle = createModelBundle(encodeFeatures(neutralFeatures()).names);

  it('is reproducible for the same concept', () => {
    const a = predictLaunch(bundle, neutralFeatures(), undefined, 'concept-1');
    const b = predictLaunch(bundle, neutralFeatures(), undefined, 'concept-1');
    expect(a.creatorFeesSol.mean).toBe(b.creatorFeesSol.mean);
    expect(a.expectedValueSol).toBe(b.expectedValueSol);
  });

  it('keeps milestone probabilities monotone', () => {
    const result = predictLaunch(bundle, neutralFeatures(), undefined, 'monotone');
    expect(result.probabilities.first_buy).toBeGreaterThanOrEqual(result.probabilities.ten_holders);
    expect(result.probabilities.ten_holders).toBeGreaterThanOrEqual(result.probabilities.hundred_holders);
    expect(result.probabilities.hundred_holders).toBeGreaterThanOrEqual(result.probabilities.graduation);
  });

  it('starts from a pessimistic base rate, as permissionless launches warrant', () => {
    const result = predictLaunch(bundle, neutralFeatures(), undefined, 'baseline');
    expect(result.probabilities.graduation).toBeLessThan(0.05);
    expect(result.probabilities.ten_holders).toBeLessThan(0.35);
  });

  it('produces a right-skewed fee distribution where the mean exceeds the median', () => {
    const result = predictLaunch(bundle, neutralFeatures(), undefined, 'skew');
    expect(result.creatorFeesSol.mean).toBeGreaterThanOrEqual(result.creatorFeesSol.median);
    expect(result.creatorFeesSol.p90).toBeGreaterThanOrEqual(result.creatorFeesSol.p10);
    expect(result.tailConcentration).toBeGreaterThan(0);
  });

  it('rates a strong candidate above a saturated one', () => {
    const strong = { ...neutralFeatures(), trend_velocity: 0.3, saturation: 0.02, originality: 0.95, trend_source_breadth: 0.9 };
    const weak = { ...neutralFeatures(), trend_velocity: 0.01, saturation: 0.95, originality: 0.2, trend_source_breadth: 0.1 };
    const a = predictLaunch(bundle, strong, undefined, 'strong');
    const b = predictLaunch(bundle, weak, undefined, 'weak');
    expect(a.probabilities.ten_holders).toBeGreaterThan(b.probabilities.ten_holders * 2);
    expect(a.expectedValueSol).toBeGreaterThan(b.expectedValueSol);
  });

  it('reports low confidence while the model has no real outcomes', () => {
    const result = predictLaunch(bundle, neutralFeatures(), undefined, 'confidence');
    expect(bundle.trainedOn).toBe(0);
    expect(result.confidence).toBeLessThan(0.7);
  });
});

describe('pump.fun fee economics', () => {
  it('excludes the permanently stranded vault rent from the claimable amount', () => {
    expect(claimableCurveLamports(CURVE_VAULT_RENT_LAMPORTS)).toBe(0);
    expect(claimableCurveLamports(CURVE_VAULT_RENT_LAMPORTS - 1)).toBe(0);
    expect(claimableCurveLamports(CURVE_VAULT_RENT_LAMPORTS + 500_000)).toBe(500_000);
    expect(claimableCurveLamports(0)).toBe(0);
  });

  it('follows the documented inverse market-cap creator-fee curve', () => {
    // The creator share peaks just after graduation and decays as the coin grows.
    expect(estimateAmmCreatorFeeBps(420)).toBeCloseTo(95, 0);
    expect(estimateAmmCreatorFeeBps(98_240)).toBeCloseTo(5, 0);
    expect(estimateAmmCreatorFeeBps(500_000)).toBeCloseTo(5, 0);
    expect(estimateAmmCreatorFeeBps(2_500)).toBeLessThan(estimateAmmCreatorFeeBps(1_000));
    expect(estimateAmmCreatorFeeBps(0)).toBeCloseTo(30, 0);
  });
});
