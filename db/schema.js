// Drizzle schema — the Postgres tables that replace the ndjson/JSON files.
//
//  drawings — one row per harvested (word → drawing) sample. Many bot containers
//             INSERT here concurrently; Postgres MVCC + the serial sequence make
//             that safe with no shared-file corruption (the old ndjson problem).
//  bots     — one row per harvester (its shard id), upserted with live counters
//             for the dashboard (rounds/guesses/wins/harvested + current lobby).

import { pgTable, serial, text, jsonb, bigint, integer, timestamp, index } from 'drizzle-orm/pg-core';

export const drawings = pgTable('drawings', {
  id: serial('id').primaryKey(),
  word: text('word').notNull(),
  drawing: jsonb('drawing').notNull(),          // [[xs,ys], …] pen polylines (display)
  colors: jsonb('colors').notNull().default([]), // palette index per polyline
  ops: jsonb('ops'),                             // ordered op19 pen+fill list (fills only)
  bot: text('bot').notNull().default(''),        // shard/instance that captured it
  ts: bigint('ts', { mode: 'number' }).notNull(),// epoch ms when harvested
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('drawings_word_idx').on(t.word),
  index('drawings_ts_idx').on(t.ts),
]);

export const bots = pgTable('bots', {
  id: text('id').primaryKey(),                   // shard id (container/instance)
  name: text('name').notNull().default(''),
  rounds: integer('rounds').notNull().default(0),
  guesses: integer('guesses').notNull().default(0),
  wins: integer('wins').notNull().default(0),
  harvested: integer('harvested').notNull().default(0),
  room: text('room').notNull().default(''),
  since: bigint('since', { mode: 'number' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
