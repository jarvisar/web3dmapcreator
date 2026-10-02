// The City of Winnipeg's own 2020 survey (Water and Waste): 1 km tiles of
// uncompressed LAS, 325-341 MB each, about 11 returns per m² with buildings
// and bridges classified. NRCan's copy of the same flight (Red_River_2020)
// has under 5 over the city. The city's 2011 survey is older than NRCan's
// and left out.
//
// The index is Socrata's API, which has CORS. The files are on Azure
// without it, so they go through the proxy. They have no VLRs at all, so no
// CRS. Tile names are UTM 14N corners on NAD83 (EPSG:26914): the index's
// outlines and a tile's header bounds both land on them.

import { proxyAvailable } from '../../data/corsProxy';
import { geoPolygons, overlaps, ringBox, Surveys, type Provider } from './common';

const INDEX = 'https://data.winnipeg.ca/resource/g634-qskh.json';
const FIRST_YEAR = 2020;

interface Row {
  id?: string;
  year?: string;
  season?: string;
  file_type?: string;
  minimum_density?: string;
  url?: { url?: string };
  boundary?: { type: string; coordinates: unknown };
}

const SEASONS: Record<string, [string, string]> = { spring: ['03-01', '05-31'], summer: ['06-01', '08-31'], fall: ['09-01', '11-30'], autumn: ['09-01', '11-30'] };

export const winnipeg: Provider = {
  id: 'winnipeg',
  name: 'City of Winnipeg',
  areas: [[-97.35, 49.7, -96.95, 50.03]],
  async discover(fetcher, bbox) {
    if (!proxyAvailable()) return [];
    const { west: w, south: s, east: e, north: n } = bbox;
    const where = `file_type='Tile' AND intersects(boundary,'POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))')`;
    const rows = await fetcher.json(`${INDEX}?$where=${encodeURIComponent(where)}&$limit=1000`);
    if (!Array.isArray(rows)) throw new Error('Winnipeg LiDAR index answered with something other than rows');
    const surveys = new Surveys();
    for (const row of rows as Row[]) {
      const year = Number(row.year);
      const url = row.url?.url ?? '';
      const coverage = geoPolygons(row.boundary);
      if (!(year >= FIRST_YEAR) || !/^https:\/\/.+\.la[sz]$/i.test(url) || !coverage.length) continue;
      const box = ringBox(coverage.flat());
      if (!overlaps(box, bbox)) continue;
      const [start, end] = SEASONS[String(row.season).toLowerCase()] ?? ['01-01', '12-31'];
      surveys.add(
        String(year),
        () => ({
          provider: 'City of Winnipeg',
          id: `lidar-${year}`,
          name: `City of Winnipeg ${year}`,
          url: `${INDEX}#${year}`,
          format: 'LAZ',
          verticalUnits: 'm',
          acquisitionStart: `${year}-${start}`,
          acquisitionEnd: `${year}-${end}`,
          densityM2: Number(/^[\d.]+/.exec(String(row.minimum_density ?? ''))?.[0]) || undefined,
          license: 'Open Government Licence - Canada',
          attribution: 'City of Winnipeg, Water and Waste',
          sourcePage: 'https://data.winnipeg.ca/d/g634-qskh',
          authoritative: true,
          projectYearHint: year,
        }),
        { url, bbox: box, horizontalCrs: 'EPSG:26914' },
        coverage,
      );
    }
    return surveys.list();
  },
};
