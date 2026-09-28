import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AreaSpec, ModelSettings } from '../settings';
import { CancelledError, EngineClient } from './client';
import type { FromWorker, ToWorker } from './protocol';

class FakeWorker {
  sent: ToWorker[] = [];
  terminated = false;
  onmessage: ((event: { data: FromWorker }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null;
  postMessage(message: ToWorker) {
    this.sent.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(message: FromWorker) {
    this.onmessage?.({ data: message });
  }
  fail(message = '') {
    this.onerror?.({ message, preventDefault() {} });
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const onReplaced = vi.fn();
  const client = new EngineClient({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
    onReplaced,
  });
  return { client, workers, onReplaced };
}

const request = { area: {} as AreaSpec, settings: {} as ModelSettings };

afterEach(() => {
  vi.useRealTimers();
});

describe('EngineClient', () => {
  it('starts a new worker after one fails to load', async () => {
    const { client, workers, onReplaced } = setup();
    const first = client.generate(request);
    workers[0].fail();
    await expect(first).rejects.toThrow(/Reload the page/);
    expect(workers[0].terminated).toBe(true);

    const second = client.generate(request);
    expect(workers).toHaveLength(2);
    const id = (workers[1].sent[0] as { id: number }).id;
    workers[1].reply({ type: 'error', id, message: 'no data' });
    await expect(second).rejects.toThrow('no data');
    // The failed worker never held a model.
    expect(onReplaced).not.toHaveBeenCalled();
  });

  it('reports a crash of a worker that was running', async () => {
    const { client, workers, onReplaced } = setup();
    const job = client.generate(request);
    workers[0].reply({ type: 'progress', id: 1, progress: { stage: 'data', label: 'Finding map data', fraction: 0 } });
    workers[0].fail('out of memory');
    await expect(job).rejects.toThrow('out of memory');
    expect(onReplaced).toHaveBeenCalledTimes(1);
  });

  it('cancels with the worker when it stops in time', async () => {
    const { client, workers } = setup();
    const job = client.generate(request);
    client.cancel();
    expect(workers[0].sent[1]).toEqual({ type: 'cancel', id: 1 });
    workers[0].reply({ type: 'error', id: 1, message: 'Cancelled', cancelled: true });
    await expect(job).rejects.toBeInstanceOf(CancelledError);
    expect(workers).toHaveLength(1);
  });

  it('replaces a stuck worker and sends a newer generate again', async () => {
    vi.useFakeTimers();
    const { client, workers, onReplaced } = setup();
    const old = client.generate(request);
    workers[0].reply({ type: 'progress', id: 1, progress: { stage: 'data', label: 'Finding map data', fraction: 0 } });
    const exported = client.export({} as never);
    const newer = client.generate(request);
    vi.advanceTimersByTime(2000);

    await expect(old).rejects.toBeInstanceOf(CancelledError);
    await expect(exported).rejects.toThrow(/Generate the model again/);
    expect(workers[0].terminated).toBe(true);
    expect(onReplaced).toHaveBeenCalledTimes(1);
    expect(workers[1].sent).toEqual([{ type: 'generate', id: 3, request }]);

    workers[1].reply({ type: 'generated', id: 3, result: { parts: [] } as never });
    await expect(newer).resolves.toEqual({ parts: [] });
  });

  it('sends only the newest generate to a replacement worker', async () => {
    vi.useFakeTimers();
    const { client, workers } = setup();
    const first = client.generate(request);
    const second = client.generate(request);
    const third = client.generate(request);
    vi.advanceTimersByTime(2000);
    await expect(first).rejects.toBeInstanceOf(CancelledError);
    await expect(second).rejects.toBeInstanceOf(CancelledError);
    expect(workers[1].sent).toEqual([{ type: 'generate', id: 3, request }]);
    workers[1].reply({ type: 'generated', id: 3, result: { parts: [] } as never });
    await expect(third).resolves.toEqual({ parts: [] });
  });
});
