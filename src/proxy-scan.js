// Fetch public proxy lists, latency-test each against skribbl, and write the
// fastest working ones to data/proxies.txt for use as BOT_PROXIES.
//
//   bun run proxies                         # top 25 http proxies
//   bun run proxies --proto socks5 --limit 40 --timeout 5000
//
// ⚠️ Public proxies are flaky and insecure — many will be dead within minutes,
// and a proxy that reaches skribbl.io:443 here may still fail the game socket
// (high port). Re-run this often; the bot rotates and retries past dead ones.

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PROTO = arg('proto', 'http').toLowerCase();
const LIMIT = Number(arg('limit', 25));
const TIMEOUT = Number(arg('timeout', 6000));
const CONC = Number(arg('concurrency', 80));
const TEST_URL = 'https://skribbl.io/';   // proves HTTPS reachability to skribbl + latency

const SOURCES = {
  http: [
    'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  ],
  socks5: [
    'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=ipport&format=text',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
  ],
};

const fetchList = async (url) => {
  try {
    const t = await (await fetch(url, { signal: AbortSignal.timeout(15000) })).text();
    return t.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
};

const normalize = (line) => {
  const s = line.replace(/^\w+:\/\//, '');
  if (!/^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(s)) return null;
  return (PROTO === 'socks5' ? 'socks5://' : 'http://') + s;
};

async function test(proxy) {
  const t = Date.now();
  try {
    const r = await fetch(TEST_URL, { method: 'HEAD', proxy, signal: AbortSignal.timeout(TIMEOUT) });
    if (r.status && r.status < 500) return Date.now() - t;
  } catch { /* dead */ }
  return null;
}

async function pool(items, fn, conc) {
  const out = new Array(items.length);
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
      if (++done % 100 === 0) process.stdout.write(`\r  tested ${done}/${items.length}…`);
    }
  }));
  return out;
}

const sources = SOURCES[PROTO] || SOURCES.http;
console.log(`fetching ${PROTO} proxy lists…`);
const raw = (await Promise.all(sources.map(fetchList))).flat();
const cands = [...new Set(raw.map(normalize).filter(Boolean))];
if (!cands.length) { console.log('no candidates fetched (network?)'); process.exit(1); }
console.log(`testing ${cands.length} candidates vs ${TEST_URL} (timeout ${TIMEOUT}ms, ${CONC} parallel)…`);
const lat = await pool(cands, test, CONC);
const ok = cands.map((p, i) => ({ p, ms: lat[i] })).filter((x) => x.ms != null).sort((a, b) => a.ms - b.ms);
const top = ok.slice(0, LIMIT);

console.log(`\n\n✓ ${ok.length}/${cands.length} working — top ${top.length}:`);
for (const x of top) console.log(`  ${String(x.ms).padStart(5)}ms  ${x.p}`);

await Bun.write('data/proxies.txt', top.map((x) => x.p).join(',') + '\n');
console.log(`\nwrote data/proxies.txt`);
console.log(`use it:\n  BOT_PROXIES=$(cat data/proxies.txt) docker compose -f docker-compose.harvest.yml up -d --scale harvester=10`);
