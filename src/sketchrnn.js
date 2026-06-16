// SketchRNN generator (ONNX) — draw a learned word ourselves instead of replaying
// QuickDraw. The Python trainer exports only the single decoder *step*
// (point, class, h, c) -> (mdn params, h, c); the autoregressive loop and the
// Mixture-Density sampling live here in Bun (per the plan — keeps the ONNX graph
// trivial and the stochastic loop in JS).
//
// Output is a drawing [[xs, ys], …] in arbitrary coords; the caller fits it to the
// canvas with strokesToSegments. Gated by BOT_MODELS, no-op until trained.

import { existsSync, readFileSync, statSync } from 'node:fs';

const MODEL = new URL('../data/model/generator.onnx', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const META = new URL('../data/model/generator.meta.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const gauss = () => {
  // Box–Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

function sampleIndex(probs) {
  const r = Math.random();
  let acc = 0;
  for (let i = 0; i < probs.length; i++) { acc += probs[i]; if (r < acc) return i; }
  return probs.length - 1;
}

function softmax(a, temp = 1) {
  let max = -Infinity;
  for (const v of a) if (v > max) max = v;
  let sum = 0;
  const out = a.map((v) => { const e = Math.exp((v - max) / temp); sum += e; return e; });
  return out.map((e) => e / (sum || 1));
}

export class SketchGenerator {
  constructor() {
    this.ort = null;
    this.session = null;
    this.meta = null;
    this.mtime = 0;
    this.ready = false;
    this.vocabSet = new Set();
  }

  async load() {
    if (!existsSync(MODEL) || !existsSync(META)) return this;
    try { this.ort = await import('onnxruntime-node'); }
    catch { try { this.ort = await import('onnxruntime-web'); } catch { return this; } }
    await this._open();
    return this;
  }

  async _open() {
    this.meta = JSON.parse(readFileSync(META, 'utf8'));
    this.session = await this.ort.InferenceSession.create(MODEL);
    this.mtime = statSync(MODEL).mtimeMs;
    this.vocabSet = new Set(this.meta.vocab);
    this.ready = true;
  }

  async maybeReload() {
    if (!this.ort || !existsSync(MODEL)) return false;
    if (statSync(MODEL).mtimeMs <= this.mtime) return false;
    try { await this._open(); return true; } catch { return false; }
  }

  get enabled() { return this.ready; }
  knows(word) { return this.vocabSet.has(String(word).toLowerCase()); }

  /**
   * Sample a drawing of `word`.
   * @returns {Promise<number[][][]|null>} drawing [[xs,ys],…], or null if unknown.
   */
  async draw(word, { temperature = 0.4 } = {}) {
    if (!this.ready) return null;
    const key = String(word).toLowerCase();
    const ci = this.meta.vocab.indexOf(key);
    if (ci < 0) return null;

    const { hidden, mixtures: M, max_len, scale, vocab } = this.meta;
    const T = this.ort.Tensor;
    const cond = new Float32Array(vocab.length); cond[ci] = 1;
    let h = new Float32Array(hidden), c = new Float32Array(hidden);
    let point = new Float32Array([0, 0, 1, 0, 0]); // start token (pen down at origin)

    const strokes = [];
    let xs = [0], ys = [0], x = 0, y = 0;

    for (let t = 0; t < max_len; t++) {
      const out = await this.session.run({
        point: new T('float32', point, [1, 1, 5]),
        cond: new T('float32', cond, [1, 1, vocab.length]),
        h: new T('float32', h, [1, 1, hidden]),
        c: new T('float32', c, [1, 1, hidden]),
      });
      const p = out.params.data;
      h = out.hn.data; c = out.cn.data;

      // unpack [pi(M), mux(M), muy(M), sx(M), sy(M), rho(M), pen(3)]
      const pi = softmax(Array.from(p.slice(0, M)), temperature);
      const k = sampleIndex(pi);
      const mux = p[M + k], muy = p[2 * M + k];
      const sx = Math.exp(p[3 * M + k]) * Math.sqrt(temperature);
      const sy = Math.exp(p[4 * M + k]) * Math.sqrt(temperature);
      const rho = Math.tanh(p[5 * M + k]);
      const pen = softmax(Array.from(p.slice(6 * M, 6 * M + 3)));

      const z1 = gauss(), z2 = gauss();
      const dx = mux + sx * z1;
      const dy = muy + sy * (rho * z1 + Math.sqrt(1 - rho * rho) * z2);
      const state = sampleIndex(pen); // 0 draw · 1 lift · 2 end

      x += dx * scale; y += dy * scale;
      if (state === 2) break;                 // end of sketch
      if (state === 1) {                       // pen lift → start a new stroke
        if (xs.length > 1) strokes.push([xs, ys]);
        xs = [x]; ys = [y];
      } else {                                 // pen down → extend current stroke
        xs.push(x); ys.push(y);
      }

      point = new Float32Array([dx, dy, state === 0 ? 1 : 0, state === 1 ? 1 : 0, 0]);
    }
    if (xs.length > 1) strokes.push([xs, ys]);
    return strokes.length ? strokes : null;
  }
}
