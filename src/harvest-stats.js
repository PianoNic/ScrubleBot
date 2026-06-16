// Harvest overview: how many drawings, how many distinct words, which are new
// (outside QuickDraw — the ones harvesting uniquely adds), and the top words.
//   bun run harvest

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { getCategories } from './quickdraw.js';

const DIR = new URL('../data/harvest/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
if (!existsSync(DIR)) { console.log('no harvest yet (data/harvest/ is empty)'); process.exit(0); }

const files = readdirSync(DIR).filter((f) => /^samples.*\.ndjson$/.test(f));
const counts = new Map();
let total = 0, bad = 0;
for (const f of files) {
  for (const line of readFileSync(DIR + f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const { word } = JSON.parse(line);
      if (word) { counts.set(word, (counts.get(word) || 0) + 1); total++; }
    } catch { bad++; }
  }
}

const qd = await getCategories();
const words = [...counts.keys()];
const newWords = words.filter((w) => !qd.has(w.toLowerCase())).sort();

console.log(`\n📊 Harvest overview — ${files.length} shard${files.length === 1 ? '' : 's'}`);
console.log(`   drawings:      ${total}`);
console.log(`   unique words:  ${words.length}  (${newWords.length} not in QuickDraw)`);
if (bad) console.log(`   skipped:       ${bad} unreadable line(s)`);

const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
console.log('\n   most-harvested words:');
for (const [w, c] of top) console.log(`     ${String(c).padStart(4)}  ${w}`);

if (newWords.length) {
  console.log(`\n   new words QuickDraw can't draw [${newWords.length}] — these need the harvest:`);
  console.log('     ' + newWords.slice(0, 50).join(', ') + (newWords.length > 50 ? ' …' : ''));
}
console.log();
