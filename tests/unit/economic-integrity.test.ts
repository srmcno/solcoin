import { describe, expect, it } from 'vitest';
import { createModelBundle, encodeFeatures, neutralFeatures, predictLaunch, DEFAULT_ECONOMICS } from '@solcoin/shared';
const features = neutralFeatures();
function model(graduation: number) {
  const bundle = createModelBundle(encodeFeatures(features).names);
  bundle.baseRates = { first_buy: 1, ten_holders: 1, hundred_holders: 1, graduation };
  for (const head of Object.values(bundle.classification)) { head.weights.fill(0); head.bias = 40; }
  bundle.volume24h.weights.fill(0); bundle.volume24h.bias = Math.log1p(10); bundle.volume24h.sigma = 0;
  bundle.lifespanHours.weights.fill(0); bundle.lifespanHours.bias = Math.log1p(72); bundle.lifespanHours.sigma = 0;
  return bundle;
}
describe('economic integrity', () => {
  const economics = { ...DEFAULT_ECONOMICS, creatorFeeRateCurve: 0.003, creatorFeeRateAmm: 0.003, feeCollectionCostSol: 0 };
  it('does not create turnover when graduation changes the fee venue', () => {
    const curve = predictLaunch(model(0), features, economics, 'volume');
    const amm = predictLaunch(model(1), features, economics, 'volume');
    expect(amm.creatorFeesSol.mean).toBeCloseTo(curve.creatorFeesSol.mean, 12);
  });
  it('a lifetime multiplier of one includes only day-one volume', () => {
    const prediction = predictLaunch(model(1), features, { ...economics, lifetimeVolumeMultiplier: 1 });
    expect(prediction.creatorFeesSol.mean).toBeCloseTo(10 * 0.003, 4);
  });
  it('cannot fabricate volume from zero-volume predictions with a low buyer probability', () => {
    const bundle = model(0); bundle.baseRates.first_buy = 0.2; bundle.volume24h.bias = 0;
    const prediction = predictLaunch(bundle, features, economics);
    expect(prediction.creatorFeesSol.mean).toBe(0);
    expect(prediction.expectedValueSol).toBeCloseTo(-economics.launchCostSol - economics.candidateCostSol);
  });
  it.each([NaN, Infinity, -1])('rejects invalid costs %s', value => {
    expect(() => predictLaunch(model(0), features, { ...economics, launchCostSol: value })).toThrow(RangeError);
  });
  it('rejects a fee percentage supplied as a fraction greater than one', () => {
    expect(() => predictLaunch(model(0), features, { ...economics, creatorFeeRateCurve: 3 })).toThrow(RangeError);
  });
});
