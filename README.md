# 🎨 ScrubleBot

A self-hosted [skribbl.io](https://skribbl.io) bot that **joins a lobby, guesses words by looking at the drawing, and draws real doodles on its turn** — as a headless [Socket.IO](https://socket.io) client. No browser at runtime, no auth, one [Bun](https://bun.sh) process.

> It guesses by *watching the canvas* (a QuickDraw CNN), and it draws by *replaying real human doodles* (the Quick, Draw! dataset). Both run in-process — no Python, no cloud.

> 🆕 **New here?** [`docs/HOW_IT_WORKS.md`](docs/HOW_IT_WORKS.md) explains the whole system in plain language.

---

## ✨ Features

- **Headless** — connects straight to skribbl's websocket as a player. No browser, no Selenium.
- **Guesses by vision** — reconstructs the canvas from the live draw stream and recognizes the doodle with **doodleNet** (a 345-class QuickDraw CNN, ~26 ms inference), fused with a dictionary filter (word length + revealed letters).
- **Draws real doodles** — on its turn it picks a drawable word and replays an actual human **Quick, Draw!** drawing, streamed stroke-by-stroke so it looks live.
- **Plays like a person** — confidence-gated guessing (no spam), lowercase chat, jittered timing, the occasional typo.
- **Public, private, or custom lobbies** — join by code or invite URL, or matchmake into a public game.

## 🧠 How it works

```
                    ┌──────────────── guessing ────────────────┐
  draw stream  ──▶  StrokeCanvas ──▶ 28×28 ──▶ doodleNet ──┐
  (op19)                                                    ├──▶ ranked guess ──▶ chat (op30)
  word mask    ──▶  dictionary filter (length + hints) ─────┘
  (op11/op13)

                    ┌──────────────── drawing ─────────────────┐
  our turn     ──▶  pick a drawable word ──▶ Quick, Draw! doodle ──▶ scale to canvas ──▶ op19 strokes
  (op11)
```

| | Guessing | Drawing |
|---|---|---|
| Source | **doodleNet** (QuickDraw CNN) | **Quick, Draw!** human doodles |
| Vocabulary | 345 categories + 3.7k dictionary | 342 drawable categories |
| Runtime | tfjs, in-process | ranged fetch + replay |

## 🚀 Quickstart

Requires [Bun](https://bun.sh) (`bun --version` ≥ 1.3).

```sh
git clone https://github.com/PianoNic/ScrubleBot.git
cd ScrubleBot
bun install
bun run src/index.js          # join a public game, guess + draw
```

### Joining a specific lobby

```sh
bun run src/index.js ABCD1234                        # by room code
bun run src/index.js "https://skribbl.io/?ABCD1234"  # by invite URL
bun run src/index.js                                 # public matchmaking
BOT_CREATE=1 bun run src/index.js                    # create a private room
```

### Configuration (env vars)

| var | default | meaning |
|-----|---------|---------|
| `BOT_NAME` | `ScrubleBot` | display name |
| `BOT_JOIN` | – | room code / invite URL (also accepted as the first CLI arg) |
| `BOT_CREATE` | `0` | `1` = create a private room |
| `BOT_LANG` | `0` | language index (`0` = English) |
| `BOT_GUESS` | `1` | set `0` to disable guessing |
| `BOT_VISION` | `1` | set `0` to disable the canvas-vision guesser |
| `BOT_LEARN` | `1` | set `0` to disable harvesting + few-shot detection |
| `BOT_MODELS` | `0` | `1` = load the trained color-aware ONNX detector (no-op until trained) |
| `BOT_RUN_SECONDS` | – | exit after N seconds (handy for testing) |

### 💡 Tip: only-drawable rooms

For a private game where the bot always draws something recognizable, set the room's
**Custom words** to the contents of [`data/drawable_words.txt`](data/drawable_words.txt)
(the 342 categories the bot can both draw *and* recognize) and tick **"Use custom words only."**

## 🧠 Self-learning (color-aware, from scratch)

While it plays, the bot **harvests** every drawing it watches — labelled by the
word revealed at round-end, **with each stroke's color** — into `data/harvest/`.
A PyTorch trainer turns that into a **from-scratch color-aware CNN detector** that
learns words *and* color semantics (brown + green ≈ a plant), exported to **ONNX**
the Bun bot hot-loads while it runs. It complements doodleNet: doodleNet is the
fast 345-class grayscale baseline; the learned model covers harvested/unknown words
and uses color.

The loop, fully containerized (`docker compose up`):

```
 bot (Bun)  ──harvest (word, strokes, colors)──▶  data/harvest/samples.ndjson
     ▲                                                      │
     │ hot-reload detector.onnx                             ▼
     │                                   trainer (PyTorch, GPU)
     │                                   ├─ raster: strokes+colors → RGB 28×28 (parity w/ the bot)
     │                                   ├─ clean: vision LLM drops scene-polluted samples (figure/ground)
     │                                   ├─ train: CNN + gray-dropout (works in monochrome too)
     └──── data/model/detector.onnx ◀────┴─ export ONNX + vocab
```

**Color is a cue, not a crutch.** Training randomly desaturates a fraction of each
batch (`--gray`), so the detector recognizes the plain **black-and-white** drawing
on shape alone, while still exploiting color when it helps.

**Figure vs. ground.** Players draw a *scene* (a sea, a garden) around the actual
word. A local **vision LLM** (Ollama — recommended `qwen2.5vl:7b`; lighter:
`moondream`, `llava`, `LFM2.5-VL-1.6B`) looks at each harvested drawing and drops
the ones where the word isn't the clear subject, so the model learns *the thing*,
not the backdrop. It fails open (keeps the sample) if the LLM is offline, and is
skipped entirely with `LLM_CLEAN=0`.

### Run it (Docker)

```sh
# Pull a vision model on the host first, e.g.:  ollama pull qwen2.5vl:7b
LLM_CLEAN=1 OLLAMA_VISION_MODEL=qwen2.5vl:7b docker compose up --build
```

`bot` and `trainer` share `./data`: the bot harvests + hot-reloads, the trainer
(GPU) retrains as the harvest grows. The trainer reaches host Ollama via
`host.docker.internal`. **RTX 5080 (Blackwell)?** Build the trainer with a cu128
base — see the note in [`Dockerfile.train`](Dockerfile.train).

### Or train manually

```sh
pip install -r train/requirements.txt
python train/train.py --min-samples 50 --epochs 40 --generator  # --watch to retrain as data grows
BOT_MODELS=1 bun run src/index.js                               # loads detector.onnx + generator.onnx
```

With a trained generator the bot **draws learned words itself** (conditional
Sketch-RNN, sampled stroke-by-stroke); QuickDraw replay stays the fallback for
words it hasn't learned to draw yet.

### One model (retire doodleNet)

By default the color detector runs *alongside* doodleNet (the fixed 345-class
grayscale baseline). To collapse to a **single custom model**, seed training with
the QuickDraw dataset itself — the same data doodleNet learned from — so one model
covers the 345 shapes *and* the harvested color/new words:

```sh
# fetch ~150 QuickDraw drawings per category as the shape base, + your harvest
python train/train.py --quickdraw 150 --min-samples 200 --epochs 40
BOT_VISION=0 BOT_MODELS=1 bun run src/index.js   # doodleNet off — your model only
```

QuickDraw is colorless, so its categories teach **shape** (rendered grayscale);
the harvest adds **color** and new words on top. `gray_dropout` keeps the model
working on a plain black-and-white drawing (verified: a monochrome tree → 90%).
The vocabulary is the union of QuickDraw ∪ harvest and **grows every retrain** as
you play.

See [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) for the full design.

## 📁 Project structure

```
src/
  protocol.js     opcodes, game states, palette, canvas dims
  matchmaking.js  POST /api/play → server origin + socket path
  client.js       SkribblClient — login, state machine, semantic events + actions
  wordlist.js     load the per-language word list
  guesser.js      confidence-gated dictionary + vision fusion
  human.js        lowercase / jitter / typo humanization
  doodlenet.js    QuickDraw CNN (tfjs) — recognize the canvas
  canvas.js       StrokeCanvas — op19 strokes → 28×28 bitmap
  strokes.js      shared op19 ⇄ polyline conversion + canvas fitting
  quickdraw.js    fetch & replay a real Quick, Draw! doodle as op19
  harvester.js    record (word → drawing → colors) while playing — learning data
  learned.js      use harvested drawings (replay + few-shot) [interim]
  onnx.js         load the trained color-aware detector (ONNX) + hot-reload
  sketchrnn.js    sample the trained generator (ONNX) → op19 strokes
  drawer.js       word pick + placeholder fallback
  render-png.js   visualize op19 strokes as a PNG (debugging)
  index.js        entry point — wires it all together
train/            PyTorch pipeline (GPU) — harvest → clean → train → ONNX
  raster.py       strokes+colors → RGB 28×28 (byte-parity with src/canvas.js)
  dataset.py      load samples.ndjson → tensors + open-set vocab
  quickdraw.py    fetch the QuickDraw base (seeds the single model — shape)
  llm_clean.py    vision-LLM figure/ground cleaning (Ollama)
  train_detector.py  color-aware CNN + gray-dropout → detector.onnx
  train_generator.py conditional Sketch-RNN (LSTM+MDN) → generator.onnx
  train.py        autonomous loop (one-shot or --watch)
data/
  wordlists/      skribbl word lists (per language)
  doodlenet/      doodleNet model + class names
  drawable_words.txt
  harvest/        harvested drawings (generated by playing; gitignored)
  model/          trained detector.onnx + vocab (generated; gitignored)
Dockerfile.bot · Dockerfile.train · docker-compose.yml
```

## 📡 Protocol (reverse-engineered)

Transport: **Engine.IO v4 / Socket.IO v4** over websocket, **no auth**.
Matchmaking: `POST https://skribbl.io/api/play` `{name,lang,create,join,avatar}` → `https://serverN.skribbl.io:PORT`; the `:PORT` becomes the Socket.IO **path** `/PORT/` over `wss`. Login: emit `login {join,create,name,lang,avatar}`.

All gameplay multiplexes through one event: `data` → `{ id: <opcode>, data: <payload> }`.

| op | meaning |
|----|---------|
| 10 | full lobby snapshot on join |
| 1 / 2 | player joined / left |
| 11 | state machine — `3` choose-word · `4` drawing · `5` round end |
| 13 | hint reveal `[[position, char], …]` |
| 18 | **send**: choose word `{data:<index>}` |
| 19 | **draw** `[[tool,color,width,x1,y1,x2,y2], …]` |
| 30 | chat / guess (`{data:"<text>"}` to send) |

## 🙏 Credits

- [doodleNet](https://github.com/yining1023/doodleNet) & [ml5.js](https://ml5js.org) — QuickDraw classifier
- [Quick, Draw! Dataset](https://github.com/googlecreativelab/quickdraw-dataset) — human doodles
- [skribbl word lists](https://github.com/skribbliohints/skribbliohints.github.io)

## ⚠️ Disclaimer

For educational and personal use. Using bots may violate skribbl.io's terms of service — run it in your own private rooms and be considerate of other players.

## 📄 License

[MIT](LICENSE)
