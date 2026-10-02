// Land Salzburg's ALS (SAGIS): LAZ per 625 x 500 m sheet in up to three
// epochs. Epoch 3 (2022 around the city, 2024 in the Pinzgau, 20 to 47
// returns per m²) covers about a quarter of the Land, epoch 2 (flown 2016 to
// 2023 by region, 14 to 74 per m²) nearly all of it. Epoch 1 is left out:
// most of its files are empty and the rest sparse. Standard ASPRS classes.
//
// The files have no CORS, so they go through the proxy. The index answers
// cross-origin but is 30 MB of HTML, so sheets are numbered from their
// position instead: 10 km blocks of MGI / Austria GK M31, 8 x 10 cells of
// 1250 x 1000 m numbered from the north-west, and quadrants 1-4 (NW, NE, SW,
// SE). A HEAD finds the newest epoch of each sheet (404 where there's none),
// and its header and first point say when it was flown. Epoch 3 headers are
// dated a year after the flight, so the GPS date is used where the file has
// one. The files carry no CRS.

import { proxyAvailable } from '../../data/corsProxy';
import type { GeoBounds } from '../../types';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import { boxPolygon, clipBox, lasStart, overlaps, ringBox, unlessMissing, YearGroups, type Provider } from './common';

const FILES = 'https://service.salzburg.gv.at/sagisogd/archiv/raster/hoehen/laserscan/Originalpunkte/ungefiltert/DOM/';
const W = 625;
const H = 500;
const EPOCHS = [3, 2];

/** The sheet number holding a point in GK M31 metres. */
export function sheetName(x: number, y: number): string {
  const bx = Math.floor(x / 10000);
  const by = Math.floor(y / 10000);
  const ox = x - bx * 10000;
  const oy = y - by * 10000;
  const col = Math.floor(ox / 1250);
  const row = Math.min(9, Math.floor((10000 - oy) / 1000));
  const cx = ox - col * 1250;
  const cy = oy - (9 - row) * 1000;
  const quadrant = (cy >= 500 ? 0 : 2) + (cx >= 625 ? 2 : 1);
  return `${bx + 1}${by + 1}${String(row * 8 + col + 1).padStart(2, '0')}${quadrant}`;
}

/** Lower-left corners of the sheets meeting a lon/lat box. */
function sheets(bbox: GeoBounds, limit = 200): { x: number; y: number }[] {
  const { fromLonLat } = lonLatTransforms(crsFromEpsg(31258));
  const corners: [number, number][] = [];
  for (let k = 0; k <= 8; k++) {
    const lon = bbox.west + ((bbox.east - bbox.west) * k) / 8;
    const lat = bbox.south + ((bbox.north - bbox.south) * k) / 8;
    corners.push(fromLonLat(lon, bbox.south), fromLonLat(lon, bbox.north), fromLonLat(bbox.west, lat), fromLonLat(bbox.east, lat));
  }
  const x0 = Math.floor(Math.min(...corners.map((c) => c[0])) / W);
  const x1 = Math.floor(Math.max(...corners.map((c) => c[0])) / W);
  const y0 = Math.floor(Math.min(...corners.map((c) => c[1])) / H);
  const y1 = Math.floor(Math.max(...corners.map((c) => c[1])) / H);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > limit) throw new Error('The area covers too many tiles of this survey');
  const out: { x: number; y: number }[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ x: x * W, y: y * H });
  return out;
}

export const salzburg: Provider = {
  id: 'salzburg',
  name: 'Land Salzburg (SAGIS)',
  areas: [[12, 46.9, 13.95, 48.05]],
  async discover(fetcher, bbox) {
    if (!proxyAvailable()) return [];
    const { toLonLat } = lonLatTransforms(crsFromEpsg(31258));
    const wanted = sheets(bbox).filter(({ x, y }) => overlaps(ringBox(boxPolygon(toLonLat, [x, y, x + W, y + H])), bbox));
    const found = await Promise.all(
      wanted.map(async ({ x, y }) => {
        const sheet: [number, number, number, number] = [x, y, x + W, y + H];
        const name = sheetName(x + W / 2, y + H / 2);
        const out = [];
        // An older epoch only fills what the newer one's points don't reach:
        // some epoch 3 sheets on the edge of a flight block are partly empty.
        for (const epoch of EPOCHS) {
          const url = `${FILES}${name}_dom_op_${epoch}_m.laz`;
          const size = await unlessMissing(fetcher.size(url));
          if (!size) continue;
          const start = await lasStart(fetcher, url, size);
          const box = clipBox(start.box, sheet);
          if (!start.points || box[2] <= box[0] || box[3] <= box[1]) continue;
          out.push({ url, size, epoch, box, start });
          if ((box[2] - box[0]) * (box[3] - box[1]) >= 0.98 * W * H) break;
        }
        return out;
      }),
    );
    const groups = new YearGroups();
    for (const { url, size, epoch, box, start } of found.flat()) {
      const shape = boxPolygon(toLonLat, box);
      const bounds = ringBox(shape);
      if (!overlaps(bounds, bbox)) continue;
      groups.add(`${epoch}-${start.year ?? 'undated'}`, start.year, { url, bbox: bounds, horizontalCrs: 'EPSG:31258', size }, shape, start.date ? [start.date] : []);
    }
    return groups.list((key, year) => {
      const epoch = key.split('-')[0];
      return {
        provider: 'Land Salzburg',
        id: `salzburg-${key}`,
        name: `Salzburg ALS ${year ?? ''} (epoch ${epoch})`.replace('  ', ' '),
        url: `${FILES}#${key}`,
        format: 'LAZ',
        verticalUnits: 'm',
        classification: { '1': 'unclassified', '2': 'ground', '3': 'low vegetation', '4': 'medium vegetation', '5': 'high vegetation', '6': 'building', '9': 'water', '17': 'bridge' },
        license: 'CC BY 4.0',
        attribution: '© Land Salzburg',
        sourcePage: 'https://www.salzburg.gv.at/themen/salzburg/sagis/als-befliegungen',
        authoritative: true,
        projectYearHint: year,
      };
    });
  },
};
