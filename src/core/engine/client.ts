// Main-thread side of the generation worker.

import type {
  EditRequest,
  EditUpdate,
  ExportRequest,
  ExportResult,
  FromWorker,
  GenerateRequest,
  GenerateResult,
  ProgressEvent,
  ToWorker,
} from './protocol';

interface Pending {
  message: Extract<ToWorker, { type: 'generate' | 'export' | 'edit' }>;
  resolve: (value: never) => void;
  reject: (error: Error) => void;
  onProgress?: (event: ProgressEvent) => void;
  sentAt: number;
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

export interface EngineOptions {
  createWorker?: () => Worker;
  /** A working worker was dropped, and its model with it. Nothing can be exported until the next generate. */
  onReplaced?: () => void;
}

// The pipeline yields often, but a single native-speed loop can still hold
// the worker for a moment. After this long the worker is replaced instead.
const CANCEL_GRACE_MS = 1500;
// An edit or export waiting this long when a new model is asked for is
// taken as stuck, and the worker is replaced rather than the model queued
// behind it for good.
const STUCK_MS = 10_000;

export class EngineClient {
  private worker: Worker | null = null;
  /** Whether the current worker has sent anything, to tell a failed load from a crash. */
  private heardFrom = false;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private activeGenerate: number | null = null;

  constructor(private readonly options: EngineOptions = {}) {}

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = (this.options.createWorker ?? defaultWorker)();
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      this.heardFrom = true;
      this.receive(event.data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      // Usually the script failed to load, e.g. a tab left open across a deploy.
      const message = this.heardFrom
        ? event.message || 'The generator stopped unexpectedly. Try again.'
        : 'The generator could not start. Reload the page and try again.';
      this.dropWorker();
      this.rejectAll(() => new Error(message));
    };
    this.worker = worker;
    this.heardFrom = false;
    return worker;
  }

  private dropWorker() {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    this.activeGenerate = null;
    if (this.heardFrom) this.options.onReplaced?.();
  }

  private rejectAll(error: (id: number) => Error) {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error(id));
    }
  }

  private receive(message: FromWorker) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    switch (message.type) {
      case 'progress':
        pending.onProgress?.(message.progress);
        return;
      case 'generated':
      case 'exported':
        this.pending.delete(message.id);
        if (message.id === this.activeGenerate) this.activeGenerate = null;
        pending.resolve(message.result as never);
        return;
      case 'edited':
        this.pending.delete(message.id);
        pending.resolve(message.update as never);
        return;
      case 'error':
        this.pending.delete(message.id);
        if (message.id === this.activeGenerate) this.activeGenerate = null;
        pending.reject(message.cancelled ? new CancelledError() : new Error(message.message));
        return;
    }
  }

  private request<T>(message: Pending['message'], onProgress?: (event: ProgressEvent) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(message.id, { message, resolve: resolve as (value: never) => void, reject, onProgress, sentAt: performance.now() });
      try {
        this.ensureWorker().postMessage(message);
      } catch (error) {
        // new Worker() itself can throw, e.g. when a content policy blocks it.
        this.pending.delete(message.id);
        if (this.activeGenerate === message.id) this.activeGenerate = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  generate(request: GenerateRequest, onProgress?: (event: ProgressEvent) => void): Promise<GenerateResult> {
    const now = performance.now();
    const stuck = [...this.pending].filter(([, p]) => p.message.type !== 'generate' && now - p.sentAt > STUCK_MS).map(([id]) => id);
    if (stuck.length) this.replaceWorker(this.activeGenerate !== null ? [...stuck, this.activeGenerate] : stuck);
    else if (this.activeGenerate !== null) this.cancel();
    const id = this.nextId++;
    this.activeGenerate = id;
    return this.request<GenerateResult>({ type: 'generate', id, request }, onProgress);
  }

  export(request: ExportRequest, onProgress?: (event: ProgressEvent) => void): Promise<ExportResult> {
    return this.request<ExportResult>({ type: 'export', id: this.nextId++, request }, onProgress);
  }

  /**
   * Apply edits to the model the worker holds. A newer call before this one
   * is done supersedes it, and it rejects with CancelledError.
   */
  edit(request: EditRequest): Promise<EditUpdate> {
    return this.request<EditUpdate>({ type: 'edit', id: this.nextId++, request });
  }

  /** Cancel the running generation. The promise rejects with CancelledError. */
  cancel(): void {
    if (this.activeGenerate !== null) this.stop(this.activeGenerate);
  }

  /** Cancel a download being made. Its promise rejects with CancelledError. */
  cancelExport(): void {
    for (const [id, pending] of [...this.pending]) if (pending.message.type === 'export') this.stop(id);
  }

  /**
   * Stop edits being applied, for one taking far too long. An update can't
   * stop part way, so the worker is replaced, and the model with it.
   */
  stopEdits(): void {
    const ids = [...this.pending].filter(([, p]) => p.message.type === 'edit').map(([id]) => id);
    if (ids.length) this.replaceWorker(ids);
  }

  /** Asks the worker to stop a request, and replaces the worker when it's still at it after a moment. */
  private stop(id: number): void {
    if (!this.worker) return;
    this.worker.postMessage({ type: 'cancel', id } satisfies ToWorker);
    const worker = this.worker;
    setTimeout(() => {
      if (this.pending.has(id) && this.worker === worker) this.replaceWorker([id]);
    }, CANCEL_GRACE_MS);
  }

  /**
   * Replaces the worker. Downloaded data cached in it is lost, and so is its
   * model, so whatever else was waiting fails. The requests given are
   * cancelled, and so is every generate but the newest, which is sent again
   * to the new worker unless it's one of them.
   */
  private replaceWorker(cancelled: number[]): void {
    const stopped = new Set(cancelled);
    const generates = [...this.pending.values()].filter((p) => p.message.type === 'generate');
    const newest = generates[generates.length - 1];
    const retry = newest && !stopped.has(newest.message.id) ? newest : null;
    this.dropWorker();
    for (const [id, pending] of [...this.pending]) {
      if (pending === retry || (!stopped.has(id) && pending.message.type !== 'generate')) continue;
      this.pending.delete(id);
      pending.reject(new CancelledError());
    }
    if (retry) this.pending.delete(retry.message.id);
    this.rejectAll(() => new Error('The generator was restarted. Generate the model again.'));
    if (retry) {
      this.activeGenerate = retry.message.id;
      this.request(retry.message, retry.onProgress).then(retry.resolve as (value: unknown) => void, retry.reject);
    }
  }
}

function defaultWorker(): Worker {
  return new Worker(new URL('../../worker/engine.worker.ts', import.meta.url), { type: 'module' });
}
