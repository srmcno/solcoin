export const LAMPORTS_PER_SOL = 1_000_000_000;

export function solToLamports(sol: number): number {
  return Math.round(sol * LAMPORTS_PER_SOL);
}

export function lamportsToSol(lamports: number | bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

/** Formatting helpers shared by the API and the dashboard. */
export function formatSol(lamportsOrSol: number, opts: { fromLamports?: boolean; digits?: number } = {}): string {
  const sol = opts.fromLamports ? lamportsToSol(lamportsOrSol) : lamportsOrSol;
  const digits = opts.digits ?? (Math.abs(sol) >= 1 ? 3 : 5);
  return `${sol.toFixed(digits)} SOL`;
}

export function formatUsd(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : 4;
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatCompact(value: number): string {
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** Well-known Solana program addresses used across the execution layer. */
export const SOLANA_PROGRAMS = {
  systemProgram: '11111111111111111111111111111111',
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022Program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  associatedTokenProgram: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  computeBudgetProgram: 'ComputeBudget111111111111111111111111111111',
  memoProgram: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  wrappedSol: 'So11111111111111111111111111111111111111112',
} as const;

/** Sensible ceilings so a runaway loop cannot produce absurd requests. */
export const HARD_LIMITS = {
  maxLaunchesPerDayAbsolute: 24,
  maxSolPerTransactionAbsolute: 2,
  maxSolPerDayAbsolute: 5,
  maxAiSpendUsdPerDayAbsolute: 200,
  maxConceptsPerCycle: 40,
  maxTrendsPerDiscovery: 500,
} as const;

export const TIME = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
} as const;
