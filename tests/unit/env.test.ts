import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv, resetEnvCache } from '../../packages/server/src/config/env.js';

/**
 * The first thing anyone does with this repository is copy `.env.example` to
 * `.env`. If that produces a server that will not boot, nothing else matters.
 */

let dir: string;
const saved = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'solcoin-env-'));
  resetEnvCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  resetEnvCache();
});

describe('environment loading', () => {
  /**
   * A `.env` file cannot express "absent" except by omitting a line, and the
   * shipped example lists every optional variable with an empty value so an
   * operator can see what exists. Passing those to the schema as empty strings
   * made the documented first step produce a boot failure complaining that an
   * address the operator never supplied was not a valid email.
   */
  it('treats an empty optional variable as absent, not as an empty value', () => {
    writeFileSync(
      join(dir, '.env'),
      [
        'SOLCOIN_MASTER_KEY=',
        'BOOTSTRAP_EMAIL=',
        'BOOTSTRAP_PASSWORD=',
        'WEB_DIST=',
        'CORS_ORIGINS=',
        `DATABASE_PATH=${join(dir, 'x.db')}`,
      ].join('\n'),
    );

    for (const key of ['SOLCOIN_MASTER_KEY', 'BOOTSTRAP_EMAIL', 'BOOTSTRAP_PASSWORD', 'WEB_DIST', 'CORS_ORIGINS']) {
      delete process.env[key];
    }

    const env = loadEnv({ cwd: dir, reload: true });
    expect(env.BOOTSTRAP_EMAIL).toBeUndefined();
    expect(env.BOOTSTRAP_PASSWORD).toBeUndefined();
    expect(env.SOLCOIN_MASTER_KEY).toBeUndefined();
    expect(env.corsOrigins).toEqual([]);
  });

  it('still rejects a value that is present and genuinely invalid', () => {
    writeFileSync(join(dir, '.env'), 'BOOTSTRAP_EMAIL=not-an-email\n');
    delete process.env.BOOTSTRAP_EMAIL;
    expect(() => loadEnv({ cwd: dir, reload: true })).toThrow(/BOOTSTRAP_EMAIL/);
  });

  it('reads a real value from .env', () => {
    writeFileSync(join(dir, '.env'), 'SOLCOIN_MASTER_KEY=this-key-is-long-enough\n');
    delete process.env.SOLCOIN_MASTER_KEY;
    expect(loadEnv({ cwd: dir, reload: true }).SOLCOIN_MASTER_KEY).toBe('this-key-is-long-enough');
  });
});
