// Generative drawing model — a real neural net that LEARNS to draw, not replay.
// A class-conditioned LSTM trained (teacher-forced) on harvested stroke
// sequences; at inference it rolls out a NEW sequence of pen movements for a
// requested word. This is a compact Sketch-RNN-style decoder.
//
// Honesty: generative sketching is genuinely data/compute hungry. With little
// harvested data the output is rough/abstract; it sharpens the more the bot
// plays and the longer you train. That's the whole point of "train for a long
// time." For polished output the bot still falls back to a real human doodle.

import * as tf from '@tensorflow/tfjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const DIR = new URL('../../data/model/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const META_FILE = `${DIR}sketchgen.meta.json`;
const WEIGHTS_FILE = `${DIR}sketchgen.weights.json`;
const MAX_LEN = 80;     // max points per sketch
const HIDDEN = 128;

/** drawing [[xs,ys],…] → normalized sequence of [dx,dy,penUp], scaled by `scale`. */
function toSequence(drawing, scale) {
  const seq = [];
  let px = null, py = null;
  for (const [xs, ys] of drawing) {
    for (let i = 0; i < xs.length; i++) {
      if (px === null) { px = xs[i]; py = ys[i]; continue; }
      seq.push([(xs[i] - px) / scale, (ys[i] - py) / scale, 0]);
      px = xs[i]; py = ys[i];
    }
    if (seq.length) seq[seq.length - 1][2] = 1; // pen up at end of each stroke
  }
  return seq.slice(0, MAX_LEN);
}

export class SketchGen {
  constructor() { this.vocab = []; this.model = null; this.scale = 40; }

  _build(V) {
    const F = 3 + V; // [dx,dy,pen] + class one-hot, per step
    const model = tf.sequential();
    model.add(tf.layers.lstm({ units: HIDDEN, returnSequences: true, inputShape: [MAX_LEN, F] }));
    model.add(tf.layers.lstm({ units: HIDDEN, returnSequences: true }));
    model.add(tf.layers.dense({ units: 3 })); // predict [dx,dy,pen] per step
    model.compile({ optimizer: tf.train.adam(5e-3), loss: 'meanSquaredError' });
    this.model = model;
  }

  _oneHot(i) { const v = new Array(this.vocab.length).fill(0); v[i] = 1; return v; }

  /**
   * Train on harvested samples grouped by word.
   * @param {Array<{drawing:number[][][], word:string}>} samples
   */
  async train(samples, { epochs = 60, batchSize = 16, onEpoch } = {}) {
    const words = [...new Set(samples.map((s) => s.word))].sort();
    if (!words.length) throw new Error('no samples');
    this.vocab = words;
    const idx = new Map(words.map((w, i) => [w, i]));
    const V = words.length;

    // build padded teacher-forcing tensors: X[t] = [point_t, class], Y[t] = point_{t+1}
    const X = [], Y = [];
    for (const s of samples) {
      const seq = toSequence(s.drawing, this.scale);
      if (seq.length < 4) continue;
      const oneHot = this._oneHot(idx.get(s.word));
      const xRow = [], yRow = [];
      for (let t = 0; t < MAX_LEN; t++) {
        const cur = seq[t] ?? [0, 0, 1];
        const nxt = seq[t + 1] ?? [0, 0, 1];
        xRow.push([...cur, ...oneHot]);
        yRow.push(nxt);
      }
      X.push(xRow); Y.push(yRow);
    }
    if (!X.length) throw new Error('no usable sequences');

    this._build(V);
    const xs = tf.tensor3d(X), ys = tf.tensor3d(Y);
    try {
      await this.model.fit(xs, ys, {
        epochs, batchSize, shuffle: true,
        callbacks: onEpoch ? { onEpochEnd: (e, l) => onEpoch(e, l) } : undefined,
      });
    } finally { xs.dispose(); ys.dispose(); }
    return { classes: V, sequences: X.length };
  }

  /** Generate a NEW drawing for `word` → grouped op19-ready polylines [[xs,ys],…]. */
  generate(word, { canvasSize = 540, temperature = 0.0 } = {}) {
    const i = this.vocab.indexOf(String(word).toLowerCase());
    if (i < 0 || !this.model) return null;
    const oneHot = this._oneHot(i);

    const pts = []; // [dx,dy,pen]
    let cur = [0, 0, 0];
    for (let t = 0; t < MAX_LEN; t++) {
      const seqIn = [];
      for (let k = 0; k < MAX_LEN; k++) seqIn.push(k <= t ? [...(pts[k] ?? cur), ...oneHot] : [0, 0, 1, ...oneHot]);
      const out = tf.tidy(() => this.model.predict(tf.tensor3d([seqIn])).arraySync()[0][t]);
      let [dx, dy, pen] = out;
      if (temperature > 0) { dx += (Math.random() - 0.5) * temperature; dy += (Math.random() - 0.5) * temperature; }
      cur = [dx, dy, pen > 0.5 ? 1 : 0];
      pts.push(cur);
    }

    // integrate offsets → absolute polylines, splitting on pen-up
    const strokes = []; let xs = [], ys = [], x = canvasSize / 2, y = canvasSize / 2;
    for (const [dx, dy, pen] of pts) {
      x += dx * this.scale; y += dy * this.scale;
      xs.push(x); ys.push(y);
      if (pen === 1) { if (xs.length > 1) strokes.push([xs, ys]); xs = []; ys = []; }
    }
    if (xs.length > 1) strokes.push([xs, ys]);
    return strokes.length ? strokes : null;
  }

  knows(word) { return this.vocab.includes(String(word).toLowerCase()); }

  save() {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    writeFileSync(META_FILE, JSON.stringify({ vocab: this.vocab, scale: this.scale }));
    const w = this.model.getWeights().map((t) => ({ shape: t.shape, data: Array.from(t.dataSync()) }));
    writeFileSync(WEIGHTS_FILE, JSON.stringify(w));
  }

  load() {
    if (!existsSync(META_FILE) || !existsSync(WEIGHTS_FILE)) return false;
    const meta = JSON.parse(readFileSync(META_FILE, 'utf8'));
    this.vocab = meta.vocab; this.scale = meta.scale;
    this._build(this.vocab.length);
    const w = JSON.parse(readFileSync(WEIGHTS_FILE, 'utf8'));
    this.model.setWeights(w.map((t) => tf.tensor(t.data, t.shape)));
    return true;
  }
}
