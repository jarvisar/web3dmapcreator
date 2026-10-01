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

  it('cancels a download, with the worker when it stops in time and by replacing it when not', async () => {
    vi.useFakeTimers();
    const { client, workers, onReplaced } = setup();
    const first = client.export({} as never);
    client.cancelExport();
    expect(workers[0].sent[1]).toEqual({ type: 'cancel', id: 1 });
    workers[0].reply({ type: 'error', id: 1, message: 'Cancelled', cancelled: true });
    await expect(first).rejects.toBeInstanceOf(CancelledError);
    vi.advanceTimersByTime(2000);
    expect(workers).toHaveLength(1);

    // Stuck in a loop, it never answers the cancel.
    const second = client.export({} as never);
    const edit = client.edit({} as never);
    client.cancelExport();
    vi.advanceTimersByTime(2000);
    await expect(second).rejects.toBeInstanceOf(CancelledError);
    await expect(edit).rejects.toThrow(/Generate the model again/);
    expect(workers[0].terminated).toBe(true);
    expect(onReplaced).toHaveBeenCalledTimes(1);
  });

  it('stops edits being applied by replacing the worker', async () => {
    const { client, workers, onReplaced } = setup();
    const model = client.generate(request);
    workers[0].reply({ type: 'generated', id: 1, result: { parts: [] } as never });
    await model;
    const edit = client.edit({} as never);
    client.stopEdits();
    await expect(edit).rejects.toBeInstanceOf(CancelledError);
    expect(workers[0].terminated).toBe(true);
    expect(onReplaced).toHaveBeenCalledTimes(1);
  });

  it('answers a survey search, and never takes a slow one for a stuck worker', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { client, workers } = setup();
    const search = client.surveys({} as AreaSpec);
    expect(workers[0].sent[0]).toEqual({ type: 'surveys', id: 1, area: {} });
    vi.advanceTimersByTime(30000);
    const job = client.generate(request);
    expect(workers).toHaveLength(1);
    workers[0].reply({ type: 'surveys', id: 1, result: { surveys: [], failures: ['x'] } });
    await expect(search).resolves.toEqual({ surveys: [], failures: ['x'] });
    workers[0].reply({ type: 'generated', id: 2, result: { parts: [] } as never });
    await expect(job).resolves.toEqual({ parts: [] });
  });

  it('replaces a worker stuck on an edit when a new model is asked for', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { client, workers } = setup();
    const edit = client.edit({} as never);
    vi.advanceTimersByTime(5000);
    // Not long enough to call it stuck: the model waits its turn.
    const first = client.generate(request);
    expect(workers).toHaveLength(1);
    vi.advanceTimersByTime(6000);
    const second = client.generate(request);
    await expect(edit).rejects.toBeInstanceOf(CancelledError);
    await expect(first).rejects.toBeInstanceOf(CancelledError);
    expect(workers[0].terminated).toBe(true);
    expect(workers[1].sent).toEqual([{ type: 'generate', id: 3, request }]);
    workers[1].reply({ type: 'generated', id: 3, result: { parts: [] } as never });
    await expect(second).resolves.toEqual({ parts: [] });
  });
});
