// European providers against canned catalog answers: how each turns its
// publisher's index into tiles, names and dates.

import { zipSync } from 'fflate';
import proj4 from 'proj4';
import { describe, expect, it } from 'vitest';
import type { GeoBounds } from '../../types';
import { setProjector } from '../read/crs';
import type { Fetcher } from '../read/fetcher';
import { basque } from './basque';
import { berlin } from './berlin';
import { brandenburg } from './brandenburg';
import { flai, unlistedDataset } from './flai';
import { helsinki } from './helsinki';
import { luxembourg } from './luxembourg';
import { rlp, rlpTiles } from './rlp';
import { scotland } from './scotland';
import { slovenia } from './slovenia';
import { trentino } from './trentino';

setProjector((from, to) => proj4(from, to));

function fakeFetcher(route: (url: string, body?: string) => string | object | Uint8Array | number | undefined) {
  const requested: string[] = [];
  const get = (url: string, body?: string) => {
    requested.push(url);
    const answer = route(url, body);
    if (answer === undefined) throw new Error(`Download failed with HTTP 404: ${url}`);
    return answer;
  };
  const fetcher = {
    downloaded: 0,
    text: async (url: string) => get(url) as string,
    json: async (url: string) => get(url),
    post: async (url: string, body: string) => get(url, body),
    catalog: async (url: string) => (get(url) as Uint8Array).slice().buffer,
    bytes: async (url: string) => (get(url) as Uint8Array).slice().buffer,
    range: async (url: string, start: number, end: number) => {
      const bytes = get(url) as Uint8Array;
      if (end > bytes.length) throw new Error(`Range past the end of ${url}`);
      return bytes.slice(start, end).buffer;
    },
    size: async (url: string) => (get(url) as Uint8Array).length,
  };
  return { fetcher: fetcher as unknown as Fetcher, requested };
}

const square = (w: number, s: number, e: number, n: number) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const around = (lon: number, lat: number, d = 0.002): GeoBounds => ({ west: lon - d, south: lat - d, east: lon + d, north: lat + d });

/** A shapefile of rectangles and a dBase table beside it, zipped as a published index. */
function zippedShapefile(boxes: [number, number, number, number][], columns: [string, number][], rows: (string | number)[][], prj?: string): Uint8Array {
  const recordSize = 8 + 44 + 4 + 5 * 16;
  const shp = new Uint8Array(100 + boxes.length * recordSize);
  const sv = new DataView(shp.buffer);
  sv.setInt32(0, 9994, false);
  sv.setInt32(24, shp.length / 2, false);
  sv.setInt32(28, 1000, true);
  sv.setInt32(32, 5, true);
  [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))].forEach((v, k) => sv.setFloat64(36 + 8 * k, v, true));
  boxes.forEach(([w, s, e, n], i) => {
    const at = 100 + i * recordSize;
    sv.setInt32(at, i + 1, false);
    sv.setInt32(at + 4, (recordSize - 8) / 2, false);
    const c = at + 8;
    sv.setInt32(c, 5, true);
    [w, s, e, n].forEach((v, k) => sv.setFloat64(c + 4 + 8 * k, v, true));
    sv.setInt32(c + 36, 1, true);
    sv.setInt32(c + 40, 5, true);
    [[w, s], [w, n], [e, n], [e, s], [w, s]].forEach(([x, y], k) => {
      sv.setFloat64(c + 48 + 16 * k, x, true);
      sv.setFloat64(c + 56 + 16 * k, y, true);
    });
  });
  const headerSize = 32 + 32 * columns.length + 1;
  const rowSize = 1 + columns.reduce((s, c) => s + c[1], 0);
  const dbf = new Uint8Array(headerSize + rows.length * rowSize + 1);
  const dv = new DataView(dbf.buffer);
  dbf[0] = 3;
  dv.setUint32(4, rows.length, true);
  dv.setUint16(8, headerSize, true);
  dv.setUint16(10, rowSize, true);
  columns.forEach(([name, width], i) => {
    name.split('').forEach((c, k) => (dbf[32 + 32 * i + k] = c.charCodeAt(0)));
    dbf[32 + 32 * i + 11] = 'C'.charCodeAt(0);
    dbf[32 + 32 * i + 16] = width;
  });
  dbf[headerSize - 1] = 0x0d;
  rows.forEach((row, r) => {
    let at = headerSize + r * rowSize;
    dbf.fill(0x20, at, at + rowSize);
    at++;
    row.forEach((value, i) => {
      String(value).split('').forEach((c, k) => (dbf[at + k] = c.charCodeAt(0)));
      at += columns[i][1];
    });
  });
  return zipSync({ 'index.shp': shp, 'index.dbf': dbf, ...(prj ? { 'index.prj': new TextEncoder().encode(prj) } : {}) });
}

/** UTM zone 30 or 32 metres of a lon/lat. */
const utm = (zone: number, lon: number, lat: number) => proj4('EPSG:4326', `+proj=utm +zone=${zone} +ellps=GRS80 +units=m`, [lon, lat]);

describe('Rhineland-Palatinate', () => {
  const links = [
    '<feed>',
    '<link rel="section" href="https://geobasis-rlp.de/data/las/current/las/lpolpg_32_446_5538_1_rp.laz" bbox="49.98, 8.24, 49.99, 8.26" size="156000000"/>',
    '<link rel="section" href="https://geobasis-rlp.de/data/las/current/las/lpolpg_32_312_5571_1_rp.laz" bbox="50.27, 6.38, 50.28, 6.40" size="90000000"/>',
    '<link rel="alternate" href="https://example.com/other.laz" bbox="49.98, 8.24, 49.99, 8.26"/>',
    '</feed>',
  ].join('\n');

  it('reads boxes given as lat, lon and keeps only the state\'s own files', () => {
    const tiles = rlpTiles(links);
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toEqual({ url: 'https://geobasis-rlp.de/data/las/current/las/lpolpg_32_446_5538_1_rp.laz', box: [8.24, 49.98, 8.26, 49.99], size: 156000000 });
  });

  it('lists the tiles under an area as one survey with two classes', async () => {
    const { fetcher } = fakeFetcher((url) => (url.endsWith('atomfeed-links.xml') ? links : undefined));
    const [survey] = await rlp.discover(fetcher, around(8.25, 49.985), []);
    expect(survey.tiles!.map((t) => t.size)).toEqual([156000000]);
    expect(survey.classification).toEqual({ '2': 'ground', '20': 'unclassified' });
  });
});

describe('Brandenburg', () => {
  it('names each ZIP after its sheet and takes the dates from the WFS', async () => {
    const { fetcher, requested } = fakeFetcher((url) =>
      url.startsWith('https://isk.geobasis-bb.de/')
        ? {
            type: 'FeatureCollection',
            features: [
              { type: 'Feature', geometry: square(13.045, 52.397, 13.06, 52.406), properties: { sheetnr: '33367-5807', creationdate: '2017-12-27' } },
              { type: 'Feature', geometry: square(13.06, 52.397, 13.075, 52.406), properties: { sheetnr: '33368-5807', creationdate: '2019-03-01' } },
            ],
          }
        : undefined,
    );
    const [survey] = await brandenburg.discover(fetcher, around(13.06, 52.4), []);
    expect(survey.tiles!.map((t) => t.url)).toEqual(['https://data.geobasis-bb.de/geobasis/daten/als/laz/als_33367-5807.zip', 'https://data.geobasis-bb.de/geobasis/daten/als/laz/als_33368-5807.zip']);
    expect(survey).toMatchObject({ acquisitionStart: '2017-12-27', acquisitionEnd: '2019-03-01', projectYearHint: 2019 });
    // The WFS takes its box as lat, lon.
    expect(requested[0]).toMatch(/BBOX=52\.39\d*,13\.05\d*,52\.40\d*,13\.06\d*,/);
  });

  it('falls back to the file listing, without dates, when the WFS is down', async () => {
    const listing = new TextEncoder().encode('<!DOCTYPE html><a href="als_33367-5807.zip">als_33367-5807.zip</a> <a href="als_33368-5807.zip">x</a>');
    const { fetcher } = fakeFetcher((url) => (url === 'https://data.geobasis-bb.de/geobasis/daten/als/laz/' ? listing : undefined));
    const [survey] = await brandenburg.discover(fetcher, around(13.06, 52.4, 0.003), []);
    expect(survey.tiles!.map((t) => t.url.split('/').at(-1))).toEqual(['als_33367-5807.zip', 'als_33368-5807.zip']);
    expect(survey.acquisitionStart).toBeUndefined();
  });

  it('finds nothing where an empty collection leaves out its features', async () => {
    const { fetcher } = fakeFetcher(() => ({ type: 'FeatureCollection' }));
    expect(await brandenburg.discover(fetcher, around(13.4, 52.52), [])).toEqual([]);
  });
});

describe('Luxembourg', () => {
  it('finds the block and member of each 500 m tile from the grid', async () => {
    const resources = [
      { title: 'lidar2024-c020-r013.zip', url: 'https://download.data.public.lu/resources/x/20241130/lidar2024-c020-r013.zip', filesize: 1700086212 },
      { title: 'lidar2024-ta.gpkg', url: 'https://download.data.public.lu/resources/x/ta.gpkg', filesize: 3 },
    ];
    const { fetcher } = fakeFetcher((url) => (url.startsWith('https://data.public.lu/api/') ? { resources } : undefined));
    // Inside tile 77000-77500 x 74500-75000 of LUREF, block c020 r013.
    const [lon, lat] = proj4('+proj=tmerc +lat_0=49.8333333333333 +lon_0=6.16666666666667 +k=1 +x_0=80000 +y_0=100000 +ellps=intl +towgs84=-189.681,18.3463,-42.7695,-0.33746,-3.09264,2.53861,0.4598 +units=m', 'EPSG:4326', [77250, 74750]);
    const [survey] = await luxembourg.discover(fetcher, around(lon, lat, 0.001), []);
    expect(survey.tiles).toHaveLength(1);
    expect(survey.tiles![0]).toMatchObject({ url: resources[0].url, member: '77000_75000.laz', size: 1700086212, horizontalCrs: 'EPSG:2169' });
    expect(survey.classification!['13']).toBe('bridge');
  });
});

describe('Scotland', () => {
  it('asks the portal with "intersects" and makes one survey per collection, dates in order', async () => {
    let asked = '';
    const product = (collection: string, ref: string, begin: string, end: string) => ({
      collectionName: collection,
      metadata: { temporalExtent: { begin, end }, useConstraints: 'The following attribution statement must be used to acknowledge the source of the information: Crown copyright Scottish Government. Rest.' },
      data: { product: { http: { url: `https://srsp-open-data.s3-eu-west-2.amazonaws.com/lidar/x/${ref}.laz`, size: 1000 } } },
      footprint: { type: 'MultiPolygon', coordinates: [[[[-3.218, 55.935], [-3.202, 55.935], [-3.202, 55.944], [-3.218, 55.944], [-3.218, 55.935]]]] },
    });
    const { fetcher } = fakeFetcher((url, body) => {
      if (!url.startsWith('https://api.remotesensing.data.gov.scot/')) return undefined;
      asked = body ?? '';
      return {
        result: [
          product('scotland-gov/lidar/phase-5/laz', 'NT2472_4PPM_LAS_PHASE5', '2021-04-12', '2020-05-28'),
          product('scotland-gov/lidar/phase-2/laz', 'NT27NW_2PPM_LAS_PHASE2', '2012-11-29', '2014-04-18'),
        ],
      };
    });
    const surveys = await scotland.discover(fetcher, around(-3.21, 55.94), []);
    expect(JSON.parse(asked)).toMatchObject({ spatialop: 'intersects' });
    // Phase 2 is non-commercial and never asked for, nor kept if it came back.
    expect(surveys.map((s) => s.name)).toEqual(['Scotland LiDAR Phase 5']);
    expect(surveys[0]).toMatchObject({ acquisitionStart: '2020-05-28', acquisitionEnd: '2021-04-12', attribution: 'Crown copyright Scottish Government', verticalUnits: 'm' });
    expect(surveys[0].tiles![0]).toMatchObject({ horizontalCrs: 'EPSG:27700', size: 1000 });
  });
});

describe('Slovenia', () => {
  it('outlines each root by its source tiles near the area, with their density', async () => {
    const { fetcher } = fakeFetcher((url) => {
      if (url.endsWith('/2023/ept.json')) return { boundsConforming: [420999, 30999, -310, 557001, 167000, 2560] };
      if (url.endsWith('/ept.json')) return { boundsConforming: [0, 0, 0, 1, 1, 1] };
      if (url.endsWith('/2023/ept-sources/manifest.json'))
        return [
          { bounds: [462000, 101000, 0, 463000, 102000, 1], points: 30e6 },
          { bounds: [500000, 50000, 0, 501000, 51000, 1], points: 1 },
        ];
      return undefined;
    });
    // Ljubljana is in source 462/101 of the Slovene grid.
    const [lon, lat] = proj4('+proj=tmerc +lat_0=0 +lon_0=15 +k=0.9999 +x_0=500000 +y_0=-5000000 +ellps=GRS80 +units=m', 'EPSG:4326', [462500, 101500]);
    const surveys = await slovenia.discover(fetcher, around(lon, lat), []);
    expect(surveys.map((s) => s.id)).toEqual(['2023']);
    expect(surveys[0].coverage).toHaveLength(1);
    expect(surveys[0].densityM2).toBeCloseTo(30, 6);
    expect(surveys[0].classification!['8']).toBe('building');
  });
});

describe('Basque Country', () => {
  it('puts each 500 m tile in its sheet folder, named by its corner in hectometres', async () => {
    const [x, y] = utm(30, -2.935, 43.263);
    const x0 = Math.floor(x / 500) * 500;
    const y0 = Math.floor(y / 500) * 500;
    const index = zippedShapefile([[x0, y0, x0 + 500, y0 + 500]], [['NAME', 40], ['fecha', 8], ['SC50CLAS', 10]], [['PNOA_2016_PV_x', '20171206', '61']]);
    const { fetcher } = fakeFetcher((url) => (url.endsWith('HOJAS_LAS_LIDAR_2017_ETRS89.zip') ? index : undefined));
    const [survey] = await basque.discover(fetcher, around(-2.935, 43.263, 0.0005), []);
    expect(survey.tiles![0].url).toBe(`https://www.geo.euskadi.eus/lidar/DatosDescarga/LIDAR/LIDAR_2017_ETRS89/061/${x0 / 100}-${y0 / 100}.laz`);
    expect(survey.acquisitionEnd).toBe('2017-12-06');
  });
});

describe('Trentino', () => {
  it('takes file names from the index', async () => {
    const [x, y] = utm(32, 11.1217, 46.07);
    const x0 = Math.floor(x / 500) * 500;
    const y0 = Math.floor(y / 500) * 500;
    const name = `5h${x0 / 100}${y0 / 100}`;
    const index = zippedShapefile([[x0, y0, x0 + 500, y0 + 500]], [['n_tavola', 20]], [[name]]);
    const { fetcher } = fakeFetcher((url) => (url.includes('siatservices.provincia.tn.it/idt/vector/') ? index : undefined));
    const [survey] = await trentino.discover(fetcher, around(11.1217, 46.07, 0.0005), []);
    expect(survey.tiles!.map((t) => t.url)).toEqual([`https://siatservices.provincia.tn.it/stemdata/2014_lidar_laz/${name}.laz`]);
  });
});

describe('Helsinki', () => {
  it('offers each sheet from both years, read whole', async () => {
    const { fetcher } = fakeFetcher((url) =>
      url.startsWith('https://kartta.hel.fi/') ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: square(24.928, 60.161, 24.937, 60.165), properties: { tunnus: '672496a' } }] } : undefined,
    );
    const surveys = await helsinki.discover(fetcher, around(24.93, 60.163), []);
    expect(surveys.map((s) => s.name)).toEqual(['Helsinki laser data 2021', 'Helsinki laser data 2017']);
    expect(surveys[0].tiles![0]).toMatchObject({ url: 'https://ptp.hel.fi/DataHandlers/Lidar_kaikki/Default.ashx?q=672496a&y=2021', whole: true, horizontalCrs: 'EPSG:3879' });
  });
});

describe('Berlin', () => {
  it('reads the tiles from each district ZIP\'s directory', async () => {
    const mitte = zipSync({ '3dm_33_392_5820_1_be.las': [new Uint8Array(10), { level: 0 }], 'readme.txt': new Uint8Array(3) });
    const empty = zipSync({ 'readme.txt': new Uint8Array(3) });
    const { fetcher } = fakeFetcher((url) => (url.endsWith('/Mitte.zip') ? mitte : url.endsWith('.zip') ? empty : undefined));
    const [lon, lat] = proj4('+proj=utm +zone=33 +ellps=GRS80 +units=m', 'EPSG:4326', [392500, 5820500]);
    const [survey] = await berlin.discover(fetcher, around(lon, lat, 0.001), []);
    expect(survey.tiles).toEqual([expect.objectContaining({ url: 'https://gdi.berlin.de/data/a_als/atom/Mitte.zip', member: '3dm_33_392_5820_1_be.las', size: mitte.length })]);
  });
});

describe('Flai', () => {
  it('describes a dataset its inventory leaves out from the folder name', () => {
    expect(unlistedDataset('data/ES/CNIG/Lidar_2015-2021_epsg25830')).toMatchObject({ epsg: 25830, path: 'data/ES/CNIG/Lidar_2015-2021_epsg25830/copc', start: '2015-01-01', end: '2021-12-31' });
    expect(unlistedDataset('data/LV/GeoRiga/Lidar_2022')).toMatchObject({ epsg: 0, name: 'LV GeoRiga / Lidar_2022', start: '2022-01-01' });
  });

  it('finds the PNOA third coverage by its tile names, in the UTM zone they turn up in', async () => {
    const bucket = 'https://open-lidar-data.s3.eu-central-1.amazonaws.com/';
    const folders = (prefixes: string[]) => `<ListBucketResult><IsTruncated>false</IsTruncated>${prefixes.map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join('')}</ListBucketResult>`;
    const keys = (list: string[]) => `<ListBucketResult><IsTruncated>false</IsTruncated>${list.map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`).join('')}</ListBucketResult>`;
    const copc = 'data/ES/CNIG/Lidar_2022-2025/copc/';
    // Zaragoza: zone 30, in the square 675-676 km E, 4611-4612 km N.
    const [x, y] = utm(30, -0.8773, 41.6561);
    const tileName = `${copc}PNOA_2023_ARA_${Math.floor(x / 1000)}-${Math.floor(y / 1000) + 1}_NPC01.copc.laz`;
    const { fetcher } = fakeFetcher((url) => {
      // The inventory lists only a dataset far away, so this one comes from the bucket.
      if (url.endsWith('README.md')) return '| Finland | 3067 | data/FI/NLS/05p_year_2023/copc | 2023-01-01 | 2023-12-31 | 0.78 | CC-BY-4.0 |';
      if (!url.startsWith(bucket)) return undefined;
      const prefix = decodeURIComponent(/prefix=([^&]*)/.exec(url)?.[1] ?? '');
      if (url.includes('delimiter=/')) {
        if (prefix === 'data/') return folders(['data/ES/', 'data/FI/']);
        if (prefix === 'data/ES/') return folders(['data/ES/CNIG/']);
        if (prefix === 'data/ES/CNIG/') return folders(['data/ES/CNIG/Lidar_2022-2025/']);
        if (prefix === 'data/ES/CNIG/Lidar_2022-2025/') return folders([copc]);
      }
      if (url.includes('delimiter=_')) {
        if (prefix === `${copc}PNOA_`) return folders([`${copc}PNOA_2023_`]);
        if (prefix === `${copc}PNOA_2023_`) return folders([`${copc}PNOA_2023_ARA_`]);
      }
      return keys(prefix === `${copc}PNOA_2023_ARA_${Math.floor(x / 1000)}-` ? [tileName] : []);
    });
    const failures: { source: string; reason: string }[] = [];
    const surveys = await flai.discover(fetcher, around(-0.8773, 41.6561, 0.0005), failures);
    expect(failures).toEqual([]);
    expect(surveys.map((s) => s.id)).toEqual(['data/ES/CNIG/Lidar_2022-2025']);
    expect(surveys[0].tiles).toEqual([expect.objectContaining({ url: bucket + tileName, horizontalCrs: 'EPSG:25830' })]);
  });
});
