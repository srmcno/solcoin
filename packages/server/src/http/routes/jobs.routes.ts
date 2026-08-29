import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import { requirePermission } from '../server.js';
import type { AppContainer } from '../../container.js';

export default async function jobRoutes(
  app: FastifyInstance,
  options: FastifyPluginOptions & { container: AppContainer },
): Promise<void> {
  const { container } = options;

  app.get('/api/jobs', async (request) => {
    requirePermission(request, 'view');
    return { jobs: container.scheduler.status(), recentRuns: await container.scheduler.recentRuns(undefined, 40) };
  });

  app.get('/api/jobs/:name/runs', async (request) => {
    requirePermission(request, 'view');
    const { name } = z.object({ name: z.string() }).parse(request.params);
    return { runs: await container.scheduler.recentRuns(name, 60) };
  });

  app.post('/api/jobs/:name/run', async (request) => {
    requirePermission(request, 'run_research');
    const { name } = z.object({ name: z.string() }).parse(request.params);
    const result = await container.scheduler.runNow(name);
    if (!result.started) throw new AppError('conflict', result.reason ?? 'The job could not be started.');
    return { ok: true };
  });

  app.patch('/api/jobs/:name', async (request) => {
    requirePermission(request, 'edit_limits');
    const { name } = z.object({ name: z.string() }).parse(request.params);
    const body = z
      .object({ enabled: z.boolean().optional(), intervalSeconds: z.number().int().min(15).max(86_400).optional() })
      .parse(request.body);
    if (body.enabled !== undefined) container.scheduler.setEnabled(name, body.enabled);
    if (body.intervalSeconds !== undefined) container.scheduler.setInterval(name, body.intervalSeconds);
    return { ok: true };
  });
}
