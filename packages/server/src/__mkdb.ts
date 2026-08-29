import { getTableConfig } from 'drizzle-orm/sqlite-core';
import Database from 'better-sqlite3';
import * as schema from './db/schema.js';

const db = new Database('/tmp/claude-0/-home-user-solcoin/5205514c-fdd5-50fe-9e7c-5e2b6e4c0d74/scratchpad/test.db');
for (const [name, t] of Object.entries(schema as Record<string, any>)) {
  if (!t || typeof t !== 'object') continue;
  let cfg;
  try { cfg = getTableConfig(t as any); } catch { continue; }
  const cols = cfg.columns.map((c: any) => {
    const type = c.getSQLType();
    return `"${c.name}" ${type}`;
  });
  const pk = cfg.primaryKeys.flatMap((p: any) => p.columns.map((c: any) => `"${c.name}"`));
  const inlinePk = cfg.columns.filter((c: any) => c.primary).map((c: any) => `"${c.name}"`);
  const allPk = [...inlinePk, ...pk];
  if (allPk.length) cols.push(`PRIMARY KEY (${allPk.join(', ')})`);
  const ddl = `CREATE TABLE IF NOT EXISTS "${cfg.name}" (${cols.join(', ')})`;
  db.exec(ddl);
}
console.log(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r:any)=>r.name).join(','));
