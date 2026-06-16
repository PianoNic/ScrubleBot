// Sample the trained generator for given words and save each as a PNG, so you
// can SEE what the model draws without joining a game.
//
//   bun run src/draw.js cat house tree
//   bun run draw sun umbrella           (via the package.json script)
//
// Writes <word>.png in the current directory. Needs data/model/generator.onnx
// (train it first). Optional GEN_TEMP env sets sampling temperature (default 0.4;
// lower = cleaner/more rigid, higher = loopier).

import { SketchGenerator } from './sketchrnn.js';
import { strokesToSegments } from './strokes.js';
import { renderSegmentsToPng } from './render-png.js';

const words = process.argv.slice(2);
if (!words.length) {
  console.error('usage: bun run src/draw.js <word> [word ...]');
  process.exit(1);
}

const temperature = Number(process.env.GEN_TEMP ?? 0.4);
const gen = await new SketchGenerator().load();
if (!gen.enabled) {
  console.error('✗ no generator.onnx found — train the generator first.');
  process.exit(1);
}
console.log(`🖌 generator loaded (${gen.meta.vocab.length} words), temp ${temperature}`);

for (const word of words) {
  const key = word.toLowerCase();
  if (!gen.knows(key)) {
    console.log(`✗ "${word}" is not in the generator's vocabulary — skipping`);
    continue;
  }
  const g = await gen.draw(key, { temperature });
  if (!g) { console.log(`✗ "${word}" produced no strokes`); continue; }
  const segs = strokesToSegments(g.drawing, { colors: g.colors })?.flat() ?? [];
  const png = renderSegmentsToPng(segs);
  const file = `${key.replace(/[^a-z0-9]+/gi, '_')}.png`;
  await Bun.write(file, png);
  console.log(`✓ ${word} → ${file}  (${g.drawing.length} strokes)`);
}
