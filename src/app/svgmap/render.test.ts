import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderSettings } from '../../core/svgmap/settings';
import type { SvgWorkerRequest, SvgWorkerResponse } from '../../worker/svg.worker';

// A worker that only answers when told to.
class FakeWorker {
  static made: FakeWorker[] = [];
  sent: SvgWorkerRequest[] = [];
  terminated = false;
  onmessage: ((event: { data: SvgWorkerResponse }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  constructor() {
    FakeWorker.made.push(this);
  }
  postMessage(message: SvgWorkerRequest) {
    this.sent.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  ack(seq: number) {
    this.onmessage?.({ data: { type: 'ack', seq } });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  FakeWorker.made = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('document', { baseURI: 'https://app.test/' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settings = (n: number) => ({ title: `map ${n}` }) as unknown as RenderSettings;

describe('the SVG render worker', () => {
  it('is replaced when a cancel goes unanswered, even if an older answer arrives late', async () => {
    const { cancelRender, requestRender } = await import('./render');
    requestRender(settings(1), null);
    const worker = FakeWorker.made[0];
    worker.ack(1);
    // A second render while the first runs, then a cancel.
    requestRender(settings(2), null);
    cancelRender();
    const [, second, cancel] = worker.sent;
    expect(cancel.type).toBe('cancel');
    // The answer to the second render arrives only now, then nothing.
    worker.ack(second.seq);
    await vi.advanceTimersByTimeAsync(8000);
    expect(worker.terminated).toBe(true);
  });

  it('is kept when it answers the cancel', async () => {
    const { cancelRender, requestRender } = await import('./render');
    requestRender(settings(1), null);
    const worker = FakeWorker.made[0];
    requestRender(settings(2), null);
    cancelRender();
    worker.ack(worker.sent[2].seq);
    await vi.advanceTimersByTimeAsync(8000);
    expect(worker.terminated).toBe(false);
  });
});
