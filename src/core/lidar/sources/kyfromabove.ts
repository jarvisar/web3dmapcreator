// KyFromAbove, Kentucky's own statewide program, as COPC on AWS: phase 2
// (flown 2019 to 2021) over the whole state and phase 3 (from the winter of
// 2022-23) over most of it so far. USGS's EPT mirror has some of these
// flights and not others: over Louisville and Paducah it only has 2012-2013
// data, 1 to 4.5 returns per m², against 5 to 7 here. Phase 1 (2010-2017,
// plain LAZ) is the data USGS's KY_FullState already holds.
//
// Tiles are 5000 ft squares of Kentucky Single Zone (EPSG:3089) named after
// their row and column, so listing a row's prefix says which exist. The
// files have no capture dates (GPS week time), so each phase gets the year
// it started, which leaves the same flights in USGS's EPT ahead on ties.

import type { Polygon } from '../../types';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import { gridSquares, keyPath, ringBox, s3Keys, squarePolygon, type Candidate, type Provider, type Tile } from './common';

const BUCKET = 'https://kyfromabove.s3.us-west-2.amazonaws.com/';
// Left edge of column 0 and top edge of row 0, US feet.
const X0 = 3775000;
const TOP = 4365000;
const TILE = 5000;
const PHASES = [
  { phase: 2, year: 2019, name: 'KyFromAbove Phase 2 (2019-2021)' },
  { phase: 3, year: 2022, name: 'KyFromAbove Phase 3 (2022-)' },
];

const pad = (n: number) => String(n).padStart(3, '0');

export const kyfromabove: Provider = {
  id: 'kyfromabove',
  name: 'KyFromAbove',
  areas: [[-89.6, 36.4, -81.9, 39.2]],
  async discover(fetcher, bbox) {
    const { toLonLat } = lonLatTransforms(crsFromEpsg(3089));
    const squares = gridSquares(3089, bbox, TILE)
      .map(({ x, y }) => ({ x, y, column: (x - X0) / TILE, row: (TOP - y - TILE) / TILE }))
      .filter((s) => s.column >= 0 && s.row >= 0 && s.column < 1000 && s.row < 1000);
    const rows = [...new Set(squares.map((s) => s.row))];
    const out: Candidate[] = [];
    for (const { phase, year, name } of PHASES) {
      const folder = `elevation/PointCloud/Phase${phase}/`;
      const listed = new Map<string, number>();
      await Promise.all(
        rows.map(async (row) => {
          for (const [key, { size }] of await s3Keys(fetcher, BUCKET, `${folder}N${pad(row)}`, 2)) listed.set(key, size);
        }),
      );
      const tiles: Tile[] = [];
      const coverage: Polygon[] = [];
      for (const { x, y, row, column } of squares) {
        const key = `${folder}N${pad(row)}E${pad(column)}_LAS_Phase${phase}.copc.laz`;
        const size = listed.get(key);
        if (size === undefined) continue;
        const square = squarePolygon(toLonLat, x, y, TILE);
        tiles.push({ url: `${BUCKET}${keyPath(key)}`, bbox: ringBox(square), horizontalCrs: 'EPSG:3089', size });
        coverage.push(square);
      }
      if (!tiles.length) continue;
      out.push({
        provider: 'KyFromAbove',
        id: `phase${phase}`,
        name,
        url: `${BUCKET}${folder}`,
        format: 'COPC',
        coverage,
        tiles,
        // Some phase 2 files have no vertical CRS. Every phase is NAVD88 in US feet.
        verticalUnits: 'us-ft',
        license: 'Public domain with attribution',
        attribution: 'KyFromAbove, Commonwealth of Kentucky',
        sourcePage: 'https://registry.opendata.aws/kyfromabove/',
        authoritative: true,
        projectYearHint: year,
      });
    }
    return out;
  },
};
