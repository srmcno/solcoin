import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from '../helpers.js';
import { NotificationService } from '../../packages/server/src/services/notification.service.js';
import { SECRET_KEYS } from '../../packages/server/src/security/secrets.js';
import { launchImpossibleReasons } from '../../packages/server/src/cli/preflight-checks.js';

/**
 * The mainnet preflight is a gate. A gate that passes when it should block is
 * worse than no gate, because it is believed.
 */

let harness: TestHarness;

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => harness.cleanup());

function notifications(credentials: Record<string, string>): NotificationService {
  return new NotificationService(
    harness.db,
    harness.settings,
    async (key: string) => credentials[key] ?? null,
    harness.events,
    () => harness.clock.now(),
  );
}

describe('a stored webhook is not a working notification channel', () => {
  /**
   * `NotificationService` requires both a credential and its toggle, so a
   * Discord URL in the secret store with `discordEnabled` off delivers
   * nothing. The preflight gate used to look for the secret alone and pass —
   * and the setup wizard produced exactly that state, so the documented path
   * cleared a blocker while an emergency stop would have reached nobody.
   */
  it('reports nothing dispatchable when the credential is stored but the channel is off', async () => {
    const service = notifications({ [SECRET_KEYS.discordWebhook]: 'https://discord.example.invalid/hook' });
    expect(await service.dispatchableChannels()).toEqual([]);
  });

  it('reports the channel once it is switched on', async () => {
    harness.settings.update({ notifications: { discordEnabled: true } }, { type: 'system' });
    const service = notifications({ [SECRET_KEYS.discordWebhook]: 'https://discord.example.invalid/hook' });
    expect(await service.dispatchableChannels()).toContain('discord');
  });

  /** Telegram needs both halves; a token alone delivers nothing. */
  it('does not count Telegram without a chat id', async () => {
    harness.settings.update({ notifications: { telegramEnabled: true } }, { type: 'system' });
    const service = notifications({ [SECRET_KEYS.telegramBotToken]: 'token' });
    expect(await service.dispatchableChannels()).toEqual([]);

    const withChat = notifications({
      [SECRET_KEYS.telegramBotToken]: 'token',
      [SECRET_KEYS.telegramChatId]: '123',
    });
    expect(await withChat.dispatchableChannels()).toContain('telegram');
  });

  /**
   * Email is enabled-only and then filtered out of dispatch, because the
   * service does not implement delivery. It must never satisfy the gate.
   */
  it('never counts email, which has no delivery implementation', async () => {
    harness.settings.update({ notifications: { emailEnabled: true } }, { type: 'system' });
    expect(await notifications({}).dispatchableChannels()).toEqual([]);
  });
});

describe('limits that make every launch impossible', () => {
  /**
   * `GuardService` reserves one launch's estimated cost and tests it against
   * the per-transaction, hourly and daily SOL caps, and counts the launch
   * against the launch caps. Any of those below what a launch needs means
   * every mainnet launch is refused — which the gate reported as ready.
   */
  const base = () => harness.settings.get().limits;
  const perLaunch = () => harness.guard.estimatedLaunchCostLamports() / 1e9;

  it('passes the shipped defaults', () => {
    expect(launchImpossibleReasons(base(), perLaunch())).toEqual([]);
  });

  it.each([
    ['maxLaunchesPerHour', { maxLaunchesPerHour: 0 }],
    ['maxLaunchesPerDay', { maxLaunchesPerDay: 0 }],
    ['maxSolPerTransaction', { maxSolPerTransaction: 0.001 }],
    ['maxSolPerHour', { maxSolPerHour: 0.001 }],
    ['maxSolSpendPerDay', { maxSolSpendPerDay: 0.001 }],
  ])('blocks when %s cannot admit a single launch', (field, patch) => {
    harness.settings.update({ limits: patch }, { type: 'system' });
    const reasons = launchImpossibleReasons(harness.settings.get().limits, perLaunch());
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.join(' ')).toContain(field);
  });

  /** The guard must actually refuse, or the predicate is describing nothing. */
  it('agrees with what the guard does', () => {
    harness.settings.update({ limits: { maxSolPerHour: 0.001 } }, { type: 'system' });
    expect(launchImpossibleReasons(harness.settings.get().limits, perLaunch()).length).toBeGreaterThan(0);

    const decision = harness.guard.checkLaunch(5_000_000_000);
    expect(decision.allowed).toBe(false);
  });
});

describe('the model sample count', () => {
  /**
   * A prediction bundle exposes `trainedOn`. Preflight read `trainedOnSamples`
   * behind a cast, which silenced the mismatch, so every operator was told the
   * model had zero real outcomes however many it had scored.
   */
  it('is exposed as trainedOn, which is the field the gate must read', async () => {
    const { PredictionService } = await import('../../packages/server/src/services/prediction.service.js');
    const service = new PredictionService(harness.db, () => harness.clock.now());
    const bundle = service.getBundle() as Record<string, unknown>;
    expect(bundle).toHaveProperty('trainedOn');
    expect(bundle.trainedOnSamples).toBeUndefined();
  });
});

describe('the balance gate leaves room for a launch', () => {
  /**
   * The floor is applied *after* the spend: `checkSpend` subtracts one
   * launch's reserved cost and compares the remainder against the floor. A
   * balance merely above the floor therefore refuses every launch — 0.051 SOL
   * against a 0.05 floor read as fine and could not launch anything.
   */
  it('agrees with the guard about what a launch needs', () => {
    const floorSol = harness.settings.get().limits.walletBalanceFloorSol;
    const launchCost = harness.guard.estimatedLaunchCostLamports();
    const floorLamports = floorSol * 1e9;

    // Just above the floor, but with no room for the launch itself.
    const justOverFloor = floorLamports + 1_000;
    expect(harness.guard.checkSpend({ operation: 'launch', lamports: launchCost, walletBalanceLamports: justOverFloor }).allowed).toBe(
      false,
    );

    // The threshold preflight now requires.
    const enough = floorLamports + launchCost;
    expect(harness.guard.checkSpend({ operation: 'launch', lamports: launchCost, walletBalanceLamports: enough }).allowed).toBe(true);
  });
});

describe('the consecutive-failure breaker', () => {
  /**
   * Releasing the emergency stop and clearing the failure count are separate
   * routes. `checkLaunch` refuses every launch while the count is at its
   * threshold, so an operator who released the stop and stopped there had a
   * platform that would launch nothing and a gate that reported no blockers.
   */
  it('refuses launches while it is tripped, with the stop released', () => {
    const threshold = harness.settings.get().limits.consecutiveFailureShutdown;
    const at = harness.clock.now();
    for (let i = 0; i < threshold; i++) {
      harness.db.$raw
        .prepare(
          `INSERT INTO concepts (id, name, symbol, description, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
        )
        .run(`cpt_f${i}`, `Concept ${i}`, 'CPT', 'a concept used in a breaker test', 'failed', at + i, at + i);
      harness.db.$raw
        .prepare(
          `INSERT INTO launches (id, concept_id, idempotency_key, network, adapter, status, approval_mode, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(`lch_f${i}`, `cpt_f${i}`, `k${i}`, 'simulation', 'simulation', 'failed', 'manual', at + i, at + i);
    }

    expect(harness.settings.get().emergencyStop).toBe(false);
    expect(harness.guard.consecutiveLaunchFailures()).toBeGreaterThanOrEqual(threshold);
    const decision = harness.guard.checkLaunch(5_000_000_000);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('consecutive_failures');
  });
});

describe('settings that refuse every launch on their own', () => {
  /**
   * `checkOperational` rejects with `autonomy_off` before any limit is
   * consulted, so autonomy switched off refuses launches the gate had nothing
   * at all to say about.
   */
  it('autonomy off refuses launches before any limit is reached', () => {
    harness.settings.update({ autonomy: { launch: 'off' } }, { type: 'system' });
    const decision = harness.guard.checkLaunch(5_000_000_000);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('autonomy_off');
  });
});

describe('the failure breaker is read for the target network', () => {
  /**
   * `consecutiveLaunchFailures` filtered on the *selected* network, and
   * preflight runs before the switch — so unacknowledged mainnet failures were
   * invisible while the platform sat on simulation, and would halt launching
   * the instant it switched.
   */
  it('sees mainnet failures while the platform is still on simulation', () => {
    const at = harness.clock.now();
    for (let i = 0; i < 3; i++) {
      harness.db.$raw
        .prepare(`INSERT INTO concepts (id, name, symbol, description, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
        .run(`cpt_m${i}`, `Concept ${i}`, 'CPT', 'a concept used in a breaker test', 'failed', at + i, at + i);
      harness.db.$raw
        .prepare(
          `INSERT INTO launches (id, concept_id, idempotency_key, network, adapter, status, approval_mode, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(`lch_m${i}`, `cpt_m${i}`, `km${i}`, 'mainnet', 'pumpfun_sdk', 'failed', 'manual', at + i, at + i);
    }

    expect(harness.settings.get().execution.network).toBe('simulation');
    // What the old check saw: nothing, because it asked about simulation.
    expect(harness.guard.consecutiveLaunchFailures()).toBe(0);
    // What preflight asks now.
    expect(harness.guard.consecutiveLaunchFailures('mainnet')).toBe(3);
  });
});
