// Shared stroke geometry: convert between skribbl op19 segments and polyline
// "drawings" (QuickDraw-style [[xs,ys], …]), and fit a drawing onto the canvas.
// Used by the QuickDraw replay, the harvester (learning to draw), and rendering.

import { TOOL, CANVAS } from './protocol.js';

/**
 * Group a flat list of op19 segments [tool,color,width,x1,y1,x2,y2] into
 * polyline strokes. A new stroke starts wherever a segment doesn't continue
 * from the previous one (pen lift).
 * @returns {number[][][]} drawing as [[xs, ys], …]
 */
export function segmentsToStrokes(segments, tol = 2) {
  const strokes = [];
  let xs = null, ys = null, px = null, py = null;
  for (const s of segments) {
    if (!Array.isArray(s) || s.length < 7) continue;
    if (s[0] !== TOOL.PEN || s[1] === 0) continue; // skip non-pen / white ink
    const [, , , x1, y1, x2, y2] = s;
    if (xs === null || Math.abs(x1 - px) > tol || Math.abs(y1 - py) > tol) {
      if (xs && xs.length > 1) strokes.push([xs, ys]);
      xs = [x1]; ys = [y1];
    }
    xs.push(x2); ys.push(y2);
    px = x2; py = y2;
  }
  if (xs && xs.length > 1) strokes.push([xs, ys]);
  return strokes;
}

/** Bounding box over all points of a drawing, or null if empty. */
export function bbox(drawing) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [xs, ys] of drawing) {
    for (const x of xs) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
    for (const y of ys) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (!isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Fit a drawing (any coordinate range) onto the canvas and emit grouped op19
 * strokes — each an array of [tool,color,width,x1,y1,x2,y2] segments.
 * @returns {number[][][]|null}
 */
export function strokesToSegments(drawing, { color = 1, width = 8, targetSize = 540 } = {}) {
  const bb = bbox(drawing);
  if (!bb) return null;
  const bw = Math.max(1, bb.maxX - bb.minX), bh = Math.max(1, bb.maxY - bb.minY);
  const scale = targetSize / Math.max(bw, bh);
  const offX = (CANVAS.width - bw * scale) / 2 - bb.minX * scale;
  const offY = (CANVAS.height - bh * scale) / 2 - bb.minY * scale;
  const tx = (x) => Math.round(x * scale + offX);
  const ty = (y) => Math.round(y * scale + offY);

  const out = [];
  for (const [xs, ys] of drawing) {
    const segs = [];
    for (let i = 1; i < xs.length; i++) {
      segs.push([TOOL.PEN, color, width, tx(xs[i - 1]), ty(ys[i - 1]), tx(xs[i]), ty(ys[i])]);
    }
    if (segs.length) out.push(segs);
  }
  return out.length ? out : null;
}
