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
