// Vorarlberg's 2023 survey (VoGIS, the fourth since 2002-04), flown March to
// November 2023: COPC per 2.5 km sheet, thinned to one point per 12.5 cm
// cell, about 27 returns per m² (15 along the Rhine at Lustenau). Buildings
// and bridges are classified. The older surveys aren't read, since 2023
// covers the whole Land.
//
// The files have no CORS, so they go through the proxy. Their index is a
// 6.8 MB virtual point cloud, so the sheets are listed here instead (from it,
// October 2026) and named from their position: the BEV's 1:5000 sheets,
// 10 km blocks of MGI / Austria GK West with 5 km cells 50-53 and 2.5 km
// quarters 00-03, both numbered from the north-west. Sheets on the border
// keep the box their points cover. The header's WKT names EPSG:31254
// without a datum shift, and crs.ts's definition with it wins.

import type { Polygon } from '../../types';
import { proxyAvailable } from '../../data/corsProxy';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import { boxPolygon, gridSquares, overlaps, ringBox, type Provider, type Tile } from './common';

const FILES = 'https://vogis.cnv.at/geodaten/api/public/dl/OTSj-JMs/gelaendemodelle/lidarpunkte/kacheln/2023/';
const SHEET = 2500;
const X0 = -62500;
const Y0 = 187500;
// Row (2.5 km up from Y0) : column runs (2.5 km east of X0).
const ROWS =
  '34:7-9 33:7-9 32:6-14 31:4,6-14 30:1-14 29:1-16 28:2-17 27:4-18 26:4-18 25:4-17,20-21 24:3-22 23:2-21 22:2-21 21:1-21 20:0-21 ' +
  '19:0-21 18:1-21 17:1-21 16:1-21 15:1-21 14:2-21 13:3-21 12:3-20 11:2-19 10:2-19 9:5-19 8:8-19 7:10-19 6:10-19 5:10-19 4:11-18 ' +
  '3:12-18 2:15-19 1:16-19 0:17-19';
// Sheets the points don't fill: column.row : west, south, east, north in metres from the sheet's corner.
const PARTIAL =
  '0.20:1740,0,2500,610 0.19:1590,840,2500,2500 2.11:2420,210,2500,820 3.12:750,0,2500,2500 2.10:2150,800,2500,2070 3.10:0,10,2500,2500 ' +
  '4.10:0,300,2500,2500 1.16:2180,0,2500,1150 1.15:1540,700,2500,2500 2.14:1520,780,2500,2500 3.13:980,0,2500,2500 1.18:880,0,2500,2500 ' +
  '1.17:620,630,2500,2500 2.23:1650,0,2500,1640 3.24:840,0,2500,2010 2.22:930,0,2500,2500 1.21:920,0,2500,1570 2.28:1000,650,2500,2500 ' +
  '3.28:0,30,2500,2500 4.27:300,0,2500,2500 4.26:350,0,2500,2500 4.25:240,0,2500,2500 4.31:410,0,1260,630 1.30:1650,0,2500,800 2.30:0,0,180,350 ' +
  '1.29:1660,1290,2500,2500 3.30:1760,0,2500,680 8.8:1550,1840,2500,2500 5.9:2160,2020,2500,2500 6.9:0,1400,2500,2500 7.9:0,820,2500,2500 ' +
  '6.32:2280,0,2500,510 6.31:1690,860,2500,2500 5.30:0,0,2500,1240 6.30:0,0,2500,1190 7.34:2130,0,2500,160 8.34:0,0,2500,890 7.33:780,0,2500,2500 ' +
  '11.4:0,860,2500,2500 12.3:1400,1990,2500,2500 9.8:0,450,2500,2500 10.7:2250,2300,2500,2500 10.6:2110,0,2500,1480 10.5:2290,1090,2500,2500 ' +
  '10.32:0,0,150,90 11.32:410,0,2500,520 12.32:0,0,230,80 9.34:0,0,1440,890 9.33:0,0,2170,2500 13.3:0,1890,2500,2500 14.3:0,390,2500,2500 ' +
  '15.2:1530,1420,2500,2500 16.1:760,1130,2500,2500 13.32:2150,0,2500,280 14.32:0,0,430,290 14.31:0,0,470,2500 14.30:0,0,2290,2500 15.29:0,0,2500,1340 ' +
  '16.29:0,0,1490,1410 17.0:1660,1460,2500,2500 18.0:0,1410,2500,2500 19.0:0,2130,810,2500 18.4:0,0,1670,2500 18.3:0,0,790,2500 19.2:0,0,660,740 ' +
  '19.1:0,0,860,2500 19.8:0,0,1580,2500 19.7:0,0,2030,2500 19.6:0,0,2480,2500 19.5:0,1320,2220,2500 20.12:0,1650,1550,2500 19.11:0,0,940,2500 ' +
  '19.10:0,0,1730,2500 19.9:0,0,1820,2500 18.24:0,0,2500,1840 19.24:0,0,2500,2320 17.28:0,0,2060,910 18.27:0,0,230,350 18.26:0,1390,540,2500 ' +
  '17.25:0,0,1570,2500 20.25:850,0,2330,620 21.16:0,0,1150,2500 21.15:0,0,970,2500 21.14:0,0,1790,2500 21.13:0,850,1690,2500 21.20:0,2220,270,2500 ' +
  '21.19:0,0,1800,610 21.18:0,0,1920,2500 21.17:0,0,1170,2500 22.24:0,130,460,2290 21.23:0,0,2410,2500 21.22:0,0,1040,2500 21.21:0,0,1340,2500 ' +
  '21.25:1740,0,2380,220';

let listed: Map<string, [number, number, number, number]> | null = null;

/** Every sheet by its lower-left corner, with the box its points cover. */
export function sheets(): Map<string, [number, number, number, number]> {
  if (listed) return listed;
  const boxes = new Map<string, [number, number, number, number]>();
  for (const entry of PARTIAL.split(' ')) {
    const [cell, box] = entry.split(':');
    boxes.set(cell, box.split(',').map(Number) as [number, number, number, number]);
  }
  listed = new Map();
  for (const row of ROWS.split(' ')) {
    const [r, runs] = row.split(':');
    for (const run of runs.split(',')) {
      const [a, b = a] = run.split('-').map(Number);
      for (let c = a; c <= b; c++) {
        const [w, s, e, n] = boxes.get(`${c}.${r}`) ?? [0, 0, SHEET, SHEET];
        const x = X0 + c * SHEET;
        const y = Y0 + Number(r) * SHEET;
        listed.set(`${x},${y}`, [x + w, y + s, x + e, y + n]);
      }
    }
  }
  return listed;
}

/** The sheet name for the 2.5 km sheet with this lower-left corner in GK West. */
export function sheetName(x: number, y: number): string {
  const bx = Math.floor(x / 10000);
  const by = Math.floor(y / 10000);
  const ox = x - bx * 10000;
  const oy = y - by * 10000;
  const cell = (oy >= 5000 ? 0 : 2) + (ox >= 5000 ? 1 : 0);
  const quarter = (oy % 5000 >= 2500 ? 0 : 2) + (ox % 5000 >= 2500 ? 1 : 0);
  // Block columns count from x = -160 km, as in the M28 zone's numbering.
  return `${String(bx + 16).padStart(2, '0')}${String(by + 1).padStart(2, '0')}${50 + cell}0${quarter}`;
}

export const vorarlberg: Provider = {
  id: 'vorarlberg',
  name: 'Land Vorarlberg (VoGIS)',
  areas: [[9.5, 46.8, 10.25, 47.6]],
  async discover(_fetcher, bbox) {
    if (!proxyAvailable()) return [];
    const { toLonLat } = lonLatTransforms(crsFromEpsg(31254));
    const all = sheets();
    const tiles: Tile[] = [];
    const coverage: Polygon[] = [];
    for (const { x, y } of gridSquares(31254, bbox, SHEET)) {
      const box = all.get(`${x},${y}`);
      if (!box) continue;
      const shape = boxPolygon(toLonLat, box);
      const bounds = ringBox(shape);
      if (!overlaps(bounds, bbox)) continue;
      tiles.push({ url: `${FILES}pc2023_${sheetName(x, y)}.copc.laz`, bbox: bounds, horizontalCrs: 'EPSG:31254' });
      coverage.push(shape);
    }
    if (!tiles.length) return [];
    return [
      {
        provider: 'Land Vorarlberg',
        id: 'vorarlberg-2023',
        name: 'Vorarlberg Lidarpunkte 2023',
        url: `${FILES}#2023`,
        format: 'COPC',
        coverage,
        tiles,
        verticalUnits: 'm',
        // From the survey reports: 64 is dams and embankments ("Dämme,
        // Staumauern"), 34 and 41 synthetic ground and water points for the
        // terrain model, left out with wires (14, 15) and noise (7). 22 and 63
        // aren't described anywhere. Both sit at about ground level and are
        // left out too.
        classification: {
          '1': 'unclassified',
          '2': 'ground',
          '3': 'low vegetation',
          '4': 'medium vegetation',
          '5': 'high vegetation',
          '6': 'building',
          '9': 'water',
          '17': 'bridge',
          '64': 'ground',
        },
        acquisitionStart: '2023-03-18',
        acquisitionEnd: '2023-11-09',
        license: 'CC BY 4.0',
        attribution: 'Land Vorarlberg, data.vorarlberg.gv.at',
        sourcePage: 'https://vogis.cnv.at/geonetwork/srv/api/records/d2af1b63-113e-480b-8380-4048a91ddfa4',
        authoritative: true,
        projectYearHint: 2023,
      },
    ];
  },
};
