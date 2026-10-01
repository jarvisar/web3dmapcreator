// Downloads for LiDAR discovery and reading, through the shared HTTP layer
// (per-host limits, retries) and the LiDAR byte cache. Catalog answers are
// kept for a day; point data never changes under its URL and stays until the
// cache evicts it.

import { lidarCache, type ByteCache } from '../../data/cache';
import { fetchByteLength, fetchBytes, fetchPost, fetchRange, fetchTail } from '../../data/http';

const DAY_MS = 24 * 3600 * 1000;
// How old a catalog may be and still stand in for a server that is down.
const STALE_MS = 30 * DAY_MS;
// NRCan's tile index has taken up to two minutes to answer a small query.
const CATALOG_IDLE_MS = 150_000;

// Answers kept in memory for the batches asking next. Every batch reads
// the same coarse EPT ancestors, and the byte cache commits too late for a
// batch running alongside.
const RECENT_BYTES = 128e6;

let store: ByteCache | null = lidarCache;

/** Swap the LiDAR cache, e.g. for a folder in Node. null caches nothing. */
export function setLidarStore(value: ByteCache | null): void {
  store = value;
}

export type LidarRequest =
  | { kind: 'bytes'; url: string }
  | { kind: 'range'; url: string; start: number; end: number }
  | { kind: 'tail'; url: string; start: number }
  | { kind: 'text'; url: string; maxAgeMs: number; json?: boolean }
  | { kind: 'catalog'; url: string; maxAgeMs: number; magic: number[] }
  | { kind: 'post'; url: string; body: string; type: string; maxAgeMs: number }
  | { kind: 'size'; url: string }
  | { kind: 'note'; key: string; value?: string };

/** Where a LiDAR worker's Fetchers send their requests: to one Fetcher serving all workers. */
export type Transport = (request: LidarRequest) => Promise<ArrayBuffer | string>;

let transport: Transport | null = null;

export function setLidarTransport(value: Transport | null): void {
  transport = value;
}

export class Fetcher {
  /** Bytes that came over the network, not from the cache. */
  downloaded = 0;
  private readonly inflight = new Map<string, Promise<ArrayBuffer | string>>();
  private readonly recent = new Map<string, ArrayBuffer | string>();
  private recentBytes = 0;

  constructor(readonly signal?: AbortSignal) {}

  private onBytes = (bytes: number, fromCache: boolean) => {
    if (!fromCache) this.downloaded += bytes;
  };

  /** Immutable point data: a whole file. */
  bytes(url: string): Promise<ArrayBuffer> {
    if (transport) return transport({ kind: 'bytes', url }) as Promise<ArrayBuffer>;
    return fetchBytes(url, this.signal, { store, onBytes: this.onBytes });
  }

  range(url: string, start: number, end: number): Promise<ArrayBuffer> {
    if (transport) return transport({ kind: 'range', url, start, end }) as Promise<ArrayBuffer>;
    return fetchRange(url, start, end, this.signal, { store, onBytes: this.onBytes });
  }

  /** From `start` to the end of a file of unknown size. */
  tail(url: string, start: number): Promise<ArrayBuffer> {
    if (transport) return transport({ kind: 'tail', url, start }) as Promise<ArrayBuffer>;
    return fetchTail(url, start, this.signal, { store, onBytes: this.onBytes });
  }

  /**
   * A small note kept in the LiDAR cache, such as where a LAZ file's chunks
   * lie, or '' when there is none. With `value` it's saved instead.
   */
  async note(key: string, value?: string): Promise<string> {
    if (transport) return (await transport({ kind: 'note', key, value })) as string;
    if (!store) return '';
    if (value !== undefined) {
      await store.put(`note:${key}`, new TextEncoder().encode(value).buffer as ArrayBuffer).catch(() => undefined);
      return value;
    }
    const saved = await store.get(`note:${key}`).catch(() => undefined);
    return saved ? new TextDecoder().decode(saved) : '';
  }

  /**
   * A worker's request. Workers asking for the same thing at once share one
   * download, and recent answers are kept in memory for a while.
   */
  serve(request: LidarRequest): Promise<ArrayBuffer | string> {
    // Notes change once a file has been read through, so they're never kept here.
    if (request.kind === 'note') return this.note(request.key, request.value);
    const key = JSON.stringify(request);
    const kept = this.recent.get(key);
    if (kept !== undefined) {
      // Most recently used last.
      this.recent.delete(key);
      this.recent.set(key, kept);
      return Promise.resolve(kept);
    }
    let pending = this.inflight.get(key);
    if (!pending) {
      const load =
        request.kind === 'bytes'
          ? this.bytes(request.url)
          : request.kind === 'range'
            ? this.range(request.url, request.start, request.end)
            : request.kind === 'tail'
              ? this.tail(request.url, request.start)
              : request.kind === 'catalog'
                ? this.catalog(request.url, request.maxAgeMs, request.magic)
                : request.kind === 'post'
                  ? this.postText(request.url, request.body, request.type, request.maxAgeMs)
                  : request.kind === 'size'
                    ? this.size(request.url).then(String)
                  : this.text(request.url, request.maxAgeMs, request.json);
      pending = load
        .then((value) => {
          this.remember(key, value);
          return value;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private remember(key: string, value: ArrayBuffer | string): void {
    const size = typeof value === 'string' ? value.length * 2 : value.byteLength;
    if (size > RECENT_BYTES / 8) return;
    this.recent.set(key, value);
    this.recentBytes += size;
    for (const [old, kept] of this.recent) {
      if (this.recentBytes <= RECENT_BYTES) break;
      this.recent.delete(old);
      this.recentBytes -= typeof kept === 'string' ? kept.length * 2 : kept.byteLength;
    }
  }

  /**
   * A catalog document, reused for a day. Only an answer that reads as one is
   * kept: a server can send its maintenance page with a 200, and cached, that
   * stood in for the catalog for a day after the server was back.
   */
  async text(url: string, maxAgeMs = DAY_MS, json = false): Promise<string> {
    if (transport) return transport({ kind: 'text', url, maxAgeMs, json }) as Promise<string>;
    const body = await this.kept(url, maxAgeMs, (bytes) => catalogProblem(new TextDecoder().decode(bytes), json), () => this.download(url));
    return new TextDecoder().decode(body);
  }

  /**
   * A binary catalog document, such as a zipped tile index, reused for a
   * day. Only kept when it starts with `magic`.
   */
  async catalog(url: string, maxAgeMs = DAY_MS, magic: number[] = []): Promise<ArrayBuffer> {
    if (transport) return transport({ kind: 'catalog', url, maxAgeMs, magic }) as Promise<ArrayBuffer>;
    const body = await this.kept(url, maxAgeMs, (bytes) => (magic.every((b, i) => bytes[i] === b) ? null : 'answered with something other than the expected file.'), () => this.download(url));
    return body.slice().buffer;
  }

  /**
   * A catalog document from the cache while it's younger than `maxAgeMs`,
   * else from the server. When the server fails, a copy up to STALE_MS old
   * is better than no survey: national services go down for maintenance
   * for hours, and their tile indexes change slowly.
   */
  private download(url: string): Promise<ArrayBuffer> {
    return fetchBytes(url, this.signal, { cache: false, onBytes: this.onBytes, idleTimeoutMs: CATALOG_IDLE_MS });
  }

  private async kept(url: string, maxAgeMs: number, problem: (bytes: Uint8Array) => string | null, load: () => Promise<ArrayBuffer>): Promise<Uint8Array> {
    const key = `catalog:${url}`;
    const cached = store ? await store.get(key).catch(() => undefined) : undefined;
    let stale: Uint8Array | null = null;
    if (cached && cached.byteLength > 8) {
      const age = Date.now() - new DataView(cached).getFloat64(0, true);
      const body = new Uint8Array(cached, 8);
      if (problem(body) === null) {
        if (age < maxAgeMs) return body;
        if (age < STALE_MS) stale = body;
      }
    }
    let body: Uint8Array;
    try {
      body = new Uint8Array(await load());
    } catch (error) {
      if (stale && !this.signal?.aborted && (error as Error)?.name !== 'AbortError') return stale;
      throw error;
    }
    const wrong = problem(body);
    if (wrong) {
      if (stale) return stale;
      throw new Error(`${url.split('\n')[0]} ${wrong}`);
    }
    const stamped = new Uint8Array(body.byteLength + 8);
    new DataView(stamped.buffer).setFloat64(0, Date.now(), true);
    stamped.set(body, 8);
    if (store) store.put(key, stamped.buffer).catch(() => undefined);
    return body;
  }

  /** A file's size from a HEAD request, kept for a day: a ZIP's directory is found from its end. */
  async size(url: string): Promise<number> {
    if (transport) return Number(await transport({ kind: 'size', url }));
    const key = `size:${url}`;
    const saved = store ? await store.get(key).catch(() => undefined) : undefined;
    if (saved && saved.byteLength === 16) {
      const view = new DataView(saved);
      if (Date.now() - view.getFloat64(0, true) < DAY_MS) return view.getFloat64(8, true);
    }
    const size = await fetchByteLength(url, this.signal);
    const stamped = new DataView(new ArrayBuffer(16));
    stamped.setFloat64(0, Date.now(), true);
    stamped.setFloat64(8, size, true);
    if (store) store.put(key, stamped.buffer).catch(() => undefined);
    return size;
  }

  /** A JSON search answer to a POST, kept for a day like a catalog document. */
  async post(url: string, body: string, type = 'application/json', maxAgeMs = DAY_MS): Promise<unknown> {
    return JSON.parse(await this.postText(url, body, type, maxAgeMs));
  }

  private async postText(url: string, body: string, type: string, maxAgeMs: number): Promise<string> {
    if (transport) return (await transport({ kind: 'post', url, body, type, maxAgeMs })) as string;
    const answer = await this.kept(`${url}\n${body}`, maxAgeMs, (bytes) => catalogProblem(new TextDecoder().decode(bytes), true), () => fetchPost(url, body, type, this.signal, { onBytes: this.onBytes, idleTimeoutMs: CATALOG_IDLE_MS }));
    return new TextDecoder().decode(answer);
  }

  async json(url: string, maxAgeMs = DAY_MS): Promise<unknown> {
    return JSON.parse(await this.text(url, maxAgeMs, true));
  }
}

/** Why a catalog answer isn't one, or null. */
function catalogProblem(text: string, json: boolean): string | null {
  if (json) {
    try {
      JSON.parse(text);
      return null;
    } catch {
      return 'answered with something other than JSON.';
    }
  }
  return /^\s*(<!doctype html|<html)/i.test(text) ? 'answered with a web page.' : null;
}

/** Run `task` on each item with at most `window` running ahead of the one being consumed. */
export async function* ahead<T, R>(items: T[], window: number, task: (item: T) => Promise<R>): AsyncGenerator<R> {
  const running: Promise<R>[] = [];
  let next = 0;
  // Each task needs a handler as soon as it starts. One failing while an
  // earlier one is still awaited is otherwise an unhandled rejection, which
  // ends a Node process before the caller can catch it. It still throws here
  // when its turn comes.
  const start = () => {
    const promise = task(items[next++]);
    promise.catch(() => undefined);
    running.push(promise);
  };
  while (next < items.length && running.length < window) start();
  while (running.length) {
    const result = await running.shift()!;
    if (next < items.length) start();
    yield result;
  }
}
