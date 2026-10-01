// Files whose hosts send no CORS headers, so a browser can only read them
// through the site's proxy (`proxy/`, a Cloudflare Worker). The proxy reads
// this list too and refuses anything else, so it can't be used as an open
// proxy. Node has no CORS and fetches them directly.
//
// Only the request goes through the proxy. Cache keys stay the file's own
// URL, so moving the proxy doesn't throw away what was downloaded.

export const PROXIED: string[] = [
  // USGS 3DEP work units that Hobu's EPT mirror hasn't built yet.
  'https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/',
];

// The proxy's address, 'direct' (Node), or null when there's none: then these
// files can't be read and their sources are left out.
let proxy: string | null = null;

export function setCorsProxy(value: string | null | undefined): void {
  proxy = value ? value.replace(/\/+$/, '') : null;
}

export const needsProxy = (url: string): boolean => PROXIED.some((prefix) => url.startsWith(prefix));

export const proxyAvailable = (): boolean => proxy !== null;

/** Where to send a request for `url`: the proxy for listed files, else the file itself. */
export function requestUrl(url: string): string {
  if (!proxy || proxy === 'direct' || !needsProxy(url)) return url;
  return `${proxy}/${url.slice('https://'.length)}`;
}
