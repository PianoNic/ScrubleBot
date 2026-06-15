// doodleNet — QuickDraw sketch classifier (345 classes), run in-process via tfjs.
// Loads the local ml5 model (model.json + one weight shard + class_names.txt)
// through an in-memory IO handler, so no per-run download and no native deps.

import * as tf from '@tensorflow/tfjs';

const DIR = new URL('../data/doodlenet/', import.meta.url);

export class DoodleNet {
  constructor() {
    this.model = null;
    this.labels = [];
  }

  async load() {
    const modelJson = await Bun.file(new URL('model.json', DIR)).json();
    const weightData = await Bun.file(new URL('group1-shard1of1.bin', DIR)).arrayBuffer();
    const text = await Bun.file(new URL('class_names.txt', DIR)).text();
    this.labels = text.split('\n').map((s) => s.trim()).filter(Boolean)
      .map((s) => s.replace(/_/g, ' ').toLowerCase()); // normalize "cell_phone" -> "cell phone"

    this.model = await tf.loadLayersModel({
      load: async () => ({
        modelTopology: modelJson.modelTopology,
        weightSpecs: modelJson.weightsManifest.flatMap((g) => g.weights),
        weightData,
        format: modelJson.format,
        generatedBy: modelJson.generatedBy,
        convertedBy: modelJson.convertedBy,
      }),
    });
    return this;
  }

  /**
   * Classify a 28×28 grayscale doodle.
   * @param {Float32Array} grid784  length-784, values 0..1 (strokes ≈ 1 on 0 bg)
   * @param {number} [topK=10]
   * @returns {Array<{label:string, prob:number}>}  ranked
   */
  classify(grid784, topK = 10) {
    const probs = this.vector(grid784);
    return [...probs]
      .map((p, i) => ({ label: this.labels[i] ?? String(i), prob: p }))
      .sort((a, b) => b.prob - a.prob)
      .slice(0, topK);
  }

  /** Raw 345-dim output — used as a "fingerprint" for few-shot matching. */
  vector(grid784) {
    if (!this.model) throw new Error('DoodleNet not loaded');
    return tf.tidy(() => {
      const x = tf.tensor(grid784, [1, 28, 28, 1]);
      return this.model.predict(x).dataSync();
    });
  }
}
