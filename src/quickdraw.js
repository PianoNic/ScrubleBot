// QuickDraw doodle source — draw like a human by replaying a real Quick, Draw!
// drawing for the word's category, scaled to skribbl's canvas and emitted as
// op19 strokes. Lightweight: a ranged fetch grabs a few real doodles (not the
// whole multi-MB category file), no ML inference, same 345-category vocab as
// doodleNet. Replaces the unmaintained sketch-rnn lib (tfjs-version conflict).

import { strokesToSegments } from './strokes.js';

const BASE = 'https://storage.googleapis.com/quickdraw_dataset/full/simplified';
const CLASSES_URL = new URL('../data/doodlenet/class_names.txt', import.meta.url);

let CATEGORIES = null;     // Set<string> of drawable category names (lowercased)
const cache = new Map();   // category -> parsed drawings[]

async function categories() {
  if (CATEGORIES) return CATEGORIES;
  const text = await Bun.file(CLASSES_URL).text();
  CATEGORIES = new Set(
    text.split('\n')
      .map((s) => s.trim().replace(/_/g, ' ').toLowerCase())
      .filter(Boolean)
      // QuickDraw's proper-noun files use special casing we can't fetch — drop them.
      .filter((c) => !c.startsWith('the '))
  );
  return CATEGORIES;
}

/** Can we draw this word (is it a QuickDraw category)? */
export async function isDrawable(word) {
  return (await categories()).has(String(word).toLowerCase());
}

/** The full set of drawable category names (lowercased). */
export async function getCategories() {
  return categories();
}

/** Fetch (ranged) and cache a handful of real doodles for a category. */
async function fetchDrawings(category) {
  if (cache.has(category)) return cache.get(category);
  const url = `${BASE}/${encodeURIComponent(category)}.ndjson`;
  const res = await fetch(url, { headers: { Range: 'bytes=0-120000' } });
  if (!res.ok && res.status !== 206) throw new Error(`quickdraw ${category}: ${res.status}`);
  const text = await res.text();
  const drawings = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.lastIndexOf('}') < line.length - 1) continue; // skip truncated tail line
    try {
      const d = JSON.parse(line);
      if (d.recognized && Array.isArray(d.drawing)) drawings.push(d.drawing);
    } catch { /* partial line */ }
  }
  cache.set(category, drawings);
  return drawings;
}

/**
 * Get one real doodle for `word` as grouped op19 strokes, scaled/centred on the
 * canvas. Returns an array of strokes, each a list of [tool,color,width,x1,y1,x2,y2]
 * segments — caller can send stroke-by-stroke to look like live drawing.
 * @returns {Promise<number[][][]|null>} null if the word isn't drawable.
 */
export async function doodleStrokes(word, { color = 1, width = 8, index = null, targetSize = 540 } = {}) {
  const category = String(word).toLowerCase();
  if (!(await categories()).has(category)) return null;
  const drawings = await fetchDrawings(category);
  if (!drawings.length) return null;

  const pick = index != null ? index % drawings.length : Math.floor(Math.random() * drawings.length);
  return strokesToSegments(drawings[pick], { color, width, targetSize });
}
