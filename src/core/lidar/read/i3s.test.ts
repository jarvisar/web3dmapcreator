// I3S point cloud scene layers: LEPCC positions from a real Northern Ireland
// leaf node, and the reader walking a small layer built around it.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Projection } from '../../geo/projection';
import type { GeoBounds } from '../../types';
import type { Fetcher } from './fetcher';
import { readI3s, sceneOutline } from './i3s';
import { decodeLepccXyz } from './lepcc';

// Node 128018 of the 2021 NI coastal survey's layer, in EPSG:3857.
const leaf = new Uint8Array(readFileSync(new URL('../testdata/i3s-ni-leaf.lepcc', import.meta.url)));

describe('LEPCC', () => {
  it('decodes positions and checks the blob', () => {
    const points = decodeLepccXyz(leaf);
    expect(points.count).toBe(1412);
    expect(points.maxError).toEqual([0.01, 0.01, 0.01]);
    const xs = Array.from({ length: points.count }, (_, i) => points.xyz[3 * i]);
    const zs = Array.from({ length: points.count }, (_, i) => points.xyz[3 * i + 2]);
    expect(Math.min(...xs)).toBeCloseTo(-805854.56, 1);
    expect(Math.max(...xs)).toBeCloseTo(-805824.02, 1);
    expect(Math.min(...zs)).toBeCloseTo(-1.25, 1);
    expect(Math.max(...zs)).toBeCloseTo(-0.95, 1);
    const broken = leaf.slice();
    broken[200] ^= 0xff;
    expect(() => decodeLepccXyz(broken)).toThrow(/checksum/);
    expect(() => decodeLepccXyz(new TextEncoder().encode('{"error":{}}'))).toThrow(/Not a LEPCC/);
  });
});

describe('scene layer reader', () => {
  const layerUrl = 'https://tiles.example.com/SceneServer/layers/0';
  const obb = { center: [-805839.3, 7372079.3, -1.08], halfSize: [15.3, 15.3, 1.9], quaternion: [0, 0, 0, 1] };
  const layer = {
    layerType: 'PointCloud',
    spatialReference: { wkid: 102100, latestWkid: 3857 },
    store: { index: { nodesPerPage: 64 }, defaultGeometrySchema: { encoding: 'lepcc-xyz' } },
    attributeStorageInfo: [
      { key: '8', name: 'CLASS_CODE' },
      { key: '32', name: 'RETURNS' },
    ],
    elevationInfo: { unit: 'meter' },
  };
  const page = { nodes: [{ resourceId: 0, obb: { ...obb, halfSize: [400, 400, 10] }, firstChild: 1, childCount: 1, vertexCount: 0 }, { resourceId: 128018, obb, firstChild: 0, childCount: 0, vertexCount: 1412 }] };
  // Half ground, half buildings; every other return the only one.
  const classes = Uint8Array.from({ length: 1412 }, (_, i) => (i % 2 ? 6 : 2));
  const returns = Uint8Array.from({ length: 1412 }, (_, i) => (i % 2 ? 0x11 : 0x21));

  function fakeFetcher(overrides: Record<string, Uint8Array> = {}) {
    const requested: string[] = [];
    const fetcher = {
      json: async (url: string) => {
        requested.push(url);
        if (url === layerUrl) return layer;
        if (url === `${layerUrl}/nodepages/0`) return page;
        throw new Error(`404 ${url}`);
      },
      bytes: async (url: string) => {
        requested.push(url);
        const body = overrides[url] ?? (url.endsWith('/geometries/0') ? leaf : url.endsWith('/attributes/8') ? classes : url.endsWith('/attributes/32') ? returns : null);
        if (!body) throw new Error(`404 ${url}`);
        return body.slice().buffer;
      },
    };
    return { fetcher: fetcher as unknown as Fetcher, requested };
  }

  // Covers the middle of the leaf from west to east, all of it north to south.
  const around: GeoBounds = { west: -7.2391, south: 55.0524, east: -7.2389, north: 55.0528 };
  const frame = new Projection([-7.239, 55.0526], 0, 1);

  it('walks to the nodes under the area and keeps their classes and returns', async () => {
    const { fetcher, requested } = fakeFetcher();
    const { points, info } = await readI3s(fetcher, layerUrl, around, { frame });
    expect(info.nodes).toBe(1);
    expect(points.count).toBeGreaterThan(100);
    expect(points.count).toBeLessThan(1412);
    const kept = Array.from(points.cls.subarray(0, points.count));
    expect(new Set(kept)).toEqual(new Set([2, 6]));
    for (let i = 0; i < points.count; i++) expect(points.single[i]).toBe(points.cls[i] === 6 ? 1 : 0);
    expect(requested).toContain(`${layerUrl}/nodes/128018/attributes/8`);
  });

  it("takes a JSON answer to a node resource as the server's error", async () => {
    const { fetcher } = fakeFetcher({ [`${layerUrl}/nodes/128018/attributes/8`]: new TextEncoder().encode('{"error":{"code":404,"message":"Resource not found"}}') });
    await expect(readI3s(fetcher, layerUrl, around, { frame })).rejects.toThrow(/Resource not found/);
  });

  it('outlines where the layer has points from its small nodes', async () => {
    const { fetcher } = fakeFetcher();
    const boxes = await sceneOutline(fetcher, layerUrl, around);
    expect(boxes).toHaveLength(1);
    const [w, s, e, n] = boxes[0];
    expect(w).toBeCloseTo(-7.2391, 3);
    expect(e).toBeCloseTo(-7.2388, 3);
    expect(s).toBeLessThan(55.0526);
    expect(n).toBeGreaterThan(55.0526);
  });
});
