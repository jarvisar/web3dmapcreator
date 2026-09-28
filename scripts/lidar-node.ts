// LiDAR in Node for the scripts: a folder in place of IndexedDB, the decoder
// from the wasm's bytes (Node's fetch can't read file URLs), and a pool of
// worker threads like the site's worker pool.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ByteCache } from '../src/core/data/cache';
import { setSurfaceStore } from '../src/core/dsm/prepare';
import { setCheckpointStore } from '../src/core/lidar/prepare';
import { setLidarStore } from '../src/core/lidar/read/fetcher';
import { installLidarCodecs } from '../src/worker/lidarCodecs';
import { lidarPool, type WorkerLike } from '../src/worker/lidarPool';

/** Nothing is evicted, so delete the folder to start over. */
export function folderStore(dir: string): ByteCache {
  mkdirSync(dir, { recursive: true });
  const path = (key: string) => join(dir, createHash('sha1').update(key).digest('hex'));
  return {
    async get(key) {
      try {
        const bytes = readFileSync(path(key));
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      } catch {
        return undefined;
      }
    },
    async put(key, data) {
      writeFileSync(path(key), new Uint8Array(data));
    },
  };
}

/** The decoder, projector and a folder cache for this thread. */
export function setUpLidar(cacheDir: string): void {
  const store = folderStore(cacheDir);
  setLidarStore(store);
  setCheckpointStore(store);
  setSurfaceStore(store);
  installLidarCodecs(readFileSync(createRequire(import.meta.url).resolve('@voxelkloud/wasm-codecs/voxelkloud_wasm_codecs_bg.wasm')));
}

function threadWorker(cacheDir: string): WorkerLike {
  const worker = new Worker(new URL('./lidar-worker.mjs', import.meta.url), { workerData: { cacheDir } });
  const like: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (message) => worker.postMessage(message),
    terminate: () => void worker.terminate(),
  };
  worker.on('message', (data) => like.onmessage?.({ data }));
  worker.on('error', (error: Error) => like.onerror?.({ message: error.message }));
  return like;
}

export function threadPool(size: number, cacheDir: string) {
  return lidarPool(size, undefined, () => threadWorker(cacheDir));
}
