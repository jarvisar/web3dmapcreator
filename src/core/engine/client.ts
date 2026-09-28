// Main-thread side of the generation worker.

import type {
  ExportRequest,
  ExportResult,
  FromWorker,
  GenerateRequest,
  GenerateResult,
  ProgressEvent,
  ToWorker,
} from './protocol';

interface Pending {
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

// The pipeline yields often, but a single native-speed loop can still hold
// the worker for a moment. After this long the worker is replaced instead.
const CANCEL_GRACE_MS = 1500;

export class EngineClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private activeGenerate: number | null = null;

  constructor(private readonly createWorker: () => Worker = defaultWorker) {
    this.worker = this.spawn();
  }

  private spawn(): Worker {
    const worker = this.createWorker();
    worker.onmessage = (event: MessageEvent<FromWorker>) => this.receive(event.data);
    worker.onerror = (event) => {
      const error = new Error(event.message || 'The generator stopped unexpectedly');
      for (const [id, pending] of this.pending) {
        pending.reject(error);
        this.pending.delete(id);
      }
      this.activeGenerate = null;
    };
    return worker;
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
      case 'error':
        this.pending.delete(message.id);
        if (message.id === this.activeGenerate) this.activeGenerate = null;
        pending.reject(message.cancelled ? new CancelledError() : new Error(message.message));
        return;
    }
  }

  private send(message: ToWorker) {
    this.worker.postMessage(message);
  }

  generate(request: GenerateRequest, onProgress?: (event: ProgressEvent) => void): Promise<GenerateResult> {
    if (this.activeGenerate !== null) this.cancel();
    const id = this.nextId++;
    this.activeGenerate = id;
    return new Promise<GenerateResult>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: never) => void, reject, onProgress });
      this.send({ type: 'generate', id, request });
    });
  }

  export(request: ExportRequest, onProgress?: (event: ProgressEvent) => void): Promise<ExportResult> {
    const id = this.nextId++;
    return new Promise<ExportResult>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: never) => void, reject, onProgress });
      this.send({ type: 'export', id, request });
    });
  }

  get busy(): boolean {
    return this.activeGenerate !== null;
  }

  /** Cancel the running generation. Resolves once the worker is free again. */
  cancel(): void {
    const id = this.activeGenerate;
    if (id === null) return;
    this.send({ type: 'cancel', id });
    setTimeout(() => {
      if (!this.pending.has(id)) return;
      // Still busy: replace the worker. Downloaded data cached in it is lost.
      this.worker.terminate();
      for (const [pendingId, pending] of this.pending) {
        pending.reject(new CancelledError());
        this.pending.delete(pendingId);
      }
      this.activeGenerate = null;
      this.worker = this.spawn();
    }, CANCEL_GRACE_MS);
  }

  dispose() {
    this.worker.terminate();
    this.pending.clear();
  }
}

function defaultWorker(): Worker {
  return new Worker(new URL('../../worker/engine.worker.ts', import.meta.url), { type: 'module' });
}
