import { gzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ahead, CatalogError, Fetcher, setLidarStore } from './fetcher';

describe('ahead', () => {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  afterEach(() => {
    process.off('unhandledRejection', listener);
    unhandled.length = 0;
  });

  it('keeps order, and a later failure waits for its turn', async () => {
    process.on('unhandledRejection', listener);
    const task = (item: number) =>
      item === 1 ? Promise.reject(new Error('item 1 failed')) : new Promise<number>((resolve) => setTimeout(() => resolve(item), 50));
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const value of ahead([0, 1, 2], 3, task)) seen.push(value);
      })(),
    ).rejects.toThrow('item 1 failed');
    expect(seen).toEqual([0]);
    // Item 1 failed while item 0 was still being awaited.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(unhandled).toEqual([]);
  });
});

describe('catalog answers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setLidarStore(null);
  });

  it("aren't kept when they're a maintenance page, and a kept one is read again", async () => {
    const stored = new Map<string, ArrayBuffer>();
    setLidarStore({ get: async (key) => stored.get(key), put: async (key, value) => void stored.set(key, value) });
    let body = '<!doctype html><title>Down for maintenance</title>';
    vi.stubGlobal('fetch', async () => new Response(body, { status: 200 }));
    const url = 'https://catalog.test/index.json';
    await expect(new Fetcher().json(url)).rejects.toThrow(/other than JSON/);
    expect(stored.size).toBe(0);
    // One cached before this was checked stands in for nothing.
    const page = new TextEncoder().encode(body);
    const stamped = new Uint8Array(page.byteLength + 8);
    new DataView(stamped.buffer).setFloat64(0, Date.now(), true);
    stamped.set(page, 8);
    stored.set(`catalog:${url}`, stamped.buffer);
    body = '{"surveys":[]}';
    expect(await new Fetcher().json(url)).toEqual({ surveys: [] });
    // Plain text catalogs refuse a web page too.
    body = '<html><body>Service unavailable</body></html>';
    await expect(new Fetcher().text('https://catalog.test/listing')).rejects.toThrow(/web page/);
  });

  it('fall back to an older copy while the server is down, but not past a month', async () => {
    const stored = new Map<string, ArrayBuffer>();
    setLidarStore({ get: async (key) => stored.get(key), put: async (key, value) => void stored.set(key, value) });
    const url = 'https://catalog.test/tiles.json';
    const keep = (text: string, ageDays: number) => {
      const bytes = new TextEncoder().encode(text);
      const stamped = new Uint8Array(bytes.byteLength + 8);
      new DataView(stamped.buffer).setFloat64(0, Date.now() - ageDays * 86400e3, true);
      stamped.set(bytes, 8);
      stored.set(`catalog:${url}`, stamped.buffer);
    };
    keep('{"tiles":1}', 3);
    vi.stubGlobal('fetch', async () => new Response('busy', { status: 404 }));
    expect(await new Fetcher().json(url)).toEqual({ tiles: 1 });
    // A maintenance page with a 200 doesn't replace it either.
    vi.stubGlobal('fetch', async () => new Response('<html>Wartungsarbeiten</html>', { status: 200 }));
    expect(await new Fetcher().json(url)).toEqual({ tiles: 1 });
    keep('{"tiles":1}', 40);
    await expect(new Fetcher().json(url)).rejects.toThrow(/other than JSON/);
    // Once the server answers, the new copy is kept.
    vi.stubGlobal('fetch', async () => new Response('{"tiles":2}', { status: 200 }));
    expect(await new Fetcher().json(url)).toEqual({ tiles: 2 });
    expect(await new Fetcher().json(url)).toEqual({ tiles: 2 });
  });

  it("aren't kept when they're an ArcGIS error, which is asked again next time", async () => {
    const stored = new Map<string, ArrayBuffer>();
    setLidarStore({ get: async (key) => stored.get(key), put: async (key, value) => void stored.set(key, value) });
    const url = 'https://catalog.test/FeatureServer/0/query?f=geojson';
    let body = '{"error":{"code":500,"message":"Error performing query operation","details":[]}}';
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response(body, { status: 200 });
    });
    const failed = await new Fetcher().json(url).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(CatalogError);
    expect((failed as CatalogError).problem).toBe('answered with an error (Error performing query operation)');
    expect(stored.size).toBe(0);
    body = '{"type":"FeatureCollection","features":[]}';
    expect(await new Fetcher().json(url)).toEqual({ type: 'FeatureCollection', features: [] });
    expect(calls).toBe(2);
    // An error once a day has passed leaves the older copy standing.
    const kept = stored.get(`catalog:${url}`)!;
    new DataView(kept).setFloat64(0, Date.now() - 2 * 86400e3, true);
    body = '{"error":{"code":400,"message":"Unable to complete operation."}}';
    expect(await new Fetcher().json(url)).toEqual({ type: 'FeatureCollection', features: [] });
    // Only an error object at the top counts: answers with one further down, or a flag, are catalogs.
    for (const text of ['{"features":[{"properties":{"error":{"code":1}}}]}', '[{"error":{"code":1}}]', '{"error":false,"rows":[]}', '{"error":null}']) {
      body = text;
      expect(await new Fetcher().json(`https://catalog.test/${encodeURIComponent(text)}`)).toEqual(JSON.parse(text));
    }
  });
});

describe('whole files with a check', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setLidarStore(null);
  });
  const text = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes);

  it("aren't cached when the server answers with something other than the file", async () => {
    const stored = new Map<string, ArrayBuffer>();
    setLidarStore({ get: async (key) => stored.get(key), put: async (key, value) => void stored.set(key, value) });
    let body = new TextEncoder().encode('Tiedostoa ei voi ladata. File not found [error: nonexistent file]');
    vi.stubGlobal('fetch', async () => new Response(body, { status: 200 }));
    const url = 'https://tiles.test/Default.ashx?q=666498d&y=2021';
    expect(text(await new Fetcher().bytes(url, 'point-file'))).toMatch(/File not found/);
    expect(stored.size).toBe(0);
    // One cached before this was checked is read again.
    stored.set(url, body.slice().buffer);
    body = new TextEncoder().encode('LASF and the rest of a tile');
    expect(text(await new Fetcher().bytes(url, 'point-file'))).toMatch(/^LASF/);
    expect(text(stored.get(url)!)).toMatch(/^LASF/);
  });

  it("keep a scene layer's JSON errors out of the cache, gzipped or not", async () => {
    const stored = new Map<string, ArrayBuffer>();
    setLidarStore({ get: async (key) => stored.get(key), put: async (key, value) => void stored.set(key, value) });
    const error = new TextEncoder().encode('{"error":{"code":500,"message":"Unable to complete operation."}}');
    let body = error;
    vi.stubGlobal('fetch', async () => new Response(body.slice().buffer, { status: 200 }));
    const url = 'https://scene.test/layers/0/nodes/7/geometries/0';
    await new Fetcher().bytes(url, 'scene-resource');
    body = gzipSync(error);
    await new Fetcher().bytes(url, 'scene-resource');
    expect(stored.size).toBe(0);
    body = new TextEncoder().encode('LEPCC     blob');
    await new Fetcher().bytes(url, 'scene-resource');
    expect(stored.size).toBe(1);
  });
});
