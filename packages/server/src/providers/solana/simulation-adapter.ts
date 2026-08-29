import { Keypair } from '@solana/web3.js';
import { createRng, hashSeed, type ExecutionNetwork } from '@solcoin/shared';
import { createHash, hkdfSync } from 'node:crypto';
import { componentLogger } from '../../core/logger.js';
import type {
  AccruedFees,
  FeeClaimPlan,
  LaunchAdapter,
  LaunchPlan,
  LaunchReceipt,
  LaunchRequest,
} from './launch-adapter.js';

/**
 * Simulation adapter — paper launches that broadcast nothing.
 *
 * This exists so the entire pipeline (discovery, generation, gating, launch
 * queueing, monitoring, fee accounting, learning) can be exercised end to end
 * before any real funds are at risk, and so the platform has a safe default on
 * a fresh install.
 *
 * Two honesty rules govern everything here:
 *  1. Every artefact it produces is stamped `simulated: true` and lives on the
 *     `simulation` network. The API and dashboard surface that prominently;
 *     simulated numbers are never mixed into real revenue reporting.
 *  2. The synthetic market is driven by a seeded RNG over a heavy-tailed model
 *     that mirrors observed launch outcomes — most tokens get nothing, a few
 *     get real volume. It is deliberately *not* flattering: a simulation that
 *     makes every launch look profitable would be worse than useless, because
 *     it would validate a strategy that loses money.
 */

export interface SimulationAdapterOptions {
  now?: () => number;
  /** Seed prefix, so a whole simulated run can be replayed exactly. */
  seed?: string;
  /**
   * Base rate at which simulated tokens attract any organic buyer at all.
   * Set from observed market statistics where available.
   */
  firstBuyRate?: number;
}

/** The synthetic state the monitoring layer reads for a simulated token. */
export interface SimulatedTokenState {
  mint: string;
  createdAt: number;
  /** Drawn once at creation and held fixed, so the token has a consistent fate. */
  destiny: {
    getsFirstBuy: boolean;
    /** Peak 24h volume in SOL if it gets traction. */
    peakVolume24hSol: number;
    lifespanHours: number;
    graduates: boolean;
    peakHolders: number;
  };
}

export class SimulationLaunchAdapter implements LaunchAdapter {
  readonly id = 'simulation';
  readonly label = 'Simulation (no transactions broadcast)';
  readonly networks: ExecutionNetwork[] = ['simulation'];

  private readonly log = componentLogger('simulation-adapter');
  private readonly now: () => number;
  private readonly seed: string;
  private readonly firstBuyRate: number;
  private readonly states = new Map<string, SimulatedTokenState>();
  /** Simulated fee vaults, in lamports, keyed by creator address. */
  private readonly vaults = new Map<string, { curve: number; amm: number }>();

  constructor(options: SimulationAdapterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.seed = options.seed ?? 'solcoin-simulation';
    this.firstBuyRate = options.firstBuyRate ?? 0.42;
  }

  async ready(): Promise<{ ready: boolean }> {
    return { ready: true };
  }

  async prepare(request: LaunchRequest, _payer: string): Promise<LaunchPlan> {
    // Derive the same way the real adapter does, so a plan reviewed in
    // simulation has the same shape as one reviewed on mainnet.
    const seedBytes = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(this.seed, 'utf8'),
        createHash('sha256').update(request.idempotencyKey).digest(),
        Buffer.from('solcoin/sim-mint/v1', 'utf8'),
        32,
      ),
    );
    const mintKeypair = Keypair.fromSeed(new Uint8Array(seedBytes));

    const costBreakdown = [
      { label: 'Token-2022 mint rent (simulated)', lamports: 3_700_000 },
      { label: 'Bonding curve account rent (simulated)', lamports: 1_800_000 },
      { label: 'Base transaction fee (simulated)', lamports: 10_000 },
    ];
    if (request.devBuyLamports > 0) {
      costBreakdown.push({ label: 'Developer buy (simulated)', lamports: request.devBuyLamports });
      costBreakdown.push({ label: 'Associated token account rent (simulated)', lamports: 2_074_080 });
    }

    return {
      summary: `SIMULATED launch of ${request.symbol} (${request.name}). No transaction will be broadcast.`,
      mintAddress: mintKeypair.publicKey.toBase58(),
      mintKeypair,
      instructions: [],
      estimatedCostLamports: costBreakdown.reduce((a, c) => a + c.lamports, 0),
      costBreakdown,
      adapter: this.id,
    };
  }

  async execute(plan: LaunchPlan, _payer: Keypair): Promise<LaunchReceipt> {
    const createdAt = this.now();
    const rng = createRng(hashSeed(`${this.seed}:${plan.mintAddress}`));

    // Draw the token's fate once. Volume is log-normal with a heavy tail, which
    // is what the real distribution looks like: the median launch earns almost
    // nothing and a small minority carries the whole return.
    const getsFirstBuy = rng.next() < this.firstBuyRate;
    const peakVolume24hSol = getsFirstBuy ? Math.expm1(Math.log1p(3) + 2.3 * rng.normal()) : 0;
    const lifespanHours = getsFirstBuy ? Math.max(0.5, Math.expm1(Math.log1p(30) + 1.3 * rng.normal())) : 0.5;
    const graduates = getsFirstBuy && peakVolume24hSol > 300 && rng.next() < 0.35;
    const peakHolders = getsFirstBuy ? Math.max(1, Math.round(Math.expm1(Math.log1p(6) + 1.8 * rng.normal()))) : 0;

    this.states.set(plan.mintAddress, {
      mint: plan.mintAddress,
      createdAt,
      destiny: { getsFirstBuy, peakVolume24hSol, lifespanHours, graduates, peakHolders },
    });

    this.log.info(
      { mint: plan.mintAddress, getsFirstBuy, peakVolume24hSol: Number(peakVolume24hSol.toFixed(2)) },
      'simulated launch recorded',
    );

    return {
      mintAddress: plan.mintAddress,
      signature: `SIMULATED-${plan.mintAddress.slice(0, 24)}`,
      slot: 0,
      network: 'simulation',
      actualCostLamports: plan.estimatedCostLamports,
      networkFeeLamports: 10_000,
      confirmedAt: createdAt,
      adapter: this.id,
      simulated: true,
    };
  }

  /**
   * Current synthetic market state for a token.
   *
   * Volume follows a rise-and-decay profile: a burst in the first hours, then
   * exponential decay over the token's drawn lifespan.
   */
  getSimulatedMarket(mint: string, atMs = this.now()): {
    exists: boolean;
    ageHours: number;
    volume24hSol: number;
    volume1hSol: number;
    cumulativeVolumeSol: number;
    holders: number;
    marketCapUsd: number;
    graduated: boolean;
    firstTradeAt: number | null;
  } {
    const state = this.states.get(mint);
    if (!state) {
      return {
        exists: false,
        ageHours: 0,
        volume24hSol: 0,
        volume1hSol: 0,
        cumulativeVolumeSol: 0,
        holders: 0,
        marketCapUsd: 0,
        graduated: false,
        firstTradeAt: null,
      };
    }
    const ageHours = Math.max(0, (atMs - state.createdAt) / 3_600_000);
    const { destiny } = state;

    if (!destiny.getsFirstBuy) {
      return {
        exists: true,
        ageHours,
        volume24hSol: 0,
        volume1hSol: 0,
        cumulativeVolumeSol: 0,
        holders: 0,
        marketCapUsd: 0,
        graduated: false,
        firstTradeAt: null,
      };
    }

    // Ramp up over the first hour, then decay with the drawn lifespan.
    const ramp = Math.min(1, ageHours / 1);
    const decay = Math.exp(-ageHours / Math.max(1, destiny.lifespanHours));
    const intensity = ramp * decay;

    const volume24hSol = destiny.peakVolume24hSol * intensity;
    const volume1hSol = volume24hSol * 0.22;
    // Integral of the decay profile, in SOL.
    const cumulativeVolumeSol =
      destiny.peakVolume24hSol * Math.max(1, destiny.lifespanHours) * (1 - Math.exp(-ageHours / Math.max(1, destiny.lifespanHours))) / 24;
    const holders = Math.round(destiny.peakHolders * Math.min(1, ageHours / 6) * Math.max(0.3, decay));

    return {
      exists: true,
      ageHours,
      volume24hSol,
      volume1hSol,
      cumulativeVolumeSol,
      holders,
      // Rough market cap proxy; simulated figures are labelled as such everywhere.
      marketCapUsd: cumulativeVolumeSol * 120 * (destiny.graduates ? 4 : 1),
      graduated: destiny.graduates && ageHours > 6,
      firstTradeAt: state.createdAt + 60_000,
    };
  }

  /** Accrue simulated creator fees from simulated volume. */
  accrueFees(mint: string, creator: string, curveFeeRate: number, ammFeeRate: number, atMs = this.now()): void {
    const market = this.getSimulatedMarket(mint, atMs);
    if (!market.exists) return;
    const vault = this.vaults.get(creator) ?? { curve: 0, amm: 0 };
    const curveFeesSol = market.cumulativeVolumeSol * curveFeeRate;
    const ammFeesSol = market.graduated ? market.cumulativeVolumeSol * 2 * ammFeeRate : 0;
    // Vaults hold cumulative accrual; the claim resets them.
    vault.curve = Math.round(curveFeesSol * 1e9);
    vault.amm = Math.round(ammFeesSol * 1e9);
    this.vaults.set(creator, vault);
  }

  async getAccruedFees(creator: string): Promise<AccruedFees> {
    const vault = this.vaults.get(creator) ?? { curve: 0, amm: 0 };
    // Mirror the real stranded-rent behaviour so fee-collection economics are
    // exercised honestly in simulation.
    const rent = 890_880;
    const curveVaultLamports = vault.curve > 0 ? vault.curve + rent : 0;
    return {
      creator,
      curveVaultLamports,
      curveClaimableLamports: vault.curve,
      ammVaultLamports: vault.amm,
      totalClaimableLamports: vault.curve + vault.amm,
      curveVaultAddress: `SIM-curve-${creator.slice(0, 8)}`,
      ammVaultAddress: `SIM-amm-${creator.slice(0, 8)}`,
      observedAt: this.now(),
      source: 'simulation',
    };
  }

  async prepareFeeClaim(creator: string): Promise<FeeClaimPlan | null> {
    const accrued = await this.getAccruedFees(creator);
    if (accrued.totalClaimableLamports <= 0) return null;
    return {
      instructions: [],
      claimableLamports: accrued.totalClaimableLamports,
      estimatedCostLamports: 5_000,
      includesCurve: accrued.curveClaimableLamports > 0,
      includesAmm: accrued.ammVaultLamports > 0,
      summary: `SIMULATED sweep of ${(accrued.totalClaimableLamports / 1e9).toFixed(6)} SOL`,
    };
  }

  async executeFeeClaim(
    plan: FeeClaimPlan,
    payer: Keypair,
  ): Promise<{ signature: string; slot: number; claimedLamports: number; networkFeeLamports: number; simulated: boolean }> {
    const creator = payer.publicKey.toBase58();
    this.vaults.set(creator, { curve: 0, amm: 0 });
    return {
      signature: `SIMULATED-CLAIM-${creator.slice(0, 20)}-${this.now()}`,
      slot: 0,
      claimedLamports: plan.claimableLamports,
      networkFeeLamports: 5_000,
      simulated: true,
    };
  }

  /** Register a token created outside this process (e.g. loaded from the database). */
  restore(state: SimulatedTokenState): void {
    this.states.set(state.mint, state);
  }

  snapshot(): SimulatedTokenState[] {
    return [...this.states.values()];
  }

  /** A deterministic simulated wallet, so simulation never touches a real key. */
  static simulatedWallet(seed = 'solcoin-sim-wallet'): { keypair: Keypair; address: string } {
    const bytes = createHash('sha256').update(seed).digest();
    const keypair = Keypair.fromSeed(new Uint8Array(bytes));
    return { keypair, address: keypair.publicKey.toBase58() };
  }
}

/** Type guard used by services that need the simulated market model. */
export function isSimulationAdapter(adapter: LaunchAdapter): adapter is SimulationLaunchAdapter {
  return adapter.id === 'simulation';
}
