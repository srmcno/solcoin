import { describe, expect, it } from 'vitest';
import { createHarness, T0 } from '../helpers.js';
import { BacktestService } from '../../packages/server/src/services/backtest.service.js';
import { PredictionService } from '../../packages/server/src/services/prediction.service.js';
import { neutralFeatures, defaultSettings } from '@solcoin/shared';

describe('backtest smoke', () => {
  it('runs every query', async () => {
    const h = createHarness();
    const now = () => h.clock.now();
    const preds = new PredictionService(h.db, now);
    const svc = new BacktestService(h.db, preds, now);

    const raw = h.db.$raw;
    const f = JSON.stringify(neutralFeatures());
    // concept with a launch + token + outcome
    raw.prepare(`INSERT INTO concepts (id,name,symbol,description,risk_flags,hard_collision,opportunity_score,originality_score,saturation_score,created_at,updated_at) VALUES ('c1','A','A','d','[]',0,90,0.9,0.1,?,?)`).run(T0 - 86400000, T0);
    raw.prepare(`INSERT INTO predictions (id,concept_id,model_version,features,p_ten_holders,expected_value_sol,probability_profitable,expected_creator_fees_sol,created_at) VALUES ('p1','c1','v1',?,0.9,1.0,0.9,1.0,?)`).run(f, T0 - 86400000);
    raw.prepare(`INSERT INTO launches (id,concept_id,prediction_id,idempotency_key,network,adapter,status,mint_address,total_cost_lamports,created_at,updated_at) VALUES ('l1','c1','p1','k1','devnet','a','confirmed','M1',30000000,?,?)`).run(T0 - 86400000, T0);
    raw.prepare(`INSERT INTO tokens (mint,launch_id,concept_id,network,name,symbol,creator_address,lifecycle,graduated_at,holders,peak_holders,creator_fees_accrued_lamports,creator_fees_collected_lamports,created_at,updated_at) VALUES ('M1','l1','c1','devnet','A','A','C','graduated',?,50,60,1000000000,500000000,?,?)`).run(T0, T0, T0);
    raw.prepare(`INSERT INTO prediction_outcomes (id,prediction_id,token_mint,horizon_hours,actual_creator_fees_sol,created_at) VALUES ('o1','p1','M1',24,1.4,?)`).run(T0);
    raw.prepare(`INSERT INTO expenses (id,kind,amount_usd,amount_lamports,ref_type,ref_id,incurred_at,created_at) VALUES ('e1','ai_inference',1,2000000,'launch','l1',?,?)`).run(T0, T0);
    // a concept with no prediction
    raw.prepare(`INSERT INTO concepts (id,name,symbol,description,risk_flags,hard_collision,opportunity_score,originality_score,saturation_score,created_at,updated_at) VALUES ('c2','B','B','d','[]',0,90,0.9,0.1,?,?)`).run(T0 - 86400000, T0);

    const strat = svc.strategyFromSettings(defaultSettings());
    const r = await svc.replay({ strategy: strat, sinceMs: T0 - 10 * 86400000, untilMs: T0 + 86400000 });
    console.log(JSON.stringify({ considered: r.candidatesConsidered, launched: r.wouldHaveLaunched, obs: r.ofWhichObserved, net: r.realisedNetSol, fees: r.realisedFeesSol, cost: r.realisedCostSol, grad: r.observedGraduationRate, noPred: r.candidatesWithoutStoredPrediction, actual: r.actualLaunchesInWindow, rej: r.rejectionReasonBreakdown, uneval: r.unevaluableChecks, perLaunch: r.realisedPerLaunch, modelled: r.modelled }, null, 1));

    const cmp = await svc.compareStrategies(svc.defaultStrategies().map(s => ({ name: s.name, description: s.description, config: s.config })), { sinceMs: T0 - 10 * 86400000, untilMs: T0 + 86400000 });
    console.log(JSON.stringify(cmp.strategies.map(s => ({ n: s.name, l: s.launches, o: s.observedLaunches, net: s.realisedNetSol, shrunk: s.shrunkMeanNetPerLaunchSol, d: s.distinguishable, note: s.distinguishabilityNote })), null, 1));

    const proj = await svc.monteCarloProjection({ strategy: strat, months: 3, draws: 500 });
    console.log(JSON.stringify(proj, null, 1).slice(0, 900));

    const sweep = await svc.sweepThreshold({ parameter: 'minOpportunityScore', values: [10, 50, 90], sinceMs: T0 - 10 * 86400000, untilMs: T0 + 86400000 });
    console.log(JSON.stringify(sweep.map(p => ({ v: p.value, l: p.launches, o: p.observedLaunches, net: p.realisedNetSol, s: p.shrunkMeanNetPerLaunchSol, u: p.underpowered })), null, 1));

    expect(r.candidatesConsidered).toBe(1);
    h.cleanup();
  });
});
