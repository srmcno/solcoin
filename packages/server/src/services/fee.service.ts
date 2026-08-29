import type { Keypair } from '@solana/web3.js';
import {
  CURVE_VAULT_RENT_LAMPORTS,
  estimateClaimCostLamports,
  lamportsToSol,
  solToLamports,
  TIME,
} from '@solcoin/shared';
import { AppError, safeErrorText } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { componentLogger } from '../core/logger.js';
import type { Db } from '../db/client.js';
import type { EventBus } from '../core/events.js';
import { AUDIT_ACTIONS, type AuditLog } from '../security/audit.js';
import type { LaunchAdapter } from '../providers/solana/launch-adapter.js';
import type { GuardService } from './guard.service.js';
import type { SettingsService } from './settings.service.js';

/**
 * Creator-fee detection, accounting and collection.
 *
 * The economics here are unforgiving and easy to get wrong:
 *
 *  - Fees accrue in **two vaults per creator**, not per token — the bonding
 *    curve vault and the AMM coin-creator vault. Accrual across every token the
 *    wallet created pools into the same two accounts, so a claim is a wallet
 *    operation, and attributing the proceeds back to individual tokens is a
 *    bookkeeping exercise this service performs explicitly.
 *  - The bonding-curve vault is a zero-byte System-owned account whose
 *    rent-exempt minimum is **permanently stranded**. Treating the raw balance
 *    as claimable produces claims that recover less than they cost.
 *  - A claim costs a transaction fee. Claiming 0.00001 SOL for a 0.000005 SOL
 *    fee is technically profitable and practically pointless; claiming below
 *    the fee destroys value outright. The threshold is expressed as a *ratio*
 *    so it stays correct as network fees move.
 */

export interface AccrualSnapshot {
  creator: string;
  curveVaultLamports: number;
  curveClaimableLamports: number;
  ammVaultLamports: number;
  totalClaimableLamports: number;
  observedAt: number;
  /** Change since the previous snapshot, which is the actual earned amount. */
  deltaLamports: number;
}

export interface CollectionDecision {
  shouldCollect: boolean;
  reason: string;
  claimableLamports: number;
  estimatedCostLamports: number;
  valueRatio: number;
}

export class FeeService {
  private readonly log = componentLogger('fees');

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly guard: GuardService,
    private readonly audit: AuditLog,
    private readonly events: EventBus,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Read the on-chain vaults and record a snapshot.
   *
   * Snapshots are the raw material for fee reporting: the *delta* between
   * consecutive snapshots (plus anything collected in between) is what the
   * creator actually earned in that window.
   */
  async snapshotAccruals(adapter: LaunchAdapter, creator: string, solPriceUsd?: number): Promise<AccrualSnapshot> {
    const accrued = await adapter.getAccruedFees(creator);
    const previous = this.latestSnapshot(creator);

    // Collections between snapshots reset the vault, so a naive difference
    // would read as negative earnings. Add back anything collected since.
    const collectedSince = previous
      ? this.collectedLamportsBetween(creator, previous.observedAt, accrued.observedAt)
      : 0;
    const deltaLamports = previous
      ? Math.max(0, accrued.totalClaimableLamports - previous.totalClaimableLamports + collectedSince)
      : accrued.totalClaimableLamports;

    const insert = this.db.$raw.prepare(
      `INSERT INTO creator_fee_events
         (id, token_mint, kind, vault, vault_address, wallet_address, lamports, claimable_lamports,
          usd_value, sol_price_usd, source, observed_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );

    this.db.$raw.transaction(() => {
      insert.run(
        newId('fee', accrued.observedAt),
        null,
        'accrual_snapshot',
        'curve',
        accrued.curveVaultAddress ?? null,
        creator,
        accrued.curveVaultLamports,
        accrued.curveClaimableLamports,
        solPriceUsd ? lamportsToSol(accrued.curveClaimableLamports) * solPriceUsd : null,
        solPriceUsd ?? null,
        accrued.source,
        accrued.observedAt,
        this.now(),
      );
      insert.run(
        newId('fee', accrued.observedAt + 1),
        null,
        'accrual_snapshot',
        'amm',
        accrued.ammVaultAddress ?? null,
        creator,
        accrued.ammVaultLamports,
        accrued.ammVaultLamports,
        solPriceUsd ? lamportsToSol(accrued.ammVaultLamports) * solPriceUsd : null,
        solPriceUsd ?? null,
        accrued.source,
        accrued.observedAt,
        this.now(),
      );
    })();

    if (deltaLamports > 0) {
      this.attributeAccrual(creator, deltaLamports, accrued.observedAt);
      const threshold = solToLamports(this.settings.get().notifications.largeFeeAccrualSol);
      if (deltaLamports >= threshold) {
        this.events.emit('fees.accrued', {
          mint: creator,
          lamports: deltaLamports,
          claimableLamports: accrued.totalClaimableLamports,
        });
      }
    }

    return {
      creator,
      curveVaultLamports: accrued.curveVaultLamports,
      curveClaimableLamports: accrued.curveClaimableLamports,
      ammVaultLamports: accrued.ammVaultLamports,
      totalClaimableLamports: accrued.totalClaimableLamports,
      observedAt: accrued.observedAt,
      deltaLamports,
    };
  }

  /**
   * Attribute pooled accrual back to individual tokens.
   *
   * The vaults do not tell us which token generated which lamport, so we
   * apportion by each token's share of measured organic volume in the window.
   * This is an estimate and is labelled as one wherever it is displayed; the
   * wallet-level totals remain exact.
   */
  private attributeAccrual(creator: string, deltaLamports: number, atMs: number): void {
    const windowStart = atMs - 6 * TIME.hour;
    const rows = this.db.$raw
      .prepare(
        `SELECT mint, volume_24h_sol FROM tokens
          WHERE creator_address = ? AND lifecycle NOT IN ('failed','dormant') AND volume_24h_sol > 0
          AND updated_at >= ?`,
      )
      .all(creator, windowStart) as Array<{ mint: string; volume_24h_sol: number }>;

    const totalVolume = rows.reduce((acc, r) => acc + r.volume_24h_sol, 0);
    if (totalVolume <= 0 || rows.length === 0) return;

    const update = this.db.$raw.prepare(
      'UPDATE tokens SET creator_fees_accrued_lamports = creator_fees_accrued_lamports + ?, last_fee_check_at = ? WHERE mint = ?',
    );
    this.db.$raw.transaction(() => {
      for (const row of rows) {
        const share = Math.round((row.volume_24h_sol / totalVolume) * deltaLamports);
        if (share > 0) update.run(share, atMs, row.mint);
      }
    })();
  }

  /**
   * Should a claim be submitted right now?
   *
   * Returns a reason in every case, because "we did not collect" is a decision
   * the operator needs to be able to interrogate, not silence.
   */
  decideCollection(snapshot: AccrualSnapshot, lastCollectionAt: number | null): CollectionDecision {
    const config = this.settings.get().fees;
    const claimable = snapshot.totalClaimableLamports;
    const estimatedCostLamports = estimateClaimCostLamports({
      includeCurve: snapshot.curveClaimableLamports > 0,
      includeAmm: snapshot.ammVaultLamports > 0,
      priorityFeeMicroLamportsPerCu: this.settings.get().execution.priorityFeeMicroLamports,
    });
    const valueRatio = estimatedCostLamports > 0 ? claimable / estimatedCostLamports : 0;

    if (claimable <= 0) {
      return {
        shouldCollect: false,
        reason: 'No claimable balance. Note that the bonding-curve vault permanently retains its rent-exempt minimum, so a small nonzero vault balance is not claimable.',
        claimableLamports: claimable,
        estimatedCostLamports,
        valueRatio,
      };
    }

    const thresholdLamports = solToLamports(config.collectionThresholdSol);
    const hoursSince = lastCollectionAt ? (this.now() - lastCollectionAt) / TIME.hour : Infinity;

    // The force interval exists so a slow earner is eventually swept rather
    // than accumulating forever below the threshold.
    const forced = config.forceCollectionIntervalHours > 0 && hoursSince >= config.forceCollectionIntervalHours;

    if (!forced && claimable < thresholdLamports) {
      return {
        shouldCollect: false,
        reason: `Claimable ${lamportsToSol(claimable).toFixed(6)} SOL is below the ${config.collectionThresholdSol} SOL collection threshold.`,
        claimableLamports: claimable,
        estimatedCostLamports,
        valueRatio,
      };
    }

    if (!forced && valueRatio < config.minCollectionValueRatio) {
      return {
        shouldCollect: false,
        reason: `Claim would recover only ${valueRatio.toFixed(1)}x its transaction cost, below the required ${config.minCollectionValueRatio}x.`,
        claimableLamports: claimable,
        estimatedCostLamports,
        valueRatio,
      };
    }

    if (hoursSince < config.minHoursBetweenCollections) {
      return {
        shouldCollect: false,
        reason: `Last collection was ${hoursSince.toFixed(1)}h ago; the minimum interval is ${config.minHoursBetweenCollections}h.`,
        claimableLamports: claimable,
        estimatedCostLamports,
        valueRatio,
      };
    }

    // Below this, a claim can never pay for itself regardless of settings.
    if (claimable <= estimatedCostLamports) {
      return {
        shouldCollect: false,
        reason: `Claiming ${lamportsToSol(claimable).toFixed(6)} SOL would cost ${lamportsToSol(estimatedCostLamports).toFixed(6)} SOL and therefore destroy value.`,
        claimableLamports: claimable,
        estimatedCostLamports,
        valueRatio,
      };
    }

    return {
      shouldCollect: true,
      reason: forced
        ? `Forced sweep: ${hoursSince.toFixed(0)}h since the last collection.`
        : `Claimable ${lamportsToSol(claimable).toFixed(6)} SOL recovers ${valueRatio.toFixed(0)}x its transaction cost.`,
      claimableLamports: claimable,
      estimatedCostLamports,
      valueRatio,
    };
  }

  /** Submit a claim, recording the measured proceeds. */
  async collect(
    adapter: LaunchAdapter,
    creator: string,
    getSigner: <T>(fn: (keypair: Keypair) => Promise<T>) => Promise<T>,
    options: { actorId?: string; actorType?: 'user' | 'system' | 'job'; solPriceUsd?: number; signal?: AbortSignal } = {},
  ): Promise<{ collected: boolean; lamports: number; signature?: string; reason?: string }> {
    const operational = this.guard.checkOperational('fee_collection');
    if (!operational.allowed) {
      return { collected: false, lamports: 0, reason: operational.reason };
    }

    const plan = await adapter.prepareFeeClaim(creator);
    if (!plan) {
      return { collected: false, lamports: 0, reason: 'Nothing to claim.' };
    }

    try {
      const result = await getSigner((payer) => adapter.executeFeeClaim(plan, payer, { signal: options.signal }));

      this.db.$raw
        .prepare(
          `INSERT INTO creator_fee_events
             (id, token_mint, kind, vault, wallet_address, lamports, claimable_lamports, usd_value, sol_price_usd,
              transaction_signature, network_fee_lamports, source, observed_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          newId('fee', this.now()),
          null,
          'collection',
          plan.includesCurve && plan.includesAmm ? 'both' : plan.includesCurve ? 'curve' : 'amm',
          creator,
          result.claimedLamports,
          0,
          options.solPriceUsd ? lamportsToSol(result.claimedLamports) * options.solPriceUsd : null,
          options.solPriceUsd ?? null,
          result.signature,
          result.networkFeeLamports,
          result.simulated ? 'simulation' : 'onchain',
          this.now(),
          this.now(),
        );

      // Attribute the collection back to tokens in proportion to their recorded
      // outstanding accrual, then zero that accrual.
      this.attributeCollection(creator, result.claimedLamports);

      this.audit.record({
        actorType: options.actorType ?? 'job',
        actorId: options.actorId ?? null,
        action: AUDIT_ACTIONS.feeCollected,
        targetType: 'wallet',
        targetId: creator,
        transactionSignature: result.signature,
        parameters: {
          lamports: result.claimedLamports,
          sol: lamportsToSol(result.claimedLamports),
          simulated: result.simulated,
        },
      });
      this.events.emit('fees.collected', { mint: creator, lamports: result.claimedLamports, signature: result.signature });

      this.log.info(
        { creator, sol: lamportsToSol(result.claimedLamports), signature: result.signature },
        'creator fees collected',
      );
      return { collected: true, lamports: result.claimedLamports, signature: result.signature };
    } catch (e) {
      const message = safeErrorText(e, 400);
      this.audit.record({
        actorType: options.actorType ?? 'job',
        actorId: options.actorId ?? null,
        action: AUDIT_ACTIONS.feeCollectionSkipped,
        targetType: 'wallet',
        targetId: creator,
        result: 'failed',
        resultDetail: message,
      });
      throw new AppError('transaction_failed', `Creator fee collection failed: ${message}`, { cause: e, retryable: true });
    }
  }

  private attributeCollection(creator: string, claimedLamports: number): void {
    const rows = this.db.$raw
      .prepare('SELECT mint, creator_fees_accrued_lamports FROM tokens WHERE creator_address = ? AND creator_fees_accrued_lamports > 0')
      .all(creator) as Array<{ mint: string; creator_fees_accrued_lamports: number }>;
    const totalAccrued = rows.reduce((acc, r) => acc + r.creator_fees_accrued_lamports, 0);
    if (totalAccrued <= 0) return;

    const update = this.db.$raw.prepare(
      `UPDATE tokens SET creator_fees_collected_lamports = creator_fees_collected_lamports + ?,
                         creator_fees_accrued_lamports = MAX(0, creator_fees_accrued_lamports - ?),
                         last_fee_collection_at = ?
       WHERE mint = ?`,
    );
    this.db.$raw.transaction(() => {
      for (const row of rows) {
        const share = Math.round((row.creator_fees_accrued_lamports / totalAccrued) * claimedLamports);
        update.run(share, row.creator_fees_accrued_lamports, this.now(), row.mint);
      }
    })();
  }

  latestSnapshot(creator: string): { totalClaimableLamports: number; observedAt: number } | null {
    const rows = this.db.$raw
      .prepare(
        `SELECT vault, claimable_lamports, observed_at FROM creator_fee_events
          WHERE wallet_address = ? AND kind = 'accrual_snapshot'
          ORDER BY observed_at DESC LIMIT 2`,
      )
      .all(creator) as Array<{ vault: string; claimable_lamports: number; observed_at: number }>;
    if (rows.length === 0) return null;
    const latestAt = rows[0]!.observed_at;
    const total = rows.filter((r) => r.observed_at === latestAt).reduce((acc, r) => acc + r.claimable_lamports, 0);
    return { totalClaimableLamports: total, observedAt: latestAt };
  }

  private collectedLamportsBetween(creator: string, fromMs: number, toMs: number): number {
    const row = this.db.$raw
      .prepare(
        `SELECT COALESCE(SUM(lamports), 0) AS total FROM creator_fee_events
          WHERE wallet_address = ? AND kind = 'collection' AND observed_at > ? AND observed_at <= ?`,
      )
      .get(creator, fromMs, toMs) as { total: number };
    return row?.total ?? 0;
  }

  lastCollectionAt(creator: string): number | null {
    const row = this.db.$raw
      .prepare(
        `SELECT observed_at FROM creator_fee_events WHERE wallet_address = ? AND kind = 'collection'
          ORDER BY observed_at DESC LIMIT 1`,
      )
      .get(creator) as { observed_at: number } | undefined;
    return row?.observed_at ?? null;
  }

  /** Fee totals for the dashboard, split by realised and outstanding. */
  async totals(): Promise<{
    collectedLamports: number;
    collectedTodayLamports: number;
    collected7dLamports: number;
    collected30dLamports: number;
    outstandingLamports: number;
    strandedRentLamports: number;
    collectionCount: number;
  }> {
    const sumSince = (since: number): number => {
      const row = this.db.$raw
        .prepare(`SELECT COALESCE(SUM(lamports), 0) AS total FROM creator_fee_events WHERE kind = 'collection' AND observed_at >= ?`)
        .get(since) as { total: number };
      return row?.total ?? 0;
    };

    const collected = sumSince(0);
    const outstandingRow = this.db.$raw
      .prepare(
        `SELECT COALESCE(SUM(claimable_lamports), 0) AS total FROM creator_fee_events e
          WHERE kind = 'accrual_snapshot'
            AND observed_at = (SELECT MAX(observed_at) FROM creator_fee_events WHERE kind = 'accrual_snapshot')`,
      )
      .get() as { total: number };

    const vaultCount = this.db.$raw
      .prepare(`SELECT COUNT(DISTINCT wallet_address) AS n FROM creator_fee_events WHERE kind = 'accrual_snapshot' AND vault = 'curve'`)
      .get() as { n: number };

    const countRow = this.db.$raw
      .prepare(`SELECT COUNT(*) AS n FROM creator_fee_events WHERE kind = 'collection'`)
      .get() as { n: number };

    return {
      collectedLamports: collected,
      collectedTodayLamports: sumSince(this.now() - TIME.day),
      collected7dLamports: sumSince(this.now() - 7 * TIME.day),
      collected30dLamports: sumSince(this.now() - 30 * TIME.day),
      outstandingLamports: outstandingRow?.total ?? 0,
      // Surfaced explicitly so the operator understands why the vault balance
      // and the claimable amount never agree.
      strandedRentLamports: (vaultCount?.n ?? 0) * CURVE_VAULT_RENT_LAMPORTS,
      collectionCount: countRow?.n ?? 0,
    };
  }

  async history(limit = 100): Promise<Array<Record<string, unknown>>> {
    return this.db.$raw
      .prepare(
        `SELECT * FROM creator_fee_events WHERE kind = 'collection' ORDER BY observed_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
  }
}
