// Trentino (Provincia autonoma di Trento): the 2014 survey, partly flown
// again in 2018, as 500 m LAZ tiles of about 18 MB at 10 points per m²,
// classified. The only open point cloud of an Italian city found that a
// browser can read. Names come from the zipped tile index (731 KB) rather
// than the grid: a missing tile answers 404 without CORS, which a browser
// can't tell from a network failure.

import type { Polygon } from '../../types';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import { ringBox, type Provider, type Tile } from './common';
import { dbfRowAt, shpPolygons, zippedIndex } from './shapefile';

const INDEX = 'https://siatservices.provincia.tn.it/idt/vector/p_TN_9f2cc32d-1030-430d-be85-7f95c9cc24ea.zip';
const FILES = 'https://siatservices.provincia.tn.it/stemdata/2014_lidar_laz/';
const WEEK_MS = 7 * 24 * 3600 * 1000;

export const trentino: Provider = {
  id: 'trentino',
  name: 'Provincia autonoma di Trento',
  areas: [[10.4, 45.6, 12.0, 46.6]],
  async discover(fetcher, bbox) {
    const index = await zippedIndex(fetcher, INDEX, WEEK_MS);
    const { toLonLat, fromLonLat } = lonLatTransforms(crsFromEpsg(25832));
    const corners = [fromLonLat(bbox.west, bbox.south), fromLonLat(bbox.east, bbox.south), fromLonLat(bbox.east, bbox.north), fromLonLat(bbox.west, bbox.north)];
    const query: [number, number, number, number] = [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))];
    const tiles: Tile[] = [];
    const coverage: Polygon[] = [];
    for (const shape of shpPolygons(index.shp, query)) {
      const name = String(dbfRowAt(index.dbf, shape.index).n_tavola ?? '');
      if (!/^5h\d{9}$/.test(name)) continue;
      const [x0, y0, x1, y1] = shape.box;
      const polygon: Polygon = [[toLonLat(x0, y0), toLonLat(x1, y0), toLonLat(x1, y1), toLonLat(x0, y1)]];
      tiles.push({ url: `${FILES}${name}.laz`, bbox: ringBox(polygon), horizontalCrs: 'EPSG:25832' });
      coverage.push(polygon);
    }
    if (!tiles.length) return [];
    return [
      {
        provider: 'Provincia autonoma di Trento',
        id: 'lidar-2014',
        name: 'Trentino LiDAR PAT 2014/2018',
        url: `${FILES}#2014`,
        format: 'LAZ',
        coverage,
        tiles,
        verticalUnits: 'm',
        acquisitionStart: '2013-01-01',
        acquisitionEnd: '2018-12-31',
        license: 'CC BY 4.0',
        attribution: 'Provincia autonoma di Trento - LiDAR PAT',
        sourcePage: 'https://siat.provincia.tn.it/stem/',
        authoritative: true,
        projectYearHint: 2014,
      },
    ];
  },
};
