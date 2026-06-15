// Dictionary guesser: match the wordlist against skribbl's length-mask +
// revealed-letter hints, then guess like a human — quietly waiting until the
// revealed letters narrow the field, then sending only the top pick or two.
//
// Anti-spam: it stays silent while many words still fit (the "confidence gate"),
// guessing only once candidates drop to a handful. Timing is jittered and text
// is lowercased with the occasional typo so it doesn't read as a bot.
//
// skribbl reveals spaces/hyphens up-front and hint positions index into the full
// string, so one matcher handles single- and multi-word answers alike.

import { humanize, jitter } from './human.js';

export class DictionaryGuesser {
  /**
   * @param {Array<{word,key,picked,sr}>} entries  from loadWordlist()
   * @param {object} [opts]
   * @param {number} [opts.baseIntervalMs=2600]  rough gap between guesses (jittered)
   * @param {number} [opts.maxGuesses=4]          hard cap per round
   * @param {number} [opts.confidenceMax=6]       only guess when ≤ this many fit
   * @param {number} [opts.typoChance=0.15]       chance of a human typo (wide fields only)
   * @param {(text:string)=>void} [opts.send]
   */
  constructor(entries, {
    baseIntervalMs = 2600, maxGuesses = 4, confidenceMax = 8,
    typoChance = 0.15, visionThreshold = 0.12, send = () => {},
  } = {}) {
    this.entries = entries;
    this.baseIntervalMs = baseIntervalMs;
    this.maxGuesses = maxGuesses;
    this.confidenceMax = confidenceMax;
    this.typoChance = typoChance;
    this.visionThreshold = visionThreshold;
    this.send = send;
    this.onGuess = null; // observer(cleanWord, remaining, sentText, source)
    this._reset();
  }

  _reset() {
    this.active = false;
    this.timer = null;
    this.tried = new Set();
    this.count = 0;
    this.word = null;
    this.hints = [];
    this.solved = false;
    this.vision = new Map(); // word.key -> prob, from doodleNet
  }

  /** Feed the latest doodleNet predictions ([{label,prob}]). */
  setVision(preds) {
    this.vision = new Map((preds || []).map((p) => [p.label.toLowerCase(), p.prob]));
    this._schedule(jitter(1200)); // a fresh, confident read may let us guess now
  }

  /** Total slot count incl. spaces/hyphens (skribbl `word` is [len] or [l1,l2,…]). */
  _len(word) {
    if (Array.isArray(word)) return word.reduce((a, b) => a + (Number(b) || 0), 0);
    return Number(word) || 0;
  }

  /** Per-position constraint array (null = unknown, else lowercased char). */
  _pattern(len, hints) {
    const pat = new Array(len).fill(null);
    for (const h of hints || []) {
      if (h && typeof h.char === 'string' && Number.isInteger(h.position) && h.position < len) {
        pat[h.position] = h.char.toLowerCase();
      }
    }
    return pat;
  }

  /** Ranked candidate entries matching the current length + revealed letters. */
  candidates(word = this.word, hints = this.hints) {
    const len = this._len(word);
    if (!len) return [];
    const pat = this._pattern(len, hints);
    const out = [];
    for (const e of this.entries) {
      if (e.key.length !== len) continue;
      let ok = true;
      for (let i = 0; i < len; i++) {
        if (pat[i] !== null && e.key[i] !== pat[i]) { ok = false; break; }
      }
      if (ok) out.push(e);
    }
    out.sort((a, b) => b.picked - a.picked || b.sr - a.sr);
    return out;
  }

  start(word, hints) {
    this._reset();
    this.active = true;
    this.word = word;
    this.hints = hints || [];
    this._schedule(jitter(this.baseIntervalMs)); // initial "thinking" pause
  }

  /** New hint reveal / state update mid-round — may make us newly confident. */
  update(word, hints) {
    if (!this.active) return;
    if (word != null) this.word = word;
    if (hints) this.hints = hints;
    this._schedule(jitter(1500));
  }

  markSolved() { this.solved = true; this.stop(); }

  stop() {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  _schedule(delay) {
    if (!this.active) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this._consider(), delay);
  }

  _consider() {
    this.timer = null;
    if (!this.active || this.solved) return;
    if (this.count >= this.maxGuesses) return this.stop();

    const cands = this.candidates().filter((e) => !this.tried.has(e.key));
    if (!cands.length) return; // nothing fits yet — wait for the next reveal

    // Vision shortcut: if doodleNet confidently recognizes a word that also fits
    // the length/hints, guess it now — no need to wait for revealed letters.
    let next = null, source = 'dict';
    let best = null, bestProb = 0;
    for (const e of cands) {
      const p = this.vision.get(e.key) ?? 0;
      if (p > bestProb) { bestProb = p; best = e; }
    }
    if (best && bestProb >= this.visionThreshold) {
      next = best; source = `vision ${(bestProb * 100).toFixed(0)}%`;
    } else if (cands.length > this.confidenceMax) {
      // No confident sighting and the field is still wide → stay quiet (anti-spam).
      this._schedule(jitter(this.baseIntervalMs * 1.5));
      return;
    } else {
      next = cands[0]; // narrow enough — guess the most-popular fit
    }

    this.tried.add(next.key);
    this.count++;
    // Clean text once we're down to the final couple; typos only while exploring.
    const text = humanize(next.word, cands.length > 2 && source === 'dict' ? this.typoChance : 0);
    this.send(text);
    this.onGuess?.(next.word, cands.length, text, source);

    this._schedule(jitter(this.baseIntervalMs));
  }
}
