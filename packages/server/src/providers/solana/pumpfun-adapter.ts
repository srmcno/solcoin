import { createHash, hkdfSync } from 'node:crypto';
import { Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import BN from 'bn.js';
import {
  CURVE_VAULT_RENT_LAMPORTS,
  claimableCurveLamports,
  estimateClaimCostLamports,
  type ExecutionNetwork,
} from '@solcoin/shared';
import { AppError, safeErrorText } from '../../core/errors.js';
import { componentLogger } from '../../core/logger.js';
import type { SolanaRpc } from './rpc.js';
import type {
  AccruedFees,
  FeeClaimPlan,
  LaunchAdapter,
  LaunchPlan,
  LaunchReceipt,
  LaunchRequest,
} from './launch-adapter.js';

/**
 * Pump.fun launch adapter, built directly on the official on-chain SDK.
 *
 * Why direct rather than a relay API: a relay charges 0.5–1% of the developer
 * buy for what is, underneath, an instruction builder; it adds a third-party
 * availability dependency to the single most consequential operation the
 * platform performs; and no relay supports devnet, which is where the entire
 * launch path should be exercised before real funds are involved. The official
 * SDK has none of those problems and the programs are deployed on devnet at
 * identical addresses.
 *
 * The instruction used is `create_v2`, which is the current path — it mints via
 * Token-2022 with metadata as a mint extension rather than a separate Metaplex
 * account. The older `create` is deprecated in the SDK.
 */

/** Salt for deterministic mint derivation; changing it changes every derived mint. */
const MINT_DERIVATION_INFO = 'solcoin/mint/v1';

/**
 * The pump.fun SDK is loaded lazily, on first on-chain use.
 *
 * Two reasons, both practical. It pulls in the Anchor runtime and several
 * hundred kilobytes of IDL, none of which simulation mode needs, so a fresh
 * install boots without paying for it. And its dependency chain contains
 * CommonJS packages imported with named bindings, which some ESM toolchains
 * cannot resolve statically — deferring the import keeps that problem confined
 * to the code path that actually needs the SDK rather than breaking startup.
 */
type PumpSdkModule = typeof import('@pump-fun/pump-sdk');
let sdkModule: Promise<PumpSdkModule> | null = null;

function loadPumpSdk(): Promise<PumpSdkModule> {
  sdkModule ??= import('@pump-fun/pump-sdk');
  return sdkModule;
}

export interface PumpFunAdapterOptions {
  rpc: SolanaRpc;
  network: ExecutionNetwork;
  /**
   * Secret used to derive mint keypairs deterministically from idempotency keys.
   * Must be stable for the life of the deployment and must be kept secret: with
   * it, an attacker could predict and front-run a mint address.
   */
  mintDerivationSecret: string;
  /** Injected for testability. */
  now?: () => number;
}

export class PumpFunLaunchAdapter implements LaunchAdapter {
  readonly id = 'pumpfun_sdk';
  readonly label = 'Pump.fun (on-chain SDK)';

  /**
   * The one network this instance can actually reach.
   *
   * The program is deployed at the same addresses on devnet and mainnet, so it
   * is tempting to declare both. That would be a lie about *this* object: its
   * RPC connection was fixed when it was constructed. Declaring both let
   * `adapterFor(network)` hand back an adapter still pointed at the old chain
   * after an operator switched networks, so a launch recorded as devnet would
   * broadcast to mainnet and spend real SOL. Naming only the bound network
   * makes that mismatch a refusal instead.
   */
  readonly networks: ExecutionNetwork[];

  private readonly log = componentLogger('pumpfun-adapter');
  private offline: InstanceType<PumpSdkModule['PumpSdk']> | null = null;
  private online: InstanceType<PumpSdkModule['OnlinePumpSdk']> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: PumpFunAdapterOptions) {
    this.now = options.now ?? Date.now;
    this.networks = [options.network];
    if (!options.mintDerivationSecret || options.mintDerivationSecret.length < 16) {
      throw new AppError('not_configured', 'A mint derivation secret of at least 16 characters is required.');
    }
  }

  /** Built lazily so the adapter can be constructed before RPC is reachable. */
  private async sdk(): Promise<InstanceType<PumpSdkModule['OnlinePumpSdk']>> {
    if (!this.online) {
      const { OnlinePumpSdk } = await loadPumpSdk();
      this.online = new OnlinePumpSdk(this.options.rpc.connection);
    }
    return this.online;
  }

  private async offlineSdk(): Promise<InstanceType<PumpSdkModule['PumpSdk']>> {
    if (!this.offline) {
      const { PumpSdk } = await loadPumpSdk();
      this.offline = new PumpSdk();
    }
    return this.offline;
  }

  async ready(): Promise<{ ready: boolean; reason?: string }> {
    try {
      const global = await (await this.sdk()).fetchGlobal();
      if (!global) return { ready: false, reason: 'The pump.fun global config account could not be read.' };
      return { ready: true };
    } catch (e) {
      return { ready: false, reason: `Cannot reach the pump.fun program: ${safeErrorText(e, 160)}` };
    }
  }

  /**
   * Derive the mint keypair deterministically from the idempotency key.
   *
   * This is the platform's strongest duplicate-launch defence. If a job crashes
   * after broadcasting but before recording the result, the retry derives the
   * *same* mint address, so the second create transaction fails with "account
   * already in use" instead of minting a second token. A random keypair per
   * attempt would silently produce duplicates.
   */
  deriveMintKeypair(idempotencyKey: string): Keypair {
    const seed = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(this.options.mintDerivationSecret, 'utf8'),
        createHash('sha256').update(idempotencyKey).digest(),
        Buffer.from(MINT_DERIVATION_INFO, 'utf8'),
        32,
      ),
    );
    return Keypair.fromSeed(new Uint8Array(seed));
  }

  async prepare(request: LaunchRequest, payer: string): Promise<LaunchPlan> {
    const payerKey = new PublicKey(payer);
    const mintKeypair = this.deriveMintKeypair(request.idempotencyKey);
    const mint = mintKeypair.publicKey;

    // If the mint already exists, a previous attempt already landed. Surface
    // that as a conflict so the caller can reconcile rather than retrying.
    const existing = await this.options.rpc.getAccountInfo(mint);
    if (existing) {
      throw new AppError(
        'conflict',
        `Mint ${mint.toBase58()} already exists on chain — a previous attempt for this idempotency key succeeded.`,
        { details: { mint: mint.toBase58() }, retryable: false },
      );
    }

    const global = await (await this.sdk()).fetchGlobal();
    const instructions: TransactionInstruction[] = [];

    if (request.devBuyLamports > 0) {
      const { getBuyTokenAmountFromSolAmount, newBondingCurve } = await loadPumpSdk();
      const feeConfig = await (await this.sdk()).fetchFeeConfig();
      const solAmount = new BN(request.devBuyLamports);
      // Compute the token amount the buy should yield at the curve's opening
      // price, then let slippage protect the actual execution.
      // The curve does not exist yet, so price against a freshly-initialised
      // curve derived from the live global config. Devnet and mainnet differ
      // here (1 SOL vs 30 SOL of initial virtual reserves), which is exactly
      // why this is read from chain rather than hardcoded.
      const tokenAmount = getBuyTokenAmountFromSolAmount({
        global,
        feeConfig,
        mintSupply: null,
        bondingCurve: newBondingCurve(global, NATIVE_MINT),
        amount: solAmount,
        quoteMint: NATIVE_MINT,
      });
      const built = await (await this.offlineSdk()).createV2AndBuyInstructions({
        global,
        mint,
        name: request.name,
        symbol: request.symbol,
        uri: request.metadataUri,
        creator: payerKey,
        user: payerKey,
        amount: tokenAmount,
        solAmount,
        mayhemMode: false,
        /*
         * `cashback: false` makes this a Creator Fee coin, and it is the single
         * most consequential argument in this call.
         *
         * Pump.fun's Cashback Coins, introduced 2026-02-17, redirect the entire
         * 0.30% creator leg of every bonding-curve trade to the traders' volume
         * accumulators instead of the creator vault. The choice is made at
         * creation and is locked permanently: a coin launched in cashback mode
         * earns its creator nothing on the curve, ever, and no later setting
         * can change it.
         *
         * The SDK currently defaults this to false, so omitting it happens to
         * do the right thing today. That is not a basis for leaving it out. A
         * default that flips in a dependency upgrade would silently turn every
         * future launch into one that cannot earn, with nothing failing and
         * nothing to see in a diff — the platform would go on reporting
         * projected fee revenue that could never arrive.
         */
        cashback: false,
      });
      instructions.push(...built);
    } else {
      instructions.push(
        await (await this.offlineSdk()).createV2Instruction({
          mint,
          name: request.name,
          symbol: request.symbol,
          uri: request.metadataUri,
          creator: payerKey,
          user: payerKey,
          mayhemMode: false,
          /*
           * `cashback: false` makes this a Creator Fee coin, and it is the single
           * most consequential argument in this call.
           *
           * Pump.fun's Cashback Coins, introduced 2026-02-17, redirect the entire
           * 0.30% creator leg of every bonding-curve trade to the traders' volume
           * accumulators instead of the creator vault. The choice is made at
           * creation and is locked permanently: a coin launched in cashback mode
           * earns its creator nothing on the curve, ever, and no later setting
           * can change it.
           *
           * The SDK currently defaults this to false, so omitting it happens to
           * do the right thing today. That is not a basis for leaving it out. A
           * default that flips in a dependency upgrade would silently turn every
           * future launch into one that cannot earn, with nothing failing and
           * nothing to see in a diff — the platform would go on reporting
           * projected fee revenue that could never arrive.
           */
          cashback: false,
        }),
      );
    }

    // Rent figures measured on chain: a Token-2022 mint with the metadata
    // extension, the bonding-curve account, and (when buying) an associated
    // token account for the payer.
    const costBreakdown: Array<{ label: string; lamports: number }> = [
      { label: 'Token-2022 mint rent', lamports: 3_700_000 },
      { label: 'Bonding curve account rent', lamports: 1_800_000 },
      { label: 'Base transaction fee', lamports: 10_000 },
    ];
    if (request.devBuyLamports > 0) {
      costBreakdown.push({ label: 'Associated token account rent', lamports: 2_074_080 });
      costBreakdown.push({ label: 'Developer buy', lamports: request.devBuyLamports });
    }
    const priorityLamports = Math.ceil((400_000 * request.priorityFeeMicroLamports) / 1_000_000);
    if (priorityLamports > 0) costBreakdown.push({ label: 'Priority fee', lamports: priorityLamports });

    const estimatedCostLamports = costBreakdown.reduce((acc, c) => acc + c.lamports, 0);

    return {
      summary: `create_v2 ${request.symbol} (${request.name}) on ${request.network}${
        request.devBuyLamports > 0 ? ` with a ${(request.devBuyLamports / 1e9).toFixed(4)} SOL developer buy` : ''
      }`,
      mintAddress: mint.toBase58(),
      mintKeypair,
      instructions,
      estimatedCostLamports,
      costBreakdown,
      adapter: this.id,
    };
  }

  async execute(
    plan: LaunchPlan,
    payer: Keypair,
    options: {
      signal?: AbortSignal;
      onSigned?: (info: { signature: string; blockhash: string; lastValidBlockHeight: number }) => Promise<void> | void;
    } = {},
  ): Promise<LaunchReceipt> {
    const balanceBefore = await this.options.rpc.getBalance(payer.publicKey);

    const result = await this.options.rpc.sendTransaction(plan.instructions, payer, {
      signers: [plan.mintKeypair],
      signal: options.signal,
      onSigned: options.onSigned,
      // create_v2 has been measured consuming 328k–368k CU, so a 320k limit —
      // which some third-party relays hardcode — is not enough. Simulation
      // determines the real number; this is the floor if simulation fails.
      computeUnitLimit: undefined,
    });

    const balanceAfter = await this.options.rpc.getBalance(payer.publicKey).catch(() => balanceBefore);
    const actualCostLamports = Math.max(0, balanceBefore - balanceAfter);

    return {
      mintAddress: plan.mintAddress,
      signature: result.signature,
      slot: result.slot,
      network: this.options.network,
      actualCostLamports: actualCostLamports || plan.estimatedCostLamports,
      networkFeeLamports: result.feeLamports ?? 10_000,
      confirmedAt: result.confirmedAt,
      adapter: this.id,
      simulated: false,
    };
  }

  /**
   * Read unclaimed creator fees.
   *
   * Fees accrue in two independent vaults with different owners and different
   * PDA seeds — `creator-vault` (hyphen) for the bonding curve, `creator_vault`
   * (underscore) for the AMM. Graduation does not move pre-graduation fees, so
   * a graduated coin has balances in both and both must be swept.
   *
   * The bonding-curve vault is a zero-byte System-owned account, so its
   * rent-exempt minimum is permanently stranded and is subtracted here. Treating
   * the raw balance as claimable is the classic mistake that produces claim
   * transactions which cost more than they recover.
   */
  async getAccruedFees(creator: string): Promise<AccruedFees> {
    const { ammCreatorVaultPda, creatorVaultPda } = await loadPumpSdk();
    const creatorKey = new PublicKey(creator);
    const curveVault = creatorVaultPda(creatorKey);
    const ammVaultAuthority = ammCreatorVaultPda(creatorKey);
    const ammVaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, ammVaultAuthority, true, TOKEN_PROGRAM_ID);

    const [curveInfo, ammInfo] = await Promise.all([
      this.options.rpc.getAccountInfo(curveVault).catch(() => null),
      this.options.rpc.getAccountInfo(ammVaultAta).catch(() => null),
    ]);

    const curveVaultLamports = curveInfo?.lamports ?? 0;
    const curveClaimableLamports = curveInfo
      ? claimableCurveLamports(curveVaultLamports, curveInfo.data.length)
      : 0;

    // A wrapped-SOL token account stores its amount as a little-endian u64 at
    // offset 64. The account's own lamports are rent, not fees.
    let ammVaultLamports = 0;
    if (ammInfo && ammInfo.data.length >= 72) {
      ammVaultLamports = Number(ammInfo.data.readBigUInt64LE(64));
    }

    return {
      creator,
      curveVaultLamports,
      curveClaimableLamports,
      ammVaultLamports,
      totalClaimableLamports: curveClaimableLamports + ammVaultLamports,
      curveVaultAddress: curveVault.toBase58(),
      ammVaultAddress: ammVaultAta.toBase58(),
      observedAt: this.now(),
      source: 'onchain',
    };
  }

  async prepareFeeClaim(creator: string): Promise<FeeClaimPlan | null> {
    const creatorKey = new PublicKey(creator);
    const accrued = await this.getAccruedFees(creator);

    const includesCurve = accrued.curveClaimableLamports > 0;
    const includesAmm = accrued.ammVaultLamports > 0;
    if (!includesCurve && !includesAmm) return null;

    // The SDK's helper emits both the bonding-curve claim and the AMM claim in
    // one instruction list, so a single transaction sweeps both vaults.
    const instructions = await (await this.sdk()).collectCoinCreatorFeeInstructions(creatorKey, creatorKey);

    const estimatedCostLamports = estimateClaimCostLamports({ includeCurve: includesCurve, includeAmm: includesAmm });

    return {
      instructions,
      claimableLamports: accrued.totalClaimableLamports,
      estimatedCostLamports,
      includesCurve,
      includesAmm,
      summary: `Sweep ${(accrued.totalClaimableLamports / 1e9).toFixed(6)} SOL of creator fees from ${
        [includesCurve ? 'the bonding-curve vault' : null, includesAmm ? 'the AMM vault' : null].filter(Boolean).join(' and ')
      }`,
    };
  }

  async executeFeeClaim(
    plan: FeeClaimPlan,
    payer: Keypair,
    options: {
      signal?: AbortSignal;
      onSigned?: (info: { signature: string; blockhash: string; lastValidBlockHeight: number }) => Promise<void> | void;
    } = {},
  ): Promise<{ signature: string; slot: number; claimedLamports: number; networkFeeLamports: number; simulated: boolean }> {
    const balanceBefore = await this.options.rpc.getBalance(payer.publicKey);
    const result = await this.options.rpc.sendTransaction(plan.instructions, payer, {
      signal: options.signal,
      onSigned: options.onSigned,
    });
    const balanceAfter = await this.options.rpc.getBalance(payer.publicKey).catch(() => balanceBefore);

    // The measured delta is the honest number: it already nets out the network
    // fee and any account rent the claim had to create.
    const claimedLamports = Math.max(0, balanceAfter - balanceBefore);

    if (claimedLamports === 0) {
      this.log.warn(
        { signature: result.signature },
        'fee claim confirmed but the wallet balance did not increase — fees may have been routed to a sharing config',
      );
    }

    return {
      signature: result.signature,
      slot: result.slot,
      claimedLamports,
      networkFeeLamports: result.feeLamports ?? 5_000,
      simulated: false,
    };
  }

  /** Minimum vault balance below which claiming can never be economic. */
  static minimumEconomicVaultLamports(): number {
    return CURVE_VAULT_RENT_LAMPORTS + 20_000;
  }
}
