// Make the bot's chat read like a person typing, not a dictionary dump:
// lowercase, jittered "thinking" timing, and the occasional natural typo.

const ADJACENT = {
  a: 'sqzw', b: 'vghn', c: 'xdfv', d: 'sefcx', e: 'wrsd', f: 'drtgcv', g: 'ftyhbv',
  h: 'gyujnb', i: 'ujko', j: 'huikmn', k: 'jiolm', l: 'kop', m: 'njk', n: 'bhjm',
  o: 'iklp', p: 'ol', q: 'wa', r: 'edft', s: 'awedxz', t: 'rfgy', u: 'yhji',
  v: 'cfgb', w: 'qase', x: 'zsdc', y: 'tghu', z: 'asx',
};

const rand = (n) => Math.floor(Math.random() * n);
const chance = (p) => Math.random() < p;

/** A human-ish delay around `base` ms (±~40%, never below 600ms). */
export function jitter(base) {
  const d = base * (0.7 + Math.random() * 0.7);
  return Math.max(600, Math.round(d));
}

/**
 * Lowercase the guess and, with probability `typo`, introduce one realistic
 * slip (adjacent-key, swapped pair, or dropped letter). Words shorter than 4
 * chars are left clean (typos there just look broken).
 * @param {string} word
 * @param {number} [typo=0]  0..1 probability of a typo
 */
export function humanize(word, typo = 0) {
  let s = String(word).toLowerCase();
  if (typo <= 0 || s.length < 4 || !chance(typo)) return s;

  const a = s.split('');
  const kind = rand(3);
  const i = 1 + rand(a.length - 2); // avoid first/last char
  if (kind === 0 && ADJACENT[a[i]]) {
    const opts = ADJACENT[a[i]];
    a[i] = opts[rand(opts.length)];          // adjacent-key hit
  } else if (kind === 1) {
    [a[i], a[i + 1]] = [a[i + 1], a[i]];      // transpose
  } else {
    a.splice(i, 1);                           // dropped letter
  }
  return a.join('');
}
