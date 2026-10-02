import { describe, expect, it } from 'vitest';
import { crsFromEpsg, lonLatTransforms } from './crs';
import { eptDensity, eptPresence, landDensity } from './density';
import type { Fetcher } from './fetcher';

const mercator = lonLatTransforms(crsFromEpsg(3857));
const base = 'https://example.com/survey/';

// A 1024 m cube at the equator, where Web Mercator is metres. The root holds
// half a return per m², and its south-west child (512 m) three more.
// Everything east of it is water.
const files: Record<string, unknown> = {
  [`${base}ept.json`]: { bounds: [0, 0, 0, 1024, 1024, 1024], span: 128, dataType: 'laszip', hierarchyType: 'json', srs: { horizontal: '3857' } },
  [`${base}ept-hierarchy/0-0-0-0.json`]: { '0-0-0-0': 0.5 * 1024 * 1024, '1-0-0-0': -1 },
  [`${base}ept-hierarchy/1-0-0-0.json`]: { '1-0-0-0': 3 * 512 * 512 },
};

function fakeFetcher() {
  const requested: string[] = [];
  const fetcher = {
    async json(url: string) {
      requested.push(url);
      if (!(url in files)) throw new Error(`404 ${url}`);
      return files[url];
    },
  };
  return { fetcher: fetcher as unknown as Fetcher, requested };
}

function box(x0: number, y0: number, x1: number, y1: number) {
  const [west, south] = mercator.toLonLat(x0, y0);
  const [east, north] = mercator.toLonLat(x1, y1);
  return { west, south, east, north };
}

describe('eptDensity', () => {
  it('counts every depth over the box and leaves the water out', async () => {
    const { fetcher, requested } = fakeFetcher();
    // Half land at 3.5 per m², half water at 0.5: the mean over the box would be 2.
    expect(await eptDensity(fetcher, `${base}ept.json`, box(0, 0, 1024, 512))).toBeCloseTo(3.5, 3);
    expect(requested).toHaveLength(3);
    // Only where the outline is.
    const [lonEdge] = mercator.toLonLat(700, 0);
    expect(await eptDensity(fetcher, `${base}ept.json`, box(0, 0, 1024, 512), (lon) => lon > lonEdge)).toBeCloseTo(0.5, 3);
  });

  it("doesn't read pages the box misses", async () => {
    const { fetcher, requested } = fakeFetcher();
    expect(await eptDensity(fetcher, `${base}ept.json`, box(600, 600, 1000, 1000))).toBeCloseTo(0.5, 3);
    expect(requested).toHaveLength(2);
  });
});

describe('landDensity', () => {
  it('averages the columns that are not water or holes', () => {
    expect(landDensity([10, 12, 0.5, 0, 11, 9])).toBeCloseTo(10.5, 6);
    expect(landDensity([0, 0, 0, 0])).toBe(null);
    expect(landDensity([5, 5])).toBe(null);
  });
});

describe('eptPresence', () => {
  // A 256 m cube at the equator, so 32 m columns are nodes three levels down.
  // Points in the west half to that depth, and a leaf two levels down over
  // the north-east quarter that says nothing about where in it they are.
  const presence = 'https://example.com/presence/';
  const pages: Record<string, Record<string, number>> = {
    [`${presence}ept-hierarchy/0-0-0-0.json`]: { '0-0-0-0': 1000, '1-0-0-0': 1000, '1-0-1-0': 1000, '1-1-1-0': 1000, '2-0-0-0': -1 },
    [`${presence}ept-hierarchy/2-0-0-0.json`]: { '2-0-0-0': 10 },
  };
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 8; j++) {

      const node = `3-${i}-${j}-0`;
      pages[`${presence}ept-hierarchy/0-0-0-0.json`][`2-${i >> 1}-${j >> 1}-0`] ??= 100;
      pages[`${presence}ept-hierarchy/0-0-0-0.json`][node] = 10;

    }
  }
  const fetcher = {
    async json(url: string) {
      if (url === `${presence}ept.json`) return { bounds: [0, 0, 0, 256, 256, 256], span: 128, dataType: 'laszip', hierarchyType: 'json', srs: { horizontal: '3857' } };
      if (!(url in pages)) throw new Error(`404 ${url}`);
      return pages[url];
    },
  } as unknown as Fetcher;

  it('counts the columns with points, and a leaf above them for all it covers', async () => {
    // The west half (16 of 64 columns are the north-east leaf).
    expect(await eptPresence(fetcher, `${presence}ept.json`, box(0, 0, 256, 256))).toBeCloseTo(0.75, 6);
    expect(await eptPresence(fetcher, `${presence}ept.json`, box(0, 0, 128, 128))).toBe(1);
    // The south-east quarter has nothing.
    expect(await eptPresence(fetcher, `${presence}ept.json`, box(160, 0, 256, 96))).toBe(0);
  });
});
