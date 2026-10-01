// City of Turku's 2021 survey (flown 18 April), LAZ per 500 m sheet: 71 to
// 86 returns per m², buildings classified, 115-150 MB a sheet. The national
// survey needs an API key, and Flai's copy of it has 0.5-2 per m² here.
//
// Sheets are named after their west and north edges in ETRS-GK23. The city's
// own index only answers its own site, so the sheets it lists are below, as
// runs of columns per row, in 500 m steps from E 23449500 and N 6692500 (from
// its index in October 2026). The files carry no CRS.

import type { Polygon } from '../../types';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import { overlaps, ringBox, squarePolygon, type Provider, type Tile } from './common';

const FILES = 'https://turku.asiointi.fi/3d/pistepilvi/';
const SHEET = 500;
const E0 = 23449500;
const N0 = 6692500;
// Row (north edge) : columns from-to (west edges), several runs where the city's edge has gaps.
const ROWS =
  '88:37-37 87:36-37 86:36-38 85:36-38 84:36-38 83:36-39 82:36-39 81:36-39 80:36-40 79:35-41 ' +
  '78:35-41 77:35-41 76:35-41 75:35-41 74:35-41 73:35-41 72:35-41 71:35-41 70:34-41 69:34-41 ' +
  '68:34-40 67:33-40 66:33-40 65:34-40 64:33-40 63:33-40 62:32-40 61:31-39 60:30-39 59:29-38 ' +
  '58:28-38 57:27-37 56:26-37 55:26-37 54:25-35 53:25-35 52:24-34 51:24-34 50:23-33 49:23-33 ' +
  '48:23-32 47:23-32 46:23-32 45:22-32 44:22-32 43:22-32 42:21-32 41:15-17,19-33 40:15-32 39:16-32 ' +
  '38:16-32 37:17-31 36:18-31 35:17-30 34:15-30 33:14-31 32:13-32 31:13-31 30:12-28,30-31 29:12-27 ' +
  '28:4-8,11-29 27:4-29 26:3-30 25:3-30 24:3-30 23:3-31 22:3-31 21:3-31 20:0-31 19:0-30 18:0-28 ' +
  '17:0-27 16:2-26 15:2-24 14:4-21 13:5-21 12:4-21 11:3-21 10:2-21 9:2-22 8:2-23 7:2-24 6:1-24 ' +
  '5:1-24 4:0-24 3:0-24 2:0-4,6-21 1:7-17 0:9-13';

function sheets(): [number, number][] {
  const out: [number, number][] = [];
  for (const row of ROWS.trim().split(/\s+/)) {
    const [north, runs] = row.split(':');
    for (const run of runs.split(',')) {
      const [a, b] = run.split('-').map(Number);
      for (let c = a; c <= b; c++) out.push([E0 + c * SHEET, N0 + Number(north) * SHEET]);
    }
  }
  return out;
}

export const turku: Provider = {
  id: 'turku',
  name: 'City of Turku',
  areas: [[22.0, 60.33, 22.45, 60.73]],
  async discover(_fetcher, bbox) {
    const { toLonLat } = lonLatTransforms(crsFromEpsg(3877));
    const tiles: Tile[] = [];
    const coverage: Polygon[] = [];
    for (const [west, north] of sheets()) {
      const square = squarePolygon(toLonLat, west, north - SHEET, SHEET);
      const box = ringBox(square);
      if (!overlaps(box, bbox)) continue;
      tiles.push({ url: `${FILES}${west}_${north}.laz`, bbox: box, horizontalCrs: 'EPSG:3877' });
      coverage.push(square);
    }
    if (!tiles.length) return [];
    return [
      {
        provider: 'City of Turku',
        id: '2021',
        name: 'Turku laser data 2021',
        url: `${FILES}#2021`,
        format: 'LAZ',
        coverage,
        tiles,
        verticalUnits: 'm',
        // 8 is model keypoints (ground) and 10 bridges.
        classification: { '1': 'unclassified', '2': 'ground', '3': 'low vegetation', '4': 'medium vegetation', '5': 'high vegetation', '6': 'building', '8': 'ground', '9': 'water', '10': 'bridge' },
        acquisitionStart: '2021-04-18',
        acquisitionEnd: '2021-04-18',
        license: 'CC BY 4.0',
        attribution: 'Turun kaupunki, Kaupunkiympäristön palvelukokonaisuus',
        sourcePage: 'https://www.avoindata.fi/data/fi/dataset/turun-kaupungin-kaupunkitietomalli',
        authoritative: true,
        projectYearHint: 2021,
      },
    ];
  },
};
