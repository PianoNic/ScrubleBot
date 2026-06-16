// Harvest dashboard — a tiny Bun server (no build step) serving a single
// shadcn-styled page: live stats, the running harvesters, and a gallery of the
// drawings already collected. Reads the shared data/harvest volume. KISS.
//   bun run src/dashboard.js   (PORT env, default 28080)

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { getCategories } from './quickdraw.js';
import { PALETTE } from './protocol.js';

const DIR = new URL('../data/harvest/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PORT = Number(process.env.PORT || 28080);

const shardFiles = () => { try { return readdirSync(DIR).filter((f) => /^samples.*\.ndjson$/.test(f)); } catch { return []; } };

function harvesters() {
  let files = [];
  try { files = readdirSync(DIR).filter((f) => /^stats\..*\.json$/.test(f)); } catch { return []; }
  const now = Date.now();
  return files.map((f) => {
    try {
      const d = JSON.parse(readFileSync(DIR + f, 'utf8'));
      return { ...d, active: now - statSync(DIR + f).mtimeMs < 60000 };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => (b.active - a.active) || (b.rounds || 0) - (a.rounds || 0));
}

async function aggregate() {
  const counts = new Map();
  let total = 0;
  for (const f of shardFiles()) {
    try {
      for (const line of readFileSync(DIR + f, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const w = JSON.parse(line).word; if (w) { counts.set(w, (counts.get(w) || 0) + 1); total++; } } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  const qd = await getCategories();
  const words = [...counts.keys()];
  const hs = harvesters();
  const sum = (k) => hs.reduce((s, x) => s + (x[k] || 0), 0);
  return {
    drawings: total,
    words: words.length,
    newWords: words.filter((w) => !qd.has(w.toLowerCase())).length,
    trainable: [...counts.values()].filter((c) => c >= 3).length,
    online: hs.filter((h) => h.active).length,
    guesses: sum('guesses'), wins: sum('wins'), rounds: sum('rounds'),
    top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
    harvesters: hs,
  };
}

function recentDrawings(n = 24) {
  const out = [];
  for (const f of shardFiles()) {
    try {
      const lines = readFileSync(DIR + f, 'utf8').split('\n');
      for (let i = Math.max(0, lines.length - n - 1); i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try { const o = JSON.parse(lines[i]); if (Array.isArray(o.drawing)) out.push({ word: o.word, drawing: o.drawing, colors: o.colors || [], ts: o.ts || 0 }); } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, n);
}

function allDrawings(offset = 0, limit = 60, word = '') {
  const wq = word.trim().toLowerCase();
  const out = [];
  for (const f of shardFiles()) {
    try {
      for (const line of readFileSync(DIR + f, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (!Array.isArray(o.drawing)) continue;
          if (wq && !String(o.word || '').toLowerCase().includes(wq)) continue;
          out.push({ word: o.word, drawing: o.drawing, colors: o.colors || [], ts: o.ts || 0 });
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  out.sort((a, b) => b.ts - a.ts);
  return { total: out.length, items: out.slice(offset, offset + limit) };
}

const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });

Bun.serve({
  port: PORT,
  async fetch(req) {
    const { pathname, searchParams } = new URL(req.url);
    if (pathname === '/api/stats') return json(await aggregate());
    if (pathname === '/api/drawings') return json(recentDrawings(Number(searchParams.get('n') || 24)));
    if (pathname === '/api/all') return json(allDrawings(Number(searchParams.get('offset') || 0), Number(searchParams.get('limit') || 60), searchParams.get('word') || ''));
    return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
});
console.log(`🎨 dashboard on http://localhost:${PORT}`);

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>ScrubleBot Harvest</title>
<style>
:root{--bg:#09090b;--card:#18181b;--border:#27272a;--fg:#fafafa;--muted:#a1a1aa;--accent:#22c55e;--accent2:#3b82f6}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:20px;font-weight:600;margin:0;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:13px;margin-top:2px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent);margin-right:6px;box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent)}
.grid{display:grid;gap:14px}.cards{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin:22px 0}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px}
.label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:500}
.stat{font-size:28px;font-weight:650;margin-top:6px;letter-spacing:-.02em}
.stat small{font-size:13px;color:var(--muted);font-weight:500}
.section{margin-top:30px}.section h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600;margin:0 0 12px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--border);font-size:13px}
th{color:var(--muted);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.badge{display:inline-flex;align-items:center;gap:5px;background:#0c1f14;color:var(--accent);border:1px solid #14331f;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:500}
.badge.off{background:#1c1c1f;color:var(--muted);border-color:var(--border)}
.gallery{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}
.tile{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:8px;overflow:hidden}
.tile svg{width:100%;height:110px;background:#fff;border-radius:8px;display:block}
.tile .w{margin-top:7px;font-size:12px;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chips{display:flex;flex-wrap:wrap;gap:7px}
.chip{background:var(--card);border:1px solid var(--border);border-radius:999px;padding:4px 11px;font-size:12px}
.chip b{color:var(--accent2);font-variant-numeric:tabular-nums;margin-left:5px}
.muted{color:var(--muted)}
.search{width:100%;max-width:320px;background:var(--card);border:1px solid var(--border);border-radius:10px;
padding:9px 12px;color:var(--fg);font-size:13px;margin-bottom:14px;outline:none}
.search:focus{border-color:var(--accent2)}
.btn{background:var(--card);border:1px solid var(--border);color:var(--fg);border-radius:10px;
padding:9px 18px;font-size:13px;cursor:pointer}.btn:hover{border-color:var(--accent2)}
</style></head><body><div class="wrap">
<div style="display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:10px">
<div><h1>🎨 ScrubleBot · Harvest</h1><div class="sub" id="updated">loading…</div></div>
<div id="online"></div></div>

<div class="grid cards" id="cards"></div>

<div class="section"><h2>Harvesters</h2><div class="card" style="padding:4px 0">
<table><thead><tr><th>Bot</th><th class="num">Rounds</th><th class="num">Guesses</th><th class="num">Wins</th><th class="num">Win/Guess</th><th>Status</th></tr></thead>
<tbody id="bots"></tbody></table></div></div>

<div class="section"><h2>Most-harvested words</h2><div class="chips" id="top"></div></div>

<div class="section"><h2>Recently harvested drawings</h2><div class="grid gallery" id="gallery"></div></div>

<div class="section"><h2>All harvested drawings <span class="muted" id="allcount"></span></h2>
<input id="search" class="search" placeholder="filter by word…" autocomplete="off">
<div class="grid gallery" id="allgallery"></div>
<div style="text-align:center;margin-top:16px"><button id="more" class="btn">Load more</button></div></div>
</div>
<script>
const PAL=${JSON.stringify(PALETTE)};
const pct=(a,b)=>b?Math.round(100*a/b)+'%':'—';
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const tile=d=>'<div class="tile">'+svg(d)+'<div class="w" title="'+esc(d.word)+'">'+esc(d.word)+'</div></div>';
function svg(d){
  const S=d.drawing||[],C=d.colors||[];let xa=1e9,ya=1e9,xb=-1e9,yb=-1e9;
  for(const[xs,ys]of S){for(const x of xs){if(x<xa)xa=x;if(x>xb)xb=x;}for(const y of ys){if(y<ya)ya=y;if(y>yb)yb=y;}}
  if(xa>xb){xa=ya=0;xb=yb=1;}const w=Math.max(1,xb-xa),h=Math.max(1,yb-ya),sw=Math.max(w,h)/55;
  let p='';S.forEach((s,i)=>{const[xs,ys]=s;const pts=xs.map((x,j)=>x+','+ys[j]).join(' ');
    p+='<polyline points="'+pts+'" fill="none" stroke="'+(PAL[C[i]??1]||'#000')+'" stroke-width="'+sw+'" stroke-linecap="round" stroke-linejoin="round"/>';});
  return '<svg viewBox="'+xa+' '+ya+' '+w+' '+h+'" preserveAspectRatio="xMidYMid meet">'+p+'</svg>';
}
function card(label,val,sub){return '<div class="card"><div class="label">'+label+'</div><div class="stat">'+val+(sub?' <small>'+sub+'</small>':'')+'</div></div>';}
async function tick(){
  try{
    const s=await (await fetch('/api/stats')).json();
    document.getElementById('online').innerHTML='<span class="badge"><span class="dot"></span>'+s.online+' online</span>';
    document.getElementById('updated').textContent='updated '+new Date().toLocaleTimeString();
    document.getElementById('cards').innerHTML=
      card('Drawings',s.drawings.toLocaleString())+
      card('Unique words',s.words.toLocaleString())+
      card('New (non-QuickDraw)',s.newWords.toLocaleString())+
      card('Trainable (≥3)',s.trainable.toLocaleString())+
      card('Win / Guess',pct(s.wins,s.guesses),s.wins+'/'+s.guesses)+
      card('Rounds watched',s.rounds.toLocaleString());
    document.getElementById('bots').innerHTML=s.harvesters.map(h=>
      '<tr><td>'+(h.name||'?')+'</td><td class="num">'+(h.rounds||0)+'</td><td class="num">'+(h.guesses||0)+
      '</td><td class="num">'+(h.wins||0)+'</td><td class="num">'+pct(h.wins||0,h.guesses||0)+
      '</td><td><span class="badge'+(h.active?'':' off')+'">'+(h.active?'live':'idle')+'</span></td></tr>').join('')
      ||'<tr><td colspan="6" class="muted" style="padding:14px 12px">no harvesters yet</td></tr>';
    document.getElementById('top').innerHTML=s.top.map(([w,c])=>'<span class="chip">'+esc(w)+'<b>'+c+'</b></span>').join('');
    const ds=await (await fetch('/api/drawings?n=24')).json();
    document.getElementById('gallery').innerHTML=ds.map(tile).join('')||'<div class="muted">nothing harvested yet</div>';
  }catch(e){document.getElementById('updated').textContent='error: '+e.message;}
}
// "All drawings" — paginated, on-demand, with a word filter.
let off=0,word='',total=0;
async function loadAll(reset){
  if(reset){off=0;word=document.getElementById('search').value;document.getElementById('allgallery').innerHTML='';}
  const r=await (await fetch('/api/all?offset='+off+'&limit=60&word='+encodeURIComponent(word))).json();
  total=r.total;off+=r.items.length;
  document.getElementById('allgallery').insertAdjacentHTML('beforeend',r.items.map(tile).join(''));
  document.getElementById('allcount').textContent='('+total+')';
  document.getElementById('more').style.display=off<total?'':'none';
  if(total===0)document.getElementById('allgallery').innerHTML='<div class="muted">no matches</div>';
}
document.getElementById('more').onclick=()=>loadAll(false);
let st;document.getElementById('search').oninput=()=>{clearTimeout(st);st=setTimeout(()=>loadAll(true),300);};
tick();setInterval(tick,5000);loadAll(true);
</script></body></html>`;
