// Downloads for LiDAR discovery and reading, through the shared HTTP layer
// (per-host limits, retries) and the LiDAR byte cache. Catalog answers are
// kept for a day; point data never changes under its URL and stays until the
// cache evicts it.

import { lidarCache, type ByteCache } from '../../data/cache';
import { fetchBytes, fetchRange } from '../../data/http';

const DAY_MS = 24 * 3600 * 1000;
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
  | { kind: 'text'; url: string; maxAgeMs: number; json?: boolean };

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

  /**
   * A worker's request. Workers asking for the same thing at once share one
   * download, and recent answers are kept in memory for a while.
   */
  serve(request: LidarRequest): Promise<ArrayBuffer | string> {
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
    const usable = (text: string) => catalogProblem(text, json) === null;
    const key = `catalog:${url}`;
    const cached = store ? await store.get(key).catch(() => undefined) : undefined;
    if (cached && cached.byteLength > 8) {
      const view = new DataView(cached);
      const saved = view.getFloat64(0, true);
      const text = new TextDecoder().decode(new Uint8Array(cached, 8));
      if (Date.now() - saved < maxAgeMs && usable(text)) return text;
    }
    const body = new Uint8Array(await fetchBytes(url, this.signal, { cache: false, onBytes: this.onBytes, idleTimeoutMs: CATALOG_IDLE_MS }));
    const text = new TextDecoder().decode(body);
    const problem = catalogProblem(text, json);
    if (problem) throw new Error(`${url} ${problem}`);
    const stamped = new Uint8Array(body.byteLength + 8);
    new DataView(stamped.buffer).setFloat64(0, Date.now(), true);
    stamped.set(body, 8);
    if (store) store.put(key, stamped.buffer).catch(() => undefined);
    return text;
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
