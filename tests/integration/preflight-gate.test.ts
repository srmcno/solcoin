import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from '../helpers.js';
import { NotificationService } from '../../packages/server/src/services/notification.service.js';
import { SECRET_KEYS } from '../../packages/server/src/security/secrets.js';

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
