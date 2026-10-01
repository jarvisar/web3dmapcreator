// EPT and COPC reading end to end, against small synthetic LAS 1.4 files
// served by a fake fetcher. The fake decoder hands back the uncompressed
// records, so this covers everything around decompression: hierarchy walks,
// range reads, CRS and Z units, cropping, classes and capture years.

import { describe, expect, it } from 'vitest';
import { Projection } from '../../geo/projection';
import type { GeoBounds } from '../../types';
import { crsFromEpsg, lonLatTransforms } from './crs';
import { readTiles } from './tiles';
import { BudgetExceeded, readEpt } from './ept';
import type { Fetcher } from './fetcher';
import { readHeader, type Vlr } from './las';
import { setLazDecoder } from './laz';

const POINT_SIZE = 30;
// 2021-06-01 as adjusted standard GPS time (GPS seconds less 1e9, 18 leap seconds).
const GPS_2021 = (Date.UTC(2021, 5, 1) - Date.UTC(1980, 0, 6)) / 1000 + 18 - 1e9;

interface Pt {
  x: number;
  y: number;
  z: number;
  cls: number;
  returns?: number;
  withheld?: boolean;
  overlap?: boolean;
}

function ascii(target: Uint8Array, at: number, text: string) {
  for (let i = 0; i < text.length; i++) target[at + i] = text.charCodeAt(i);
}

/** An uncompressed point format 6 LAS 1.4 file with adjusted GPS time. */
function las(points: Pt[], vlrs: Vlr[] = []): Uint8Array {
  const vlrBytes = vlrs.reduce((s, v) => s + 54 + v.data.length, 0);
  const pointsAt = 375 + vlrBytes;
  const bytes = new Uint8Array(pointsAt + points.length * POINT_SIZE);
  const view = new DataView(bytes.buffer);
  ascii(bytes, 0, 'LASF');
  view.setUint16(6, 1, true);
  bytes[24] = 1;
  bytes[25] = 4;
  view.setUint16(94, 375, true);
  view.setUint32(96, pointsAt, true);
  view.setUint32(100, vlrs.length, true);
  bytes[104] = 6;
  view.setUint16(105, POINT_SIZE, true);
  const scale = [0.01, 0.01, 0.01];
  const offset = [0, 5621000, 0];
  for (let k = 0; k < 3; k++) {
    view.setFloat64(131 + 8 * k, scale[k], true);
    view.setFloat64(155 + 8 * k, offset[k], true);
  }
  view.setBigUint64(247, BigInt(points.length), true);
  let at = 375;
  for (const vlr of vlrs) {
    ascii(bytes, at + 2, vlr.userId);
    view.setUint16(at + 18, vlr.recordId, true);
    view.setUint16(at + 20, vlr.data.length, true);
    bytes.set(vlr.data, at + 54);
    at += 54 + vlr.data.length;
  }
  points.forEach((p, i) => {
    const o = pointsAt + i * POINT_SIZE;
    view.setInt32(o, Math.round((p.x - offset[0]) / scale[0]), true);
    view.setInt32(o + 4, Math.round((p.y - offset[1]) / scale[1]), true);
    view.setInt32(o + 8, Math.round((p.z - offset[2]) / scale[2]), true);
    const returns = p.returns ?? 1;
    bytes[o + 14] = 1 | (returns << 4);
    bytes[o + 15] = (p.withheld ? 4 : 0) | (p.overlap ? 8 : 0);
    bytes[o + 16] = p.cls;
    view.setFloat64(o + 22, GPS_2021, true);
  });
  return bytes;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Serves fixed files. Range reads past the end fail, as they do over HTTP. */
function fakeFetcher(files: Record<string, Uint8Array | object>) {
  const requested: string[] = [];
  const file = (url: string) => {
    const body = files[url];
    if (!body) throw new Error(`404 ${url}`);
    return body;
  };
  const fetcher = {
    downloaded: 0,
    async json(url: string) {
      requested.push(url);
      return file(url);
    },
    async bytes(url: string) {
      requested.push(url);
      return (file(url) as Uint8Array).slice().buffer;
    },
    async range(url: string, start: number, end: number) {
      requested.push(`${url}#${start}-${end}`);
      const body = file(url) as Uint8Array;
      if (end > body.length) throw new Error(`Range ${start}-${end} past the end of ${url} (${body.length} bytes)`);
      return body.slice(start, end).buffer;
    },
  };
  return { fetcher: fetcher as unknown as Fetcher, requested };
}

// Records pass through unchanged: the files are not compressed.
setLazDecoder({
  decodeFile(bytes) {
    const header = readHeader(bytes);
    const start = header.pointDataOffset;
    return { records: bytes.subarray(start, start + header.pointCount * header.pointSize), pointCount: header.pointCount, pointSize: header.pointSize };
  },
  chunkDecoder: () => ({ decode: (chunk) => chunk, free: () => undefined }),
});

const mercator = lonLatTransforms(crsFromEpsg(3857));
// Query box in web Mercator: x 50-200, y 5621050-5621200.
function bboxOf(x0: number, y0: number, x1: number, y1: number): GeoBounds {
  const [west, south] = mercator.toLonLat(x0, y0);
  const [east, north] = mercator.toLonLat(x1, y1);
  return { west, south, east, north };
}
const bbox = bboxOf(50, 5621050, 200, 5621200);
const frame = new Projection([(bbox.west + bbox.east) / 2, (bbox.south + bbox.north) / 2], 0, 1);

describe('EPT reading', () => {
  const base = 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/TEST/';
  const meta = { bounds: [0, 5621000, -500, 1024, 5622024, 524], span: 256, dataType: 'laszip', hierarchyType: 'json', srs: { horizontal: '3857' } };

  function survey() {
    return {
      [`${base}ept.json`]: meta,
      [`${base}ept-hierarchy/0-0-0-0.json`]: { '0-0-0-0': 3, '1-0-0-0': -1, '1-1-1-0': 2, '1-0-0-1': 2 },
      [`${base}ept-hierarchy/1-0-0-0.json`]: { '1-0-0-0': 2, '2-0-0-0': 1, '2-1-1-0': 1, '3-0-0-0': 1 },
      [`${base}ept-data/0-0-0-0.laz`]: las([
        { x: 100, y: 5621100, z: 50, cls: 2 },
        { x: 600, y: 5621600, z: 50, cls: 2 },
        { x: 150, y: 5621150, z: 70, cls: 7 },
      ]),
      [`${base}ept-data/1-0-0-0.laz`]: las([
        { x: 120, y: 5621120, z: 80, cls: 6 },
        { x: 130, y: 5621130, z: 80, cls: 6, withheld: true },
      ]),
      [`${base}ept-data/1-0-0-1.laz`]: las([
        { x: 140, y: 5621140, z: 90, cls: 6, overlap: true },
        { x: 160, y: 5621160, z: 60, cls: 5, returns: 2 },
      ]),
      [`${base}ept-data/2-0-0-0.laz`]: las([{ x: 180, y: 5621180, z: 55, cls: 1 }]),
    };
  }

  it('reads intersecting nodes down to the resolution and crops their returns', async () => {
    const { fetcher, requested } = fakeFetcher(survey());
    const { points, info } = await readEpt(fetcher, `${base}ept.json`, bbox, { frame, resolutionM: 1 });
    // Depth 3 is finer than 1 m needs; 1-1-1-0 and 2-1-1-0 lie outside the query.
    expect(requested.filter((u) => u.endsWith('.laz')).map((u) => u.slice(u.lastIndexOf('/') + 1))).toEqual(['0-0-0-0.laz', '1-0-0-0.laz', '1-0-0-1.laz', '2-0-0-0.laz']);
    expect(info.nodes).toBe(4);
    expect(info.horizontalCrs).toBe('EPSG:3857');
    // Outside, noise, withheld and overlap returns are dropped.
    expect(points.count).toBe(4);
    expect([...points.z]).toEqual([50, 80, 60, 55]);
    expect([...points.cls]).toEqual([2, 6, 5, 1]);
    expect([...points.single]).toEqual([1, 1, 0, 1]);
    expect([...points.year]).toEqual([2021, 2021, 2021, 2021]);
    expect([...points.confidence]).toEqual([1, 1, 1, 1]);
    // 80 web Mercator metres each way near 45 degrees north are about 56.6
    // real metres. The frame is ellipsoidal and 3857 spherical, so north and
    // east differ by 0.3%.
    const real = 80 * Math.cos((((bbox.south + bbox.north) / 2) * Math.PI) / 180);
    expect(points.x[3] - points.x[0]).toBeCloseTo(real, 0);
    expect(points.y[3] - points.y[0]).toBeCloseTo(real, 0);
  });

  it('stops at the point budget', async () => {
    const { fetcher } = fakeFetcher(survey());
    await expect(readEpt(fetcher, `${base}ept.json`, bbox, { frame, resolutionM: 1, maxPoints: 2 })).rejects.toBeInstanceOf(BudgetExceeded);
  });

  it('refuses an undeclared Z unit off the USGS mirror where feet are possible', async () => {
    const other = 'https://example.com/survey/';
    const files: Record<string, object> = {};
    for (const [url, body] of Object.entries(survey())) files[url.replace(base, other)] = body;
    // Moved to Texas, where height systems in feet exist.
    const [x0, y0] = mercator.fromLonLat(-97.8, 30.2);
    files[`${other}ept.json`] = { ...meta, bounds: [x0, y0, -500, x0 + 1024, y0 + 1024, 524] };
    const { fetcher } = fakeFetcher(files);
    await expect(readEpt(fetcher, `${other}ept.json`, bboxOf(x0 + 50, y0 + 50, x0 + 200, y0 + 200), { frame })).rejects.toThrow(/vertical units/);
  });
});

describe('COPC reading', () => {
  const url = 'https://example.com/tiles/a.copc.laz';

  // GeoTIFF keys: web Mercator, Z in feet.
  function geoKeys(): Uint8Array {
    const keys = [
      [3072, 0, 1, 3857],
      [4099, 0, 1, 9002],
    ];
    const data = new Uint8Array(8 + 8 * keys.length);
    const view = new DataView(data.buffer);
    view.setUint16(0, 1, true);
    view.setUint16(2, 1, true);
    view.setUint16(6, keys.length, true);
    keys.forEach((key, k) => key.forEach((v, j) => view.setUint16(8 + 8 * k + 2 * j, v, true)));
    return data;
  }

  function hierarchyPage(entries: [number, number, number, number, number, number, number][]): Uint8Array {
    const page = new Uint8Array(32 * entries.length);
    const view = new DataView(page.buffer);
    entries.forEach(([d, x, y, z, offset, byteSize, count], k) => {
      [d, x, y, z].forEach((v, j) => view.setInt32(32 * k + 4 * j, v, true));
      view.setBigUint64(32 * k + 16, BigInt(offset), true);
      view.setInt32(32 * k + 24, byteSize, true);
      view.setInt32(32 * k + 28, count, true);
    });
    return page;
  }

  function tile() {
    // Z in feet.
    const chunks: Pt[][] = [
      [
        { x: 100, y: 5621100, z: 100, cls: 2 },
        { x: 900, y: 5621900, z: 100, cls: 2 },
      ],
      [{ x: 120, y: 5621120, z: 200, cls: 6 }],
      [{ x: 700, y: 5621700, z: 200, cls: 6 }],
    ];
    const info = new Uint8Array(160);
    const infoView = new DataView(info.buffer);
    const vlrs = [
      { userId: 'copc', recordId: 1, data: info },
      { userId: 'laszip encoded', recordId: 22204, data: new Uint8Array(52) },
      { userId: 'LASF_Projection', recordId: 34735, data: geoKeys() },
    ];
    const headLength = las([], vlrs).length;
    const records = chunks.map((c) => las(c).subarray(375));
    const offsets: number[] = [];
    let at = headLength;
    for (const r of records) {
      offsets.push(at);
      at += r.length;
    }
    // The root page lists the root node and points at a child page for 1-0-0-0; 1-1-1-0 is outside the query.
    const childAt = at;
    const child = hierarchyPage([[1, 0, 0, 0, offsets[1], records[1].length, 1]]);
    const rootAt = childAt + child.length;
    const root = hierarchyPage([
      [0, 0, 0, 0, offsets[0], records[0].length, 2],
      [1, 0, 0, 0, childAt, child.length, -1],
      [1, 1, 1, 0, offsets[2], records[2].length, 1],
    ]);
    [512, 5621512, 0].forEach((v, k) => infoView.setFloat64(8 * k, v, true));
    infoView.setFloat64(24, 512, true);
    infoView.setFloat64(32, 4, true);
    infoView.setBigUint64(40, BigInt(rootAt), true);
    infoView.setBigUint64(48, BigInt(root.length), true);
    const bytes = concat([las([], vlrs), ...records, child, root]);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(247, BigInt(chunks.flat().length), true);
    return { bytes, badNode: `${url}#${offsets[2]}-${offsets[2] + records[2].length}` };
  }

  it('reads only the header records, the pages and nodes it needs, with Z from the header keys', async () => {
    const { bytes, badNode } = tile();
    const { fetcher, requested } = fakeFetcher({ [url]: bytes });
    const { points, info } = await readTiles(fetcher, [{ url, bbox: [0, 44.9, 0.01, 45.1] }], bbox, { frame, resolutionM: 1 });
    expect(requested).not.toContain(badNode);
    expect(requested.every((r) => r.includes('#'))).toBe(true);
    expect(info.tiles).toBe(1);
    expect(info.nodes).toBe(2);
    expect(info.zToMetres).toBeCloseTo(0.3048, 12);
    expect(points.count).toBe(2);
    expect(points.z[0]).toBeCloseTo(30.48, 9);
    expect(points.z[1]).toBeCloseTo(60.96, 9);
    expect([...points.cls]).toEqual([2, 6]);
  });

  it('skips tiles that do not reach the area', async () => {
    const { fetcher, requested } = fakeFetcher({});
    const { points, info } = await readTiles(fetcher, [{ url, bbox: [5, 5, 6, 6] }], bbox, { frame });
    expect(points.count).toBe(0);
    expect(info.tiles).toBe(0);
    expect(requested).toEqual([]);
  });

  it('opens a tile smaller than a fixed first read', async () => {
    const { bytes } = tile();
    expect(bytes.length).toBeLessThan(65536);
    const { fetcher, requested } = fakeFetcher({ [url]: bytes });
    await readTiles(fetcher, [{ url, bbox: [0, 44.9, 0.01, 45.1] }], bbox, { frame, resolutionM: 1 });
    expect(requested[0]).toBe(`${url}#0-375`);
  });
});
