// Madrid city's 2026 LiDAR (Ayuntamiento de Madrid). The whole urban area
// was flown from 28 May to 29 June 2026, but only a first delivery around the
// new F1 circuit is out so far: 11 tiles of 1 km over IFEMA, Valdebebas and
// the edge of Barajas, flown 13 June. About 69 returns per m², plain ASPRS
// classes, 310 MB of LAZ per tile. The host sends no CORS headers.
//
// Each delivery has a small zipped shapefile grid next to its files, and its
// NOMBRE (x km, then the top edge in km) names the file. Names have to come
// from the grid: a file that isn't there answers a 302 to a maintenance page,
// not a 404. The rest of the city will probably land in another folder under
// 2026/NUBE_PUNTOS/ (folder listings are refused, so the path has to come
// from the dataset page). Add it to DELIVERIES with its grid. A tile in a
// later delivery replaces the same tile in an earlier one.
//
// The city's 2023 cloud next to it is image matching, not LiDAR, and isn't read.

import type { Polygon } from '../../types';
import { proxyAvailable } from '../../data/corsProxy';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import { overlaps, ringBox, squarePolygon, type Provider, type Tile } from './common';
import { dbfRowAt, shpPolygons, zippedIndex } from './shapefile';

const BASE = 'https://geoportal.madrid.es/fsdescargas/IDEAM_WBGEOPORTAL/ELEVACIONES/2026/NUBE_PUNTOS/';
const WEEK_MS = 7 * 24 * 3600 * 1000;

interface Delivery {
  id: string;
  folder: string;
  grid: string;
  start: string;
  end: string;
}

const DELIVERIES: Delivery[] = [{ id: 'F1', folder: `${BASE}LIDAR/F1/`, grid: 'Malla_1kmx1km_LiDAR_F1.zip', start: '2026-06-13', end: '2026-06-13' }];

export const madrid: Provider = {
  id: 'madrid',
  name: 'Ayuntamiento de Madrid',
  areas: [[-3.9, 40.3, -3.5, 40.65]],
  async discover(fetcher, bbox) {
    if (!proxyAvailable()) return [];
    const { toLonLat, fromLonLat } = lonLatTransforms(crsFromEpsg(25830));
    const corners = [fromLonLat(bbox.west, bbox.south), fromLonLat(bbox.east, bbox.south), fromLonLat(bbox.east, bbox.north), fromLonLat(bbox.west, bbox.north)];
    const query: [number, number, number, number] = [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))];
    const found = new Map<string, { tile: Tile; square: Polygon; delivery: Delivery }>();
    for (const delivery of DELIVERIES) {
      const index = await zippedIndex(fetcher, `${delivery.folder}${delivery.grid}`, WEEK_MS);
      for (const shape of shpPolygons(index.shp, query)) {
        const name = String(dbfRowAt(index.dbf, shape.index).nombre ?? '');
        const match = /^(\d{3})-(\d{4})$/.exec(name);
        if (!match) continue;
        const square = squarePolygon(toLonLat, Number(match[1]) * 1000, (Number(match[2]) - 1) * 1000, 1000);
        const box = ringBox(square);
        if (!overlaps(box, bbox)) continue;
        found.set(name, { tile: { url: `${delivery.folder}${name}.laz`, bbox: box, horizontalCrs: 'EPSG:25830' }, square, delivery });
      }
    }
    if (!found.size) return [];
    const used = DELIVERIES.filter((d) => [...found.values()].some((f) => f.delivery === d));
    return [
      {
        provider: 'Ayuntamiento de Madrid',
        id: 'lidar-2026',
        name: 'Madrid LiDAR 2026',
        // Named by its deliveries, so a later one doesn't reuse checkpoints made without it.
        url: `${BASE}#2026-${used.map((d) => d.id).join('-')}`,
        format: 'LAZ',
        coverage: [...found.values()].map((f) => f.square),
        tiles: [...found.values()].map((f) => f.tile),
        verticalUnits: 'm',
        acquisitionStart: used.map((d) => d.start).sort()[0],
        acquisitionEnd: used.map((d) => d.end).sort().at(-1),
        densityM2: 69,
        license: 'Ayuntamiento de Madrid open data terms',
        attribution: 'Origen de los datos: Ayuntamiento de Madrid',
        sourcePage: 'https://geoportal.madrid.es/IDEAM_WBGEOPORTAL/dataset.iam?id=SPA_28079_CIRCUITO_F1_MADRING',
        authoritative: true,
        projectYearHint: 2026,
      },
    ];
  },
};
