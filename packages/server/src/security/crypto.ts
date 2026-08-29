import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Cryptographic primitives.
 *
 * Deliberately built on Node's own `crypto` module rather than a dependency:
 * this is the code that protects wallet keys, and every additional package in
 * this path is additional supply-chain surface.
 *
 * Key derivation is scrypt with parameters chosen for ~100ms on a modern CPU,
 * which is the right trade-off for an interactive unlock. Encryption is
 * AES-256-GCM, so ciphertext is authenticated and tampering is detectable.
 */

export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const;
const KEY_LENGTH = 32;
const IV_LENGTH = 12;

export interface EncryptedBlob {
  ciphertext: string;
  iv: string;
  authTag: string;
  salt: string;
  kdf: 'scrypt';
}

export async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return scrypt(passphrase, salt, KEY_LENGTH, { ...SCRYPT_PARAMS });
}

export async function encryptWithPassphrase(plaintext: string | Buffer, passphrase: string): Promise<EncryptedBlob> {
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt);
  return { ...encryptWithKey(plaintext, key), salt: salt.toString('base64'), kdf: 'scrypt' };
}

export function encryptWithKey(plaintext: string | Buffer, key: Buffer): Omit<EncryptedBlob, 'salt' | 'kdf'> {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export async function decryptWithPassphrase(blob: EncryptedBlob, passphrase: string): Promise<Buffer> {
  const key = await deriveKey(passphrase, Buffer.from(blob.salt, 'base64'));
  return decryptWithKey(blob, key);
}

export function decryptWithKey(blob: Omit<EncryptedBlob, 'salt' | 'kdf'>, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, 'base64')), decipher.final()]);
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

export interface PasswordRecord {
  hash: string;
  params: string;
}

export async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, { ...SCRYPT_PARAMS });
  return {
    hash: derived.toString('base64'),
    params: JSON.stringify({ kdf: 'scrypt', ...SCRYPT_PARAMS, salt: salt.toString('base64'), keylen: 64 }),
  };
}

export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
  let params: { N: number; r: number; p: number; maxmem: number; salt: string; keylen: number };
  try {
    params = JSON.parse(record.params);
  } catch {
    return false;
  }
  try {
    const derived = await scrypt(password, Buffer.from(params.salt, 'base64'), params.keylen ?? 64, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: params.maxmem ?? SCRYPT_PARAMS.maxmem,
    });
    const expected = Buffer.from(record.hash, 'base64');
    if (expected.length !== derived.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Hashing and comparison helpers
// ---------------------------------------------------------------------------

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function sha256Base64Url(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('base64url');
}

/** Constant-time string comparison for tokens and CSRF values. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still perform a comparison so the timing does not leak length.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Overwrite a buffer holding key material.
 *
 * This is genuinely best-effort: V8 may have copied the bytes elsewhere, and a
 * heap dump can still contain them. It reduces the window, it does not close it.
 * The real mitigation is keeping key material out of the process wherever
 * possible — see the keystore's external-signer mode.
 */
export function wipe(buffer: Buffer | Uint8Array): void {
  buffer.fill(0);
}

/** Non-secret display hint for a credential, e.g. `sk-ant-…a91f`. */
export function credentialHint(value: string): string {
  if (value.length <= 8) return '…';
  const head = value.slice(0, Math.min(7, Math.floor(value.length / 4)));
  const tail = value.slice(-4);
  return `${head}…${tail}`;
}
