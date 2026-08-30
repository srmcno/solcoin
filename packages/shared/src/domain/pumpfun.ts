/**
 * Pump.fun protocol constants and the creator-fee economic model.
 *
 * IMPORTANT: fee parameters are protocol state, not constants. The authoritative
 * source is the on-chain `FeeConfig` account owned by the Pump Fees program.
 *
 * These values are a verified snapshot of it, and they are what the platform
 * actually uses for every economic estimate: the opportunity model, the
 * prediction bundle, and the fee projections shown on the dashboard all read
 * the constants below rather than the chain.
 *
 * The one place a live read happens is `PumpFunLaunchAdapter.prepare`, which
 * calls the SDK's `fetchFeeConfig()` to price a developer buy against the
 * curve's opening price — because devnet and mainnet differ there and a
 * hardcoded figure would misprice the buy.
 *
 * The consequence, stated so it is not discovered the expensive way: if
 * Pump.fun changes its fee schedule, the platform's revenue estimates go stale
 * silently. `creatorBpsFromTiers` and `LiveFeeConfig` below exist to consume a
 * live read and are deliberately left in place for that work, but nothing calls
 * them yet.
 *
 * Snapshot verified: 2026-08-29, by decoding the live FeeConfig accounts.
 */

export const PUMP_PROGRAM_IDS = {
  /** Pump bonding-curve program. */
  pump: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  /** PumpSwap AMM (post-graduation pools). */
  pumpAmm: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  /** Pump Fees program, which owns the FeeConfig accounts. */
  pumpFees: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
} as const;

/** PDA seeds. The two creator vaults use *different* seed strings — a classic footgun. */
export const PUMP_PDA_SEEDS = {
  /** Bonding-curve creator vault: hyphen. */
  creatorVaultCurve: 'creator-vault',
  /** AMM coin-creator vault authority: underscore. */
  creatorVaultAmm: 'creator_vault',
  feeConfig: 'fee_config',
  bondingCurve: 'bonding-curve',
  global: 'global',
  mintAuthority: 'mint-authority',
  metadata: 'metadata',
} as const;

/** Anchor instruction discriminators, from the published IDLs. */
export const PUMP_DISCRIMINATORS = {
  /** Current bonding-curve creator-fee claim (supports non-SOL quote mints). */
  collectCreatorFeeV2: [207, 17, 138, 242, 4, 34, 19, 56],
  /** Legacy SOL-only claim, retained for older vaults. */
  collectCreatorFeeLegacy: [20, 22, 86, 123, 198, 28, 219, 132],
  /** PumpSwap AMM coin-creator fee claim. */
  collectCoinCreatorFee: [160, 57, 89, 42, 181, 139, 43, 66],
} as const;

/**
 * Bonding-curve fee split, in basis points of trade volume.
 * Verified: lp=0, protocol=95, creator=30 which is 1.25% total, creator keeps 0.30%.
 */
export const CURVE_FEE_BPS = { lp: 0, protocol: 95, creator: 30 } as const;

/** Non-canonical AMM pools (e.g. a Raydium migration) pay the creator nothing. */
export const NON_CANONICAL_AMM_FEE_BPS = { lp: 25, protocol: 5, creator: 0 } as const;

/**
 * Canonical PumpSwap pools use market-cap-indexed dynamic fee tiers: the creator
 * share starts high to reward early traction and decays as the coin grows.
 *
 * This is a *monotone interpolation* of the verified curve endpoints, not the
 * exact 25-tier table. It is used only when the live FeeConfig cannot be read,
 * and any figure derived from it is surfaced in the UI as an estimate.
 */
export const AMM_CREATOR_FEE_CURVE_ANCHORS: ReadonlyArray<{ marketCapSol: number; creatorBps: number }> = [
  { marketCapSol: 0, creatorBps: 30 },
  { marketCapSol: 420, creatorBps: 95 },
  { marketCapSol: 1_000, creatorBps: 88 },
  { marketCapSol: 2_500, creatorBps: 76 },
  { marketCapSol: 6_000, creatorBps: 60 },
  { marketCapSol: 12_000, creatorBps: 44 },
  { marketCapSol: 25_000, creatorBps: 30 },
  { marketCapSol: 50_000, creatorBps: 16 },
  { marketCapSol: 98_240, creatorBps: 5 },
];

/** Interpolate the fallback creator-fee curve at a given market cap. */
export function estimateAmmCreatorFeeBps(marketCapSol: number): number {
  const mc = Math.max(0, marketCapSol);
  const anchors = AMM_CREATOR_FEE_CURVE_ANCHORS;
  const last = anchors[anchors.length - 1]!;
  if (mc >= last.marketCapSol) return last.creatorBps;
  for (let i = 1; i < anchors.length; i++) {
    const lo = anchors[i - 1]!;
    const hi = anchors[i]!;
    if (mc <= hi.marketCapSol) {
      const span = hi.marketCapSol - lo.marketCapSol;
      if (span <= 0) return hi.creatorBps;
      const t = (mc - lo.marketCapSol) / span;
      return lo.creatorBps + t * (hi.creatorBps - lo.creatorBps);
    }
  }
  return last.creatorBps;
}

/** Fee tiers as read from chain, when available. */
export interface FeeTier {
  /** Lower bound of the tier, in lamports of market cap. */
  marketCapLamportsThreshold: number;
  lpBps: number;
  protocolBps: number;
  creatorBps: number;
}

export interface LiveFeeConfig {
  /** Which pool type these tiers describe. */
  scope: 'curve' | 'amm_canonical' | 'amm_non_canonical';
  tiers: FeeTier[];
  /** When this snapshot was read, in unix ms. Zero means "fallback constant". */
  fetchedAt: number;
  source: 'onchain' | 'fallback';
}

export function creatorBpsFromTiers(tiers: readonly FeeTier[], marketCapLamports: number): number {
  let best = tiers[0]?.creatorBps ?? 0;
  for (const tier of tiers) {
    if (marketCapLamports >= tier.marketCapLamportsThreshold) best = tier.creatorBps;
  }
  return best;
}

/**
 * Rent-exempt minimum for the 0-byte, System-owned bonding-curve creator vault.
 * This balance is permanently stranded: a vault holding less than this plus the
 * transaction fee is not worth claiming, ever.
 */
export const CURVE_VAULT_RENT_LAMPORTS = 890_880;

/** Base transaction fee per signature. */
export const LAMPORTS_PER_SIGNATURE = 5_000;

/** Measured compute usage for the claim instructions, used for fee estimation. */
export const CLAIM_COMPUTE_UNITS = {
  collectCreatorFeeV2: 30_000,
  collectCoinCreatorFee: 8_000,
} as const;

/** Lamports of rent per byte-year, used to price non-zero-length vault accounts. */
const RENT_LAMPORTS_PER_BYTE = 6_960;

/**
 * How much of a bonding-curve vault balance can actually be claimed?
 *
 * The stranded rent means the claimable amount is always less than the vault
 * balance, and a claim that nets less than its own cost destroys value.
 */
export function claimableCurveLamports(vaultLamports: number, vaultDataLength = 0): number {
  const rent =
    vaultDataLength === 0
      ? CURVE_VAULT_RENT_LAMPORTS
      : CURVE_VAULT_RENT_LAMPORTS + vaultDataLength * RENT_LAMPORTS_PER_BYTE;
  return Math.max(0, vaultLamports - rent);
}

export function estimateClaimCostLamports(options: {
  includeCurve: boolean;
  includeAmm: boolean;
  priorityFeeMicroLamportsPerCu?: number;
}): number {
  let cu = 0;
  if (options.includeCurve) cu += CLAIM_COMPUTE_UNITS.collectCreatorFeeV2;
  if (options.includeAmm) cu += CLAIM_COMPUTE_UNITS.collectCoinCreatorFee;
  const priority = Math.ceil((cu * (options.priorityFeeMicroLamportsPerCu ?? 0)) / 1_000_000);
  return LAMPORTS_PER_SIGNATURE + priority;
}
