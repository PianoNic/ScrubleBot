// Use what the bot has harvested: replay learned drawings (draw words QuickDraw
// doesn't cover) and few-shot detection (recognize learned words by matching the
// doodleNet "fingerprint" of the live canvas to harvested examples).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { strokesToSegments } from './strokes.js';
import { StrokeCanvas } from './canvas.js';

const DIR = new URL('../data/harvest/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

let CACHE = null; // word -> drawing[] (lazy)

function loadHarvest() {
  if (CACHE) return CACHE;
  CACHE = new Map();
  if (!existsSync(DIR)) return CACHE;
  const files = readdirSync(DIR).filter((f) => /^samples.*\.ndjson$/.test(f)); // every shard
  for (const f of files) {
    for (const line of readFileSync(DIR + f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const { word, drawing } = JSON.parse(line);
        if (!word || !Array.isArray(drawing)) continue;
        if (!CACHE.has(word)) CACHE.set(word, []);
        CACHE.get(word).push(drawing);
      } catch { /* skip */ }
    }
  }
  return CACHE;
}

export function harvestHas(word) { return loadHarvest().has(String(word).toLowerCase()); }

/** Replay a harvested human drawing of `word` as op19 strokes, or null. */
export function learnedStrokes(word, { color = 1, width = 8 } = {}) {
  const list = loadHarvest().get(String(word).toLowerCase());
  if (!list?.length) return null;
  const drawing = list[Math.floor(Math.random() * list.length)];
  return strokesToSegments(drawing, { color, width });
}

/** Render a polyline drawing to doodleNet's 28×28 input. */
function drawingToGrid(drawing) {
  const segs = strokesToSegments(drawing, { width: 8 });
  if (!segs) return null;
  const c = new StrokeCanvas();
  for (const s of segs) c.add(s);
  return c.toGrid28();
}

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
};

/**
 * Few-shot detector: embeds harvested drawings via doodleNet's output vector and
 * nearest-neighbours the live canvas against them — recognizing words beyond the
 * fixed 345 classes, from as little as one example.
 */
export class FewShotDetector {
  constructor(doodleNet, { maxPerWord = 8, maxTotal = 4000 } = {}) {
    this.net = doodleNet;
    this.maxPerWord = maxPerWord;
    this.maxTotal = maxTotal;
    this.lib = []; // { word, vec }
  }

  /** Build the library from the harvest (call once at startup). */
  build() {
    const harvest = loadHarvest();
    const perWord = new Map();
    for (const [word, drawings] of harvest) {
      for (const drawing of drawings) {
        if (this.lib.length >= this.maxTotal) break;
        if ((perWord.get(word) || 0) >= this.maxPerWord) break;
        const grid = drawingToGrid(drawing);
        if (!grid) continue;
        this.lib.push({ word, vec: this.net.vector(grid) });
        perWord.set(word, (perWord.get(word) || 0) + 1);
      }
    }
    return this.lib.length;
  }

  /** Match the live canvas; returns ranked { label, prob } like classify(). */
  match(grid784, topK = 5, threshold = 0.6) {
    if (!this.lib.length) return [];
    const q = this.net.vector(grid784);
    const best = new Map(); // word -> max cosine
    for (const { word, vec } of this.lib) {
      const s = cosine(q, vec);
      if (s > (best.get(word) ?? -1)) best.set(word, s);
    }
    return [...best.entries()]
      .filter(([, s]) => s >= threshold)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([label, prob]) => ({ label, prob }));
  }
}
