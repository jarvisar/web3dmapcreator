# LiDAR CORS Proxy

A small Cloudflare Worker that lets the site read LiDAR files from servers that don't send CORS headers. That started with USGS's own LAZ on `rockyweb.usgs.gov`, for the 3DEP work units Hobu's EPT mirror hasn't built yet, and is now about 25 hosts: AHN in the Netherlands, Bavaria, Saxony, Thuringia, Saarland, Salzburg, Vorarlberg, Brussels, Poland, Estonia, Madrid, Navarra, Catalonia, Texas, Anchorage, British Columbia, Quebec, Winnipeg, Montevideo, and the faster state copies of some USGS work units. [LiDAR sources](../docs/LIDAR_SOURCES.md) has the list.

It only fetches URLs that match a rule in `src/core/data/corsProxy.ts` and only answers the site's own origins, so it isn't an open proxy. The body is streamed straight through, never buffered, so file size doesn't matter. Range and conditional headers are passed on, nothing else is: no cookies, no Origin, no Referer.

Without the proxy the site still works. Sources that need it are just left out.

## Setup

1. In the Cloudflare dashboard, go to `Workers & Pages`, `Create`, `Import a repository` and pick this repository.
2. Set the root directory to `proxy`. Leave the build command empty and set the deploy command to `npx wrangler deploy`.
3. Deploy. The Worker comes up at `https://citymodel-lidar-proxy.<your subdomain>.workers.dev`.
4. In the GitHub repository's `Settings > Secrets and variables > Actions > Variables`, add `LIDAR_PROXY_URL` with that address, then run the Pages deploy again.

The Worker reads `../src/core/data/corsProxy.ts`, so it needs the whole repository, which Cloudflare's builds clone anyway. Under `Settings > Build > Build watch paths` you can limit rebuilds to `proxy/*` and `src/core/data/corsProxy.ts`.

The sites allowed to use it are in `wrangler.jsonc` (`ORIGINS`, comma separated). `localhost` and `127.0.0.1` on any port always are, for development.

## Local Development

1. Run `npm install` here, then `npm run dev`. It serves the Worker at `http://127.0.0.1:8787` without a Cloudflare account.
2. Build or run the site with `VITE_LIDAR_PROXY=http://127.0.0.1:8787` set.

The tests run with the site's (`npm test` at the root).

## Adding a Host

Add a rule to `PROXIED` in `src/core/data/corsProxy.ts` and deploy the Worker again. Both the site and the Worker read that list.

- `prefix` for everything under a path. Keep it as narrow as the files you need. Shared object stores (`fsn1.your-objectstorage.com`) need the bucket in the prefix.
- `pattern` where a random share id comes before the file name, like Montevideo's Alfresco links, so the rule doesn't open every share on the server.
- `noHead` where the host refuses HEAD or answers it without a length (Nextcloud, FileBrowser, Alfresco, Bavaria). Sizes then come from a two byte range.

Only GET and HEAD go through, so a catalog that only answers POST has to send CORS headers itself. Plain GET catalogs, folder listings and WFS requests can go through the proxy like files.

Check from a server that the host answers `Range` requests first, with the Worker's User-Agent, since a host that only serves whole files is slow through any proxy. The Worker sends `Mozilla/5.0 (compatible; citymodel-lidar-proxy; +https://citymodel.jarvisar.com)`: TxGIO's CloudFront refuses agents that don't start with `Mozilla/5.0`. It also asks for `Accept-Encoding: identity`, since Bavaria's server gzips LAZ for anyone who accepts gzip and then ignores Range.

## Limits

- The free plan allows 100,000 requests a day, resetting at midnight UTC. A LiDAR model is roughly 100 to 500 of them. Deflated ZIP members are fetched in 16 MB pieces through the proxy to keep that down (a 650 MB Austin member is about 40 requests). Past the limit Cloudflare answers with error 1027 and no CORS headers, which the site can only see as a network error, so its message says the proxy may be over its daily limit. Nothing is billed.
- Cloudflare doesn't limit response body size, and time spent waiting on the upstream doesn't count toward the 10 ms CPU limit. Memory is 128 MB per isolate, which is why nothing is buffered.
- Cloudflare's terms say large files should go through the Developer Platform, which Workers are part of, but they call it a paid service. It's not clear whether the free plan counts. If Cloudflare objects, the $5 a month Workers plan settles it.
- Requests leave from Cloudflare's addresses near the visitor. Some hosts treat those differently from a home connection: ICGC's server didn't answer US addresses at all in October 2026, and several hosts sit behind a WAF (F5 at Madrid, Montevideo, Quebec and Vorarlberg, Link11 at Thuringia, Cloudflare at Estonia). Nextcloud shares (Saxony, Saarland) lock out an address after a run of failed requests, and every visitor shares the Worker's addresses, so providers never guess file names there.
- rockyweb gives each connection about 50-65 KB/s. Read directly (the CLI does), six at once come to about 370 KB/s. Through the Worker it was 65 to 350 KB/s and usually nearer 130, I think because Cloudflare reuses its connections to rockyweb and several requests end up sharing one. A Worker can't control that. So a 22 MB tile takes 1 to 6 minutes the first time, and comes from the browser's cache after that. Pennsylvania's and New York's 2024 work units are read from the states' copies instead, at 4-7 MB/s.
- Poland's server ignores Range and has taken up to two minutes to start answering, and Navarra's and Salzburg's give under 1.5 MB/s. The rest gave 2 to 20 MB/s per connection from a home connection in the US.
