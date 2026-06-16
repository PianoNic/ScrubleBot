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
import { randomName } from './human.js';
import { Stats } from './stats.js';
import { pickProxy, maskProxy } from './proxy.js';

// Accept a custom lobby as a room code or a full invite URL
// (e.g. "ABCD1234" or "https://skribbl.io/?ABCD1234"), via CLI arg or BOT_JOIN.
function parseRoomCode(input) {
  if (!input) return '';
  let s = String(input).trim();
  if (s.includes('?')) s = s.split('?').pop();   // strip up to the query
  return s.split(/[&#/]/)[0];                     // take the code token
}

const cliJoin = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : '';
// BOT_NAME_RANDOM=1 → a believable human-ish name per bot (for a harvest fleet).
const cfg = {
  name: process.env.BOT_NAME_RANDOM === '1' ? randomName() : (process.env.BOT_NAME || 'ScrubleBot'),
  lang: Number(process.env.BOT_LANG ?? 0),
  create: Number(process.env.BOT_CREATE ?? 0),   // 1 = create a private room
  join: parseRoomCode(cliJoin || process.env.BOT_JOIN || ''), // room code/URL, '' = public
  guess: process.env.BOT_GUESS !== '0',          // dictionary guesser on by default
  vision: process.env.BOT_VISION !== '0',        // doodleNet "look at the drawing" on by default
  learn: process.env.BOT_LEARN !== '0',          // harvest drawings + few-shot detection on by default
  models: process.env.BOT_MODELS === '1',        // load the from-scratch color-aware ONNX detector
  leaveUndrawable: process.env.BOT_LEAVE_UNDRAWABLE === '1', // on our turn, if we can't draw any offered word, leave for a fresh game
};

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

const proxy = pickProxy();
if (proxy) log('🌐 routing via proxy', maskProxy(proxy));
const bot = new SkribblClient({ name: cfg.name, proxy });
const stats = new Stats(cfg.name);   // rounds/guesses/wins for the dashboard

// Wordlist powers both the guesser and the "which offered word to draw" pick.
const entries = await loadWordlist(cfg.lang);
const rankByKey = new Map(entries.map((e) => [e.key, e.picked]));
const drawable = await getCategories();   // QuickDraw categories we can draw
log(`📖 loaded ${entries.length} words, ${drawable.size} drawable categories`);

// --- Phase 2: dictionary guesser -------------------------------------------
let guesser = null;
if (cfg.guess) {
  guesser = new DictionaryGuesser(entries, { send: (text) => bot.guess(text) });
  guesser.onGuess = (word, remaining, sent, source) => {
    stats.inc('guesses');
    log(`   🤔 guessing "${sent}"${sent !== word.toLowerCase() ? ` (=${word})` : ''} — ${remaining} fit [${source}]`);
  };
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
  if (!guesser || bot.isDrawing) return;
  const grid = canvas.toGrid28();
  if (!grid) return;
  // doodleNet (grayscale 345) and the trained color detector are both optional;
  // fuse whichever are present. Single-model mode = BOT_VISION=0 + BOT_MODELS=1.
  let preds = doodle ? mergeVision(doodle.classify(grid, 8), fewshot ? fewshot.match(grid, 5) : []) : [];
  if (detector?.enabled) {
    const rgb = canvas.toRGB();
    if (rgb) preds = mergeVision(preds, await detector.classify(rgb, 8));
  }
  if (!preds.length) return;
  guesser.setVision(preds);
  const top = preds.slice(0, 3).map((p) => `${p.label} ${(p.prob * 100).toFixed(0)}%`).join(', ');
  log(`   👁  sees: ${top}`);
}

function startVision() {
  stopVision();
  if (!doodle && !detector?.enabled) return;
  visionTimer = setInterval(classifyNow, 2500);
}
function stopVision() { if (visionTimer) clearInterval(visionTimer); visionTimer = null; }

let shuttingDown = false;
let lastLeftRoom = null;   // room we just left, to avoid matchmaking back into it
// Intentionally leave the current game and matchmake into a fresh one (used by
// harvest bots when it's their turn and they can't draw any offered word).
function rejoinFresh(reason) {
  if (shuttingDown) return;
  lastLeftRoom = bot.room?.id ?? lastLeftRoom;
  log(`🚪 leaving (${reason}) → new game`);
  guesser?.stop(); stopVision();
  try { bot.close(); } catch { /* already closed */ }
  setTimeout(() => bot.join({ create: 0, join: '' }).catch((e) => log('rejoin failed:', e?.message)), 1500);
}

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
  // If matchmaking dropped us back into the room we just left, bounce again.
  if (cfg.leaveUndrawable && room.id && room.id === lastLeftRoom) {
    log(`   ↩ matchmade back into ${room.id} — leaving for a different lobby`);
    rejoinFresh('same room');
    return;
  }
  lastLeftRoom = null;
  log(`🏠 joined room ${room.id} (type ${room.type}) — ${room.users.length} players, me=#${room.me}`);
  log('   players:', room.users.map((u) => u.name).join(', '));
});

bot.on('playerJoin', (u) => log(`➕ ${u.name} joined`));
bot.on('playerLeft', (d) => log(`➖ ${bot.userName(d.id)} left`));
bot.on('chat', ({ name, msg }) => log(`💬 ${name}: ${msg}`));
bot.on('guessedCorrect', (d) => {
  log(`✅ ${bot.userName(d.id)} guessed it`);
  if (d.id === bot.me) { log('   🎉 WE GOT IT'); guesser?.markSolved(); stats.inc('wins'); }
});

bot.on('turnStart', ({ drawerId, time }) =>
  log(`✏️  turn: ${bot.userName(drawerId)} is choosing a word (${time}s)`));

bot.on('yourTurnChoose', ({ time, data }) => {
  const words = data?.words ?? [];
  const canDraw = (w) => {
    const k = String(w).toLowerCase();
    return drawable.has(k) || harvestHas(w) || (generator?.enabled && generator.knows(w));
  };
  if (cfg.leaveUndrawable) {
    // Pick a word we can actually draw — prefer a QuickDraw category (best quality),
    // else a harvested/generated one. If none is drawable, leave for a fresh game.
    let idx = words.findIndex((w) => drawable.has(String(w).toLowerCase()));
    if (idx < 0) idx = words.findIndex(canDraw);
    if (idx < 0) { rejoinFresh(`our turn but can't draw ${JSON.stringify(words)}`); return; }
    log(`🎯 OUR TURN — choices ${JSON.stringify(words)} → picking "${words[idx]}" (drawable ✏️)`);
    bot.chooseWord(idx);
    return;
  }
  const idx = pickWordIndex(words, rankByKey, drawable);
  const can = drawable.has(String(words[idx]).toLowerCase());
  log(`🎯 OUR TURN — choices ${JSON.stringify(words)} → picking "${words[idx]}"${can ? ' (drawable ✏️)' : ''}`);
  bot.chooseWord(idx);
});

// Draw a doodle for our word, stroke-by-stroke so it looks live. Prefers a real
// QuickDraw drawing; falls back to a harvested (learned) one for words outside
// the 345 categories; finally a placeholder.
async function drawOurTurn(word) {
  const key = String(word).toLowerCase();
  let strokes = null, source = null;

  const tryQuickDraw = async () => {
    try { const s = await doodleStrokes(word, { width: 8 }); if (s) { strokes = s; source = 'QuickDraw'; } }
    catch (e) { log('   ⚠️  quickdraw fetch failed:', e?.message); }
  };
  const tryGenerator = async () => {
    if (!(generator?.enabled && generator.knows(key))) return;
    try {
      const g = await generator.draw(key);
      if (g) { strokes = strokesToSegments(g.drawing, { width: 8, colors: g.colors }); source = 'generator'; }
    } catch (e) { log('   ⚠️  generator failed:', e?.message); }
  };

  // QuickDraw categories → replay a real human doodle (far more recognizable than
  // the synthetic generator). The generator is the *primary* drawer only for words
  // QuickDraw doesn't cover (harvested/new words); each falls back to the other.
  if (drawable.has(key)) { await tryQuickDraw(); if (!strokes) await tryGenerator(); }
  else { await tryGenerator(); if (!strokes) await tryQuickDraw(); }

  if (!strokes) { strokes = learnedStrokes(word, { width: 8 }); if (strokes) source = 'learned'; }
  if (!strokes) {
    // Harvest bots leave rather than scribble a placeholder; full bots draw one.
    if (cfg.leaveUndrawable) { rejoinFresh(`couldn't draw "${word}"`); return; }
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
  if (!bot.isDrawing) stats.inc('rounds');
  if (harvester && !bot.isDrawing) {
    const r = harvester.finish(word);
    if (r.saved) { stats.set('harvested', r.total); log(`   🧠 learned "${r.word}" (${r.strokes} strokes) — ${r.total} drawings known`); }
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

// BOT_DEBUG=1 dumps every raw frame — use it in a live game to confirm the
// still-unverified opcodes (15 guessed-correct, 21 clear) against real payloads.
if (process.env.BOT_DEBUG === '1') {
  bot.on('raw', ({ id, data }) => log(`🐛 op${id}:`, String(JSON.stringify(data)).slice(0, 200)));
}

log('starting…', cfg);
log(cfg.join ? `🔑 joining custom lobby "${cfg.join}"` : (cfg.create ? '🏗  creating private room' : '🌐 public matchmaking'));

// Stagger startup so a fleet doesn't all hit matchmaking at once (BOT_START_DELAY
// = max random seconds to wait before the first join).
const startDelay = Number(process.env.BOT_START_DELAY ?? 0);
if (startDelay > 0) {
  const d = Math.random() * startDelay;
  log(`⏳ staggering start by ${d.toFixed(1)}s`);
  await new Promise((r) => setTimeout(r, d * 1000));
}

// Resilient first join: matchmaking can rate-limit (esp. a fleet), so retry with
// backoff + jitter instead of crashing the process.
async function joinWithRetry() {
  for (let attempt = 1; !shuttingDown; attempt++) {
    try { await bot.join({ create: cfg.create, join: cfg.join }); return; }
    catch (e) {
      const wait = Math.min(30000, 1500 * attempt) + Math.floor(Math.random() * 1500);
      log(`⚠️  join failed (${e?.message || e}) — retry ${attempt} in ${(wait / 1000).toFixed(0)}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
await joinWithRetry();

// Optional bounded run for testing: BOT_RUN_SECONDS=20 bun run src/index.js
if (process.env.BOT_RUN_SECONDS) {
  setTimeout(() => { shuttingDown = true; log('⏱  test window elapsed, exiting'); bot.close(); process.exit(0); },
    Number(process.env.BOT_RUN_SECONDS) * 1000);
}

// Keep the process alive; Ctrl-C to quit.
process.on('SIGINT', () => { shuttingDown = true; log('bye'); bot.close(); process.exit(0); });
