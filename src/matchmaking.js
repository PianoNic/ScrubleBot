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
export async function requestServer({ name, lang = 0, create = 0, join = '', avatar = [27, 30, 2, -1] }) {
  // /api/play occasionally returns an empty body (rate-limit); retry a few times.
  let raw = '';
  for (let attempt = 0; attempt < 4 && !raw; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 600));
    const res = await fetch(PLAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, lang, create, join, avatar }),
    });
    if (!res.ok) throw new Error(`/api/play returned ${res.status}`);
    raw = (await res.text()).trim(); // e.g. "https://server3.skribbl.io:5005"
  }

  const m = raw.match(/^(https?):\/\/([^:/]+)(?::(\d+))?/i);
  if (!m) throw new Error(`Unexpected /api/play response: ${JSON.stringify(raw)}`);
  const [, scheme, host, port] = m;
  const origin = `${scheme}://${host}`;
  const path = port ? `/${port}/` : '/socket.io/';
  return { origin, path, raw };
}
