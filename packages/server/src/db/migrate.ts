import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { loadEnv } from '../config/env.js';
import { closeDatabase, openDatabase, type Db } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Migrations folder resolution.
 *
 * The compiled build emits JavaScript to `dist/` but leaves the `.sql` files in
 * `src/db/migrations`, so we look in both places rather than duplicating them
 * into the build output.
 */
export function migrationsFolder(): string {
  const candidates = [
    resolve(here, 'migrations'),
    // The bundle is emitted to two depths: `dist/main.js` and `dist/cli/*.js`.
    // Only the second was covered, so the server itself found its migrations
    // solely because the third candidate happened to match when the process
    // was started from the repository root. Run it from anywhere else — a
    // systemd unit with a different WorkingDirectory, a container — and it
    // died on boot with "Can't find meta/_journal.json".
    resolve(here, '../src/db/migrations'),
    resolve(here, '../../src/db/migrations'),
    resolve(process.cwd(), 'packages/server/src/db/migrations'),
    resolve(process.cwd(), 'src/db/migrations'),
  ];
  for (const c of candidates) {
    // A migrations folder always contains the drizzle journal.
    if (existsSync(resolve(c, 'meta/_journal.json'))) return c;
  }
  return candidates[0]!;
}

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: migrationsFolder() });
}

/**
 * Standalone migration runner, invoked by `src/cli/migrate.ts`.
 *
 * Deliberately NOT guarded by an `import.meta.url === process.argv[1]` check:
 * the server is bundled into a single file, so that comparison is true for
 * every module in the bundle and would fire this CLI on every boot.
 */
export function migrateCli(): void {
  const env = loadEnv();
  const db = openDatabase({ path: env.DATABASE_PATH });
  runMigrations(db);
  // eslint-disable-next-line no-console
  console.log(`Migrations applied to ${env.DATABASE_PATH}`);
  closeDatabase(db);
}
