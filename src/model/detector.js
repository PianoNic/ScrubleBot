// Trainable detection model. NOT nearest-neighbour / lookup — this is a real
// neural network trained by backprop (model.fit) on the drawings the bot
// harvests while playing. It learns to recognise words beyond doodleNet's fixed
// 345 classes.
//
// Architecture = transfer learning: doodleNet's frozen output (a 345-dim
// "fingerprint" of any sketch) feeds a small trainable classifier head over the
// learned vocabulary. This learns fast from limited data and improves the longer
// the bot plays/harvests.

import * as tf from '@tensorflow/tfjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const DIR = new URL('../../data/model/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const VOCAB_FILE = `${DIR}detector.vocab.json`;
const WEIGHTS_FILE = `${DIR}detector.weights.json`;

export class Detector {
  /** @param {import('../doodlenet.js').DoodleNet} doodleNet frozen feature extractor */
  constructor(doodleNet) {
    this.net = doodleNet;
    this.vocab = [];      // learned words (output classes)
    this.model = null;    // trainable head
  }

  _build(numClasses) {
    const model = tf.sequential();
    model.add(tf.layers.dense({ inputShape: [345], units: 256, activation: 'relu' }));
    model.add(tf.layers.dropout({ rate: 0.3 }));
    model.add(tf.layers.dense({ units: numClasses, activation: 'softmax' }));
    model.compile({ optimizer: tf.train.adam(1e-3), loss: 'categoricalCrossentropy', metrics: ['accuracy'] });
    this.model = model;
  }

  /** Features = doodleNet fingerprint for a 28×28 grid. */
  _features(grid784) { return this.net.vector(grid784); }

  /**
   * Train the head on harvested (grid, word) samples.
   * @param {Array<{grid:Float32Array, word:string}>} samples
   * @param {object} [opts]
   */
  async train(samples, { epochs = 40, batchSize = 32, onEpoch } = {}) {
    const words = [...new Set(samples.map((s) => s.word))].sort();
    if (words.length < 2) throw new Error('need ≥2 distinct words to train');
    this.vocab = words;
    const index = new Map(words.map((w, i) => [w, i]));
    this._build(words.length);

    const xs = tf.tensor2d(samples.map((s) => Array.from(this._features(s.grid))), [samples.length, 345]);
    const ys = tf.oneHot(tf.tensor1d(samples.map((s) => index.get(s.word)), 'int32'), words.length);
    try {
      await this.model.fit(xs, ys, {
        epochs, batchSize, shuffle: true, validationSplit: samples.length > 50 ? 0.15 : 0,
        callbacks: onEpoch ? { onEpochEnd: (e, logs) => onEpoch(e, logs) } : undefined,
      });
    } finally { xs.dispose(); ys.dispose(); }
    return { classes: words.length, samples: samples.length };
  }

  /** Predict ranked { label, prob } for a 28×28 grid. */
  predict(grid784, topK = 5) {
    if (!this.model) return [];
    return tf.tidy(() => {
      const probs = this.model.predict(tf.tensor2d([Array.from(this._features(grid784))], [1, 345])).dataSync();
      return [...probs]
        .map((p, i) => ({ label: this.vocab[i], prob: p }))
        .sort((a, b) => b.prob - a.prob)
        .slice(0, topK);
    });
  }

  // --- persistence (manual JSON so it works the same in Bun) -----------------

  async save() {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    writeFileSync(VOCAB_FILE, JSON.stringify(this.vocab));
    const weights = this.model.getWeights().map((w) => ({ shape: w.shape, data: Array.from(w.dataSync()) }));
    writeFileSync(WEIGHTS_FILE, JSON.stringify(weights));
  }

  /** Load a previously trained head, or return false if none exists. */
  load() {
    if (!existsSync(VOCAB_FILE) || !existsSync(WEIGHTS_FILE)) return false;
    this.vocab = JSON.parse(readFileSync(VOCAB_FILE, 'utf8'));
    this._build(this.vocab.length);
    const weights = JSON.parse(readFileSync(WEIGHTS_FILE, 'utf8'));
    this.model.setWeights(weights.map((w) => tf.tensor(w.data, w.shape)));
    return true;
  }
}
