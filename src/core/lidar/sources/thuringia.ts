// Thuringia's survey (TLBG, GDI-Th): deflated LAZ in a ZIP per 1 km tile,
// 10 to 14 returns per m², 55 to 70 MB a tile. Classified ground (2) and
// everything else (1, 20), no buildings. The 2020-2025 campaign is read, and
// 2014-2019 only for a tile the newer one doesn't have yet.
//
// The files have no CORS, so they go through the proxy. Tiles are named by
// their south-west corner in UTM32 km. Each ZIP ends with a small `.meta`
// text member giving the month the tile was flown, which is worth reading:
// a campaign spans six years and Erfurt's 2020-2025 tile was flown in
// December 2019. The LAZ member's local header (the first 375 bytes, which
// the reader asks for again anyway) says where the `.meta` starts, and one
// read from there to the end gets it, so a tile costs two small requests.

import { inflateSync } from 'fflate';
import type { Polygon } from '../../types';
import { proxyAvailable } from '../../data/corsProxy';
import { crsFromEpsg, lonLatTransforms } from '../read/crs';
import type { Fetcher } from '../read/fetcher';
import { boxPolygon, gridSquares, localMember, overlaps, ringBox, unlessMissing, YearGroups, type Provider } from './common';

const FILES = 'https://geoportal.geoportal-th.de/hoehendaten/LAS/';
const KM = 1000;
const CAMPAIGNS = [
  { id: '2020-2025', first: 2020, file: (e: number, n: number) => `las_2020-2025/las_32_${e}_${n}_1_th_2020-2025.zip` },
  { id: '2014-2019', first: 2014, file: (e: number, n: number) => `las_2014-2019/las_${e}_${n}_1_th_2014-2019.zip` },
];

interface Found {
  url: string;
  campaign: (typeof CAMPAIGNS)[number];
  member?: string;
  bytes?: number;
  /** YYYY-MM from the `.meta`, when it was read. */
  month?: string;
}

/** The flight month from a `.meta` member: "Erfassungsdatum: 2019-12". */
export function metaMonth(text: string): string | undefined {
  return /Erfassungsdatum:\s*(\d{4}-\d{2})/.exec(text)?.[1];
}

async function readTile(fetcher: Fetcher, url: string): Promise<Omit<Found, 'campaign'> | null> {
  const first = await unlessMissing(fetcher.range(url, 0, 375));
  if (!first) return null;
  const laz = localMember(new Uint8Array(first));
  if (!laz || !/\.laz$/i.test(laz.name) || laz.compressedSize === undefined) return { url };
  const found = { url, member: laz.name, bytes: laz.compressedSize };
  // The `.meta` follows the LAZ, then the central directory. A tile without
  // one still reads, it just takes its campaign's first year.
  const rest = new Uint8Array(await fetcher.tail(url, laz.dataAt + laz.compressedSize));
  const meta = localMember(rest);
  if (!meta || !/\.meta$/i.test(meta.name) || meta.compressedSize === undefined || meta.dataAt + meta.compressedSize > rest.length) return found;
  const data = rest.subarray(meta.dataAt, meta.dataAt + meta.compressedSize);
  try {
    const text = new TextDecoder().decode(meta.method === 8 ? inflateSync(data) : data);
    return { ...found, month: metaMonth(text) };
  } catch {
    return found;
  }
}

export const thuringia: Provider = {
  id: 'thuringia',
  name: 'TLBG Thüringen',
  areas: [[9.8, 50.2, 12.7, 51.7]],
  async discover(fetcher, bbox) {
    if (!proxyAvailable()) return [];
    const { toLonLat } = lonLatTransforms(crsFromEpsg(25832));
    const squares = gridSquares(25832, bbox, KM)
      .map(({ x, y }) => ({ x, y, shape: boxPolygon(toLonLat, [x, y, x + KM, y + KM]) as Polygon }))
      .filter(({ shape }) => overlaps(ringBox(shape), bbox));
    const found = await Promise.all(
      squares.map(async ({ x, y, shape }) => {
        // Tiles outside the state, or not flown yet, are 404.
        for (const campaign of CAMPAIGNS) {
          const tile = await readTile(fetcher, `${FILES}${campaign.file(x / KM, y / KM)}`);
          if (tile) return { ...tile, campaign, shape };
        }
        return null;
      }),
    );
    const groups = new YearGroups();
    for (const tile of found) {
      if (!tile) continue;
      const year = tile.month ? Number(tile.month.slice(0, 4)) : tile.campaign.first;
      const dates = tile.month ? [`${tile.month}-01`, monthEnd(tile.month)] : [];
      groups.add(
        `${tile.campaign.id}-${year}`,
        year,
        { url: tile.url, bbox: ringBox(tile.shape), horizontalCrs: 'EPSG:25832', member: tile.member, bytes: tile.bytes },
        tile.shape,
        dates,
      );
    }
    return groups.list((key, year) => ({
      provider: 'TLBG Thüringen',
      id: `thuringia-${key}`,
      name: `Thüringen Laserpunkte ${year}`,
      url: `${FILES}#${key}`,
      format: 'LAZ',
      verticalUnits: 'm',
      classification: { '1': 'unclassified', '2': 'ground', '20': 'unclassified' },
      license: 'CC BY 4.0',
      attribution: '© GDI-Th',
      sourcePage: 'https://geoportal.thueringen.de/',
      authoritative: true,
      projectYearHint: year,
    }));
  },
};

function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const day = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, '0')}`;
}
