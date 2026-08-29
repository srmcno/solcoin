import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import { requirePermission } from '../server.js';
import type { AppContainer } from '../../container.js';

export default async function trendRoutes(
  app: FastifyInstance,
  options: FastifyPluginOptions & { container: AppContainer },
): Promise<void> {
  const { container } = options;

  app.get('/api/trends', async (request) => {
    requirePermission(request, 'view');
    const query = z
      .object({
        limit: z.coerce.number().min(1).max(200).default(50),
        minScore: z.coerce.number().min(0).max(100).default(0),
        status: z.string().optional(),
      })
      .parse(request.query);
    const trends = await container.trends.listTop(query);
    return {
      trends,
      generationThreshold: container.settings.get().research.conceptGenerationThreshold,
      marketConditions: container.research.latestMarketConditions(),
    };
  });

  app.get('/api/trends/:id', async (request) => {
    requirePermission(request, 'view');
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const trend = await container.trends.getById(id);
    if (!trend) throw new AppError('not_found', 'No such trend.');

    const [observations, concepts] = await Promise.all([
      container.trends.getObservations(id, 600),
      Promise.resolve(
        container.db.$raw
          .prepare(
            `SELECT id, name, symbol, status, opportunity_score, originality_score, saturation_score,
                    ai_panel_score, rejection_reason, rejection_detail, created_at
               FROM concepts WHERE trend_id = ? ORDER BY created_at DESC LIMIT 40`,
          )
          .all(id),
      ),
    ]);

    return { trend, observations, concepts };
  });

  /** Trigger a discovery cycle on demand. */
  app.post('/api/trends/discover', async (request) => {
    requirePermission(request, 'run_research');
    const started = await container.scheduler.runNow('trend-discovery');
    if (!started.started) throw new AppError('conflict', started.reason ?? 'Discovery could not be started.');
    return { ok: true, message: 'Discovery started. Results appear as providers report in.' };
  });

  app.get('/api/opportunities', async (request) => {
    requirePermission(request, 'view');
    const config = container.settings.get();
    const trends = await container.trends.listTop({ limit: 40, status: 'active' });
    const qualifying = trends.filter((t) => t.opportunityScore >= config.research.conceptGenerationThreshold);
    return {
      opportunities: trends,
      qualifyingCount: qualifying.length,
      thresholds: {
        generation: config.research.conceptGenerationThreshold,
        gate: config.qualityGate.minOpportunityScore,
        maxSaturation: config.qualityGate.maxSaturationScore,
        maxTrendAgeHours: config.qualityGate.maxTrendAgeHours,
      },
    };
  });
}
