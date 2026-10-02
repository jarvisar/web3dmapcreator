import { EngineClient } from '../../core/engine/client';

let client: EngineClient | null = null;
const replacedListeners = new Set<() => void>();

/** Called when the worker was replaced after a crash or a cancel that took too long. The new worker has no model. */
export function onWorkerReplaced(listener: () => void): () => void {
  replacedListeners.add(listener);
  return () => replacedListeners.delete(listener);
}

const outdatedListeners = new Set<() => void>();

/** Called when a worker script didn't load because a deploy replaced it, which a reload fixes. */
export function onAppOutdated(listener: () => void): () => void {
  outdatedListeners.add(listener);
  return () => outdatedListeners.delete(listener);
}

// Created on first use so the worker bundle does not compete with the map
// tiles while the page loads.
export function getEngine(): EngineClient {
  client ??= new EngineClient({
    onReplaced: () => {
      for (const listener of replacedListeners) listener();
    },
    onOutdated: () => {
      for (const listener of outdatedListeners) listener();
    },
  });
  return client;
}
