// Keep one bot per lobby. Bots share the data volume, so the first into a room
// claims a lock; a second bot that lands in the same room sees it taken and bails
// to a fresh game. Stale locks (a crashed bot) free after a minute.

import { existsSync, mkdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';

const DIR = new URL('../data/.rooms/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const TTL = 60_000;
let current = null;   // { path, hb }

const pathFor = (roomId) => DIR + String(roomId).replace(/[^A-Za-z0-9_-]/g, '') + '.lock';

/** Try to claim a room. true = it's ours (stay); false = another bot has it (leave). */
export function claimRoom(roomId) {
  releaseRoom();
  if (!roomId) return true;
  try { if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true }); } catch { return true; }
  const p = pathFor(roomId);
  try {
    try {
      writeFileSync(p, String(process.pid), { flag: 'wx' });            // atomic create
    } catch {
      if (Date.now() - statSync(p).mtimeMs <= TTL) return false;        // alive — taken by another bot
      unlinkSync(p); writeFileSync(p, String(process.pid), { flag: 'wx' });  // reclaim a stale lock
    }
    const hb = setInterval(() => { try { utimesSync(p, new Date(), new Date()); } catch { /* gone */ } }, 20_000);
    current = { path: p, hb };
    return true;
  } catch {
    return true;   // on any error, don't falsely force a leave
  }
}

export function releaseRoom() {
  if (!current) return;
  try { clearInterval(current.hb); unlinkSync(current.path); } catch { /* gone */ }
  current = null;
}

process.on('exit', releaseRoom);
process.on('SIGINT', () => { releaseRoom(); process.exit(0); });
process.on('SIGTERM', () => { releaseRoom(); process.exit(0); });
