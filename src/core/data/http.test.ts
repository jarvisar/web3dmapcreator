import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ByteCache } from './cache';
import { configureHttp, fetchByteLength, fetchBytes, fetchTail, HttpError, NetworkError, parseRetryAfter, remoteFile, setByteCache } from './http';
import { mockServer } from './testdata/serve';

const URL_A = 'https://example.com/a.bin';
const data = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);

function mapCache(): ByteCache & { store: Map<string, ArrayBuffer> } {
  const store = new Map<string, ArrayBuffer>();
  return {
    store,
    get: async (key) => store.get(key),
    put: async (key, value) => void store.set(key, value),
  };
}

// A response whose body sends `first` bytes and then fails, like a dropped connection.
function brokenResponse(body: Uint8Array, first: number): Response {
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(body.slice(0, first));
      } else {
        controller.error(new TypeError('connection reset'));
      }
    },
  });
  return new Response(stream, { status: 206 });
}

beforeEach(() => {
  configureHttp({ maxInFlight: 6, retries: 3, retryDelayMs: 1, idleTimeoutMs: 30000 });
  setByteCache(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('remoteFile', () => {
  it('reads byte ranges with an inclusive Range header', async () => {
    const server = mockServer({ [URL_A]: data });
    vi.stubGlobal('fetch', server.fetch);
    const file = remoteFile(URL_A, data.length);
    expect(new Uint8Array(await file.slice(10, 20))).toEqual(data.slice(10, 20));
    expect(new Uint8Array(await file.slice(990))).toEqual(data.slice(990));
    expect((await file.slice(5, 5)).byteLength).toBe(0);
    expect(server.requests.map((r) => r.range)).toEqual([[10, 20], [990, 1000]]);
    await expect(file.slice(900, 1001)).rejects.toThrow(RangeError);
  });

  it('retries 5xx and 429 but not other 4xx', async () => {
    const server = mockServer({ [URL_A]: data });
    vi.stubGlobal('fetch', server.fetch);
    server.failNext(() => true, 503);
    server.failNext(() => true, 429);
    const file = remoteFile(URL_A, data.length);
    expect((await file.slice(0, 100)).byteLength).toBe(100);
    expect(server.requests).toHaveLength(3);

    server.failNext(() => true, 404);
    const error = await file.slice(0, 100).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(404);
    expect(server.requests).toHaveLength(4);
  });

  it('waits as long as Retry-After asks, up to a limit', async () => {
    let calls = 0;
    const answers = [
      new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }),
      new Response(data.slice(0, 10), { status: 206 }),
    ];
    vi.stubGlobal('fetch', async () => answers[calls++]);
    expect((await remoteFile(URL_A, data.length).slice(0, 10)).byteLength).toBe(10);
    expect(calls).toBe(2);

    // Two minutes is too long to wait: the request fails at once, retries left or not.
    const fetchMock = vi.fn(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }));
    vi.stubGlobal('fetch', fetchMock);
    const error = await remoteFile(URL_A, data.length).slice(0, 10).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'HttpError', status: 429, retryAfterMs: 120000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads Retry-After as seconds or a date', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    expect(parseRetryAfter('5', now)).toBe(5000);
    expect(parseRetryAfter('Mon, 28 Sep 2026 12:00:03 GMT', now)).toBe(3000);
    expect(parseRetryAfter('Mon, 28 Sep 2026 11:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it('can be told not to retry', async () => {
    const fetchMock = vi.fn(async () => new Response('down', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchBytes(URL_A, undefined, { retries: 0, cache: false })).rejects.toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after three retries', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);
    const error = await remoteFile(URL_A, data.length).slice(0, 10).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(String(error)).toContain(URL_A);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('refuses a whole file sent for a partial range', async () => {
    const fetchMock = vi.fn(async () => new Response(data.slice(), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(remoteFile(URL_A, data.length).slice(0, 10)).rejects.toThrow(/ignored the byte range/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A range covering the whole file may come back as a plain 200.
    expect((await remoteFile(URL_A, data.length).slice(0, data.length)).byteLength).toBe(data.length);
  });

  it('reads the rest of a file from an offset, and caches it', async () => {
    const server = mockServer({ [URL_A]: data });
    vi.stubGlobal('fetch', server.fetch);
    setByteCache(mapCache());
    expect(new Uint8Array(await fetchTail(URL_A, 990))).toEqual(data.slice(990));
    expect(new Uint8Array(await fetchTail(URL_A, 990))).toEqual(data.slice(990));
    expect(server.requests).toHaveLength(1);
    vi.stubGlobal('fetch', async () => new Response(data.slice(), { status: 200 }));
    await expect(fetchTail(URL_A, 10, undefined, { cache: false })).rejects.toThrow(/ignored the byte range/);
    expect((await fetchTail(URL_A, 0, undefined, { cache: false })).byteLength).toBe(data.length);
  });

  it('refuses a mismatched Content-Range', async () => {
    vi.stubGlobal('fetch', async () => new Response(data.slice(0, 10), { status: 206, headers: { 'content-range': 'bytes 5-14/1000' } }));
    await expect(remoteFile(URL_A, data.length).slice(0, 10)).rejects.toThrow(/bytes 5-14/);
  });

  it('retries a short body and takes back the bytes of a failed attempt', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => (++calls === 1 ? brokenResponse(data.slice(0, 100), 40) : new Response(data.slice(0, 100), { status: 206 })));
    const reports: number[] = [];
    const file = remoteFile(URL_A, data.length, { onBytes: (bytes) => reports.push(bytes) });
    expect(new Uint8Array(await file.slice(0, 100))).toEqual(data.slice(0, 100));
    expect(calls).toBe(2);
    expect(reports).toContain(-40);
    expect(reports.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('drops a stalled transfer and retries it', async () => {
    configureHttp({ idleTimeoutMs: 40, retries: 1 });
    let calls = 0;
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      calls++;
      // Never sends a byte, but gives up when aborted like a real fetch.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
        },
      });
      return new Response(stream, { status: 206 });
    });
    await expect(remoteFile(URL_A, data.length).slice(0, 10)).rejects.toThrow(/No data received/);
    expect(calls).toBe(2);
  });

  it('stops a request cancelled while it waited for a slot', async () => {
    // Like a real fetch: an aborted signal fails at once.
    const seen: boolean[] = [];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      seen.push(init?.signal?.aborted ?? false);
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const [start, end] = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('range') ?? '')!.slice(1).map(Number);
      return new Response(data.slice(start, end + 1), { status: 206 });
    });
    for (const start of [(signal: AbortSignal) => remoteFile(URL_A, data.length, { signal }).slice(0, 10), (signal: AbortSignal) => fetchByteLength(URL_A, signal)]) {
      const controller = new AbortController();
      const pending = start(controller.signal);
      controller.abort();
      await expect(pending).rejects.toThrow();
    }
    expect(seen.every((aborted) => aborted)).toBe(true);
  });

  it('retries a HEAD that never answers, then gives up', async () => {
    configureHttp({ idleTimeoutMs: 40, retries: 1 });
    let calls = 0;
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      calls++;
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    });
    await expect(fetchByteLength(URL_A)).rejects.toThrow(/No answer for/);
    expect(calls).toBe(2);
  });

  it('keeps no more than maxInFlight requests open', async () => {
    let open = 0;
    let most = 0;
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      open++;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open--;
      const [start, end] = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('range') ?? '')!.slice(1).map(Number);
      return new Response(data.slice(start, end + 1), { status: 206 });
    });
    const file = remoteFile(URL_A, data.length);
    await Promise.all(Array.from({ length: 30 }, (_, i) => file.slice(i * 10, i * 10 + 10)));
    expect(most).toBe(6);

    configureHttp({ maxInFlight: 2 });
    most = 0;
    await Promise.all(Array.from({ length: 10 }, (_, i) => file.slice(i, i + 5)));
    expect(most).toBe(2);
  });

  it('keeps the limit per host, so a busy host does not hold up another', async () => {
    configureHttp({ maxInFlight: 2 });
    const URL_B = 'https://other.example.org/b.bin';
    let hold = true;
    const held: (() => void)[] = [];
    const started: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      started.push(url);
      const [start, end] = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('range') ?? '')!.slice(1).map(Number);
      if (url === URL_A && hold) await new Promise<void>((resolve) => held.push(resolve));
      return new Response(data.slice(start, end + 1), { status: 206 });
    });
    const slow = Array.from({ length: 5 }, (_, i) => remoteFile(URL_A, data.length).slice(i * 10, i * 10 + 10));
    expect((await remoteFile(URL_B, data.length).slice(0, 10)).byteLength).toBe(10);
    expect(started.filter((url) => url === URL_A)).toHaveLength(2);
    hold = false;
    for (const resolve of held) resolve();
    await Promise.all(slow);
    expect(started.filter((url) => url === URL_A)).toHaveLength(5);
  });

  it('stops queued and running requests on abort', async () => {
    configureHttp({ maxInFlight: 1 });
    const started: string[] = [];
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      started.push(new Headers(init?.headers).get('range') ?? '');
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    });
    const controller = new AbortController();
    const file = remoteFile(URL_A, data.length, { signal: controller.signal });
    const reads = [file.slice(0, 10), file.slice(10, 20), file.slice(20, 30)];
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    for (const read of reads) await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    expect(started).toHaveLength(1);

    // The slot is free again.
    configureHttp({ maxInFlight: 6 });
    vi.stubGlobal('fetch', mockServer({ [URL_A]: data }).fetch);
    expect((await remoteFile(URL_A, data.length).slice(0, 4)).byteLength).toBe(4);
  });

  it('stops waiting between retries on abort', async () => {
    configureHttp({ retryDelayMs: 60000 });
    const server = mockServer({});
    vi.stubGlobal('fetch', server.fetch);
    server.failNext(() => true, 500);
    const controller = new AbortController();
    const read = remoteFile(URL_A, data.length, { signal: controller.signal }).slice(0, 10);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    expect(server.requests).toHaveLength(1);
  });
});

describe('byte cache', () => {
  it('serves repeated ranges and files from the cache', async () => {
    const cache = mapCache();
    setByteCache(cache);
    const server = mockServer({ [URL_A]: data });
    vi.stubGlobal('fetch', server.fetch);
    const reports: [number, boolean][] = [];
    const file = remoteFile(URL_A, data.length, { onBytes: (bytes, cached) => reports.push([bytes, cached]) });
    await file.slice(0, 100);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(new Uint8Array(await file.slice(0, 100))).toEqual(data.slice(0, 100));
    expect(server.requests).toHaveLength(1);
    expect(reports.at(-1)).toEqual([100, true]);
    expect([...cache.store.keys()]).toEqual([`${URL_A}#0-100`]);

    await fetchBytes(URL_A);
    await fetchBytes(URL_A);
    expect(server.requests).toHaveLength(2);
    expect(cache.store.has(URL_A)).toBe(true);
  });

  it('can skip the cache or refresh an entry', async () => {
    const cache = mapCache();
    setByteCache(cache);
    cache.store.set(URL_A, new Uint8Array([1, 2, 3]).buffer);
    const server = mockServer({ [URL_A]: data });
    vi.stubGlobal('fetch', server.fetch);
    expect((await fetchBytes(URL_A)).byteLength).toBe(3);
    expect((await fetchBytes(URL_A, undefined, { cache: false })).byteLength).toBe(data.length);
    expect(cache.store.get(URL_A)?.byteLength).toBe(3);
    expect((await fetchBytes(URL_A, undefined, { refresh: true })).byteLength).toBe(data.length);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cache.store.get(URL_A)?.byteLength).toBe(data.length);
    expect(server.requests).toHaveLength(2);
  });

  it('ignores a failing cache', async () => {
    setByteCache({
      get: async () => {
        throw new Error('broken');
      },
      put: async () => {
        throw new Error('full');
      },
    });
    vi.stubGlobal('fetch', mockServer({ [URL_A]: data }).fetch);
    expect((await remoteFile(URL_A, data.length).slice(0, 10)).byteLength).toBe(10);
  });

  it('ignores a cached range of the wrong length', async () => {
    const cache = mapCache();
    cache.store.set(`${URL_A}#0-10`, new ArrayBuffer(4));
    setByteCache(cache);
    vi.stubGlobal('fetch', mockServer({ [URL_A]: data }).fetch);
    expect((await remoteFile(URL_A, data.length).slice(0, 10)).byteLength).toBe(10);
  });
});
