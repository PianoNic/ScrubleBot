# How ScrubleBot works

A plain-language tour of the whole system — what each piece is, how data flows,
and the handful of ideas that make it tick. If you read one doc, read this one.

> **The 30-second version:** the bot plays skribbl. To **guess**, it turns the live
> drawing into a tiny picture and asks a neural net "what is this?". To **draw**, it
> asks another neural net to produce strokes for the word. While it plays it
> **records** every drawing it sees, and those recordings **train** the nets to get
> better. That's the whole loop.

---

## 1. The one idea you need first: strokes vs. rasters

skribbl sends drawings as **vector strokes** — a list of pen movements:

```
[pen, color, width, x1, y1, x2, y2]   ← "draw a line from (x1,y1) to (x2,y2) in this color"
```

A drawing is just many of those. The trouble: a neural network needs a **fixed-size
grid of numbers** (an image), not a variable-length list of lines. So we
**rasterize** — paint the strokes onto a small **28×28 pixel image with 3 color
channels (RGB)**:

```
vector strokes                         raster (what the model sees)
[[100,200 → 140,180, brown],     ──▶   ┌───────────────┐  28 px
 [150,150 → 250,150, green],            │   a 28×28×3   │
 …]                                      │   RGB image   │  28 px
                                         └───────────────┘
```

When training printed `rasterized 80000/169870`, it was doing exactly this —
converting 169,870 doodles into 169,870 little pictures. "Raster" = "picture made
of pixels." That's the only jargon that matters.

**Why 28×28?** Tiny is enough for doodles, and it makes the net fast (it runs on a
CPU in milliseconds). **Why RGB?** So the model can use **color** as a clue
(brown + green → probably a plant). More on that below.

---

## 2. The big loop

```
        ┌─────────────────────────── PLAY ───────────────────────────┐
        │  bot joins a skribbl lobby                                  │
        │   • someone draws → bot rasterizes the canvas → guesses      │
        │   • bot's turn    → bot generates strokes → draws            │
        │   • every round it watches → HARVEST (word + strokes+colors) │
        └──────────────────────────────┬──────────────────────────────┘
                                        │ data/harvest/samples.ndjson
                                        ▼
        ┌─────────────────────────── TRAIN ──────────────────────────┐
        │  QuickDraw base + your harvest                              │
        │   1. rasterize all drawings → 28×28×3 images                │
        │   2. (optional) vision-LLM drops "scene, not subject" ones  │
        │   3. train DETECTOR  (image → word)                         │
        │   4. train GENERATOR (word → strokes)                       │
        │   5. export both to ONNX                                    │
        └──────────────────────────────┬──────────────────────────────┘
                                        │ data/model/*.onnx
                                        ▼
                       bot HOT-RELOADS the new models, plays smarter → loop
```

Two engines come out of training:

- **Detector** — `image → word`. This is the **guesser's eyes**.
- **Generator** — `word → strokes`. This is the **bot's drawing hand**.

---

## 3. The two data sources

The models learn from two pools, mixed into one:

| Source | What | Color? | Role |
|---|---|---|---|
| **QuickDraw** | Google's dataset of 345 doodle categories (cat, tree, car…) | no (drawn black) | teaches **shape** — the big, stable base |
| **Harvest** | drawings the bot watched on skribbl, labelled by the answer | **yes** | teaches **color** + **new words** the bot keeps seeing |

QuickDraw is the same data the old `doodleNet` recognizer learned from — so by
training on it directly, your own model inherits that knowledge **without** copying
any frozen weights. The harvest then adds what QuickDraw lacks: real colors and
words outside the fixed 345.

---

## 4. The clever bits (each is small)

- **Color is a cue, not a crutch (`gray_dropout`).** During training we randomly
  turn ~30% of the images **grayscale**. That forces the model to recognize the
  **shape** alone, so a plain black-and-white drawing still works — but it still
  *uses* color when it's there. (Verified: an all-black tree → 90%.)

- **The thing vs. its scene (figure-ground).** People draw a *scene*: a tree with a
  sun, a sea, a garden. Only the tree is the word. A local **vision LLM** (Ollama,
  e.g. `qwen2.5vl:7b`) looks at each harvested drawing and drops the ones where the
  word is buried in background, so the model learns *the thing*, not the backdrop.
  Optional; fails safe if the LLM is off.

- **Raster parity.** The picture the trainer learns from (`train/raster.py`) and the
  picture the live bot feeds the model (`src/canvas.js` → `toRGB`) are produced by
  **identical** code — verified pixel-for-pixel. If they differed, the model would
  see one thing in training and another in the game, and guess badly.

- **One model or two.** By default the new color model runs **alongside** the old
  `doodleNet` (strong from day one). Seed training with QuickDraw (`--quickdraw`)
  and you can **retire doodleNet** and run a single custom model
  (`BOT_VISION=0`). Your call.

- **ONNX + hot-reload.** Training is **Python on the GPU**; the bot is **Bun
  (JavaScript)**. They meet through **ONNX**, a portable model file. The bot watches
  the file and **reloads a newer model mid-game** — no restart. So: play → train →
  the running bot just gets smarter.

---

## 5. Where each file lives

**The bot (Bun — runtime):**
| File | Does |
|---|---|
| `src/client.js` | talks to skribbl (the websocket protocol) |
| `src/canvas.js` | **rasterizes** the live canvas → 28×28 grayscale + RGB |
| `src/guesser.js` | picks what to guess (dictionary + the model's vote) |
| `src/onnx.js` | loads the **detector** model, recognizes the canvas |
| `src/sketchrnn.js` | loads the **generator** model, samples strokes to draw |
| `src/quickdraw.js` | fallback: replay a real QuickDraw doodle |
| `src/harvester.js` | records (word → strokes → colors) while playing |
| `src/index.js` | wires it all together |

**The trainer (Python — GPU):**
| File | Does |
|---|---|
| `train/raster.py` | strokes → 28×28×3 image (parity with `canvas.js`) |
| `train/quickdraw.py` | fetch the QuickDraw shape base |
| `train/dataset.py` | load + **rasterize** everything (parallel, cached) |
| `train/llm_clean.py` | the vision-LLM figure-ground filter |
| `train/train_detector.py` | the CNN: image → word → `detector.onnx` |
| `train/train_generator.py` | the LSTM: word → strokes → `generator.onnx` |
| `train/train.py` | runs the whole pipeline (one-shot or `--watch`) |

**The handoff (on disk):**
| Path | What |
|---|---|
| `data/harvest/samples.ndjson` | drawings the bot recorded |
| `data/model/detector.onnx` (+ vocab) | the trained recognizer |
| `data/model/generator.onnx` (+ meta) | the trained drawer |
| `data/quickdraw_cache/` | downloaded QuickDraw (so re-runs are fast) |

---

## 6. What happens in a single round (runtime)

**Someone else is drawing:**
1. Strokes stream in → `canvas.js` accumulates them.
2. Every ~2.5s → rasterize the canvas → ask the **detector** "what is this?".
3. Fuse that with the dictionary (word length + revealed letters) → if confident,
   `guesser.js` sends a guess that reads like a human typed it.
4. At round end, the answer is revealed → `harvester.js` saves (answer → strokes →
   colors) for future training.

**The bot's turn:**
1. Pick the most drawable offered word.
2. Ask the **generator** for strokes (in color). If it doesn't know the word, fall
   back to replaying a real QuickDraw doodle.
3. Stream the strokes out slowly so it looks hand-drawn.

---

## 7. Glossary

- **stroke / op19** — skribbl's "draw a line" message: coords + palette color.
- **raster / rasterize** — turning vector strokes into a fixed pixel image.
- **detector** — neural net that maps an image to a word (for guessing).
- **generator** — neural net that maps a word to strokes (for drawing).
- **doodleNet** — a pre-trained 345-class recognizer; the optional baseline.
- **harvest** — the bot's saved (word → drawing) recordings.
- **QuickDraw** — Google's 345-category doodle dataset; the shape base.
- **gray_dropout** — randomly graying training images so color isn't a crutch.
- **figure-ground** — separating the subject (the word) from background scenery.
- **parity** — the trainer and the bot produce the *identical* raster.
- **ONNX** — portable model format; trained in Python, run in Bun.
- **hot-reload** — the bot loading a freshly trained model without restarting.

See [`RUNBOOK.md`](../RUNBOOK.md) for the exact commands, and
[`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md) for design history.
