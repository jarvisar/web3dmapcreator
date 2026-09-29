// A source is a TileJSON URL, an XYZ template with {z}/{x}/{y}, or a .pmtiles
// file read with range requests. It has to use the OpenMapTiles schema.
// Only the tiles for the selected area are fetched, six at a time, and they
// are cached so changing settings doesn't download anything again.
import { PMTiles } from 'pmtiles';
import type { TileId } from '../prepare';

type Fetcher = (tile: TileId, signal?: AbortSignal) => Promise<ArrayBuffer | null>;

// A download that stops without failing would otherwise hold its render, and
// every later render that shares it, forever. XYZ tiles fail after IDLE_MS
// with no bytes. PMTiles reads and TileJSON get READ_MS in all.
const IDLE_MS = 30_000;
const READ_MS = 60_000;

async function downloadTile(href: string, tile: TileId, signal?: AbortSignal): Promise<ArrayBuffer | null> {
  const controller = new AbortController();
  const forward = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', forward, { once: true });
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, IDLE_MS);
  };
  try {
    arm();
    const response = await fetch(href, { signal: controller.signal });
    if (response.status === 204 || response.status === 404) return null; // empty sea/desert tile
    if (!response.ok) throw new Error(`Tile ${tile.z}/${tile.x}/${tile.y} failed with ${response.status}.`);
    if (!response.body) return maybeGunzip(await response.arrayBuffer());
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      chunks.push(value);
      length += value.byteLength;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return maybeGunzip(bytes.buffer);
  } catch (error) {
    if (stalled && !signal?.aborted) throw new Error(`Tile ${tile.z}/${tile.x}/${tile.y} stalled: no data for ${IDLE_MS / 1000} s.`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}

async function maybeGunzip(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return buffer;
  // Some servers send gzipped tiles without Content-Encoding.
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

async function resolveTemplate(url: string): Promise<string> {
  if (url.includes('{z}')) return url;
  const response = await fetch(url, { signal: AbortSignal.timeout(READ_MS) });
  if (!response.ok) throw new Error(`The tile source answered ${response.status} (${url}).`);
  const json = (await response.json()) as { tiles?: string[] };
  const template = json.tiles?.[0];
  if (!template) throw new Error('The tile source is not a TileJSON document with a tiles URL.');
  return template;
}

export class TileSource {
  private readonly url: string;
  private fetcher: Promise<Fetcher> | null = null;

  constructor(url: string) {
    this.url = url.trim();
  }

  private makeFetcher(): Promise<Fetcher> {
    if (/\.pmtiles(\?|$)/i.test(this.url)) {
      const archive = new PMTiles(this.url);
      return Promise.resolve(async (tile, signal) => {
        const response = await archive.getZxy(tile.z, tile.x, tile.y, signal ?? AbortSignal.timeout(READ_MS));
        return response ? response.data : null;
      });
    }
    return resolveTemplate(this.url).then((template) => async (tile, signal) => {
      const href = template.replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y));
      return downloadTile(href, tile, signal);
    });
  }

  get(tile: TileId, signal?: AbortSignal): Promise<ArrayBuffer | null> {
    if (!this.fetcher) {
      this.fetcher = this.makeFetcher();
      // Forget a failed lookup so the next render can retry.
      this.fetcher.catch(() => {
        this.fetcher = null;
      });
    }
    return this.fetcher.then((fetchTile) => fetchTile(tile, signal));
  }
}

export class TileCache {
  private readonly entries = new Map<string, ArrayBuffer | null>();
  private readonly inflight = new Map<string, Promise<ArrayBuffer | null>>();
  private bytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes = 256 * 1024 * 1024) {
    this.maxBytes = maxBytes;
  }

  private remember(key: string, value: ArrayBuffer | null) {
    this.entries.set(key, value);
    this.bytes += value?.byteLength ?? 0;
    for (const [oldKey, oldValue] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(oldKey);
      this.bytes -= oldValue?.byteLength ?? 0;
    }
  }

  async fetchAll(
    source: TileSource,
    sourceKey: string,
    tiles: TileId[],
    onProgress: (done: number, total: number) => void,
    isCancelled: () => boolean,
    concurrency = 6,
    attempts = 3,
  ): Promise<Map<string, ArrayBuffer | null>> {
    const out = new Map<string, ArrayBuffer | null>();
    let done = 0;
    let failures = 0;
    let next = 0;
    const work = async () => {
      while (next < tiles.length && !isCancelled()) {
        const tile = tiles[next++];
        const key = `${sourceKey}|${tile.z}/${tile.x}/${tile.y}`;
        const tileId = `${tile.z}/${tile.x}/${tile.y}`;
        if (this.entries.has(key)) {
          const value = this.entries.get(key)!;
          this.entries.delete(key);
          this.entries.set(key, value);
          out.set(tileId, value);
        } else {
          let pending = this.inflight.get(key);
          if (!pending) {
            pending = this.fetchWithRetry(source, tile, attempts);
            this.inflight.set(key, pending);
          }
          try {
            const value = await pending;
            if (!this.entries.has(key)) this.remember(key, value);
            out.set(tileId, value);
          } catch {
            // Left out of the result. An empty tile is null instead.
            failures++;
          } finally {
            this.inflight.delete(key);
          }
        }
        onProgress(++done, tiles.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, tiles.length) }, work));
    if (failures > 0 && failures === tiles.length) {
      throw new Error('Could not download any map data. Check your connection, or the tile source under Map data.');
    }
    return out;
  }

  private async fetchWithRetry(source: TileSource, tile: TileId, attempts: number): Promise<ArrayBuffer | null> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await source.get(tile);
      } catch (error) {
        lastError = error;
        if (attempt + 1 < attempts) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    throw lastError;
  }
}
