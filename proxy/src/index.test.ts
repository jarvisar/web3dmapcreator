// The proxy against a stubbed upstream: who it answers, what it fetches, and
// what it passes back.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowedOrigin, handle, targetOf } from './index';

const env = { ORIGINS: 'https://citymodel.jarvisar.com' };
const site = 'https://citymodel.jarvisar.com';
const worker = 'https://proxy.example.workers.dev';
const file = 'rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/OH_Statewide_Phase3_2021_B21/OH_StatewideP3_6_B21/LAZ/tile.laz';

function request(path: string, init: { method?: string; origin?: string | null; headers?: Record<string, string> } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.origin !== null) headers.set('Origin', init.origin ?? site);
  return new Request(`${worker}/${path}`, { method: init.method ?? 'GET', headers });
}

afterEach(() => vi.unstubAllGlobals());

describe('LiDAR CORS proxy', () => {
  it('answers the site and localhost, nobody else', () => {
    expect(allowedOrigin(site, env)).toBe(true);
    expect(allowedOrigin('http://localhost:5173', env)).toBe(true);
    expect(allowedOrigin('http://127.0.0.1:4173', env)).toBe(true);
    expect(allowedOrigin('https://example.com', env)).toBe(false);
    expect(allowedOrigin('http://localhost.example.com', env)).toBe(false);
    expect(allowedOrigin(null, env)).toBe(false);
  });

  it('only reads listed files', () => {
    expect(targetOf(`${worker}/${file}`)).toBe(`https://${file}`);
    expect(targetOf(`${worker}/rockyweb.usgs.gov/elsewhere/tile.laz`)).toBeNull();
    expect(targetOf(`${worker}/rockyweb.usgs.gov.example.com/vdelivery/Datasets/Staged/Elevation/LPC/Projects/a.laz`)).toBeNull();
    expect(targetOf(`${worker}/example.com/${file}`)).toBeNull();
    // Share links are matched by pattern, so other files on the same host stay out.
    expect(targetOf(`${worker}/imnube.montevideo.gub.uy/share/s/6Q_g8cksRMCTdg8l3IyNSA/content/LIDAR_MVD_2024_K-29-D-6-O-5.laz`)).toBe('https://imnube.montevideo.gub.uy/share/s/6Q_g8cksRMCTdg8l3IyNSA/content/LIDAR_MVD_2024_K-29-D-6-O-5.laz');
    expect(targetOf(`${worker}/imnube.montevideo.gub.uy/share/s/6Q_g8cksRMCTdg8l3IyNSA/content/minutes.pdf`)).toBeNull();
    // Query strings are part of the match.
    const estonia = 'geoportaal.maaruum.ee/index.php?lang_id=1&plugin_act=otsing';
    expect(targetOf(`${worker}/${estonia}&kaardiruut=474659&andmetyyp=lidar_laz_madal&dl=1&f=474659_2024_madal.laz&page_id=614`)).not.toBeNull();
    expect(targetOf(`${worker}/${estonia}&page_id=614&kaardiruut=474659&andmetyyp=lidar_laz_madal`)).not.toBeNull();
    expect(targetOf(`${worker}/geoportaal.maaruum.ee/index.php?lang_id=1&plugin_act=admin`)).toBeNull();
    // PHP takes the last of a repeated parameter.
    expect(targetOf(`${worker}/${estonia}&page_id=614&kaardiruut=474659&andmetyyp=lidar_laz_madal&plugin_act=admin`)).toBeNull();
    expect(targetOf(`${worker}/${estonia}&kaardiruut=474659&andmetyyp=lidar_laz_madal&dl=1&f=474659_2024_madal.laz&page_id=614&f=x`)).toBeNull();
    // Dot segments are resolved before the check.
    expect(targetOf(`${worker}/rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/../../../../../secret`)).toBeNull();
  });

  it('refuses encoded slashes and dots, which a server could resolve outside the prefix', () => {
    const projects = 'rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects';
    for (const path of ['..%2F..%2Fsecret', '..%2f..%2fsecret', '..%5C..%5Csecret', '%2E%2E%2Fsecret', 'P/%2e%2e%2fsecret', 'P/a%2Eb.laz']) {
      expect(targetOf(`${worker}/${projects}/${path}`), path).toBeNull();
    }
    // Encoded characters in the query are fine, as in an S3 listing's prefix.
    expect(targetOf(`${worker}/nrs.objectstore.gov.bc.ca/gdwuts/?list-type=2&prefix=watershed%2F092%2F&max-keys=1000`)).not.toBeNull();
    expect(targetOf(`${worker}/${projects}/P/WU/LAZ/tile%20one.laz`)).not.toBeNull();
  });

  it('streams a range read with its headers exposed to the site', async () => {
    const upstream = vi.fn(async () => new Response(new Uint8Array(100), { status: 206, headers: { 'Content-Range': 'bytes 0-99/22312578', 'Content-Length': '100', 'Set-Cookie': 'x=1' } }));
    vi.stubGlobal('fetch', upstream);
    const response = await handle(request(file, { headers: { Range: 'bytes=0-99', Cookie: 'y=2' } }), env);
    expect(response.status).toBe(206);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(site);
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('Content-Range');
    expect(response.headers.get('Content-Range')).toBe('bytes 0-99/22312578');
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect((await response.arrayBuffer()).byteLength).toBe(100);
    const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://${file}`);
    const sent = new Headers(init.headers);
    expect(sent.get('Range')).toBe('bytes=0-99');
    expect(sent.get('Cookie')).toBeNull();
    // TxGIO's CloudFront only lets through agents that start with Mozilla/5.0.
    expect(sent.get('User-Agent')).toMatch(/^Mozilla\/5\.0 \(compatible; citymodel-lidar-proxy; /);
    expect(sent.get('Accept-Encoding')).toBe('identity');
  });

  it('gives a HEAD its size', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200, headers: { 'Content-Length': '22312578' } })));
    const response = await handle(request(file, { method: 'HEAD' }), env);
    expect(response.headers.get('Content-Length')).toBe('22312578');
  });

  it('answers a preflight without fetching anything', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const response = await handle(request(file, { method: 'OPTIONS' }), env);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Range');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses other origins, other methods and other files', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    expect((await handle(request(file, { origin: 'https://example.com' }), env)).status).toBe(403);
    expect((await handle(request(file, { origin: null }), env)).status).toBe(403);
    expect((await handle(request(file, { method: 'POST' }), env)).status).toBe(405);
    expect((await handle(request('example.com/a.laz'), env)).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('follows redirects only to listed files', async () => {
    const moved = `https://${file.replace('tile.laz', 'moved.laz')}`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.endsWith('tile.laz') ? new Response(null, { status: 302, headers: { Location: moved } }) : new Response('ok', { status: 200 }))),
    );
    expect((await handle(request(file), env)).status).toBe(200);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://example.com/elsewhere' } })));
    expect((await handle(request(file), env)).status).toBe(502);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'http://[bad' } })));
    expect((await handle(request(file), env)).status).toBe(502);
  });

  it("answers with CORS headers when the host doesn't answer, so the site can tell", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Network connection lost.');
      }),
    );
    const response = await handle(request(file, { headers: { Range: 'bytes=0-99' } }), env);
    expect(response.status).toBe(502);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(site);
    expect(await response.text()).toBe("rockyweb.usgs.gov didn't answer.");
  });
});
