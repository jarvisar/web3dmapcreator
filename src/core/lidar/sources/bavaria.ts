// Bavaria's survey (LDBV Laserdaten), flown in lots (2020 to 2024 in the
// cities so far): LAZ per 1 km tile, 11 to 49 returns per m² in the cities,
// 80 to 300 MB a km². Buildings are classified, unlike most German states.
//
// The files have no CORS, so they go through the proxy. Tiles are named by
// their south-west corner in UTM32 km, which spares the metalink service (it
// answers XML to a POST). There's no date index, so each tile's header and
// first point say when it was flown, and a 404 there means the tile is
// outside the state. The server gzips LAZ for any request that accepts gzip
// and then sends no length and ignores Range, so sizes come from a two byte
// range (`noHead` in data/corsProxy.ts) and the proxy asks for identity. The
// files carry no CRS either.

import { proxyAvailable } from '../../data/corsProxy';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import { boxPolygon, clipBox, gridSquares, lasStart, overlaps, ringBox, unlessMissing, YearGroups, type Provider } from './common';

const FILES = 'https://geodaten.bayern.de/odd_data/laser/';
const KM = 1000;

export const bavaria: Provider = {
  id: 'bavaria',
  name: 'LDBV Bayern',
  areas: [[8.9, 47.2, 13.9, 50.6]],
  async discover(fetcher, bbox) {
    if (!proxyAvailable()) return [];
    const { toLonLat } = lonLatTransforms(crsFromEpsg(25832));
    const groups = new YearGroups();
    const squares = gridSquares(25832, bbox, KM).filter(({ x, y }) => overlaps(ringBox(boxPolygon(toLonLat, [x, y, x + KM, y + KM])), bbox));
    const found = await Promise.all(
      squares.map(async ({ x, y }) => {
        const url = `${FILES}${x / KM}_${y / KM}.laz`;
        const start = await unlessMissing(lasStart(fetcher, url));
        return start && { url, start, sheet: [x, y, x + KM, y + KM] as [number, number, number, number] };
      }),
    );
    for (const tile of found) {
      if (!tile?.start.points) continue;
      // Tiles on the state's edge only hold points on its side.
      const shape = boxPolygon(toLonLat, clipBox(tile.start.box, tile.sheet));
      const box = ringBox(shape);
      if (!overlaps(box, bbox)) continue;
      const { year, date } = tile.start;
      groups.add(String(year ?? 'undated'), year, { url: tile.url, bbox: box, horizontalCrs: 'EPSG:25832' }, shape, date ? [date] : []);
    }
    return groups.list((key, year) => ({
      provider: 'LDBV Bayern',
      id: `bavaria-${key}`,
      name: `Bayern Laserdaten ${year ?? ''}`.trim(),
      url: `${FILES}#${key}`,
      format: 'LAZ',
      verticalUnits: 'm',
      // 9 is water in older data and 20 everything above ground that isn't a
      // building. 22 was bridges up to 2020 and is basement entrances since,
      // left out with 23 and 24, synthetic ground.
      classification: { '1': 'unclassified', '2': 'ground', '6': 'building', '9': 'water', '20': 'unclassified', ...(year && year <= 2020 ? { '22': 'bridge' } : {}) },
      license: 'CC BY 4.0',
      attribution: 'Bayerische Vermessungsverwaltung, www.geodaten.bayern.de',
      sourcePage: 'https://geodaten.bayern.de/opengeodata/OpenDataDetail.html?pn=laserdaten',
      authoritative: true,
      projectYearHint: year,
    }));
  },
};
