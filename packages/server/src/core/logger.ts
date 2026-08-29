import { createRequire } from 'node:module';
import { pino, type Logger as PinoLogger } from 'pino';
import { redactSecrets } from './errors.js';

/**
 * Structured logging with aggressive redaction.
 *
 * Private keys, API keys and session tokens must never reach a log line, a log
 * aggregator, or an error report. Redaction happens at two levels: pino's
 * path-based redaction for known field names, and a regex sweep over rendered
 * strings for anything that merely *looks* like a credential.
 */

const REDACT_PATHS = [
  'password',
  'passphrase',
  'privateKey',
  'private_key',
  'secretKey',
  'secret_key',
  'secret',
  'apiKey',
  'api_key',
  'apikey',
  'token',
  'accessToken',
  'refreshToken',
  'sessionToken',
  'authorization',
  'cookie',
  'mintSecret',
  'mintSecretEncrypted',
  'keypair',
  'seed',
  'mnemonic',
  'totpSecret',
  '*.password',
  '*.privateKey',
  '*.secretKey',
  '*.apiKey',
  '*.token',
  '*.secret',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
];

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LoggerOptions {
  level: LogLevel;
  pretty: boolean;
  /** Called for every log record so events can also be persisted. */
  sink?: (record: { level: LogLevel; component: string; message: string; context?: unknown }) => void;
}

export type Logger = PinoLogger & {
  child(bindings: Record<string, unknown>): Logger;
};

let rootLogger: Logger | null = null;

/**
 * Human-readable logs, without a worker thread.
 *
 * pino's `transport` option runs pino-pretty in a worker whose entry point it
 * resolves relative to the file pino itself is running from. The server ships
 * as a single bundled file, so that path does not exist: the worker fails to
 * start, the failure surfaces as an uncaught exception, and the process dies
 * before it has written one line — a silent boot failure in the default
 * development configuration. Using pino-pretty as an ordinary stream produces
 * the same output in-process with no path resolution to get wrong.
 *
 * It is also a development dependency, so a production install pruned with
 * `--omit=dev` will not have it. Asking for pretty logs there degrades to
 * NDJSON rather than refusing to start.
 */
function prettyDestination(): NodeJS.WritableStream | null {
  try {
    const require = createRequire(import.meta.url);
    const loaded: unknown = require('pino-pretty');
    const factory =
      typeof loaded === 'function'
        ? (loaded as (opts: Record<string, unknown>) => NodeJS.WritableStream)
        : typeof (loaded as { default?: unknown })?.default === 'function'
          ? ((loaded as { default: (opts: Record<string, unknown>) => NodeJS.WritableStream }).default)
          : null;
    if (!factory) return null;
    return factory({ colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' });
  } catch {
    return null;
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const pinoOptions = {
    level: options.level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    hooks: {
      logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void) {
        // Sweep rendered strings for credential-shaped substrings.
        const cleaned = args.map((a) => (typeof a === 'string' ? redactSecrets(a) : a));
        return method.apply(this, cleaned as Parameters<typeof method>);
      },
    },
  };

  const destination = options.pretty ? prettyDestination() : null;
  const base = (destination ? pino(pinoOptions, destination) : pino(pinoOptions)) as Logger;

  if (options.pretty && !destination) {
    base.warn('pretty logging was requested but pino-pretty could not be loaded; writing NDJSON instead');
  }

  rootLogger = base;
  return base;
}

export function getLogger(): Logger {
  if (!rootLogger) {
    rootLogger = createLogger({ level: 'info', pretty: false });
  }
  return rootLogger;
}

export function componentLogger(component: string): Logger {
  return getLogger().child({ component });
}
