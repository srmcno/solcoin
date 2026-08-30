import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { AppError } from '../core/errors.js';

/**
 * Ensure a `.env` exists with a master key.
 *
 * The master key encrypts every credential and the wallet keystore. Losing it
 * makes all of them unrecoverable, which is why this generates one rather than
 * asking the operator to invent it, states plainly what it protects, and never
 * regenerates over an existing value.
 */
export function ensureEnvFile(root: string): { created: boolean; source: 'generated' | 'existing' | 'environment'; path: string } {
  const path = resolve(root, '.env');
  const examplePath = resolve(root, '.env.example');
  const rawFromEnvironment = process.env.SOLCOIN_MASTER_KEY ?? '';
  const fromEnvironment = rawFromEnvironment.trim();

  /*
   * Surrounding whitespace has to be rejected, not trimmed away.
   *
   * `loadEnv` encrypts with the *raw* environment value, whitespace included —
   * a trailing newline inherited from a secret file is the common case. A
   * `.env` file cannot represent that: `loadDotEnv` trims every value it
   * reads, so whatever is written here comes back trimmed. Persisting the
   * trimmed form would therefore record a key that does not decrypt anything
   * the raw one encrypted, which is the same unrecoverable wallet as writing
   * an unrelated key, reached by a quieter route.
   *
   * Trimming it at load time instead would break any deployment already
   * encrypting with an untrimmed key. So the operator is told.
   */
  if (fromEnvironment.length >= 16 && rawFromEnvironment !== fromEnvironment) {
    throw new AppError(
      'validation_failed',
      'SOLCOIN_MASTER_KEY has leading or trailing whitespace. It is used verbatim to encrypt the wallet, ' +
        'but a .env file cannot store it that way, so the two would disagree and the wallet would become ' +
        'unreadable. Remove the whitespace — often a trailing newline from a secret file — and run setup again.',
    );
  }

  const readKey = (text: string): string => (/^SOLCOIN_MASTER_KEY=(.*)$/m.exec(text)?.[1] ?? '').trim();
  const withKey = (text: string, key: string): string =>
    /^SOLCOIN_MASTER_KEY=.*$/m.test(text)
      ? text.replace(/^SOLCOIN_MASTER_KEY=.*$/m, `SOLCOIN_MASTER_KEY=${key}`)
      : `${text.trimEnd()}\nSOLCOIN_MASTER_KEY=${key}\n`;

  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const inFile = existing === null ? '' : readKey(existing);

  /*
   * A key already in the environment wins, and is written down rather than
   * replaced.
   *
   * `loadDotEnv` deliberately never overrides a real environment variable, so
   * if `SOLCOIN_MASTER_KEY` is exported by the parent shell it is the key that
   * actually encrypts the wallet and every credential — whatever this file
   * says. Generating a fresh one here and writing it to `.env` therefore
   * produced the worst possible outcome: the operator is told to back up a key
   * that decrypts nothing, and the next run without that transient environment
   * value cannot open the wallet at all. There is no recovery from that.
   */
  if (fromEnvironment.length >= 16) {
    if (inFile && inFile !== fromEnvironment) {
      throw new AppError(
        'validation_failed',
        'SOLCOIN_MASTER_KEY is set in the environment and a different key is written in .env. ' +
          'The environment one wins at runtime, so continuing would encrypt everything with a key .env does not hold. ' +
          'Remove one of them and run setup again.',
      );
    }
    if (inFile !== fromEnvironment) {
      const base = existing ?? (existsSync(examplePath) ? readFileSync(examplePath, 'utf8') : 'SOLCOIN_MASTER_KEY=\n');
      writeFileSync(path, withKey(base, fromEnvironment), { mode: 0o600 });
    }
    chmodSync(path, 0o600);
    return { created: existing === null, source: 'environment', path };
  }

  if (existing === null) {
    const template = existsSync(examplePath) ? readFileSync(examplePath, 'utf8') : 'SOLCOIN_MASTER_KEY=\n';
    writeFileSync(path, withKey(template, randomBytes(32).toString('base64')), { mode: 0o600 });
    chmodSync(path, 0o600);
    return { created: true, source: 'generated', path };
  }

  if (inFile.length >= 16) {
    /*
     * Tighten the permissions even when the key is left alone. A `.env` that
     * was copied, or created by hand, is commonly mode 0644 — every local user
     * can then read the key that unlocks every credential and a funded wallet.
     * The early return here used to skip the chmod that every other path did.
     */
    chmodSync(path, 0o600);
    return { created: false, source: 'existing', path };
  }

  writeFileSync(path, withKey(existing, randomBytes(32).toString('base64')), { mode: 0o600 });
  chmodSync(path, 0o600);
  return { created: false, source: 'generated', path };
}

