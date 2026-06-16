// DoodleHarvester — the "learning while playing" core. While the bot guesses in
// a round someone else is drawing, we buffer the incoming op19 strokes; when the
// word is revealed at round end we append a labelled sample to disk. Over many
// public games this builds a growing dataset of real human (word → drawing)
// pairs that powers both drawing new words (replay) and detecting them (few-shot).

import { appendFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { segmentsToColoredStrokes } from './strokes.js';

const DIR = new URL('../data/harvest/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// Each process writes its own shard when BOT_SHARD=1 (or BOT_INSTANCE is set), so
// many harvest bots can run at once without corrupting a shared append file. The
// trainer/loader read every `samples*.ndjson`.
const SHARD = (process.env.BOT_INSTANCE
  || (process.env.BOT_SHARD === '1' ? (process.env.HOSTNAME || process.pid) : ''))
  .toString().replace(/[^A-Za-z0-9_-]/g, '');
const FILE = `${DIR}samples${SHARD ? '.' + SHARD : ''}.ndjson`;
const MAX_PER_WORD = 200; // bound disk growth per category (per shard)

export class DoodleHarvester {
  constructor() {
    this.segments = [];
    this.counts = new Map();   // word -> samples saved
    this.total = 0;
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    this._loadIndex();
  }

  _loadIndex() {
    // count across all shards so the "harvested N" stat reflects the whole fleet
    let files = [];
    try { files = readdirSync(DIR).filter((f) => /^samples.*\.ndjson$/.test(f)); } catch { return; }
    for (const f of files) {
      try {
        for (const line of readFileSync(DIR + f, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          const w = JSON.parse(line).word;
          if (w) { this.counts.set(w, (this.counts.get(w) || 0) + 1); this.total++; }
        }
      } catch { /* ignore a partial file */ }
    }
  }

  startRound() { this.segments = []; }
  add(segments) { if (Array.isArray(segments)) for (const s of segments) this.segments.push(s); }

  /**
   * Save the buffered drawing under the revealed word.
   * @param {string} word  the round's answer (from roundEnd)
   * @returns {{saved:boolean, word?:string, strokes?:number, total?:number}}
   */
  finish(word) {
    if (typeof word !== 'string' || !word.trim() || this.segments.length < 3) return { saved: false };
    const key = word.toLowerCase();
    if ((this.counts.get(key) || 0) >= MAX_PER_WORD) return { saved: false };

    const { drawing, colors } = segmentsToColoredStrokes(this.segments);
    this.segments = [];
    if (!drawing.length) return { saved: false };

    // `colors` (parallel to `drawing`) lets the trainer rebuild a color-accurate
    // RGB raster; older samples without it default to black at train time.
    appendFileSync(FILE, JSON.stringify({ word: key, drawing, colors, ts: Date.now() }) + '\n');
    this.counts.set(key, (this.counts.get(key) || 0) + 1);
    this.total++;
    return { saved: true, word: key, strokes: drawing.length, total: this.total };
  }

  has(word) { return this.counts.has(String(word).toLowerCase()); }
  get words() { return this.counts.size; }
  stats() { return { total: this.total, words: this.counts.size }; }
}
