import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema> & { $raw: Database.Database };

export interface DbOptions {
  path: string;
  readonly?: boolean;
  /** Verbose SQL logging; development only. */
  verbose?: boolean;
}

/**
 * Open the database.
 *
 * SQLite in WAL mode is a deliberate choice, not a shortcut. This platform is a
 * single-node system whose write volume is bounded by API rate limits, not by
 * storage: a few hundred writes per minute at peak. WAL gives concurrent
 * readers alongside a writer, `synchronous=NORMAL` is durable across process
 * crashes (only a power loss can lose the last transaction), and the entire
 * dataset is a single file that can be backed up with one atomic call.
 *
 * The repository layer never uses SQLite-specific SQL, so moving to Postgres
 * later is a driver swap rather than a rewrite.
 */
export function openDatabase(options: DbOptions): Db {
  const path = resolve(options.path);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const sqlite = new Database(path, {
    readonly: options.readonly ?? false,
    fileMustExist: false,
  });

  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  // Wait rather than immediately throwing SQLITE_BUSY when the writer is held.
  sqlite.pragma('busy_timeout = 5000');
  // 64 MiB page cache; the working set is small and this keeps analytics snappy.
  sqlite.pragma('cache_size = -64000');
  sqlite.pragma('temp_store = MEMORY');
  sqlite.pragma('mmap_size = 268435456');
  // Reclaim space from deleted observations without a full VACUUM.
  sqlite.pragma('auto_vacuum = INCREMENTAL');

  const db = drizzle(sqlite, { schema, logger: options.verbose ?? false }) as unknown as Db;
  Object.defineProperty(db, '$raw', { value: sqlite, enumerable: false });
  return db;
}

export function closeDatabase(db: Db): void {
  try {
    db.$raw.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // Checkpointing is best-effort; a locked database still closes cleanly.
  }
  db.$raw.close();
}

/** Online backup to a file, safe to run while the platform is serving traffic. */
export async function backupDatabase(db: Db, destination: string): Promise<{ bytes: number }> {
  mkdirSync(dirname(resolve(destination)), { recursive: true });
  await db.$raw.backup(resolve(destination));
  const size = db.$raw.prepare('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()').get() as
    | { bytes: number }
    | undefined;
  return { bytes: size?.bytes ?? 0 };
}

export { schema };
