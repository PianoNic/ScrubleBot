// Optional outbound proxy — route matchmaking + the game websocket through a
// proxy so a fleet doesn't all share one IP.
//   BOT_PROXY=<url>             one proxy for this bot
//   BOT_PROXIES=<url,url,...>   each bot picks one by its shard id (spreads the fleet)
// URL forms: http://[user:pass@]host:port  or  socks5://[user:pass@]host:port

export function pickProxy() {
  const single = (process.env.BOT_PROXY || '').trim();
  if (single) return single;
  const list = (process.env.BOT_PROXIES || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return '';
  return list[Math.floor(Math.random() * list.length)];   // random each call → a dead free proxy just gets retried with another
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
