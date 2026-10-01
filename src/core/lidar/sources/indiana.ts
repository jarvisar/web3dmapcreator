// Indiana's own lidar on AWS (giselevationingov). Only the Lake Michigan rim
// survey of April 2025 (USGS's IN_Central_30_A24, QL1, around 30 returns per
// m²) is read, as COPC: USGS's EPT mirror doesn't have it yet. The statewide
// 2016-2020 COPC there is the same flights as USGS's IN_Statewide EPTs, with
// fewer returns, and the 2024 county and USGS preliminary deliveries are
// uncompressed LAS or LAZ under folders that look temporary.
//
// Tiles are 1250 ft squares of Indiana West (EPSG:6461) named after their
// lower left corner in thousands of feet, so listing a column's prefix says
// which exist.

import type { Polygon } from '../../types';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import { gridSquares, keyPath, ringBox, s3Keys, squarePolygon, type Provider, type Tile } from './common';

const BUCKET = 'https://giselevationingov.s3.amazonaws.com/';
const FOLDER = 'copc/lakerim/2025/SPW/ql1/';
const TILE = 1250;

const thousands = (v: number) => String(Math.floor(v / 1000)).padStart(4, '0');

export const indiana: Provider = {
  id: 'indiana',
  name: 'IndianaMap',
  areas: [[-87.6, 41.55, -86.7, 41.85]],
  async discover(fetcher, bbox) {
    const { toLonLat } = lonLatTransforms(crsFromEpsg(6461));
    const squares = gridSquares(6461, bbox, TILE);
    const columns = [...new Set(squares.map((s) => thousands(s.x)))];
    const listed = new Map<string, number>();
    await Promise.all(
      columns.map(async (column) => {
        for (const [key, { size }] of await s3Keys(fetcher, BUCKET, `${FOLDER}in2025_${column}`, 2)) listed.set(key, size);
      }),
    );
    const tiles: Tile[] = [];
    const coverage: Polygon[] = [];
    for (const { x, y } of squares) {
      // Each tile also comes colourised (_rgb), which only adds bytes here.
      const key = `${FOLDER}in2025_${thousands(x)}${thousands(y)}_03.copc.laz`;
      const size = listed.get(key);
      if (size === undefined) continue;
      const square = squarePolygon(toLonLat, x, y, TILE);
      tiles.push({ url: `${BUCKET}${keyPath(key)}`, bbox: ringBox(square), horizontalCrs: 'EPSG:6461', size });
      coverage.push(square);
    }
    if (!tiles.length) return [];
    return [
      {
        provider: 'IndianaMap',
        id: 'lakerim-2025',
        name: 'Indiana Lake Michigan Rim 2025 (IN_Central_30_A24)',
        url: `${BUCKET}${FOLDER}`,
        format: 'COPC',
        coverage,
        tiles,
        verticalUnits: 'us-ft',
        acquisitionStart: '2025-04-27',
        acquisitionEnd: '2025-04-27',
        license: 'CC0 1.0',
        attribution: 'Indiana Geographic Information Office',
        sourcePage: 'https://registry.opendata.aws/in-elevation/',
        authoritative: true,
        projectYearHint: 2025,
      },
    ];
  },
};
