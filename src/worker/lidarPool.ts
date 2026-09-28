// A few LiDAR workers for prepareLidar, so batches read and measure in
// parallel. Workers start on the first batch that isn't checkpointed and are
// all stopped by close(), which frees their point clouds. Their downloads
// come through here, so a file several batches need is fetched once.

import type { BatchRunner } from '../core/lidar/prepare';
import { Fetcher } from '../core/lidar/read/fetcher';
import { answer, type FromLidarWorker, type ToLidarWorker } from './lidarProtocol';

// Each worker holds one batch's points (up to a few hundred MB), so memory
// sets the limit more than cores do.
const MAX_WORKERS = 4;

export function lidarPoolSize(): number {
  const cores = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency || 2;
  return Math.max(1, Math.min(MAX_WORKERS, cores - 1));
}

/** The part of a Worker the pool uses, so Node's worker_threads can stand in. */
export interface WorkerLike {
  postMessage(message: ToLidarWorker): void;
  onmessage: ((event: { data: FromLidarWorker }) => void) | null;
  onerror: ((event: { message?: string; preventDefault?(): void }) => void) | null;
  terminate(): void;
}

const webWorker = () => new Worker(new URL('./lidar.worker.ts', import.meta.url), { type: 'module', name: 'lidar' }) as unknown as WorkerLike;

export function lidarPool(size: number, signal?: AbortSignal, create: () => WorkerLike = webWorker): BatchRunner & { close(): void; downloaded(): number } {
  const idle: WorkerLike[] = [];
  const all = new Set<WorkerLike>();
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
  };
  signal?.addEventListener('abort', () => close(), { once: true });

  return {
    concurrency: size,
    close: () => close(),
    downloaded: () => fetcher.downloaded,
    async run(job, progress) {
      signal?.throwIfAborted();
      if (closed) throw new DOMException('Aborted', 'AbortError');
      const worker = await acquire();
      const id = nextId++;
      try {
        return await new Promise((resolve, reject) => {
          running.set(id, { reject, worker });
          worker.onmessage = ({ data }) => {
            if (data.type === 'request') {
              answer(fetcher, data.rid, data.request, (message) => worker.postMessage(message));
              return;
            }
            if (data.id !== id) return;
            if (data.type === 'progress') {
              // Progress throws once generation is cancelled. The worker is
              // still busy with this batch, so it can't be reused.
              Promise.resolve(progress(data.label, data.detail)).catch((error: Error) => {
                all.delete(worker);
                worker.terminate();
                reject(error);
              });
            } else if (data.type === 'done') resolve({ outcome: data.outcome, downloaded: 0 });
            else reject(Object.assign(new Error(data.message), { name: data.name }));
          };
          // A crash (out of memory, a wasm trap) loses the worker. Only this batch fails.
          worker.onerror = (event) => {
            event.preventDefault?.();
            all.delete(worker);
            worker.terminate();
            reject(new Error(`The LiDAR worker stopped: ${event.message || 'out of memory?'}`));
          };
          worker.postMessage({ type: 'job', id, job } satisfies ToLidarWorker);
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
    },
  };
}
