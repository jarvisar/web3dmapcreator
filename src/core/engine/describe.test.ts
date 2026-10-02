import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCorsProxy } from '../data/corsProxy';
import { fetchBytes, fetchRange, NetworkError } from '../data/http';
import { describeError } from './describe';

const MAP_SERVER = 'Could not reach the map data server. Check your connection and try again.';
const proxied = 'https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/OH_X/LAZ/tile.laz';

afterEach(() => {
  setCorsProxy(null);
  vi.unstubAllGlobals();
});

async function failed(download: () => Promise<unknown>): Promise<unknown> {
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('Failed to fetch');
  });
  return download().then(
    () => null,
    (error: unknown) => error,
  );
}

describe('describeError', () => {
  it('says the map data server for a failed map or elevation download', async () => {
    const error = await failed(() => fetchBytes('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/1/1.png', undefined, { store: null, retries: 0 }));
    expect(error).toBeInstanceOf(NetworkError);
    expect(describeError(error)).toBe(MAP_SERVER);
    expect(describeError(new TypeError('Failed to fetch'))).toBe(MAP_SERVER);
    expect(describeError(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(MAP_SERVER);
    expect(describeError(new TypeError('Load failed'))).toBe(MAP_SERVER);
  });

  it("keeps a LiDAR message that quotes a network error, so it names the survey and the proxy's limit", async () => {
    setCorsProxy('https://proxy.example.workers.dev');
    const reason = ((await failed(() => fetchRange(proxied, 0, 100, undefined, { store: null, retries: 0 }))) as Error).message;
    expect(reason).toMatch(/LiDAR proxy, which may be over its daily limit/);
    // As dsm/prepare.ts throws when no block got any points.
    const wrapped = new Error(`The LiDAR surveys returned no points for this area (USGS 3DEP: ${reason}).`);
    expect(describeError(wrapped)).toBe(wrapped.message);
  });

  it('keeps the message of a failed download through the LiDAR proxy', async () => {
    setCorsProxy('https://proxy.example.workers.dev');
    const error = (await failed(() => fetchBytes(proxied, undefined, { store: null, retries: 0 }))) as Error;
    expect(describeError(error)).toBe(error.message);
    expect(describeError(error)).toMatch(/daily limit/);
  });

  it('leaves other errors alone', () => {
    expect(describeError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe("Cannot read properties of undefined (reading 'x')");
    expect(describeError(new RangeError('Array buffer allocation failed'))).toMatch(/ran out of memory/);
    expect(describeError('plain')).toBe('plain');
  });
});
