import { afterEach, describe, expect, it, vi } from 'vitest';
import { download } from '../download';
import { fontFingerprint } from './fonts';
import { FontLoader } from './loadFont';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fonts', () => {
  it('tell loaded files apart by their contents', () => {
    const a = new Uint8Array([1, 2, 3, 4]).buffer;
    const b = new Uint8Array([1, 2, 3, 5]).buffer;
    expect(fontFingerprint(a)).not.toBe(fontFingerprint(b));
    expect(fontFingerprint(a)).toBe(fontFingerprint(new Uint8Array([1, 2, 3, 4]).buffer));
  });

  it('give up on a font that never arrives, and ask for it again next time', async () => {
    vi.useFakeTimers();
    let requests = 0;
    // Never answers, but lets go when aborted like a real fetch.
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      requests++;
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    });
    // As the SVG worker loads its assets.
    const fonts = new FontLoader(async (path) => {
      const { bytes } = await download(new URL(path, 'https://app.test/').href, 30_000);
      if (!bytes) throw new Error('missing');
      return bytes;
    });
    const first = expect(fonts.load('montserrat', null)).rejects.toThrow(/No data from/);
    await vi.advanceTimersByTimeAsync(30_000);
    await first;
    const second = expect(fonts.load('montserrat', null)).rejects.toThrow(/No data from/);
    await vi.advanceTimersByTimeAsync(30_000);
    await second;
    expect(requests).toBe(2);
  });
});
