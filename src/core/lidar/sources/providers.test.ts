// National providers against canned catalog answers, and discovery's
// handling of slow providers.

import { zipSync } from 'fflate';
import proj4 from 'proj4';
import { describe, expect, it } from 'vitest';
import type { GeoBounds } from '../../types';
import { setProjector } from '../read/crs';
import { HttpError } from '../../data/http';
import { CatalogError, type Fetcher } from '../read/fetcher';
import { discover, type Provider } from './index';
import { nrw, nrwTiles } from './nrw';

setProjector((from, to) => proj4(from, to));

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
    catalog: async (url: string) => (get(url) as Uint8Array).slice().buffer,
    bytes: async (url: string) => (get(url) as Uint8Array).slice().buffer,
    range: async (url: string, start: number, end: number) => (get(url) as Uint8Array).slice(start, end).buffer,
  };
  return { fetcher: fetcher as unknown as Fetcher, requested };
}

const NRW_CSV = [
  'Kachelinformationen der 3dm fuer die Datenabgabe',
  'Punktklassenbelegung;1,2,9,14,17,18,20,24,26',
  'Kachelname;Aktualitaet;Erfassungsmethode;Fortfuehrung;Fortfuehrungsmethode;Lagegenauigkeit;Hoehengenauigkeit;Aufloesung;Koordinatenreferenzsystem_Lage;Koordinatenreferenzsystem_Hoehe;Hoehenanomalie;',
  '3dm_32_356_5645_1_nw;2022-02-12;5020;2022-02-12;5020;0.30;0.15;4.00;ETRS89_UTM32;DE_DHHN2016_NH;DE_AdV_GCG2016_QGH',
  '3dm_32_357_5645_1_nw;2025-03-01;5020;2025-03-01;5020;0.30;0.15;4.00;ETRS89_UTM32;DE_DHHN2016_NH;DE_AdV_GCG2016_QGH',
].join('\r\n');

// Cologne cathedral, in tile 356/5645, and a box reaching east into 357/5645.
const cathedral: GeoBounds = { west: 6.956, south: 50.94, east: 6.96, north: 50.942 };
const toTheEast: GeoBounds = { west: 6.958, south: 50.94, east: 6.975, north: 50.942 };

describe('Geobasis NRW', () => {
  const route = (url: string) => (url.endsWith('3dm_meta.zip') ? zipSync({ '3dm_nw.csv': new TextEncoder().encode(NRW_CSV) }) : undefined);

  it('reads the tile table', () => {
    const tiles = nrwTiles(NRW_CSV);
    expect(tiles.size).toBe(2);
    expect(tiles.get('3dm_32_356_5645_1_nw')).toEqual({ date: '2022-02-12', density: 4 });
    expect(() => nrwTiles('Kachelname;Datum\nx;y')).toThrow(/Aktualitaet/);
  });

  it('finds the 1 km tiles under an area, named after the grid', async () => {
    const { fetcher } = fakeFetcher(route);
    const [survey] = await nrw.discover(fetcher, cathedral, []);
    expect(survey.format).toBe('LAZ');
    expect(survey.tiles!.map((t) => t.url)).toEqual(['https://www.opengeodata.nrw.de/produkte/geobasis/hm/3dm_l_las/3dm_l_las/3dm_32_356_5645_1_nw.laz']);
    expect(survey.tiles![0].horizontalCrs).toBe('EPSG:25832');
    // The tile's outline is its square, near enough in lon/lat.
    const [w, s, e, n] = survey.tiles![0].bbox;
    expect(w).toBeCloseTo(6.951, 2);
    expect(e - w).toBeCloseTo(0.0145, 3);
    expect(n - s).toBeCloseTo(0.009, 3);
    expect(survey).toMatchObject({ name: 'Geobasis NRW 3D-Messdaten', acquisitionStart: '2022-02-12', acquisitionEnd: '2022-02-12' });

    const [both] = await nrw.discover(fetcher, toTheEast, []);
    expect(both.tiles).toHaveLength(2);
    expect(both).toMatchObject({ acquisitionStart: '2022-02-12', acquisitionEnd: '2025-03-01' });
    // A survey's identity changes with its newest tile, so old checkpoints aren't reused.
    expect(both.url).not.toBe(survey.url);
  });

  it('is only asked about areas in the state', async () => {
    const { fetcher, requested } = fakeFetcher((url) => route(url) ?? (url.includes('README') ? '' : { features: [] }));
    await discover(fetcher, { west: 2.35, south: 48.85, east: 2.36, north: 48.86 }, undefined, [nrw]);
    expect(requested).toEqual([]);
  });
});

describe('discovery', () => {
  it('gives up on a provider that takes too long and keeps the others', async () => {
    const hangs: Provider = { id: 'slow', timeoutMs: 20, discover: () => new Promise(() => undefined) };
    const quick: Provider = { id: 'quick', discover: async () => [{ provider: 'Quick', id: 'q', name: 'Quick', url: 'https://example.com/q', format: 'COPC', coverage: [], attribution: '', sourcePage: '', projectYearHint: null }] };
    const { candidates, failures } = await discover(fakeFetcher(() => undefined).fetcher, cathedral, undefined, [hangs, quick]);
    expect(candidates.map((c) => c.id)).toEqual(['q']);
    expect(failures).toEqual([{ source: 'slow', reason: 'no answer within 0 s', search: true }]);
  });
  it('says why a catalog failed without its URL', async () => {
    const url = 'https://maps.example.com/MapServer/1/query?f=geojson&where=1%3D1&geometry=7,50,7.1,50.1&outFields=*';
    const throws = (id: string, error: Error): Provider => ({ id, discover: async () => Promise.reject(error) });
    const { failures } = await discover(fakeFetcher(() => undefined).fetcher, cathedral, undefined, [
      throws('page', new CatalogError(url, 'answered with a web page')),
      throws('arcgis', new CatalogError(url, 'answered with an error (Error performing query operation)')),
      throws('missing', new HttpError(404, url)),
    ]);
    expect(failures.map((f) => f.reason)).toEqual(['it answered with a web page', 'it answered with an error (Error performing query operation)', 'it answered HTTP 404']);
    expect(new CatalogError(url, 'answered with a web page').message).toBe(`${url} answered with a web page.`);
  });
});
