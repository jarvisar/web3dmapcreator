// A few LiDAR workers for prepareLidar, so batches read and measure in
// parallel. Workers start on the first batch that isn't checkpointed and are
// all stopped by close(), which frees their point clouds. Their downloads
// come through here, so a file several batches need is fetched once. A
// LiDAR Only model reads its blocks and simplifies its mesh tiles here too.

import type { TileJob, TileResult } from '../core/dsm/mesh';
import type { SurfaceOutcome, SurfaceRunner } from '../core/dsm/prepare';
import type { FromWorker } from '../core/engine/protocol';
import type { BatchOutcome, BatchProgress, BatchRunner } from '../core/lidar/prepare';
import { Fetcher } from '../core/lidar/read/fetcher';
import { answer, type FromLidarWorker, type ToLidarWorker } from './lidarProtocol';

// Each worker holds one batch's points (up to a few hundred MB), so memory
// sets the limit more than cores do.
const MAX_WORKERS = 4;

export function lidarPoolSize(): number {
  const cores = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency || 2;
  return Math.max(1, Math.min(MAX_WORKERS, cores - 1));
}

/**
 * Workers for a LiDAR Only model. Its blocks are counted into the grid as
 * they're read and its mesh tiles are small, so cores set the limit, and
 * the memory the browser reports (Chrome only, in GB) where it's low.
 */
export function surfacePoolSize(): number {
  const cores = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency || 2;
  const memory = typeof navigator === 'undefined' ? undefined : (navigator as { deviceMemory?: number }).deviceMemory;
  return Math.max(1, Math.min(8, cores - 1, memory ?? 8));
}

/** The part of a Worker the pool uses, so Node's worker_threads can stand in. */
export interface WorkerLike {
  postMessage(message: ToLidarWorker): void;
  onmessage: ((event: { data: FromLidarWorker }) => void) | null;
  onerror: ((event: { message?: string; preventDefault?(): void }) => void) | null;
  terminate(): void;
}

const webWorker = () => new Worker(new URL('./lidar.worker.ts', import.meta.url), { type: 'module', name: 'lidar' }) as unknown as WorkerLike;

// The browser's pool runs in the engine worker, so this reaches the page, which offers a reload.
const tellPage = () => (self as unknown as { postMessage(message: FromWorker): void }).postMessage({ type: 'outdated' });

/** `onStale` hears of a worker that never loaded, which in the browser tells the page to offer a reload. */
export function lidarPool(
  size: number,
  signal?: AbortSignal,
  create: () => WorkerLike = webWorker,
  onStale: (() => void) | undefined = create === webWorker ? tellPage : undefined,
): BatchRunner & SurfaceRunner & { tile(job: TileJob): Promise<TileResult>; close(): void; downloaded(): number } {
  const idle: WorkerLike[] = [];
  const all = new Set<WorkerLike>();
  // Workers that have sent anything, so loaded.
  const spoke = new WeakSet<WorkerLike>();
  const waiting: ((worker: WorkerLike) => void)[] = [];
  const running = new Map<number, { reject: (error: Error) => void; worker: WorkerLike }>();
  let nextId = 0;
  let closed = false;
  const fetcher = new Fetcher(signal);

  const spawn = () => {
    const worker = create();
    all.add(worker);
    return worker;
  };
  const acquire = (): Promise<WorkerLike> => {
    const worker = idle.pop() ?? (all.size < size ? spawn() : null);
    return worker ? Promise.resolve(worker) : new Promise((resolve) => waiting.push(resolve));
  };
  const release = (worker: WorkerLike) => {
    const next = waiting.shift();
    if (next) next(worker);
    else idle.push(worker);
  };
  const close = (reason?: Error) => {
    if (closed) return;
    closed = true;
    for (const worker of all) worker.terminate();
    all.clear();
    idle.length = 0;
    for (const { reject } of running.values()) reject(reason ?? new DOMException('Aborted', 'AbortError'));
    running.clear();
    fetcher.release();
  };
  signal?.addEventListener('abort', () => close(), { once: true });

  type Message = Extract<ToLidarWorker, { type: 'job' | 'surface' | 'tile' }>;
  type Outcome = Extract<FromLidarWorker, { type: 'done' }>['outcome'];

  const dispatch = async (message: (id: number) => Message, progress?: BatchProgress): Promise<Outcome> => {
    signal?.throwIfAborted();
    if (closed) throw new DOMException('Aborted', 'AbortError');
    const worker = await acquire();
    const id = nextId++;
    try {
      return await new Promise<Outcome>((resolve, reject) => {
        running.set(id, { reject, worker });
        worker.onmessage = ({ data }) => {
          spoke.add(worker);
          if (data.type === 'request') {
            answer(fetcher, data.rid, data.request, (reply) => worker.postMessage(reply));
            return;
          }
          if (data.id !== id) return;
          if (data.type === 'progress') {
            // Progress throws once generation is cancelled. The worker is
            // still busy with this job, so it can't be reused.
            Promise.resolve(progress?.(data.label, data.detail)).catch((error: Error) => {
              all.delete(worker);
              worker.terminate();
              reject(error);
            });
          } else if (data.type === 'done') resolve(data.outcome);
          else reject(Object.assign(new Error(data.message), { name: data.name }));
        };
        // A crash (out of memory, a wasm trap) loses the worker. Only this job fails.
        worker.onerror = (event) => {
          event.preventDefault?.();
          all.delete(worker);
          worker.terminate();
          // Silent from the start and no reason given: the script didn't load.
          // A tab still on the last version asks for a chunk a deploy removed.
          if (!spoke.has(worker) && !event.message) {
            onStale?.();
            reject(new Error('The LiDAR reader could not load, probably because the site was updated. Reload the page and try again.'));
          } else reject(new Error(`The LiDAR worker stopped: ${event.message || 'out of memory?'}`));
        };
        worker.postMessage(message(id));
      });
    } finally {
      running.delete(id);
      if (all.has(worker) && !closed) release(worker);
      else if (!closed) {
        // Replace a crashed worker for anyone waiting.
        const next = waiting.shift();
        if (next) next(spawn());
      }
    }
  };

  return {
    concurrency: size,
    close: () => close(),
    downloaded: () => fetcher.downloaded,
    async run(job, progress) {
      return { outcome: (await dispatch((id) => ({ type: 'job', id, job }), progress)) as BatchOutcome, downloaded: 0 };
    },
    surface: (job, progress) => dispatch((id) => ({ type: 'surface', id, job }), progress) as Promise<SurfaceOutcome>,
    tile: (job) => {
      // Meshing comes after the reading, so held tiles (up to a GB) aren't needed any more.
      fetcher.release();
      return dispatch((id) => ({ type: 'tile', id, job })) as Promise<TileResult>;
    },
  };
}
