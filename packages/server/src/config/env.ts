import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Only infrastructure lives here: where to listen, where the database is, and
 * how to unlock the secret store. Strategy configuration lives in the database
 * and is edited from the UI; API keys live in the encrypted secret store.
 *
 * The one true secret in the environment is SOLCOIN_MASTER_KEY, which unlocks
 * everything else. It is never logged and never written to disk by the app.
 */

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4317),
  /** Absolute or relative path to the SQLite database file. */
  DATABASE_PATH: z.string().default('./data/solcoin.db'),
  /** Directory for generated artwork and metadata staging. */
  DATA_DIR: z.string().default('./data'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: z
    .string()
    .optional()
    .transform((v) => v === undefined ? undefined : v === 'true' || v === '1'),
  /**
   * Master key for the encrypted secret store. Minimum 16 characters.
   * When absent the platform boots in a locked state: it serves the UI and
   * explains what is missing, but performs no operation that needs a secret.
   */
  SOLCOIN_MASTER_KEY: z.string().min(16).optional(),
  /** Comma-separated origins allowed to call the API from a browser. */
  CORS_ORIGINS: z.string().default(''),
  /** Set to disable the scheduler in this process (e.g. a read-only replica). */
  DISABLE_SCHEDULER: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  /** Trust X-Forwarded-* headers. Only enable behind a proxy you control. */
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  /** Absolute path to the built dashboard, served as static files. */
  WEB_DIST: z.string().optional(),
  /** Bootstrap owner account, used only on a completely empty database. */
  BOOTSTRAP_EMAIL: z.string().email().optional(),
  BOOTSTRAP_PASSWORD: z.string().min(12).optional(),
});

export type Env = z.infer<typeof EnvSchema> & {
  isProduction: boolean;
  isTest: boolean;
  corsOrigins: string[];
  logPretty: boolean;
};

/** Minimal .env loader; avoids a dependency and never overrides real env vars. */
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

let cached: Env | null = null;

export function loadEnv(options: { cwd?: string; reload?: boolean } = {}): Env {
  if (cached && !options.reload) return cached;
  const cwd = options.cwd ?? process.cwd();
  loadDotEnv(resolve(cwd, '.env'));

  /*
   * An empty environment variable means "not set", not "set to the empty string".
   *
   * A `.env` file has no way to express absence except by omitting the line, and
   * the shipped `.env.example` lists every optional variable with an empty value
   * so an operator can see what exists. Handing those straight to the schema
   * made `cp .env.example .env` — the documented first step — produce a server
   * that refused to boot, complaining that an address it was never given is not
   * a valid email. Optional means optional.
   */
  const present: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && value.trim() !== '') present[key] = value;
  }

  const parsed = EnvSchema.safeParse(present);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;
  cached = {
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    corsOrigins: env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    logPretty: env.LOG_PRETTY ?? env.NODE_ENV !== 'production',
  };
  return cached;
}

export function resetEnvCache(): void {
  cached = null;
}
