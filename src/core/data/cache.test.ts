import { afterEach, describe, expect, it, vi } from 'vitest';
import { cacheSize, clearCache, memo, persistentCache, planEviction, setCacheLimit } from './cache';

afterEach(() => {
  vi.useRealTimers();
});

describe('persistent cache without IndexedDB', () => {
  it('does nothing and never throws', async () => {
    expect('indexedDB' in globalThis).toBe(false);
    await expect(persistentCache.put('key', new ArrayBuffer(8))).resolves.toBeUndefined();
    await expect(persistentCache.get('key')).resolves.toBeUndefined();
    await expect(cacheSize()).resolves.toBe(0);
    await expect(clearCache()).resolves.toBeUndefined();
    await expect(setCacheLimit(1e6)).resolves.toBeUndefined();
  });
});

describe('planEviction', () => {
  const entries = [
    { key: 'a', size: 40, used: 300 },
    { key: 'b', size: 30, used: 100 },
    { key: 'c', size: 20, used: 200 },
    { key: 'd', size: 10, used: 400 },
  ];

  it('removes the least recently used entries until under the target', () => {
    expect(planEviction(entries, 100)).toEqual([]);
    expect(planEviction(entries, 90)).toEqual(['b']);
    expect(planEviction(entries, 50)).toEqual(['b', 'c']);
    expect(planEviction(entries, 0)).toEqual(['b', 'c', 'a', 'd']);
  });
});

describe('memo', () => {
  it('shares one load between callers until it expires', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => 'value');
    const [a, b] = await Promise.all([memo('shared', 1000, load), memo('shared', 1000, load)]);
    expect([a, b]).toEqual(['value', 'value']);
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(999);
    await memo('shared', 1000, load);
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2);
    await memo('shared', 1000, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('forgets a failed load', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('ok');
    await expect(memo('failing', Infinity, load)).rejects.toThrow('offline');
    await expect(memo('failing', Infinity, load)).resolves.toBe('ok');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('lets one caller give up without cancelling the load', async () => {
    let finish: (value: string) => void = () => undefined;
    const load = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
    const controller = new AbortController();
    const cancelled = memo('slow', Infinity, load, controller.signal);
    const patient = memo('slow', Infinity, load);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    finish('done');
    await expect(patient).resolves.toBe('done');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('forgets everything on clearCache', async () => {
    const load = vi.fn(async () => 1);
    await memo('cleared', Infinity, load);
    await clearCache();
    await memo('cleared', Infinity, load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
