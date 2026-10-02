// Saxony's own survey (GeoSN Laserscandaten), flown 2022 to 2024: deflated
// LAZ in a ZIP per 2 km tile, 14 to 18 returns per m², 245 to 365 MB a tile.
// Classified like NRW's, ground (2) and everything else (20). Flai has an
// older copy at 7 to 8 per m² in Dresden and Leipzig, read by COPC node.
//
// The ZIPs are on a public Nextcloud share without CORS, so they go through
// the proxy. Nextcloud locks an address out after enough failed requests,
// and every proxy user shares the proxy's addresses, so nothing is asked of
// it that might fail: the tiles and their dates come from GeoSN's currency
// WMS (one GetFeatureInfo per tile, with CORS). Only tiles it lists have their
// first 375 bytes read, for the member's name and size.

import { proxyAvailable } from '../../data/corsProxy';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import type { Fetcher } from '../read/fetcher';
import { boxPolygon, gridSquares, localMember, overlaps, ringBox, YearGroups, type Provider } from './common';

const SHARE = 'https://geocloud.landesvermessung.sachsen.de/public.php/dav/files/EpkzyJHScGb5ndd/';
const WMS =
  'https://geodienste.sachsen.de/wms_geosn_aktualitaet-gbd/guest?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo' +
  '&LAYERS=Aktualitaet_DHM&QUERY_LAYERS=Aktualitaet_DHM&CRS=EPSG:25833&WIDTH=100&HEIGHT=100&I=50&J=50&INFO_FORMAT=application/geo%2Bjson&FEATURE_COUNT=10';
const TILE = 2000;

/** The tile's flight dates from the currency WMS, or null where it lists no tile. */
async function tileDates(fetcher: Fetcher, x: number, y: number): Promise<string[] | null> {
  const answer = (await fetcher.json(`${WMS}&BBOX=${x},${y},${x + TILE},${y + TILE}`)) as { features?: { properties?: Record<string, unknown> }[] };
  const name = `33${x / 1000}_${y / 1000}_2_sn`;
  for (const feature of answer.features ?? []) {
    const props = feature.properties ?? {};
    if (props.Kachelbezeichnung_AdV !== name) continue;
    // "2024-11-30", or several where a tile was flown on more than one day.
    const key = Object.keys(props).find((k) => /^Aktualit/i.test(k) && /H.henmodell/i.test(k));
    return [...String(key ? props[key] : '').matchAll(/\d{4}-\d{2}-\d{2}/g)].map((m) => m[0]).sort();
  }
  return null;
}

export const saxony: Provider = {
  id: 'saxony',
  name: 'GeoSN Sachsen',
  areas: [[11.8, 50.1, 15.1, 51.7]],
  async discover(fetcher, bbox) {
    if (!proxyAvailable()) return [];
    const { toLonLat } = lonLatTransforms(crsFromEpsg(25833));
    const squares = gridSquares(25833, bbox, TILE)
      .map(({ x, y }) => ({ x, y, shape: boxPolygon(toLonLat, [x, y, x + TILE, y + TILE]) }))
      .filter(({ shape }) => overlaps(ringBox(shape), bbox));
    const found = await Promise.all(
      squares.map(async (square) => {
        const dates = await tileDates(fetcher, square.x, square.y);
        if (!dates) return null;
        const url = `${SHARE}lsc_33${square.x / 1000}_${square.y / 1000}_2_sn_laz.zip`;
        // Read again by the tile reader as its first bytes, so it's not wasted.
        const member = localMember(new Uint8Array(await fetcher.range(url, 0, 375)));
        return { ...square, dates, url, member };
      }),
    );
    const groups = new YearGroups();
    for (const tile of found) {
      if (!tile) continue;
      const last = tile.dates[tile.dates.length - 1];
      const year = last ? Number(last.slice(0, 4)) : null;
      const laz = tile.member && /\.laz$/i.test(tile.member.name) ? tile.member : null;
      groups.add(
        String(year ?? 'undated'),
        year,
        {
          url: tile.url,
          bbox: ringBox(tile.shape),
          horizontalCrs: 'EPSG:25833',
          member: laz?.name ?? `lsc_33${tile.x / 1000}_${tile.y / 1000}_2_sn.laz`,
          bytes: laz?.compressedSize,
        },
        tile.shape,
        tile.dates,
      );
    }
    return groups.list((key, year) => ({
      provider: 'GeoSN Sachsen',
      id: `saxony-${key}`,
      name: `Sachsen Laserscandaten ${year ?? ''}`.trim(),
      url: `${SHARE}#${key}`,
      format: 'LAZ',
      verticalUnits: 'm',
      classification: { '1': 'unclassified', '2': 'ground', '20': 'unclassified' },
      license: 'Datenlizenz Deutschland - Namensnennung - Version 2.0',
      attribution: '© GeoSN, dl-de/by-2-0',
      sourcePage: 'https://www.geodaten.sachsen.de/batch-download-4719.html',
      authoritative: true,
      projectYearHint: year,
    }));
  },
};
