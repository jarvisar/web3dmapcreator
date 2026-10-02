// Discovery against canned catalog answers: the Flai inventory and its
// shapefile tile index, the USGS EPT catalog, and one provider failing.

import { describe, expect, it } from 'vitest';
import type { GeoBounds } from '../../types';
import type { Fetcher } from '../read/fetcher';
import { discover as discoverAll, flaiInventory, PROVIDERS, providersFor, sphericalArea, USGS_CATALOG } from './index';

type Box = [number, number, number, number];

/** A polygon shapefile with one rectangle per box. */
function shapefile(boxes: Box[]): Uint8Array {
  const recordSize = 8 + 44 + 4 + 5 * 16;
  const bytes = new Uint8Array(100 + boxes.length * recordSize);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, 9994, false);
  view.setInt32(24, bytes.length / 2, false);
  view.setInt32(28, 1000, true);
  view.setInt32(32, 5, true);
  const all: Box = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
  all.forEach((v, k) => view.setFloat64(36 + 8 * k, v, true));
  boxes.forEach(([w, s, e, n], i) => {
    const at = 100 + i * recordSize;
    view.setInt32(at, i + 1, false);
    view.setInt32(at + 4, (recordSize - 8) / 2, false);
    const c = at + 8;
    view.setInt32(c, 5, true);
    [w, s, e, n].forEach((v, k) => view.setFloat64(c + 4 + 8 * k, v, true));
    view.setInt32(c + 36, 1, true);
    view.setInt32(c + 40, 5, true);
    view.setInt32(c + 44, 0, true);
    [[w, s], [w, n], [e, n], [e, s], [w, s]].forEach(([x, y], k) => {
      view.setFloat64(c + 48 + 16 * k, x, true);
      view.setFloat64(c + 56 + 16 * k, y, true);
    });
  });
  return bytes;
}

/** A dBase file with one text column, fname. */
function dbf(names: string[]): Uint8Array {
  const width = 40;
  const headerSize = 32 + 32 + 1;
  const rowSize = 1 + width;
  const bytes = new Uint8Array(headerSize + names.length * rowSize + 1);
  const view = new DataView(bytes.buffer);
  bytes[0] = 3;
  view.setUint32(4, names.length, true);
  view.setUint16(8, headerSize, true);
  view.setUint16(10, rowSize, true);
  'FNAME'.split('').forEach((c, i) => (bytes[32 + i] = c.charCodeAt(0)));
  bytes[32 + 11] = 'C'.charCodeAt(0);
  bytes[32 + 16] = width;
  bytes[64] = 0x0d;
  names.forEach((name, r) => {
    const at = headerSize + r * rowSize;
    bytes.fill(0x20, at, at + rowSize);
    name.split('').forEach((c, i) => (bytes[at + 1 + i] = c.charCodeAt(0)));
  });
  bytes[bytes.length - 1] = 0x1a;
  return bytes;
}

function fakeFetcher(route: (url: string) => string | object | Uint8Array | undefined) {
  const requested: string[] = [];
  const get = (url: string) => {
    requested.push(url);
    const body = route(url);
    if (body === undefined) throw new Error(`404 ${url}`);
    return body;
  };
  const fetcher = {
    downloaded: 0,
    text: async (url: string) => get(url) as string,
    json: async (url: string) => get(url),
    bytes: async (url: string) => (get(url) as Uint8Array).slice().buffer,
    range: async (url: string, start: number, end: number) => {
      const body = get(url) as Uint8Array;
      if (end > body.length) throw new Error(`Range past the end of ${url}`);
      return body.slice(start, end).buffer;
    },
  };
  return { fetcher: fetcher as unknown as Fetcher, requested };
}

const listing = (keys: string[]) =>
  `<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key><ETag>"r"</ETag></Contents>`).join('')}</ListBucketResult>`;

// Somewhere no national service covers. Only USGS and Flai are asked: the
// other worldwide catalogs have tests of their own. The made-up USGS surveys
// sit next to Flai's, outside the US, so USGS's areas are left off.
const discover = (fetcher: Fetcher, box: GeoBounds) =>
  discoverAll(
    fetcher,
    box,
    undefined,
    PROVIDERS.filter((p) => p.id === 'usgs' || p.id === 'flai').map((p) => ({ ...p, areas: undefined })),
  );
const bbox: GeoBounds = { west: 20.001, south: 60.001, east: 20.009, north: 60.009 };

describe('Flai inventory', () => {
  it('reads the dataset rows of the published table', () => {
    const readme = [
      '| Name | EPSG | Path | Start | End | Density | License |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      '| Denmark | 25832 | data/DK/SDFI/DHM/copc | 2018-01-01 | 2022-12-31 | 18 | CC-BY-4.0 |',
      '| Test survey | 4326 | data/XX/Agency/Scan\\_2022/copc | 2022-01-01 | 2022-12-31 | 10 | CC-BY-4.0 |',
    ].join('\n');
    const datasets = flaiInventory(readme);
    expect(datasets.map((d) => d.name)).toEqual(['Denmark / DHM', 'Test survey / Scan_2022']);
    expect(datasets[1]).toMatchObject({ epsg: 4326, path: 'data/XX/Agency/Scan_2022/copc', start: '2022-01-01', density: 10, license: 'CC-BY-4.0' });
  });
});

describe('LiDAR discovery', () => {
  const inventory = '| Test survey | 4326 | data/XX/Agency/Scan_2022/copc | 2022-01-01 | 2022-12-31 | 10 | CC-BY-4.0 |';
  const shp = shapefile([
    [20, 60, 20.01, 60.01],
    [10, 10, 11, 11],
  ]);
  const rows = dbf(['inside.copc.laz', 'outside.copc.laz']);
  const usgs = {
    features: [
      { properties: { name: 'XX_Here_2020', url: 'https://example.com/here/ept.json' }, geometry: { type: 'Polygon', coordinates: [[[19.9, 59.9], [20.1, 59.9], [20.1, 60.1], [19.9, 59.9]]] } },
      { properties: { name: 'XX_Plain_2020', url: 'http://example.com/plain/ept.json' }, geometry: { type: 'Polygon', coordinates: [[[19.9, 59.9], [20.1, 59.9], [20.1, 60.1], [19.9, 59.9]]] } },
      { properties: { name: 'XX_Far_2019', url: 'https://example.com/far/ept.json' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
      { properties: { name: 'XX_WorkUnit_1_B23', url: 'https://example.com/unit/ept.json' }, geometry: { type: 'Polygon', coordinates: [[[19.9, 59.9], [20.1, 59.9], [20.1, 60.1], [19.9, 59.9]]] } },
    ],
  };

  function route(url: string) {
    if (url === USGS_CATALOG) return usgs;
    if (url.endsWith('README.md')) return inventory;
    if (url.includes('list-type=2')) return listing(['data/XX/Agency/Scan_2022/shp/index.shp', 'data/XX/Agency/Scan_2022/shp/index.dbf']);
    if (url.endsWith('/shp/index.shp')) return shp;
    if (url.endsWith('/shp/index.dbf')) return rows;
    return undefined;
  }

  it('finds Flai tiles from the index and USGS surveys from the catalog, without point downloads', async () => {
    const { fetcher, requested } = fakeFetcher(route);
    const { candidates, failures } = await discover(fetcher, bbox);
    expect(failures).toEqual([]);
    expect(candidates.map((c) => `${c.provider} ${c.id}`)).toEqual(['USGS XX_Here_2020', 'USGS XX_WorkUnit_1_B23', 'Flai data/XX/Agency/Scan_2022']);
    // Work units since 2020 carry their year as a suffix.
    expect(candidates.map((c) => c.projectYearHint)).toEqual([2020, 2023, 2022]);
    const flai = candidates[2];
    expect(flai.format).toBe('COPC');
    expect(flai.tiles!.map((t) => t.url)).toEqual(['https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/XX/Agency/Scan_2022/copc/inside.copc.laz']);
    expect(flai.tiles![0].horizontalCrs).toBe('EPSG:4326');
    expect(flai).toMatchObject({ acquisitionStart: '2022-01-01', acquisitionEnd: '2022-12-31', densityM2: 10, projectYearHint: 2022 });
    expect(requested.some((u) => u.endsWith('.copc.laz'))).toBe(false);
  });

  it('estimates the density of a USGS survey from its point count and outline', async () => {
    const { fetcher } = fakeFetcher((url) => (url === 'https://example.com/here/ept.json' ? { points: 2e9 } : route(url)));
    const here = (await discover(fetcher, bbox)).candidates[0];
    // The outline is half of a 0.2 degree square at 60 degrees north: about 124 km2.
    expect(here.densityM2! * sphericalArea(here.coverage)).toBeCloseTo(2e9, -3);
    expect(sphericalArea(here.coverage) / 1e6).toBeCloseTo(123.9, 0);
    // Without an ept.json there's no density, and discovery carries on.
    expect((await discover(fakeFetcher(route).fetcher, bbox)).candidates[0].densityM2).toBeUndefined();
  });

  it('keeps the other providers when one fails', async () => {
    const { fetcher } = fakeFetcher((url) => (url === USGS_CATALOG ? undefined : route(url)));
    const { candidates, failures } = await discover(fetcher, bbox);
    expect(failures.map((f) => [f.source, f.search])).toEqual([['USGS 3DEP', true]]);
    expect(candidates.map((c) => c.provider)).toEqual(['Flai']);
  });

  it('searches a national grid dataset beyond its own zone', async () => {
    // Denmark publishes Copenhagen in UTM 32, east of EPSG:25832's 6-12 degrees.
    const copenhagen: GeoBounds = { west: 12.566, south: 55.674, east: 12.573, north: 55.679 };
    const denmark = '| Denmark | 25832 | data/DK/SDFI/DHM/copc | 2018-01-01 | 2022-12-31 | 18 | CC-BY-4.0 |';
    const { fetcher, requested } = fakeFetcher((url) => (url.endsWith('README.md') ? denmark : url === USGS_CATALOG ? { features: [] } : undefined));
    await discover(fetcher, copenhagen);
    expect(requested.some((u) => u.includes('list-type=2') && u.includes(encodeURIComponent('data/DK/SDFI/DHM/shp/')))).toBe(true);
  });
  it("only asks USGS's catalog about the US and its territories", () => {
    const around = (lon: number, lat: number): GeoBounds => ({ west: lon - 0.001, south: lat - 0.001, east: lon + 0.001, north: lat + 0.001 });
    const asked = (lon: number, lat: number) => providersFor(around(lon, lat)).some((p) => p.id === 'usgs');
    // Chicago, Anchorage, Adak, Honolulu, San Juan, Mona Island, Hagåtña, Saipan, Pago Pago.
    for (const [lon, lat] of [[-87.63, 41.88], [-149.89, 61.22], [-176.64, 51.88], [-157.86, 21.31], [-66.11, 18.47], [-67.9, 18.08], [144.75, 13.47], [145.75, 15.18], [-170.7, -14.28]]) expect(asked(lon, lat)).toBe(true);
    // Paris, Tokyo, Mexico City, Reykjavik.
    for (const [lon, lat] of [[2.35, 48.86], [139.69, 35.69], [-99.13, 19.43], [-21.94, 64.15]]) expect(asked(lon, lat)).toBe(false);
  });
});
