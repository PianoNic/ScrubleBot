// StrokeCanvas — accumulate skribbl op19 segments and rasterize them to the
// 28×28 grayscale bitmap doodleNet expects (strokes ≈ 1 on a 0 background).
//
// To match QuickDraw's preprocessing we bounding-box the drawing, scale it to
// fit a centered square, render at high resolution, then box-downsample to 28×28
// for anti-aliasing — this matters a lot for recognition quality.

import { TOOL, colorRGB } from './protocol.js';

const HI = 280;        // high-res raster size
const OUT = 28;        // model input size
const POOL = HI / OUT; // 10
const MARGIN = 0.12;   // fraction of padding around the drawing

export class StrokeCanvas {
  constructor() { this.segments = []; }

  /** Add op19 segments — pen [0,color,width,x1,y1,x2,y2] and fill [1,color,x,y],
   *  preserving order (a fill colors the region as it was at that moment). */
  add(segments) {
    if (!Array.isArray(segments)) return;
    for (const s of segments) {
      if (!Array.isArray(s)) continue;
      if (s[0] === TOOL.PEN && s.length >= 7) {
        if (s[1] === 0) continue;      // skip white ink (eraser/background)
        this.segments.push(s);
      } else if (s[0] === TOOL.FILL && s.length >= 4) {
        this.segments.push(s);         // [1, color, x, y]
      }
    }
  }

  clear() { this.segments = []; }
  get isEmpty() { return this.segments.length === 0; }

  /** Bounding box over the pen strokes (fills don't define the shape), or null. */
  _bbox() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
    for (const s of this.segments) {
      if (s[0] !== TOOL.PEN || s.length < 7) continue;
      const [, , , x1, y1, x2, y2] = s;
      minX = Math.min(minX, x1, x2); maxX = Math.max(maxX, x1, x2);
      minY = Math.min(minY, y1, y2); maxY = Math.max(maxY, y1, y2);
      any = true;
    }
    return any ? { minX, minY, maxX, maxY } : null;
  }

  /**
   * Rasterize to a length-784 Float32Array (28×28), values 0..1.
   * @returns {Float32Array|null} null if nothing has been drawn yet.
   */
  toGrid28() {
    const bb = this._bbox();
    if (!bb) return null;

    const w = Math.max(1, bb.maxX - bb.minX);
    const h = Math.max(1, bb.maxY - bb.minY);
    const span = Math.max(w, h);
    const scale = (HI * (1 - 2 * MARGIN)) / span;
    // center the (possibly non-square) drawing within the HI×HI raster
    const offX = (HI - w * scale) / 2 - bb.minX * scale;
    const offY = (HI - h * scale) / 2 - bb.minY * scale;
    const tx = (x) => x * scale + offX;
    const ty = (y) => y * scale + offY;

    const hi = new Float32Array(HI * HI);
    const radius = Math.max(1, Math.round(0.9 * POOL)); // stroke half-thickness in hi-res px
    for (const s of this.segments) {                    // pen only — doodleNet wants line-art
      if (s[0] !== TOOL.PEN || s.length < 7) continue;
      this._line(hi, tx(s[3]), ty(s[4]), tx(s[5]), ty(s[6]), radius);
    }

    // box-downsample HI×HI -> 28×28 (average pooling = cheap anti-aliasing)
    const out = new Float32Array(OUT * OUT);
    for (let oy = 0; oy < OUT; oy++) {
      for (let ox = 0; ox < OUT; ox++) {
        let sum = 0;
        for (let py = 0; py < POOL; py++) {
          const yy = oy * POOL + py;
          for (let px = 0; px < POOL; px++) sum += hi[yy * HI + (ox * POOL + px)];
        }
        let v = sum / (POOL * POOL);
        out[oy * OUT + ox] = v > 1 ? 1 : v;
      }
    }
    return out;
  }

  /**
   * Color-aware raster for the from-scratch detector: an RGB image on a white
   * canvas using each stroke's real palette color, so the model can learn color
   * semantics (brown + green ≈ plant). Same bbox-fit normalization as toGrid28.
   * @param {number} [out=28] output side length
   * @returns {Float32Array|null} length 3*out*out, CHW order (R plane, G, B), 0..1
   */
  toRGB(out = OUT) {
    const bb = this._bbox();
    if (!bb) return null;
    const pool = HI / out;

    const w = Math.max(1, bb.maxX - bb.minX);
    const h = Math.max(1, bb.maxY - bb.minY);
    const span = Math.max(w, h);
    const scale = (HI * (1 - 2 * MARGIN)) / span;
    const offX = (HI - w * scale) / 2 - bb.minX * scale;
    const offY = (HI - h * scale) / 2 - bb.minY * scale;
    const tx = (x) => x * scale + offX;
    const ty = (y) => y * scale + offY;

    // hi-res RGB, white background (1,1,1). Process ops IN ORDER so a fill colors
    // the region as it was at that moment and later strokes draw over it.
    const hi = new Float32Array(HI * HI * 3).fill(1);
    const radius = Math.max(1, Math.round(0.9 * pool));
    for (const s of this.segments) {
      if (s[0] === TOOL.PEN && s.length >= 7) {
        this._lineRGB(hi, tx(s[3]), ty(s[4]), tx(s[5]), ty(s[6]), radius, colorRGB(s[1]));
      } else if (s[0] === TOOL.FILL && s.length >= 4) {
        this._fillRGB(hi, Math.round(tx(s[2])), Math.round(ty(s[3])), colorRGB(s[1]));
      }
    }

    // box-downsample per channel into CHW output
    const res = new Float32Array(3 * out * out);
    const plane = out * out;
    for (let oy = 0; oy < out; oy++) {
      for (let ox = 0; ox < out; ox++) {
        let r = 0, g = 0, b = 0;
        for (let py = 0; py < pool; py++) {
          const yy = oy * pool + py;
          for (let px = 0; px < pool; px++) {
            const i = (yy * HI + (ox * pool + px)) * 3;
            r += hi[i]; g += hi[i + 1]; b += hi[i + 2];
          }
        }
        const n = pool * pool, o = oy * out + ox;
        res[o] = r / n;                 // R plane
        res[plane + o] = g / n;         // G plane
        res[2 * plane + o] = b / n;     // B plane
      }
    }
    return res;
  }

  /** Flood-fill the region at (px,py) with rgb (4-connectivity, exact-color). */
  _fillRGB(buf, px, py, rgb) {
    if (px < 0 || px >= HI || py < 0 || py >= HI) return;
    const at = (x, y) => (y * HI + x) * 3;
    const i0 = at(px, py);
    const tr = buf[i0], tg = buf[i0 + 1], tb = buf[i0 + 2];   // colour we're replacing
    if (tr === rgb[0] && tg === rgb[1] && tb === rgb[2]) return;
    const stack = [px, py];
    while (stack.length) {
      const y = stack.pop(), x = stack.pop();
      if (x < 0 || x >= HI || y < 0 || y >= HI) continue;
      const i = at(x, y);
      if (buf[i] !== tr || buf[i + 1] !== tg || buf[i + 2] !== tb) continue;
      buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2];
      stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
    }
  }

  /** Stamp a thick colored line into the hi-res RGB buffer. */
  _lineRGB(buf, x0, y0, x1, y1, r, rgb) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      for (let y = y0 - r; y <= y0 + r; y++) {
        if (y < 0 || y >= HI) continue;
        for (let x = x0 - r; x <= x0 + r; x++) {
          if (x < 0 || x >= HI) continue;
          const i = (y * HI + x) * 3;
          buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2];
        }
      }
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  /** Stamp a thick line into the hi-res buffer (Bresenham + square brush). */
  _line(buf, x0, y0, x1, y1, r) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      this._stamp(buf, x0, y0, r);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  _stamp(buf, cx, cy, r) {
    for (let y = cy - r; y <= cy + r; y++) {
      if (y < 0 || y >= HI) continue;
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || x >= HI) continue;
        buf[y * HI + x] = 1;
      }
    }
  }
}
