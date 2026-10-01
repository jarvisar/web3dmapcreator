// Plain LAS and LAZ tiles, against small synthetic files served by a fake
// fetcher. The chunk table's arithmetic coding is tested on real tables in
// chunks.test.ts, so here it's swapped for JSON, and the fake decoder hands
// back records as they are.

import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { Projection } from '../../geo/projection';
import type { GeoBounds } from '../../types';
import type { LazChunk } from './chunks';
import { crsFromEpsg, lonLatTransforms } from './crs';
import type { Fetcher } from './fetcher';
import { setLazDecoder } from './laz';
import { checkTile, readTiles, tileDensity } from './tiles';

vi.mock('./chunks', async (original) => ({
  ...(await original<typeof import('./chunks')>()),
  decodeChunkTable: (head: Uint8Array, body: Uint8Array): LazChunk[] => {
    expect(new DataView(head.buffer, head.byteOffset).getUint32(0, true)).toBe(0);
    // Whatever follows the table (EVLRs, the end pointer) is read too, as in a real file.
    const text = new TextDecoder().decode(body);
    return JSON.parse(text.slice(0, text.lastIndexOf(']') + 1)) as LazChunk[];
  },
}));

setLazDecoder({
  decodeFile: () => {
    throw new Error('not used');
  },
  chunkDecoder: () => ({ decode: (chunk) => chunk, free: () => undefined }),
});

const SIZE = 30;
const mercator = lonLatTransforms(crsFromEpsg(3857));

interface Pt {
  x: number;
  y: number;
  z: number;
  cls: number;
}

function geoKeys(): Uint8Array {
  const keys = [[3072, 0, 1, 3857]];
  const data = new Uint8Array(8 + 8 * keys.length);
  const view = new DataView(data.buffer);
  view.setUint16(0, 1, true);
  view.setUint16(6, keys.length, true);
  keys.forEach((key, k) => key.forEach((v, j) => view.setUint16(8 + 8 * k + 2 * j, v, true)));
  return data;
}

/**
 * A LAS 1.4 point format 6 tile in web Mercator. With `chunks`, it's laid
 * out as a LAZ file: the compression bit, a laszip record, the chunk table
 * offset where the points start and a (JSON) table after them.
 */
function tile(points: Pt[], chunks?: number, tableAtEnd = false): Uint8Array {
  const vlrs: { userId: string; recordId: number; data: Uint8Array }[] = [{ userId: 'LASF_Projection', recordId: 34735, data: geoKeys() }];
  if (chunks) {
    const laszip = new Uint8Array(34);
    new DataView(laszip.buffer).setUint32(12, chunks, true);
    vlrs.push({ userId: 'laszip encoded', recordId: 22204, data: laszip });
  }
  const pointsAt = 375 + vlrs.reduce((s, v) => s + 54 + v.data.length, 0);
  const first = pointsAt + (chunks ? 8 : 0);
  const records = new Uint8Array(points.length * SIZE);
  const rv = new DataView(records.buffer);
  points.forEach((p, i) => {
    rv.setInt32(i * SIZE, Math.round(p.x * 100), true);
    rv.setInt32(i * SIZE + 4, Math.round((p.y - 5621000) * 100), true);
    rv.setInt32(i * SIZE + 8, Math.round(p.z * 100), true);
    records[i * SIZE + 14] = 1 | (1 << 4);
    records[i * SIZE + 16] = p.cls;
  });
  let table = new Uint8Array(0);
  if (chunks) {
    const list: LazChunk[] = [];
    for (let k = 0; k < points.length; k += chunks) {
      const count = Math.min(chunks, points.length - k);
      list.push({ offset: first + k * SIZE, byteSize: count * SIZE, pointCount: count });
    }
    const json = new TextEncoder().encode(JSON.stringify(list));
    table = new Uint8Array(8 + json.length);
    new DataView(table.buffer).setUint32(4, list.length, true);
    table.set(json, 8);
  }
  const bytes = new Uint8Array(first + records.length + table.length);
  const view = new DataView(bytes.buffer);
  'LASF'.split('').forEach((c, i) => (bytes[i] = c.charCodeAt(0)));
  bytes[24] = 1;
  bytes[25] = 4;
  view.setUint16(94, 375, true);
  view.setUint32(96, pointsAt, true);
  view.setUint32(100, vlrs.length, true);
  bytes[104] = 6 | (chunks ? 0x80 : 0);
  view.setUint16(105, SIZE, true);
  [0.01, 0.01, 0.01].forEach((v, k) => view.setFloat64(131 + 8 * k, v, true));
  [0, 5621000, 0].forEach((v, k) => view.setFloat64(155 + 8 * k, v, true));
  view.setBigUint64(247, BigInt(points.length), true);
  let at = 375;
  for (const vlr of vlrs) {
    vlr.userId.split('').forEach((c, i) => (bytes[at + 2 + i] = c.charCodeAt(0)));
    view.setUint16(at + 18, vlr.recordId, true);
    view.setUint16(at + 20, vlr.data.length, true);
    bytes.set(vlr.data, at + 54);
    at += 54 + vlr.data.length;
  }
  const tableAt = first + records.length;
  if (chunks) view.setBigInt64(pointsAt, tableAtEnd ? -1n : BigInt(tableAt), true);
  bytes.set(records, first);
  bytes.set(table, tableAt);
  return bytes;
}

function fakeFetcher(files: Record<string, Uint8Array>) {
  const requested: string[] = [];
  const notes = new Map<string, string>();
  const file = (url: string) => {
    if (!files[url]) throw new Error(`404 ${url}`);
    return files[url];
  };
  const fetcher = {
    downloaded: 0,
    async range(url: string, start: number, end: number) {
      requested.push(`${url}#${start}-${end}`);
      if (end > file(url).length) throw new Error(`Range ${start}-${end} past the end of ${url}`);
      return file(url).slice(start, end).buffer;
    },
    async tail(url: string, start: number) {
      requested.push(`${url}#${start}-`);
      return file(url).slice(start).buffer;
    },
    async bytes(url: string) {
      requested.push(url);
      return file(url).slice().buffer;
    },
    async note(key: string, value?: string) {
      if (value !== undefined) notes.set(key, value);
      return notes.get(key) ?? '';
    },
  };
  return { fetcher: fetcher as unknown as Fetcher, requested, notes };
}

function bboxOf(x0: number, y0: number, x1: number, y1: number): GeoBounds {
  const [west, south] = mercator.toLonLat(x0, y0);
  const [east, north] = mercator.toLonLat(x1, y1);
  return { west, south, east, north };
}

// Three chunks of two points: west, middle and east of the tile.
const points: Pt[] = [
  { x: 10, y: 5621010, z: 5, cls: 2 },
  { x: 20, y: 5621020, z: 6, cls: 6 },
  { x: 410, y: 5621010, z: 7, cls: 2 },
  { x: 420, y: 5621020, z: 8, cls: 7 },
  { x: 810, y: 5621010, z: 9, cls: 1 },
  { x: 820, y: 5621020, z: 10, cls: 2 },
];
const everything = bboxOf(0, 5621000, 1000, 5621100);
const frame = new Projection([(everything.west + everything.east) / 2, (everything.south + everything.north) / 2], 0, 1);
const url = 'https://example.com/tiles/a.laz';
const entry = (size?: number) => ({ url, bbox: [everything.west, everything.south, everything.east, everything.north] as [number, number, number, number], size });

describe('plain LAZ tiles', () => {
  it('reads every chunk the first time, notes where each lies, and then reads only what a query needs', async () => {
    const { fetcher, requested, notes } = fakeFetcher({ [url]: tile(points, 2) });
    const first = await readTiles(fetcher, [entry()], everything, { frame });
    // Noise (class 7) is dropped.
    expect([...first.points.z]).toEqual([5, 6, 7, 9, 10]);
    expect(first.info.nodes).toBe(3);
    // No size and no EVLRs: the table is read to the end of the file.
    expect(requested.some((r) => r.endsWith('-'))).toBe(true);
    expect(notes.size).toBe(1);
    const boxes = JSON.parse([...notes.values()][0]) as number[];
    expect(boxes.slice(0, 4)).toEqual([10, 5621010, 20, 5621020]);

    const east = await readTiles(fetcher, [entry()], bboxOf(700, 5621000, 1000, 5621100), { frame });
    expect([...east.points.z]).toEqual([9, 10]);
    expect(east.info.nodes).toBe(1);
  });

  it('reads the table up to a known file size', async () => {
    const bytes = tile(points, 4);
    const { fetcher, requested } = fakeFetcher({ [url]: bytes });
    const { points: read } = await readTiles(fetcher, [entry(bytes.length)], everything, { frame });
    expect(read.count).toBe(5);
    expect(requested.some((r) => r.endsWith('-'))).toBe(false);
    expect(requested.at(-2)).toMatch(new RegExp(`#\\d+-${bytes.length}$`));
  });

  it('finds a table written at the end through the last 8 bytes, given the size', async () => {
    const bytes = tile(points, 2, true);
    // After the header, its two records and the 8 byte pointer slot, and the points.
    const tableAt = 375 + 54 + 16 + 54 + 34 + 8 + points.length * SIZE;
    const withPointer = new Uint8Array(bytes.length + 8);
    withPointer.set(bytes);
    new DataView(withPointer.buffer).setBigInt64(bytes.length, BigInt(tableAt), true);
    const { fetcher } = fakeFetcher({ [url]: withPointer });
    expect((await readTiles(fetcher, [entry(withPointer.length)], everything, { frame })).points.count).toBe(5);
    await expect(readTiles(fetcher, [entry()], everything, { frame })).rejects.toThrow(/no LAZ chunk table/);
  });
});

describe('uncompressed LAS tiles', () => {
  it('reads the records in slabs and crops them', async () => {
    const { fetcher, notes } = fakeFetcher({ [url]: tile(points) });
    const { points: read, info } = await readTiles(fetcher, [entry()], bboxOf(0, 5621000, 500, 5621100), { frame });
    expect([...read.z]).toEqual([5, 6, 7]);
    expect([...read.cls]).toEqual([2, 6, 2]);
    expect(info.horizontalCrs).toBe('EPSG:3857');
    expect(notes.size).toBe(1);
  });

  it("adds a tile's height offset to every return", async () => {
    const { fetcher } = fakeFetcher({ [url]: tile(points) });
    const { points: read } = await readTiles(fetcher, [{ ...entry(), zOffset: -36.5 }], bboxOf(0, 5621000, 500, 5621100), { frame });
    expect([...read.z]).toEqual([5 - 36.5, 6 - 36.5, 7 - 36.5]);
  });

  it('reads a whole file from a server that ignores Range', async () => {
    const { fetcher, requested } = fakeFetcher({ [url]: tile(points) });
    const { points: read } = await readTiles(fetcher, [{ ...entry(), whole: true }], everything, { frame });
    expect(read.count).toBe(5);
    expect(requested).toEqual([url]);
  });
});

describe('tiles in ZIPs', () => {
  const zipUrl = 'https://example.com/tiles/block.zip';
  const west = points.slice(0, 2);
  const east = points.slice(4);

  it('reads a stored member in place, by name, and skips one the ZIP lacks', async () => {
    const zip = zipSync({ 'readme.txt': new TextEncoder().encode('hello'), 'west.laz': [tile(west, 1), { level: 0 }], 'east.las': [tile(east), { level: 0 }] });
    for (const size of [zip.length, undefined]) {
      const { fetcher, notes } = fakeFetcher({ [zipUrl]: zip });
      const box = entry().bbox;
      const { points: read } = await readTiles(
        fetcher,
        [
          { url: zipUrl, bbox: box, member: 'west.laz', size },
          { url: zipUrl, bbox: box, member: 'missing.laz', size },
          { url: zipUrl, bbox: box, member: 'east.las', size },
        ],
        everything,
        { frame },
      );
      expect([...read.z]).toEqual([5, 6, 9, 10]);
      // Each member keeps notes of its own.
      expect([...notes.keys()].every((k) => k.includes('#'))).toBe(true);
    }
  });

  it('streams a deflated member of plain LAS and crops it as it inflates', async () => {
    const many: Pt[] = Array.from({ length: 5000 }, (_, i) => ({ x: (i % 100) * 10, y: 5621000 + Math.floor(i / 100), z: i / 100, cls: 2 }));
    const zip = zipSync({ 'big.las': [tile(many), { level: 6 }] });
    const { fetcher } = fakeFetcher({ [zipUrl]: zip });
    const { points: read } = await readTiles(fetcher, [{ url: zipUrl, bbox: entry().bbox, size: zip.length }], bboxOf(0, 5621000, 500, 5621100), { frame });
    expect(read.count).toBe(2500);
    // x = 500 is just outside the crop.
    expect(Math.max(...read.z)).toBeCloseTo(49.49, 6);
  });

  it('inflates a deflated LAZ member whole', async () => {
    const zip = zipSync({ 'west.laz': [tile(points, 2), { level: 6 }] });
    const { fetcher } = fakeFetcher({ [zipUrl]: zip });
    const { points: read } = await readTiles(fetcher, [{ url: zipUrl, bbox: entry().bbox, size: zip.length }], everything, { frame });
    expect(read.count).toBe(5);
  });
});

describe('checking a tile before offering it', () => {
  // Inside the US, where heights can't be assumed to be metres.
  const american = [-90, 38, -89, 39] as [number, number, number, number];

  it('reads the header by range and throws what reading it would', async () => {
    const { fetcher, requested } = fakeFetcher({ [url]: tile(points, 2) });
    await expect(checkTile(fetcher, { url, bbox: american }, {})).rejects.toThrow(/vertical units/);
    await checkTile(fetcher, { url, bbox: american }, { verticalUnits: 'us-ft' });
    await checkTile(fetcher, entry(), {});
    expect(requested.every((r) => /#\d+-\d+$/.test(r))).toBe(true);
  });

  it("leaves alone a tile it would have to download, whole or deflated", async () => {
    const zipUrl = 'https://example.com/tiles/block.zip';
    const zip = zipSync({ 'west.laz': [tile(points, 2), { level: 6 }] });
    const zipped = fakeFetcher({ [zipUrl]: zip });
    await checkTile(zipped.fetcher, { url: zipUrl, bbox: american, size: zip.length }, {});
    expect(zipped.requested).not.toContain(zipUrl);
    const whole = fakeFetcher({ [url]: tile(points) });
    await checkTile(whole.fetcher, { url, bbox: american, whole: true }, {});
    expect(whole.requested).toEqual([]);
  });
});

describe('tileDensity', () => {
  it("divides a tile's points by the ground its header's box covers, from the header alone", async () => {
    const bytes = tile(points, 2);
    const view = new DataView(bytes.buffer);
    // Max and min x, then y: 1000 by 100 units at 45 degrees north, 50,000 m² on the ground.
    [1000, 0, 5621100, 5621000].forEach((v, k) => view.setFloat64(179 + 8 * k, v, true));
    const { fetcher, requested } = fakeFetcher({ [url]: bytes });
    const lat = mercator.toLonLat(0, 5621050)[1] * (Math.PI / 180);
    expect(await tileDensity(fetcher, entry())).toBeCloseTo(6 / (1000 * 100 * Math.cos(lat) ** 2), 9);
    expect(requested.every((r) => /#\d+-\d+$/.test(r))).toBe(true);
    // Nothing to divide by, or nothing it may read.
    expect(await tileDensity(fakeFetcher({ [url]: tile(points, 2) }).fetcher, entry())).toBe(null);
    expect(await tileDensity(fakeFetcher({ [url]: bytes }).fetcher, { ...entry(), whole: true })).toBe(null);
  });
});
