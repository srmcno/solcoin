import { createHash } from 'node:crypto';
import type { Keypair } from '@solana/web3.js';
import { lamportsToSol, solToLamports, type ExecutionNetwork } from '@solcoin/shared';
import { AppError, errorCode, safeErrorText } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { componentLogger } from '../core/logger.js';
import { parseJson } from '../core/json.js';
import type { Db } from '../db/client.js';
import type { EventBus } from '../core/events.js';
import { AUDIT_ACTIONS, type AuditLog } from '../security/audit.js';
import type { LaunchAdapter, LaunchRequest } from '../providers/solana/launch-adapter.js';
import type { GuardDecision, GuardReservation, GuardService } from './guard.service.js';
import type { SettingsService } from './settings.service.js';

/**
 * Launch orchestration.
 *
 * The single most important property of this service is that **a token is never
 * created twice**, no matter how the process fails or is retried. Three
 * independent mechanisms enforce that, because any one of them alone has a hole:
 *
 *  1. A unique index on `launches.idempotency_key`. The row is inserted
 *     *before* anything is broadcast, so a concurrent or retried attempt hits a
 *     constraint violation rather than racing.
 *  2. The mint keypair is derived deterministically from that same key, so even
 *     if the database row were lost, the second attempt would target the same
 *     mint address and the on-chain create would fail as "already in use"
 *     rather than minting a second token.
 *  3. The signature is persisted at the moment of signing, before the first
 *     broadcast. A process that dies mid-flight leaves a record that the
 *     recovery path uses to *confirm* the existing transaction instead of
 *     sending a new one.
 *
 * Everything else here — limits, autonomy checks, audit — is important, but this
 * is the part where a bug costs real money.
 */

export interface LaunchInput {
  conceptId: string;
  predictionId?: string;
  name: string;
  symbol: string;
  description: string;
  metadataUri: string;
  imageUri?: string;
  approvalMode: 'manual' | 'autonomous';
  initiatedBy?: string;
  actorLabel?: string;
}

export interface LaunchOutcome {
  launchId: string;
  status: 'confirmed' | 'failed' | 'blocked';
  mintAddress?: string;
  signature?: string;
  network: ExecutionNetwork;
  costLamports?: number;
  error?: string;
  errorCode?: string;
  simulated: boolean;
}

export class LaunchService {
  private readonly log = componentLogger('launch');

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly guard: GuardService,
    private readonly audit: AuditLog,
    private readonly events: EventBus,
    private readonly adapters: Map<string, LaunchAdapter>,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The idempotency key.
   *
   * Derived from the concept plus the target network, so the same concept can
   * legitimately be launched once on devnet and once on mainnet, but never
   * twice on the same network.
   */
  static idempotencyKey(conceptId: string, network: ExecutionNetwork): string {
    return createHash('sha256').update(`launch:${network}:${conceptId}`).digest('hex').slice(0, 40);
  }

  private adapterFor(network: ExecutionNetwork): LaunchAdapter {
    const configured = this.settings.get().execution.adapter;
    if (network === 'simulation') {
      const sim = this.adapters.get('simulation');
      if (!sim) throw new AppError('not_configured', 'The simulation adapter is not registered.');
      return sim;
    }
    if (configured !== 'auto') {
      const chosen = this.adapters.get(configured);
      if (chosen && chosen.networks.includes(network)) return chosen;
    }
    for (const adapter of this.adapters.values()) {
      if (adapter.networks.includes(network)) return adapter;
    }
    throw new AppError('not_configured', `No launch adapter is available for the "${network}" network.`);
  }

  /**
   * Execute a launch.
   *
   * `getSigner` is a callback rather than a keypair so that plaintext key
   * material is scoped to the signing window and never held by this service.
   */
  async launch(
    input: LaunchInput,
    getSigner: <T>(fn: (keypair: Keypair) => Promise<T>) => Promise<T>,
    options: { signal?: AbortSignal; walletBalanceLamports?: number } = {},
  ): Promise<LaunchOutcome> {
    const config = this.settings.get();
    const network = config.execution.network;
    const idempotencyKey = LaunchService.idempotencyKey(input.conceptId, network);

    // Reconcile before doing anything: a previous attempt may already have
    // succeeded, or be mid-flight.
    const existing = this.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      const reconciled = await this.reconcile(existing);
      if (reconciled) return reconciled;
    }

    const recordBlocked = (decision: GuardDecision): LaunchOutcome => {
      this.audit.record({
        actorType: input.approvalMode === 'autonomous' ? 'system' : 'user',
        actorId: input.initiatedBy ?? null,
        actorLabel: input.actorLabel ?? null,
        action: AUDIT_ACTIONS.launchBlocked,
        targetType: 'concept',
        targetId: input.conceptId,
        result: 'blocked',
        reason: decision.reason,
        parameters: { code: decision.code, network },
      });
      return {
        launchId: '',
        status: 'blocked',
        network,
        error: decision.reason,
        errorCode: decision.code,
        simulated: network === 'simulation',
      };
    };

    // A cheap early rejection so an obviously blocked launch does not pay for
    // an adapter readiness probe. It is not the decision that binds: that one
    // is made below, inside the transaction that claims the slot.
    const preflight = this.guard.checkLaunch(options.walletBalanceLamports);
    if (!preflight.allowed) return recordBlocked(preflight);

    const adapter = this.adapterFor(network);
    const readiness = await adapter.ready();
    if (!readiness.ready) {
      throw new AppError('provider_unavailable', `The ${adapter.label} adapter is not ready: ${readiness.reason}`, {
        retryable: true,
      });
    }

    const launchId = newId('lch', this.now());

    /*
     * Claim the idempotency key before any side effect, and re-evaluate the
     * launch gate in the same transaction that claims it.
     *
     * The pre-flight above cannot bind on its own: the launch counters are
     * read from the database, and between that read and this insert there is
     * an `await` on the adapter readiness probe. Two launches of different
     * concepts arriving in that window would both see the same counts, both
     * clear the hourly and daily limits, and both proceed. Deciding inside the
     * transaction that writes the `preparing` row closes it.
     *
     * A unique-constraint violation here means another attempt got there
     * first, which is a success condition for correctness, not an error.
     */
    let reservation: GuardReservation<void>;
    try {
      reservation = this.guard.reserveLaunch(
        options.walletBalanceLamports,
        () => {
          this.db.$raw
            .prepare(
              `INSERT INTO launches (id, concept_id, prediction_id, idempotency_key, network, adapter, status,
                                     approval_mode, initiated_by, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              launchId,
              input.conceptId,
              input.predictionId ?? null,
              idempotencyKey,
              network,
              adapter.id,
              'preparing',
              input.approvalMode,
              input.initiatedBy ?? null,
              this.now(),
              this.now(),
            );
        },
        // Checked inside the same transaction, ahead of the limits: a second
        // attempt at a launch that is already claimed is a duplicate, not a
        // platform that has run out of hourly slots, and saying the latter
        // would send an operator looking for the wrong problem.
        { alreadyClaimed: () => this.findByIdempotencyKey(idempotencyKey) !== null },
      );
    } catch (e) {
      // A unique-constraint violation here means a concurrent attempt claimed
      // the key first. For correctness that is a success — exactly one launch
      // exists — so it is reported as a blocked outcome rather than thrown.
      const conflicting = this.findByIdempotencyKey(idempotencyKey);
      if (conflicting) {
        const reconciled = await this.reconcile(conflicting);
        if (reconciled) return reconciled;
        return {
          launchId: String(conflicting.id),
          status: 'blocked',
          network,
          error: 'Another launch attempt for this concept is already in progress on this network.',
          errorCode: 'conflict',
          simulated: network === 'simulation',
        };
      }
      this.log.error({ conceptId: input.conceptId, err: safeErrorText(e, 200) }, 'could not claim the launch idempotency key');
      return {
        launchId: '',
        status: 'blocked',
        network,
        error: 'Could not claim the launch idempotency key.',
        errorCode: 'conflict',
        simulated: network === 'simulation',
      };
    }

    // Resolved inside the transaction, so nothing was written either way.
    if (reservation.outcome === 'denied') return recordBlocked(reservation.decision);
    if (reservation.outcome === 'abandoned') {
      const conflicting = this.findByIdempotencyKey(idempotencyKey);
      if (conflicting) {
        const reconciled = await this.reconcile(conflicting);
        if (reconciled) return reconciled;
      }
      return {
        launchId: conflicting ? String(conflicting.id) : '',
        status: 'blocked',
        network,
        error: 'Another launch attempt for this concept is already in progress on this network.',
        errorCode: 'conflict',
        simulated: network === 'simulation',
      };
    }

    this.audit.record({
      actorType: input.approvalMode === 'autonomous' ? 'system' : 'user',
      actorId: input.initiatedBy ?? null,
      actorLabel: input.actorLabel ?? null,
      action: AUDIT_ACTIONS.launchRequested,
      targetType: 'launch',
      targetId: launchId,
      parameters: { conceptId: input.conceptId, symbol: input.symbol, network, adapter: adapter.id },
    });
    this.events.emit('launch.queued', { launchId, conceptId: input.conceptId });

    const request: LaunchRequest = {
      idempotencyKey,
      name: input.name,
      symbol: input.symbol,
      description: input.description,
      metadataUri: input.metadataUri,
      imageUri: input.imageUri,
      devBuyLamports: solToLamports(config.execution.devBuySol),
      slippageBps: config.execution.slippageBps,
      priorityFeeMicroLamports: config.execution.priorityFeeMicroLamports,
      network,
    };

    try {
      const outcome = await getSigner(async (payer) => {
        const plan = await adapter.prepare(request, payer.publicKey.toBase58());

        this.db.$raw
          .prepare(
            `UPDATE launches SET mint_address = ?, metadata_uri = ?, image_uri = ?, creator_address = ?,
                                 dev_buy_lamports = ?, total_cost_lamports = ?, attempts = attempts + 1,
                                 updated_at = ? WHERE id = ?`,
          )
          .run(
            plan.mintAddress,
            input.metadataUri,
            input.imageUri ?? null,
            payer.publicKey.toBase58(),
            request.devBuyLamports,
            plan.estimatedCostLamports,
            this.now(),
            launchId,
          );

        return adapter.execute(plan, payer, {
          signal: options.signal,
          // Persisting the signature before the first broadcast is what makes
          // crash recovery possible without risking a duplicate.
          onSigned: ({ signature, blockhash, lastValidBlockHeight }) => {
            this.db.$raw
              .prepare(
                `UPDATE launches SET status = 'submitted', transaction_signature = ?, blockhash = ?,
                                     last_valid_block_height = ?, submitted_at = ?, updated_at = ?
                 WHERE id = ?`,
              )
              .run(signature, blockhash, lastValidBlockHeight, this.now(), this.now(), launchId);
            this.events.emit('launch.submitted', { launchId, signature, network });
          },
        });
      });

      this.db.$raw
        .prepare(
          `UPDATE launches SET status = 'confirmed', transaction_signature = ?, slot = ?,
                               total_cost_lamports = ?, network_fee_lamports = ?, confirmed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          outcome.signature,
          outcome.slot,
          outcome.actualCostLamports,
          outcome.networkFeeLamports,
          outcome.confirmedAt,
          this.now(),
          launchId,
        );

      this.audit.record({
        actorType: input.approvalMode === 'autonomous' ? 'system' : 'user',
        actorId: input.initiatedBy ?? null,
        action: AUDIT_ACTIONS.launchConfirmed,
        targetType: 'launch',
        targetId: launchId,
        transactionSignature: outcome.signature,
        parameters: {
          mint: outcome.mintAddress,
          network,
          costSol: lamportsToSol(outcome.actualCostLamports),
          simulated: outcome.simulated,
        },
      });
      this.events.emit('launch.confirmed', {
        launchId,
        mint: outcome.mintAddress,
        network,
        signature: outcome.signature,
      });

      return {
        launchId,
        status: 'confirmed',
        mintAddress: outcome.mintAddress,
        signature: outcome.signature,
        network,
        costLamports: outcome.actualCostLamports,
        simulated: outcome.simulated,
      };
    } catch (e) {
      const code = errorCode(e);
      const message = safeErrorText(e, 600);
      this.recordFailure(launchId, code, message);

      this.audit.record({
        actorType: input.approvalMode === 'autonomous' ? 'system' : 'user',
        actorId: input.initiatedBy ?? null,
        action: AUDIT_ACTIONS.launchFailed,
        targetType: 'launch',
        targetId: launchId,
        result: 'failed',
        resultDetail: message,
        parameters: { code, network },
      });
      this.events.emit('launch.failed', { launchId, error: message, code, attempts: 1 });

      // Repeated failures usually mean something systemic. Stopping is cheaper
      // than continuing to burn rent on transactions that will not land.
      const consecutive = this.guard.consecutiveLaunchFailures();
      const threshold = this.settings.get().limits.consecutiveFailureShutdown;
      if (consecutive >= threshold) {
        this.guard.autoStop(
          `${consecutive} consecutive launch failures on ${network}. Most recent: ${message.slice(0, 200)}`,
        );
      }

      return { launchId, status: 'failed', network, error: message, errorCode: code, simulated: network === 'simulation' };
    }
  }

  /**
   * Reconcile an in-flight or completed launch found by idempotency key.
   *
   * Returns an outcome when the existing record settles the question, or null
   * when the caller should proceed with a fresh attempt (only possible when the
   * previous attempt definitively failed before broadcasting).
   */
  private async reconcile(row: Record<string, unknown>): Promise<LaunchOutcome | null> {
    const status = String(row.status);
    const launchId = String(row.id);
    const network = String(row.network) as ExecutionNetwork;

    if (status === 'confirmed') {
      this.log.info({ launchId }, 'launch already confirmed for this idempotency key; returning the existing result');
      return {
        launchId,
        status: 'confirmed',
        mintAddress: (row.mint_address as string) ?? undefined,
        signature: (row.transaction_signature as string) ?? undefined,
        network,
        costLamports: Number(row.total_cost_lamports ?? 0),
        simulated: network === 'simulation',
      };
    }

    if (status === 'preparing') {
      // Another attempt holds the key and has not broadcast yet. Waiting is
      // correct; starting a second attempt is exactly the duplicate this
      // machinery exists to prevent.
      const ageMs = this.now() - Number(row.created_at ?? 0);
      return {
        launchId,
        status: 'blocked',
        network,
        error: `A launch attempt for this concept started ${Math.round(ageMs / 1000)}s ago and has not finished. It will be resolved by the recovery job.`,
        errorCode: 'conflict',
        simulated: network === 'simulation',
      };
    }

    if (status === 'submitted' && row.transaction_signature) {
      // A previous process broadcast this and then stopped. Deliberately no
      // adapter is required here: resolving the outcome is the recovery job's
      // responsibility, and this path must work even when the adapter that
      // produced the transaction is no longer available.
      const signature = String(row.transaction_signature);
      this.log.warn({ launchId, signature }, 'found a submitted launch with no confirmation; reconciling on chain');

      if (network === 'simulation') {
        this.db.$raw.prepare(`UPDATE launches SET status = 'confirmed', confirmed_at = ?, updated_at = ? WHERE id = ?`).run(this.now(), this.now(), launchId);
        return {
          launchId,
          status: 'confirmed',
          mintAddress: (row.mint_address as string) ?? undefined,
          signature,
          network,
          simulated: true,
        };
      }

      // Leave the row as `submitted`. The recovery job resolves it once the
      // mint appears on chain; guessing here risks marking a live token failed.
      return {
        launchId,
        status: 'blocked',
        network,
        error:
          'A previous attempt broadcast a transaction whose outcome is still unknown. It is being reconciled on chain and will not be retried until that resolves.',
        errorCode: 'conflict',
        // The simulation case returned above, so reaching here means a real network.
        simulated: false,
      };
    }

    if (status === 'failed' || status === 'abandoned') {
      // Deliberately do not auto-retry: the failure reason may still hold. A
      // person who has looked at it and wants another attempt goes through
      // `retireFailed`, which the manual launch path calls for them.
      return {
        launchId,
        status: 'failed',
        network,
        error: `A previous launch attempt for this concept failed: ${String(row.last_error ?? 'unknown error')}`,
        errorCode: String(row.error_code ?? 'internal'),
        simulated: network === 'simulation',
      };
    }

    return null;
  }

  private recordFailure(launchId: string, code: string, message: string): void {
    const row = this.db.$raw.prepare('SELECT attempt_log FROM launches WHERE id = ?').get(launchId) as
      | { attempt_log: string }
      | undefined;
    const log = parseJson<Array<Record<string, unknown>>>(row?.attempt_log, []);
    log.push({ at: this.now(), code, message: message.slice(0, 400) });
    this.db.$raw
      .prepare(
        `UPDATE launches SET status = 'failed', last_error = ?, error_code = ?, attempt_log = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(message, code, JSON.stringify(log.slice(-20)), this.now(), launchId);
  }

  /**
   * Free a failed launch so the same concept can be attempted again.
   *
   * The idempotency key is what stops a retry becoming a second token, and it
   * stays claimed by the failed row forever — so without this, "retry" on a
   * failed candidate could never submit anything, however many times it was
   * pressed. The row is kept and reclassified rather than deleted: the history
   * and the failure analytics stay intact, and only the key is retired.
   *
   * Deliberately not called on the autonomous path. A launch that failed may
   * fail the same way again, and the platform retrying by itself is how a bad
   * configuration turns into a run of paid-for failures.
   */
  retireFailed(conceptId: string, network: ExecutionNetwork): number {
    const key = LaunchService.idempotencyKey(conceptId, network);
    const retired = this.db.$raw
      .prepare(
        `UPDATE launches
            SET status = 'abandoned', idempotency_key = 'retired:' || id, updated_at = ?
          WHERE idempotency_key = ? AND status IN ('failed','abandoned')`,
      )
      .run(this.now(), key).changes;
    if (retired > 0) {
      this.log.info({ conceptId, network, retired }, 'retired a failed launch so the concept can be attempted again');
    }
    return retired;
  }

  findByIdempotencyKey(key: string): Record<string, unknown> | null {
    const row = this.db.$raw.prepare('SELECT * FROM launches WHERE idempotency_key = ?').get(key) as
      | Record<string, unknown>
      | undefined;
    return row ?? null;
  }

  async getById(launchId: string): Promise<Record<string, unknown> | null> {
    return (this.db.$raw.prepare('SELECT * FROM launches WHERE id = ?').get(launchId) as Record<string, unknown>) ?? null;
  }

  async listRecent(limit = 50): Promise<Array<Record<string, unknown>>> {
    return this.db.$raw
      .prepare('SELECT * FROM launches ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
  }

  /** Launches stuck in `submitted`, which the recovery job must resolve. */
  async listUnresolved(): Promise<Array<Record<string, unknown>>> {
    return this.db.$raw
      .prepare(`SELECT * FROM launches WHERE status IN ('preparing','submitted') ORDER BY created_at ASC LIMIT 50`)
      .all() as Array<Record<string, unknown>>;
  }

  /**
   * Resolve a launch that was broadcast but never confirmed.
   *
   * Called by the recovery job. Marks the launch confirmed if the mint now
   * exists on chain, failed if the transaction expired without landing, and
   * otherwise leaves it alone to be checked again.
   */
  async resolveUnconfirmed(
    launchId: string,
    check: (mint: string, signature: string | null) => Promise<'confirmed' | 'expired' | 'unknown'>,
  ): Promise<'confirmed' | 'failed' | 'pending'> {
    const row = await this.getById(launchId);
    if (!row) return 'pending';
    const mint = row.mint_address as string | null;
    const signature = (row.transaction_signature as string | null) ?? null;
    if (!mint) {
      // Never broadcast anything: safe to fail so it can be retried cleanly.
      this.recordFailure(launchId, 'internal', 'Launch was abandoned before a mint address was assigned.');
      return 'failed';
    }

    const state = await check(mint, signature);
    if (state === 'confirmed') {
      this.db.$raw
        .prepare(`UPDATE launches SET status = 'confirmed', confirmed_at = ?, updated_at = ? WHERE id = ?`)
        .run(this.now(), this.now(), launchId);
      this.events.emit('launch.confirmed', {
        launchId,
        mint,
        network: String(row.network),
        signature: signature ?? '',
      });
      return 'confirmed';
    }
    if (state === 'expired') {
      this.recordFailure(launchId, 'transaction_expired', 'The launch transaction expired without landing on chain.');
      this.events.emit('launch.failed', {
        launchId,
        error: 'Transaction expired without landing.',
        code: 'transaction_expired',
        attempts: Number(row.attempts ?? 1),
      });
      return 'failed';
    }
    return 'pending';
  }
}
