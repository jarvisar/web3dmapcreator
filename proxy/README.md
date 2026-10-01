# LiDAR CORS Proxy

A small Cloudflare Worker that lets the site read LiDAR files from servers that don't send CORS headers. Right now that's USGS's own LAZ on `rockyweb.usgs.gov`, for the 3DEP surveys Hobu's EPT mirror hasn't built yet (Cincinnati's 2021-22 survey, Houston, Portland, Pittsburgh, Baltimore, Salt Lake City, San Diego, Philadelphia and Miami, among about 180).

It only fetches files under the prefixes in `src/core/data/corsProxy.ts` and only answers the site's own origins, so it isn't an open proxy. The body is streamed straight through, never buffered, so file size doesn't matter. Range and conditional headers are passed on.

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

Add the file prefix to `PROXIED` in `src/core/data/corsProxy.ts` and deploy the Worker again. Both the site and the Worker read that list. Keep the prefixes as narrow as the files you need. Check from a server that the host answers `Range` requests first, since a host that only serves whole files is slow through any proxy.

## Limits

- The free plan allows 100,000 requests a day, resetting at midnight UTC. A LiDAR model is roughly 100 to 500 of them. Past the limit Cloudflare answers with error 1027 and no CORS headers, which the site can only see as a network error, so its message says the proxy may be over its daily limit. Nothing is billed.
- Cloudflare doesn't limit response body size, and time spent waiting on the upstream doesn't count toward the 10 ms CPU limit. Memory is 128 MB per isolate, which is why nothing is buffered.
- Cloudflare's terms say large files should go through the Developer Platform, which Workers are part of, but they call it a paid service. It's not clear whether the free plan counts. If Cloudflare objects, the $5 a month Workers plan settles it.
- rockyweb gives each connection about 48 KB/s. The site reads six runs of a file at once, so a 22 MB tile takes a minute or two.
