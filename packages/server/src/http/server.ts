import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError, isAppError, redactSecrets, safeErrorText } from '../core/errors.js';
import { componentLogger } from '../core/logger.js';
import type { Env } from '../config/env.js';
import { AuthService, CSRF_HEADER, SESSION_COOKIE, type AuthenticatedUser } from '../security/auth.js';
import type { AppContainer } from '../container.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
    csrfToken?: string;
  }
}

/**
 * HTTP surface.
 *
 * Security posture, stated explicitly because this server can spend money:
 *  - Session cookies are HttpOnly, SameSite=Lax and Secure in production, so
 *    browser JavaScript can never read a session and cross-site form posts
 *    cannot carry one.
 *  - Every mutating request additionally requires a CSRF token from a header,
 *    which SameSite alone does not cover for all browsers and proxy setups.
 *  - A strict Content-Security-Policy with no inline script. The dashboard is a
 *    compiled bundle, so it has no need for `unsafe-inline`, and refusing it is
 *    the single most effective XSS mitigation available.
 *  - Errors returned to clients carry a stable code and a human-readable
 *    message, never a stack trace and never anything that survived redaction.
 */

export interface ServerOptions {
  env: Env;
  container: AppContainer;
}

export async function createServer(options: ServerOptions): Promise<FastifyInstance> {
  const { env, container } = options;
  const log = componentLogger('http');

  const app = Fastify({
    logger: false,
    trustProxy: env.TRUST_PROXY ?? false,
    bodyLimit: 2 * 1024 * 1024,
    disableRequestLogging: true,
    genReqId: () => Math.random().toString(36).slice(2, 12),
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // The dashboard ships compiled CSS but Vite injects a style element for
        // the initial paint; inline styles cannot execute code, so allowing them
        // is a far smaller concession than allowing inline script.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: env.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  await app.register(cookie, {});

  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: () => ({
      error: { code: 'rate_limited', message: 'Too many requests. Slow down and try again shortly.' },
    }),
  });

  // CORS is only enabled when origins are explicitly configured. The default
  // deployment serves the dashboard from this same origin and needs none.
  if (env.corsOrigins.length > 0) {
    app.addHook('onRequest', async (request, reply) => {
      const origin = request.headers.origin;
      if (origin && env.corsOrigins.includes(origin)) {
        reply.header('access-control-allow-origin', origin);
        reply.header('access-control-allow-credentials', 'true');
        reply.header('access-control-allow-headers', `content-type, ${CSRF_HEADER}`);
        reply.header('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
        reply.header('vary', 'Origin');
      }
      if (request.method === 'OPTIONS') {
        reply.code(204).send();
      }
    });
  }

  // Authentication runs for every API request. Public routes opt out explicitly
  // rather than being allow-listed by prefix, which is easy to get wrong.
  const PUBLIC_ROUTES = new Set([
    'POST:/api/auth/login',
    'GET:/api/auth/session',
    'GET:/api/system/bootstrap',
    'POST:/api/system/bootstrap',
    'GET:/api/health',
  ]);

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;

    const routeKey = `${request.method}:${request.routeOptions?.url ?? request.url.split('?')[0]}`;
    const token = request.cookies[SESSION_COOKIE];

    if (token) {
      const session = await container.auth.authenticate(token);
      if (session) {
        request.user = session.user;
        request.csrfToken = session.csrfToken;
      }
    }

    if (PUBLIC_ROUTES.has(routeKey)) return;

    if (!request.user) {
      throw new AppError('unauthorized', 'Sign in to continue.');
    }

    // Any state-changing method must present the session's CSRF token.
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
      AuthService.verifyCsrf(request.csrfToken ?? '', request.headers[CSRF_HEADER] as string | undefined);
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    // Log slow or failing requests only; logging every dashboard poll is noise
    // that buries the entries that matter.
    if (reply.statusCode >= 400 || reply.elapsedTime > 1500) {
      log.info(
        {
          method: request.method,
          url: redactSecrets(request.url),
          status: reply.statusCode,
          ms: Math.round(reply.elapsedTime),
          user: request.user?.id,
        },
        'request',
      );
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({
        error: {
          code: 'validation_failed',
          message: 'The request body is invalid.',
          details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
      return;
    }

    if (isAppError(error)) {
      if (error.statusCode >= 500) {
        log.error({ err: safeErrorText(error), url: redactSecrets(request.url) }, 'request failed');
      }
      reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }

    const err = error as { statusCode?: number; message?: string };
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      log.error({ err: safeErrorText(error), url: redactSecrets(request.url) }, 'unhandled request error');
    }
    reply.code(status).send({
      error: {
        code: status === 429 ? 'rate_limited' : 'internal',
        // Never surface an unexpected error's message: it may contain
        // credentials, file paths or internal structure.
        message:
          status >= 500
            ? 'Something went wrong handling that request. The details are in the server log.'
            : redactSecrets(err.message ?? 'Request failed.'),
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.code(404).send({ error: { code: 'not_found', message: `No such endpoint: ${request.method} ${request.url.split('?')[0]}` } });
      return;
    }
    // Everything else falls through to the single-page app.
    reply.sendFile('index.html');
  });

  await registerRoutes(app, container);

  const webDist = env.WEB_DIST ? resolve(env.WEB_DIST) : resolve(process.cwd(), 'packages/web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/', index: ['index.html'] });
    log.info({ webDist }, 'serving the dashboard');
  } else {
    log.warn({ webDist }, 'dashboard bundle not found; run "npm run build" to serve the UI from this server');
    app.get('/', async () => ({
      message:
        'The API is running but the dashboard bundle has not been built. Run "npm run build" (or "npm run dev" for the development server).',
    }));
  }

  return app;
}

/** Registered lazily so route modules can import the container type freely. */
async function registerRoutes(app: FastifyInstance, container: AppContainer): Promise<void> {
  const modules = await Promise.all([
    import('./routes/auth.routes.js'),
    import('./routes/system.routes.js'),
    import('./routes/settings.routes.js'),
    import('./routes/trends.routes.js'),
    import('./routes/candidates.routes.js'),
    import('./routes/tokens.routes.js'),
    import('./routes/fees.routes.js'),
    import('./routes/wallet.routes.js'),
    import('./routes/analytics.routes.js'),
    import('./routes/jobs.routes.js'),
    import('./routes/learning.routes.js'),
    import('./routes/experiments.routes.js'),
  ]);
  for (const module of modules) {
    await app.register(module.default, { container });
  }
}

/** Helper used by route modules to enforce permissions consistently. */
export function requirePermission(request: FastifyRequest, permission: Parameters<typeof AuthService.assertPermission>[1]): AuthenticatedUser {
  if (!request.user) throw new AppError('unauthorized', 'Sign in to continue.');
  AuthService.assertPermission(request.user, permission);
  return request.user;
}

export function actorFrom(request: FastifyRequest): { type: 'user'; id?: string; label?: string; ipAddress?: string } {
  return { type: 'user', id: request.user?.id, label: request.user?.displayName, ipAddress: request.ip };
}

export type { FastifyReply, FastifyRequest };
