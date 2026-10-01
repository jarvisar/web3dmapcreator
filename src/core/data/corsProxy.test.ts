// Requests for files without CORS go to the proxy, keyed in the cache by the
// file's own URL.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestUrl, setCorsProxy } from './corsProxy';
import { fetchBytes } from './http';

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
});
