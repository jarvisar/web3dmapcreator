// Downloaded bytes kept in IndexedDB between sessions, evicted least recently
// used first once they pass a size limit. Every operation fails quietly: with
// no IndexedDB (Node, some private windows), a full disk or a broken database
// the data is simply downloaded again. Overture file URLs include the release,
// so a cached range never goes stale.
//
// The page and the worker each load their own copy of this module, with their
// own connection to the same database. Either one can clear it while the
// other is using it.
//
// Map data and LiDAR each have a database of their own, so the hundreds of
// megabytes of a city's point cloud never push out its map data.

export interface ByteCache {
  get(key: string): Promise<ArrayBuffer | undefined>;
  put(key: string, data: ArrayBuffer): Promise<void>;
}

/** Writes past this many bytes evict the least recently used entries. */
export const CACHE_LIMIT = 400e6;
/** The same for LiDAR point data and prepared measurements. */
export const LIDAR_CACHE_LIMIT = 1e9;

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
    tx.onerror = (event) => {
      clearTimeout(timer);
      // While a request's error bubbles up, tx.error is still null. It is only
      // set once the transaction aborts.
      const source = event.target as { error?: DOMException | null } | null;
      reject(source?.error ?? tx.error ?? new Error('IndexedDB transaction failed'));
    };
    tx.onabort = () => {
      clearTimeout(timer);
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    };
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

function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22);
}

/** One IndexedDB database of cached bytes with a size limit. */
export class IdbCache implements ByteCache {
  private opening: Promise<IDBDatabase | null> | null = null;
  private connection: IDBDatabase | null = null;
  // Bytes stored, measured on first write and kept up to date after that. The
  // other thread's writes and clears make it drift, which only means an extra
  // trim that measures again.
  private stored: number | null = null;
  // Reads only record their time here. It is written in batches.
  private readonly touched = new Map<string, number>();
  private touchTimer: ReturnType<typeof setTimeout> | undefined;
  // Writes, trims and clears run one at a time.
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly name: string,
    readonly limit: number,
  ) {}

  private serial(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch(() => undefined);
    return this.queue;
  }

  private openDb(): Promise<IDBDatabase | null> {
    this.opening ??= new Promise<IDBDatabase | null>((resolve) => {
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
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(db);
      };
      // A database held open by an old version in another tab can block forever.
      // Callers go without the cache until then, and a late open is still used.
      const timer = setTimeout(() => finish(null), OPEN_TIMEOUT_MS);
      try {
        const request = factory.open(this.name, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA);
          if (!db.objectStoreNames.contains(ENTRIES)) db.createObjectStore(ENTRIES, { keyPath: 'key' });
        };
        request.onsuccess = () => {
          const db = request.result;
          // Deleting the database (from the other thread, or the browser's site
          // data settings) closes this connection. The next use opens a new one.
          db.onversionchange = () => {
            db.close();
            this.forget(db);
          };
          db.onclose = () => this.forget(db);
          this.connection = db;
          if (settled) this.opening = Promise.resolve(db);
          else finish(db);
        };
        request.onerror = () => finish(null);
        request.onblocked = () => finish(null);
      } catch {
        finish(null);
      }
    });
    return this.opening;
  }

  private forget(db: IDBDatabase): void {
    // A newer connection may have opened since.
    if (this.connection !== db) return;
    this.connection = null;
    this.opening = null;
    this.stored = null;
  }

  private async readEntries(db: IDBDatabase): Promise<CacheEntry[]> {
    const entries = await result(db.transaction(ENTRIES, 'readonly').objectStore(ENTRIES).getAll());
    return (entries as CacheEntry[]).map((entry) => {
      const used = this.touched.get(entry.key);
      return used !== undefined && used > entry.used ? { ...entry, used } : entry;
    });
  }

  private async trim(db: IDBDatabase, target: number): Promise<void> {
    const entries = await this.readEntries(db);
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
    this.stored = total;
  }

  async get(key: string): Promise<ArrayBuffer | undefined> {
    try {
      const db = await this.openDb();
      if (!db) return undefined;
      const value = await result(db.transaction(DATA, 'readonly').objectStore(DATA).get(key));
      if (!(value instanceof ArrayBuffer)) return undefined;
      this.touch(key);
      return value;
    } catch {
      return undefined;
    }
  }

  private touch(key: string): void {
    this.touched.set(key, Date.now());
    this.touchTimer ??= setTimeout(() => {
      this.touchTimer = undefined;
      void this.serial(() => this.writeTouches());
    }, TOUCH_DELAY_MS);
  }

  private async writeTouches(): Promise<void> {
    const batch = [...this.touched];
    this.touched.clear();
    const db = await this.openDb();
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

  put(key: string, data: ArrayBuffer): Promise<void> {
    // One download may not push out more than a quarter of everything else.
    if (data.byteLength > this.limit / 4) return Promise.resolve();
    return this.serial(async () => {
      const db = await this.openDb();
      if (!db) return;
      const before = (this.stored ??= (await this.readEntries(db)).reduce((sum, entry) => sum + entry.size, 0));
      try {
        const tx = db.transaction([DATA, ENTRIES], 'readwrite');
        tx.objectStore(DATA).put(data, key);
        tx.objectStore(ENTRIES).put({ key, size: data.byteLength, used: Date.now() } satisfies CacheEntry);
        await finished(tx);
        this.stored += data.byteLength;
      } catch (error) {
        // Out of quota: make room for later writes instead of retrying this one.
        if (isQuotaError(error)) await this.trim(db, before / 2);
        return;
      }
      if (this.stored > this.limit) await this.trim(db, this.limit * TRIM_TO);
    });
  }

  /** Bytes currently cached, 0 when there is no cache. */
  async size(): Promise<number> {
    try {
      const db = await this.openDb();
      if (!db) return 0;
      return (await this.readEntries(db)).reduce((sum, entry) => sum + entry.size, 0);
    } catch {
      return 0;
    }
  }

  clear(): Promise<void> {
    this.touched.clear();
    return this.serial(async () => {
      const db = await this.openDb();
      if (!db) return;
      const tx = db.transaction([DATA, ENTRIES], 'readwrite');
      tx.objectStore(DATA).clear();
      tx.objectStore(ENTRIES).clear();
      await finished(tx);
      this.stored = 0;
    });
  }
}

/** The map data cache. It does nothing where IndexedDB is missing or failing. */
export const persistentCache = new IdbCache('city-model-downloads', CACHE_LIMIT);
/** LiDAR point data and prepared measurements. */
export const lidarCache = new IdbCache('city-model-lidar', LIDAR_CACHE_LIMIT);

/** Bytes currently cached, 0 when there is no cache. */
export async function cacheSize(): Promise<number> {
  const [data, lidar] = await Promise.all([persistentCache.size(), lidarCache.size()]);
  return data + lidar;
}

/** Deletes every cached download and forgets memoized results. */
export async function clearCache(): Promise<void> {
  memos.clear();
  await Promise.all([persistentCache.clear(), lidarCache.clear()]);
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
