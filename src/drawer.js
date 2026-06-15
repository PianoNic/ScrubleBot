// Drawer — Phase 3 will plug sketch-rnn in here. For now it provides just enough
// to survive our own turn (skribbl kicks an AFK drawer): pick the most-guessable
// offered word, and emit a placeholder scribble so the canvas isn't empty.

import { TOOL, CANVAS } from './protocol.js';

/**
 * Choose which of the 3 offered words to draw. Strongly prefers a word we can
 * actually draw (a QuickDraw category); breaks ties by how "picked"/guessable it
 * is. Falls back to the first option.
 * @param {string[]} words
 * @param {Map<string, number>} rankByKey  word.toLowerCase() -> picked score
 * @param {Set<string>|null} [drawable]    lowercased drawable categories
 * @returns {number} index into words
 */
export function pickWordIndex(words, rankByKey, drawable = null) {
  let best = 0, bestScore = -Infinity;
  words.forEach((w, i) => {
    const key = String(w).toLowerCase();
    const canDraw = drawable?.has(key) ? 1 : 0;
    const score = canDraw * 1e6 + (rankByKey.get(key) ?? 0); // drawable wins, then popularity
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return best;
}

/**
 * Placeholder art: a simple looping scribble in the middle of the canvas, as
 * op19 segments [tool,color,width,x1,y1,x2,y2]. Replaced by sketch-rnn in Phase 3.
 * @param {number} [color=1] palette index (1 = black)
 * @param {number} [width=12]
 * @returns {number[][]}
 */
export function placeholderStrokes(color = 1, width = 12) {
  const cx = CANVAS.width / 2, cy = CANVAS.height / 2, r = 120;
  const segs = [];
  let prev = null;
  for (let a = 0; a <= Math.PI * 6; a += Math.PI / 12) {
    const rad = r * (1 - a / (Math.PI * 8)); // shrinking spiral
    const p = [cx + Math.cos(a) * rad, cy + Math.sin(a) * rad];
    if (prev) segs.push([TOOL.PEN, color, width, prev[0] | 0, prev[1] | 0, p[0] | 0, p[1] | 0]);
    prev = p;
  }
  return segs;
}
