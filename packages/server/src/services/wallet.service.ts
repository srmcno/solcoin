import { Keypair, PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import { lamportsToSol, solToLamports, type ExecutionNetwork } from '@solcoin/shared';
import { createHash } from 'node:crypto';
import { AppError, safeErrorText } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { componentLogger } from '../core/logger.js';
import type { Db } from '../db/client.js';
import type { EventBus } from '../core/events.js';
import { AUDIT_ACTIONS, type AuditLog } from '../security/audit.js';
import type { WalletKeystore } from '../security/keystore.js';
import type { SolanaRpc } from '../providers/solana/rpc.js';
import type { GuardService } from './guard.service.js';
import type { SettingsService } from './settings.service.js';

/**
 * Wallet operations and treasury separation.
 *
 * The custody model is deliberately two-tier:
 *
 *   TREASURY (key held outside this process — hardware wallet, exchange,
 *             a separate signer; the platform only ever knows the address)
 *      ▲  periodic sweeps of accumulated revenue
 *      │
 *   OPERATING WALLET (encrypted keystore in this process, funded with only
 *                     what near-term launches and fee claims require)
 *      │
 *      ▼  token creation, fee collection
 *
 * The point is bounded loss: a total compromise of this process costs the
 * operating float, not the accumulated revenue. Sweeps move value *out* of the
 * hot wallet and never in, and the treasury address is a sensitive setting that
 * requires elevated permissions to change — because an attacker who can change
 * it can redirect every future sweep.
 */

export interface WalletSummary {
  address: string | null;
  role: string;
  network: ExecutionNetwork;
  balanceLamports: number;
  balanceSol: number;
  balanceCheckedAt: number | null;
  custody: string;
  canSign: boolean;
  belowFloor: boolean;
  floorSol: number;
  availableForSpendSol: number;
  treasuryAddress: string | null;
  treasuryBalanceLamports: number | null;
}

export class WalletService {
  private readonly log = componentLogger('wallet');

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly keystore: WalletKeystore,
    private readonly guard: GuardService,
    private readonly audit: AuditLog,
    private readonly events: EventBus,
    private readonly rpc: SolanaRpc | null,
    private readonly now: () => number = Date.now,
  ) {}

  async summary(): Promise<WalletSummary> {
    const config = this.settings.get();
    const network = config.execution.network;
    const record = await this.keystore.getRecord();
    const address = record?.publicKey ?? null;
    const floorSol = config.limits.walletBalanceFloorSol;

    let balanceLamports = 0;
    let balanceCheckedAt: number | null = null;

    if (address) {
      const cached = this.db.$raw
        .prepare('SELECT balance_lamports, balance_checked_at FROM wallet_accounts WHERE address = ? AND network = ?')
        .get(address, network) as { balance_lamports: number; balance_checked_at: number | null } | undefined;
      balanceLamports = cached?.balance_lamports ?? 0;
      balanceCheckedAt = cached?.balance_checked_at ?? null;
    }

    let treasuryBalanceLamports: number | null = null;
    if (config.wallet.treasuryAddress) {
      const cached = this.db.$raw
        .prepare('SELECT balance_lamports FROM wallet_accounts WHERE address = ? AND network = ?')
        .get(config.wallet.treasuryAddress, network) as { balance_lamports: number } | undefined;
      treasuryBalanceLamports = cached?.balance_lamports ?? null;
    }

    return {
      address,
      role: 'operating',
      network,
      balanceLamports,
      balanceSol: lamportsToSol(balanceLamports),
      balanceCheckedAt,
      custody: record?.custody ?? 'none',
      canSign: await this.keystore.canSign(),
      belowFloor: lamportsToSol(balanceLamports) < floorSol,
      floorSol,
      availableForSpendSol: Math.max(0, lamportsToSol(balanceLamports) - floorSol),
      treasuryAddress: config.wallet.treasuryAddress ?? null,
      treasuryBalanceLamports,
    };
  }

  /** Refresh balances from chain and persist them. */
  /**
   * Resolve outgoing transactions that were left `pending`.
   *
   * A row is written before the transaction is sent and updated after, so a
   * process that dies in between leaves one stranded. Nothing else ever touches
   * it: it stays pending forever, showing on the wallet page as an outgoing
   * transfer that is neither confirmed nor failed. The job that should fix this
   * is called `wallet-reconcile` and, until now, only refreshed balances.
   *
   * Three cases, deliberately distinct:
   *
   *  - A row with a signature can be resolved against the chain, which is the
   *    only authority on whether it landed.
   *  - A fee-claim reservation with no signature never got as far as sending.
   *    It exists to hold spending allowance while a claim runs, and the claim
   *    itself is recorded in `creator_fee_events`, so voiding an old one loses
   *    nothing and frees the allowance it is holding.
   *  - A transfer with no signature is genuinely unknown: it may have been
   *    broadcast in the instant before the process died. Guessing either way
   *    would be a lie, so it is counted and reported rather than resolved.
   */
  async reconcilePending(options: { olderThanMs?: number } = {}): Promise<{
    confirmed: number;
    failed: number;
    voided: number;
    unknown: number;
  }> {
    const cutoff = this.now() - (options.olderThanMs ?? 10 * 60_000);
    const rows = this.db.$raw
      .prepare(
        `SELECT id, signature, purpose FROM wallet_transactions
          WHERE direction = 'out' AND status = 'pending' AND occurred_at < ?
          ORDER BY occurred_at ASC LIMIT 100`,
      )
      .all(cutoff) as Array<{ id: string; signature: string | null; purpose: string }>;

    const result = { confirmed: 0, failed: 0, voided: 0, unknown: 0 };

    for (const row of rows) {
      if (!row.signature) {
        if (row.purpose === 'fee_claim') {
          this.db.$raw
            .prepare(
              `UPDATE wallet_transactions
                  SET status = 'failed', fee_lamports = 0,
                      error = 'Spending reservation for a fee claim that never reported an outcome.'
                WHERE id = ?`,
            )
            .run(row.id);
          result.voided++;
        } else {
          result.unknown++;
        }
        continue;
      }

      if (!this.rpc) {
        result.unknown++;
        continue;
      }

      const status = await this.rpc.getSignatureStatus(row.signature).catch(() => null);
      if (!status) {
        result.unknown++;
        continue;
      }
      if (status.err) {
        this.db.$raw
          .prepare(`UPDATE wallet_transactions SET status = 'failed', error = ? WHERE id = ?`)
          .run('The transaction was found on chain and had failed.', row.id);
        result.failed++;
      } else {
        this.db.$raw.prepare(`UPDATE wallet_transactions SET status = 'confirmed' WHERE id = ?`).run(row.id);
        result.confirmed++;
      }
    }

    if (result.unknown > 0) {
      this.log.warn(
        { unknown: result.unknown },
        'outgoing transactions whose outcome cannot be determined; they are left pending rather than guessed at',
      );
    }
    return result;
  }

  async refreshBalances(): Promise<{ operating: number | null; treasury: number | null }> {
    const config = this.settings.get();
    const network = config.execution.network;

    // Simulation has no chain to read. When no wallet has been configured there
    // is deliberately nothing to register: inventing an address and a balance
    // would put a fabricated figure on the dashboard and make an unconfigured
    // wallet look like a degraded one.
    if (network === 'simulation' || !this.rpc) {
      const record = await this.keystore.getRecord();
      if (!record) return { operating: null, treasury: null };

      // A configured wallet gets a simulated float so the spending limits are
      // exercised end to end. Its custody is reported truthfully, and the
      // balance is labelled as simulated everywhere it is displayed.
      const simulated = solToLamports(2);
      this.upsertAccount(
        record.publicKey,
        'operating',
        network,
        simulated,
        record.custody,
        record.custody === 'encrypted_keystore',
      );
      return { operating: simulated, treasury: null };
    }

    const address = await this.keystore.getPublicKey();
    let operating: number | null = null;
    if (address) {
      try {
        operating = await this.rpc.getBalance(address);
        this.upsertAccount(address, 'operating', network, operating, (await this.keystore.getRecord())?.custody ?? 'watch_only', await this.keystore.canSign());
      } catch (e) {
        this.log.warn({ err: safeErrorText(e, 160) }, 'could not refresh the operating wallet balance');
      }
    }

    let treasury: number | null = null;
    if (config.wallet.treasuryAddress) {
      try {
        treasury = await this.rpc.getBalance(config.wallet.treasuryAddress);
        this.upsertAccount(config.wallet.treasuryAddress, 'treasury', network, treasury, 'external', false);
      } catch (e) {
        this.log.warn({ err: safeErrorText(e, 160) }, 'could not refresh the treasury balance');
      }
    }

    if (operating !== null) {
      const floor = solToLamports(config.limits.walletBalanceFloorSol);
      if (operating < floor) {
        this.events.emit('wallet.low_balance', { address: address!, balanceLamports: operating, floorLamports: floor });
      }
    }

    return { operating, treasury };
  }

  private upsertAccount(
    address: string,
    role: string,
    network: string,
    balanceLamports: number,
    custody: string,
    hasSigningKey: boolean,
  ): void {
    this.db.$raw
      .prepare(
        `INSERT INTO wallet_accounts (id, role, address, label, network, has_signing_key, custody,
                                      balance_lamports, balance_checked_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(address, network) DO UPDATE SET
           balance_lamports = excluded.balance_lamports,
           balance_checked_at = excluded.balance_checked_at,
           has_signing_key = excluded.has_signing_key,
           custody = excluded.custody,
           role = excluded.role,
           updated_at = excluded.updated_at`,
      )
      .run(
        newId('wal'),
        role,
        address,
        role === 'treasury' ? 'Treasury' : 'Operating wallet',
        network,
        hasSigningKey ? 1 : 0,
        custody,
        balanceLamports,
        this.now(),
        this.now(),
        this.now(),
      );
  }

  /**
   * Decide whether a treasury sweep is warranted.
   *
   * A sweep costs a transaction fee, so it only makes sense once the surplus is
   * meaningfully larger than that cost. Sweeping down to the float rather than
   * to zero keeps the platform operational immediately afterwards.
   */
  async evaluateSweep(): Promise<{
    shouldSweep: boolean;
    reason: string;
    amountLamports: number;
    destination: string | null;
  }> {
    const config = this.settings.get();
    const summary = await this.summary();

    if (!config.wallet.treasuryAddress) {
      return { shouldSweep: false, reason: 'No treasury address is configured.', amountLamports: 0, destination: null };
    }
    if (!summary.canSign) {
      return {
        shouldSweep: false,
        reason: 'This process cannot sign for the operating wallet.',
        amountLamports: 0,
        destination: config.wallet.treasuryAddress,
      };
    }

    const thresholdLamports = solToLamports(config.wallet.sweepThresholdSol);
    if (summary.balanceLamports < thresholdLamports) {
      return {
        shouldSweep: false,
        reason: `Balance ${summary.balanceSol.toFixed(4)} SOL is below the ${config.wallet.sweepThresholdSol} SOL sweep threshold.`,
        amountLamports: 0,
        destination: config.wallet.treasuryAddress,
      };
    }

    const floatLamports = solToLamports(config.wallet.operatingFloatSol);
    const amount = summary.balanceLamports - floatLamports;
    // Leave headroom for the transaction fee itself.
    const sweepable = amount - 10_000;

    if (sweepable <= 0) {
      return {
        shouldSweep: false,
        reason: 'Nothing above the operating float to sweep.',
        amountLamports: 0,
        destination: config.wallet.treasuryAddress,
      };
    }

    return {
      shouldSweep: true,
      reason: `${lamportsToSol(sweepable).toFixed(4)} SOL above the ${config.wallet.operatingFloatSol} SOL operating float.`,
      amountLamports: sweepable,
      destination: config.wallet.treasuryAddress,
    };
  }

  /**
   * Move SOL out of the operating wallet.
   *
   * Every transfer is idempotency-keyed, guard-checked and audited. The
   * destination is validated as a real public key before anything is signed —
   * a typo here is an irreversible loss.
   */
  async transfer(input: {
    destination: string;
    lamports: number;
    purpose: 'treasury_sweep' | 'manual_transfer';
    actorId?: string;
    actorType?: 'user' | 'system' | 'job';
    actorLabel?: string;
    idempotencyKey?: string;
  }): Promise<{ signature: string; lamports: number }> {
    const config = this.settings.get();
    const network = config.execution.network;

    if (network === 'simulation') {
      throw new AppError('forbidden', 'Transfers are not available in simulation mode: there are no real funds to move.');
    }
    if (!this.rpc) throw new AppError('not_configured', 'No Solana RPC is configured.');

    let destination: PublicKey;
    try {
      destination = new PublicKey(input.destination);
      // Reject an address that is not on the ed25519 curve unless it is a known
      // PDA; sending to an off-curve address that nobody controls burns funds.
      if (!PublicKey.isOnCurve(destination.toBytes())) {
        throw new Error('address is not on the ed25519 curve');
      }
    } catch (e) {
      throw new AppError('validation_failed', `"${input.destination}" is not a valid Solana address that can receive SOL.`, {
        cause: e,
      });
    }

    const source = await this.keystore.getPublicKey();
    if (source && destination.toBase58() === source) {
      throw new AppError('validation_failed', 'The destination is the operating wallet itself.');
    }

    const balance = await this.rpc.getBalance(source ?? destination);

    const idempotencyKey =
      input.idempotencyKey ??
      createHash('sha256')
        .update(`transfer:${network}:${destination.toBase58()}:${input.lamports}:${Math.floor(this.now() / 60_000)}`)
        .digest('hex')
        .slice(0, 40);

    const existing = this.db.$raw
      .prepare('SELECT signature, status FROM wallet_transactions WHERE idempotency_key = ?')
      .get(idempotencyKey) as { signature: string | null; status: string } | undefined;
    if (existing?.signature && existing.status !== 'failed') {
      return { signature: existing.signature, lamports: input.lamports };
    }

    const txId = newId('wtx', this.now());

    /*
     * The spend limits are evaluated in the same transaction that writes the
     * `pending` row consuming them. Checking first and inserting afterwards
     * leaves an `await` in between, and two transfers to different
     * destinations arriving in that window both read the same committed spend,
     * both clear the caps, and both land — for a combined amount the caps were
     * supposed to forbid. Everything slow is already done above.
     */
    const reservation = this.guard.reserveSpend(
      { operation: 'wallet_transfer', lamports: input.lamports, walletBalanceLamports: balance },
      () => {
        this.db.$raw
          .prepare(
            `INSERT INTO wallet_transactions (id, wallet_address, network, direction, purpose, lamports,
                                              counterparty, status, idempotency_key, initiated_by, occurred_at, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            txId,
            source ?? '',
            network,
            'out',
            input.purpose,
            input.lamports,
            destination.toBase58(),
            'pending',
            idempotencyKey,
            input.actorId ?? null,
            this.now(),
            this.now(),
          );
      },
    );
    if (reservation.outcome === 'denied') throw this.guard.denial(reservation.decision);

    try {
      const result = await this.keystore.withSigner(async (payer) => {
        const instruction: TransactionInstruction = SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: destination,
          lamports: input.lamports,
        });
        return this.rpc!.sendTransaction([instruction], payer, { skipSimulation: false });
      });

      this.db.$raw
        .prepare(
          `UPDATE wallet_transactions SET signature = ?, status = 'confirmed', fee_lamports = ?, occurred_at = ?
           WHERE id = ?`,
        )
        .run(result.signature, result.feeLamports ?? 5_000, result.confirmedAt, txId);

      this.audit.record({
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        actorLabel: input.actorLabel ?? null,
        action: input.purpose === 'treasury_sweep' ? AUDIT_ACTIONS.walletSweep : AUDIT_ACTIONS.walletTransfer,
        targetType: 'wallet',
        targetId: source ?? '',
        transactionSignature: result.signature,
        parameters: { destination: destination.toBase58(), sol: lamportsToSol(input.lamports), network },
      });

      if (input.purpose === 'treasury_sweep') {
        this.events.emit('wallet.swept', {
          from: source ?? '',
          to: destination.toBase58(),
          lamports: input.lamports,
          signature: result.signature,
        });
      }

      await this.refreshBalances();
      return { signature: result.signature, lamports: input.lamports };
    } catch (e) {
      const message = safeErrorText(e, 400);
      this.db.$raw
        .prepare(`UPDATE wallet_transactions SET status = 'failed', error = ? WHERE id = ?`)
        .run(message, txId);
      this.audit.record({
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        action: AUDIT_ACTIONS.walletTransfer,
        targetType: 'wallet',
        targetId: source ?? '',
        result: 'failed',
        resultDetail: message,
      });
      throw e;
    }
  }

  async transactions(limit = 100): Promise<Array<Record<string, unknown>>> {
    return this.db.$raw
      .prepare('SELECT * FROM wallet_transactions ORDER BY occurred_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
  }

  async accounts(): Promise<Array<Record<string, unknown>>> {
    return this.db.$raw.prepare('SELECT * FROM wallet_accounts ORDER BY role, created_at').all() as Array<
      Record<string, unknown>
    >;
  }

  /**
   * The signer callback handed to the launch and fee services.
   *
   * In simulation this returns a deterministic throwaway keypair so the whole
   * pipeline runs without a real wallet ever existing.
   */
  signerFor(network: ExecutionNetwork): <T>(fn: (keypair: Keypair) => Promise<T>) => Promise<T> {
    if (network === 'simulation') {
      const seed = createHash('sha256').update('solcoin-simulation-wallet').digest();
      const keypair = Keypair.fromSeed(new Uint8Array(seed));
      return async (fn) => fn(keypair);
    }
    return (fn) => this.keystore.withSigner(fn);
  }
}
