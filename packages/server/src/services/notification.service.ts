import { TIME, formatSol, lamportsToSol, type NotificationEvent } from '@solcoin/shared';
import { safeErrorText } from '../core/errors.js';
import type { EventBus } from '../core/events.js';
import { newId } from '../core/ids.js';
import { parseJson, stringify } from '../core/json.js';
import { componentLogger } from '../core/logger.js';
import type { Db } from '../db/client.js';
import { HttpClient } from '../providers/http.js';
import { SECRET_KEYS } from '../security/secrets.js';
import type { SettingsService } from './settings.service.js';

/**
 * Outbound notifications.
 *
 * Three properties matter more than the transport details:
 *
 *  1. **Deduplication.** A flapping provider or a wallet hovering on its floor
 *     produces the same alert every job tick. Without a dedupe window the
 *     operator gets two hundred messages, mutes the channel, and then misses
 *     the one alert that mattered. The window is configurable because "the same
 *     alert" means something different for a launch failure than for a balance
 *     warning.
 *  2. **Delivery never blocks or breaks the caller.** A launch must not fail
 *     because Discord is down. `notify` records the notification and its
 *     delivery rows synchronously, then dispatches in the background; every
 *     failure lands on the delivery row, never on the caller's stack.
 *  3. **The message says something.** Every subscription below writes the
 *     actual numbers and a deep link into the body. "Event occurred" is not a
 *     notification, it is a prompt to go and look something up.
 *
 * The notification row itself is always written when the event is enabled,
 * even with no channel configured: the in-app inbox (`list`/`unreadCount`) is
 * itself a delivery channel and works with zero credentials.
 */

export type NotificationSeverity = 'info' | 'warning' | 'critical';

/** Channels that carry a notification off this machine. */
export type NotificationChannel = 'webhook' | 'discord' | 'telegram' | 'slack' | 'email';

export interface NotifyInput {
  event: NotificationEvent;
  severity: NotificationSeverity;
  title: string;
  body: string;
  /**
   * Identity of the *situation*, not of the message. Two alerts about the same
   * wallet dipping below its floor share a dedupe key; two different wallets
   * do not.
   */
  dedupeKey?: string;
  refType?: string;
  refId?: string;
  /** Dashboard path the operator should open, e.g. `/tokens/<mint>`. */
  link?: string;
  data?: Record<string, unknown>;
}

export interface NotifyResult {
  /** True when the notification was recorded (and therefore visible in-app). */
  sent: boolean;
  notificationId?: string;
  /** Channels a delivery row was created for. */
  channels: NotificationChannel[];
  /** Always populated when nothing was recorded, or when no channel was used. */
  reason?: string;
}

export interface NotificationRow {
  id: string;
  event: string;
  severity: string;
  title: string;
  body: string;
  dedupeKey: string | null;
  refType: string | null;
  refId: string | null;
  link: string | null;
  data: Record<string, unknown>;
  readAt: number | null;
  createdAt: number;
  deliveries: Array<{ channel: string; status: string; attempts: number; error: string | null; deliveredAt: number | null }>;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  unreadOnly?: boolean;
  event?: NotificationEvent;
  severity?: NotificationSeverity;
  /** Only notifications created at or after this epoch millisecond. */
  since?: number;
}

interface DispatchPayload {
  id: string;
  event: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  link: string | null;
  data: Record<string, unknown>;
  createdAt: number;
}

/** Attempts before a delivery is abandoned. */
const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Spacing base for retries. Attempt *k* is only retried once the delivery row
 * is `RETRY_BASE_MS * 2^k` old, giving 2/4/8/16 minutes. The schema has no
 * `last_attempt_at` column, so elapsed-since-creation is the clock; because
 * `attempts` only ever increases, the spacing is still strictly exponential.
 */
const RETRY_BASE_MS = 60_000;

/**
 * Deliveries older than this are dropped rather than retried. A two-day-old
 * "wallet balance is low" alert is not information, it is archaeology.
 */
const RETRY_MAX_AGE_MS = 24 * TIME.hour;

const SEVERITY_COLOUR: Record<NotificationSeverity, number> = {
  info: 0x3b82f6,
  warning: 0xf59e0b,
  critical: 0xef4444,
};

const SEVERITY_EMOJI: Record<NotificationSeverity, string> = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🚨',
};

export class NotificationService {
  private readonly log = componentLogger('notifications');
  /** One client per channel: a dead Discord webhook must not open Telegram's circuit. */
  private readonly clients = new Map<NotificationChannel, HttpClient>();
  private readonly unsubscribes: Array<() => void> = [];
  /** Background dispatches, so tests and shutdown can wait for quiescence. */
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly getCredential: (key: string) => Promise<string | null>,
    private readonly events: EventBus,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record a notification and fan it out.
   *
   * Returns rather than throws in every "we did not send" case: a caller
   * emitting a notification is reporting something, not asking for a
   * transaction, and must never be interrupted by the reporting itself.
   */
  async notify(input: NotifyInput): Promise<NotifyResult> {
    const config = this.settings.get().notifications;

    if (!config.enabledEvents.includes(input.event)) {
      // Deliberately records nothing at all: a disabled event should not
      // quietly accumulate in the inbox either.
      return {
        sent: false,
        channels: [],
        reason: `The "${input.event}" notification is switched off in settings.notifications.enabledEvents.`,
      };
    }

    const timestamp = this.now();

    /*
     * The channel lookup happens before the dedupe check, not after.
     *
     * It is the only `await` on this path, and with it in the middle two
     * notifications sharing a dedupe key could both find no duplicate and both
     * insert — which is precisely what the dedupe window exists to prevent.
     * Reading the channels first leaves the check and the insert with nothing
     * between them.
     */
    const channels = await this.enabledChannels();

    if (input.dedupeKey && config.dedupeWindowMinutes > 0) {
      const windowStart = timestamp - config.dedupeWindowMinutes * TIME.minute;
      const duplicate = this.db.$raw
        .prepare('SELECT id, created_at FROM notifications WHERE dedupe_key = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1')
        .get(input.dedupeKey, windowStart) as { id: string; created_at: number } | undefined;
      if (duplicate) {
        const agoMinutes = Math.round((timestamp - duplicate.created_at) / TIME.minute);
        return {
          sent: false,
          notificationId: duplicate.id,
          channels: [],
          reason: `Suppressed as a duplicate of ${duplicate.id}, sent ${agoMinutes} minute(s) ago; the dedupe window is ${config.dedupeWindowMinutes} minutes.`,
        };
      }
    }
    const id = newId('ntf', timestamp);
    const data = { ...(input.data ?? {}), ...(input.link ? { link: input.link } : {}) };

    const insertNotification = this.db.$raw.prepare(
      `INSERT INTO notifications (id, event, severity, title, body, dedupe_key, ref_type, ref_id, data, read_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,NULL,?)`,
    );
    const insertDelivery = this.db.$raw.prepare(
      `INSERT INTO notification_deliveries (id, notification_id, channel, status, attempts, error, delivered_at, created_at)
       VALUES (?,?,?,?,?,?,NULL,?)`,
    );

    const deliveryIds = new Map<NotificationChannel, string>();

    this.db.$raw.transaction(() => {
      insertNotification.run(
        id,
        input.event,
        input.severity,
        input.title,
        input.body,
        input.dedupeKey ?? null,
        input.refType ?? null,
        input.refId ?? null,
        stringify(data),
        timestamp,
      );
      for (const channel of channels) {
        const deliveryId = newId('nd', timestamp);
        deliveryIds.set(channel, deliveryId);
        // Email is recorded and immediately marked skipped: SMTP is not an HTTP
        // transport and this service only speaks HTTP. Recording it means the
        // operator can see that `emailEnabled` is doing nothing, rather than
        // wondering why no mail arrives.
        const skipped = channel === 'email';
        insertDelivery.run(
          deliveryId,
          id,
          channel,
          skipped ? 'skipped' : 'pending',
          0,
          skipped ? 'Email delivery is not implemented in this service; configure a webhook, Discord, Telegram or Slack channel instead.' : null,
          timestamp,
        );
      }
    })();

    const payload: DispatchPayload = {
      id,
      event: input.event,
      severity: input.severity,
      title: input.title,
      body: input.body,
      link: input.link ?? null,
      data,
      createdAt: timestamp,
    };

    const dispatchable = channels.filter((c) => c !== 'email');
    if (dispatchable.length > 0) this.dispatchInBackground(payload, dispatchable, deliveryIds);

    return {
      sent: true,
      notificationId: id,
      channels,
      reason:
        dispatchable.length === 0
          ? 'Recorded to the in-app inbox only: no outbound channel is both enabled in settings and configured with a credential.'
          : undefined,
    };
  }

  /**
   * Retry deliveries that failed.
   *
   * Bounded at five attempts because a webhook URL that has rejected a message
   * five times over half an hour is misconfigured, not congested, and retrying
   * it forever burns the same quota the working channels need.
   */
  async retryFailedDeliveries(): Promise<{ retried: number }> {
    const timestamp = this.now();
    const rows = this.db.$raw
      .prepare(
        `SELECT d.id, d.notification_id, d.channel, d.attempts, d.created_at,
                n.event, n.severity, n.title, n.body, n.data, n.created_at AS notification_created_at
           FROM notification_deliveries d
           JOIN notifications n ON n.id = d.notification_id
          WHERE d.status = 'failed' AND d.attempts < ? AND d.created_at >= ?
          ORDER BY d.created_at ASC
          LIMIT 100`,
      )
      .all(MAX_DELIVERY_ATTEMPTS, timestamp - RETRY_MAX_AGE_MS) as Array<{
      id: string;
      notification_id: string;
      channel: string;
      attempts: number;
      created_at: number;
      event: string;
      severity: string;
      title: string;
      body: string;
      data: string | null;
      notification_created_at: number;
    }>;

    const enabled = await this.enabledChannels();
    const due = rows.filter((row) => {
      const channel = row.channel as NotificationChannel;
      // A channel the operator has since disabled or de-credentialed is not
      // retried — re-sending into a channel nobody is watching is pure noise.
      if (!enabled.includes(channel)) return false;
      const backoffMs = RETRY_BASE_MS * 2 ** Math.max(1, row.attempts);
      return timestamp - row.created_at >= backoffMs;
    });

    let retried = 0;
    await Promise.allSettled(
      due.map(async (row) => {
        const data = parseJson<Record<string, unknown>>(row.data, {});
        const link = typeof data.link === 'string' ? data.link : null;
        const payload: DispatchPayload = {
          id: row.notification_id,
          event: row.event,
          severity: normaliseSeverity(row.severity),
          title: row.title,
          body: row.body,
          link,
          data,
          createdAt: row.notification_created_at,
        };
        retried++;
        await this.attemptDelivery(payload, row.channel as NotificationChannel, row.id);
      }),
    );

    if (retried > 0) this.log.info({ retried }, 'retried failed notification deliveries');
    return { retried };
  }

  /**
   * Wire the platform's event bus to notifications.
   *
   * Every message below carries the numbers that make it actionable and a path
   * the operator can open. The dedupe keys are chosen per situation, so
   * repeated events about the *same* token or wallet collapse while events
   * about different ones do not.
   */
  subscribe(): void {
    if (this.unsubscribes.length > 0) return; // Idempotent: double-wiring would double-send.

    this.unsubscribes.push(
      this.events.on('launch.confirmed', (p) => {
        const token = this.tokenLabel(p.mint);
        void this.safeNotify({
          event: 'launch_succeeded',
          severity: 'info',
          title: `Launched ${token ?? p.mint.slice(0, 8)} on ${p.network}`,
          body: `${token ? `${token} is live. ` : ''}Mint ${p.mint} confirmed on ${p.network} in transaction ${p.signature}. Monitoring has started at the hot poll interval.`,
          dedupeKey: `launch_confirmed:${p.launchId}`,
          refType: 'launch',
          refId: p.launchId,
          link: `/tokens/${p.mint}`,
          data: { mint: p.mint, network: p.network, signature: p.signature, launchId: p.launchId },
        });
      }),

      this.events.on('launch.failed', (p) => {
        void this.safeNotify({
          event: 'launch_failed',
          severity: p.attempts >= 3 ? 'critical' : 'warning',
          title: `Launch failed after ${p.attempts} attempt${p.attempts === 1 ? '' : 's'} (${p.code})`,
          body: `Launch ${p.launchId} did not complete. Error code ${p.code}: ${p.error}. Consecutive failures count toward the automatic shutdown threshold in settings.limits.consecutiveFailureShutdown.`,
          dedupeKey: `launch_failed:${p.launchId}`,
          refType: 'launch',
          refId: p.launchId,
          link: `/launches/${p.launchId}`,
          data: { launchId: p.launchId, code: p.code, attempts: p.attempts, error: p.error },
        });
      }),

      this.events.on('token.graduated', (p) => {
        const token = this.tokenLabel(p.mint);
        void this.safeNotify({
          event: 'token_graduated',
          severity: 'info',
          title: `${token ?? p.mint.slice(0, 8)} graduated at $${Math.round(p.marketCapUsd).toLocaleString('en-US')} market cap`,
          body: `${token ? `${token} ` : `Mint ${p.mint} `}completed its bonding curve and migrated to the AMM at an estimated $${Math.round(p.marketCapUsd).toLocaleString('en-US')} market cap. Creator fees now accrue in the AMM coin-creator vault as well as the curve vault.`,
          // Graduation happens once per token, but the detector can re-fire on
          // repeated polls; one message per token per window is enough.
          dedupeKey: `graduated:${p.mint}`,
          refType: 'token',
          refId: p.mint,
          link: `/tokens/${p.mint}`,
          data: { mint: p.mint, marketCapUsd: p.marketCapUsd },
        });
      }),

      this.events.on('token.high_volume', (p) => {
        const token = this.tokenLabel(p.mint);
        const threshold = this.settings.get().notifications.highVolumeSol;
        void this.safeNotify({
          event: 'high_organic_volume',
          severity: 'info',
          title: `${token ?? p.mint.slice(0, 8)} traded ${p.volume24hSol.toFixed(1)} SOL in 24h`,
          body: `${token ? `${token} ` : `Mint ${p.mint} `}has ${p.volume24hSol.toFixed(2)} SOL of 24-hour volume, above the ${threshold} SOL high-volume threshold. Volume at this level is what actually generates creator fees.`,
          dedupeKey: `high_volume:${p.mint}`,
          refType: 'token',
          refId: p.mint,
          link: `/tokens/${p.mint}`,
          data: { mint: p.mint, volume24hSol: p.volume24hSol, thresholdSol: threshold },
        });
      }),

      this.events.on('fees.collected', (p) => {
        void this.safeNotify({
          event: 'fees_collected',
          severity: 'info',
          title: `Collected ${formatSol(p.lamports, { fromLamports: true })} in creator fees`,
          body: `A creator-fee claim for ${p.mint} settled ${formatSol(p.lamports, { fromLamports: true })} into the operating wallet. Transaction ${p.signature}.`,
          // Keyed on the signature: each claim is a distinct, real event and
          // none of them should be suppressed.
          dedupeKey: `fees_collected:${p.signature}`,
          refType: 'wallet',
          refId: p.mint,
          link: '/fees',
          data: { creator: p.mint, lamports: p.lamports, sol: lamportsToSol(p.lamports), signature: p.signature },
        });
      }),

      this.events.on('fees.accrued', (p) => {
        // The emitter already applies this threshold, but the bus is public and
        // any component can emit; re-check rather than trust the caller.
        const thresholdSol = this.settings.get().notifications.largeFeeAccrualSol;
        const accruedSol = lamportsToSol(p.lamports);
        if (accruedSol < thresholdSol) return;
        void this.safeNotify({
          event: 'large_fee_accrual',
          severity: 'info',
          title: `${formatSol(p.lamports, { fromLamports: true })} of creator fees accrued`,
          body: `Vaults for ${p.mint} accrued ${formatSol(p.lamports, { fromLamports: true })} since the last snapshot, above the ${thresholdSol} SOL notification threshold. Total claimable is now ${formatSol(p.claimableLamports, { fromLamports: true })}. Note that the bonding-curve vault permanently retains its rent-exempt minimum, so the claimable figure is below the raw vault balance.`,
          dedupeKey: `fee_accrual:${p.mint}`,
          refType: 'wallet',
          refId: p.mint,
          link: '/fees',
          data: {
            creator: p.mint,
            accruedLamports: p.lamports,
            accruedSol,
            claimableLamports: p.claimableLamports,
            claimableSol: lamportsToSol(p.claimableLamports),
          },
        });
      }),

      this.events.on('wallet.low_balance', (p) => {
        const shortfall = Math.max(0, p.floorLamports - p.balanceLamports);
        void this.safeNotify({
          event: 'wallet_balance_low',
          severity: 'warning',
          title: `Operating wallet at ${formatSol(p.balanceLamports, { fromLamports: true })}, below its floor`,
          body: `Wallet ${p.address} holds ${formatSol(p.balanceLamports, { fromLamports: true })} against a floor of ${formatSol(p.floorLamports, { fromLamports: true })} — a shortfall of ${formatSol(shortfall, { fromLamports: true })}. All spending is blocked until it is topped up; launches and fee claims will be refused in the meantime.`,
          // One warning per wallet per dedupe window: a wallet sitting under its
          // floor re-triggers on every job tick.
          dedupeKey: `low_balance:${p.address}`,
          refType: 'wallet',
          refId: p.address,
          link: '/wallet',
          data: {
            address: p.address,
            balanceLamports: p.balanceLamports,
            balanceSol: lamportsToSol(p.balanceLamports),
            floorLamports: p.floorLamports,
            shortfallSol: lamportsToSol(shortfall),
          },
        });
      }),

      this.events.on('system.emergency_stop', (p) => {
        void this.safeNotify({
          event: 'emergency_stop',
          severity: p.engaged ? 'critical' : 'warning',
          title: p.engaged ? 'Emergency stop engaged — all side effects halted' : 'Emergency stop released',
          body: p.engaged
            ? `${p.actor} engaged the global kill switch: ${p.reason || 'no reason given'}. No job with a side effect will run — no launches, no fee claims, no wallet transfers — until it is released.`
            : `${p.actor} released the emergency stop: ${p.reason || 'no reason given'}. Jobs with side effects resume on their next scheduled tick.`,
          // Engage and release must both land, so the key carries the state.
          dedupeKey: `emergency_stop:${p.engaged ? 'engaged' : 'released'}`,
          refType: 'system',
          refId: 'emergency_stop',
          link: '/settings',
          data: { engaged: p.engaged, reason: p.reason, actor: p.actor },
        });
      }),

      this.events.on('concept.awaiting_approval', (p) => {
        // Expected value is the *mean* of a distribution where a handful of
        // outcomes carry almost everything. Quoting it alone would describe a
        // typical launch with a number a typical launch never reaches, so the
        // stored median, 10th–90th percentiles and tail share go with it.
        const outcome = this.feeOutcomeSummary(p.conceptId);
        void this.safeNotify({
          event: 'candidate_awaiting_approval',
          severity: 'info',
          title: `${p.name} ($${p.symbol}) is waiting for your approval`,
          body: `Concept ${p.name} ($${p.symbol}) cleared the quality gate and needs a human decision before it can launch. ${outcome.text}`,
          dedupeKey: `awaiting_approval:${p.conceptId}`,
          refType: 'concept',
          refId: p.conceptId,
          link: `/candidates/${p.conceptId}`,
          data: { conceptId: p.conceptId, name: p.name, symbol: p.symbol, expectedValueSol: p.expectedValueSol, ...outcome.data },
        });
      }),

      this.events.on('model.retrained', (p) => {
        // A log loss without the size of the holdout it was measured on is not
        // a number anyone can act on, so it is looked up rather than omitted —
        // and when the bundle did not record one, the message says so instead
        // of letting the reader assume the figure is well measured.
        const holdout = this.holdoutSize(p.version);
        const holdoutClause =
          holdout === null
            ? ', though this bundle did not record how many held-out outcomes that was measured over, so how precisely it is measured is unknown'
            : ` over ${holdout} held-out outcome${holdout === 1 ? '' : 's'}${
                holdout < 30 ? `, which is too small a holdout for the gap between two nearby log losses to be meaningful` : ''
              }`;
        void this.safeNotify({
          event: 'model_retrained',
          severity: 'info',
          title: `Success model retrained as ${p.version} on ${p.trainedOn} outcomes`,
          body: `A new model bundle (${p.version}) was fitted on ${p.trainedOn} observed launch outcomes. Held-out log loss is ${p.logLoss.toFixed(3)}${holdoutClause} (lower is better; 0.693 is the score of an uninformative coin flip). With ${p.trainedOn} outcomes in total the fit is ${p.trainedOn < 50 ? 'still dominated by the priors and should be treated as provisional' : 'starting to be driven by observed data'}.`,
          dedupeKey: `model_retrained:${p.version}`,
          refType: 'model',
          refId: p.version,
          link: '/learning',
          data: { version: p.version, trainedOn: p.trainedOn, logLoss: p.logLoss, holdoutN: holdout },
        });
      }),
    );

    this.log.info({ subscriptions: this.unsubscribes.length }, 'notification subscriptions wired to the event bus');
  }

  /** Detach every event subscription. Used on shutdown and in tests. */
  unsubscribe(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
  }

  list(options: ListOptions = {}): { notifications: NotificationRow[]; total: number; unread: number } {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);

    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (options.unreadOnly) conditions.push('read_at IS NULL');
    if (options.event) {
      conditions.push('event = ?');
      params.push(options.event);
    }
    if (options.severity) {
      conditions.push('severity = ?');
      params.push(options.severity);
    }
    if (options.since !== undefined) {
      conditions.push('created_at >= ?');
      params.push(options.since);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = this.db.$raw
      .prepare(`SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    const totalRow = this.db.$raw.prepare(`SELECT COUNT(*) AS n FROM notifications ${where}`).get(...params) as
      | { n: number }
      | undefined;

    const deliveries = this.db.$raw.prepare(
      'SELECT channel, status, attempts, error, delivered_at FROM notification_deliveries WHERE notification_id = ? ORDER BY created_at ASC',
    );

    const notifications: NotificationRow[] = rows.map((row) => {
      const id = String(row.id);
      const data = parseJson<Record<string, unknown>>(row.data as string | null, {});
      return {
        id,
        event: String(row.event),
        severity: String(row.severity),
        title: String(row.title),
        body: String(row.body),
        dedupeKey: (row.dedupe_key as string | null) ?? null,
        refType: (row.ref_type as string | null) ?? null,
        refId: (row.ref_id as string | null) ?? null,
        link: typeof data.link === 'string' ? data.link : null,
        data,
        readAt: (row.read_at as number | null) ?? null,
        createdAt: Number(row.created_at),
        deliveries: (
          deliveries.all(id) as Array<{
            channel: string;
            status: string;
            attempts: number;
            error: string | null;
            delivered_at: number | null;
          }>
        ).map((d) => ({
          channel: d.channel,
          status: d.status,
          attempts: d.attempts,
          error: d.error,
          deliveredAt: d.delivered_at,
        })),
      };
    });

    return { notifications, total: totalRow?.n ?? 0, unread: this.unreadCount() };
  }

  /** Mark one notification read. Returns false when it was already read or absent. */
  markRead(id: string): boolean {
    const result = this.db.$raw
      .prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL')
      .run(this.now(), id);
    return result.changes > 0;
  }

  markAllRead(): { marked: number } {
    const result = this.db.$raw.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL').run(this.now());
    return { marked: result.changes };
  }

  unreadCount(): number {
    const row = this.db.$raw.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL').get() as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  /** Wait for background dispatches to settle. For shutdown and tests only. */
  async flush(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  // -------------------------------------------------------------------------
  // Channel resolution and dispatch
  // -------------------------------------------------------------------------

  /**
   * A channel is used only when it is switched on *and* its credential exists.
   * A missing credential is an unconfigured channel, not an error: the platform
   * is designed to run with any subset of its integrations present.
   */
  private async enabledChannels(): Promise<NotificationChannel[]> {
    const config = this.settings.get().notifications;
    const channels: NotificationChannel[] = [];

    if (config.webhookEnabled && (await this.getCredential(SECRET_KEYS.genericWebhook))) channels.push('webhook');
    if (config.discordEnabled && (await this.getCredential(SECRET_KEYS.discordWebhook))) channels.push('discord');
    if (
      config.telegramEnabled &&
      (await this.getCredential(SECRET_KEYS.telegramBotToken)) &&
      (await this.getCredential(SECRET_KEYS.telegramChatId))
    ) {
      channels.push('telegram');
    }
    // NotificationSettings has no `slackEnabled` toggle, so storing a Slack
    // webhook URL is itself the opt-in. That is a deliberate operator action
    // (the credential has to be typed into the secret store), and removing the
    // secret switches the channel off again.
    if (await this.getCredential(SECRET_KEYS.slackWebhook)) channels.push('slack');
    if (config.emailEnabled) channels.push('email');

    return channels;
  }

  private dispatchInBackground(
    payload: DispatchPayload,
    channels: NotificationChannel[],
    deliveryIds: Map<NotificationChannel, string>,
  ): void {
    const task = (async () => {
      // allSettled, not all: one dead channel must not cancel the others.
      await Promise.allSettled(
        channels.map((channel) => {
          const deliveryId = deliveryIds.get(channel);
          return deliveryId ? this.attemptDelivery(payload, channel, deliveryId) : Promise.resolve();
        }),
      );
    })();
    this.inflight.add(task);
    void task
      .catch(() => undefined)
      .finally(() => {
        this.inflight.delete(task);
      });
  }

  /** Never throws: the outcome is written to the delivery row, not raised. */
  private async attemptDelivery(payload: DispatchPayload, channel: NotificationChannel, deliveryId: string): Promise<void> {
    try {
      await this.send(channel, payload);
      this.db.$raw
        .prepare(
          "UPDATE notification_deliveries SET status = 'delivered', attempts = attempts + 1, error = NULL, delivered_at = ? WHERE id = ?",
        )
        .run(this.now(), deliveryId);
    } catch (e) {
      const message = safeErrorText(e, 400);
      const row = this.db.$raw
        .prepare(
          "UPDATE notification_deliveries SET status = 'failed', attempts = attempts + 1, error = ? WHERE id = ? RETURNING attempts",
        )
        .get(message, deliveryId) as { attempts: number } | undefined;
      const attempts = row?.attempts ?? 0;
      if (attempts >= MAX_DELIVERY_ATTEMPTS) {
        this.db.$raw
          .prepare("UPDATE notification_deliveries SET status = 'abandoned' WHERE id = ?")
          .run(deliveryId);
      }
      this.log.warn({ channel, notificationId: payload.id, attempts, err: message }, 'notification delivery failed');
    }
  }

  private async send(channel: NotificationChannel, payload: DispatchPayload): Promise<void> {
    switch (channel) {
      case 'webhook':
        return this.sendWebhook(payload);
      case 'discord':
        return this.sendDiscord(payload);
      case 'telegram':
        return this.sendTelegram(payload);
      case 'slack':
        return this.sendSlack(payload);
      case 'email':
        // Unreachable: email rows are marked skipped at insert time and are
        // never dispatched. Kept exhaustive so a new channel cannot be silently
        // dropped by the switch.
        return;
    }
  }

  private async sendWebhook(payload: DispatchPayload): Promise<void> {
    const url = await this.requireCredential(SECRET_KEYS.genericWebhook, 'generic webhook URL');
    await this.client('webhook').request(url, {
      method: 'POST',
      responseType: 'text',
      // Many webhook receivers answer 2xx with an empty or non-JSON body, and
      // several answer 204; accept anything the client considers a success.
      body: {
        source: 'solcoin',
        id: payload.id,
        event: payload.event,
        severity: payload.severity,
        title: payload.title,
        body: payload.body,
        link: payload.link,
        data: payload.data,
        createdAt: payload.createdAt,
        createdAtIso: new Date(payload.createdAt).toISOString(),
      },
    });
  }

  private async sendDiscord(payload: DispatchPayload): Promise<void> {
    const url = await this.requireCredential(SECRET_KEYS.discordWebhook, 'Discord webhook URL');
    await this.client('discord').request(url, {
      method: 'POST',
      responseType: 'text',
      body: {
        username: 'solcoin',
        embeds: [
          {
            title: truncate(`${SEVERITY_EMOJI[payload.severity]} ${payload.title}`, 250),
            description: truncate(payload.link ? `${payload.body}\n\nOpen: \`${payload.link}\`` : payload.body, 4000),
            color: SEVERITY_COLOUR[payload.severity],
            timestamp: new Date(payload.createdAt).toISOString(),
            fields: embedFields(payload.data),
            footer: { text: `${payload.event} · ${payload.severity}` },
          },
        ],
      },
    });
  }

  private async sendTelegram(payload: DispatchPayload): Promise<void> {
    const token = await this.requireCredential(SECRET_KEYS.telegramBotToken, 'Telegram bot token');
    const chatId = await this.requireCredential(SECRET_KEYS.telegramChatId, 'Telegram chat id');
    const text = truncate(
      `${SEVERITY_EMOJI[payload.severity]} <b>${escapeHtml(payload.title)}</b>\n\n${escapeHtml(payload.body)}${
        payload.link ? `\n\n<code>${escapeHtml(payload.link)}</code>` : ''
      }`,
      4000,
    );
    await this.client('telegram').request(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      body: { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true },
    });
  }

  private async sendSlack(payload: DispatchPayload): Promise<void> {
    const url = await this.requireCredential(SECRET_KEYS.slackWebhook, 'Slack webhook URL');
    await this.client('slack').request(url, {
      method: 'POST',
      // Slack's incoming-webhook endpoint answers with the literal string "ok".
      responseType: 'text',
      body: {
        text: truncate(`${SEVERITY_EMOJI[payload.severity]} ${payload.title}`, 300),
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: truncate(payload.title, 148), emoji: true } },
          { type: 'section', text: { type: 'mrkdwn', text: truncate(payload.body, 2900) } },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `*${payload.severity}* · \`${payload.event}\`${payload.link ? ` · \`${payload.link}\`` : ''} · <!date^${Math.floor(
                  payload.createdAt / 1000,
                )}^{date_short_pretty} {time}|${new Date(payload.createdAt).toISOString()}>`,
              },
            ],
          },
        ],
      },
    });
  }

  private async requireCredential(key: string, label: string): Promise<string> {
    const value = await this.getCredential(key);
    if (!value) {
      throw new Error(`The ${label} is not configured (secret "${key}" is missing or the secret store is locked).`);
    }
    return value;
  }

  /**
   * Per-channel HTTP client.
   *
   * `maxRetries: 1` because this service owns retry policy: the delivery row is
   * the durable record, and `retryFailedDeliveries` spaces attempts over
   * minutes rather than the client's sub-second jitter.
   */
  private client(channel: NotificationChannel): HttpClient {
    const existing = this.clients.get(channel);
    if (existing) return existing;
    const created = new HttpClient({
      name: `notify:${channel}`,
      timeoutMs: 10_000,
      maxRetries: 1,
      // Telegram allows ~30 messages/second; the others are looser. This is far
      // above any rate this platform can generate and exists only as a bound.
      rateLimit: { requests: 20, intervalMs: TIME.minute, burst: 5 },
      circuitThreshold: 8,
      circuitCooldownMs: 5 * TIME.minute,
    });
    this.clients.set(channel, created);
    return created;
  }

  /** Event-handler entry point: an emitter must never see a notification error. */
  private async safeNotify(input: NotifyInput): Promise<void> {
    try {
      await this.notify(input);
    } catch (e) {
      this.log.error({ event: input.event, err: safeErrorText(e, 300) }, 'failed to record notification');
    }
  }

  /**
   * One honest sentence about a concept's modelled creator-fee outcome.
   *
   * The distribution is severely right-skewed — most launches earn close to
   * nothing and a rare one earns most of the total — so the mean on its own
   * would be a number almost no launch achieves. Median first, then the
   * 10th-90th percentile range, then the share of the mean that comes from the
   * extreme tail, and only then the mean itself. When there is no stored
   * prediction the sentence says so; it does not invent one.
   */
  private feeOutcomeSummary(conceptId: string): { text: string; data: Record<string, unknown> } {
    const row = this.db.$raw
      .prepare(
        `SELECT expected_value_sol, expected_creator_fees_sol, creator_fees_median_sol, creator_fees_p10_sol,
                creator_fees_p90_sol, tail_concentration, probability_profitable, confidence
           FROM predictions WHERE concept_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(conceptId) as
      | {
          expected_value_sol: number;
          expected_creator_fees_sol: number;
          creator_fees_median_sol: number;
          creator_fees_p10_sol: number;
          creator_fees_p90_sol: number;
          tail_concentration: number;
          probability_profitable: number;
          confidence: number;
        }
      | undefined;

    if (!row) {
      return {
        text: 'No stored prediction was found for this concept, so its modelled outcome distribution is unavailable here — open the candidate to see the numbers the quality gate actually used.',
        data: { outcomeDistribution: 'insufficient' },
      };
    }

    const tailPercent = Math.round(row.tail_concentration * 100);
    const text =
      `Modelled creator-fee outcome: a median of ${row.creator_fees_median_sol.toFixed(4)} SOL, with an 80% range of ` +
      `${row.creator_fees_p10_sol.toFixed(4)}-${row.creator_fees_p90_sol.toFixed(4)} SOL, and ${tailPercent}% of the mean ` +
      `coming from the top 1% of simulated outcomes. The mean expected value is ${row.expected_value_sol.toFixed(4)} SOL; ` +
      `because the distribution is that skewed, the median is the better guess for this one launch and the mean is only a ` +
      `ranking signal across many. The model puts the chance of ending up profitable at ${(row.probability_profitable * 100).toFixed(0)}% ` +
      `and rates its own confidence in this concept at ${(row.confidence * 100).toFixed(0)}%. Every figure here is a simulation ` +
      `output, not a forecast of what this token will do.`;

    return {
      text,
      data: {
        expectedCreatorFeesSol: row.expected_creator_fees_sol,
        medianCreatorFeesSol: row.creator_fees_median_sol,
        creatorFeesP10Sol: row.creator_fees_p10_sol,
        creatorFeesP90Sol: row.creator_fees_p90_sol,
        tailConcentration: row.tail_concentration,
        probabilityProfitable: row.probability_profitable,
        modelConfidence: row.confidence,
      },
    };
  }

  /**
   * Number of held-out outcomes a bundle's log loss was measured over, or null
   * when the bundle did not record one. Never guessed: an unknown holdout is
   * reported as unknown.
   */
  private holdoutSize(version: string): number | null {
    const row = this.db.$raw.prepare('SELECT metrics FROM model_versions WHERE version = ?').get(version) as
      | { metrics: string | null }
      | undefined;
    if (!row) return null;
    const metrics = parseJson<{ holdout?: unknown }>(row.metrics, {});
    return typeof metrics.holdout === 'number' && Number.isFinite(metrics.holdout) ? metrics.holdout : null;
  }

  /** "NAME ($TICKER)" for a mint, or null when the token is not known locally. */
  private tokenLabel(mint: string): string | null {
    const row = this.db.$raw.prepare('SELECT name, symbol FROM tokens WHERE mint = ?').get(mint) as
      | { name: string; symbol: string }
      | undefined;
    return row ? `${row.name} ($${row.symbol})` : null;
  }
}

function normaliseSeverity(value: string): NotificationSeverity {
  return value === 'critical' || value === 'warning' ? value : 'info';
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Discord permits ten embed fields; six keeps the card readable. */
function embedFields(data: Record<string, unknown>): Array<{ name: string; value: string; inline: boolean }> {
  return Object.entries(data)
    .filter(([key, value]) => key !== 'link' && value !== null && value !== undefined && typeof value !== 'object')
    .slice(0, 6)
    .map(([key, value]) => ({
      name: truncate(key, 250),
      value: truncate(typeof value === 'number' ? formatNumber(value) : String(value), 200) || '—',
      inline: true,
    }));
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  return value.toFixed(Math.abs(value) < 1 ? 6 : 3);
}
