// Downloads for the data layer. Requests to each host share a limit on
// requests in flight, network errors and 429 or 5xx answers are retried with
// backoff, and content that cannot change is looked up in the byte cache first.

import type { AsyncBuffer } from 'hyparquet';
import { persistentCache, type ByteCache } from './cache';

export interface HttpConfig {
  /** Requests in flight to one host. Browsers allow 6 per host over HTTP/1.1 anyway. */
  maxInFlight: number;
  /** Retries after the first attempt. */
  retries: number;
  /** Delay before the first retry. Each later retry doubles it. */
  retryDelayMs: number;
  /** An attempt that receives nothing for this long is dropped and retried. */
  idleTimeoutMs: number;
}

const config: HttpConfig = { maxInFlight: 6, retries: 3, retryDelayMs: 500, idleTimeoutMs: 30000 };

// Most time one request waits on Retry-After answers. A server asking to be
// left alone for longer gets a failed request instead.
const MAX_WAIT_MS = 10000;

export function configureHttp(options: Partial<HttpConfig>): void {
  Object.assign(config, options);
  for (const queue of queues.values()) drain(queue);
}

let byteCache: ByteCache | null = persistentCache;

/** Swap the persistent cache, e.g. for a file cache in Node. null turns caching off. */
export function setByteCache(cache: ByteCache | null): void {
  byteCache = cache;
}

/** A value kept in the byte cache under a key of its own, when there is a cache. */
export async function loadCached(key: string): Promise<ArrayBuffer | undefined> {
  return byteCache?.get(key).catch(() => undefined);
}

export function storeCached(key: string, data: ArrayBuffer): void {
  byteCache?.put(key, data).catch(() => undefined);
}

/**
 * Called as data arrives, from the network or the cache. When an attempt
 * fails part way, its bytes are taken back with a negative count before the
 * retry, so the running total always matches the data actually delivered.
 */
export type BytesListener = (bytes: number, fromCache: boolean) => void;

export interface RequestOptions {
  signal?: AbortSignal;
  onBytes?: BytesListener;
  /** Use the byte cache. Default true. */
  cache?: boolean;
  /** Skip the cache lookup but still store the result, to replace a bad entry. */
  refresh?: boolean;
  /** Retries after the first attempt. Default from configureHttp. */
  retries?: number;
}

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  /** From a Retry-After header. Browsers hide it unless the server exposes it. */
  readonly retryAfterMs: number | undefined;

  constructor(status: number, url: string, retryAfterMs?: number) {
    super(`Download failed with HTTP ${status}: ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Milliseconds to wait from a Retry-After value, either seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export class NetworkError extends Error {
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(`Network error while downloading ${url}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'NetworkError';
    this.url = url;
  }
}

// Stalled or short transfers. Worth another attempt.
class TransferError extends Error {}

interface HostQueue {
  active: number;
  waiting: (() => void)[];
}

// Browsers keep a connection pool per host, so each host gets its own queue.
// With one shared queue, a few hundred elevation tiles asked for at once held
// up every Overture read behind them.
const queues = new Map<string, HostQueue>();

function queueFor(url: string): HostQueue {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    host = '';
  }
  let queue = queues.get(host);
  if (!queue) queues.set(host, (queue = { active: 0, waiting: [] }));
  return queue;
}

function acquire(queue: HostQueue, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (queue.active < config.maxInFlight && !queue.waiting.length) {
    queue.active++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const start = () => {
      signal?.removeEventListener('abort', cancel);
      queue.active++;
      resolve();
    };
    const cancel = () => {
      const index = queue.waiting.indexOf(start);
      if (index >= 0) queue.waiting.splice(index, 1);
      reject(signal?.reason);
    };
    queue.waiting.push(start);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

function release(queue: HostQueue): void {
  queue.active--;
  drain(queue);
}

function drain(queue: HostQueue): void {
  while (queue.active < config.maxInFlight && queue.waiting.length) queue.waiting.shift()?.();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

function retryable(error: unknown): boolean {
  if (error instanceof HttpError) return error.status === 429 || error.status >= 500;
  // fetch reports network failures, including a connection dropped mid-body, as TypeError.
  return error instanceof TypeError || error instanceof TransferError;
}

async function withRetries<T>(
  url: string,
  signal: AbortSignal | undefined,
  attempt: () => Promise<T>,
  retries = config.retries,
): Promise<T> {
  let waited = 0;
  for (let tries = 0; ; tries++) {
    let delay: number;
    try {
      return await attempt();
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      delay = config.retryDelayMs * 2 ** tries * (0.75 + Math.random() / 2);
      // 429 and 503 may say how long to stay away.
      const asked = error instanceof HttpError ? error.retryAfterMs : undefined;
      if (asked !== undefined) delay = asked;
      if (tries >= retries || !retryable(error) || (asked !== undefined && waited + delay > MAX_WAIT_MS)) {
        if (error instanceof TypeError || error instanceof TransferError) throw new NetworkError(url, error);
        throw error;
      }
    }
    waited += delay;
    await sleep(delay, signal);
  }
}

interface Transfer {
  url: string;
  /** [start, end) of a range read. */
  range?: [number, number];
  /** Size of the whole file, when known. */
  size?: number;
  signal?: AbortSignal;
  onBytes?: BytesListener;
}

function rangeProblem(response: Response, t: Transfer & { range: [number, number] }): string | undefined {
  const [start, end] = t.range;
  if (response.status === 200) {
    return start === 0 && end === t.size ? undefined : 'the server ignored the byte range';
  }
  const header = response.headers.get('content-range');
  if (!header) return undefined;
  const match = /^bytes (\d+)-(\d+)\//.exec(header);
  if (!match || Number(match[1]) !== start || Number(match[2]) !== end - 1) {
    return `the server sent "${header}" for bytes ${start}-${end - 1}`;
  }
  return undefined;
}

async function readBody(response: Response, expected: number | undefined, onChunk: (bytes: number) => void): Promise<ArrayBuffer> {
  const body = response.body;
  if (!body) {
    const buffer = await response.arrayBuffer();
    if (expected !== undefined && buffer.byteLength !== expected) {
      throw new TransferError(`Received ${buffer.byteLength} of ${expected} bytes`);
    }
    onChunk(buffer.byteLength);
    return buffer;
  }
  const reader = body.getReader();
  try {
    if (expected !== undefined) {
      const out = new Uint8Array(expected);
      let offset = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (offset + value.byteLength > expected) throw new Error(`Received more than the ${expected} bytes asked for`);
        out.set(value, offset);
        offset += value.byteLength;
        onChunk(value.byteLength);
      }
      if (offset !== expected) throw new TransferError(`Received ${offset} of ${expected} bytes`);
      return out.buffer;
    }
    // Content-Length can't be trusted here: a compressed response reports its compressed size.
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
      onChunk(value.byteLength);
    }
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out.buffer;
  } catch (error) {
    reader.cancel().catch(() => undefined);
    throw error;
  }
}

async function transferOnce(t: Transfer): Promise<ArrayBuffer> {
  const queue = queueFor(t.url);
  await acquire(queue, t.signal);
  const controller = new AbortController();
  const forward = () => controller.abort(t.signal?.reason);
  t.signal?.addEventListener('abort', forward, { once: true });
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, config.idleTimeoutMs);
  };
  let received = 0;
  try {
    arm();
    const init: RequestInit = { signal: controller.signal };
    // Only range reads send a header. Any other header makes the browser send
    // a CORS preflight, which stac.overturemaps.org rejects.
    if (t.range) init.headers = { Range: `bytes=${t.range[0]}-${t.range[1] - 1}` };
    const response = await fetch(t.url, init);
    if (!response.ok) {
      response.body?.cancel().catch(() => undefined);
      throw new HttpError(response.status, t.url, parseRetryAfter(response.headers.get('retry-after')));
    }
    if (t.range) {
      const problem = rangeProblem(response, { ...t, range: t.range });
      if (problem) {
        response.body?.cancel().catch(() => undefined);
        throw new Error(`Could not read ${t.url}: ${problem}`);
      }
    }
    return await readBody(response, t.range ? t.range[1] - t.range[0] : undefined, (bytes) => {
      arm();
      received += bytes;
      t.onBytes?.(bytes, false);
    });
  } catch (error) {
    if (received) t.onBytes?.(-received, false);
    if (stalled && !t.signal?.aborted) {
      throw new TransferError(`No data received for ${Math.round(config.idleTimeoutMs / 1000)} s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    t.signal?.removeEventListener('abort', forward);
    release(queue);
  }
}

async function cachedTransfer(key: string, t: Transfer, options: RequestOptions): Promise<ArrayBuffer> {
  const cache = options.cache === false ? null : byteCache;
  if (cache && !options.refresh) {
    const hit = await cache.get(key).catch(() => undefined);
    if (hit && (!t.range || hit.byteLength === t.range[1] - t.range[0])) {
      t.signal?.throwIfAborted();
      t.onBytes?.(hit.byteLength, true);
      return hit;
    }
  }
  const data = await withRetries(t.url, t.signal, () => transferOnce(t), options.retries);
  if (cache) cache.put(key, data).catch(() => undefined);
  return data;
}

export interface RemoteFile extends AsyncBuffer {
  slice(start: number, end?: number): Promise<ArrayBuffer>;
}

/**
 * A hyparquet AsyncBuffer over a remote file. Each slice is one range request
 * (or a cache hit), so knowing `byteLength` up front saves a HEAD request.
 */
export function remoteFile(url: string, byteLength: number, options: RequestOptions = {}): RemoteFile {
  return {
    byteLength,
    slice(start: number, end = byteLength): Promise<ArrayBuffer> {
      if (!(start >= 0 && start <= end && end <= byteLength)) {
        return Promise.reject(new RangeError(`Bytes ${start}-${end} are outside ${url}`));
      }
      if (start === end) return Promise.resolve(new ArrayBuffer(0));
      const transfer = { url, range: [start, end] as [number, number], size: byteLength, signal: options.signal, onBytes: options.onBytes };
      return cachedTransfer(`${url}#${start}-${end}`, transfer, options);
    },
  };
}

/** A whole file, cached by its URL unless `cache` is false. */
export function fetchBytes(url: string, signal?: AbortSignal, options: Omit<RequestOptions, 'signal'> = {}): Promise<ArrayBuffer> {
  return cachedTransfer(url, { url, signal, onBytes: options.onBytes }, options);
}

/** File size from a HEAD request, for files the Overture index gives no size for. */
export function fetchByteLength(url: string, signal?: AbortSignal): Promise<number> {
  const queue = queueFor(url);
  return withRetries(url, signal, async () => {
    await acquire(queue, signal);
    try {
      const response = await fetch(url, { method: 'HEAD', signal });
      if (!response.ok) throw new HttpError(response.status, url, parseRetryAfter(response.headers.get('retry-after')));
      const length = Number(response.headers.get('content-length'));
      if (!Number.isFinite(length) || length <= 0) throw new Error(`No file size for ${url}`);
      return length;
    } finally {
      release(queue);
    }
  });
}
