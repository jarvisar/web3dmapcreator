// Messages between a LiDAR worker and its pool, and the worker's side of
// them, shared by the browser worker and the Node worker threads. Workers
// send their downloads to the pool, which fetches each file once for all of
// them (Fetcher.serve).

import { runBatch, type BatchJob, type BatchOutcome } from '../core/lidar/prepare';
import { Fetcher, setLidarTransport, type LidarRequest } from '../core/lidar/read/fetcher';

export type ToLidarWorker =
  | { type: 'job'; id: number; job: BatchJob }
  | { type: 'answer'; rid: number; value?: ArrayBuffer | string; error?: { name: string; message: string } };

export type FromLidarWorker =
  | { type: 'progress'; id: number; label: string; detail?: string }
  | { type: 'done'; id: number; outcome: BatchOutcome }
  | { type: 'error'; id: number; name: string; message: string }
  | { type: 'request'; rid: number; request: LidarRequest };

const described = (error: unknown) => {
  const { name, message } = error instanceof Error ? error : new Error(String(error));
  return { name, message };
};

/** Route this thread's LiDAR downloads to the pool, and return the handler for its messages. */
export function lidarWorker(post: (message: FromLidarWorker) => void): (message: ToLidarWorker) => void {
  const waiting = new Map<number, { resolve: (value: ArrayBuffer | string) => void; reject: (error: Error) => void }>();
  let next = 0;
  setLidarTransport(
    (request) =>
      new Promise((resolve, reject) => {
        const rid = next++;
        waiting.set(rid, { resolve, reject });
        post({ type: 'request', rid, request });
      }),
  );
  return (message) => {
    if (message.type === 'answer') {
      const handlers = waiting.get(message.rid);
      waiting.delete(message.rid);
      if (!handlers) return;
      if (message.error) handlers.reject(Object.assign(new Error(message.error.message), { name: message.error.name }));
      else handlers.resolve(message.value!);
      return;
    }
    const { id, job } = message;
    runBatch(job, new Fetcher(), (label, detail) => post({ type: 'progress', id, label, detail })).then(
      (outcome) => post({ type: 'done', id, outcome }),
      (error) => post({ type: 'error', id, ...described(error) }),
    );
  };
}

/** The pool's side: answer a worker's request from the shared Fetcher. */
export function answer(fetcher: Fetcher, rid: number, request: LidarRequest, reply: (message: ToLidarWorker) => void): void {
  fetcher.serve(request).then(
    (value) => reply({ type: 'answer', rid, value }),
    (error) => reply({ type: 'answer', rid, error: described(error) }),
  );
}
