// Data-access layer — every DB read/write the bot and dashboard need lives here,
// so the rest of the code stays free of SQL. All functions assume dbEnabled.

import { and, count, desc, eq, ilike } from 'drizzle-orm';
import { db, schema } from './index.js';

const { drawings, bots } = schema;

/** Insert one harvested sample. Concurrent-safe across all bot containers. */
export async function insertDrawing(rec) {
  await db.insert(drawings).values({
    word: rec.word,
    drawing: rec.drawing,
    colors: rec.colors || [],
    ops: rec.ops ?? null,
    bot: rec.bot || '',
    ts: rec.ts || Date.now(),
  });
}

/** Bulk insert (used by the ndjson → DB migration). */
export async function insertMany(recs) {
  if (!recs.length) return;
  await db.insert(drawings).values(recs.map((r) => ({
    word: r.word, drawing: r.drawing, colors: r.colors || [],
    ops: r.ops ?? null, bot: r.bot || '', ts: r.ts || Date.now(),
  })));
}

/** word → count, for seeding the harvester's per-word cap. */
export async function loadWordCounts() {
  const rows = await db.select({ word: drawings.word, c: count() }).from(drawings).groupBy(drawings.word);
  return rows.map((r) => [r.word, Number(r.c)]);
}

export async function totalDrawings() {
  const [r] = await db.select({ c: count() }).from(drawings);
  return Number(r?.c || 0);
}

export async function recentDrawings(n = 24) {
  return db.select({ word: drawings.word, drawing: drawings.drawing, colors: drawings.colors, ts: drawings.ts })
    .from(drawings).orderBy(desc(drawings.ts)).limit(n);
}

export async function allDrawings(offset = 0, limit = 60, word = '', exact = false) {
  const wq = String(word || '').trim().toLowerCase();
  const where = wq ? (exact ? eq(drawings.word, wq) : ilike(drawings.word, `%${wq}%`)) : undefined;
  const [tot] = await db.select({ c: count() }).from(drawings).where(where);
  const items = await db.select({ word: drawings.word, drawing: drawings.drawing, colors: drawings.colors, ts: drawings.ts })
    .from(drawings).where(where).orderBy(desc(drawings.ts)).limit(limit).offset(offset);
  return { total: Number(tot?.c || 0), items };
}

/** [word, count] sorted desc — the dashboard word dropdown + "top words". */
export async function wordCounts() {
  const rows = await db.select({ word: drawings.word, c: count() }).from(drawings)
    .groupBy(drawings.word).orderBy(desc(count()));
  return rows.map((r) => [r.word, Number(r.c)]);
}

/** Upsert a bot's live counters (concurrent-safe via ON CONFLICT). */
export async function upsertBot(d) {
  const row = {
    id: d.id, name: d.name || '', rounds: d.rounds || 0, guesses: d.guesses || 0,
    wins: d.wins || 0, harvested: d.harvested || 0, room: d.room || '',
    since: d.since || Date.now(), updatedAt: new Date(),
  };
  await db.insert(bots).values(row).onConflictDoUpdate({
    target: bots.id,
    set: {
      name: row.name, rounds: row.rounds, guesses: row.guesses, wins: row.wins,
      harvested: row.harvested, room: row.room, updatedAt: row.updatedAt,
    },
  });
}

export async function listBots() {
  const rows = await db.select().from(bots).orderBy(desc(bots.updatedAt));
  const now = Date.now();
  return rows.map((r) => ({
    name: r.name, rounds: r.rounds, guesses: r.guesses, wins: r.wins,
    harvested: r.harvested, room: r.room, since: Number(r.since || 0),
    active: now - new Date(r.updatedAt).getTime() < 60000,
  }));
}
