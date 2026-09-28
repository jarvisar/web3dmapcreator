import { EngineClient } from '../../core/engine/client';

let client: EngineClient | null = null;
let spawned = 0;
const replacedListeners = new Set<() => void>();

/** Called when the client replaces a worker that did not stop in time. The new worker has no model. */
export function onWorkerReplaced(listener: () => void): () => void {
  replacedListeners.add(listener);
  return () => replacedListeners.delete(listener);
}

// Created on first use so the worker bundle does not compete with the map
// tiles while the page loads.
export function getEngine(): EngineClient {
  if (!client) {
    client = new EngineClient(() => {
      spawned += 1;
      if (spawned > 1) for (const listener of replacedListeners) listener();
      return new Worker(new URL('../../worker/engine.worker.ts', import.meta.url), { type: 'module' });
    });
  }
  return client;
}
