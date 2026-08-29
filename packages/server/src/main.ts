import { loadEnv } from './config/env.js';
import { createLogger, componentLogger } from './core/logger.js';
import { safeErrorText } from './core/errors.js';
import { createContainer } from './container.js';
import { buildJobs } from './jobs/definitions.js';
import { createServer } from './http/server.js';
import { closeDatabase } from './db/client.js';

/**
 * Process entry point.
 *
 * Boot order matters: configuration, then logging (so everything after is
 * captured), then the container (which runs migrations and constructs
 * providers), then the scheduler, then HTTP last. Serving traffic before the
 * container is ready would expose half-initialised state.
 *
 * Shutdown is the reverse and is deliberately patient: the scheduler is stopped
 * and given time for in-flight jobs to unwind, because killing a process
 * mid-launch is exactly the situation the idempotency machinery exists to
 * survive but should not have to.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger({ level: env.LOG_LEVEL, pretty: env.logPretty });
  const boot = componentLogger('boot');

  boot.info(
    { nodeEnv: env.NODE_ENV, database: env.DATABASE_PATH, port: env.PORT, host: env.HOST },
    'starting solcoin',
  );

  if (!env.SOLCOIN_MASTER_KEY) {
    boot.warn(
      'SOLCOIN_MASTER_KEY is not set. The platform will start in a LOCKED state: the dashboard works and ' +
        'zero-auth research runs, but no credential can be stored or read, no wallet can be unlocked, and ' +
        'no launch can be signed. Set a key of at least 16 characters and restart to enable those features.',
    );
  }

  const container = await createContainer({ env });

  const bootstrapNeeded = container.auth.userCount() === 0;
  if (bootstrapNeeded && env.BOOTSTRAP_EMAIL && env.BOOTSTRAP_PASSWORD) {
    // Non-interactive first run, for container deployments. The UI path is the
    // normal one; this exists so a headless deploy is not a chicken-and-egg.
    await container.auth
      .createUser({
        email: env.BOOTSTRAP_EMAIL,
        password: env.BOOTSTRAP_PASSWORD,
        displayName: 'Owner',
        role: 'owner',
      })
      .then(() => boot.info({ email: env.BOOTSTRAP_EMAIL }, 'bootstrap owner account created from the environment'))
      .catch((e: unknown) => boot.error({ err: safeErrorText(e, 200) }, 'bootstrap account creation failed'));
  } else if (bootstrapNeeded) {
    boot.info('No accounts exist yet. Open the dashboard to create the first owner account.');
  }

  if (!env.DISABLE_SCHEDULER) {
    container.scheduler.registerAll(buildJobs(container));
    container.scheduler.start();
  } else {
    boot.info('Scheduler disabled by DISABLE_SCHEDULER; this process serves the API only.');
  }

  const app = await createServer({ env, container });
  await app.listen({ host: env.HOST, port: env.PORT });

  const settings = container.settings.get();
  boot.info(
    {
      url: `http://${env.HOST}:${env.PORT}`,
      network: settings.execution.network,
      phase: settings.execution.phase,
      launchAutonomy: settings.autonomy.launch,
      emergencyStop: settings.emergencyStop,
      trendProviders: container.trendProviders.length,
      marketProviders: container.marketProviders.length,
    },
    'solcoin is ready',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    boot.info({ signal }, 'shutting down');
    // Stop accepting work first, then let in-flight jobs finish.
    const timer = setTimeout(() => {
      boot.error('shutdown timed out; forcing exit');
      process.exit(1);
    }, 20_000);
    timer.unref();

    try {
      await app.close();
      await container.shutdown();
      closeDatabase(container.db);
      boot.info('shutdown complete');
      process.exit(0);
    } catch (e) {
      boot.error({ err: safeErrorText(e, 300) }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error({ err: safeErrorText(reason, 500) }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    log.fatal({ err: safeErrorText(error, 500) }, 'uncaught exception; shutting down');
    void shutdown('uncaughtException');
  });
}

main().catch((e: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
