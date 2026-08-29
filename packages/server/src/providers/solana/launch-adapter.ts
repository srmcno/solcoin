import type { Keypair, TransactionInstruction } from '@solana/web3.js';
import type { ExecutionNetwork } from '@solcoin/shared';

/**
 * Launch execution abstraction.
 *
 * Pump.fun's on-chain interface has already changed more than once (`create`
 * was superseded by `create_v2`, which moved to Token-2022 with metadata as a
 * mint extension rather than a Metaplex account). The platform therefore never
 * talks to the protocol directly from its services: everything goes through
 * this interface, and swapping in a new protocol version, a different launchpad
 * or a third-party relay is a new adapter rather than a rewrite.
 */

export interface LaunchRequest {
  /** Idempotency key. The adapter must derive its mint deterministically from it
   *  where possible, so a retry cannot mint a second token. */
  idempotencyKey: string;
  name: string;
  symbol: string;
  description: string;
  /** Already-uploaded metadata URI. */
  metadataUri: string;
  imageUri?: string;
  /** Optional initial developer buy, in lamports. Zero means create-only. */
  devBuyLamports: number;
  slippageBps: number;
  priorityFeeMicroLamports: number;
  network: ExecutionNetwork;
}

export interface LaunchPlan {
  /** Human-readable description of exactly what will be submitted. */
  summary: string;
  mintAddress: string;
  /** The mint keypair must sign the create transaction. */
  mintKeypair: Keypair;
  instructions: TransactionInstruction[];
  /** Best estimate of total lamports the payer will spend, including rent. */
  estimatedCostLamports: number;
  /** Breakdown for the UI and the cost ledger. */
  costBreakdown: Array<{ label: string; lamports: number }>;
  adapter: string;
}

export interface LaunchReceipt {
  mintAddress: string;
  signature: string;
  slot: number;
  network: ExecutionNetwork;
  /** Actual lamports the payer spent, measured after confirmation where possible. */
  actualCostLamports: number;
  networkFeeLamports: number;
  confirmedAt: number;
  adapter: string;
  /** True when nothing was broadcast (simulation mode). */
  simulated: boolean;
}

export interface AccruedFees {
  creator: string;
  /** Bonding-curve vault balance, in lamports. */
  curveVaultLamports: number;
  /** Portion of the curve vault that can actually be withdrawn. */
  curveClaimableLamports: number;
  /** AMM coin-creator vault balance, in lamports (wSOL is 1:1 with lamports). */
  ammVaultLamports: number;
  totalClaimableLamports: number;
  curveVaultAddress?: string;
  ammVaultAddress?: string;
  observedAt: number;
  source: string;
}

export interface FeeClaimPlan {
  instructions: TransactionInstruction[];
  claimableLamports: number;
  estimatedCostLamports: number;
  includesCurve: boolean;
  includesAmm: boolean;
  summary: string;
}

export interface LaunchAdapter {
  readonly id: string;
  readonly label: string;
  /** Networks this adapter can execute against. */
  readonly networks: ExecutionNetwork[];
  /** Whether the adapter is ready to execute right now. */
  ready(): Promise<{ ready: boolean; reason?: string }>;
  /** Build everything needed for a launch without broadcasting anything. */
  prepare(request: LaunchRequest, payer: string): Promise<LaunchPlan>;
  /** Broadcast and confirm. Must be safe to call at most once per plan. */
  execute(plan: LaunchPlan, payer: Keypair, options?: {
    signal?: AbortSignal;
    onSigned?: (info: { signature: string; blockhash: string; lastValidBlockHeight: number }) => Promise<void> | void;
  }): Promise<LaunchReceipt>;
  /** Read accrued, unclaimed creator fees for a wallet. */
  getAccruedFees(creator: string): Promise<AccruedFees>;
  /** Build the instructions that sweep accrued fees to the creator. */
  prepareFeeClaim(creator: string): Promise<FeeClaimPlan | null>;
  /** Execute a prepared fee claim. */
  executeFeeClaim(plan: FeeClaimPlan, payer: Keypair, options?: { signal?: AbortSignal }): Promise<{
    signature: string;
    slot: number;
    claimedLamports: number;
    networkFeeLamports: number;
    simulated: boolean;
  }>;
}
