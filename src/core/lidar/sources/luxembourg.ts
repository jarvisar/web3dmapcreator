// Luxembourg's 2024 survey of the whole country, about 40 points per m²: one
// stored ZIP per 1.5 km block, each holding up to nine 500 m COPC files that
// read in place by range. The dataset API (1.6 MB) lists the ZIPs. Which
// block and member hold a point follows from the grid, so there's no tile
// index to read. 2019 is left to Flai's COPC mirror.

import type { Polygon } from '../../types';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import { gridSquares, ringBox, squarePolygon, type Provider, type Tile } from './common';

const DATASET = 'https://data.public.lu/api/1/datasets/lidar-2024-releve-3d-du-territoire-luxembourgeois/';
// Lower left of block c000-r000 in LUREF (EPSG:2169). Checked against the
// members' own bounds: c020-r013 holds X 77000-78500, Y 74500-76000.
const X0 = 47000;
const Y0 = 55000;
const BLOCK = 1500;
const TILE = 500;

export const luxembourg: Provider = {
  id: 'luxembourg',
  name: 'Luxembourg (data.public.lu)',
  areas: [[5.7, 49.4, 6.55, 50.2]],
  async discover(fetcher, bbox) {
    const dataset = (await fetcher.json(DATASET)) as { resources?: { title?: string; url?: string; filesize?: number }[] };
    if (!Array.isArray(dataset.resources)) throw new Error('The Luxembourg dataset answered without resources');
    // Some blocks were uploaded again later, under another folder: the URL has to come from here.
    const zips = new Map<string, { url: string; size?: number }>();
    for (const r of dataset.resources) {
      if (/^lidar2024-c\d{3}-r\d{3}\.zip$/.test(r.title ?? '') && /^https:\/\//.test(r.url ?? '')) zips.set(r.title!, { url: r.url!, size: r.filesize || undefined });
    }
    if (!zips.size) throw new Error('The Luxembourg dataset lists no LiDAR blocks');
    const { toLonLat } = lonLatTransforms(crsFromEpsg(2169));
    const tiles: Tile[] = [];
    const coverage: Polygon[] = [];
    for (const { x, y } of gridSquares(2169, bbox, TILE)) {
      const pad = (n: number) => String(n).padStart(3, '0');
      const zip = zips.get(`lidar2024-c${pad(Math.floor((x - X0) / BLOCK))}-r${pad(Math.floor((y - Y0) / BLOCK))}.zip`);
      if (!zip) continue;
      const square = squarePolygon(toLonLat, x, y, TILE);
      // Members are named after their left and top edges. A block along the
      // border lacks some, and those tiles are skipped when read.
      tiles.push({ url: zip.url, member: `${x}_${y + TILE}.laz`, size: zip.size, bbox: ringBox(square), horizontalCrs: 'EPSG:2169' });
      coverage.push(square);
    }
    if (!tiles.length) return [];
    return [
      {
        provider: 'ACT Luxembourg',
        id: 'lidar2024',
        name: 'Luxembourg LiDAR 2024',
        url: `${DATASET}#copc`,
        format: 'COPC',
        coverage,
        tiles,
        verticalUnits: 'm',
        // 13 is bridges here, not ASPRS's wire guard.
        classification: { '1': 'unclassified', '2': 'ground', '3': 'low vegetation', '4': 'medium vegetation', '5': 'high vegetation', '6': 'building', '9': 'water', '13': 'bridge' },
        acquisitionStart: '2024-02-28',
        acquisitionEnd: '2024-04-30',
        license: 'CC0 1.0',
        attribution: 'Administration du cadastre et de la topographie (ACT), Lidar 2024',
        sourcePage: 'https://data.public.lu/fr/datasets/lidar-2024-releve-3d-du-territoire-luxembourgeois/',
        authoritative: true,
        projectYearHint: 2024,
      },
    ];
  },
};
