// Matchmaking: ask skribbl which game server to connect to.
// POST https://skribbl.io/api/play {name,lang,create,join,avatar}
//   -> plain text "https://serverN.skribbl.io:PORT"
// The :PORT is used as the Socket.IO *path* ("/PORT/") on the host over wss,
// NOT as a real TCP port.

const PLAY_URL = 'https://skribbl.io/api/play';

/**
 * @param {object} opts
 * @param {string} opts.name
 * @param {number} opts.lang   language index (0 = English)
 * @param {number} opts.create 0 = join public matchmaking, 1 = create private room
 * @param {string} opts.join   room code to join, or "" for matchmaking
 * @param {number[]} opts.avatar [head, eyes, mouth, -1]
 * @returns {Promise<{origin: string, path: string, raw: string}>}
 */
export async function requestServer({ name, lang = 0, create = 0, join = '', avatar = [27, 30, 2, -1], proxy = '' }) {
  // /api/play rate-limits hard (503s + occasional empty bodies). Retry transient
  // failures (503/429/5xx/network/empty) with exponential backoff + jitter.
  let raw = '', lastErr = '';
  for (let attempt = 0; attempt < 7 && !raw; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 500)));
    let res;
    try {
      res = await fetch(PLAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, lang, create, join, avatar }),
        ...(proxy ? { proxy } : {}),   // Bun fetch routes through the proxy
      });
    } catch (e) { lastErr = e.message; continue; }              // network error → retry
    if (res.status === 429 || res.status >= 500) { lastErr = `${res.status}`; continue; } // transient → retry
    if (!res.ok) throw new Error(`/api/play returned ${res.status}`);  // hard error (4xx)
    raw = (await res.text()).trim(); // e.g. "https://server3.skribbl.io:5005"
  }
  if (!raw) throw new Error(`/api/play failed after retries (${lastErr || 'empty'})`);

  const m = raw.match(/^(https?):\/\/([^:/]+)(?::(\d+))?/i);
  if (!m) throw new Error(`Unexpected /api/play response: ${JSON.stringify(raw)}`);
  const [, scheme, host, port] = m;
  const origin = `${scheme}://${host}`;
  const path = port ? `/${port}/` : '/socket.io/';
  return { origin, path, raw };
}
