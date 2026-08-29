import { eq } from 'drizzle-orm';
import { AppError } from '../core/errors.js';
import { componentLogger } from '../core/logger.js';
import type { Db } from '../db/client.js';
import { secrets } from '../db/schema.js';
import { credentialHint, decryptWithPassphrase, encryptWithPassphrase } from './crypto.js';

/**
 * Encrypted secret store.
 *
 * Every credential the platform needs — AI provider keys, RPC keys, webhook
 * URLs, wallet keystores — lives here as AES-256-GCM ciphertext keyed from the
 * master passphrase. The passphrase itself is supplied via the environment at
 * boot and is never persisted.
 *
 * Design decisions worth stating:
 *  - Secrets are decrypted on demand and cached in memory only for a short TTL,
 *    so a long-lived process does not hold every credential in plaintext forever.
 *  - Reads are recorded (`lastUsedAt`) so an operator can see which credentials
 *    are actually in use and revoke the rest.
 *  - When the store is locked, `get` returns null rather than throwing, and
 *    callers report "unconfigured". A missing credential must degrade a feature,
 *    never crash the platform.
 */

export const SECRET_KEYS = {
  anthropicApiKey: 'ai.anthropic.api_key',
  openaiApiKey: 'ai.openai.api_key',
  heliusApiKey: 'rpc.helius.api_key',
  rpcUrlMainnet: 'rpc.mainnet.url',
  rpcUrlDevnet: 'rpc.devnet.url',
  birdeyeApiKey: 'market.birdeye.api_key',
  youtubeApiKey: 'trends.youtube.api_key',
  redditClientId: 'trends.reddit.client_id',
  redditClientSecret: 'trends.reddit.client_secret',
  xBearerToken: 'trends.x.bearer_token',
  pinataJwt: 'storage.pinata.jwt',
  pumpPortalApiKey: 'execution.pumpportal.api_key',
  discordWebhook: 'notify.discord.webhook',
  slackWebhook: 'notify.slack.webhook',
  telegramBotToken: 'notify.telegram.bot_token',
  telegramChatId: 'notify.telegram.chat_id',
  genericWebhook: 'notify.webhook.url',
  smtpUrl: 'notify.smtp.url',
  operatingWalletKeystore: 'wallet.operating.keystore',
} as const;

export type SecretKey = (typeof SECRET_KEYS)[keyof typeof SECRET_KEYS];

export interface SecretMetadata {
  key: string;
  category: string;
  hint: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

interface CacheEntry {
  value: string;
  expiresAt: number;
}

export class SecretStore {
  private readonly log = componentLogger('secrets');
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs = 60_000;

  constructor(
    private readonly db: Db,
    private readonly masterKey: string | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when the store can decrypt. A locked store serves no credentials. */
  get unlocked(): boolean {
    return typeof this.masterKey === 'string' && this.masterKey.length >= 16;
  }

  assertUnlocked(): void {
    if (!this.unlocked) {
      throw new AppError(
        'locked',
        'The secret store is locked. Set SOLCOIN_MASTER_KEY (at least 16 characters) and restart to enable credentialed features.',
      );
    }
  }

  async set(key: string, value: string, category = 'api_key'): Promise<void> {
    this.assertUnlocked();
    if (!value) {
      await this.delete(key);
      return;
    }
    const blob = await encryptWithPassphrase(value, this.masterKey!);
    const timestamp = this.now();
    await this.db
      .insert(secrets)
      .values({
        key,
        ciphertext: blob.ciphertext,
        iv: blob.iv,
        authTag: blob.authTag,
        salt: blob.salt,
        kdf: blob.kdf,
        hint: credentialHint(value),
        category,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: secrets.key,
        set: {
          ciphertext: blob.ciphertext,
          iv: blob.iv,
          authTag: blob.authTag,
          salt: blob.salt,
          kdf: blob.kdf,
          hint: credentialHint(value),
          category,
          updatedAt: timestamp,
        },
      });
    this.cache.delete(key);
  }

  /**
   * Read a secret. Returns null when absent or when the store is locked — the
   * caller's job is to degrade gracefully, not to crash.
   */
  async get(key: string): Promise<string | null> {
    if (!this.unlocked) return null;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const row = await this.db.select().from(secrets).where(eq(secrets.key, key)).limit(1);
    const record = row[0];
    if (!record) return null;

    try {
      const plaintext = (
        await decryptWithPassphrase(
          {
            ciphertext: record.ciphertext,
            iv: record.iv,
            authTag: record.authTag,
            salt: record.salt,
            kdf: 'scrypt',
          },
          this.masterKey!,
        )
      ).toString('utf8');
      this.cache.set(key, { value: plaintext, expiresAt: this.now() + this.cacheTtlMs });
      void this.db
        .update(secrets)
        .set({ lastUsedAt: this.now() })
        .where(eq(secrets.key, key))
        .catch(() => undefined);
      return plaintext;
    } catch {
      // A decryption failure almost always means the master key changed.
      this.log.error(
        { key },
        'failed to decrypt secret — the master key may have changed since this secret was stored',
      );
      return null;
    }
  }

  async has(key: string): Promise<boolean> {
    const row = await this.db.select({ key: secrets.key }).from(secrets).where(eq(secrets.key, key)).limit(1);
    return row.length > 0;
  }

  async delete(key: string): Promise<void> {
    await this.db.delete(secrets).where(eq(secrets.key, key));
    this.cache.delete(key);
  }

  /** Metadata only — never returns plaintext, safe to expose over the API. */
  async list(): Promise<SecretMetadata[]> {
    const rows = await this.db
      .select({
        key: secrets.key,
        category: secrets.category,
        hint: secrets.hint,
        createdAt: secrets.createdAt,
        updatedAt: secrets.updatedAt,
        lastUsedAt: secrets.lastUsedAt,
      })
      .from(secrets);
    return rows;
  }

  /**
   * Re-encrypt every secret under a new master key.
   *
   * Runs inside a transaction: a partial rotation would leave the store
   * unreadable, which is the one failure mode worse than a lost credential.
   */
  async rotateMasterKey(newMasterKey: string): Promise<{ rotated: number }> {
    this.assertUnlocked();
    if (newMasterKey.length < 16) {
      throw new AppError('validation_failed', 'The new master key must be at least 16 characters.');
    }
    const rows = await this.db.select().from(secrets);
    const reEncrypted: Array<{ key: string; blob: Awaited<ReturnType<typeof encryptWithPassphrase>>; hint: string | null }> = [];

    for (const row of rows) {
      const plaintext = (
        await decryptWithPassphrase(
          { ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag, salt: row.salt, kdf: 'scrypt' },
          this.masterKey!,
        )
      ).toString('utf8');
      reEncrypted.push({ key: row.key, blob: await encryptWithPassphrase(plaintext, newMasterKey), hint: row.hint });
    }

    this.db.$raw.transaction(() => {
      for (const { key, blob } of reEncrypted) {
        this.db.$raw
          .prepare('UPDATE secrets SET ciphertext = ?, iv = ?, auth_tag = ?, salt = ?, updated_at = ? WHERE key = ?')
          .run(blob.ciphertext, blob.iv, blob.authTag, blob.salt, this.now(), key);
      }
    })();

    this.cache.clear();
    return { rotated: reEncrypted.length };
  }

  clearCache(): void {
    this.cache.clear();
  }
}
