import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, closeDatabase, type Db } from '../packages/server/src/db/client.js';
import { runMigrations } from '../packages/server/src/db/migrate.js';
import { createFixedClock } from '../packages/server/src/core/clock.js';
import { EventBus } from '../packages/server/src/core/events.js';
import { AuditLog } from '../packages/server/src/security/audit.js';
import { SettingsService } from '../packages/server/src/services/settings.service.js';
import { GuardService } from '../packages/server/src/services/guard.service.js';

/** A fixed instant so every test that formats or ages something is stable. */
export const T0 = Date.UTC(2026, 5, 15, 12, 0, 0);

export interface TestHarness {
  db: Db;
  clock: ReturnType<typeof createFixedClock>;
  events: EventBus;
  audit: AuditLog;
  settings: SettingsService;
  guard: GuardService;
  cleanup: () => void;
}

/**
 * A real database on a temporary file rather than an in-memory one.
 *
 * The platform relies on SQLite behaviour that differs between the two — WAL
 * mode, busy timeouts, incremental vacuum — and a test suite that exercises a
 * different engine configuration than production is testing the wrong thing.
 */
export function createHarness(): TestHarness {
  const dir = mkdtempSync(join(tmpdir(), 'solcoin-test-'));
  const db = openDatabase({ path: join(dir, 'test.db') });
  runMigrations(db);

  const clock = createFixedClock(T0);
  const now = () => clock.now();
  const events = new EventBus();
  const audit = new AuditLog(db, now);
  const settings = new SettingsService(db, audit, events, now);
  const guard = new GuardService(db, settings, audit, events, now);

  return {
    db,
    clock,
    events,
    audit,
    settings,
    guard,
    cleanup: () => {
      closeDatabase(db);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Collect events emitted during a block, for asserting on side effects. */
export function captureEvents<K extends Parameters<EventBus['on']>[0]>(
  bus: EventBus,
  event: K,
): { events: unknown[]; stop: () => void } {
  const collected: unknown[] = [];
  const stop = bus.on(event, (payload) => {
    collected.push(payload);
  });
  return { events: collected, stop };
}

export async function flushEvents(): Promise<void> {
  // The event bus dispatches through microtasks; two turns is enough for a
  // handler that itself awaits once.
  await Promise.resolve();
  await Promise.resolve();
}
