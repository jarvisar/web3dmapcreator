// Madrid, Navarra, ICGC and Brussels against canned answers: grids, listings,
// missing tiles, classes and the geoid offsets for Navarra's ellipsoidal heights.

import proj4 from 'proj4';
import { afterEach, describe, expect, it } from 'vitest';
import { setCorsProxy } from '../../data/corsProxy';
import { HttpError } from '../../data/http';
import type { GeoBounds } from '../../types';
import { setProjector } from '../read/crs';
import type { Fetcher } from '../read/fetcher';
import { brussels, brusselsTiles } from './brussels';
import { icgc, icgcListing } from './icgc';
import { madrid } from './madrid';
import { geoidHeight, navarra, pamplonaListing } from './navarra';
import { zippedShapefile } from './test-shapefile';

setProjector((from, to) => proj4(from, to));
afterEach(() => setCorsProxy(null));

function fakeFetcher(route: (url: string) => string | Uint8Array | number | undefined) {
  const requested: string[] = [];
  const get = (url: string) => {
    requested.push(url);
    const answer = route(url);
    if (answer === undefined) throw new HttpError(404, url);
    return answer;
  };
  const fetcher = {
    downloaded: 0,
    text: async (url: string) => get(url) as string,
    catalog: async (url: string) => {
      const body = get(url);
      return (typeof body === 'string' ? new TextEncoder().encode(body) : (body as Uint8Array)).slice().buffer;
    },
    size: async (url: string) => get(url) as number,
  };
  return { fetcher: fetcher as unknown as Fetcher, requested };
}

const around = (lon: number, lat: number, d = 0.002): GeoBounds => ({ west: lon - d, south: lat - d, east: lon + d, north: lat + d });
const fileOf = (url: string) => url.slice(url.lastIndexOf('/') + 1);

describe('Madrid', () => {
  const GRID = 'https://geoportal.madrid.es/fsdescargas/IDEAM_WBGEOPORTAL/ELEVACIONES/2026/NUBE_PUNTOS/LIDAR/F1/Malla_1kmx1km_LiDAR_F1.zip';
  // Two of the F1 delivery's squares, named by x km and their top edge.
  const zip = zippedShapefile(
    [
      [447000, 4479000, 448000, 4480000],
      [447000, 4480000, 448000, 4481000],
    ],
    [['NOMBRE', 20]],
    [['447-4480'], ['447-4481']],
  );
  const route = (url: string) => (url === GRID ? zip : undefined);

  it('needs the proxy', async () => {
    expect(await madrid.discover(fakeFetcher(route).fetcher, around(-3.6165, 40.464), [])).toEqual([]);
  });

  it('names tiles from the grid, not from a guess', async () => {
    setCorsProxy('direct');
    const { fetcher, requested } = fakeFetcher(route);
    const [survey] = await madrid.discover(fetcher, around(-3.6165, 40.464), []);
    expect(requested).toEqual([GRID]);
    expect(survey.tiles!.map((t) => fileOf(t.url))).toEqual(['447-4480.laz']);
    expect(survey.tiles![0]).toMatchObject({ horizontalCrs: 'EPSG:25830' });
    expect(survey.tiles![0].size).toBeUndefined();
    expect(survey).toMatchObject({ format: 'LAZ', acquisitionStart: '2026-06-13', projectYearHint: 2026, url: expect.stringContaining('#2026-F1') });
    // The square holds IFEMA's south-west part, so its outline does too.
    const [w, s, e, n] = survey.tiles![0].bbox;
    expect(w).toBeLessThan(-3.6165);
    expect(e).toBeGreaterThan(-3.6165);
    expect(s).toBeLessThan(40.464);
    expect(n).toBeGreaterThan(40.464);
  });

  it('finds nothing where the delivery has no squares', async () => {
    setCorsProxy('direct');
    expect(await madrid.discover(fakeFetcher(route).fetcher, around(-3.7038, 40.4168), [])).toEqual([]);
  });
});

describe('Navarra', () => {
  const PAMPLONA = 'https://filescartografia.navarra.es/5_LIDAR/5_5_2020_C_Pamplona_EPSG25830/';
  const REGION = 'https://filescartografia.navarra.es/5_LIDAR/5_6_2024_NAV_cam_EPSG25830/';
  const line = (size: number, name: string) => ` 7/27/2021 11:29 AM    ${size} <A HREF="/5_LIDAR/5_5_2020_C_Pamplona_EPSG25830/${name}">${name}</A><br>`;
  const listing = [
    '<html><head><title>filescartografia.navarra.es - /5_LIDAR/5_5_2020_C_Pamplona_EPSG25830/</title></head><body><pre><A HREF="/5_LIDAR/">[To Parent Directory]</A><br><br>',
    line(469492071, 'las_cam_610_4741_C_Pamplona_EPSG25830_2020.laz'),
    line(485372746, 'las_cam_610_4742_C_Pamplona_EPSG25830_2020.laz'),
    line(413103156, 'las_ca_611_4742_C_Pamplona_EPSG25830_2020.laz'),
    '</pre></body></html>',
  ].join('');
  // Plaza del Castillo is at UTM 611016, 4741443, on the line between two tiles.
  const plaza = around(-1.642, 42.8175);
  const route = (url: string) => {
    if (url === PAMPLONA) return listing;
    if (url === `${REGION}las_cam_610-4742_2024_NAV_EPSG25830.laz`) return 74779167;
    return undefined;
  };

  it('reads the 2020 listing, both prefixes and their sizes', () => {
    const tiles = pamplonaListing(listing);
    expect([...tiles.keys()]).toEqual(['las_cam_610_4741_C_Pamplona_EPSG25830_2020.laz', 'las_cam_610_4742_C_Pamplona_EPSG25830_2020.laz', 'las_ca_611_4742_C_Pamplona_EPSG25830_2020.laz']);
    expect(tiles.get('las_ca_611_4742_C_Pamplona_EPSG25830_2020.laz')).toEqual({ x: 611000, top: 4742000, size: 413103156 });
    expect(() => pamplonaListing('<html></html>')).toThrow(/no tiles/);
  });

  it('interpolates EGM08-REDNAP near the full model', () => {
    // es_ign_egm08-rednap.tif: 49.98 at the plaza, 50.00 at Tudela, 50.05 at 42.8° N 1.6° W (a node).
    expect(Math.abs(geoidHeight(-1.642, 42.8175) - 49.98)).toBeLessThan(0.15);
    expect(Math.abs(geoidHeight(-1.6044, 42.0617) - 50.0)).toBeLessThan(0.15);
    expect(geoidHeight(-1.6, 42.8)).toBeCloseTo(50.05, 2);
  });

  it('finds 2024 tiles by HEAD and 2020 ones from the listing, both moved to the geoid', async () => {
    setCorsProxy('direct');
    const { fetcher, requested } = fakeFetcher(route);
    const surveys = await navarra.discover(fetcher, plaza, []);
    expect(surveys.map((s) => s.id)).toEqual(['navarra-2024', 'pamplona-2020']);
    const [region, pamplona] = surveys;
    // 611-4742 answered 404, so only the one that exists is kept, with its size.
    expect(requested).toContain(`${REGION}las_cam_611-4742_2024_NAV_EPSG25830.laz`);
    expect(region.tiles!.map((t) => [fileOf(t.url), t.size])).toEqual([['las_cam_610-4742_2024_NAV_EPSG25830.laz', 74779167]]);
    expect(pamplona.tiles!.map((t) => [fileOf(t.url), t.size])).toEqual([
      ['las_cam_610_4742_C_Pamplona_EPSG25830_2020.laz', 485372746],
      ['las_ca_611_4742_C_Pamplona_EPSG25830_2020.laz', 413103156],
    ]);
    for (const tile of [...region.tiles!, ...pamplona.tiles!]) {
      expect(tile.horizontalCrs).toBe('EPSG:25830');
      expect(tile.zOffset).toBeGreaterThan(-50.2);
      expect(tile.zOffset).toBeLessThan(-49.8);
    }
    expect(region.classification).toMatchObject({ '10': 'ground', '11': 'ground', '17': 'bridge' });
    expect(region.classification!['150']).toBeUndefined();
    expect(region.classification!['151']).toBeUndefined();
    expect(pamplona.classification).toMatchObject({ '9': 'noise', '17': 'noise', '32': 'bridge' });
    for (const code of ['8', '20', '21', '36']) expect(pamplona.classification![code]).toBeUndefined();
    expect([region.acquisitionStart, region.acquisitionEnd, pamplona.acquisitionStart]).toEqual(['2024-07-16', '2024-09-15', '2020-09-03']);
  });

  it("doesn't read the Pamplona listing away from Pamplona", async () => {
    setCorsProxy('direct');
    const { fetcher, requested } = fakeFetcher(() => 70e6);
    // Tudela.
    const [survey] = await navarra.discover(fetcher, around(-1.6044, 42.0617), []);
    expect(requested.some((url) => url.startsWith(PAMPLONA))).toBe(false);
    expect(survey.id).toBe('navarra-2024');
    expect(Math.abs(survey.tiles![0].zOffset! + 50)).toBeLessThan(0.15);
  });

  it('needs the proxy', async () => {
    expect(await navarra.discover(fakeFetcher(route).fetcher, plaza, [])).toEqual([]);
  });
});

describe('ICGC', () => {
  const FOLDER = 'https://datacloud.icgc.cat/datacloud/lidar-territorial/laz_unzip/full10km4358/';
  const line = (size: number, name: string) => `   ${size} <A HREF="/datacloud/lidar-territorial/laz_unzip/full10km4358/${name}">${name}</A><br>`;
  const listing = [
    '<html><head><title>datacloud.icgc.cat - /datacloud/lidar-territorial/laz_unzip/full10km4358/</title></head><body><pre>',
    line(332168959, 'lidar-territorial-v3r1-full1km430581-2021-2023.laz'),
    line(327772582, 'lidar-territorial-v3r1-full1km430582-2021-2023.laz'),
    // A later version of the same tile replaces it.
    line(330000000, 'lidar-territorial-v3r2-full1km430581-2021-2023.laz'),
    '</pre></body></html>',
  ].join('');
  // The Eixample at UTM 31 430192, 4582500.
  const eixample = around(2.165, 41.391);

  it('keeps the newest version of each tile from a folder listing', () => {
    const tiles = icgcListing(listing);
    expect(tiles.get('430581')).toMatchObject({ name: 'lidar-territorial-v3r2-full1km430581-2021-2023.laz', version: '3.2', size: 330000000 });
    expect(tiles.get('430582')).toMatchObject({ version: '3.1', start: 2021, end: 2023 });
  });

  it("names the tile from its corner and reads its folder's listing", async () => {
    setCorsProxy('direct');
    const { fetcher, requested } = fakeFetcher((url) => (url === FOLDER ? listing : undefined));
    const [survey] = await icgc.discover(fetcher, eixample, []);
    expect(requested).toEqual([FOLDER]);
    expect(survey.tiles).toEqual([{ url: `${FOLDER}lidar-territorial-v3r1-full1km430582-2021-2023.laz`, bbox: expect.any(Array), size: 327772582, horizontalCrs: 'EPSG:25831' }]);
    expect(survey).toMatchObject({ format: 'LAZ', acquisitionStart: '2021-01-01', acquisitionEnd: '2023-12-31', projectYearHint: 2021 });
    expect(survey.classification).toMatchObject({ '8': 'ground', '75': 'ground', '77': 'building', '6': 'building' });
    expect(survey.classification!['76']).toBeUndefined();
  });

  it('finds nothing off the coast, where there is no folder', async () => {
    setCorsProxy('direct');
    const { fetcher, requested } = fakeFetcher(() => undefined);
    expect(await icgc.discover(fetcher, around(2.3, 41.3), [])).toEqual([]);
    expect(requested).toHaveLength(1);
  });

  it('needs the proxy and keeps a short deadline', async () => {
    expect(await icgc.discover(fakeFetcher(() => listing).fetcher, eixample, [])).toEqual([]);
    expect(icgc.timeoutMs).toBeLessThanOrEqual(30_000);
  });
});

describe('Brussels', () => {
  it('lists the 216 tiles of the feed', () => {
    const tiles = brusselsTiles();
    expect(tiles).toHaveLength(216);
    expect(tiles).toContainEqual([148, 170]);
    expect(tiles).toContainEqual([140, 167]);
    expect(tiles).not.toContainEqual([140, 166]);
  });

  it('offers the ZIP holding the Grand Place, without asking anything', async () => {
    setCorsProxy('direct');
    const { fetcher, requested } = fakeFetcher(() => undefined);
    const [survey] = await brussels.discover(fetcher, around(4.3524, 50.8467), []);
    expect(requested).toEqual([]);
    expect(survey.tiles!.map((t) => fileOf(t.url))).toEqual(['PointCloud_31370_LAS_148170_20210910.zip']);
    // No member, so the offer asks for the ZIP's size.
    expect(survey.tiles![0]).toEqual({ url: expect.any(String), bbox: expect.any(Array), horizontalCrs: 'EPSG:31370' });
    expect(survey).toMatchObject({ format: 'LAZ', verticalUnits: 'm', projectYearHint: 2021 });
  });

  it('finds nothing outside the region, and needs the proxy', async () => {
    setCorsProxy('direct');
    expect(await brussels.discover(fakeFetcher(() => undefined).fetcher, around(4.23, 50.92), [])).toEqual([]);
    setCorsProxy(null);
    expect(await brussels.discover(fakeFetcher(() => undefined).fetcher, around(4.3524, 50.8467), [])).toEqual([]);
  });
});
