import { describe, expect, it } from 'vitest';
import { crsFromEpsg, lonLatTransforms } from './crs';
import { eptDensity, landDensity } from './density';
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
