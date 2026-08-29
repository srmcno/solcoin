import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import { SESSION_COOKIE } from '../../security/auth.js';
import { actorFrom, requirePermission } from '../server.js';
import type { AppContainer } from '../../container.js';

const BootstrapBody = z.object({
  email: z.string().email(),
  password: z.string().min(12),
  displayName: z.string().min(1).max(120),
});

export default async function systemRoutes(
  app: FastifyInstance,
  options: FastifyPluginOptions & { container: AppContainer },
): Promise<void> {
  const { container } = options;

  /** Liveness. Deliberately unauthenticated and cheap. */
  app.get('/api/health', async () => ({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) }));

  /**
   * First-run state.
   *
   * Public because it must be readable before any account exists, but it
   * reveals nothing beyond whether setup is complete.
   */
  app.get('/api/system/bootstrap', async () => {
    const userCount = container.auth.userCount();
    return {
      needsBootstrap: userCount === 0,
      secretStoreUnlocked: container.secrets.unlocked,
      onboardingCompleted: container.settings.get().onboardingCompleted,
    };
  });

  /** Create the first owner account. Only possible while no user exists. */
  app.post('/api/system/bootstrap', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (request, reply) => {
    if (container.auth.userCount() > 0) {
      throw new AppError('conflict', 'The platform has already been set up. Sign in instead.');
    }
    const body = BootstrapBody.parse(request.body);
    const user = await container.auth.createUser({ ...body, role: 'owner', requireFirstUser: true });
    const session = await container.auth.login({
      email: body.email,
      password: body.password,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });
    reply.setCookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: container.env.isProduction,
      path: '/',
      maxAge: Math.floor((session.expiresAt - Date.now()) / 1000),
    });
    return { user, csrfToken: session.csrfToken };
  });

  app.get('/api/system/status', async (request) => {
    requirePermission(request, 'view');
    const [health, usage, wallet] = await Promise.all([
      container.health.checkAll(),
      container.guard.usage(),
      container.wallet.summary(),
    ]);
    const settings = container.settings.get();
    return {
      health,
      usage,
      wallet,
      phase: settings.execution.phase,
      network: settings.execution.network,
      autonomy: settings.autonomy,
      emergencyStop: settings.emergencyStop,
      emergencyStopReason: settings.emergencyStopReason,
      jobs: container.scheduler.status(),
    };
  });

  app.post('/api/system/emergency-stop', async (request) => {
    requirePermission(request, 'emergency_stop');
    const { reason } = z.object({ reason: z.string().min(3).max(500) }).parse(request.body);
    container.settings.emergencyStop(reason, actorFrom(request));
    return { ok: true, message: 'Emergency stop engaged. All jobs with side effects are suspended.' };
  });

  app.post('/api/system/emergency-release', async (request) => {
    requirePermission(request, 'emergency_stop');
    const { reason } = z.object({ reason: z.string().min(3).max(500) }).parse(request.body);
    container.settings.releaseEmergencyStop(reason, actorFrom(request));
    return { ok: true, message: 'Emergency stop released.' };
  });

  /**
   * Acknowledge the launch failures holding the consecutive-failure breaker
   * down. Without this the breaker cannot be reset from outside the database:
   * every launch is refused before it can produce the success that would clear
   * the count.
   */
  app.post('/api/system/clear-launch-failures', async (request) => {
    const actor = requirePermission(request, 'emergency_stop');
    const { reason } = z.object({ reason: z.string().min(3).max(500) }).parse(request.body);
    const cleared = container.guard.clearLaunchFailures(
      { actorId: actor.id, actorLabel: actor.displayName },
      reason,
    );
    return {
      ok: true,
      cleared,
      message:
        cleared === 0
          ? 'There were no failed launches to acknowledge on this network.'
          : `Acknowledged ${cleared} failed launch${cleared === 1 ? '' : 'es'}. Launching can resume once the emergency stop is released.`,
    };
  });

  app.get('/api/system/providers', async (request) => {
    requirePermission(request, 'view');
    return { providers: await container.health.checkAll() };
  });

  app.get('/api/system/secrets', async (request) => {
    requirePermission(request, 'edit_wallet_config');
    return { unlocked: container.secrets.unlocked, secrets: await container.secrets.list() };
  });

  app.put('/api/system/secrets/:key', async (request) => {
    const actor = requirePermission(request, 'edit_wallet_config');
    const { key } = z.object({ key: z.string().min(3).max(120) }).parse(request.params);
    const { value, category } = z.object({ value: z.string(), category: z.string().optional() }).parse(request.body);
    await container.secrets.set(key, value, category ?? 'api_key');
    container.audit.record({
      actorType: 'user',
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: 'secret.set',
      targetType: 'secret',
      targetId: key,
      ipAddress: request.ip,
    });
    // Providers cache credentials, so a change must take effect immediately.
    await container.refreshProviders();
    return { ok: true };
  });

  app.delete('/api/system/secrets/:key', async (request) => {
    const actor = requirePermission(request, 'edit_wallet_config');
    const { key } = z.object({ key: z.string() }).parse(request.params);
    await container.secrets.delete(key);
    container.audit.record({
      actorType: 'user',
      actorId: actor.id,
      action: 'secret.deleted',
      targetType: 'secret',
      targetId: key,
      ipAddress: request.ip,
    });
    await container.refreshProviders();
    return { ok: true };
  });

  app.get('/api/system/audit', async (request) => {
    requirePermission(request, 'view_audit');
    const query = z
      .object({
        limit: z.coerce.number().min(1).max(500).default(100),
        offset: z.coerce.number().min(0).default(0),
        action: z.string().optional(),
        targetType: z.string().optional(),
        targetId: z.string().optional(),
      })
      .parse(request.query);
    const entries = await container.audit.query(query);
    return { entries, total: container.audit.count() };
  });

  /** Prove the audit chain has not been tampered with. */
  app.get('/api/system/audit/verify', async (request) => {
    requirePermission(request, 'view_audit');
    return container.audit.verifyChain();
  });

  app.get('/api/system/logs', async (request) => {
    requirePermission(request, 'view');
    const query = z
      .object({
        limit: z.coerce.number().min(1).max(500).default(200),
        level: z.string().optional(),
        component: z.string().optional(),
      })
      .parse(request.query);
    const rows = container.db.$raw
      .prepare(
        `SELECT * FROM system_events
          WHERE (? IS NULL OR level = ?) AND (? IS NULL OR component = ?)
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(query.level ?? null, query.level ?? null, query.component ?? null, query.component ?? null, query.limit);
    return { events: rows };
  });

  app.get('/api/system/diagnostics', async (request) => {
    requirePermission(request, 'view');
    return container.diagnostics();
  });
}
