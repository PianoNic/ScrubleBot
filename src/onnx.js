// Color-aware learned detector (ONNX), trained from scratch on harvested data.
// Complements doodleNet: doodleNet is the fast 345-class *grayscale* baseline;
// this model takes the RGB canvas (StrokeCanvas.toRGB) so it can learn color
// semantics (brown + green ≈ plant) and recognize words outside the fixed 345.
//
// Everything here degrades gracefully: enabled only with BOT_MODELS=1, and a
// no-op if onnxruntime or the trained model/vocab aren't present yet — the bot
// runs fine before the first training pass, then picks the model up on reload.

import { existsSync, readFileSync, statSync } from 'node:fs';

const MODEL = new URL('../data/model/detector.onnx', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const VOCAB = new URL('../data/model/detector.vocab.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SIDE = 28; // must match train/raster.py and StrokeCanvas.toRGB default

function softmax(arr) {
  let max = -Infinity;
  for (const v of arr) if (v > max) max = v;
  let sum = 0;
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) { out[i] = Math.exp(arr[i] - max); sum += out[i]; }
  for (let i = 0; i < arr.length; i++) out[i] /= (sum || 1);
  return out;
}

export class ColorDetector {
  constructor() {
    this.ort = null;
    this.session = null;
    this.vocab = [];
    this.mtime = 0;     // model file mtime, for hot-reload
    this.ready = false;
  }

  /** Load onnxruntime + the model/vocab. Returns this; stays disabled if absent. */
  async load() {
    if (!existsSync(MODEL) || !existsSync(VOCAB)) return this; // not trained yet
    try {
      this.ort = await import('onnxruntime-node');
    } catch {
      try { this.ort = await import('onnxruntime-web'); }
      catch { return this; } // no runtime installed → stay disabled
    }
    await this._open();
    return this;
  }

  async _open() {
    this.vocab = JSON.parse(readFileSync(VOCAB, 'utf8'));
    this.session = await this.ort.InferenceSession.create(MODEL);
    this.mtime = statSync(MODEL).mtimeMs;
    this.ready = true;
  }

  /** Reload if the trainer has written a newer model since we last loaded. */
  async maybeReload() {
    if (!this.ort || !existsSync(MODEL)) return false;
    if (statSync(MODEL).mtimeMs <= this.mtime) return false;
    try { await this._open(); return true; } catch { return false; }
  }

  get enabled() { return this.ready; }
  get labels() { return this.vocab; }

  /**
   * Classify an RGB canvas raster.
   * @param {Float32Array} rgbCHW  length 3*SIDE*SIDE, CHW order (from toRGB)
   * @param {number} [topK=8]
   * @returns {Promise<Array<{label:string, prob:number}>>}
   */
  async classify(rgbCHW, topK = 8) {
    if (!this.ready || !rgbCHW) return [];
    const input = new this.ort.Tensor('float32', rgbCHW, [1, 3, SIDE, SIDE]);
    const feeds = { [this.session.inputNames[0]]: input };
    const out = await this.session.run(feeds);
    const logits = Array.from(out[this.session.outputNames[0]].data);
    const probs = softmax(logits);
    return probs
      .map((p, i) => ({ label: this.vocab[i] ?? String(i), prob: p }))
      .sort((a, b) => b.prob - a.prob)
      .slice(0, topK);
  }
}
