// AIST 3DDB against canned API answers: which records become surveys, and
// Tokyo's tiles going back to T.P. heights.

import { describe, expect, it } from 'vitest';
import type { GeoBounds } from '../../types';
import type { Fetcher } from '../read/fetcher';
import { aist3ddb } from './aist3ddb';

/** A LAS header whose lowest height is `minZ`. */
function header(minZ: number): Uint8Array {
  const bytes = new Uint8Array(375);
  bytes.set([0x4c, 0x41, 0x53, 0x46]);
  const view = new DataView(bytes.buffer);
  bytes[24] = 1;
  bytes[25] = 4;
  view.setUint16(94, 375, true);
  view.setUint32(96, 375, true);
  bytes[104] = 6;
  view.setUint16(105, 30, true);
  for (const at of [131, 139, 147]) view.setFloat64(at, 0.001, true);
  view.setFloat64(211, minZ + 50, true);
  view.setFloat64(219, minZ, true);
  return bytes;
}

const record = (id: number, group: string, minz: number, links = ['copc']) => ({
  type: 'GeometryCollection',
  geometries: [{ type: 'Polygon', coordinates: [[[139.762, 35.68], [139.768, 35.68], [139.768, 35.685], [139.762, 35.685], [139.762, 35.68]]], properties: { minz, maxz: minz + 50 } }],
  properties: { reg_id: id, group, external_links: links.map((type) => ({ external_link: `https://gsrt.digiarc.aist.go.jp/3ddb-pds/copc/${id}.copc.laz`, external_link_type: type })) },
});

function fakeFetcher(features: object[]) {
  const requested: string[] = [];
  const fetcher = {
    json: async (url: string) => {
      requested.push(url);
      return { type: 'FeatureCollection', properties: { all: features.length }, features };
    },
    range: async (url: string) => {
      requested.push(url);
      return header(url.endsWith('/113119.copc.laz') ? 17.614 : 0).buffer;
    },
  };
  return { fetcher: fetcher as unknown as Fetcher, requested };
}

describe('AIST 3DDB', () => {
  const station: GeoBounds = { west: 139.764, south: 35.681, east: 139.766, north: 35.683 };

  it("moves Tokyo's tiles back by the API's original lowest height", async () => {
    const { fetcher, requested } = fakeFetcher([record(113119, '92', -19.083), record(1792, '1000001', 0, []), record(135784, '125', 0)]);
    const surveys = await aist3ddb.discover(fetcher, station, []);
    expect(surveys.map((s) => [s.id, s.format])).toEqual([['tokyo-23ku-2023', 'COPC']]);
    const [tile] = surveys[0].tiles!;
    // The new host, not the old one that redirects without CORS.
    expect(tile.url).toBe('https://gsvrg.ipri.aist.go.jp/3ddb-pds/copc/113119.copc.laz');
    expect(tile.zOffset).toBeCloseTo(-19.083 - 17.614, 6);
    expect(requested[0]).toContain('POLYGON');
  });

  it('leaves Hyogo and Nagasaki on their own heights, without reading headers', async () => {
    const { fetcher, requested } = fakeFetcher([record(78452, '80', 54.1), record(108192, '86', 33)]);
    const surveys = await aist3ddb.discover(fetcher, station, []);
    expect(surveys.map((s) => s.id)).toEqual(['open-nagasaki', 'hyogo']);
    expect(surveys.every((s) => s.tiles!.every((t) => t.zOffset === undefined))).toBe(true);
    expect(requested).toHaveLength(1);
  });

  it("drops a Tokyo tile whose original height isn't given", async () => {
    const { fetcher } = fakeFetcher([record(113119, '92', Number.NaN)]);
    expect(await aist3ddb.discover(fetcher, station, [])).toEqual([]);
  });
});
