// DoodleHarvester — the "learning while playing" core. While the bot guesses in
// a round someone else is drawing, we buffer the incoming op19 strokes; when the
// word is revealed at round end we append a labelled sample to disk. Over many
// public games this builds a growing dataset of real human (word → drawing)
// pairs that powers both drawing new words (replay) and detecting them (few-shot).

import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { segmentsToStrokes } from './strokes.js';

const DIR = new URL('../data/harvest/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const FILE = `${DIR}samples.ndjson`;
const MAX_PER_WORD = 200; // bound disk growth per category

export class DoodleHarvester {
  constructor() {
    this.segments = [];
    this.counts = new Map();   // word -> samples saved
    this.total = 0;
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    this._loadIndex();
  }

  _loadIndex() {
    if (!existsSync(FILE)) return;
    try {
      for (const line of readFileSync(FILE, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const w = JSON.parse(line).word;
        if (w) { this.counts.set(w, (this.counts.get(w) || 0) + 1); this.total++; }
      }
    } catch { /* ignore a partial file */ }
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

    const drawing = segmentsToStrokes(this.segments);
    this.segments = [];
    if (!drawing.length) return { saved: false };

    appendFileSync(FILE, JSON.stringify({ word: key, drawing, ts: Date.now() }) + '\n');
    this.counts.set(key, (this.counts.get(key) || 0) + 1);
    this.total++;
    return { saved: true, word: key, strokes: drawing.length, total: this.total };
  }

  has(word) { return this.counts.has(String(word).toLowerCase()); }
  get words() { return this.counts.size; }
  stats() { return { total: this.total, words: this.counts.size }; }
}
