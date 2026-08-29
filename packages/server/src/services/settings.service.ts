import { eq } from 'drizzle-orm';
import {
  PlatformSettings,
  defaultSettings,
  isSensitiveSettingPath,
  HARD_LIMITS,
  type AutonomyCapability,
  type AutonomyLevel,
  type OperatingPhase,
} from '@solcoin/shared';
import { AppError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { componentLogger } from '../core/logger.js';
import { parseJson } from '../core/json.js';
import type { Db } from '../db/client.js';
import { settingHistory, settings } from '../db/schema.js';
import { AUDIT_ACTIONS, type AuditLog } from '../security/audit.js';
import type { EventBus } from '../core/events.js';

const SETTINGS_ROW_ID = 'current';

export interface SettingsActor {
  type: 'user' | 'system' | 'job';
  id?: string;
  label?: string;
  ipAddress?: string;
}

/**
 * Strategy configuration.
 *
 * Settings are cached in memory and invalidated on write, because the quality
 * gate reads them on every candidate and the jobs read them on every tick.
 *
 * Three invariants are enforced here rather than at the edges, so no caller can
 * bypass them:
 *  1. Values are clamped to absolute hard limits that no UI, API or model can
 *     exceed. A malfunctioning agent that sets `maxLaunchesPerDay` to 10,000
 *     gets the ceiling, not the request.
 *  2. Sensitive paths are audited with before/after values.
 *  3. Autonomy and phase can only be raised deliberately, and raising autonomy
 *     beyond what the current operating phase allows is rejected outright.
 */
export class SettingsService {
  private readonly log = componentLogger('settings');
  private cache: PlatformSettings | null = null;

  constructor(
    private readonly db: Db,
    private readonly audit: AuditLog,
    private readonly events: EventBus,
    private readonly now: () => number = Date.now,
  ) {}

  get(): PlatformSettings {
    if (this.cache) return this.cache;
    const row = this.db.$raw.prepare('SELECT value FROM settings WHERE id = ?').get(SETTINGS_ROW_ID) as
      | { value: string }
      | undefined;
    const parsed = row ? PlatformSettings.safeParse(parseJson(row.value, {})) : null;
    const value = parsed?.success ? parsed.data : defaultSettings();
    if (row && !parsed?.success) {
      this.log.warn('stored settings failed validation; falling back to defaults for the invalid fields');
    }
    this.cache = clampSettings(value);
    return this.cache;
  }

  /** Apply a partial update. Returns the new settings and the changed paths. */
  update(
    patch: Record<string, unknown>,
    actor: SettingsActor,
    reason?: string,
  ): { settings: PlatformSettings; changed: Array<{ path: string; from: unknown; to: unknown }> } {
    const current = this.get();
    const merged = deepMerge(structuredClone(current) as Record<string, unknown>, patch);
    const parsed = PlatformSettings.safeParse(merged);
    if (!parsed.success) {
      throw new AppError('validation_failed', 'The settings update is invalid.', {
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const next = clampSettings(parsed.data);
    this.assertPhaseAllowsAutonomy(next);

    const changed = diffPaths(current as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
    if (changed.length === 0) return { settings: current, changed: [] };

    const timestamp = this.now();
    this.db.$raw
      .prepare(
        `INSERT INTO settings (id, value, version, updated_at, updated_by)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET value = excluded.value, version = settings.version + 1,
                                       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(SETTINGS_ROW_ID, JSON.stringify(next), timestamp, actor.id ?? actor.type);

    for (const change of changed) {
      this.db
        .insert(settingHistory)
        .values({
          id: newId('sh', timestamp),
          path: change.path,
          previousValue: JSON.stringify(change.from ?? null),
          newValue: JSON.stringify(change.to ?? null),
          changedBy: actor.id ?? null,
          actorType: actor.type,
          reason: reason ?? null,
          createdAt: timestamp,
        })
        .run();
    }

    const sensitive = changed.filter((c) => isSensitiveSettingPath(c.path));
    if (sensitive.length > 0) {
      this.audit.record({
        actorType: actor.type,
        actorId: actor.id ?? null,
        actorLabel: actor.label ?? null,
        action: AUDIT_ACTIONS.settingsChanged,
        targetType: 'settings',
        targetId: SETTINGS_ROW_ID,
        parameters: { changes: sensitive },
        reason: reason ?? null,
        ipAddress: actor.ipAddress ?? null,
      });
    }

    this.cache = next;

    const emergencyChange = changed.find((c) => c.path === 'emergencyStop');
    if (emergencyChange) {
      this.audit.record({
        actorType: actor.type,
        actorId: actor.id ?? null,
        actorLabel: actor.label ?? null,
        action: next.emergencyStop ? AUDIT_ACTIONS.emergencyStop : AUDIT_ACTIONS.emergencyRelease,
        targetType: 'system',
        targetId: 'emergency_stop',
        reason: reason ?? next.emergencyStopReason,
        ipAddress: actor.ipAddress ?? null,
      });
      this.events.emit('system.emergency_stop', {
        engaged: next.emergencyStop,
        reason: reason ?? next.emergencyStopReason,
        actor: actor.label ?? actor.id ?? actor.type,
      });
    }

    const phaseChange = changed.find((c) => c.path === 'execution.phase');
    if (phaseChange) {
      this.audit.record({
        actorType: actor.type,
        actorId: actor.id ?? null,
        actorLabel: actor.label ?? null,
        action: AUDIT_ACTIONS.phaseChanged,
        targetType: 'system',
        targetId: 'phase',
        parameters: { from: phaseChange.from, to: phaseChange.to },
        reason: reason ?? null,
      });
    }

    this.log.info({ changed: changed.map((c) => c.path), actor: actor.type }, 'settings updated');
    return { settings: next, changed };
  }

  /** Engage the global kill switch. Deliberately its own method, not a patch. */
  emergencyStop(reason: string, actor: SettingsActor): PlatformSettings {
    return this.update({ emergencyStop: true, emergencyStopReason: reason }, actor, reason).settings;
  }

  releaseEmergencyStop(reason: string, actor: SettingsActor): PlatformSettings {
    return this.update({ emergencyStop: false, emergencyStopReason: '' }, actor, reason).settings;
  }

  autonomyFor(capability: AutonomyCapability): AutonomyLevel {
    return this.get().autonomy[capability];
  }

  /**
   * The phased-activation ladder.
   *
   * Higher phases unlock more autonomy, and the mapping is enforced rather than
   * advisory: reaching phase 4 is the only way `autonomy.launch = auto` can be
   * set at all.
   */
  private assertPhaseAllowsAutonomy(next: PlatformSettings): void {
    const phase = next.execution.phase;
    const network = next.execution.network;

    const maxAutonomy: Record<OperatingPhase, AutonomyLevel> = {
      phase1_research: 'suggest',
      phase2_devnet: 'approve',
      phase3_mainnet_approval: 'approve',
      phase4_limited_autonomous: 'auto',
      phase5_adaptive_autonomous: 'auto',
    };
    const allowedNetworks: Record<OperatingPhase, PlatformSettings['execution']['network'][]> = {
      phase1_research: ['simulation'],
      phase2_devnet: ['simulation', 'devnet'],
      phase3_mainnet_approval: ['simulation', 'devnet', 'mainnet'],
      phase4_limited_autonomous: ['simulation', 'devnet', 'mainnet'],
      phase5_adaptive_autonomous: ['simulation', 'devnet', 'mainnet'],
    };

    if (!allowedNetworks[phase].includes(network)) {
      throw new AppError(
        'forbidden',
        `Network "${network}" is not permitted in ${phase}. Advance the operating phase first — this ordering is what prevents an accidental mainnet launch.`,
      );
    }

    const rank: Record<AutonomyLevel, number> = { off: 0, suggest: 1, approve: 2, auto: 3 };
    const ceiling = rank[maxAutonomy[phase]];
    for (const capability of ['launch', 'fee_collection', 'wallet_transfer'] as const) {
      if (rank[next.autonomy[capability]] > ceiling) {
        throw new AppError(
          'forbidden',
          `Autonomy "${next.autonomy[capability]}" for ${capability} exceeds what ${phase} allows (maximum "${maxAutonomy[phase]}"). Advance the operating phase deliberately if this is intended.`,
        );
      }
    }
  }

  invalidate(): void {
    this.cache = null;
  }
}

/**
 * Clamp settings to absolute ceilings.
 *
 * These are the values no code path can exceed — not the UI, not the API, not a
 * model-driven update. They exist so that a bug or a compromised credential
 * cannot turn a bounded system into an unbounded one.
 */
export function clampSettings(value: PlatformSettings): PlatformSettings {
  const next = structuredClone(value);
  next.limits.maxLaunchesPerDay = Math.min(next.limits.maxLaunchesPerDay, HARD_LIMITS.maxLaunchesPerDayAbsolute);
  next.limits.maxLaunchesPerHour = Math.min(next.limits.maxLaunchesPerHour, next.limits.maxLaunchesPerDay);
  next.limits.maxSolPerTransaction = Math.min(next.limits.maxSolPerTransaction, HARD_LIMITS.maxSolPerTransactionAbsolute);
  next.limits.maxSolSpendPerDay = Math.min(next.limits.maxSolSpendPerDay, HARD_LIMITS.maxSolPerDayAbsolute);
  next.limits.maxSolPerHour = Math.min(next.limits.maxSolPerHour, next.limits.maxSolSpendPerDay);
  next.limits.maxAiSpendUsdPerDay = Math.min(next.limits.maxAiSpendUsdPerDay, HARD_LIMITS.maxAiSpendUsdPerDayAbsolute);
  next.research.conceptsPerOpportunity = Math.min(next.research.conceptsPerOpportunity, 12);
  next.execution.devBuySol = Math.min(next.execution.devBuySol, next.limits.maxSolPerTransaction);
  return next;
}

function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const existing = target[key];
      target[key] =
        existing && typeof existing === 'object' && !Array.isArray(existing)
          ? deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>)
          : value;
    } else {
      target[key] = value;
    }
  }
  return target;
}

function diffPaths(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix = '',
): Array<{ path: string; from: unknown; to: unknown }> {
  const changes: Array<{ path: string; from: unknown; to: unknown }> = [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const a = before?.[key];
    const b = after?.[key];
    const bothObjects =
      a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b);
    if (bothObjects) {
      changes.push(...diffPaths(a as Record<string, unknown>, b as Record<string, unknown>, path));
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes.push({ path, from: a, to: b });
    }
  }
  return changes;
}
