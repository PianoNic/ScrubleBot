// Render op19 segments to a grayscale PNG — for visualizing/debugging what the
// bot draws (and what its vision sees). Pure Bun + node:zlib, no native deps.

import zlib from 'node:zlib';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = data.length;
  const out = new Uint8Array(12 + len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  out.set([...type].map((ch) => ch.charCodeAt(0)), 4);
  out.set(data, 8);
  const typeAndData = out.subarray(4, 8 + len);
  dv.setUint32(8 + len, crc32(typeAndData));
  return out;
}

/** Encode an 8-bit grayscale buffer (length w*h) as a PNG Uint8Array. */
export function encodeGrayPng(gray, w, h) {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 0; // 8-bit, grayscale

  const raw = new Uint8Array(h * (w + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0; // filter: none
    raw.set(gray.subarray(y * w, y * w + w), y * (w + 1) + 1);
  }
  const idat = zlib.deflateSync(raw);

  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Rasterize op19 segments [[tool,color,width,x1,y1,x2,y2],…] to a PNG. */
export function renderSegmentsToPng(segments, { width = 800, height = 600, bg = 255, ink = 0 } = {}) {
  const buf = new Uint8Array(width * height).fill(bg);
  const stamp = (cx, cy, r) => {
    for (let y = cy - r; y <= cy + r; y++) {
      if (y < 0 || y >= height) continue;
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || x >= width) continue;
        buf[y * width + x] = ink;
      }
    }
  };
  const line = (x0, y0, x1, y1, r) => {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      stamp(x0, y0, r);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  };
  for (const s of segments) {
    if (!Array.isArray(s) || s.length < 7) continue;
    line(s[3], s[4], s[5], s[6], Math.max(1, Math.round((s[2] || 8) / 2)));
  }
  return encodeGrayPng(buf, width, height);
}
