// Requests for files without CORS go to the proxy, keyed in the cache by the
// file's own URL.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { needsProxy, requestUrl, setCorsProxy } from './corsProxy';
import { fetchByteLength, fetchBytes } from './http';

const file = 'https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/P/WU/LAZ/tile.laz';

afterEach(() => {
  setCorsProxy(null);
  vi.unstubAllGlobals();
});

describe('CORS proxy', () => {
  it('only sends listed files to the proxy', () => {
    setCorsProxy('https://proxy.example.workers.dev/');
    expect(requestUrl(file)).toBe('https://proxy.example.workers.dev/rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/P/WU/LAZ/tile.laz');
    expect(requestUrl('https://example.com/tile.laz')).toBe('https://example.com/tile.laz');
    setCorsProxy('proxy.example.workers.dev');
    expect(requestUrl(file)).toBe('https://proxy.example.workers.dev/rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/P/WU/LAZ/tile.laz');
    setCorsProxy('direct');
    expect(requestUrl(file)).toBe(file);
    setCorsProxy(null);
    expect(requestUrl(file)).toBe(file);
  });

  it('matches share links by pattern, not by a prefix that would open every share', () => {
    setCorsProxy('https://proxy.example.workers.dev');
    const share = 'https://imnube.montevideo.gub.uy/share/s/6Q_g8cksRMCTdg8l3IyNSA/content/LIDAR_MVD_2024_K-29-D-6-O-5.laz';
    expect(requestUrl(share)).toBe(`https://proxy.example.workers.dev/${share.slice('https://'.length)}`);
    expect(needsProxy('https://imnube.montevideo.gub.uy/share/s/6Q_g8cksRMCTdg8l3IyNSA/content/budget.pdf')).toBe(false);
  });

  it('never proxies paths with encoded slashes or dots', () => {
    setCorsProxy('https://proxy.example.workers.dev');
    for (const path of ['..%2F..%2Fsecret', '..%5Csecret', '%2e%2e%2fsecret', 'tile%2Elaz']) {
      const url = `https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/${path}`;
      expect(needsProxy(url), path).toBe(false);
      expect(requestUrl(url)).toBe(url);
    }
    expect(needsProxy('https://nrs.objectstore.gov.bc.ca/gdwuts/?list-type=2&prefix=watershed%2F092%2F')).toBe(true);
  });

  it('only proxies the Estonian listings and files the provider asks for', () => {
    const base = 'https://geoportaal.maaruum.ee/index.php?lang_id=1&plugin_act=otsing&';
    expect(needsProxy(`${base}page_id=614&kaardiruut=474659&andmetyyp=lidar_laz_madal`)).toBe(true);
    expect(needsProxy(`${base}kaardiruut=474659&andmetyyp=lidar_laz_tava&dl=1&f=474659_2025_tava.laz&page_id=614`)).toBe(true);
    expect(needsProxy(`${base}page_id=614&kaardiruut=474659&andmetyyp=lidar_laz_madal&plugin_act=admin`)).toBe(false);
    expect(needsProxy(`${base}page_id=1`)).toBe(false);
  });

  it('asks hosts that refuse HEAD for two bytes to learn a size', async () => {
    setCorsProxy('https://proxy.example.workers.dev');
    const file = 'https://geocloud.landesvermessung.sachsen.de/public.php/dav/files/EpkzyJHScGb5ndd/lsc_33410_5656_2_sn_laz.zip';
    const sent: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent.push(init);
      return new Response(new Uint8Array(2), { status: 206, headers: { 'Content-Range': 'bytes 0-1/363974735' } });
    });
    expect(await fetchByteLength(file)).toBe(363974735);
    expect(sent[0].method ?? 'GET').toBe('GET');
    expect(new Headers(sent[0].headers).get('Range')).toBe('bytes=0-1');
  });

  it("waits longer for the first byte from a host that's slow to start", async () => {
    vi.useFakeTimers();
    try {
      // Answers after a minute, then at once.
      vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response(new Uint8Array(4))), 60_000);
          init.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      });
      const slow = fetchBytes('https://opendata.geoportal.gov.pl/NumDaneWys/DanePomiaroweLAZ/81707/sheet.laz', undefined, { store: null, retries: 0 });
      const other = fetchBytes('https://example.com/sheet.laz', undefined, { store: null, retries: 0 }).catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(61_000);
      expect((await slow).byteLength).toBe(4);
      expect(String(await other)).toMatch(/No data received for 30 s/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fetches through the proxy but caches under the file itself', async () => {
    setCorsProxy('https://proxy.example.workers.dev');
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      return new Response(new Uint8Array([1, 2, 3]));
    });
    const keys: string[] = [];
    const store = { get: async () => undefined, put: async (key: string) => void keys.push(key) };
    await fetchBytes(file, undefined, { store });
    expect(fetched).toEqual([requestUrl(file)]);
    expect(keys).toEqual([file]);
  });

  it('says the proxy may be the problem when it fails', async () => {
    setCorsProxy('https://proxy.example.workers.dev');
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(fetchBytes(file, undefined, { store: null, retries: 0 })).rejects.toThrow(/LiDAR proxy, which may be over its daily limit/);
  });

  it("says the host didn't answer when the proxy couldn't reach it, not the daily limit", async () => {
    setCorsProxy('https://proxy.example.workers.dev');
    vi.stubGlobal('fetch', async () => new Response("rockyweb.usgs.gov didn't answer.", { status: 502 }));
    const error = await fetchBytes(file, undefined, { store: null, retries: 0 }).catch((e: Error) => e);
    expect(String(error)).toMatch(/rockyweb\.usgs\.gov didn't answer the LiDAR proxy \(HTTP 502\)/);
    expect(String(error)).not.toMatch(/daily limit/);
    // A 502 from a host read directly keeps the usual wording.
    const direct = await fetchBytes('https://example.com/tile.laz', undefined, { store: null, retries: 0 }).catch((e: Error) => e);
    expect(String(direct)).toMatch(/Download failed with HTTP 502/);
  });
});
