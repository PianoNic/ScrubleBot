# Implementation Plan — Self-learning models (draw + detect)

Goal: while the bot **plays public lobbies**, it harvests labelled `(word → drawing)`
data and uses it to **train real neural networks** that learn to *draw* and *detect*
words — including ones outside QuickDraw's fixed 345 ("unknown stuff"). Not replay,
not nearest-neighbour: genuine trained models.

## Architecture: harvest in Bun → train in Python (GPU) → infer in Bun

```
 ┌─────────────── Bun (the bot, runtime) ───────────────┐      ┌──── Python (training, GPU) ────┐
 │ plays + guesses + draws                              │      │ train_detector.py  (CNN)       │
 │ harvests every observed round  ──▶ data/harvest/     │ ───▶ │ train_generator.py (Sketch-RNN)│
 │ loads trained models  ◀── data/model/*.onnx          │ ◀─── │ export to ONNX                 │
 └──────────────────────────────────────────────────────┘      └────────────────────────────────┘
```

- **Why this split:** the RTX 5080 (Blackwell `sm_120`) + CUDA 13 is too new for
  `tfjs-node-gpu` (built for CUDA 11). PyTorch 2.10+cu128 **does** support it
  (verified: `torch.cuda.is_available() == True`, device = RTX 5080). So training
  runs in PyTorch on the GPU; the bot stays Bun and runs inference on the exported
  ONNX via `onnxruntime` (CPU inference is plenty fast — ~tens of ms).
- **Interchange = ONNX.** Framework-neutral, keeps the bot a single Bun process.

## Status

**Done (live-verified):**
- Phases 1–4: headless join (public/private/custom), dictionary + doodleNet vision
  guessing, QuickDraw doodle drawing. Recognized "toilet" at 89% and won a round.
- Harvester (`src/harvester.js`): records `(word, strokes)` to
  `data/harvest/samples.ndjson` every round it watches — captures **any** word,
  including unknown ones.
- CPU prototype trainers (`src/model/detector.js`, `src/model/sketchgen.js`):
  proof the data is trainable (detector hit 4/4 on held-out drawings). These are
  **superseded** by the PyTorch pipeline below but kept as a CPU fallback.

**Now built (extends the original plan):**
- **Color-aware harvest** — strokes recorded *with* per-stroke palette color
  (`src/strokes.js` `segmentsToColoredStrokes`, `src/harvester.js`).
- **RGB raster with parity** — `src/canvas.js` `toRGB()` ⇄ `train/raster.py`,
  verified pixel-identical (max diff 1e-6).
- **From-scratch color CNN** — `train/train_detector.py` trains on RGB and
  exports `detector.onnx` + vocab; `src/onnx.js` loads & hot-reloads it, fused
  into the guesser alongside doodleNet.
- **Monochrome robustness** — `gray_dropout` desaturates a fraction of each batch
  so the model works in black-and-white; color is a cue, not a crutch.
- **Figure/ground cleaning** — `train/llm_clean.py` asks a local Ollama vision
  model (e.g. `LFM2.5-VL-1.6B`) whether the word is the clear subject, dropping
  scene-polluted samples. Fails open; skip with `LLM_CLEAN=0`.
- **Conditional Sketch-RNN generator** — `train/train_generator.py` trains a
  class-conditioned LSTM + MDN decoder and exports the single decoder *step* to
  `generator.onnx`; `src/sketchrnn.js` runs the autoregressive + MDN sampling loop
  in Bun and becomes the **primary drawer** when it knows the word (QuickDraw replay
  is the fallback). Enable training with `train.py --generator`.
- **Autonomous loop + containers** — `train/train.py --watch`, `Dockerfile.bot`,
  `Dockerfile.train`, `docker-compose.yml` (shared `./data`, GPU, host Ollama).
- **ONNX export** uses the classic (`dynamo=False`) exporter → one self-contained
  file per model (atomic write, hot-reloadable, no external-data sidecar).
- **Single-model consolidation** — `train/quickdraw.py` fetches the QuickDraw
  dataset (the data doodleNet learned from) as a grayscale *shape* base; mixed
  with the color harvest into one unified vocab via `train.py --quickdraw N`. Run
  `BOT_VISION=0 BOT_MODELS=1` to retire doodleNet and use the single model. The
  bot's vision is now source-agnostic (fuses whichever of doodleNet / detector are
  present). Verified: a monochrome tree classifies at 90% from the QuickDraw-seeded
  model.

**Original plan (for reference):**

### 1. Data contract  ✅ already produced by the bot
`data/harvest/samples.ndjson`, one JSON object per line:
```json
{ "word": "windsock", "drawing": [[[x0,x1,…],[y0,y1,…]], …], "ts": 1718…}
```
`drawing` = QuickDraw-style polyline strokes in canvas coords. Reuse
`src/strokes.js` semantics. Words are lowercased; unknown words included.

### 2. Python training pipeline  → `train/`
- `train/requirements.txt` — `torch` (nightly cu128), `numpy`, `onnx`.
- `train/dataset.py` — load `samples.ndjson`; build:
  - **raster set** for the detector: rasterize each drawing → 28×28 (match
    `src/canvas.js` normalization: bbox-fit, hi-res raster, box-downsample).
  - **sequence set** for the generator: `(Δx, Δy, pen)` stroke-3 sequences,
    normalized, padded to `MAX_LEN`, with a class-conditioning one-hot.
- `train/train_detector.py` — a small **CNN classifier** over the harvested
  vocabulary (open set — grows as new words are harvested). Train on GPU.
  Export `data/model/detector.onnx` + `data/model/detector.vocab.json`.
- `train/train_generator.py` — a **conditional Sketch-RNN** (LSTM decoder +
  mixture-density output over pen offsets, class-conditioned). Train on GPU.
  Export `data/model/generator.onnx` + `data/model/generator.meta.json`.
- `train/train.py` — orchestrates both; `--min-samples`, `--epochs`, runs on GPU
  if available. Designed to be re-run as the harvest grows (train for a long time).

### 3. Bun inference integration  → `src/onnx.js`
- Add `onnxruntime-web` (WASM, works in Bun) — or evaluate `onnxruntime-node`.
- `Detector` (ONNX): 28×28 → class probs over learned vocab. Fuse into the guesser
  alongside doodleNet (`mergeVision` already exists) — doodleNet covers the 345,
  the learned model covers harvested/unknown words.
- `Generator` (ONNX): word → stroke sequence → `strokesToSegments` → op19. Make it
  the **primary drawer** when the model knows the word; QuickDraw replay becomes the
  fallback for words not yet learned.
- `BOT_MODELS=1` to enable loading trained ONNX; gracefully no-op if absent.

### 4. Wiring & lifecycle
- Bot already harvests while playing. Add a `data/model/` watcher (or load-on-start)
  so a freshly trained model is picked up on next launch.
- README: document the loop — *play to harvest → `python train/train.py` →
  restart bot → it now draws & detects the new words.*

## Milestones
1. `train/dataset.py` + raster parity with `src/canvas.js` (unit-check a few
   drawings render identically in Python and Bun).
2. `train_detector.py` → ONNX; wire `src/onnx.js` detector into the guesser.
3. `train_generator.py` → ONNX; wire generator into the drawer.
4. End-to-end: harvest a session → train on GPU → bot draws/detects a word it had
   never seen before.
5. Optional: a long-running harvest daemon + scheduled retrain.

## Risks / open questions
- **ONNX LSTM/MDN export** for the generator can be fiddly (sampling loop stays in
  Bun; export just the per-step decoder). Validate op support in onnxruntime-web.
- **Raster parity** Python↔Bun must match or the detector sees a different
  distribution at inference. Port `canvas.js` rasterization exactly, or export the
  detector to also accept raw strokes.
- **Generation quality** is data-hungry; expect rough output until many samples per
  word. Keep QuickDraw replay as the quality fallback.
- **Class set grows** over time — retraining rebuilds the head; keep vocab files
  versioned with the weights.
```
