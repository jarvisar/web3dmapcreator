import { afterEach, describe, expect, it, vi } from 'vitest';
import { ahead, Fetcher, setLidarStore } from './fetcher';

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
});
