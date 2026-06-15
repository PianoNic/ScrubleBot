# 🎨 ScrubleBot

A self-hosted [skribbl.io](https://skribbl.io) bot that **joins a lobby, guesses words by looking at the drawing, and draws real doodles on its turn** — as a headless [Socket.IO](https://socket.io) client. No browser at runtime, no auth, one [Bun](https://bun.sh) process.

> It guesses by *watching the canvas* (a QuickDraw CNN), and it draws by *replaying real human doodles* (the Quick, Draw! dataset). Both run in-process — no Python, no cloud.

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
| `BOT_RUN_SECONDS` | – | exit after N seconds (handy for testing) |

### 💡 Tip: only-drawable rooms

For a private game where the bot always draws something recognizable, set the room's
**Custom words** to the contents of [`data/drawable_words.txt`](data/drawable_words.txt)
(the 342 categories the bot can both draw *and* recognize) and tick **"Use custom words only."**

## 🧠 Self-learning (in progress)

While it plays, the bot **harvests** every drawing it watches (labelled by the word
revealed at round-end) into `data/harvest/`. That data trains real neural networks
that learn to **draw and detect new words** — including ones outside QuickDraw's 345.

Training runs in **PyTorch on the GPU** (the RTX 5080 / CUDA 13 is too new for
tfjs's GPU bindings) and exports **ONNX** the Bun bot loads for inference. See
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) for the full design and roadmap.

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
  harvester.js    record (word → drawing) while playing — learning data
  learned.js      use harvested drawings (replay + few-shot) [interim]
  model/          CPU prototype trainers (superseded by PyTorch — see plan)
  drawer.js       word pick + placeholder fallback
  render-png.js   visualize op19 strokes as a PNG (debugging)
  index.js        entry point — wires it all together
data/
  wordlists/      skribbl word lists (per language)
  doodlenet/      doodleNet model + class names
  drawable_words.txt
  harvest/        harvested drawings (generated by playing; gitignored)
  model/          trained models (generated; gitignored)
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
