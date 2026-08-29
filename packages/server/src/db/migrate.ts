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

async function main(): Promise<void> {
  const env = loadEnv();
  const db = openDatabase({ path: env.DATABASE_PATH });
  runMigrations(db);
  // eslint-disable-next-line no-console
  console.log(`Migrations applied to ${env.DATABASE_PATH}`);
  closeDatabase(db);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
}
