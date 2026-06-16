// Smoke test — fast, no network, no trained models required. Verifies the bits
// most likely to break silently: the color raster, stroke round-trips, the ONNX
// runtime import, and that the model loaders degrade gracefully when untrained.
//   bun test/smoke.js
import assert from 'node:assert';
import { StrokeCanvas } from '../src/canvas.js';
import { ColorDetector } from '../src/onnx.js';
import { SketchGenerator } from '../src/sketchrnn.js';
import { segmentsToColoredStrokes, strokesToSegments } from '../src/strokes.js';
import { TOOL, colorRGB } from '../src/protocol.js';

let n = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); n++; };

// palette → rgb
assert.deepStrictEqual(colorRGB(1), [0, 0, 0], 'index 1 is black');
assert.deepStrictEqual(colorRGB(0), [1, 1, 1], 'index 0 is white');
ok('palette RGB lookup');

// RGB raster shape
const segs = [
  [TOOL.PEN, 20, 8, 400, 500, 400, 350],   // brown trunk
  [TOOL.PEN, 10, 8, 350, 350, 450, 350],   // green leaves
  [TOOL.PEN, 10, 8, 450, 350, 400, 280],
];
const c = new StrokeCanvas();
c.add(segs);
const rgb = c.toRGB();
assert.strictEqual(rgb.length, 3 * 28 * 28, 'toRGB is CHW 3×28×28');
assert.ok([...rgb].every((v) => v >= 0 && v <= 1), 'raster values in 0..1');
ok('RGB raster (3×28×28, 0..1)');

// color-aware stroke round-trip
const { drawing, colors } = segmentsToColoredStrokes(segs);
assert.strictEqual(colors[0], 20, 'first stroke keeps brown');
const back = strokesToSegments(drawing, { colors });
assert.strictEqual(back[0][0][1], 20, 'round-trip preserves stroke color');
ok('colored stroke round-trip');

// model loaders: graceful no-op without trained artifacts
const det = await new ColorDetector().load();
assert.strictEqual(det.enabled, false, 'detector disabled with no model');
assert.deepStrictEqual(await det.classify(rgb), [], 'detector classify no-op');
ok('detector graceful no-op');

const gen = await new SketchGenerator().load();
assert.strictEqual(gen.enabled, false, 'generator disabled with no model');
assert.strictEqual(await gen.draw('tree'), null, 'generator draw no-op');
ok('generator graceful no-op');

// onnxruntime is importable (the inference backend)
const ort = await import('onnxruntime-node');
assert.strictEqual(typeof ort.InferenceSession, 'function', 'onnxruntime present');
ok('onnxruntime-node import');

console.log(`\n${n} checks passed`);
