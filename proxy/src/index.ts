// A CORS proxy for the City Model site's LiDAR downloads, as a Cloudflare
// Worker. It only fetches the files listed in src/core/data/corsProxy.ts and
// only answers the site's own origins (ORIGINS, plus localhost for
// development), so it can't be used as an open proxy.
//
// Requests name the file without its scheme: /rockyweb.usgs.gov/vdelivery/...
// for https://rockyweb.usgs.gov/vdelivery/... Range and conditional headers
// are passed through and the body is streamed, never buffered, so a 300 MB
// tile costs the Worker almost no CPU or memory.

import { PROXY_AGENT, proxyRule } from '../../src/core/data/corsProxy';

export interface Env {
  /** Origins allowed to use the proxy, comma separated. */
  ORIGINS?: string;
}

const FORWARDED = ['range', 'if-range', 'if-none-match', 'if-modified-since'];
const RETURNED = ['content-type', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
const EXPOSED = 'Content-Range, Content-Length, Accept-Ranges, ETag, Last-Modified';
const MAX_REDIRECTS = 3;

export function allowedOrigin(origin: string | null, env: Env): origin is string {
  if (!origin) return false;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return (env.ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .includes(origin);
}

/** A listed file's URL, normalised, or null for anything else. */
export function allowedTarget(url: string): string | null {
  let href: string;
  try {
    href = new URL(url).href;
  } catch {
    return null;
  }
  return proxyRule(href) ? href : null;
}

/** The file a request asks for: its path and query after the Worker's own host. */
export function targetOf(requestUrl: string): string | null {
  const { pathname, search } = new URL(requestUrl);
  return allowedTarget(`https://${pathname.slice(1)}${search}`);
}

function text(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin');
  if (!allowedOrigin(origin, env)) return text(403, 'This proxy only serves the City Model site.');
  const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': 'Range, If-Range, If-None-Match, If-Modified-Since', 'Access-Control-Max-Age': '86400' },
    });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'Only GET and HEAD.', cors);
  let target = targetOf(request.url);
  if (!target) return text(403, "That isn't a file this proxy reads.", cors);

  // Bavaria's server gzips LAZ for anyone who accepts gzip, and then ignores
  // Range and sends no length. Byte ranges have to be of the file itself.
  const headers = new Headers({ 'User-Agent': PROXY_AGENT, 'Accept-Encoding': 'identity' });
  for (const name of FORWARDED) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  let upstream: Response;
  for (let hop = 0; ; hop++) {
    try {
      upstream = await fetch(target, { method: request.method, headers, redirect: 'manual' });
    } catch {
      // Refused or dropped. Thrown, Cloudflare answers with its own page and no
      // CORS headers, which the site can't tell from being over the daily limit.
      return text(502, `${new URL(target).host} didn't answer.`, cors);
    }
    const location = upstream.headers.get('location');
    if (upstream.status < 300 || upstream.status >= 400 || !location) break;
    // Redirects are only followed to other listed files.
    const next: string | null = URL.canParse(location, target) ? allowedTarget(new URL(location, target).href) : null;
    upstream.body?.cancel().catch(() => undefined);
    if (!next || hop >= MAX_REDIRECTS) return text(502, 'The file redirected somewhere this proxy does not read.', cors);
    target = next;
  }

  const out = new Headers({ ...cors, 'Access-Control-Expose-Headers': EXPOSED });
  for (const name of RETURNED) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  // The length only holds for an unencoded body. A HEAD needs it for the file's size.
  const length = upstream.headers.get('content-length');
  if (length && !upstream.headers.get('content-encoding')) out.set('Content-Length', length);
  return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

export default { fetch: handle };
