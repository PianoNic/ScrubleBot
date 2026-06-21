// One-shot migration of the legacy data/harvest/*.ndjson shards into Postgres.
// Idempotent-ish: skips entirely if the drawings table already has rows, so the
// migrate container can run on every boot without duplicating the dataset.
//   DATABASE_URL=… bun run db/import-ndjson.js

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dbEnabled, closeDb } from './index.js';
import { insertMany, totalDrawings } from './queries.js';

const DIR = new URL('../data/harvest/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const BATCH = 500;

export async function importNdjson() {
  if (!dbEnabled) { console.error('DATABASE_URL not set'); return; }
  if (!existsSync(DIR)) { console.log('no data/harvest dir — skipping import'); return; }

  const existing = await totalDrawings();
  if (existing > 0) { console.log(`drawings table already has ${existing} rows — skipping ndjson import`); return; }

  const files = readdirSync(DIR).filter((f) => /^samples.*\.ndjson$/.test(f));
  if (!files.length) { console.log('no ndjson shards to import'); return; }

  let batch = [], imported = 0;
  for (const f of files) {
    const shard = (f.match(/^samples(?:\.(.+))?\.ndjson$/) || [])[1] || '';
    for (const line of readFileSync(DIR + f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (!o || !Array.isArray(o.drawing) || !o.word) continue;
      batch.push({ word: o.word, drawing: o.drawing, colors: o.colors || [], ops: o.ops ?? null, bot: shard, ts: o.ts || Date.now() });
      if (batch.length >= BATCH) { await insertMany(batch); imported += batch.length; batch = []; process.stdout.write(`\r  imported ${imported}…`); }
    }
  }
  if (batch.length) { await insertMany(batch); imported += batch.length; }
  console.log(`\n✅ imported ${imported} drawings from ${files.length} shard(s)`);
}

// Allow running standalone too.
if (import.meta.main) { await importNdjson(); await closeDb(); }
