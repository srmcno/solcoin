import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { UserRole } from '@solcoin/shared';
import { AppError } from '../../core/errors.js';
import { SESSION_COOKIE } from '../../security/auth.js';
import { requirePermission } from '../server.js';
import type { AppContainer } from '../../container.js';

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });
const CreateUserBody = z.object({
  email: z.string().email(),
  password: z.string().min(12),
  displayName: z.string().min(1).max(120),
  role: UserRole,
});
const ChangePasswordBody = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(12) });

export default async function authRoutes(
  app: FastifyInstance,
  options: FastifyPluginOptions & { container: AppContainer },
): Promise<void> {
  const { container } = options;

  app.get('/api/auth/session', async (request) => {
    if (!request.user) return { authenticated: false, user: null, csrfToken: null };
    return { authenticated: true, user: request.user, csrfToken: request.csrfToken };
  });

  app.post(
    '/api/auth/login',
    {
      // A tighter limit than the global one: this is the endpoint an attacker
      // would grind, and legitimate users sign in rarely.
      config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
    },
    async (request, reply) => {
      const body = LoginBody.parse(request.body);
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

      return { user: session.user, csrfToken: session.csrfToken, expiresAt: session.expiresAt };
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await container.auth.logout(token, request.user?.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/change-password', async (request) => {
    if (!request.user) throw new AppError('unauthorized', 'Sign in to continue.');
    const body = ChangePasswordBody.parse(request.body);
    await container.auth.changePassword(
      request.user.id,
      body.currentPassword,
      body.newPassword,
      request.cookies[SESSION_COOKIE],
    );
    return { ok: true, message: 'Password changed. All other sessions have been signed out.' };
  });

  app.get('/api/users', async (request) => {
    requirePermission(request, 'manage_users');
    return { users: await container.auth.listUsers() };
  });

  app.post('/api/users', async (request) => {
    const actor = requirePermission(request, 'manage_users');
    const body = CreateUserBody.parse(request.body);
    const user = await container.auth.createUser({ ...body, actorId: actor.id });
    return { user };
  });

  app.patch('/api/users/:id/role', async (request) => {
    const actor = requirePermission(request, 'manage_users');
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { role } = z.object({ role: UserRole }).parse(request.body);
    await container.auth.setRole(id, role, actor.id);
    return { ok: true };
  });
}
