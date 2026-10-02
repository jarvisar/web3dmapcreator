// Providers outside Europe against canned catalog answers: GeoNB,
// OpenTopography, NOAA Digital Coast and Sao Paulo.

import { readFileSync } from 'node:fs';
import { zipSync } from 'fflate';
import proj4 from 'proj4';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../data/http';
import type { GeoBounds } from '../../types';
import { crsFromEpsg, lonLatTransforms, setProjector } from '../read/crs';
import type { Fetcher } from '../read/fetcher';
import { geonb } from './geonb';
import { noaa } from './noaa';
import { opentopography } from './opentopography';
import { indiana } from './indiana';
import { japan } from './japan';
import { kyfromabove } from './kyfromabove';
import { saoPaulo } from './saopaulo';
import { zippedShapefile } from './test-shapefile';

setProjector((from, to) => proj4(from, to));

function fakeFetcher(route: (url: string) => string | object | Uint8Array | undefined) {
  const requested: string[] = [];
  const get = (url: string) => {
    requested.push(url);
    const body = route(url);
    if (body === undefined) throw new Error(`Download failed with HTTP 404: ${url}`);
    return body;
  };
  const fetcher = {
    downloaded: 0,
    text: async (url: string) => get(url) as string,
    json: async (url: string) => get(url),
    catalog: async (url: string) => (get(url) as Uint8Array).slice().buffer,
  };
  return { fetcher: fetcher as unknown as Fetcher, requested };
}

const square = (w: number, s: number, e: number, n: number) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const collection = (features: object[]) => ({ type: 'FeatureCollection', features });

/** A dBase table with the given columns, as an OpenTopography index has. */
function dbf(columns: [string, 'C' | 'N', number][], rows: (string | number)[][]): Uint8Array {
  const headerSize = 32 + 32 * columns.length + 1;
  const rowSize = 1 + columns.reduce((s, c) => s + c[2], 0);
  const bytes = new Uint8Array(headerSize + rows.length * rowSize + 1);
  const view = new DataView(bytes.buffer);
  bytes[0] = 3;
  view.setUint32(4, rows.length, true);
  view.setUint16(8, headerSize, true);
  view.setUint16(10, rowSize, true);
  columns.forEach(([name, type, width], i) => {
    const at = 32 + 32 * i;
    name.split('').forEach((c, k) => (bytes[at + k] = c.charCodeAt(0)));
    bytes[at + 11] = type.charCodeAt(0);
    bytes[at + 16] = width;
  });
  bytes[headerSize - 1] = 0x0d;
  rows.forEach((row, r) => {
    let at = headerSize + r * rowSize;
    bytes.fill(0x20, at, at + rowSize);
    at++;
    row.forEach((value, i) => {
      String(value).split('').forEach((c, k) => (bytes[at + k] = c.charCodeAt(0)));
      at += columns[i][2];
    });
  });
  return bytes;
}

describe('GeoNB', () => {
  const moncton: GeoBounds = { west: -64.80, south: 46.085, east: -64.79, north: 46.095 };

  it('makes one survey per index layer, whatever case its fields are in', async () => {
    const { fetcher, requested } = fakeFetcher((url) => {
      if (url.includes('/MapServer/12/'))
        return collection([{ type: 'Feature', geometry: square(-64.806, 46.082, -64.793, 46.092), properties: { File_URL: 'https://geonb.snb.ca/downloads2/lidar/2025/laz/nb_2025_2631000_7455000.laz', Year: 2025, PPM: 20 } }]);
      if (url.includes('/MapServer/2/'))
        return collection([{ type: 'Feature', geometry: square(-64.806, 46.082, -64.793, 46.092), properties: { FILE_URL: 'https://geonb.snb.ca/downloads2/lidar/2017/erd2/laz/nb_2017_2631000_7455000.laz', Year: '2017' } }]);
      if (url.includes('/MapServer/')) return collection([]);
      return undefined;
    });
    const surveys = await geonb.discover(fetcher, moncton, []);
    expect(surveys.map((s) => s.name)).toEqual(['GeoNB LiDAR 2025', 'GeoNB LiDAR 2017']);
    expect(surveys[0]).toMatchObject({ format: 'LAZ', projectYearHint: 2025 });
    expect(surveys[0].densityM2).toBeUndefined();
    expect(surveys[0].tiles![0]).toMatchObject({ url: 'https://geonb.snb.ca/downloads2/lidar/2025/laz/nb_2025_2631000_7455000.laz', horizontalCrs: 'EPSG:2953' });
    expect(requested.filter((u) => u.includes('/query?'))).toHaveLength(11);
  });
});

describe('OpenTopography', () => {
  const wellington: GeoBounds = { west: 174.772, south: -41.289, east: 174.78, north: -41.284 };
  // NZTM around Wellington's waterfront.
  const [x, y] = proj4('+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +units=m', 'EPSG:4326').inverse([174.776, -41.2865]);
  const index = (columns: [string, 'C' | 'N', number][]) =>
    zipSync({
      'X_TileIndex.dbf': dbf(columns, [
        ['in.laz', Math.round(x - 240), Math.round(x + 240), Math.round(y - 360), Math.round(y + 360), 'https://opentopography.s3.sdsc.edu/pc-bulk/NZ19_Wellington/in.laz'],
        ['far.laz', 1000000, 1000480, 5000000, 5000720, 'https://opentopography.s3.sdsc.edu/pc-bulk/NZ19_Wellington/far.laz'],
      ]),
      'X_TileIndex.prj': new TextEncoder().encode('PROJCS["NZGD_2000_New_Zealand_Transverse_Mercator",GEOGCS["GCS_NZGD_2000",DATUM["D_NZGD_2000",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",1600000.0],PARAMETER["False_Northing",10000000.0],PARAMETER["Central_Meridian",173.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]'),
    });
  const dataset = (folder: string, id: string) => ({
    Dataset: {
      name: 'Wellington City, New Zealand 2019-2020',
      identifier: { value: id },
      alternateName: folder,
      url: 'https://doi.org/10.5069/G9K935QX',
      citation: 'Toit&#363; Te Whenua Land Information New Zealand (LINZ) (2020). Wellington City.',
      temporalCoverage: '2019-03-20 / 2020-03-14',
      spatialCoverage: { geo: { geojson: collection([{ type: 'Feature', geometry: square(174.6, -41.4, 174.9, -41.1), properties: {} }]) }, additionalProperty: [{ name: 'EPSG (Horizontal)', value: '2193' }] },
    },
  });

  it('reads tiles from the index under the area, with either style of field names', async () => {
    for (const columns of [
      [['file_name', 'C', 20], ['min_x', 'N', 12], ['max_x', 'N', 12], ['min_y', 'N', 12], ['max_y', 'N', 12], ['URL', 'C', 90]],
      [['Filename', 'C', 20], ['MinX', 'N', 12], ['MaxX', 'N', 12], ['MinY', 'N', 12], ['MaxY', 'N', 12], ['URL', 'C', 90]],
    ] as [string, 'C' | 'N', number][][]) {
      const { fetcher } = fakeFetcher((url) => {
        if (url.startsWith('https://portal.opentopography.org/API/otCatalog')) return { Datasets: [dataset('NZ19_Wellington', 'OTLAS.092020.2193.1'), dataset('Community', 'OTDS.012021.4326.1')] };
        if (url.endsWith('NZ19_Wellington/NZ19_Wellington_TileIndex.zip')) return index(columns);
        return undefined;
      });
      const surveys = await opentopography.discover(fetcher, wellington, []);
      // Community uploads (OTDS) are left out.
      expect(surveys).toHaveLength(1);
      expect(surveys[0]).toMatchObject({ format: 'LAZ', acquisitionStart: '2019-03-20', acquisitionEnd: '2020-03-14', projectYearHint: 2020 });
      expect(surveys[0].attribution).toContain('Toitū Te Whenua');
      expect(surveys[0].tiles!.map((t) => t.url.split('/').at(-1))).toEqual(['in.laz']);
    }
  });

  it('reports a dataset whose index it cannot read, and keeps the rest', async () => {
    const { fetcher } = fakeFetcher((url) => (url.startsWith('https://portal.opentopography.org/') ? { Datasets: [dataset('NZ19_Wellington', 'OTLAS.092020.2193.1')] } : undefined));
    const failures: { source: string; reason: string }[] = [];
    expect(await opentopography.discover(fetcher, wellington, failures)).toEqual([]);
    expect(failures.map((f) => f.source)).toEqual(['OpenTopography NZ19_Wellington']);
  });
  it('passes over a dataset without a tile index, which some of its catalog entries are', async () => {
    const answer = (status: number) =>
      ({
        downloaded: 0,
        json: async () => ({ Datasets: [dataset('NZ19_Wellington', 'OTLAS.092020.2193.1')] }),
        catalog: async (url: string) => Promise.reject(new HttpError(status, url)),
      }) as unknown as Fetcher;
    const failures: { source: string; reason: string }[] = [];
    expect(await opentopography.discover(answer(404), wellington, failures)).toEqual([]);
    expect(failures).toEqual([]);
    // Anything else is still a failure, said without the URL.
    expect(await opentopography.discover(answer(503), wellington, failures)).toEqual([]);
    expect(failures).toEqual([{ source: 'OpenTopography NZ19_Wellington', reason: 'it answered HTTP 503' }]);
  });
});

describe('NOAA Digital Coast', () => {
  const pagoPago: GeoBounds = { west: -170.71, south: -14.29, east: -170.69, north: -14.27 };
  const item = (href: string, count: number) => ({
    geometry: square(-170.8, -14.35, -170.6, -14.2),
    properties: { 'pc:count': count, start_datetime: '2022-10-18T00:00:00Z', end_datetime: '2022-12-12T00:00:00Z', 'proj:wkt2': 'COMPOUNDCRS["NAD83(PA11) / UTM zone 2S + ASVD02 height", LENGTHUNIT["metre",1]]' },
    assets: { ept: { href } },
  });

  it('lists NOAA-built EPTs, leaving out USGS copies, sparse surveys and surveys without an EPT', async () => {
    const { fetcher } = fakeFetcher((url) => {
      if (url.startsWith('https://coast.noaa.gov/'))
        return collection([10092, 9118, 2497, 1].map((id) => ({ type: 'Feature', geometry: null, properties: { id, title: `Survey ${id} 2022` } })));
      if (url.endsWith('mission_10092.json')) return item('https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/entwine/geoid12b/10092/ept.json', 4e9);
      if (url.endsWith('mission_9118.json')) return item('https://s3-us-west-2.amazonaws.com/usgs-lidar-public/USGS_LPC_X/ept.json', 4e9);
      if (url.endsWith('mission_2497.json')) return item('https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/entwine/geoid12b/2497/ept.json', 1e6);
      // Nor tiles.
      if (url.includes('list-type=2')) return listing([]);
      return undefined;
    });
    const failures: { source: string; reason: string }[] = [];
    const surveys = await noaa.discover(fetcher, pagoPago, failures);
    expect(failures).toEqual([]);
    expect(surveys.map((s) => s.id)).toEqual(['10092']);
    expect(surveys[0]).toMatchObject({ format: 'EPT', verticalUnits: 'm', acquisitionStart: '2022-10-18', acquisitionEnd: '2022-12-12' });
    // About 390 km² of outline.
    expect(surveys[0].densityM2).toBeGreaterThan(5);
    expect(surveys[0].classification!['41']).toBe('water');
  });

  it('reads the tile index of a survey without an EPT, and leaves old ones alone', async () => {
    const { fromLonLat } = lonLatTransforms(crsFromEpsg(6347));
    const [x, y] = fromLonLat(-72.925, 41.305);
    const tile = (dx: number): [number, number, number, number] => [x - 400 + dx, y - 400, x + 400 + dx, y + 400];
    const folder = 'https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/laz/geoid18/';
    const index = (id: number, ext: string) =>
      zippedShapefile(
        [tile(0), tile(20000)],
        [['filename', 30], ['srs', 9], ['url', 100]],
        [
          [`near${ext}`, 'EPSG:6347', `${folder}${id}/BLOCK1/near${ext}`],
          [`far${ext}`, 'EPSG:6347', `${folder}${id}/BLOCK1/far${ext}`],
        ],
      );
    const { fetcher, requested } = fakeFetcher((url) => {
      if (url.startsWith('https://coast.noaa.gov/'))
        return collection([
          { type: 'Feature', geometry: null, properties: { id: 10296, title: '2023 CT GIS Office Lidar: Connecticut Statewide' } },
          { type: 'Feature', geometry: null, properties: { id: 4000, title: '2019 County Lidar' } },
          { type: 'Feature', geometry: null, properties: { id: 1468, title: '2006 FEMA Lidar: Connecticut Coastal' } },
        ]);
      if (url.includes(encodeURIComponent('laz/geoid18/10296/tileindex_'))) return listing([['laz/geoid18/10296/tileindex_CT_statewide_m10296.zip', 1e6]]);
      if (url.endsWith('tileindex_CT_statewide_m10296.zip')) return index(10296, '.copc.laz');
      // The 2019 one is under the other datum, as plain LAZ.
      if (url.includes(encodeURIComponent('laz/geoid12b/4000/tileindex_'))) return listing([['laz/geoid12b/4000/tileindex_county_m4000.zip', 1e6]]);
      if (url.endsWith('tileindex_county_m4000.zip')) return index(4000, '.laz');
      if (url.includes('list-type=2')) return listing([]);
      return undefined;
    });
    const failures: { source: string; reason: string }[] = [];
    const surveys = await noaa.discover(fetcher, { west: -72.927, south: 41.303, east: -72.923, north: 41.307 }, failures);
    expect(failures).toEqual([]);
    expect(surveys.map((s) => [s.id, s.format, s.projectYearHint, s.tiles!.map((t) => t.url.split('/').pop())])).toEqual([
      ['10296', 'COPC', 2023, ['near.copc.laz']],
      ['4000', 'LAZ', 2019, ['near.laz']],
    ]);
    expect(surveys[0].url).toBe(`${folder}10296/`);
    expect(requested.some((url) => url.includes(encodeURIComponent('/1468/')))).toBe(false);
  });

  it("falls back to the index's .prj when its rows name a geographic code", async () => {
    // Olympic Peninsula 2017: NAD83(CORS96) / UTM zone 10N has no code, so rows say 6783.
    const { fromLonLat } = lonLatTransforms(crsFromEpsg(26910));
    const [x, y] = fromLonLat(-122.6326, 47.5673);
    const prj = 'PROJCS["NAD_1983_CORS96_UTM_Zone_10N",GEOGCS["GCS_NAD_1983_CORS96",DATUM["D_NAD_1983_CORS96",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-123.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';
    const folder = 'https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/laz/geoid18/9072/';
    const index = zippedShapefile([[x - 300, y - 300, x + 300, y + 300]], [['srs', 9], ['url', 100]], [['EPSG:6783', `${folder}block_1a/q47122E8118.copc.laz`]], prj);
    const { fetcher } = fakeFetcher((url) => {
      if (url.startsWith('https://coast.noaa.gov/')) return collection([{ type: 'Feature', geometry: null, properties: { id: 9072, title: '2017 USGS Lidar: Olympic Peninsula, WA' } }]);
      if (url.includes(encodeURIComponent('laz/geoid18/9072/tileindex_'))) return listing([['laz/geoid18/9072/tileindex_m9072.zip', 1e6]]);
      if (url.endsWith('tileindex_m9072.zip')) return index;
      if (url.includes('list-type=2')) return listing([]);
      return undefined;
    });
    const failures: { source: string; reason: string }[] = [];
    const surveys = await noaa.discover(fetcher, { west: -122.634, south: 47.566, east: -122.631, north: 47.568 }, failures);
    expect(failures).toEqual([]);
    expect(surveys.map((s) => [s.id, s.format, s.tiles!.map((t) => [t.url.split('/').pop(), t.horizontalCrs])])).toEqual([['9072', 'COPC', [['q47122E8118.copc.laz', undefined]]]]);
  });
});

describe('Sao Paulo', () => {
  it('offers the city EPT without asking anything', async () => {
    const { fetcher, requested } = fakeFetcher(() => undefined);
    const [survey] = await saoPaulo.discover(fetcher, { west: -46.64, south: -23.56, east: -46.63, north: -23.55 }, []);
    expect(survey).toMatchObject({ format: 'EPT', url: 'https://ept-m3dc-pmsp.s3.sa-east-1.amazonaws.com/ept.json' });
    expect(requested).toEqual([]);
  });
});

describe('Japan', () => {
  // A real index tile of Tokyo's 23 wards (zoom 14, 14552/6451), 48 tiles of 400 x 300 m.
  const index = new Uint8Array(readFileSync(new URL('../testdata/tokyo-index-14-14552-6451.pbf', import.meta.url)));

  it('reads file URLs and outlines from the vector tile index', async () => {
    const { fetcher } = fakeFetcher((url) => (url.endsWith('/23ku/lp/14/14552/6451.pbf') ? index : undefined));
    const [survey] = await japan.discover(fetcher, { west: 139.75, south: 35.68, east: 139.752, north: 35.682 }, []);
    expect(survey).toMatchObject({ id: 'tokyo-23ku-2023', format: 'LAZ' });
    expect(survey.tiles!.length).toBeGreaterThan(0);
    expect(survey.tiles!.every((t) => /^https:\/\/gic-tokyo\.s3\.ap-northeast-1\.amazonaws\.com\/2024\/dig\/lp\/09LD\d{4}\.zip$/.test(t.url) && t.horizontalCrs === 'EPSG:6677')).toBe(true);
    // Each outline is a 400 x 300 m sheet: about 0.0044 by 0.0027 degrees here.
    const [w, s, e, n] = survey.tiles![0].bbox;
    expect(e - w).toBeCloseTo(0.0044, 3);
    expect(n - s).toBeCloseTo(0.0027, 3);
    // Where the index has no tile the bucket answers 403: no tiles, not a failure.
    const failures: { source: string; reason: string }[] = [];
    expect(await japan.discover(fakeFetcher(() => undefined).fetcher, { west: 139.75, south: 35.68, east: 139.752, north: 35.682 }, failures)).toEqual([]);
    expect(failures).toEqual([]);
  });
});

/** An S3 ListObjectsV2 answer for these keys and sizes. */
const listing = (keys: [string, number][]) =>
  `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${keys.map(([key, size]) => `<Contents><Key>${key}</Key><Size>${size}</Size><ETag>&quot;x&quot;</ETag></Contents>`).join('')}</ListBucketResult>`;

describe('KyFromAbove', () => {
  // Inside tile N159E063 over Paducah.
  const paducah: GeoBounds = { west: -88.5925, south: 37.0845, east: -88.5905, north: 37.0865 };

  it("finds each phase's COPC tiles by listing the rows of the grid", async () => {
    const { fetcher, requested } = fakeFetcher((url) => {
      if (url.includes(encodeURIComponent('elevation/PointCloud/Phase2/N159'))) return listing([['elevation/PointCloud/Phase2/N159E062_LAS_Phase2.copc.laz', 40e6], ['elevation/PointCloud/Phase2/N159E063_LAS_Phase2.copc.laz', 30e6]]);
      if (url.includes(encodeURIComponent('elevation/PointCloud/Phase3/N159'))) return listing([['elevation/PointCloud/Phase3/N159E063_LAS_Phase3.copc.laz', 50e6]]);
      return undefined;
    });
    const surveys = await kyfromabove.discover(fetcher, paducah, []);
    expect(requested).toHaveLength(2);
    expect(surveys.map((s) => [s.name, s.format, s.projectYearHint, s.verticalUnits])).toEqual([
      ['KyFromAbove Phase 2 (2019-2021)', 'COPC', 2019, 'us-ft'],
      ['KyFromAbove Phase 3 (2022-)', 'COPC', 2022, 'us-ft'],
    ]);
    expect(surveys[1].tiles).toEqual([expect.objectContaining({ url: 'https://kyfromabove.s3.us-west-2.amazonaws.com/elevation/PointCloud/Phase3/N159E063_LAS_Phase3.copc.laz', size: 50e6, horizontalCrs: 'EPSG:3089' })]);
    // The tile's corners as the state's tile grid has them, within a few metres.
    const [w, s, e, n] = surveys[1].tiles![0].bbox;
    expect([w, s, e, n].map((v) => Number(v.toFixed(3)))).toEqual([-88.6, 37.079, -88.583, 37.093]);
  });

  it('has nothing where a phase lacks the tile', async () => {
    const { fetcher } = fakeFetcher(() => listing([]));
    expect(await kyfromabove.discover(fetcher, paducah, [])).toEqual([]);
  });
});

describe('Indiana', () => {
  // Inside tile in2025_28222356 on the Lake Michigan shore.
  const shore: GeoBounds = { west: -87.5585, south: 41.7173, east: -87.5575, north: 41.7181 };

  it("reads the lake rim survey's COPC tiles, not their colourised copies", async () => {
    const folder = 'copc/lakerim/2025/SPW/ql1/';
    const { fetcher } = fakeFetcher((url) =>
      url.includes(encodeURIComponent(`${folder}in2025_2822`)) ? listing([[`${folder}in2025_28222356_03.copc.laz`, 29e6], [`${folder}in2025_28222356_03_rgb.copc.laz`, 39e6], [`${folder}in2025_28222355_03.copc.laz`, 31e6]]) : undefined,
    );
    const [survey, ...rest] = await indiana.discover(fetcher, shore, []);
    expect(rest).toEqual([]);
    expect(survey).toMatchObject({ format: 'COPC', acquisitionStart: '2025-04-27', verticalUnits: 'us-ft', license: 'CC0 1.0' });
    expect(survey.tiles!.map((t) => [t.url, t.size])).toEqual([[`https://giselevationingov.s3.amazonaws.com/${folder}in2025_28222356_03.copc.laz`, 29e6]]);
  });
});
