// Database connection — postgres.js pool wrapped by Drizzle.
//
// The whole DB layer is OPTIONAL: when DATABASE_URL is unset the bot/dashboard
// fall back to the legacy ndjson/JSON files, so nothing breaks for a quick local
// run or the test suite. When it's set, everything goes through Postgres.
//
// Each process keeps a small pool (DB_POOL, default 5). Many bot containers each
// open their own pool; Postgres serialises nothing at the row level, so their
// INSERTs into `drawings` run truly concurrently.

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

const URL = process.env.DATABASE_URL || '';
export const dbEnabled = !!URL;

let _sql = null;
let _db = null;
if (dbEnabled) {
  _sql = postgres(URL, {
    max: Number(process.env.DB_POOL || 5),
    idle_timeout: 30,
    connect_timeout: 15,
    onnotice: () => {},          // quiet "table already exists" style notices
  });
  _db = drizzle(_sql, { schema });
}

export const sql = _sql;
export const db = _db;
export { schema };

export async function closeDb() {
  if (_sql) { try { await _sql.end({ timeout: 5 }); } catch { /* ignore */ } }
}
