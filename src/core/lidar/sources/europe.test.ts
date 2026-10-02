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
import { flai, pnoaRegion, unlistedDataset } from './flai';
import { genova } from './genova';
import { halle } from './halle';
import { helsinki } from './helsinki';
import { luxembourg } from './luxembourg';
import { rlp, rlpTiles } from './rlp';
import { scotland } from './scotland';
import { slovenia } from './slovenia';
import { trentino } from './trentino';
import { turku } from './turku';
import { zippedShapefile } from './test-shapefile';

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
    const [lon, lat] = proj4('+proj=utm +zone=32 +ellps=GRS80 +units=m', 'EPSG:4326', [446500, 5538500]);
    const [survey] = await rlp.discover(fetcher, around(lon, lat, 0.001), []);
    expect(survey.tiles!.map((t) => t.size)).toEqual([156000000]);
    expect(survey.classification).toEqual({ '2': 'ground', '20': 'unclassified' });
  });

  it("goes by the tiles' squares in UTM, not the feed's lon/lat boxes", async () => {
    // The feed's boxes for two tiles one above the other, as it gives them: they overlap by about 10 m.
    const feed = [
      '<feed>',
      '<link rel="section" href="https://geobasis-rlp.de/data/las/current/las/lpolpg_32_447_5537_1_rp.laz" bbox="49.98298, 8.26059, 49.99206, 8.27467" size="149776746"/>',
      '<link rel="section" href="https://geobasis-rlp.de/data/las/current/las/lpolpg_32_447_5538_1_rp.laz" bbox="49.99197, 8.26045, 50.00105, 8.27454" size="146008947"/>',
      '</feed>',
    ].join('\n');
    const { fetcher } = fakeFetcher((url) => (url.endsWith('atomfeed-links.xml') ? feed : undefined));
    // Ends about 5 m short of northing 5538000 on the east side, but inside the upper tile's box.
    const [survey] = await rlp.discover(fetcher, { west: 8.272, south: 49.99, east: 8.274, north: 49.992 }, []);
    expect(survey.tiles!.map((t) => t.url.split('/').pop())).toEqual(['lpolpg_32_447_5537_1_rp.laz']);
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

  it('leaves out sheets a year lacks, which answer with a short message, and gives each year a density', async () => {
    const files: Record<string, number> = { '672496a&y=2021': 90e6, '672496a&y=2017': 36e6, '666498a&y=2021': 65, '666498a&y=2017': 65, '674490a&y=2021': 65, '674490a&y=2017': 30e6 };
    const fetcher = {
      json: async () => ({
        type: 'FeatureCollection',
        features: ['672496a', '666498a', '674490a'].map((tunnus) => ({ type: 'Feature', geometry: square(24.928, 60.161, 24.937, 60.165), properties: { tunnus } })),
      }),
      size: async (url: string) => files[url.split('?q=')[1]],
    } as unknown as Fetcher;
    const surveys = await helsinki.discover(fetcher, around(24.93, 60.163), []);
    expect(surveys.map((s) => [s.name, s.densityM2, s.tiles!.map((t) => [t.url.split('?q=')[1], t.size])])).toEqual([
      ['Helsinki laser data 2021', 60, [['672496a&y=2021', 90e6]]],
      ['Helsinki laser data 2017', 32, [['672496a&y=2017', 36e6], ['674490a&y=2017', 30e6]]],
    ]);
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

  // A bucket holding the third coverage's blocks, each with the tile names given.
  const pnoaBucket = (blocks: Record<string, string[]>) => {
    const bucket = 'https://open-lidar-data.s3.eu-central-1.amazonaws.com/';
    const copc = 'data/ES/CNIG/Lidar_2022-2025/copc/';
    const folders = (prefixes: string[]) => `<ListBucketResult><IsTruncated>false</IsTruncated>${prefixes.map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join('')}</ListBucketResult>`;
    const keys = (list: string[]) => `<ListBucketResult><IsTruncated>false</IsTruncated>${list.map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`).join('')}</ListBucketResult>`;
    return fakeFetcher((url) => {
      if (url.endsWith('README.md')) return '| Finland | 3067 | data/FI/NLS/05p_year_2023/copc | 2023-01-01 | 2023-12-31 | 0.78 | CC-BY-4.0 |';
      if (!url.startsWith(bucket)) return undefined;
      const prefix = decodeURIComponent(/prefix=([^&]*)/.exec(url)?.[1] ?? '');
      if (url.includes('delimiter=/')) {
        if (prefix === 'data/') return folders(['data/ES/']);
        if (prefix === 'data/ES/') return folders(['data/ES/CNIG/']);
        if (prefix === 'data/ES/CNIG/') return folders(['data/ES/CNIG/Lidar_2022-2025/']);
        if (prefix === 'data/ES/CNIG/Lidar_2022-2025/') return folders([copc]);
      }
      if (url.includes('delimiter=_')) {
        if (prefix === `${copc}PNOA_`) return folders([`${copc}PNOA_2023_`]);
        if (prefix === `${copc}PNOA_2023_`) return folders(Object.keys(blocks).map((b) => `${copc}PNOA_2023_${b}_`));
      }
      const all = Object.entries(blocks).flatMap(([b, names]) => names.map((n) => `${copc}PNOA_2023_${b}_${n}_NPC01.copc.laz`));
      return keys(all.filter((k) => k.startsWith(prefix)));
    });
  };
  const pnoaName = (zone: number, lon: number, lat: number) => {
    const [x, y] = utm(zone, lon, lat);
    return `${Math.floor(x / 1000)}-${Math.floor(y / 1000) + 1}`;
  };

  it("doesn't take a PNOA tile for a square with the same numbers in another zone", async () => {
    // Ponferrada's square in zone 29 has the same name as one of Aragón's in
    // zone 30, and Dénia's in zone 31 one of Extremadura's.
    for (const [lon, lat, zone, block] of [
      [-6.5983, 42.5464, 29, 'ARA'],
      [-6.7567, 41.8061, 29, 'ARA'],
      [0.1057, 38.8408, 31, 'EXT'],
    ] as [number, number, number, string][]) {
      const { fetcher } = pnoaBucket({ [block]: [pnoaName(zone, lon, lat)] });
      expect(await flai.discover(fetcher, around(lon, lat, 0.0005), [])).toEqual([]);
    }
  });

  it('reads every PNOA block meeting the area, in whichever zone each turns up in', async () => {
    // Fraga, on the Aragón side of Catalonia: one block's tile named in zone 30, the other's in zone 31.
    const [lon, lat] = [0.3496, 41.5226];
    const { fetcher } = pnoaBucket({ ARA: [pnoaName(30, lon, lat)], CAT: [pnoaName(31, lon, lat)], XYZ: [pnoaName(30, lon, lat)] });
    const [survey] = await flai.discover(fetcher, around(lon, lat, 0.0005), []);
    expect(survey.tiles!.map((t) => [t.url.split('/').pop(), t.horizontalCrs])).toEqual([
      [`PNOA_2023_ARA_${pnoaName(30, lon, lat)}_NPC01.copc.laz`, 'EPSG:25830'],
      [`PNOA_2023_CAT_${pnoaName(31, lon, lat)}_NPC01.copc.laz`, 'EPSG:25831'],
    ]);
  });

  it('knows where a PNOA block can be from its region code', () => {
    expect(pnoaRegion('data/ES/CNIG/Lidar_2022-2025/copc/PNOA_2023_ARA_')).toEqual([-2.2, 39.8, 0.8, 42.95]);
    expect(pnoaRegion('x/PNOA_2021_CyL-NW_')).toEqual([-7.1, 40.05, -1.75, 43.25]);
    // Too wide to tell squares 6 degrees apart, or unknown.
    expect(pnoaRegion('x/PNOA_2016_MUR-VAL-CLM_')).toBeNull();
    expect(pnoaRegion('x/PNOA_2009_Lote3_')).toBeNull();
  });

  it('reads heights without units of their own as metres', async () => {
    const { fetcher } = pnoaBucket({ ARA: [pnoaName(30, -0.8773, 41.6561)] });
    const [survey] = await flai.discover(fetcher, around(-0.8773, 41.6561, 0.0005), []);
    expect(survey.verticalUnits).toBe('m');
  });
});

describe('Halle', () => {
  it("reads the 2 km tiles from the ZIP's directory, grouped by year", async () => {
    const zip = zipSync({
      'Gemeinde_HalleSaale/3dm_32_704_5704_2_st_2017.laz': [new Uint8Array(10), { level: 0 }],
      'Gemeinde_HalleSaale/3dm_32_714_5708_2_st_2021.laz': [new Uint8Array(12), { level: 0 }],
    });
    const { fetcher } = fakeFetcher((url) => (url.endsWith('Gemeinde_HalleSaale.zip') ? zip : undefined));
    const [lon, lat] = proj4('+proj=utm +zone=32 +ellps=GRS80 +units=m', 'EPSG:4326', [705000, 5705000]);
    const surveys = await halle.discover(fetcher, around(lon, lat, 0.001), []);
    expect(surveys.map((s) => [s.name, s.projectYearHint])).toEqual([['Halle (Saale) 3D-Messdaten 2017', 2017]]);
    expect(surveys[0].tiles).toEqual([expect.objectContaining({ member: 'Gemeinde_HalleSaale/3dm_32_704_5704_2_st_2017.laz', bytes: 10, horizontalCrs: 'EPSG:25832' })]);
  });
});

describe('Genova', () => {
  it('takes the LAS sheets from the WFS in one request', async () => {
    const { fetcher, requested } = fakeFetcher((url) =>
      url.startsWith('https://mappe.comune.genova.it/geoserver/wfs')
        ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: square(8.9155, 44.3989, 8.9366, 44.4116), properties: { LINK_LAS: 'LAS3830.las' } }] }
        : undefined,
    );
    const [survey] = await genova.discover(fetcher, around(8.93, 44.405), []);
    expect(requested).toHaveLength(1);
    expect(requested[0]).not.toContain('startIndex');
    expect(survey.tiles).toEqual([expect.objectContaining({ url: 'https://mappe.comune.genova.it/gis/rilievo/LAS/LAS3830.las', horizontalCrs: 'EPSG:7791' })]);
  });
});

describe('Turku', () => {
  it('finds sheets from its table, named after their west and north edges', async () => {
    // Inside sheet 23460000_6705000 in the centre (E 23460000-23460500, N 6704500-6705000).
    const [survey] = await turku.discover(null as never, around(22.2777, 60.4529, 0.0005), []);
    expect(survey.tiles!.map((t) => t.url)).toEqual(['https://turku.asiointi.fi/3d/pistepilvi/23460000_6705000.laz']);
    expect(await turku.discover(null as never, around(22.0, 60.7, 0.001), [])).toEqual([]);
  });
});
