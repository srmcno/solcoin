import type { PlatformSettings } from '@solcoin/shared';

/**
 * Limit settings under which no launch can ever succeed.
 *
 * Pure, and separate from the command, so it can be tested against the same
 * arithmetic `GuardService` performs. The guard reserves one launch's
 * estimated cost and tests it against the per-transaction, hourly and daily
 * SOL caps, then counts the launch against the hourly and daily launch caps.
 * Any of those set below what a single launch needs means every mainnet
 * launch is refused — a state the preflight gate reported as "no blockers"
 * until this existed, sending the operator to look for the wrong problem.
 */
export function launchImpossibleReasons(limits: PlatformSettings['limits'], perLaunchSol: number): string[] {
  const reasons: string[] = [];
  const cost = perLaunchSol.toFixed(4);

  if (limits.maxLaunchesPerHour < 1) reasons.push('limits.maxLaunchesPerHour is 0');
  if (limits.maxLaunchesPerDay < 1) reasons.push('limits.maxLaunchesPerDay is 0');
  if (limits.maxSolPerTransaction < perLaunchSol) {
    reasons.push(`limits.maxSolPerTransaction (${limits.maxSolPerTransaction}) is below the ${cost} SOL one launch reserves`);
  }
  if (limits.maxSolPerHour < perLaunchSol) {
    reasons.push(`limits.maxSolPerHour (${limits.maxSolPerHour}) is below the ${cost} SOL one launch reserves`);
  }
  if (limits.maxSolSpendPerDay < perLaunchSol) {
    reasons.push(`limits.maxSolSpendPerDay (${limits.maxSolSpendPerDay}) is below the ${cost} SOL one launch reserves`);
  }
  return reasons;
}
