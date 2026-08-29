import { lamportsToSol, solToLamports, TIME } from '@solcoin/shared';
import { AppError } from '../core/errors.js';
import { componentLogger } from '../core/logger.js';
import type { Db } from '../db/client.js';
import type { SettingsService } from './settings.service.js';
import { AUDIT_ACTIONS, type AuditLog } from '../security/audit.js';
import type { EventBus } from '../core/events.js';

/**
 * The safety envelope.
 *
 * Every side-effecting operation asks this service for permission first. It is
 * the single place where "can the platform spend money or create something
 * on chain right now?" is answered, which means there is exactly one thing to
 * audit and one thing to test.
 *
 * All counters are derived from the database rather than held in memory, so a
 * restart cannot reset a daily limit — an in-memory counter would turn a crash
 * loop into an unbounded spend.
 *
 * The checks are deliberately conservative and fail closed: an error reading a
 * limit denies the operation.
 */

export type GuardOperation =
  | 'launch'
  | 'fee_collection'
  | 'wallet_transfer'
  | 'ai_request'
  | 'research'
  | 'concept_generation';

export interface GuardDecision {
  allowed: boolean;
  /** Machine-readable reason when denied. */
  code?: string;
  /** Human-readable explanation, suitable for the UI and the audit log. */
  reason?: string;
  /** When the limit will next permit the operation, if it is time-based. */
  retryAfterMs?: number;
}

export interface SpendRequest {
  operation: GuardOperation;
  lamports?: number;
  usd?: number;
  /** Current operating wallet balance, when known. */
  walletBalanceLamports?: number;
}

const ALLOWED: GuardDecision = { allowed: true };

export class GuardService {
  private readonly log = componentLogger('guard');

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly audit: AuditLog,
    private readonly events: EventBus,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The universal precondition.
   *
   * Checked before every operation with side effects, including ones that spend
   * nothing, because emergency stop must halt research and generation too — a
   * paused system that keeps burning AI credits is not paused.
   */
  checkOperational(operation: GuardOperation): GuardDecision {
    const config = this.settings.get();
    if (config.emergencyStop) {
      return {
        allowed: false,
        code: 'emergency_stop',
        reason: `Emergency stop is engaged${config.emergencyStopReason ? `: ${config.emergencyStopReason}` : '.'}`,
      };
    }
    const autonomyCapability = OPERATION_TO_CAPABILITY[operation];
    if (autonomyCapability && config.autonomy[autonomyCapability] === 'off') {
      return {
        allowed: false,
        code: 'autonomy_off',
        reason: `Autonomy for ${autonomyCapability.replace(/_/g, ' ')} is switched off.`,
      };
    }
    return ALLOWED;
  }

  /** Full pre-flight for a spending operation. */
  async checkSpend(request: SpendRequest): Promise<GuardDecision> {
    const operational = this.checkOperational(request.operation);
    if (!operational.allowed) return operational;

    const config = this.settings.get();
    const lamports = request.lamports ?? 0;

    if (lamports > 0) {
      const perTxCap = solToLamports(config.limits.maxSolPerTransaction);
      if (lamports > perTxCap) {
        return {
          allowed: false,
          code: 'per_transaction_limit',
          reason: `This operation would spend ${lamportsToSol(lamports).toFixed(4)} SOL, above the ${config.limits.maxSolPerTransaction} SOL per-transaction limit.`,
        };
      }

      const hourly = await this.spentLamportsSince(this.now() - TIME.hour);
      const hourlyCap = solToLamports(config.limits.maxSolPerHour);
      if (hourly + lamports > hourlyCap) {
        return {
          allowed: false,
          code: 'hourly_spend_limit',
          reason: `Hourly spend limit reached: ${lamportsToSol(hourly).toFixed(4)} of ${config.limits.maxSolPerHour} SOL already committed in the last hour.`,
          retryAfterMs: TIME.hour,
        };
      }

      const daily = await this.spentLamportsSince(this.now() - TIME.day);
      const dailyCap = solToLamports(config.limits.maxSolSpendPerDay);
      if (daily + lamports > dailyCap) {
        return {
          allowed: false,
          code: 'daily_spend_limit',
          reason: `Daily spend limit reached: ${lamportsToSol(daily).toFixed(4)} of ${config.limits.maxSolSpendPerDay} SOL already committed today.`,
          retryAfterMs: TIME.day,
        };
      }

      // The balance floor is what stops the platform from spending itself into
      // a state where it cannot even pay to collect the fees it has earned.
      if (request.walletBalanceLamports !== undefined) {
        const floor = solToLamports(config.limits.walletBalanceFloorSol);
        if (request.walletBalanceLamports - lamports < floor) {
          return {
            allowed: false,
            code: 'balance_floor',
            reason: `Spending ${lamportsToSol(lamports).toFixed(4)} SOL would take the operating wallet below its ${config.limits.walletBalanceFloorSol} SOL reserve.`,
          };
        }
      }
    }

    if (request.usd !== undefined && request.usd > 0) {
      const spent = await this.aiSpendUsdSince(this.now() - TIME.day);
      if (spent + request.usd > config.limits.maxAiSpendUsdPerDay) {
        return {
          allowed: false,
          code: 'ai_budget',
          reason: `Daily AI budget exhausted: $${spent.toFixed(2)} of $${config.limits.maxAiSpendUsdPerDay} spent in the last 24 hours.`,
          retryAfterMs: TIME.day,
        };
      }
    }

    return ALLOWED;
  }

  /**
   * Launch-specific gate: rate limits plus the consecutive-failure breaker.
   *
   * The failure breaker matters more than the rate limits. Repeated launch
   * failures usually mean something is systemically wrong — a bad RPC, an
   * expired dependency, a protocol change — and continuing to retry burns rent
   * and fees on transactions that will not land.
   */
  async checkLaunch(walletBalanceLamports?: number): Promise<GuardDecision> {
    const config = this.settings.get();

    const base = await this.checkSpend({
      operation: 'launch',
      lamports: solToLamports(config.execution.devBuySol) + 6_000_000,
      walletBalanceLamports,
    });
    if (!base.allowed) return base;

    const network = config.execution.network;

    const lastHour = await this.countLaunchesSince(this.now() - TIME.hour, network);
    if (lastHour >= config.limits.maxLaunchesPerHour) {
      return {
        allowed: false,
        code: 'hourly_launch_limit',
        reason: `Hourly launch limit reached (${lastHour}/${config.limits.maxLaunchesPerHour}).`,
        retryAfterMs: TIME.hour,
      };
    }

    const lastDay = await this.countLaunchesSince(this.now() - TIME.day, network);
    if (lastDay >= config.limits.maxLaunchesPerDay) {
      return {
        allowed: false,
        code: 'daily_launch_limit',
        reason: `Daily launch limit reached (${lastDay}/${config.limits.maxLaunchesPerDay}).`,
        retryAfterMs: TIME.day,
      };
    }

    const consecutiveFailures = await this.consecutiveLaunchFailures();
    if (consecutiveFailures >= config.limits.consecutiveFailureShutdown) {
      return {
        allowed: false,
        code: 'consecutive_failures',
        reason: `${consecutiveFailures} consecutive launch failures. Launching is halted until the cause is resolved and the counter is cleared.`,
      };
    }

    return ALLOWED;
  }

  /**
   * Trip the kill switch automatically.
   *
   * Called when the platform detects a condition it should not try to work
   * through: repeated launch failures, an impossible wallet state, a provider
   * returning nonsense. Engaging the stop is always audited and notified.
   */
  autoStop(reason: string): void {
    const config = this.settings.get();
    if (config.emergencyStop) return;
    this.log.error({ reason }, 'engaging emergency stop automatically');
    this.settings.emergencyStop(reason, { type: 'system', label: 'guard' });
    this.audit.record({
      actorType: 'system',
      actorLabel: 'guard',
      action: AUDIT_ACTIONS.emergencyStop,
      targetType: 'system',
      targetId: 'emergency_stop',
      result: 'blocked',
      reason,
    });
  }

  /** Committed spend in a window: launches plus outgoing wallet transactions. */
  private async spentLamportsSince(sinceMs: number): Promise<number> {
    const launchRow = this.db.$raw
      .prepare(
        `SELECT COALESCE(SUM(total_cost_lamports), 0) AS total
           FROM launches
          WHERE created_at >= ? AND status IN ('preparing','submitted','confirmed')`,
      )
      .get(sinceMs) as { total: number };

    const transferRow = this.db.$raw
      .prepare(
        `SELECT COALESCE(SUM(lamports + fee_lamports), 0) AS total
           FROM wallet_transactions
          WHERE occurred_at >= ? AND direction = 'out' AND status IN ('pending','confirmed')`,
      )
      .get(sinceMs) as { total: number };

    return (launchRow?.total ?? 0) + (transferRow?.total ?? 0);
  }

  private async aiSpendUsdSince(sinceMs: number): Promise<number> {
    const row = this.db.$raw
      .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM ai_requests WHERE created_at >= ?')
      .get(sinceMs) as { total: number };
    return row?.total ?? 0;
  }

  private async countLaunchesSince(sinceMs: number, network: string): Promise<number> {
    const row = this.db.$raw
      .prepare(
        `SELECT COUNT(*) AS n FROM launches
          WHERE created_at >= ? AND network = ? AND status IN ('preparing','submitted','confirmed')`,
      )
      .get(sinceMs, network) as { n: number };
    return row?.n ?? 0;
  }

  /** Failures since the most recent success, on the active network. */
  async consecutiveLaunchFailures(): Promise<number> {
    const network = this.settings.get().execution.network;
    const rows = this.db.$raw
      .prepare(
        `SELECT status FROM launches
          WHERE network = ? AND status IN ('confirmed','failed')
          ORDER BY created_at DESC LIMIT 25`,
      )
      .all(network) as Array<{ status: string }>;
    let count = 0;
    for (const row of rows) {
      if (row.status === 'failed') count++;
      else break;
    }
    return count;
  }

  /** Current usage against every limit, for the dashboard. */
  async usage(): Promise<{
    launchesLastHour: number;
    launchesToday: number;
    solSpentLastHour: number;
    solSpentToday: number;
    aiSpentTodayUsd: number;
    consecutiveFailures: number;
    limits: {
      maxLaunchesPerHour: number;
      maxLaunchesPerDay: number;
      maxSolPerHour: number;
      maxSolSpendPerDay: number;
      maxAiSpendUsdPerDay: number;
      consecutiveFailureShutdown: number;
    };
    emergencyStop: boolean;
    emergencyStopReason: string;
  }> {
    const config = this.settings.get();
    const network = config.execution.network;
    const [launchesLastHour, launchesToday, hourLamports, dayLamports, aiToday, failures] = await Promise.all([
      this.countLaunchesSince(this.now() - TIME.hour, network),
      this.countLaunchesSince(this.now() - TIME.day, network),
      this.spentLamportsSince(this.now() - TIME.hour),
      this.spentLamportsSince(this.now() - TIME.day),
      this.aiSpendUsdSince(this.now() - TIME.day),
      this.consecutiveLaunchFailures(),
    ]);

    return {
      launchesLastHour,
      launchesToday,
      solSpentLastHour: lamportsToSol(hourLamports),
      solSpentToday: lamportsToSol(dayLamports),
      aiSpentTodayUsd: aiToday,
      consecutiveFailures: failures,
      limits: {
        maxLaunchesPerHour: config.limits.maxLaunchesPerHour,
        maxLaunchesPerDay: config.limits.maxLaunchesPerDay,
        maxSolPerHour: config.limits.maxSolPerHour,
        maxSolSpendPerDay: config.limits.maxSolSpendPerDay,
        maxAiSpendUsdPerDay: config.limits.maxAiSpendUsdPerDay,
        consecutiveFailureShutdown: config.limits.consecutiveFailureShutdown,
      },
      emergencyStop: config.emergencyStop,
      emergencyStopReason: config.emergencyStopReason,
    };
  }

  /** Throw when denied, for call sites where a denial is exceptional. */
  async requireSpend(request: SpendRequest): Promise<void> {
    const decision = await this.checkSpend(request);
    if (!decision.allowed) {
      throw new AppError(decision.code === 'emergency_stop' ? 'emergency_stop' : 'limit_exceeded', decision.reason ?? 'Operation not permitted.', {
        details: { code: decision.code, retryAfterMs: decision.retryAfterMs },
      });
    }
  }
}

const OPERATION_TO_CAPABILITY: Partial<Record<GuardOperation, 'launch' | 'fee_collection' | 'wallet_transfer' | 'research' | 'concept_generation'>> = {
  launch: 'launch',
  fee_collection: 'fee_collection',
  wallet_transfer: 'wallet_transfer',
  research: 'research',
  concept_generation: 'concept_generation',
};
