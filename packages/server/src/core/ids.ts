import { randomBytes, randomUUID } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, no I/L/O/U

/**
 * Sortable, collision-resistant identifier (ULID-compatible layout).
 *
 * The 48-bit timestamp prefix means primary keys order by creation time, which
 * keeps SQLite b-tree inserts append-only and makes `ORDER BY id` free.
 */
export function newId(prefix?: string, nowMs = Date.now()): string {
  let ts = nowMs;
  const time = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    time[i] = ALPHABET[ts % 32]!;
    ts = Math.floor(ts / 32);
  }
  const rand = randomBytes(16);
  let random = '';
  for (let i = 0; i < 16; i++) random += ALPHABET[rand[i]! % 32];
  const id = time.join('') + random;
  return prefix ? `${prefix}_${id}` : id;
}

/** Cryptographically strong opaque token, URL-safe. */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Short nonce for fencing untrusted content in prompts. */
export function newNonce(): string {
  return randomBytes(9).toString('hex');
}

export function newUuid(): string {
  return randomUUID();
}
