import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BatchJob } from '../core/lidar/prepare';
import { setLidarStore } from '../core/lidar/read/fetcher';
import type { FromLidarWorker, ToLidarWorker } from './lidarProtocol';
import { lidarPool, type WorkerLike } from './lidarPool';

type Job = Extract<ToLidarWorker, { type: 'job' }>;
type Behaviour = (message: Job, worker: WorkerLike) => void;

/** Workers that answer after a tick, as `behave` says. */
function fakes(behave: Behaviour) {
  const spawned: WorkerLike[] = [];
  let busy = 0;
  let peak = 0;
  const create = () => {
    const worker: WorkerLike & { terminated: boolean } = {
      onmessage: null,
      onerror: null,
      terminated: false,
      terminate() {
        this.terminated = true;
      },
      postMessage(message) {
        if (message.type !== 'job') return;
        busy++;
        peak = Math.max(peak, busy);
        setTimeout(() => {
          busy--;
          if (!worker.terminated) behave(message, worker);
        }, 5);
      },
    };
    spawned.push(worker);
    return worker;
  };
  return { create, spawned, peak: () => peak };
}

const job = (name: string) => ({ batch: [{ id: name }] }) as unknown as BatchJob;
const done: Behaviour = ({ id, job }, worker) => {
  worker.onmessage?.({ data: { id, type: 'progress', label: 'Reading', detail: job.batch[0].id } });
  worker.onmessage?.({ data: { id, type: 'done', outcome: { records: {}, rejected: { [job.batch[0].id]: 'none' }, observations: {} } } });
};

describe('LiDAR worker pool', () => {
  it('runs up to its size at once, reusing workers', async () => {
    const f = fakes(done);
    const pool = lidarPool(3, undefined, f.create);
    const seen: string[] = [];
    const results = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => pool.run(job(name), (_, detail) => void seen.push(detail!))));
    expect(results.map((r) => Object.keys(r.outcome.rejected)[0])).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(f.spawned).toHaveLength(3);
    expect(f.peak()).toBe(3);
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    pool.close();
  });

  it('passes errors back by name, so a budget overrun can be split', async () => {
    const pool = lidarPool(1, undefined, fakes(({ id }, worker) => worker.onmessage?.({ data: { id, type: 'error', name: 'BudgetExceeded', message: 'too many points' } })).create);
    await expect(pool.run(job('a'), () => undefined)).rejects.toMatchObject({ name: 'BudgetExceeded', message: 'too many points' });
    pool.close();
  });

  it('fails only the batch whose worker crashed, and replaces the worker', async () => {
    let crashes = 1;
    const f = fakes((message, worker) => (crashes-- > 0 ? worker.onerror?.({ message: 'wasm trap' }) : done(message, worker)));
    const pool = lidarPool(1, undefined, f.create);
    const [first, second] = await Promise.allSettled([pool.run(job('a'), () => undefined), pool.run(job('b'), () => undefined)]);
    expect(first.status).toBe('rejected');
    expect((first as PromiseRejectedResult).reason.message).toMatch(/wasm trap/);
    expect(second.status).toBe('fulfilled');
    expect(f.spawned).toHaveLength(2);
    pool.close();
  });

  it('stops every worker when generation is cancelled', async () => {
    const controller = new AbortController();
    const f = fakes(() => undefined);
    const pool = lidarPool(2, controller.signal, f.create);
    const running = [pool.run(job('a'), () => undefined), pool.run(job('b'), () => undefined)];
    await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    for (const result of await Promise.allSettled(running)) expect((result as PromiseRejectedResult).reason.name).toBe('AbortError');
    expect(f.spawned.every((w) => (w as WorkerLike & { terminated: boolean }).terminated)).toBe(true);
    await expect(pool.run(job('c'), () => undefined)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('downloads a file once when several workers ask for it', async () => {
    setLidarStore(null);
    let fetched = 0;
    vi.stubGlobal('fetch', async () => {
      fetched++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(new Uint8Array(100), { status: 206, headers: { 'content-range': 'bytes 0-99/1000' } });
    });
    const answers: number[] = [];
    // Each worker asks for the same range as soon as it gets a batch.
    const create = () => {
      let current = -1;
      const worker: WorkerLike = {
        onmessage: null,
        onerror: null,
        terminate() {},
        postMessage(message) {
          if (message.type === 'answer') {
            answers.push((message.value as ArrayBuffer).byteLength);
            const finished: FromLidarWorker = { type: 'done', id: current, outcome: { records: {}, rejected: {}, observations: {} } };
            worker.onmessage?.({ data: finished });
            return;
          }
          current = message.id;
          worker.onmessage?.({ data: { type: 'request', rid: message.id, request: { kind: 'range', url: 'https://example.com/a.copc.laz', start: 0, end: 100 } } });
        },
      };
      return worker;
    };
    const pool = lidarPool(3, undefined, create);
    await Promise.all(['a', 'b', 'c'].map((name) => pool.run(job(name), () => undefined)));
    // And once more later, from memory.
    await pool.run(job('d'), () => undefined);
    expect(answers).toEqual([100, 100, 100, 100]);
    expect(fetched).toBe(1);
    expect(pool.downloaded()).toBe(100);
    pool.close();
  });
});

afterEach(() => vi.unstubAllGlobals());
