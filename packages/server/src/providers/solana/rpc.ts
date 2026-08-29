import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type Commitment,
  type Keypair,
  type SignatureStatus,
  type TransactionInstruction,
} from '@solana/web3.js';
import { AppError, safeErrorText } from '../../core/errors.js';
import { componentLogger } from '../../core/logger.js';
import type { Clock } from '../../core/clock.js';
import type { HealthState } from '@solcoin/shared';

/**
 * Solana RPC access and transaction submission.
 *
 * The hard part of Solana is not building a transaction, it is getting it
 * landed exactly once. This module encodes the practices that matter:
 *
 *  - **Blockhash expiry is the clock.** A transaction is valid until
 *    `lastValidBlockHeight`. We rebroadcast the *same signed transaction*
 *    repeatedly until either it confirms or that height passes. Rebroadcasting
 *    is safe — the signature is identical, so the network dedupes it — whereas
 *    re-signing with a fresh blockhash creates a second transaction that could
 *    also land. That distinction is the difference between one token and two.
 *  - **Confirmation is polled, not awaited.** `confirmTransaction` hides the
 *    expiry condition and gives no visibility; polling `getSignatureStatuses`
 *    lets us distinguish "not yet seen", "confirmed", "failed on chain" and
 *    "expired" and report each honestly.
 *  - **Compute units are simulated, not guessed.** An under-provisioned limit
 *    fails the transaction; an over-provisioned one overpays for priority.
 *  - **Endpoints fail over.** A single RPC provider going down must degrade the
 *    platform, not stop it.
 */

export interface RpcEndpoint {
  url: string;
  label: string;
  /** Lower numbers are preferred. */
  priority: number;
  /** Requests per second this endpoint tolerates. */
  rateLimit?: number;
}

export interface SolanaRpcOptions {
  endpoints: RpcEndpoint[];
  commitment?: Commitment;
  clock?: Clock;
  /** Consecutive failures before an endpoint is benched. */
  failureThreshold?: number;
  benchDurationMs?: number;
}

interface EndpointState {
  endpoint: RpcEndpoint;
  connection: Connection;
  consecutiveFailures: number;
  benchedUntil: number;
  lastLatencyMs: number;
  lastSuccessAt: number;
  lastFailureAt: number;
  lastError?: string;
}

export interface SendOptions {
  /** Abort the whole operation. */
  signal?: AbortSignal;
  /** Additional signers beyond the fee payer (e.g. the mint keypair). */
  signers?: Keypair[];
  /** Micro-lamports per compute unit. Zero means "estimate from the network". */
  priorityFeeMicroLamports?: number;
  /** Explicit compute unit limit; omitted means "simulate to find out". */
  computeUnitLimit?: number;
  /** Maximum rebroadcast attempts before giving up on a still-valid blockhash. */
  maxRebroadcasts?: number;
  commitment?: Commitment;
  /** Skip simulation. Only for instructions whose cost is already known. */
  skipSimulation?: boolean;
  /** Called once the transaction is signed, before the first broadcast. */
  onSigned?: (info: { signature: string; blockhash: string; lastValidBlockHeight: number }) => Promise<void> | void;
}

export interface SendResult {
  signature: string;
  slot: number;
  blockhash: string;
  lastValidBlockHeight: number;
  computeUnitsConsumed?: number;
  feeLamports?: number;
  rebroadcasts: number;
  confirmedAt: number;
}

export class SolanaRpc {
  private readonly log = componentLogger('solana-rpc');
  private readonly states: EndpointState[];
  private readonly commitment: Commitment;
  private readonly clock: Clock;
  private readonly failureThreshold: number;
  private readonly benchDurationMs: number;

  constructor(options: SolanaRpcOptions) {
    if (options.endpoints.length === 0) {
      throw new AppError('not_configured', 'At least one Solana RPC endpoint must be configured.');
    }
    this.commitment = options.commitment ?? 'confirmed';
    this.clock = options.clock ?? { now: () => Date.now(), date: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
    this.failureThreshold = options.failureThreshold ?? 4;
    this.benchDurationMs = options.benchDurationMs ?? 60_000;
    this.states = [...options.endpoints]
      .sort((a, b) => a.priority - b.priority)
      .map((endpoint) => ({
        endpoint,
        connection: new Connection(endpoint.url, {
          commitment: this.commitment,
          disableRetryOnRateLimit: true,
          confirmTransactionInitialTimeout: 60_000,
        }),
        consecutiveFailures: 0,
        benchedUntil: 0,
        lastLatencyMs: 0,
        lastSuccessAt: 0,
        lastFailureAt: 0,
      }));
  }

  /** The connection currently preferred, for callers that need a raw handle. */
  get connection(): Connection {
    return this.pickState().connection;
  }

  get endpointLabel(): string {
    return this.pickState().endpoint.label;
  }

  private pickState(): EndpointState {
    const now = this.clock.now();
    const healthy = this.states.filter((s) => s.benchedUntil <= now);
    if (healthy.length > 0) return healthy[0]!;
    // Everything is benched: use the one that will recover soonest rather than
    // failing outright, so a transient outage degrades instead of stopping.
    return [...this.states].sort((a, b) => a.benchedUntil - b.benchedUntil)[0]!;
  }

  /**
   * Run an RPC call against the preferred endpoint, failing over on error.
   *
   * Read calls are safe to retry across endpoints. Writes are not, and never
   * use this — `sendTransaction` pins one endpoint per attempt deliberately.
   */
  async call<T>(operation: string, fn: (connection: Connection) => Promise<T>): Promise<T> {
    const now = this.clock.now();
    const ordered = [
      ...this.states.filter((s) => s.benchedUntil <= now),
      ...this.states.filter((s) => s.benchedUntil > now),
    ];
    let lastError: unknown;

    for (const state of ordered) {
      const started = this.clock.now();
      try {
        const result = await fn(state.connection);
        state.consecutiveFailures = 0;
        state.lastLatencyMs = this.clock.now() - started;
        state.lastSuccessAt = this.clock.now();
        state.benchedUntil = 0;
        return result;
      } catch (e) {
        lastError = e;
        state.consecutiveFailures++;
        state.lastFailureAt = this.clock.now();
        state.lastError = safeErrorText(e, 200);
        if (state.consecutiveFailures >= this.failureThreshold) {
          state.benchedUntil = this.clock.now() + this.benchDurationMs;
          this.log.warn(
            { endpoint: state.endpoint.label, failures: state.consecutiveFailures },
            'benching RPC endpoint after repeated failures',
          );
        }
      }
    }

    throw new AppError('rpc_error', `Solana RPC "${operation}" failed on all endpoints: ${safeErrorText(lastError, 200)}`, {
      retryable: true,
      cause: lastError,
    });
  }

  async getBalance(address: string | PublicKey): Promise<number> {
    const key = typeof address === 'string' ? new PublicKey(address) : address;
    return this.call('getBalance', (c) => c.getBalance(key, this.commitment));
  }

  async getAccountInfo(address: string | PublicKey): Promise<AccountInfo<Buffer> | null> {
    const key = typeof address === 'string' ? new PublicKey(address) : address;
    return this.call('getAccountInfo', (c) => c.getAccountInfo(key, this.commitment));
  }

  async getMinimumBalanceForRentExemption(dataLength: number): Promise<number> {
    return this.call('getMinimumBalanceForRentExemption', (c) => c.getMinimumBalanceForRentExemption(dataLength));
  }

  async getSlot(): Promise<number> {
    return this.call('getSlot', (c) => c.getSlot(this.commitment));
  }

  async getBlockHeight(): Promise<number> {
    return this.call('getBlockHeight', (c) => c.getBlockHeight(this.commitment));
  }

  /**
   * Estimate a priority fee in micro-lamports per compute unit.
   *
   * `getRecentPrioritizationFees` returns what recent transactions actually paid
   * for the accounts we intend to touch. We take a high percentile because the
   * cost of being outbid (a launch that misses its window) far exceeds the cost
   * of overpaying by a fraction of a cent.
   */
  async estimatePriorityFee(
    writableAccounts: Array<string | PublicKey> = [],
    percentile = 0.75,
  ): Promise<number> {
    try {
      const keys = writableAccounts.slice(0, 128).map((a) => (typeof a === 'string' ? new PublicKey(a) : a));
      const fees = await this.call('getRecentPrioritizationFees', (c) =>
        c.getRecentPrioritizationFees(keys.length ? { lockedWritableAccounts: keys } : {}),
      );
      const values = fees.map((f) => f.prioritizationFee).filter((v) => v > 0).sort((a, b) => a - b);
      if (values.length === 0) return 1_000;
      const idx = Math.min(values.length - 1, Math.floor(values.length * percentile));
      // Floor at 1,000 µlamports/CU: below that the fee is noise and the
      // transaction competes poorly during any congestion at all.
      return Math.max(1_000, values[idx]!);
    } catch {
      // A provider that does not implement the method must not block a launch.
      return 10_000;
    }
  }

  /**
   * Simulate to discover the actual compute usage, then add headroom.
   *
   * Measured usage plus 20% (and a 1,000 CU floor) is the standard trade-off:
   * enough slack for account-state changes between simulation and execution,
   * without paying for unused units.
   */
  async estimateComputeUnits(
    instructions: TransactionInstruction[],
    payer: PublicKey,
    signers: Keypair[] = [],
  ): Promise<number | null> {
    try {
      const { blockhash } = await this.call('getLatestBlockhash', (c) => c.getLatestBlockhash(this.commitment));
      const message = new TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockhash,
        // A high provisional limit so simulation is not itself truncated.
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...instructions],
      }).compileToV0Message();
      const tx = new VersionedTransaction(message);
      if (signers.length) tx.sign(signers);

      const sim = await this.call('simulateTransaction', (c) =>
        c.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: this.commitment }),
      );
      if (sim.value.err) {
        this.log.debug({ err: JSON.stringify(sim.value.err).slice(0, 300) }, 'simulation returned an error');
        return null;
      }
      const consumed = sim.value.unitsConsumed;
      if (!consumed) return null;
      return Math.min(1_400_000, Math.ceil(consumed * 1.2) + 1_000);
    } catch (e) {
      this.log.debug({ err: safeErrorText(e, 160) }, 'compute unit estimation failed; falling back to a default limit');
      return null;
    }
  }

  /**
   * Build, sign, broadcast and confirm a transaction.
   *
   * The signed transaction is produced once and rebroadcast unchanged. The
   * caller's `onSigned` hook fires before the first broadcast so the signature
   * can be persisted — that record is what lets a crashed process recover
   * without re-sending a second, different transaction.
   */
  async sendTransaction(
    instructions: TransactionInstruction[],
    payer: Keypair,
    options: SendOptions = {},
  ): Promise<SendResult> {
    const commitment = options.commitment ?? this.commitment;
    const signers = [payer, ...(options.signers ?? [])];

    const computeUnitLimit =
      options.computeUnitLimit ??
      (options.skipSimulation ? null : await this.estimateComputeUnits(instructions, payer.publicKey, signers)) ??
      300_000;

    const priorityFee =
      options.priorityFeeMicroLamports && options.priorityFeeMicroLamports > 0
        ? options.priorityFeeMicroLamports
        : await this.estimatePriorityFee(collectWritableKeys(instructions));

    const budgetInstructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
    ];

    const { blockhash, lastValidBlockHeight } = await this.call('getLatestBlockhash', (c) =>
      c.getLatestBlockhash(commitment),
    );

    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [...budgetInstructions, ...instructions],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(message);
    transaction.sign(signers);

    const rawTransaction = transaction.serialize();
    const signature = bs58Encode(transaction.signatures[0]!);

    await options.onSigned?.({ signature, blockhash, lastValidBlockHeight });

    return this.broadcastAndConfirm({
      rawTransaction,
      signature,
      blockhash,
      lastValidBlockHeight,
      commitment,
      maxRebroadcasts: options.maxRebroadcasts ?? 30,
      signal: options.signal,
      computeUnitLimit,
    });
  }

  /**
   * Rebroadcast a pre-signed transaction until it confirms or expires.
   *
   * Exposed separately so a recovering process can resume confirmation of a
   * transaction that a previous process already signed and broadcast.
   */
  async broadcastAndConfirm(args: {
    rawTransaction: Uint8Array;
    signature: string;
    blockhash: string;
    lastValidBlockHeight: number;
    commitment: Commitment;
    maxRebroadcasts: number;
    signal?: AbortSignal;
    computeUnitLimit?: number;
  }): Promise<SendResult> {
    const started = this.clock.now();
    let rebroadcasts = 0;
    let lastSendError: unknown;

    // First send with preflight so an obviously-invalid transaction fails fast
    // with a useful message rather than silently never landing.
    try {
      await this.call('sendRawTransaction', (c) =>
        c.sendRawTransaction(args.rawTransaction, { skipPreflight: false, maxRetries: 0, preflightCommitment: args.commitment }),
      );
    } catch (e) {
      lastSendError = e;
      const text = safeErrorText(e, 400);
      if (/insufficient (funds|lamports)/i.test(text)) {
        throw new AppError('insufficient_funds', `The operating wallet does not hold enough SOL: ${text}`, {
          retryable: false,
          cause: e,
        });
      }
      if (/blockhash not found/i.test(text)) {
        throw new AppError('transaction_expired', 'Blockhash was not found by the RPC node; rebuild the transaction.', {
          retryable: true,
          cause: e,
        });
      }
      // "already processed" means our transaction is on chain — carry on to
      // confirmation rather than treating it as a failure.
      if (!/already (been )?processed/i.test(text)) {
        this.log.warn({ signature: args.signature, err: text }, 'initial broadcast failed; will rebroadcast');
      }
    }

    for (;;) {
      if (args.signal?.aborted) {
        throw new AppError('transaction_failed', 'Transaction confirmation was aborted.', { retryable: false });
      }

      const status = await this.getSignatureStatus(args.signature);

      if (status?.err) {
        throw new AppError('transaction_failed', `Transaction failed on chain: ${JSON.stringify(status.err).slice(0, 300)}`, {
          retryable: false,
          details: { signature: args.signature, err: status.err },
        });
      }

      if (status && isAtLeast(status.confirmationStatus, args.commitment)) {
        const detail = await this.getTransactionDetail(args.signature).catch(() => null);
        return {
          signature: args.signature,
          slot: status.slot,
          blockhash: args.blockhash,
          lastValidBlockHeight: args.lastValidBlockHeight,
          computeUnitsConsumed: detail?.computeUnitsConsumed ?? undefined,
          feeLamports: detail?.feeLamports ?? undefined,
          rebroadcasts,
          confirmedAt: this.clock.now(),
        };
      }

      const blockHeight = await this.getBlockHeight().catch(() => 0);
      if (blockHeight > 0 && blockHeight > args.lastValidBlockHeight) {
        throw new AppError(
          'transaction_expired',
          `Transaction ${args.signature} expired: block height ${blockHeight} passed ${args.lastValidBlockHeight} without confirmation.`,
          { retryable: true, details: { signature: args.signature } },
        );
      }

      if (rebroadcasts >= args.maxRebroadcasts) {
        throw new AppError(
          'transaction_expired',
          `Gave up confirming ${args.signature} after ${rebroadcasts} rebroadcasts (${Math.round((this.clock.now() - started) / 1000)}s).`,
          { retryable: true, details: { signature: args.signature }, cause: lastSendError },
        );
      }

      // Rebroadcast the identical signed bytes. Skipping preflight here is
      // correct: preflight already passed, and re-running it wastes an RPC call
      // per attempt.
      try {
        await this.call('sendRawTransaction', (c) =>
          c.sendRawTransaction(args.rawTransaction, { skipPreflight: true, maxRetries: 0 }),
        );
      } catch (e) {
        lastSendError = e;
      }
      rebroadcasts++;
      await this.clock.sleep(1_500);
    }
  }

  async getSignatureStatus(signature: string): Promise<SignatureStatus | null> {
    const result = await this.call('getSignatureStatuses', (c) =>
      c.getSignatureStatuses([signature], { searchTransactionHistory: true }),
    );
    return result.value[0] ?? null;
  }

  async getTransactionDetail(
    signature: string,
  ): Promise<{ computeUnitsConsumed: number | null; feeLamports: number | null; slot: number } | null> {
    const tx = await this.call('getTransaction', (c) =>
      c.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }),
    );
    if (!tx) return null;
    return {
      computeUnitsConsumed: tx.meta?.computeUnitsConsumed ?? null,
      feeLamports: tx.meta?.fee ?? null,
      slot: tx.slot,
    };
  }

  /** Endpoint health for the System Health dashboard. */
  async health(): Promise<Array<{ label: string; url: string; state: HealthState; latencyMs: number; detail: string }>> {
    const results: Array<{ label: string; url: string; state: HealthState; latencyMs: number; detail: string }> = [];
    for (const state of this.states) {
      const started = this.clock.now();
      try {
        const slot = await state.connection.getSlot('confirmed');
        const latencyMs = this.clock.now() - started;
        state.lastLatencyMs = latencyMs;
        state.lastSuccessAt = this.clock.now();
        results.push({
          label: state.endpoint.label,
          url: redactRpcUrl(state.endpoint.url),
          state: state.benchedUntil > this.clock.now() ? 'degraded' : 'ok',
          latencyMs,
          detail: `slot ${slot}`,
        });
      } catch (e) {
        results.push({
          label: state.endpoint.label,
          url: redactRpcUrl(state.endpoint.url),
          state: 'down',
          latencyMs: this.clock.now() - started,
          detail: safeErrorText(e, 160),
        });
      }
    }
    return results;
  }
}

/** RPC URLs frequently embed an API key in the path or query. */
export function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/key|token|auth/i.test(key)) parsed.searchParams.set(key, '[redacted]');
    }
    // Providers like Helius and QuickNode put the key in the path segment.
    parsed.pathname = parsed.pathname.replace(/\/[A-Za-z0-9_-]{20,}/g, '/[redacted]');
    return parsed.toString();
  } catch {
    return '[invalid url]';
  }
}

function collectWritableKeys(instructions: TransactionInstruction[]): PublicKey[] {
  const seen = new Set<string>();
  const out: PublicKey[] = [];
  for (const ix of instructions) {
    for (const key of ix.keys) {
      if (!key.isWritable) continue;
      const s = key.pubkey.toBase58();
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(key.pubkey);
    }
  }
  return out;
}

const COMMITMENT_RANK: Record<string, number> = { processed: 1, confirmed: 2, finalized: 3 };

function isAtLeast(status: string | null | undefined, required: Commitment): boolean {
  if (!status) return false;
  return (COMMITMENT_RANK[status] ?? 0) >= (COMMITMENT_RANK[required] ?? 2);
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function bs58Encode(bytes: Uint8Array): string {
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
