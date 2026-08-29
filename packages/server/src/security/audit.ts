import { desc, eq, gte, sql } from 'drizzle-orm';
import { redactSecrets } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { stableStringify } from '../core/json.js';
import type { Db } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import { sha256 } from './crypto.js';

/**
 * Append-only, hash-chained audit log.
 *
 * Every consequential action — a launch, a fee claim, a settings change, an
 * autonomy escalation, an emergency stop — is written here before or alongside
 * the action itself. Each entry commits to its predecessor's hash, so removing
 * or editing a row breaks the chain and `verifyChain` will point at exactly
 * where it broke.
 *
 * This is what makes autonomous behaviour reconstructable after the fact:
 * given the log, you can say what the platform did, why, on whose authority,
 * and with which model version.
 */

export type AuditActorType = 'user' | 'system' | 'job' | 'ai';

export interface AuditEntryInput {
  actorType: AuditActorType;
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  parameters?: unknown;
  result?: 'ok' | 'failed' | 'blocked' | 'pending';
  resultDetail?: string | null;
  modelVersion?: string | null;
  transactionSignature?: string | null;
  reason?: string | null;
  ipAddress?: string | null;
}

const GENESIS_HASH = '0'.repeat(64);

/** Keys whose values must never be written to the audit log. */
const FORBIDDEN_KEYS = /^(password|passphrase|secret|secretkey|privatekey|private_key|apikey|api_key|token|keystore|mnemonic|seed|totp.*)$/i;

function redactParameters(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limited]';
  if (typeof value === 'string') return redactSecrets(value).slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactParameters(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = FORBIDDEN_KEYS.test(k) ? '[redacted]' : redactParameters(v, depth + 1);
    }
    return out;
  }
  return value;
}

export class AuditLog {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Append an entry.
   *
   * The sequence read and the insert happen inside one synchronous SQLite
   * transaction, so two concurrent writers cannot produce a forked chain.
   */
  record(entry: AuditEntryInput): { id: string; sequence: number; hash: string } {
    const parameters = entry.parameters === undefined ? null : stableStringify(redactParameters(entry.parameters));
    const createdAt = this.now();
    const id = newId('aud', createdAt);

    return this.db.$raw.transaction(() => {
      const previous = this.db.$raw
        .prepare('SELECT sequence, hash FROM audit_log ORDER BY sequence DESC LIMIT 1')
        .get() as { sequence: number; hash: string } | undefined;

      const sequence = (previous?.sequence ?? 0) + 1;
      const previousHash = previous?.hash ?? GENESIS_HASH;

      const payload = stableStringify({
        sequence,
        previousHash,
        actorType: entry.actorType,
        actorId: entry.actorId ?? null,
        actorLabel: entry.actorLabel ?? null,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        parameters,
        result: entry.result ?? 'ok',
        resultDetail: entry.resultDetail ?? null,
        modelVersion: entry.modelVersion ?? null,
        transactionSignature: entry.transactionSignature ?? null,
        reason: entry.reason ?? null,
        createdAt,
      });
      const hash = sha256(payload);

      this.db.$raw
        .prepare(
          `INSERT INTO audit_log
             (id, sequence, actor_type, actor_id, actor_label, action, target_type, target_id,
              parameters, result, result_detail, model_version, transaction_signature, reason,
              ip_address, previous_hash, hash, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          sequence,
          entry.actorType,
          entry.actorId ?? null,
          entry.actorLabel ?? null,
          entry.action,
          entry.targetType ?? null,
          entry.targetId ?? null,
          parameters,
          entry.result ?? 'ok',
          entry.resultDetail ?? null,
          entry.modelVersion ?? null,
          entry.transactionSignature ?? null,
          entry.reason ?? null,
          entry.ipAddress ?? null,
          previousHash,
          hash,
          createdAt,
        );

      return { id, sequence, hash };
    })();
  }

  /**
   * Walk the chain and report the first break.
   *
   * Recomputes each row's hash from its own stored fields, so both a tampered
   * field and a deleted row are detected.
   */
  verifyChain(options: { limit?: number } = {}): {
    valid: boolean;
    checked: number;
    brokenAtSequence?: number;
    detail?: string;
  } {
    const limit = options.limit ?? 100_000;
    const rows = this.db.$raw
      .prepare('SELECT * FROM audit_log ORDER BY sequence ASC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;

    let expectedPrevious = GENESIS_HASH;
    let expectedSequence = 1;

    for (const row of rows) {
      const sequence = Number(row.sequence);
      if (sequence !== expectedSequence) {
        return {
          valid: false,
          checked: expectedSequence - 1,
          brokenAtSequence: sequence,
          detail: `Sequence gap: expected ${expectedSequence}, found ${sequence}. An entry was deleted.`,
        };
      }
      if (row.previous_hash !== expectedPrevious) {
        return {
          valid: false,
          checked: sequence - 1,
          brokenAtSequence: sequence,
          detail: 'Previous-hash mismatch: an earlier entry was modified.',
        };
      }
      const payload = stableStringify({
        sequence,
        previousHash: row.previous_hash,
        actorType: row.actor_type,
        actorId: row.actor_id ?? null,
        actorLabel: row.actor_label ?? null,
        action: row.action,
        targetType: row.target_type ?? null,
        targetId: row.target_id ?? null,
        parameters: row.parameters ?? null,
        result: row.result ?? 'ok',
        resultDetail: row.result_detail ?? null,
        modelVersion: row.model_version ?? null,
        transactionSignature: row.transaction_signature ?? null,
        reason: row.reason ?? null,
        createdAt: Number(row.created_at),
      });
      if (sha256(payload) !== row.hash) {
        return {
          valid: false,
          checked: sequence - 1,
          brokenAtSequence: sequence,
          detail: 'Hash mismatch: this entry was modified after it was written.',
        };
      }
      expectedPrevious = String(row.hash);
      expectedSequence = sequence + 1;
    }

    return { valid: true, checked: rows.length };
  }

  async query(options: {
    limit?: number;
    offset?: number;
    action?: string;
    targetType?: string;
    targetId?: string;
    since?: number;
  } = {}) {
    const conditions = [];
    if (options.action) conditions.push(eq(auditLog.action, options.action));
    if (options.targetType) conditions.push(eq(auditLog.targetType, options.targetType));
    if (options.targetId) conditions.push(eq(auditLog.targetId, options.targetId));
    if (options.since) conditions.push(gte(auditLog.createdAt, options.since));

    let query = this.db.select().from(auditLog).$dynamic();
    if (conditions.length) {
      query = query.where(conditions.length === 1 ? conditions[0]! : sql`${sql.join(conditions, sql` AND `)}`);
    }
    return query
      .orderBy(desc(auditLog.sequence))
      .limit(Math.min(options.limit ?? 100, 1000))
      .offset(options.offset ?? 0);
  }

  count(): number {
    const row = this.db.$raw.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number };
    return row.n;
  }
}

/** Canonical action names, so the audit log is queryable rather than free-text. */
export const AUDIT_ACTIONS = {
  userLogin: 'user.login',
  userLoginFailed: 'user.login_failed',
  userLogout: 'user.logout',
  userCreated: 'user.created',
  userRoleChanged: 'user.role_changed',
  settingsChanged: 'settings.changed',
  secretSet: 'secret.set',
  secretDeleted: 'secret.deleted',
  masterKeyRotated: 'secret.master_key_rotated',
  walletCreated: 'wallet.created',
  walletImported: 'wallet.imported',
  walletExported: 'wallet.exported',
  walletTransfer: 'wallet.transfer',
  walletSweep: 'wallet.sweep',
  conceptApproved: 'concept.approved',
  conceptRejected: 'concept.rejected',
  conceptRegenerated: 'concept.regenerated',
  launchRequested: 'launch.requested',
  launchSubmitted: 'launch.submitted',
  launchConfirmed: 'launch.confirmed',
  launchFailed: 'launch.failed',
  launchBlocked: 'launch.blocked',
  feeCollected: 'fees.collected',
  feeCollectionSkipped: 'fees.collection_skipped',
  emergencyStop: 'system.emergency_stop',
  launchFailuresCleared: 'system.launch_failures_cleared',
  emergencyRelease: 'system.emergency_release',
  autonomyChanged: 'system.autonomy_changed',
  phaseChanged: 'system.phase_changed',
  modelRetrained: 'model.retrained',
  modelActivated: 'model.activated',
  experimentStarted: 'experiment.started',
  experimentConcluded: 'experiment.concluded',
  jobRun: 'job.run',
  dataExported: 'data.exported',
} as const;
