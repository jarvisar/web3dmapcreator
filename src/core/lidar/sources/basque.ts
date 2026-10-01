// The Basque Country (geoEuskadi): PNOA's 2016-17 flight reprocessed by the
// Basque government, 500 m LAZ tiles of 10-15 MB at 3 to 6 points per m².
// Sparse, but it's the only browser route for Bilbao, San Sebastián and
// Vitoria: Flai's PNOA mirror has no Basque block. Files sit in one folder
// per MTN50 sheet, named after their lower left corner in hectometres, and
// the sheet comes from the zipped tile index (1.1 MB, 27 MB unzipped). The
// old IIS server is slow and sometimes answers 503, which is retried.

import type { Polygon } from '../../types';
import { crsFromEpsg, crsFromWkt, lonLatTransforms } from '../read/crs';
import { ringBox, type Provider, type Tile } from './common';
import { dbfRowAt, shpPolygons, zippedIndex } from './shapefile';

const BASE = 'https://www.geo.euskadi.eus/lidar/DatosDescarga/LIDAR/LIDAR_2017_ETRS89/';
const WEEK_MS = 7 * 24 * 3600 * 1000;

export const basque: Provider = {
  id: 'basque',
  name: 'geoEuskadi (Basque Country)',
  areas: [[-3.5, 42.4, -1.7, 43.5]],
  async discover(fetcher, bbox) {
    const index = await zippedIndex(fetcher, `${BASE}HOJAS_LAS_LIDAR_2017_ETRS89.zip`, WEEK_MS);
    const { toLonLat, fromLonLat } = lonLatTransforms(index.prj ? { ...crsFromWkt(index.prj), epsg: 25830, key: 'EPSG:25830' } : crsFromEpsg(25830));
    const corners = [fromLonLat(bbox.west, bbox.south), fromLonLat(bbox.east, bbox.south), fromLonLat(bbox.east, bbox.north), fromLonLat(bbox.west, bbox.north)];
    const query: [number, number, number, number] = [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))];
    const tiles: Tile[] = [];
    const coverage: Polygon[] = [];
    const dates: string[] = [];
    for (const shape of shpPolygons(index.shp, query)) {
      const row = dbfRowAt(index.dbf, shape.index);
      const sheet = String(row.sc50clas ?? '').padStart(3, '0');
      const [x0, y0, x1, y1] = shape.box;
      if (!/^\d{3}$/.test(sheet) || x1 - x0 > 600 || y1 - y0 > 600) continue;
      const polygon: Polygon = [[toLonLat(x0, y0), toLonLat(x1, y0), toLonLat(x1, y1), toLonLat(x0, y1)]];
      // The files' GeoTIFF keys say WGS 84 / UTM 30, a metre off ETRS89 at most.
      tiles.push({ url: `${BASE}${sheet}/${Math.round(x0 / 100)}-${Math.round(y0 / 100)}.laz`, bbox: ringBox(polygon), horizontalCrs: 'EPSG:25830' });
      coverage.push(polygon);
      // dBase dates are YYYYMMDD.
      const date = String(row.fecha ?? '');
      if (/^\d{8}$/.test(date)) dates.push(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`);
    }
    if (!tiles.length) return [];
    dates.sort();
    return [
      {
        provider: 'geoEuskadi',
        id: 'lidar-2017',
        name: 'Basque Country LiDAR 2017',
        url: `${BASE}#2017`,
        format: 'LAZ',
        coverage,
        tiles,
        verticalUnits: 'm',
        // The flight was PNOA's of 2016. The index's dates are when it was processed.
        acquisitionStart: '2016-01-01',
        acquisitionEnd: dates.at(-1) ?? '2017-12-31',
        license: 'CC BY 4.0',
        attribution: 'Gobierno Vasco - geoEuskadi',
        sourcePage: 'https://www.geo.euskadi.eus/',
        authoritative: true,
        projectYearHint: 2016,
      },
    ];
  },
};
