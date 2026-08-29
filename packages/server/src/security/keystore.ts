import { Keypair } from '@solana/web3.js';
import { AppError } from '../core/errors.js';
import { componentLogger } from '../core/logger.js';
import { decryptWithPassphrase, encryptWithPassphrase, wipe, type EncryptedBlob } from './crypto.js';
import { SECRET_KEYS, type SecretStore } from './secrets.js';

/**
 * Wallet key custody.
 *
 * Threat model: the realistic compromise for a self-hosted platform is not a
 * sophisticated attacker with kernel access — it is a leaked log line, a stack
 * trace posted to an issue tracker, a database file copied to a backup bucket,
 * or a dependency that reads `process.env`. The design targets those directly:
 *
 *  - The private key is stored only as AES-256-GCM ciphertext, in the database,
 *    under a key derived from a passphrase that lives in the environment and is
 *    never written to disk by this application. A stolen database file alone is
 *    useless.
 *  - Plaintext key material exists only inside `withSigner`, for the duration of
 *    one signing operation, and is zeroed on the way out.
 *  - The key never crosses the HTTP boundary. There is no API route that returns
 *    it, and the export path requires a separate explicit confirmation and is
 *    audited.
 *  - A `watch_only` mode lets an operator run the whole platform against an
 *    address whose key lives elsewhere, with launches prepared but signed by an
 *    external signer.
 *
 * What this deliberately does not claim: it is not hardware-backed, and a
 * process-level compromise while unlocked can reach the key during a signing
 * window. Operators who need that guarantee should run in `external` custody
 * with a dedicated signer.
 */

export type WalletCustody = 'encrypted_keystore' | 'external' | 'watch_only';

export interface KeystoreRecord {
  publicKey: string;
  custody: WalletCustody;
  encrypted?: EncryptedBlob;
  createdAt: number;
  label: string;
}

export class WalletKeystore {
  private readonly log = componentLogger('keystore');

  constructor(
    private readonly secrets: SecretStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Generate a fresh operating wallet and store it encrypted. */
  async createOperatingWallet(label = 'Operating wallet'): Promise<{ publicKey: string }> {
    this.secrets.assertUnlocked();
    if (await this.secrets.has(SECRET_KEYS.operatingWalletKeystore)) {
      throw new AppError(
        'conflict',
        'An operating wallet already exists. Remove it explicitly before creating another, so funds are never orphaned.',
      );
    }
    const keypair = Keypair.generate();
    try {
      await this.persist(keypair, label);
      return { publicKey: keypair.publicKey.toBase58() };
    } finally {
      wipe(keypair.secretKey);
    }
  }

  /**
   * Import an existing key.
   *
   * Accepts the two formats operators actually have: a base58 secret key (what
   * Phantom exports) and a JSON byte array (what `solana-keygen` writes).
   */
  async importOperatingWallet(secret: string, label = 'Operating wallet'): Promise<{ publicKey: string }> {
    this.secrets.assertUnlocked();
    const keypair = parseSecretKey(secret);
    try {
      await this.persist(keypair, label);
      return { publicKey: keypair.publicKey.toBase58() };
    } finally {
      wipe(keypair.secretKey);
    }
  }

  /** Register an address whose key is held elsewhere. */
  async setWatchOnly(publicKey: string, label = 'External wallet'): Promise<void> {
    this.secrets.assertUnlocked();
    const record: KeystoreRecord = { publicKey, custody: 'watch_only', createdAt: this.now(), label };
    await this.secrets.set(SECRET_KEYS.operatingWalletKeystore, JSON.stringify(record), 'wallet');
  }

  async getRecord(): Promise<KeystoreRecord | null> {
    const raw = await this.secrets.get(SECRET_KEYS.operatingWalletKeystore);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as KeystoreRecord;
    } catch {
      this.log.error('operating wallet keystore is corrupt or was written under a different master key');
      return null;
    }
  }

  async getPublicKey(): Promise<string | null> {
    return (await this.getRecord())?.publicKey ?? null;
  }

  async canSign(): Promise<boolean> {
    const record = await this.getRecord();
    return record?.custody === 'encrypted_keystore' && Boolean(record.encrypted);
  }

  /**
   * Run `fn` with a live keypair, then wipe it.
   *
   * This is the only path to plaintext key material. `fn` must not retain the
   * keypair; anything it needs from the key must be extracted before returning.
   */
  async withSigner<T>(fn: (keypair: Keypair) => Promise<T>): Promise<T> {
    const record = await this.getRecord();
    if (!record) {
      throw new AppError('not_configured', 'No operating wallet is configured. Create or import one in Settings → Wallet.');
    }
    if (record.custody !== 'encrypted_keystore' || !record.encrypted) {
      throw new AppError(
        'not_configured',
        `The operating wallet is in "${record.custody}" custody, so this process cannot sign for it. Switch to an encrypted keystore or use an external signer.`,
      );
    }
    this.secrets.assertUnlocked();

    let secretBytes: Buffer | null = null;
    let keypair: Keypair | null = null;
    try {
      secretBytes = await decryptWithPassphrase(record.encrypted, this.masterPassphrase());
      keypair = Keypair.fromSecretKey(new Uint8Array(secretBytes));
      if (keypair.publicKey.toBase58() !== record.publicKey) {
        throw new AppError('internal', 'Keystore integrity check failed: the decrypted key does not match the stored address.');
      }
      return await fn(keypair);
    } finally {
      if (keypair) wipe(keypair.secretKey);
      if (secretBytes) wipe(secretBytes);
    }
  }

  /**
   * Export the secret key.
   *
   * Intentionally awkward: the caller must pass the exact confirmation phrase,
   * and every call is expected to be audited by the route that invokes it.
   */
  async exportSecretKey(confirmationPhrase: string): Promise<string> {
    if (confirmationPhrase !== 'I understand this reveals my private key') {
      throw new AppError('forbidden', 'Export requires the exact confirmation phrase.');
    }
    return this.withSigner(async (keypair) => Buffer.from(keypair.secretKey).toString('base64'));
  }

  async remove(): Promise<void> {
    await this.secrets.delete(SECRET_KEYS.operatingWalletKeystore);
  }

  private async persist(keypair: Keypair, label: string): Promise<void> {
    const encrypted = await encryptWithPassphrase(Buffer.from(keypair.secretKey), this.masterPassphrase());
    const record: KeystoreRecord = {
      publicKey: keypair.publicKey.toBase58(),
      custody: 'encrypted_keystore',
      encrypted,
      createdAt: this.now(),
      label,
    };
    await this.secrets.set(SECRET_KEYS.operatingWalletKeystore, JSON.stringify(record), 'wallet');
  }

  /**
   * The keystore is encrypted under the master key a second time, independently
   * of the secret store's own envelope. That means a bug that leaks a secret
   * row still does not leak the wallet, and rotating the master key re-wraps
   * both layers.
   */
  private masterPassphrase(): string {
    const key = process.env.SOLCOIN_MASTER_KEY;
    if (!key || key.length < 16) {
      throw new AppError('locked', 'SOLCOIN_MASTER_KEY is not set; the wallet cannot be unlocked.');
    }
    return `wallet:${key}`;
  }
}

/** Parse the two secret-key formats operators actually paste in. */
export function parseSecretKey(secret: string): Keypair {
  const trimmed = secret.trim();
  try {
    if (trimmed.startsWith('[')) {
      const bytes = JSON.parse(trimmed) as number[];
      if (!Array.isArray(bytes) || (bytes.length !== 64 && bytes.length !== 32)) {
        throw new Error('expected a 32- or 64-byte array');
      }
      return bytes.length === 64
        ? Keypair.fromSecretKey(Uint8Array.from(bytes))
        : Keypair.fromSeed(Uint8Array.from(bytes));
    }
    const decoded = decodeBase58(trimmed);
    if (decoded.length === 64) return Keypair.fromSecretKey(decoded);
    if (decoded.length === 32) return Keypair.fromSeed(decoded);
    throw new Error(`unexpected key length ${decoded.length}`);
  } catch (e) {
    throw new AppError(
      'validation_failed',
      'Could not read that private key. Provide either a base58 secret key or a JSON byte array.',
      { cause: e },
    );
  }
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function decodeBase58(input: string): Uint8Array {
  const bytes: number[] = [0];
  for (const char of input) {
    const value = BASE58_ALPHABET.indexOf(char);
    if (value === -1) throw new Error(`invalid base58 character: ${char}`);
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < input.length && input[i] === '1'; i++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

export function encodeBase58(bytes: Uint8Array): string {
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]!];
  return out;
}
