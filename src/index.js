// scrübleBot entry point.
// Phase 1: join a lobby and observe the round flow (verifies the protocol +
// matchmaking + client end-to-end). Guessing/drawing modules layer on next.

import { SkribblClient } from './client.js';
import { loadWordlist } from './wordlist.js';
import { DictionaryGuesser } from './guesser.js';
import { pickWordIndex, placeholderStrokes } from './drawer.js';
import { DoodleNet } from './doodlenet.js';
import { StrokeCanvas } from './canvas.js';
import { doodleStrokes, getCategories } from './quickdraw.js';
import { DoodleHarvester } from './harvester.js';
import { learnedStrokes, harvestHas, FewShotDetector } from './learned.js';
import { ColorDetector } from './onnx.js';
import { SketchGenerator } from './sketchrnn.js';
import { strokesToSegments } from './strokes.js';

// Accept a custom lobby as a room code or a full invite URL
// (e.g. "ABCD1234" or "https://skribbl.io/?ABCD1234"), via CLI arg or BOT_JOIN.
function parseRoomCode(input) {
  if (!input) return '';
  let s = String(input).trim();
  if (s.includes('?')) s = s.split('?').pop();   // strip up to the query
  return s.split(/[&#/]/)[0];                     // take the code token
}

const cliJoin = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : '';
const cfg = {
  name: process.env.BOT_NAME || 'ScrubleBot',
  lang: Number(process.env.BOT_LANG ?? 0),
  create: Number(process.env.BOT_CREATE ?? 0),   // 1 = create a private room
  join: parseRoomCode(cliJoin || process.env.BOT_JOIN || ''), // room code/URL, '' = public
  guess: process.env.BOT_GUESS !== '0',          // dictionary guesser on by default
  vision: process.env.BOT_VISION !== '0',        // doodleNet "look at the drawing" on by default
  learn: process.env.BOT_LEARN !== '0',          // harvest drawings + few-shot detection on by default
  models: process.env.BOT_MODELS === '1',        // load the from-scratch color-aware ONNX detector
};

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

const bot = new SkribblClient({ name: cfg.name });

// Wordlist powers both the guesser and the "which offered word to draw" pick.
const entries = await loadWordlist(cfg.lang);
const rankByKey = new Map(entries.map((e) => [e.key, e.picked]));
const drawable = await getCategories();   // QuickDraw categories we can draw
log(`📖 loaded ${entries.length} words, ${drawable.size} drawable categories`);

// --- Phase 2: dictionary guesser -------------------------------------------
let guesser = null;
if (cfg.guess) {
  guesser = new DictionaryGuesser(entries, { send: (text) => bot.guess(text) });
  guesser.onGuess = (word, remaining, sent, source) =>
    log(`   🤔 guessing "${sent}"${sent !== word.toLowerCase() ? ` (=${word})` : ''} — ${remaining} fit [${source}]`);
}

// --- Phase 4: vision ("look at the drawing") -------------------------------
let doodle = null;
const canvas = new StrokeCanvas();
let visionTimer = null;
if (cfg.vision) {
  doodle = await new DoodleNet().load();
  log(`👁  doodleNet ready (${doodle.labels.length} classes)`);
}

// --- Learning loop: harvest drawings + few-shot detection ------------------
let harvester = null, fewshot = null;
if (cfg.learn) {
  harvester = new DoodleHarvester();
  const s = harvester.stats();
  log(`🧠 learning on — harvested ${s.total} drawings across ${s.words} words`);
  if (doodle && s.total) {
    fewshot = new FewShotDetector(doodle);
    log(`   built few-shot library of ${fewshot.build()} examples`);
  }
}

// --- From-scratch color-aware detector (ONNX, trained on the harvest) -------
let detector = null, generator = null;
if (cfg.models) {
  detector = await new ColorDetector().load();
  if (detector.enabled) log(`🎨 color detector ready (${detector.labels.length} learned words)`);
  else log('🎨 color detector enabled but no trained model yet — will pick one up once trained');

  generator = await new SketchGenerator().load();
  if (generator.enabled) log(`🖌  sketch generator ready (${generator.meta.vocab.length} drawable words)`);
}

/** Merge doodleNet + few-shot predictions, keeping the max score per label. */
function mergeVision(a, b) {
  const m = new Map();
  for (const p of [...a, ...b]) if ((m.get(p.label) ?? 0) < p.prob) m.set(p.label, p.prob);
  return [...m.entries()].map(([label, prob]) => ({ label, prob })).sort((x, y) => y.prob - x.prob);
}

async function classifyNow() {
  if (!doodle || !guesser || bot.isDrawing) return;
  const grid = canvas.toGrid28();
  if (!grid) return;
  let preds = mergeVision(doodle.classify(grid, 8), fewshot ? fewshot.match(grid, 5) : []);
  // Fuse the from-scratch color-aware detector (sees the RGB canvas).
  if (detector?.enabled) {
    const rgb = canvas.toRGB();
    if (rgb) preds = mergeVision(preds, await detector.classify(rgb, 8));
  }
  guesser.setVision(preds);
  const top = preds.slice(0, 3).map((p) => `${p.label} ${(p.prob * 100).toFixed(0)}%`).join(', ');
  log(`   👁  sees: ${top}`);
}

function startVision() {
  stopVision();
  if (!doodle) return;
  visionTimer = setInterval(classifyNow, 2500);
}
function stopVision() { if (visionTimer) clearInterval(visionTimer); visionTimer = null; }

let shuttingDown = false;
bot.on('server', ({ raw, origin, path }) => log('🛰  matchmaking →', raw, `(io ${origin} path ${path})`));
bot.on('connect', () => log('🔌 connected, logging in as', cfg.name));
bot.on('error', (e) => log('⚠️  error:', e?.message || e));
bot.on('disconnect', (r) => {
  guesser?.stop();
  stopVision();
  log('❌ disconnected:', r);
  if (shuttingDown || r === 'io client disconnect') return;
  log('🔁 rejoining in 3s…');
  setTimeout(() => bot.join({ create: cfg.create, join: cfg.join }).catch((e) => log('rejoin failed:', e?.message)), 3000);
});

bot.on('lobby', (room) => {
  log(`🏠 joined room ${room.id} (type ${room.type}) — ${room.users.length} players, me=#${room.me}`);
  log('   players:', room.users.map((u) => u.name).join(', '));
});

bot.on('playerJoin', (u) => log(`➕ ${u.name} joined`));
bot.on('playerLeft', (d) => log(`➖ ${bot.userName(d.id)} left`));
bot.on('chat', ({ name, msg }) => log(`💬 ${name}: ${msg}`));
bot.on('guessedCorrect', (d) => {
  log(`✅ ${bot.userName(d.id)} guessed it`);
  if (d.id === bot.me) { log('   🎉 WE GOT IT'); guesser?.markSolved(); }
});

bot.on('turnStart', ({ drawerId, time }) =>
  log(`✏️  turn: ${bot.userName(drawerId)} is choosing a word (${time}s)`));

bot.on('yourTurnChoose', ({ time, data }) => {
  const words = data?.words ?? [];
  const idx = pickWordIndex(words, rankByKey, drawable);
  const can = drawable.has(String(words[idx]).toLowerCase());
  log(`🎯 OUR TURN — choices ${JSON.stringify(words)} → picking "${words[idx]}"${can ? ' (drawable ✏️)' : ''}`);
  bot.chooseWord(idx);
});

// Draw a doodle for our word, stroke-by-stroke so it looks live. Prefers a real
// QuickDraw drawing; falls back to a harvested (learned) one for words outside
// the 345 categories; finally a placeholder.
async function drawOurTurn(word) {
  let strokes = null, source = 'QuickDraw';
  // Prefer the learned generator when it knows the word (draws it itself);
  // otherwise replay a real QuickDraw doodle, then a harvested one.
  if (generator?.enabled && generator.knows(word)) {
    try {
      const drawing = await generator.draw(word);
      if (drawing) { strokes = strokesToSegments(drawing, { width: 8 }); source = 'generator'; }
    } catch (e) { log('   ⚠️  generator failed:', e?.message); }
  }
  if (!strokes) {
    try { strokes = await doodleStrokes(word, { width: 8 }); }
    catch (e) { log('   ⚠️  quickdraw fetch failed:', e?.message); }
  }
  if (!strokes) { strokes = learnedStrokes(word, { width: 8 }); source = 'learned'; }
  if (!strokes) {
    log(`   ✍️  "${word}" unknown → placeholder`);
    bot.draw(placeholderStrokes());
    return;
  }
  log(`   ✏️  source: ${source}`);
  // Draw one segment at a time, spread over ~9s, so it's visibly drawn live
  // (not dumped instantly). skribbl streams strokes exactly like this.
  const segs = strokes.flat();
  const gap = Math.max(45, Math.min(220, Math.floor(9000 / Math.max(1, segs.length))));
  log(`   🎨 drawing "${word}" — ${segs.length} segments over ~${((segs.length * gap) / 1000).toFixed(1)}s`);
  for (const seg of segs) {
    if (!bot.isDrawing) break;        // turn ended early
    bot.draw([seg]);
    await new Promise((r) => setTimeout(r, gap));
  }
}

bot.on('drawing', ({ drawerId, word, hints, time }) => {
  const mask = Array.isArray(word) ? `${word.join('+')} letters` : `"${word}"`;
  log(`🎨 ${bot.userName(drawerId)} drawing — word: ${mask}, hints: ${JSON.stringify(hints)}, ${time}s`);

  canvas.clear();                    // fresh canvas each round
  if (bot.isDrawing) {
    guesser?.stop();
    stopVision();                    // our turn → don't watch/guess
    drawOurTurn(typeof word === 'string' ? word : '');
    return;
  }
  guesser?.start(word, hints);       // new round → begin guessing
  startVision();                     // …and start watching the canvas
  harvester?.startRound();           // …and record the drawing to learn from
});

// Incoming strokes from the current drawer — accumulate for vision + learning.
bot.on('draw', (segments) => {
  if (bot.isDrawing) return;
  canvas.add(segments);
  harvester?.add(segments);
});
bot.on('clear', () => { canvas.clear(); harvester?.startRound(); });

// Revealed letters (op13) — feed the guesser so it can narrow with confidence.
bot.on('hints', ({ word, hints }) => {
  if (guesser && !bot.isDrawing) guesser.update(word, hints);
});

bot.on('roundEnd', ({ word, reason }) => {
  guesser?.stop();
  stopVision();
  // Learn from the round we just watched, then clear.
  if (harvester && !bot.isDrawing) {
    const r = harvester.finish(word);
    if (r.saved) log(`   🧠 learned "${r.word}" (${r.strokes} strokes) — ${r.total} drawings known`);
  }
  // The trainer writes a newer detector.onnx as the harvest grows — pick it up live.
  detector?.maybeReload().then((did) => {
    if (did) log(`   🔄 reloaded color detector (${detector.labels.length} learned words)`);
  });
  generator?.maybeReload().then((did) => {
    if (did) log(`   🔄 reloaded sketch generator (${generator.meta.vocab.length} drawable words)`);
  });
  canvas.clear();
  log(`🔚 round end — word was "${word}" (reason ${reason})`);
});

// Surface anything we haven't mapped yet, to keep filling the protocol.
bot.on('unknown', ({ id, data }) => log(`❓ unknown op${id}:`, String(JSON.stringify(data) ?? data).slice(0, 160)));

log('starting…', cfg);
log(cfg.join ? `🔑 joining custom lobby "${cfg.join}"` : (cfg.create ? '🏗  creating private room' : '🌐 public matchmaking'));
await bot.join({ create: cfg.create, join: cfg.join });

// Optional bounded run for testing: BOT_RUN_SECONDS=20 bun run src/index.js
if (process.env.BOT_RUN_SECONDS) {
  setTimeout(() => { shuttingDown = true; log('⏱  test window elapsed, exiting'); bot.close(); process.exit(0); },
    Number(process.env.BOT_RUN_SECONDS) * 1000);
}

// Keep the process alive; Ctrl-C to quit.
process.on('SIGINT', () => { shuttingDown = true; log('bye'); bot.close(); process.exit(0); });
