// US state and city providers against canned catalog answers: Illinois,
// Wisconsin, DC, Alaska, ARPA-I and USGS's staged LAZ.

import proj4 from 'proj4';
import { describe, expect, it } from 'vitest';
import type { GeoBounds } from '../../types';
import { setProjector } from '../read/crs';
import type { Fetcher } from '../read/fetcher';
import { alaska } from './alaska';
import { arpai } from './arpai';
import { setCorsProxy } from '../../data/corsProxy';
import { usgsStaged } from './usgsstaged';
import { dc } from './dc';
import { illinois } from './illinois';
import { wisconsin } from './wisconsin';

setProjector((from, to) => proj4(from, to));

function fakeFetcher(route: (url: string) => string | object | undefined) {
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
  };
  return { fetcher: fetcher as unknown as Fetcher, requested };
}

const ring = (w: number, s: number, e: number, n: number) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const square = (w: number, s: number, e: number, n: number) => ({ type: 'Polygon', coordinates: [ring(w, s, e, n)] });
const listing = (keys: [string, number][]) =>
  `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${keys.map(([key, size]) => `<Contents><Key>${key}</Key><Size>${size}</Size><ETag>&quot;x&quot;</ETag></Contents>`).join('')}</ListBucketResult>`;

describe('Illinois', () => {
  const loop: GeoBounds = { west: -87.632, south: 41.876, east: -87.627, north: 41.879 };
  const tile = (name: string, year: string, url: string, zone = 'East') => ({
    type: 'Feature',
    properties: { CollectionName: name, CollectionYear: year, TileURL: url, SPCS_Zone: zone },
    geometry: square(-87.6329, 41.8741, -87.6238, 41.881),
  });

  it('groups tiles by collection and leaves out the old QL3 ones', async () => {
    const { fetcher, requested } = fakeFetcher(() => ({
      type: 'FeatureCollection',
      features: [
        tile('Cook', '2017', 'https://clearinghouse.isgs.illinois.edu/las/district1/cook/2017/las/LAS_17508975.las'),
        tile('Cook', '2022', 'https://clearinghouse.isgs.illinois.edu/las/district1/cook/2022/las/17508975.las'),
        tile('Cook', '2009-2011', 'https://clearinghouse.isgs.illinois.edu/las/district1/cook/2009/las/x.las'),
        tile('Christian', '2024', 'https://clearinghouse.isgs.illinois.edu/las/district6/christian/2024/laz/2475_1001.laz', 'West'),
        tile('Cook', '2022', 'ftp://clearinghouse.isgs.illinois.edu/x.las'),
      ],
    }));
    const surveys = await illinois.discover(fetcher, loop, []);
    expect(requested[0]).toContain('geometry=-87.632,41.876,-87.627,41.879');
    expect(surveys.map((s) => [s.name, s.format, s.projectYearHint, s.tiles!.length])).toEqual([
      ['Illinois Cook 2017', 'LAZ', 2017, 1],
      ['Illinois Cook 2022', 'LAZ', 2022, 1],
      ['Illinois Christian 2024', 'LAZ', 2024, 1],
    ]);
    // Files before LAS 1.4 may only have GeoTIFF keys with a user-defined projection.
    expect(surveys[2].tiles![0].horizontalCrs).toBe('EPSG:3436');
    expect(surveys[1].classification!['11']).toBe('ground');
  });
});

describe('Wisconsin', () => {
  const capitol: GeoBounds = { west: -89.386, south: 43.073, east: -89.382, north: 43.076 };

  it("reads only the listed datasets' indexes that meet the area", async () => {
    const { fetcher, requested } = fakeFetcher((url) => {
      if (url.endsWith('Dane_Classified_LAS_USGS_2024.geojson'))
        return {
          type: 'FeatureCollection',
          features: [
            { type: 'Feature', properties: { downloadUrl: 'https://web.s3.wisc.edu/wsco-wisconsinview/lidar/Dane/Dane_2024_3DEP_Delivery/Classified_LAS/Classified_LAS/819481.laz' }, geometry: square(-89.39, 43.07, -89.38, 43.08) },
            { type: 'Feature', properties: { downloadUrl: 'https://web.s3.wisc.edu/wsco-wisconsinview/lidar/Dane/far.laz' }, geometry: square(-89.5, 43.0, -89.49, 43.01) },
          ],
        };
      if (url.endsWith('CityofMadison_classified_LAS_City_2022.geojson')) return { type: 'FeatureCollection', features: [] };
      return undefined;
    });
    const surveys = await wisconsin.discover(fetcher, capitol, []);
    expect(requested.map((u) => u.split('/').pop())).toEqual(['Dane_Classified_LAS_USGS_2024.geojson', 'CityofMadison_classified_LAS_City_2022.geojson']);
    expect(surveys).toHaveLength(1);
    expect(surveys[0]).toMatchObject({ name: 'Wisconsin Dane County 2024', format: 'LAZ', projectYearHint: 2024 });
    expect(surveys[0].tiles!.map((t) => t.url.split('/').pop())).toEqual(['819481.laz']);
  });
});

describe('DC', () => {
  const whiteHouse: GeoBounds = { west: -77.038, south: 38.896, east: -77.035, north: 38.899 };

  it('finds whole LAS tiles in the ImageServer catalog, sized from their point counts', async () => {
    const { fetcher, requested } = fakeFetcher(() => ({
      features: [
        { attributes: { OBJECTID: 120, Name: '2016', PointCount: 7787464 }, geometry: { rings: [ring(-77.0392, 38.8936, -77.03, 38.9008)] } },
        { attributes: { OBJECTID: 9, Name: 'Overview', PointCount: 1 }, geometry: { rings: [ring(-77.1, 38.8, -76.9, 39.0)] } },
      ],
    }));
    const [survey, ...rest] = await dc.discover(fetcher, whiteHouse, []);
    expect(rest).toEqual([]);
    expect(requested[0]).toContain('where=Category%3D1');
    expect(survey).toMatchObject({ format: 'LAZ', projectYearHint: 2024, license: 'CC0 1.0' });
    expect(survey.densityM2).toBeCloseTo(7787464 / 636000, -0.5);
    expect(survey.tiles).toEqual([
      expect.objectContaining({
        url: 'https://imagery.dcgis.dc.gov/dcgis/rest/services/Lidar/Classified_LAS_2024/ImageServer/file?id=.%5CLidar_2024%5CLAS_Point_Cloud%5C2016.las&rasterId=120',
        size: 7787464 * 30,
        whole: true,
      }),
    ]);
  });

  it('reports a catalog error', async () => {
    const { fetcher } = fakeFetcher(() => ({ error: { code: 400, message: 'Invalid query' } }));
    await expect(dc.discover(fetcher, whiteHouse, [])).rejects.toThrow(/Invalid query/);
  });
});

describe('Alaska', () => {
  // Inside the south-west quarter of tile 176/788 in zone 6 (362500-363250 E, 6681250-6682000 N).
  const seward: GeoBounds = { west: -149.4822, south: 60.2456, east: -149.4804, north: 60.2465 };
  const folder = 'ak_alaska_pointcloud/soa_fema_seward_seward/point_cloud/tilecls/orthometric/utm_zone_06/';

  it("lists a column's tiles and keeps the quarters under the area", async () => {
    const { fetcher, requested } = fakeFetcher((url) =>
      url.includes(encodeURIComponent(`${folder}UTM6_0176_`))
        ? listing([
            [`${folder}UTM6_0176_0788_1_2023.copc.laz`, 60e6],
            [`${folder}UTM6_0176_0788_2_2023.copc.laz`, 61e6],
            [`${folder}UTM6_0176_0788_3_2023.copc.laz`, 62e6],
            [`${folder}UTM6_0176_0788_4_2023.copc.laz`, 63e6],
            [`${folder}UTM6_0176_0700_1_2023.copc.laz`, 64e6],
          ])
        : listing([]),
    );
    const surveys = await alaska.discover(fetcher, seward, []);
    expect(requested).toHaveLength(1);
    expect(surveys).toHaveLength(1);
    expect(surveys[0]).toMatchObject({ name: 'Alaska Seward 2023', format: 'COPC', verticalUnits: 'm' });
    expect(surveys[0].tiles!.map((t) => [t.url.split('/').pop(), t.size, t.horizontalCrs])).toEqual([['UTM6_0176_0788_3_2023.copc.laz', 62e6, 'EPSG:6335']]);
  });
});

describe('ARPA-I INSIGHTS', () => {
  it("reads a flight area's one COPC, for LiDAR only models", async () => {
    const downtown: GeoBounds = { west: -111.893, south: 40.759, east: -111.889, north: 40.762 };
    const [survey, ...rest] = await arpai.discover(null as never, downtown, []);
    expect(rest).toEqual([]);
    expect(survey).toMatchObject({ format: 'COPC', unclassified: true, projectYearHint: 2025 });
    expect(survey.tiles!.map((t) => t.url)).toEqual(['https://arpa-i-insights.s3.amazonaws.com/lidar/v1/data/SLC/Dissemination/L3_unified_copc/SLC.copc.laz']);
    expect(await arpai.discover(null as never, { west: -112.1, south: 40.5, east: -112.05, north: 40.55 }, [])).toEqual([]);
  });
});

describe('USGS staged LAZ', () => {
  const clifton: GeoBounds = { west: -84.516, south: 39.13, east: -84.514, north: 39.132 };
  const staged = 'https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/';
  const item = (path: string, box = { minX: -84.5175, minY: 39.1287, maxX: -84.513, maxY: 39.1323 }) => ({ downloadURL: staged + path, sizeInBytes: 22312578, boundingBox: box });
  const route = (url: string) => {
    if (url.startsWith('https://raw.githubusercontent.com/')) return { features: [{ properties: { name: 'OH_StatewideP3_7_B21' } }, { properties: { name: 'USGS_LPC_IL_4County_Cook_2017_LAS_2019' } }] };
    if (url.startsWith('https://tnmaccess.nationalmap.gov/'))
      return {
        total: 5,
        items: [
          item('OH_Statewide_Phase3_2021_B21/OH_StatewideP3_6_B21/LAZ/USGS_LPC_OH_Statewide_Phase3_2021_B21_BS13960417.laz'),
          item('OH_Statewide_Phase3_2021_B21/OH_StatewideP3_7_B21/LAZ/a.laz'),
          item('IL_4County_Cook_2017/IL_4County_Cook_2017/LAZ/b.laz'),
          item('legacy/OH_SOUTH_2007/LAZ/USGS_LPC_OH_SOUTH_2007_001831.laz'),
          item('OH_Statewide_Phase3_2021_B21/OH_StatewideP3_6_B21/LAZ/far.laz', { minX: -84.6, minY: 39.0, maxX: -84.59, maxY: 39.01 }),
        ],
      };
    return undefined;
  };

  it("finds work units USGS's mirror hasn't built, only with a way past CORS", async () => {
    expect(await usgsStaged.discover(fakeFetcher(route).fetcher, clifton, [])).toEqual([]);
    setCorsProxy('direct');
    try {
      const surveys = await usgsStaged.discover(fakeFetcher(route).fetcher, clifton, []);
      expect(surveys.map((s) => [s.id, s.format, s.projectYearHint])).toEqual([['OH_StatewideP3_6_B21', 'LAZ', 2021]]);
      expect(surveys[0].tiles).toEqual([expect.objectContaining({ url: expect.stringMatching(/BS13960417\.laz$/), size: 22312578 })]);
    } finally {
      setCorsProxy(null);
    }
  });
});
