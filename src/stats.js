// Tiny per-process stats recorder for the dashboard. Counters (rounds watched,
// guesses, wins, harvested, current lobby) with a debounced save. When
// DATABASE_URL is set it upserts a row in the `bots` table (concurrent-safe via
// ON CONFLICT); otherwise it falls back to data/harvest/stats.<shard>.json.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dbEnabled } from '../db/index.js';

const DIR = new URL('../data/harvest/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SHARD = (process.env.BOT_INSTANCE
  || (process.env.BOT_SHARD === '1' ? (process.env.HOSTNAME || process.pid) : ''))
  .toString().replace(/[^A-Za-z0-9_-]/g, '') || 'main';
const FILE = `${DIR}stats.${SHARD}.json`;

export class Stats {
  constructor(name) {
    this.d = { name, rounds: 0, guesses: 0, wins: 0, harvested: 0, since: Date.now() };
    if (!dbEnabled) {
      try { if (existsSync(FILE)) Object.assign(this.d, JSON.parse(readFileSync(FILE, 'utf8'))); } catch { /* fresh */ }
    }
    this.d.name = name;          // keep the current display name
    this._t = null;
    this._save();
  }

  set(k, v) { this.d[k] = v; this._save(); }
  inc(k, by = 1) { this.d[k] = (this.d[k] || 0) + by; this._save(); }

  _save() {
    if (this._t) return;          // debounce bursts of updates
    this._t = setTimeout(() => {
      this._t = null;
      if (dbEnabled) {
        import('../db/queries.js')
          .then(({ upsertBot }) => upsertBot({ id: SHARD, ...this.d }))
          .catch((e) => console.error('stats: DB upsert failed:', e.message));
      } else {
        try { writeFileSync(FILE, JSON.stringify(this.d)); } catch { /* ignore */ }
      }
    }, 1500);
  }
}
