import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import { requirePermission } from '../server.js';
import type { Permission } from '@solcoin/shared';
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

  /*
   * Running a job by hand needs the permission that job's side effects need,
   * not a blanket one.
   *
   * `run_research` is what an analyst holds. Gating every job behind it let an
   * analyst start `launch-queue` — a real mainnet launch of an approved
   * candidate — without `launch_token`, and `fee-collect` without
   * `collect_fees`. The dashboard offers the same Run button for every job, so
   * nothing about the UI discouraged it.
   */
  app.post('/api/jobs/:name/run', async (request) => {
    const { name } = z.object({ name: z.string() }).parse(request.params);
    const job = container.scheduler.status().find((j) => j.name === name);
    requirePermission(request, permissionForJob(name, job?.hasSideEffects ?? true));
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

/**
 * The permission a manual run of each job requires.
 *
 * Jobs that only read or compute need `run_research`. Anything that can spend,
 * launch or move funds needs the permission that operation needs on its own —
 * a manual run is not a lesser act than the operation it performs.
 *
 * Unlisted jobs fall through to `run_research`, which is right for the
 * read-only majority. A new side-effecting job is easy to forget to add here,
 * so anything the scheduler reports as having side effects and this map does
 * not name requires `edit_limits` — an operator permission an analyst does not
 * hold. Forgetting then costs an unnecessary permission check rather than an
 * unintended launch.
 */
const JOB_PERMISSIONS: Record<string, Permission> = {
  'launch-queue': 'launch_token',
  'launch-recovery': 'launch_token',
  'fee-collect': 'collect_fees',
  'wallet-reconcile': 'transfer_funds',
  'candidate-pipeline': 'generate_concepts',
  'model-train': 'manage_experiments',
  maintenance: 'edit_limits',
};

function permissionForJob(name: string, hasSideEffects: boolean): Permission {
  const mapped = JOB_PERMISSIONS[name];
  if (mapped) return mapped;
  return hasSideEffects ? 'edit_limits' : 'run_research';
}
