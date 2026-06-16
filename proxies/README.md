# proxies/

Drop your proxy files here — **any number of files**, one proxy per line. The bot
reads every file in this folder automatically (no env needed) and **each bot
claims its own** proxy so they don't share one.

Supported line formats (mix freely):

```
ip:port:user:pass            # Webshare-style (default scheme: http)
ip:port                      # no auth
http://user:pass@ip:port     # full url
socks5://user:pass@ip:port   # socks
```

For bare `ip:port[:user:pass]` lines the scheme is `http` by default; set
`BOT_PROXY_SCHEME=socks5` to change it.

Example: paste your Webshare list straight into `proxies/webshare.txt`:

```
38.154.203.95:5863:xmfvjlar:95ko7d7qpf09
198.105.121.200:6462:xmfvjlar:95ko7d7qpf09
```

> ⚠️ These files contain credentials — they're gitignored, never commit them.

Then just run the fleet (the folder is mounted into the containers):

```sh
docker compose -f docker-compose.harvest.yml up -d --build --scale harvester=10
```
