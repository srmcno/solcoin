import { migrateCli } from '../db/migrate.js';

/** Entry point for `npm run db:migrate`. */
try {
  migrateCli();
} catch (e) {
  // eslint-disable-next-line no-console
  console.error('Migration failed:', e instanceof Error ? e.stack : e);
  process.exit(1);
}
