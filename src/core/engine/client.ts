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
      this.pending.set(message.id, { message, resolve: resolve as (value: never) => void, reject, onProgress });
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
    if (this.activeGenerate !== null) this.cancel();
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
    const id = this.activeGenerate;
    if (id === null || !this.worker) return;
    this.worker.postMessage({ type: 'cancel', id } satisfies ToWorker);
    const worker = this.worker;
    setTimeout(() => {
      if (!this.pending.has(id) || this.worker !== worker) return;
      // Still busy: replace the worker. Downloaded data cached in it is lost,
      // and so is its model, so pending exports fail. Each generate cancels
      // the one before, so only the newest is sent again to the new worker.
      const generates = [...this.pending.values()].filter((p) => p.message.type === 'generate');
      const retry = generates.length && generates[generates.length - 1].message.id !== id ? generates[generates.length - 1] : null;
      this.dropWorker();
      for (const pending of generates) {
        if (pending === retry) continue;
        this.pending.delete(pending.message.id);
        pending.reject(new CancelledError());
      }
      if (retry) this.pending.delete(retry.message.id);
      this.rejectAll(() => new Error('The generator was restarted. Generate the model again.'));
      if (retry) {
        this.activeGenerate = retry.message.id;
        this.request(retry.message, retry.onProgress).then(retry.resolve as (value: unknown) => void, retry.reject);
      }
    }, CANCEL_GRACE_MS);
  }
}

function defaultWorker(): Worker {
  return new Worker(new URL('../../worker/engine.worker.ts', import.meta.url), { type: 'module' });
}
