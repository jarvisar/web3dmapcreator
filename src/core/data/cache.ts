// Downloaded bytes kept in IndexedDB between sessions, evicted least recently
// used first once they pass a size limit. Every operation fails quietly: with
// no IndexedDB (Node, some private windows), a full disk or a broken database
// the data is simply downloaded again. Overture file URLs include the release,
// so a cached range never goes stale.

export interface ByteCache {
  get(key: string): Promise<ArrayBuffer | undefined>;
  put(key: string, data: ArrayBuffer): Promise<void>;
}

export const DEFAULT_CACHE_LIMIT = 400e6;

const DB_NAME = 'city-model-downloads';
const DB_VERSION = 1;
const DATA = 'data';
const ENTRIES = 'entries';
const OPEN_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 10000;
const TOUCH_DELAY_MS = 2000;
// Trim to this share of the limit, so a full cache is not trimmed on every write.
const TRIM_TO = 0.9;

export interface CacheEntry {
  key: string;
  size: number;
  /** Last use, in ms since the epoch. */
  used: number;
}

let limit = DEFAULT_CACHE_LIMIT;
let opening: Promise<IDBDatabase | null> | null = null;
// Bytes stored, measured on first write and kept up to date after that.
let stored: number | null = null;
// Reads only record their time here. It is written in batches.
const touched = new Map<string, number>();
let touchTimer: ReturnType<typeof setTimeout> | undefined;
// Writes, trims and clears run one at a time.
let queue: Promise<void> = Promise.resolve();

function serial(task: () => Promise<void>): Promise<void> {
  queue = queue.then(task).catch(() => undefined);
  return queue;
}

function openDb(): Promise<IDBDatabase | null> {
  opening ??= new Promise<IDBDatabase | null>((resolve) => {
    let factory: IDBFactory | undefined;
    try {
      factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    } catch {
      factory = undefined;
    }
    if (!factory) {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (db: IDBDatabase | null) => {
      if (settled) {
        db?.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };
    // A database held open by an old version in another tab can block forever.
    const timer = setTimeout(() => finish(null), OPEN_TIMEOUT_MS);
    try {
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA);
        if (!db.objectStoreNames.contains(ENTRIES)) db.createObjectStore(ENTRIES, { keyPath: 'key' });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          opening = null;
          stored = null;
        };
        finish(db);
      };
      request.onerror = () => finish(null);
      request.onblocked = () => finish(null);
    } catch {
      finish(null);
    }
  });
  return opening;
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('IndexedDB request timed out')), REQUEST_TIMEOUT_MS);
    request.onsuccess = () => {
      clearTimeout(timer);
      resolve(request.result);
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error);
    };
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        tx.abort();
      } catch {
        // Already finished.
      }
      reject(new Error('IndexedDB transaction timed out'));
    }, REQUEST_TIMEOUT_MS);
    tx.oncomplete = () => {
      clearTimeout(timer);
      resolve();
    };
    tx.onerror = () => {
      clearTimeout(timer);
      reject(tx.error);
    };
    tx.onabort = () => {
      clearTimeout(timer);
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    };
  });
}

async function readEntries(db: IDBDatabase): Promise<CacheEntry[]> {
  const entries = await result(db.transaction(ENTRIES, 'readonly').objectStore(ENTRIES).getAll());
  return (entries as CacheEntry[]).map((entry) => {
    const used = touched.get(entry.key);
    return used !== undefined && used > entry.used ? { ...entry, used } : entry;
  });
}

/** Keys to delete, least recently used first, to bring the total down to `target` bytes. */
export function planEviction(entries: readonly CacheEntry[], target: number): string[] {
  let total = 0;
  for (const entry of entries) total += entry.size;
  const doomed: string[] = [];
  const oldest = [...entries].sort((a, b) => a.used - b.used);
  for (const entry of oldest) {
    if (total <= target) break;
    doomed.push(entry.key);
    total -= entry.size;
  }
  return doomed;
}

async function trim(db: IDBDatabase, target: number): Promise<void> {
  const entries = await readEntries(db);
  const doomed = planEviction(entries, target);
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (doomed.length) {
    const sizes = new Map(entries.map((entry) => [entry.key, entry.size]));
    const tx = db.transaction([DATA, ENTRIES], 'readwrite');
    for (const key of doomed) {
      tx.objectStore(DATA).delete(key);
      tx.objectStore(ENTRIES).delete(key);
      total -= sizes.get(key) ?? 0;
    }
    await finished(tx);
  }
  stored = total;
}

function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22);
}

async function get(key: string): Promise<ArrayBuffer | undefined> {
  try {
    const db = await openDb();
    if (!db) return undefined;
    const value = await result(db.transaction(DATA, 'readonly').objectStore(DATA).get(key));
    if (!(value instanceof ArrayBuffer)) return undefined;
    touch(key);
    return value;
  } catch {
    return undefined;
  }
}

function touch(key: string): void {
  touched.set(key, Date.now());
  touchTimer ??= setTimeout(() => {
    touchTimer = undefined;
    void serial(writeTouches);
  }, TOUCH_DELAY_MS);
}

async function writeTouches(): Promise<void> {
  const batch = [...touched];
  touched.clear();
  const db = await openDb();
  if (!db || !batch.length) return;
  const tx = db.transaction(ENTRIES, 'readwrite');
  const store = tx.objectStore(ENTRIES);
  for (const [key, used] of batch) {
    const request = store.get(key);
    request.onsuccess = () => {
      const entry = request.result as CacheEntry | undefined;
      if (entry && entry.used < used) store.put({ ...entry, used });
    };
  }
  await finished(tx);
}

function put(key: string, data: ArrayBuffer): Promise<void> {
  // One download may not push out more than a quarter of everything else.
  if (data.byteLength > limit / 4) return Promise.resolve();
  return serial(async () => {
    const db = await openDb();
    if (!db) return;
    stored ??= (await readEntries(db)).reduce((sum, entry) => sum + entry.size, 0);
    try {
      const tx = db.transaction([DATA, ENTRIES], 'readwrite');
      tx.objectStore(DATA).put(data, key);
      tx.objectStore(ENTRIES).put({ key, size: data.byteLength, used: Date.now() } satisfies CacheEntry);
      await finished(tx);
      stored += data.byteLength;
    } catch (error) {
      // Out of quota: make room for later writes instead of retrying this one.
      if (isQuotaError(error)) await trim(db, stored / 2);
      return;
    }
    if (stored > limit) await trim(db, limit * TRIM_TO);
  });
}

/** The IndexedDB cache. It does nothing where IndexedDB is missing or failing. */
export const persistentCache: ByteCache = { get, put };

/** Bytes currently cached, 0 when there is no cache. */
export async function cacheSize(): Promise<number> {
  try {
    const db = await openDb();
    if (!db) return 0;
    return (await readEntries(db)).reduce((sum, entry) => sum + entry.size, 0);
  } catch {
    return 0;
  }
}

/** Deletes every cached download and forgets memoized results. */
export function clearCache(): Promise<void> {
  memos.clear();
  touched.clear();
  return serial(async () => {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction([DATA, ENTRIES], 'readwrite');
    tx.objectStore(DATA).clear();
    tx.objectStore(ENTRIES).clear();
    await finished(tx);
    stored = 0;
  });
}

/**
 * Size limit for writes made from this thread (the page and the worker each
 * load their own copy of this module). Trims right away when it is exceeded.
 */
export function setCacheLimit(bytes: number): Promise<void> {
  limit = Math.max(0, bytes);
  return serial(async () => {
    const db = await openDb();
    if (!db) return;
    stored ??= (await readEntries(db)).reduce((sum, entry) => sum + entry.size, 0);
    if (stored > limit) await trim(db, limit * TRIM_TO);
  });
}

const memos = new Map<string, { value: Promise<unknown>; expires: number }>();

/**
 * Shares one `load()` between callers for `ttlMs`. A failed load is
 * forgotten so the next call tries again. The load keeps running when a
 * caller's signal aborts, and only that caller's promise rejects.
 */
export function memo<T>(key: string, ttlMs: number, load: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const now = Date.now();
  let hit = memos.get(key) as { value: Promise<T>; expires: number } | undefined;
  if (!hit || hit.expires <= now) {
    const value = load();
    hit = { value, expires: now + ttlMs };
    memos.set(key, hit);
    value.catch(() => {
      if (memos.get(key)?.value === value) memos.delete(key);
    });
  }
  return signal ? abortable(hit.value, signal) : hit.value;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(error);
      },
    );
  });
}
