import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { TIME } from '@solcoin/shared';
import { requirePermission } from '../server.js';
import { AUDIT_ACTIONS } from '../../security/audit.js';
import type { AppContainer } from '../../container.js';

const RangeQuery = z.object({
  range: z.enum(['7d', '30d', '90d', '1y', 'all']).default('30d'),
  network: z.string().optional(),
});

function rangeToMs(range: string, now: number): number {
  switch (range) {
    case '7d':
      return now - 7 * TIME.day;
    case '30d':
      return now - 30 * TIME.day;
    case '90d':
      return now - 90 * TIME.day;
    case '1y':
      return now - 365 * TIME.day;
    default:
      return 0;
  }
}

export default async function analyticsRoutes(
  app: FastifyInstance,
  options: FastifyPluginOptions & { container: AppContainer },
): Promise<void> {
  const { container } = options;

  app.get('/api/analytics/overview', async (request) => {
    requirePermission(request, 'view');
    const network = container.settings.get().execution.network;
    return container.analytics.overview(network);
  });

  app.get('/api/analytics/distribution', async (request) => {
    requirePermission(request, 'view');
    const query = RangeQuery.parse(request.query);
    return container.analytics.revenueDistribution({
      sinceMs: rangeToMs(query.range, Date.now()),
      network: query.network ?? container.settings.get().execution.network,
    });
  });

  app.get('/api/analytics/pnl', async (request) => {
    requirePermission(request, 'view');
    const query = RangeQuery.parse(request.query);
    return container.analytics.profitAndLoss({
      sinceMs: rangeToMs(query.range, Date.now()),
      network: query.network ?? container.settings.get().execution.network,
    });
  });

  app.get('/api/analytics/by/:dimension', async (request) => {
    requirePermission(request, 'view');
    const { dimension } = z
      .object({
        dimension: z.enum([
          'category',
          'trend_source',
          'launch_hour_utc',
          'launch_day_of_week',
          'concept_archetype',
          'saturation_bucket',
          'opportunity_bucket',
          'exploration_arm',
        ]),
      })
      .parse(request.params);
    const query = RangeQuery.parse(request.query);
    return {
      dimension,
      groups: await container.analytics.byDimension(dimension, {
        sinceMs: rangeToMs(query.range, Date.now()),
        network: query.network ?? container.settings.get().execution.network,
      }),
    };
  });

  app.get('/api/analytics/series', async (request) => {
    requirePermission(request, 'view');
    const query = z
      .object({
        metric: z.enum(['creator_fees_sol', 'launches', 'organic_volume_sol', 'spend_sol', 'ai_spend_usd', 'trends_discovered']),
        bucket: z.enum(['hour', 'day', 'week']).default('day'),
        range: z.enum(['7d', '30d', '90d', '1y', 'all']).default('30d'),
      })
      .parse(request.query);
    return {
      metric: query.metric,
      points: await container.analytics.timeSeries(query.metric, {
        bucket: query.bucket,
        sinceMs: rangeToMs(query.range, Date.now()),
        network: container.settings.get().execution.network,
      }),
    };
  });

  app.get('/api/analytics/signals', async (request) => {
    requirePermission(request, 'view');
    return { signals: await container.analytics.signalPredictiveness() };
  });

  app.get('/api/analytics/forecast', async (request) => {
    requirePermission(request, 'view');
    return container.analytics.forecast();
  });

  // --- Accounting -----------------------------------------------------------

  app.get('/api/accounting/ledger', async (request) => {
    requirePermission(request, 'view');
    const query = z
      .object({
        range: z.enum(['7d', '30d', '90d', '1y', 'all']).default('30d'),
        limit: z.coerce.number().min(1).max(1000).default(200),
        offset: z.coerce.number().min(0).default(0),
      })
      .parse(request.query);
    const sinceMs = rangeToMs(query.range, Date.now());
    const [entries, summary] = await Promise.all([
      container.accounting.ledger({ sinceMs, limit: query.limit, offset: query.offset }),
      container.accounting.summary({ sinceMs }),
    ]);
    return { entries, summary };
  });

  app.get('/api/accounting/monthly', async (request) => {
    requirePermission(request, 'view');
    return { months: await container.accounting.monthlyBreakdown() };
  });

  app.get('/api/accounting/export', async (request, reply) => {
    const actor = requirePermission(request, 'export_accounting');
    const query = z
      .object({ format: z.enum(['csv', 'json']).default('csv'), range: z.enum(['7d', '30d', '90d', '1y', 'all']).default('all') })
      .parse(request.query);
    const sinceMs = rangeToMs(query.range, Date.now());

    container.audit.record({
      actorType: 'user',
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: AUDIT_ACTIONS.dataExported,
      targetType: 'accounting',
      targetId: query.range,
      parameters: { format: query.format },
      ipAddress: request.ip,
    });

    const stamp = new Date().toISOString().slice(0, 10);
    if (query.format === 'json') {
      reply.header('content-type', 'application/json; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="solcoin-ledger-${stamp}.json"`);
      return container.accounting.exportJson({ sinceMs });
    }
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="solcoin-ledger-${stamp}.csv"`);
    return container.accounting.exportCsv({ sinceMs });
  });

  // --- Strategy lab ---------------------------------------------------------

  app.get('/api/strategies', async (request) => {
    requirePermission(request, 'view');
    return { strategies: container.backtest.defaultStrategies() };
  });

  app.post('/api/strategies/compare', async (request) => {
    requirePermission(request, 'view');
    const body = z
      .object({
        strategies: z.array(z.object({ name: z.string(), config: z.record(z.unknown()) })).min(1).max(6).optional(),
        range: z.enum(['30d', '90d', '1y', 'all']).default('90d'),
      })
      .parse(request.body ?? {});
    const sinceMs = rangeToMs(body.range, Date.now());
    const strategies = body.strategies ?? container.backtest.defaultStrategies().map((s) => ({ name: s.name, config: s.config }));
    return container.backtest.compareStrategies(strategies as never, { sinceMs, untilMs: Date.now() });
  });

  app.post('/api/strategies/project', async (request) => {
    requirePermission(request, 'view');
    const body = z
      .object({ months: z.number().int().min(1).max(24).default(6), draws: z.number().int().min(200).max(20000).default(4000) })
      .parse(request.body ?? {});
    const strategy = container.backtest.defaultStrategies()[1];
    return container.backtest.monteCarloProjection({ strategy: strategy?.config as never, months: body.months, draws: body.draws });
  });

  app.post('/api/strategies/sweep', async (request) => {
    requirePermission(request, 'view');
    const body = z
      .object({
        parameter: z.enum(['minOpportunityScore', 'maxSaturationScore', 'minExpectedValueSol']),
        values: z.array(z.number()).min(2).max(20),
        range: z.enum(['30d', '90d', '1y', 'all']).default('90d'),
      })
      .parse(request.body);
    return {
      parameter: body.parameter,
      results: await container.backtest.sweepThreshold({
        parameter: body.parameter,
        values: body.values,
        sinceMs: rangeToMs(body.range, Date.now()),
      }),
    };
  });
}
