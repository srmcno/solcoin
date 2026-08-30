import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureEnvFile } from '../../packages/server/src/cli/setup-env.js';

/**
 * How `npm run setup` decides which master key is the real one.
 *
 * Getting this wrong is not recoverable: the key encrypts the operating
 * wallet, so an operator who backs up the wrong one loses the wallet.
 */

let dir: string;
const saved = process.env.SOLCOIN_MASTER_KEY;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'solcoin-env-'));
  delete process.env.SOLCOIN_MASTER_KEY;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.SOLCOIN_MASTER_KEY;
  else process.env.SOLCOIN_MASTER_KEY = saved;
});

const keyIn = (path: string): string => (/^SOLCOIN_MASTER_KEY=(.*)$/m.exec(readFileSync(path, 'utf8'))?.[1] ?? '').trim();
const modeOf = (path: string): string => (statSync(path).mode & 0o777).toString(8);

describe('master key selection', () => {
  it('generates one when there is no .env at all', () => {
    const result = ensureEnvFile(dir);
    expect(result.source).toBe('generated');
    expect(keyIn(result.path).length).toBeGreaterThanOrEqual(16);
    expect(modeOf(result.path)).toBe('600');
  });

  /**
   * `loadDotEnv` never overrides a real environment variable, so a key
   * exported by the parent shell is the one that actually encrypts the wallet.
   * Generating a different one and writing it to `.env` told the operator to
   * back up a key that decrypts nothing, and the next run without that
   * transient value could not open the wallet at all.
   */
  it('persists a key already in the environment instead of replacing it', () => {
    process.env.SOLCOIN_MASTER_KEY = 'an-externally-supplied-master-key';
    const result = ensureEnvFile(dir);
    expect(result.source).toBe('environment');
    expect(keyIn(result.path)).toBe('an-externally-supplied-master-key');
  });

  it('refuses to continue when the environment and .env disagree', () => {
    writeFileSync(join(dir, '.env'), 'SOLCOIN_MASTER_KEY=the-key-written-in-the-file\n');
    process.env.SOLCOIN_MASTER_KEY = 'a-different-key-from-the-environment';
    expect(() => ensureEnvFile(dir)).toThrow(/environment/i);
  });

  it('accepts the environment key when .env already holds the same one', () => {
    writeFileSync(join(dir, '.env'), 'SOLCOIN_MASTER_KEY=the-very-same-master-key\n');
    process.env.SOLCOIN_MASTER_KEY = 'the-very-same-master-key';
    expect(ensureEnvFile(dir).source).toBe('environment');
  });

  /**
   * A copied or hand-written `.env` is commonly mode 0644, which lets every
   * local user read the key that unlocks a funded wallet. The path that leaves
   * the key alone used to leave the permissions alone too.
   */
  it('tightens permissions on an existing .env even when the key is untouched', () => {
    const path = join(dir, '.env');
    writeFileSync(path, 'SOLCOIN_MASTER_KEY=an-existing-key-long-enough\n', { mode: 0o644 });
    expect(modeOf(path)).toBe('644');

    const result = ensureEnvFile(dir);
    expect(result.source).toBe('existing');
    expect(keyIn(path)).toBe('an-existing-key-long-enough');
    expect(modeOf(path)).toBe('600');
  });

  it('fills in a key when .env exists but the value is empty', () => {
    writeFileSync(join(dir, '.env'), 'SOLCOIN_MASTER_KEY=\nPORT=4317\n');
    const result = ensureEnvFile(dir);
    expect(result.source).toBe('generated');
    expect(keyIn(result.path).length).toBeGreaterThanOrEqual(16);
    expect(readFileSync(result.path, 'utf8')).toContain('PORT=4317');
  });
});

describe('whitespace around an environment-supplied key', () => {
  /**
   * `loadEnv` encrypts with the raw environment value, whitespace included,
   * and a `.env` file cannot store it that way — `loadDotEnv` trims every
   * value it reads back. Persisting the trimmed form would record a key that
   * decrypts nothing the raw one encrypted: the same unrecoverable wallet as
   * writing an unrelated key, by a quieter route.
   */
  it.each([
    ['a trailing newline, as a secret file produces', 'a-key-from-a-secret-file\n'],
    ['a trailing space', 'a-key-with-a-trailing-space '],
    ['a leading space', ' a-key-with-a-leading-space'],
  ])('refuses %s', (_label, value) => {
    process.env.SOLCOIN_MASTER_KEY = value;
    expect(() => ensureEnvFile(dir)).toThrow(/whitespace/i);
  });

  it('accepts a clean key', () => {
    process.env.SOLCOIN_MASTER_KEY = 'a-perfectly-clean-master-key';
    expect(ensureEnvFile(dir).source).toBe('environment');
    expect(keyIn(join(dir, '.env'))).toBe('a-perfectly-clean-master-key');
  });

  /**
   * The check must not fire on a value too short to be a key at all — that is
   * the "no key supplied" path, which generates one.
   */
  it('ignores a too-short environment value entirely', () => {
    process.env.SOLCOIN_MASTER_KEY = '  short  ';
    expect(ensureEnvFile(dir).source).toBe('generated');
  });
});
