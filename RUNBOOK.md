# RUNBOOK

The loop is: **seed from the existing dataset → play the real world to harvest →
retrain on what you saw → the bot picks up the better model live.**

## 0. Prerequisites

- [Bun](https://bun.sh) ≥ 1.3 (bot) and Python 3.11 + a CUDA GPU (training).
- For the figure/ground clean step: [Ollama](https://ollama.com) with a vision
  model — `ollama pull qwen2.5vl:7b`.
- For Docker training: NVIDIA driver + NVIDIA Container Toolkit. **RTX 5080
  (Blackwell):** use a cu128 base image (see `Dockerfile.train`).

---

## 1. Train first from the existing dataset (day one, no harvest needed)

The model is seeded with **QuickDraw** — the same data doodleNet learned from.
QuickDraw is colorless, so it teaches *shape*; color comes later from the harvest.

**Docker (GPU):**
```sh
DATA_DIR=./data QUICKDRAW=150 EPOCHS=40 \
  docker compose -f docker-compose.train.yml up --build
```

**Or bare metal:**
```sh
pip install -r train/requirements.txt
python train/train.py --quickdraw 150 --min-samples 200 --epochs 40 --generator
```

Writes `data/model/detector.onnx` (+ vocab) and `data/model/generator.onnx`
(+ meta). The first run downloads QuickDraw into `data/quickdraw_cache/` (cached).

> Tip: `--quickdraw 150` pulls ~150 drawings per category. Raise it (300–1000) on
> the GPU for sharper recognition; the cache makes re-runs fast.

---

## 2. Go into the real world and harvest

Run the bot. While it plays, it records every drawing it watches (with colors)
into `data/harvest/samples.ndjson`.

```sh
bun install
BOT_MODELS=1 bun run src/index.js                 # public game; loads the model from step 1
# join a specific lobby:  BOT_MODELS=1 bun run src/index.js ABCD1234
```

- `BOT_MODELS=1` loads the trained detector + generator.
- Add `BOT_VISION=0` to run **single-model** (your model only, doodleNet off).
- The bot **draws learned words itself** (the generator), in color, on its turn.

---

## 3. Retrain on what you harvested (and keep going)

Re-run training; it now mixes QuickDraw **+** your harvest into one growing vocab,
and (with Ollama up) drops scene-polluted samples first.

```sh
LLM_CLEAN=1 OLLAMA_VISION_MODEL=qwen2.5vl:7b \
  python train/train.py --quickdraw 150 --min-samples 50 --epochs 40 --generator
```

**Continuous:** add `--watch` (or use `docker compose up` — the `trainer` service
already runs `--watch --quickdraw 150 --generator`). It retrains as the harvest
grows; the bot **hot-reloads** the new model at the next round end — no restart.

```sh
docker compose up --build         # bot harvests + trainer retrains, sharing ./data
```

---

## Knobs

| env / flag | default | meaning |
|---|---|---|
| `BOT_MODELS` | `0` | load trained ONNX models |
| `BOT_VISION` | `1` | doodleNet on; set `0` for single-model |
| `BOT_DEBUG` | `0` | `1` = dump every raw protocol frame |
| `--quickdraw N` | `0` | QuickDraw samples per category (`0` = harvest only) |
| `--generator` | off | also train the Sketch-RNN drawer |
| `--watch` | off | retrain as the harvest grows |
| `LLM_CLEAN` | `0`/`1` | vision-LLM figure/ground cleaning |

## Verify locally

```sh
bun run test          # fast smoke test (no GPU, no models needed)
```
