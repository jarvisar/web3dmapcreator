// TxGIO, Anchorage, LidarBC and Quebec's MRNF against canned answers: how
// each turns its index into tiles, names, dates, CRS and classes.

import { zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { setCorsProxy } from '../../data/corsProxy';
import { HttpError } from '../../data/http';
import type { GeoBounds } from '../../types';
import type { Fetcher } from '../read/fetcher';
import { anchorage } from './anchorage';
import { flightDates, lidarbc } from './lidarbc';
import { projectName, quebec } from './quebec';
import { memberCell, nameParts, quarterQuad, quarterQuads, texas } from './texas';

afterEach(() => setCorsProxy(null));

function fakeFetcher(route: (url: string) => string | object | Uint8Array | undefined) {
  const requested: string[] = [];
  const get = (url: string) => {
    requested.push(url);
    const answer = route(url);
    if (answer === undefined) throw new HttpError(404, url);
    return answer;
  };
  const fetcher = {
    downloaded: 0,
    json: async (url: string) => get(url),
    text: async (url: string) => get(url) as string,
    range: async (url: string, start: number, end: number) => {
      const bytes = get(url) as Uint8Array;
      if (end > bytes.length) throw new Error(`Range past the end of ${url}`);
      return bytes.slice(start, end).buffer;
    },
    size: async (url: string) => (get(url) as Uint8Array).length,
  };
  return { fetcher: fetcher as unknown as Fetcher, requested };
}

const around = (lon: number, lat: number, d = 0.002): GeoBounds => ({ west: lon - d, south: lat - d, east: lon + d, north: lat + d });
const square = (w: number, s: number, e: number, n: number) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const feature = (properties: object, geometry: object) => ({ type: 'Feature', properties, geometry });
const collection = (features: object[]) => ({ type: 'FeatureCollection', features });

/** A LAS 1.4 header claiming `points` points, padded so it deflates like a real member's start. */
function lasFile(points: number): Uint8Array {
  const bytes = new Uint8Array(4096);
  bytes.set([76, 65, 83, 70]);
  bytes[24] = 1;
  bytes[25] = 4;
  const view = new DataView(bytes.buffer);
  view.setUint16(94, 375, true);
  view.setUint32(96, 375, true);
  bytes[104] = 6 | 0x80;
  view.setUint16(105, 30, true);
  view.setBigUint64(247, BigInt(points), true);
  return bytes;
}

/** Makes a ZIP's central directory claim another inflated size for one member. */
function claimSize(zip: Uint8Array, name: string, size: number): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const encoded = new TextEncoder().encode(name);
  for (let at = 0; at + 46 < zip.length; at++) {
    if (view.getUint32(at, true) !== 0x02014b50 || view.getUint16(at + 28, true) !== encoded.length) continue;
    if (encoded.every((b, i) => zip[at + 46 + i] === b)) view.setUint32(at + 24, size, true);
  }
  return zip;
}

describe('TxGIO', () => {
  it('numbers quarter quads the way TxGIO does', () => {
    // Austin East SW, El Paso SW, Round Rock SE, College Station, San Antonio East SW.
    expect(quarterQuad(-97.7431, 30.2672)).toBe('3097433');
    expect(quarterQuad(-106.487, 31.759)).toBe('3106133');
    expect(quarterQuad(-97.6789, 30.5083)).toBe('3097274');
    expect(quarterQuad(-96.3344, 30.628)).toBe('3096223');
    expect(quarterQuad(-98.4936, 29.4241)).toBe('2998373');
    // Across the line between Austin East's SW and SE quarters.
    expect([...quarterQuads({ west: -97.69, south: 30.26, east: -97.685, north: 30.262 }).keys()].sort()).toEqual(['3097433', '3097434']);
  });

  it('puts a member in its 1/64 degree cell', () => {
    // a1 of Austin East SW, as its header has it: -97.7504 to -97.7340, 30.2969 to 30.3125.
    const quad = quarterQuads(around(-97.72, 30.28, 0.001)).get('3097433')!;
    expect(memberCell(quad, 'a', '1')).toEqual([-97.75, 30.296875, -97.734375, 30.3125]);
    expect(memberCell(quad, 'd', '4')).toEqual([-97.703125, 30.25, -97.6875, 30.265625]);
  });

  it('reads the agency and year from the file name', () => {
    expect(nameParts('stratmap21-28cm-50cm-bexar-travis_3097433_lpc.zip')).toEqual({ agency: 'stratmap', year: 2021, place: 'bexar-travis' });
    expect(nameParts('city-of-austin-2003-170cm_3097433_lpc.zip')).toEqual({ agency: 'city-of-austin', year: 2003, place: '' });
    expect(nameParts('stratmap23-steinhagen-lake-50cm_3094073_lpc.zip')).toMatchObject({ year: 2023, place: 'steinhagen-lake' });
    expect(nameParts('usgs19-70cm-hurricane_2998191_lpc.zip')).toMatchObject({ agency: 'usgs', year: 2019 });
  });

  it('lists the members under an area from the ZIP directory, newer StratMap collections only', async () => {
    setCorsProxy('direct');
    const zip = claimSize(
      zipSync({
        'stratmap21-28cm_3097433a1.laz': lasFile(1),
        'stratmap21-28cm_3097433c1.laz': lasFile(80_000_000),
        'stratmap21-28cm_3097433c1.xml': new Uint8Array(10),
        'stratmap21-28cm_3097433c2.laz': lasFile(1),
      }),
      'stratmap21-28cm_3097433c2.laz',
      900_000_000,
    );
    const base = 'https://data.geographic.texas.gov/';
    const zipUrl = `${base}447db89a/resources/stratmap21-28cm-50cm-bexar-travis_3097433_lpc.zip`;
    const { fetcher, requested } = fakeFetcher((url) => {
      if (url.includes('resource__icontains=_3097433_lpc'))
        return {
          results: [
            { resource: zipUrl, filesize: zip.length, collection_id: '447db89a', resource_type_abbreviation: 'LPC' },
            { resource: `${base}0549d3ba/resources/stratmap17-50cm-central-texas_3097433_lpc.zip`, filesize: 1e9, collection_id: '0549d3ba', resource_type_abbreviation: 'LPC' },
            { resource: `${base}6ddcc1e6/resources/usgs19-70cm-hurricane_3097433_lpc.zip`, filesize: 1e9, collection_id: '6ddcc1e6', resource_type_abbreviation: 'LPC' },
            { resource: `${base}447db89a/resources/stratmap21-28cm-50cm-bexar-travis_3097433_hypso.zip`, filesize: 1e6, collection_id: '447db89a', resource_type_abbreviation: 'HYPSO' },
          ],
        };
      if (url.includes('collections_catalog/?collection_id=447db89a')) return { results: [{ name: 'Bexar & Travis Counties Lidar', acquisition_date: '2021-03-07' }] };
      return url === zipUrl ? zip : undefined;
    });
    // Over c1 and c2 of Austin East SW. c2 claims 900 MB inflated, past what the reader inflates.
    const [survey, ...rest] = await texas.discover(fetcher, around(-97.7344, 30.27), []);
    expect(rest).toEqual([]);
    expect(survey).toMatchObject({ id: '447db89a', name: 'TxGIO Bexar & Travis Counties Lidar', format: 'LAZ', acquisitionStart: '2021-03-07', projectYearHint: 2021, license: 'CC0 1.0' });
    expect(survey.tiles).toEqual([{ url: zipUrl, member: 'stratmap21-28cm_3097433c1.laz', size: zip.length, bytes: expect.any(Number), bbox: [-97.75, 30.265625, -97.734375, 30.28125] }]);
    // 80 million points over a cell of about 2.6 km².
    expect(survey.densityM2).toBeGreaterThan(29);
    expect(survey.densityM2).toBeLessThan(33);
    expect(requested.some((url) => url.includes('stratmap17') || url.includes('usgs19'))).toBe(false);
  });

  it('falls back to a name from the file when the catalog fails, and needs the proxy', async () => {
    const zip = zipSync({ 'stratmap24-50cm_3097274d4.laz': lasFile(10) });
    const zipUrl = 'https://data.geographic.texas.gov/91943379/resources/stratmap24-50cm-hays-williamson-counties_3097274_lpc.zip';
    const { fetcher, requested } = fakeFetcher((url) => {
      if (url.includes('resource__icontains=_3097274_lpc')) return { results: [{ resource: zipUrl, filesize: zip.length, collection_id: '91943379', resource_type_abbreviation: 'LPC' }] };
      return url === zipUrl ? zip : undefined;
    });
    // In d4, the south-east corner of Round Rock SE.
    const bbox = around(-97.633, 30.508, 0.001);
    expect(await texas.discover(fetcher, bbox, [])).toEqual([]);
    expect(requested).toEqual([]);
    setCorsProxy('direct');
    const [survey] = await texas.discover(fetcher, bbox, []);
    expect(survey).toMatchObject({ name: 'TxGIO StratMap 2024 Hays Williamson Counties', acquisitionStart: '2024-01-01' });
  });
});

describe('Anchorage', () => {
  it('fixes the backslashes in the links and keeps tiles under the area', async () => {
    setCorsProxy('direct');
    const link = (id: string) => `https://cdn.ancgis.com/datapublicstatic\\Elevation2025\\LiDAR_PointCloud\\${id}.laz`;
    const { fetcher, requested } = fakeFetcher((url) =>
      url.includes('LiDAR_Product_Links_2025_Hosted')
        ? collection([
            feature({ GRID_ID: '6_0163_0860_4', URL_LiDAR_LAZ: link('6_0163_0860_4') }, square(-149.9031, 61.2122, -149.8889, 61.2191)),
            feature({ GRID_ID: '6_0170_0860_4', URL_LiDAR_LAZ: link('6_0170_0860_4') }, square(-149.7, 61.2122, -149.69, 61.2191)),
            feature({ GRID_ID: '6_0163_0861_1', URL_LiDAR_LAZ: 'https://example.com/elsewhere.laz' }, square(-149.9031, 61.2122, -149.8889, 61.2191)),
          ])
        : undefined,
    );
    const [survey] = await anchorage.discover(fetcher, around(-149.895, 61.215), []);
    expect(requested[0]).toMatch(/geometry=-149\.897\d*,61\.213\d*,-149\.893\d*,61\.217\d*&geometryType=esriGeometryEnvelope/);
    expect(survey).toMatchObject({ name: 'Anchorage 2025 (Municipality of Anchorage)', attribution: 'Data provided courtesy of MOA', projectYearHint: 2025 });
    expect(survey.tiles).toEqual([{ url: 'https://cdn.ancgis.com/datapublicstatic/Elevation2025/LiDAR_PointCloud/6_0163_0860_4.laz', bbox: [-149.9031, 61.2122, -149.8889, 61.2191] }]);
  });
});

describe('LidarBC', () => {
  it('takes flight dates from file names only where they fall in the survey year', () => {
    expect(flightDates('bc_092g025_4_1_3_xyes_8_utm10_20250826_20250826.laz', 2025)).toEqual({ start: '2025-08-26', end: '2025-08-26' });
    expect(flightDates('bc_092g016_4_4_3_xyes_8_utm10_20240217_20250425.laz', 2024)).toEqual({ start: '2024-02-17', end: '2025-04-25' });
    // Fraser 2016's names carry the 2017 delivery.
    expect(flightDates('bc_092g025_3_4_2_xyes_8_utm10_20170713.laz', 2016)).toEqual({ start: '2016-01-01', end: '2016-12-31' });
    expect(flightDates('bc_092b044_1_3_2_xyes_8_utm10_2019.laz', 2019)).toEqual({ start: '2019-01-01', end: '2019-12-31' });
  });

  it('groups tiles by operation and year, leaving out the ones NRCan has as COPC', async () => {
    setCorsProxy('direct');
    const store = 'https://nrs.objectstore.gov.bc.ca/gdwuts/092/092g/';
    const tile = (filename: string, year: number, operation: string, projection = 'utm10') =>
      feature({ filename, year, oper_name: operation, projection, s3Url: `${store}${year}/pointcloud/${filename}` }, square(-123.125, 49.275, -123.105, 49.29));
    const { fetcher, requested } = fakeFetcher((url) => {
      if (url.includes('LiDAR_BC_S3_Public'))
        return collection([
          tile('bc_092g025_4_1_3_xyes_8_utm10_20250826_20250826.laz', 2025, 'LidarBC Program'),
          tile('bc_092g025_3_4_1_xyes_8_utm10_20170713.laz', 2016, 'NDMP Fraser 2016'),
          tile('bc_092g025_3_4_2_xyes_8_utm10_20170713.laz', 2016, 'NDMP Fraser 2016'),
          tile('bc_082e083_4_3_3_xyes_8_utm11_170607.laz', 2017, 'NDMP Okanagan 2017', 'utm11'),
        ]);
      // NRCan has one of the two Fraser tiles.
      if (url.endsWith('/BC/Lower_Mainland_2016/bc_092g025_3_4_1_xyes_8_utm10_20170713.copc.laz')) return new Uint8Array(100);
      return undefined;
    });
    const surveys = await lidarbc.discover(fetcher, around(-123.116, 49.282), []);
    expect(surveys.map((s) => [s.name, s.acquisitionStart, s.acquisitionEnd, s.tiles!.length])).toEqual([
      ['LidarBC 2025', '2025-08-26', '2025-08-26', 1],
      ['LidarBC NDMP Fraser 2016', '2016-01-01', '2016-12-31', 1],
      ['LidarBC NDMP Okanagan 2017', '2017-01-01', '2017-12-31', 1],
    ]);
    expect(surveys[1].tiles![0].url).toContain('_3_4_2_');
    expect(surveys.map((s) => s.tiles![0].horizontalCrs)).toEqual(['EPSG:3157', 'EPSG:3157', 'EPSG:2955']);
    expect(surveys[0]).toMatchObject({ verticalUnits: 'm', format: 'LAZ' });
    expect(surveys[0].classification).toBeUndefined();
    // Only Fraser's tiles were looked for on NRCan.
    expect(requested.filter((url) => url.includes('canelevation'))).toHaveLength(2);
  });
});

describe('Quebec MRNF', () => {
  it('names projects in words', () => {
    expect(projectName('2021_MauriciePortneuf_LiDAR')).toBe('2021 Mauricie Portneuf');
    expect(projectName('2023_MELCCFP_PICAI_2_LiDAR')).toBe('2023 MELCCFP PICAI 2');
  });

  it('reads both layers, skipping ground-only tiles and surveys NRCan has whole', async () => {
    setCorsProxy('direct');
    const files = 'https://diffusion.mern.gouv.qc.ca/diffusion/RGQ/Lidar/';
    const tile = (name: string, project: string, folder: string, dates: string, type = 'Données classifiées') =>
      feature(
        { NOM_TUILE: name, TELECHARGEMENT_TUILE: `${files}${folder}/Mtm8/Laz/${name}.laz`, PROJET: project, TYPE_DONNEE: type, CODE_EPSG: 2950, DATE_ACQUISITION: dates, TAILLE_FICHIER: '117 Mo' },
        { type: 'MultiPolygon', coordinates: [square(-72.549, 46.3418, -72.5359, 46.3506).coordinates] },
      );
    const mauricie = tile('21_3785134F08_DC', '2021_MauriciePortneuf_LiDAR', '2021_Mauricieportneuf_Lidar_Den10_DonneesClassifiees', '2021-11-03,2021-10-20');
    const { fetcher, requested } = fakeFetcher((url) => {
      if (url.includes('LidarPlusRecent')) return collection([mauricie, tile('23_3785134F08_DC', '2023_CMM_LiDAR', '2023_Cmm_Lidar_Den15_DonneesClassifiees', '2023-11-21')]);
      if (url.includes('LidarHistorique'))
        return collection([
          mauricie,
          tile('18_3785134F08_DC', '2018_FleuveSaintLaurent_LiDAR', '2018_Fleuvesaintlaurent_Lidar_Den4_DonneesClassifiees', '2018-09-15,2018-09-17'),
          tile('11_3785134F08_DS', '2011_MauriciePortneufDeschaillons_Lidar', '2011_Mauriciportneufdeschaillons_Lidar_Den2_DonneesAuSol', '2011-11-01', 'Données au sol'),
        ]);
      return undefined;
    });
    const surveys = await quebec.discover(fetcher, around(-72.543, 46.343), []);
    expect(requested).toHaveLength(2);
    expect(requested[0]).toMatch(/^https:\/\/servicesvecto3\.mern\.gouv\.qc\.ca\/geoserver\/Index_Telechargement_Lidar_Pub\/wfs\?/);
    // Latitude first.
    expect(requested[0]).toMatch(/bbox=46\.341\d*,-72\.545\d*,46\.345\d*,-72\.541\d*,urn:ogc:def:crs:EPSG::4326/);
    expect(surveys.map((s) => [s.name, s.acquisitionStart, s.acquisitionEnd, s.projectYearHint, s.tiles!.length])).toEqual([
      ['Québec 2021 Mauricie Portneuf', '2021-10-20', '2021-11-03', 2021, 1],
      ['Québec 2018 Fleuve Saint Laurent', '2018-09-15', '2018-09-17', 2018, 1],
    ]);
    // The index's sizes are rounded ("117 Mo"), so none is given.
    expect(surveys[0].tiles).toEqual([{ url: `${files}2021_Mauricieportneuf_Lidar_Den10_DonneesClassifiees/Mtm8/Laz/21_3785134F08_DC.laz`, bbox: [-72.549, 46.3418, -72.5359, 46.3506], horizontalCrs: 'EPSG:2950' }]);
    expect(surveys[0]).toMatchObject({ verticalUnits: 'm', classification: expect.objectContaining({ '2': 'ground', '8': 'ground', '6': 'building' }) });
  });
});
