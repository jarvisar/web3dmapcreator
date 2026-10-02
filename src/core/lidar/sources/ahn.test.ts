// AHN5 and AHN6 against canned Ellipsis WFS answers: editions, years from
// the map sheets, and tiles the bucket doesn't have.

import proj4 from 'proj4';
import { afterEach, describe, expect, it } from 'vitest';
import { setCorsProxy } from '../../data/corsProxy';
import { HttpError } from '../../data/http';
import { crsFromEpsg, lonLatTransforms, setProjector } from '../read/crs';
import type { Fetcher } from '../read/fetcher';
import { ahn } from './ahn';

setProjector((from, to) => proj4(from, to));
afterEach(() => setCorsProxy(null));

const { toLonLat } = lonLatTransforms(crsFromEpsg(28992));
const rd = (x0: number, y0: number, x1: number, y1: number) => ({ type: 'Polygon', coordinates: [[toLonLat(x0, y0), toLonLat(x1, y0), toLonLat(x1, y1), toLonLat(x0, y1), toLonLat(x0, y0)]] });
const sheet = (url: string, geometry: object) => ({ type: 'Feature', properties: { Puntenwolk: url }, geometry });

function fakeFetcher(ahn6: object[], ahn5: object[], missing: string[]) {
  const asked: string[] = [];
  const fetcher = {
    json: async (url: string) => {
      asked.push(url);
      return { type: 'FeatureCollection', features: url.includes('0820faae') ? ahn6 : ahn5 };
    },
    size: async (url: string) => {
      asked.push(url);
      if (missing.some((name) => url.endsWith(name))) throw new HttpError(403, url);
      return 2e8;
    },
  };
  return { fetcher: fetcher as unknown as Fetcher, asked };
}

describe('AHN', () => {
  // Two 1 km squares wide around RD (121500, 487500) in Amsterdam.
  const [w, s] = toLonLat(121200, 487200);
  const [e, n] = toLonLat(122300, 487800);
  const bbox = { west: w, south: s, east: e, north: n };

  it('needs the proxy', async () => {
    expect(await ahn.discover(fakeFetcher([], [], []).fetcher, bbox, [])).toEqual([]);
  });

  it("lists AHN5's 1 km tiles under its map sheets with their year, and AHN6 sheets as they come", async () => {
    setCorsProxy('direct');
    // The 1 km squares at y 487000-488000 have their centres in the 2023 sheet.
    const ahn5 = [sheet('https://basisdata.nl/hwh-ahn/AHN5/01_LAZ/2023_C_25GN1.LAZ', rd(120000, 482500, 125000, 488750)), sheet('https://basisdata.nl/hwh-ahn/AHN5/01_LAZ/2024_C_25GN2.LAZ', rd(120000, 488750, 125000, 495000))];
    const ahn6 = [sheet('https://basisdata.nl/hwh-ahn/AHN6/01_LAZ/AHN6_2025_C_122000_487000.LAZ', rd(122000, 487000, 123000, 488000))];
    const { fetcher, asked } = fakeFetcher(ahn6, ahn5, ['AHN5_C_122000_487000.COPC.LAZ']);
    const surveys = await ahn.discover(fetcher, bbox, []);
    expect(surveys.map((c) => [c.id, c.format, c.projectYearHint, c.tiles!.map((t) => t.url.split('/').pop())])).toEqual([
      ['AHN6-2025', 'COPC', 2025, ['AHN6_2025_C_122000_487000.COPC.LAZ']],
      ['AHN5-2023', 'COPC', 2023, ['AHN5_C_121000_487000.COPC.LAZ']],
    ]);
    expect(surveys[0].tiles![0]).toMatchObject({ horizontalCrs: 'EPSG:28992', url: 'https://fsn1.your-objectstorage.com/hwh-ahn/AHN6/01_LAZ/AHN6_2025_C_122000_487000.COPC.LAZ' });
    expect(surveys[1].classification?.['26']).toBe('bridge');
    // The WFS takes lat,lon.
    expect(asked[0]).toContain(`bbox=${s},${w},${n},${e},urn:ogc:def:crs:EPSG::4326`);
  });

  it("finds a tile whose centre is on a sheet's edge", async () => {
    setCorsProxy('direct');
    // Sheets end at y 487500, the middle of the tile at y 487000-488000, and the area is just south of it.
    const [aw, as] = toLonLat(121300, 487200);
    const [ae, an] = toLonLat(121500, 487450);
    const ahn5 = [sheet('https://basisdata.nl/hwh-ahn/AHN5/01_LAZ/2023_C_25GN1.LAZ', rd(120000, 481250, 125000, 487500))];
    const surveys = await ahn.discover(fakeFetcher([], ahn5, []).fetcher, { west: aw, south: as, east: ae, north: an }, []);
    expect(surveys.map((c) => [c.id, c.tiles!.map((t) => t.url.split('/').pop())])).toEqual([['AHN5-2023', ['AHN5_C_121000_487000.COPC.LAZ']]]);
  });
});
