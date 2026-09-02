import { CURVE_VAULT_RENT_LAMPORTS, CURVE_FEE_BPS, LAMPORTS_PER_SIGNATURE, creatorBpsFromTiers, screenRisk } from '@solcoin/shared';
import { AppError } from '../core/errors.js';

/**
 * The pure parts of the devnet rehearsal, kept apart from the command so they
 * can be tested without a chain: which network is acceptable, how much SOL a
 * run needs, what the fixture token looks like, and how a run is judged.
 */

/**
 * Genesis hashes identify a cluster regardless of what an RPC URL claims to
 * be. The rehearsal signs a purchase of its own token, which is a protocol
 * test on devnet and would be self-trading anywhere real, so the cluster is
 * checked against the chain rather than against a setting or a hostname.
 */
export const GENESIS_HASHES = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
} as const;

export function assertDevnetGenesis(genesisHash: string): void {
  if (genesisHash === GENESIS_HASHES.devnet) return;
  const which = genesisHash === GENESIS_HASHES.mainnet ? 'MAINNET' : `an unrecognised cluster (${genesisHash})`;
  throw new AppError(
    'forbidden',
    `The rehearsal only runs on devnet, and the RPC it was given is ${which}. Nothing was signed. Check the devnet RPC URL in Settings → Credentials.`,
    { retryable: false },
  );
}

export interface RehearsalFixture {
  name: string;
  symbol: string;
  description: string;
  imagePrompt: string;
}

/**
 * The token the rehearsal mints.
 *
 * Named for what it is. Its description says, on chain and in every wallet
 * that reads the metadata, that it is a devnet test with no value — because a
 * devnet token is still a token somebody could stumble on.
 */
export function rehearsalFixture(atMs: number): RehearsalFixture {
  const d = new Date(atMs);
  const stamp = `${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const fixture: RehearsalFixture = {
    name: `Solcoin Rehearsal ${stamp}`,
    symbol: 'RHRSL',
    // The launchpad is deliberately not named here: the safety screen treats
    // its name as a protected mark, and the fixture must pass that screen
    // rather than be excused from it.
    description:
      'Devnet rehearsal token minted by Solcoin (npm run rehearsal) to prove its launch and creator-fee path ' +
      'against the real launchpad program. It exists only on devnet, is not an asset, and has no value.',
    imagePrompt: 'A plain geometric calibration mark on a dark background.',
  };
  // The fixture goes through the same safety screen a generated concept does.
  // If the screen ever rejects it, the rehearsal must not quietly route around
  // the screen: it fails here, loudly.
  const risk = screenRisk(fixture.name, fixture.symbol, fixture.description);
  if (risk.blocked) {
    throw new AppError('internal', `The rehearsal fixture failed safety screening: ${risk.flags.map((f) => f.label).join('; ')}`);
  }
  return fixture;
}

/**
 * Creator fee a curve buy of `buyLamports` deposits in the creator vault.
 * The bonding-curve creator leg is 0.30% of the SOL side on mainnet; the
 * live figure is read from the program and passed in.
 */
export function expectedCreatorFeeLamports(buyLamports: number, creatorFeeBps: number = CURVE_FEE_BPS.creator): number {
  return Math.floor((buyLamports * creatorFeeBps) / 10_000);
}

/**
 * The smallest test buy that leaves a claimable balance behind.
 *
 * The curve vault keeps its rent-exempt minimum forever, so the first
 * 890,880 lamports of fees can never be withdrawn. A buy that deposits less
 * than that proves nothing about claiming: the vault fills, and the claim
 * step correctly refuses because there is nothing claimable. The default adds
 * enough headroom that the claim also clears the value-ratio check.
 *
 * The fee rate is a parameter, not the mainnet constant, because devnet's
 * program is configured differently — its creator leg has been observed at
 * 5 bps against mainnet's 30 — and a buy sized for mainnet leaves a devnet
 * vault below its rent floor with nothing to claim.
 */
export function minimumBuyLamportsForClaim(options: { claimableHeadroomLamports?: number; creatorFeeBps?: number } = {}): number {
  const headroom = options.claimableHeadroomLamports ?? 100_000;
  const bps = options.creatorFeeBps ?? CURVE_FEE_BPS.creator;
  return Math.ceil(((CURVE_VAULT_RENT_LAMPORTS + headroom) * 10_000) / bps);
}

/**
 * What the operating wallet must hold before the run starts.
 *
 * The launch gate applies the balance floor, so the floor is a requirement
 * and not a leftover; the launch reserve is what the guard counts against
 * the caps; the buy is spent outright; and the allowance covers the buyer's
 * token account rent, the claim's signature and a little priority fee.
 */
export function requiredFundingLamports(input: {
  floorLamports: number;
  launchReserveLamports: number;
  buyLamports: number;
}): number {
  const allowance = 2_074_080 + 20 * LAMPORTS_PER_SIGNATURE + 2_000_000;
  return input.floorLamports + input.launchReserveLamports + Math.max(0, input.buyLamports) + allowance;
}

/**
 * The creator fee a fresh curve pays on this cluster, in basis points.
 *
 * Mirrors the program: when a fee-config account exists its tier table
 * governs, selected by the curve's market cap (a new curve sits at its
 * opening market cap); otherwise the global account's flat rate applies.
 * `creatorBpsFromTiers` implements the same selection the SDK does — the
 * highest tier at or below the market cap, else the first.
 */
export function liveCreatorFeeBps(input: {
  globalCreatorFeeBps: number;
  feeTiers: ReadonlyArray<{ marketCapLamportsThreshold: number; creatorBps: number }> | null;
  openingMarketCapLamports: number;
}): number {
  if (input.feeTiers && input.feeTiers.length > 0) {
    return creatorBpsFromTiers(
      input.feeTiers.map((t) => ({ marketCapLamportsThreshold: t.marketCapLamportsThreshold, creatorBps: t.creatorBps, lpBps: 0, protocolBps: 0 })),
      input.openingMarketCapLamports,
    );
  }
  return input.globalCreatorFeeBps;
}

export function explorerUrl(kind: 'tx' | 'address' | 'token', value: string, network: 'devnet' | 'mainnet'): string {
  const cluster = network === 'devnet' ? '?cluster=devnet' : '';
  return `https://solscan.io/${kind}/${value}${cluster}`;
}

export type StepStatus = 'passed' | 'failed' | 'skipped' | 'blocked';

export interface RehearsalStep {
  step: string;
  status: StepStatus;
  detail: string;
  signature?: string;
  url?: string;
  data?: Record<string, unknown>;
}

/**
 * Judge a run.
 *
 * Exit codes are distinct on purpose: a run that could not start for want of
 * devnet SOL is not a failure of the platform, and a script that treats it as
 * one sends the operator looking for the wrong problem.
 */
export function rehearsalVerdict(steps: readonly RehearsalStep[]): { ok: boolean; exitCode: 0 | 1 | 3; summary: string } {
  const failed = steps.filter((s) => s.status === 'failed');
  const blocked = steps.filter((s) => s.status === 'blocked');
  const passed = steps.filter((s) => s.status === 'passed').length;
  if (failed.length > 0) {
    return { ok: false, exitCode: 1, summary: `${failed.length} step${failed.length === 1 ? '' : 's'} failed: ${failed.map((s) => s.step).join(', ')}.` };
  }
  if (blocked.length > 0) {
    return { ok: false, exitCode: 3, summary: `Blocked before completion: ${blocked.map((s) => `${s.step} (${s.detail})`).join('; ')}.` };
  }
  return { ok: true, exitCode: 0, summary: `${passed} step${passed === 1 ? '' : 's'} passed against the real Pump.fun program on devnet.` };
}

/** Parse the handful of flags the command accepts. */
export function parseRehearsalArgs(argv: readonly string[]): {
  /** Null when not given: the command sizes the buy from the live fee rate. */
  buySol: number | null;
  skipBuy: boolean;
  skipClaim: boolean;
  enterDevnet: boolean;
  json: boolean;
  help: boolean;
} {
  const out: ReturnType<typeof parseRehearsalArgs> = {
    buySol: null,
    skipBuy: false,
    skipClaim: false,
    enterDevnet: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    switch (flag) {
      case '--buy-sol': {
        const raw = inline ?? argv[++i];
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) {
          throw new AppError('validation_failed', `--buy-sol needs a non-negative number of SOL, got "${raw ?? ''}".`);
        }
        out.buySol = value;
        break;
      }
      case '--skip-buy':
        out.skipBuy = true;
        break;
      case '--skip-claim':
        out.skipClaim = true;
        break;
      case '--enter-devnet':
        out.enterDevnet = true;
        break;
      case '--json':
        out.json = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        throw new AppError('validation_failed', `Unknown option "${arg}". Run with --help.`);
    }
  }
  return out;
}
