import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../server.js';
import type { AppContainer } from '../../container.js';

export default async function learningRoutes(
  app: FastifyInstance,
  options: FastifyPluginOptions & { container: AppContainer },
): Promise<void> {
  const { container } = options;

  app.get('/api/learning', async (request) => {
    requirePermission(request, 'view');
    const [summary, calibration, baseRates, models] = await Promise.all([
      container.learning.summary(),
      container.learning.evaluate(),
      container.learning.observedBaseRates(),
      container.predictions.listModelVersions(),
    ]);
    return { summary, calibration, baseRates, models };
  });

  app.get('/api/learning/errors', async (request) => {
    requirePermission(request, 'view');
    const { limit } = z.object({ limit: z.coerce.number().min(1).max(200).default(50) }).parse(request.query);
    return { errors: await container.learning.predictionErrors(limit) };
  });

  app.post('/api/learning/train', async (request) => {
    requirePermission(request, 'manage_experiments');
    const result = await container.learning.train({});
    return result;
  });
}
