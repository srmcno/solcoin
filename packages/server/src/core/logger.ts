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

export function createLogger(options: LoggerOptions): Logger {
  const base = pino({
    level: options.level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    hooks: {
      logMethod(args, method) {
        // Sweep rendered strings for credential-shaped substrings.
        const cleaned = args.map((a) => (typeof a === 'string' ? redactSecrets(a) : a));
        return method.apply(this, cleaned as Parameters<typeof method>);
      },
    },
    ...(options.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  }) as Logger;

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
