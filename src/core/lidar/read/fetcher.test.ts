import { afterEach, describe, expect, it } from 'vitest';
import { ahead } from './fetcher';

describe('ahead', () => {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  afterEach(() => {
    process.off('unhandledRejection', listener);
    unhandled.length = 0;
  });

  it('keeps order, and a later failure waits for its turn', async () => {
    process.on('unhandledRejection', listener);
    const task = (item: number) =>
      item === 1 ? Promise.reject(new Error('item 1 failed')) : new Promise<number>((resolve) => setTimeout(() => resolve(item), 50));
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const value of ahead([0, 1, 2], 3, task)) seen.push(value);
      })(),
    ).rejects.toThrow('item 1 failed');
    expect(seen).toEqual([0]);
    // Item 1 failed while item 0 was still being awaited.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(unhandled).toEqual([]);
  });
});
