import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../server.js';
import type { AppContainer } from '../../container.js';

export default async function experimentRoutes(
  app: FastifyInstance,
  options: FastifyPluginOptions & { container: AppContainer },
): Promise<void> {
  const { container } = options;

  app.get('/api/experiments', async (request) => {
    requirePermission(request, 'view');
    const rows = container.db.$raw.prepare('SELECT * FROM experiments ORDER BY created_at DESC LIMIT 100').all();
    return { experiments: rows, banditArms: await container.experiments.banditArms('exploration_strategy') };
  });

  app.get('/api/experiments/:id', async (request) => {
    requirePermission(request, 'view');
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return container.experiments.results(id);
  });

  app.post('/api/experiments', async (request) => {
    const actor = requirePermission(request, 'manage_experiments');
    const body = z
      .object({
        name: z.string().min(3).max(120),
        hypothesis: z.string().min(10).max(1000),
        factor: z.string().min(2).max(60),
        metric: z.string().default('creator_fees_sol'),
        minSamplesPerArm: z.number().int().min(2).max(200).default(12),
        arms: z
          .array(z.object({ key: z.string().min(1).max(60), label: z.string().min(1).max(120), config: z.record(z.unknown()) }))
          .min(2)
          .max(6),
      })
      .parse(request.body);
    return container.experiments.create({ ...body, createdBy: actor.id });
  });

  app.post('/api/experiments/:id/start', async (request) => {
    const actor = requirePermission(request, 'manage_experiments');
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await container.experiments.start(id, { id: actor.id, label: actor.displayName });
    return { ok: true };
  });

  app.post('/api/experiments/:id/stop', async (request) => {
    const actor = requirePermission(request, 'manage_experiments');
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { conclusion } = z.object({ conclusion: z.string().max(2000).default('') }).parse(request.body ?? {});
    await container.experiments.stop(id, conclusion, { id: actor.id, label: actor.displayName });
    return { ok: true };
  });
}
