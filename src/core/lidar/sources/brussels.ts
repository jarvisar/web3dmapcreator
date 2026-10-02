// The Brussels region's 2021 point cloud (urban.brussels, UrbIS), all flown on
// 9 October 2021 by its GPS times: 216 tiles of 1 km, about 72 returns per m²,
// buildings classified, heights on TAW like Flanders' DHMV beside it (within
// 3 cm at the Grand Place). Each tile is a ZIP of 1.5 GB holding one deflated
// LAS of 2.9 GB, read as it inflates (no LAZ or COPC on the server), so it's
// the heaviest download there is: 1.5 GB per km². The host sends no CORS
// headers.
//
// Tiles are named after their south-west corner in Lambert 72 km, and every
// name carries the same date (20210910, which isn't the flight). The set is
// fixed, so it's listed below instead of read from the ATOM feed, which only
// says the same thing. The LAS has no CRS record. The member isn't named, so
// an offer asks for the ZIP's size, which is the member's give or take its
// header.

import type { Polygon } from '../../types';
import { proxyAvailable } from '../../data/corsProxy';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import { overlaps, ringBox, squarePolygon, type Provider, type Tile } from './common';

const FILES = 'https://urbisdownload.datastore.brussels/UrbIS/Vector/M8/PointCloud2021/LAS/';
const KM = 1000;
// Row (south edge, N km) : runs of west edges (E km), from the ATOM feed in October 2026.
const ROWS =
  '178:151-153 177:147-148,150-154 176:145-154 175:144-154 174:144-155 173:143-154 172:143-155 171:143-156 170:143-157 ' +
  '169:141-157 168:141-157 167:140-157 166:142-156 165:145-158 164:145-158 163:146-156 162:146-155 161:150-152';

export function brusselsTiles(): [number, number][] {
  const out: [number, number][] = [];
  for (const row of ROWS.trim().split(/\s+/)) {
    const [south, runs] = row.split(':');
    for (const run of runs.split(',')) {
      const [a, b = a] = run.split('-');
      for (let e = Number(a); e <= Number(b); e++) out.push([e, Number(south)]);
    }
  }
  return out;
}

export const brussels: Provider = {
  id: 'brussels',
  name: 'urban.brussels',
  areas: [[4.22, 50.75, 4.5, 50.93]],
  async discover(_fetcher, bbox) {
    if (!proxyAvailable()) return [];
    const { toLonLat } = lonLatTransforms(crsFromEpsg(31370));
    const tiles: Tile[] = [];
    const coverage: Polygon[] = [];
    for (const [e, n] of brusselsTiles()) {
      const square = squarePolygon(toLonLat, e * KM, n * KM, KM);
      const box = ringBox(square);
      if (!overlaps(box, bbox)) continue;
      tiles.push({ url: `${FILES}PointCloud_31370_LAS_${e}${n}_20210910.zip`, bbox: box, horizontalCrs: 'EPSG:31370' });
      coverage.push(square);
    }
    if (!tiles.length) return [];
    return [
      {
        provider: 'urban.brussels',
        id: 'pointcloud-2021',
        name: 'Brussels LiDAR 2021',
        url: `${FILES}#2021`,
        format: 'LAZ',
        coverage,
        tiles,
        verticalUnits: 'm',
        acquisitionStart: '2021-10-09',
        acquisitionEnd: '2021-10-09',
        densityM2: 72,
        license: 'CC BY 4.0',
        attribution: 'urban.brussels (UrbIS), Airborne LiDAR pointcloud 2021',
        sourcePage: 'https://datastore.brussels/web/data/dataset/ff1124e1-424e-11ee-b156-00090ffe0001',
        authoritative: true,
        projectYearHint: 2021,
      },
    ];
  },
};
