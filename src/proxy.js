// Outbound proxy support so a fleet doesn't all share one IP.
//   BOT_PROXIES=<csv>     comma list (urls or ip:port[:user:pass])
//   BOT_PROXY_DIR=<dir>   folder of proxy files (default "proxies/"), one entry
//                         per line as ip:port:user:pass / ip:port / full url
//   BOT_PROXY=<url>       a single explicit proxy (overrides the pool)
//   BOT_PROXY_SCHEME      http (default) or socks5, for bare ip:port[:user:pass]
//
// Each bot tries to CLAIM its own proxy from the pool (a lock file in the shared
// data volume) so bots don't share; if the pool is exhausted it shares one.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';

const LOCKDIR = new URL('../data/.proxylocks/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const LOCK_TTL = 90_000;   // a lock older than this (a dead bot) can be reclaimed

function parseLine(line, scheme) {
  const s = line.trim();
  if (!s || s.startsWith('#')) return null;
  if (/^\w+:\/\//.test(s)) return s;                 // already a full url
  const p = s.split(':');
  if (p.length === 4) return `${scheme}://${p[2]}:${p[3]}@${p[0]}:${p[1]}`;  // ip:port:user:pass
  if (p.length === 2) return `${scheme}://${p[0]}:${p[1]}`;                   // ip:port
  return null;
}

/** Build the proxy pool from BOT_PROXIES + every file in BOT_PROXY_DIR. */
export function loadPool() {
  const scheme = (process.env.BOT_PROXY_SCHEME || 'http').toLowerCase();
  const pool = [];
  for (const s of (process.env.BOT_PROXIES || '').split(',')) { const u = parseLine(s, scheme); if (u) pool.push(u); }
  const dir = process.env.BOT_PROXY_DIR || 'proxies';
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (f.startsWith('.') || /\.(md|gitkeep)$/i.test(f)) continue;
      try { for (const line of readFileSync(`${dir}/${f}`, 'utf8').split('\n')) { const u = parseLine(line, scheme); if (u) pool.push(u); } }
      catch { /* skip unreadable */ }
    }
  }
  return [...new Set(pool)];
}

const lockPath = (proxy) => {
  let h = 0;
  for (const c of proxy) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return LOCKDIR + h.toString(36) + '.lock';
};

/**
 * Claim a proxy for this bot's exclusive use (1:1). Returns the claimed url and
 * keeps a heartbeat so other bots see it's taken; null if all are claimed.
 */
export function claimProxy(pool) {
  if (!pool.length) return null;
  try { if (!existsSync(LOCKDIR)) mkdirSync(LOCKDIR, { recursive: true }); } catch { return null; }
  const order = pool.slice().sort(() => Math.random() - 0.5);   // shuffle so bots don't all grab #1
  for (const px of order) {
    const lp = lockPath(px);
    try {
      try {
        writeFileSync(lp, String(process.pid), { flag: 'wx' });   // atomic create
      } catch {
        if (Date.now() - statSync(lp).mtimeMs <= LOCK_TTL) continue;   // alive — taken
        unlinkSync(lp); writeFileSync(lp, String(process.pid), { flag: 'wx' });  // reclaim stale
      }
      const hb = setInterval(() => { try { utimesSync(lp, new Date(), new Date()); } catch { /* gone */ } }, 30_000);
      const release = () => { try { clearInterval(hb); unlinkSync(lp); } catch { /* gone */ } };
      process.on('exit', release);
      process.on('SIGINT', () => { release(); process.exit(0); });
      process.on('SIGTERM', () => { release(); process.exit(0); });
      return px;
    } catch { /* race — try next */ }
  }
  return null;
}

/** Build an http(s)/socks agent for the websocket transport, or null. */
export async function makeAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (/^socks/i.test(proxyUrl)) {
    const { SocksProxyAgent } = await import('socks-proxy-agent');
    return new SocksProxyAgent(proxyUrl);
  }
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  return new HttpsProxyAgent(proxyUrl);
}

/** Hide credentials when logging a proxy URL. */
export const maskProxy = (u) => String(u || '').replace(/\/\/[^/@]*@/, '//***@');
