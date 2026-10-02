// TxGIO's StratMap lidar (Texas Water Development Board). Every collection is
// one ZIP per quarter quad (3.75 minutes, about 6 x 7 km) of 16 LAZ members,
// each a 1/64 degree cell, so no index is downloaded: the quarter
// quad's id comes from lon/lat, one call to TxGIO's API (which answers
// cross-origin) lists every collection's ZIP there, and the ZIP's central
// directory, read by range, says which members exist.
//
// Where it beats 3DEP: Austin 2021 (31.6 returns per m² against 8.2 in
// 2017), El Paso 2023, San Antonio 2021, Round Rock and San Marcos 2024,
// College Station 2025. Only collections from 2019 on are listed. 3DEP
// covered the state by 2018 and Hobu's mirror has it, the older collections
// are those flights or older, and every listed ZIP costs a central directory
// read through the proxy. The usgs ones are USGS projects the mirror has too.
//
// Most members are deflated, so they're fetched whole and inflated: 500 to
// 830 MB each in Austin. Some are stored and read in place. Deflated ones
// over the reader's inflate limit (768 MiB, read/tiles.ts) are left out, 11
// of Travis County's 516 28 cm members in October 2026, so another survey
// fills their cells. The file host's CloudFront refuses requests without a
// browser-like User-Agent, which the proxy sends.

import { Inflate } from 'fflate';
import type { GeoBounds, Polygon } from '../../types';
import { proxyAvailable } from '../../data/corsProxy';
import { readHeader } from '../read/las';
import type { Fetcher } from '../read/fetcher';
import { centralMembers, type ZipMember } from '../read/zip';
import { briefly, overlaps, Surveys, type Box, type Provider } from './common';

const API = 'https://api.tnris.org/api/v1/';
const FILES = 'https://data.geographic.texas.gov/';
const OLDEST = 2019;
const QQ = 1 / 16;
const CELL = 1 / 64;
// A model reaching past this many quarter quads isn't one this is for.
const MAX_QUADS = 16;
const WEEK_MS = 7 * 24 * 3600 * 1000;
// read/tiles.ts won't inflate a member larger than this.
const MAX_INFLATED = 768 * 1024 * 1024;

interface Resource {
  resource?: string;
  filesize?: number;
  collection_id?: string;
  resource_type_abbreviation?: string;
}

/** The quarter quad holding a point, as TxGIO numbers it: latitude, longitude mod 100, the 7.5' quad (row by row from the degree's north-west corner), then NW 1, NE 2, SW 3, SE 4. */
export function quarterQuad(lon: number, lat: number): string {
  const a = -lon;
  const latDeg = Math.floor(lat);
  const lonDeg = Math.floor(a);
  const row = Math.floor((latDeg + 1 - lat) / 0.125);
  const col = Math.floor((lonDeg + 1 - a) / 0.125);
  const north = latDeg + 1 - row * 0.125;
  const west = -(lonDeg + 1) + col * 0.125;
  const quarter = (lat >= north - QQ ? 1 : 3) + (lon >= west + QQ ? 1 : 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(latDeg)}${pad(lonDeg % 100)}${pad(row * 8 + col + 1)}${quarter}`;
}

/** Quarter quads meeting a box, by id, with their lon/lat boxes. */
export function quarterQuads(bbox: GeoBounds): Map<string, Box> {
  const out = new Map<string, Box>();
  const index = (v: number) => Math.floor(v / QQ + 1e-9);
  const [i0, i1, j0, j1] = [index(bbox.west), index(bbox.east), index(bbox.south), index(bbox.north)];
  if ((i1 - i0 + 1) * (j1 - j0 + 1) > MAX_QUADS) throw new Error('The area covers too many TxGIO quarter quads');
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const box: Box = [i * QQ, j * QQ, (i + 1) * QQ, (j + 1) * QQ];
      out.set(quarterQuad(box[0] + QQ / 2, box[1] + QQ / 2), box);
    }
  }
  return out;
}

/** A member's 1/64 degree cell: the letter is the quarter of the quarter quad, the digit the quarter of that, both NW, NE, SW, SE. */
export function memberCell(quad: Box, letter: string, digit: string): Box {
  const q = 'abcd'.indexOf(letter);
  const d = Number(digit) - 1;
  const west = quad[0] + (q % 2) * 2 * CELL + (d % 2) * CELL;
  const north = quad[3] - (q >> 1) * 2 * CELL - (d >> 1) * CELL;
  return [west, north - CELL, west + CELL, north];
}

/** Agency, year and place from a ZIP's name, `stratmap21-28cm-50cm-bexar-travis_3097433_lpc.zip`. */
export function nameParts(name: string): { agency: string; year: number; place: string } | null {
  const match = /^([a-z-]*?)-?(\d{4}|\d{2})-(.*)_\d{7}_lpc\.zip$/.exec(name);
  if (!match) return null;
  const year = match[2].length === 2 ? 2000 + Number(match[2]) : Number(match[2]);
  const place = match[3].replace(/(^|-)\d+c?m(?=-|$)/g, '').replace(/^-+|-+$/g, '');
  return { agency: match[1], year, place };
}

const title = (slug: string) =>
  slug
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');

/**
 * Returns per m² of one member from its header. The start of a deflated
 * stream inflates on its own, so either way that's one small range. Counted
 * over the member's whole cell, so a member at a survey's edge reads low.
 * Ranking can't read a deflated member's header, and without a density
 * Austin's 2021 survey (four times denser, four years newer) would never be
 * offered where the 2017 one measured a building.
 */
async function memberDensity(fetcher: Fetcher, url: string, size: number, member: ZipMember, cell: Box): Promise<number | undefined> {
  // The local header, its name and extra field, then the start of the data.
  const end = Math.min(member.offset + Math.min(member.compressedSize + 1024, 32 * 1024), size);
  const head = new Uint8Array(await fetcher.range(url, member.offset, end));
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (view.getUint32(0, true) !== 0x04034b50) return undefined;
  const data = head.subarray(30 + view.getUint16(26, true) + view.getUint16(28, true));
  let bytes = data;
  if (member.method === 8) {
    const parts: Uint8Array[] = [];
    new Inflate((part) => parts.push(part)).push(data);
    bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    parts.reduce((at, part) => (bytes.set(part, at), at + part.length), 0);
  }
  if (bytes.length < 375) return undefined;
  const { pointCount } = readHeader(bytes);
  const lat = ((cell[1] + cell[3]) / 2) * (Math.PI / 180);
  const area = (cell[2] - cell[0]) * 111_320 * Math.cos(lat) * (cell[3] - cell[1]) * 110_574;
  return pointCount > 0 ? pointCount / area : undefined;
}

/** For lookups the survey can do without: undefined when they fail, unless the model was cancelled. */
function unlessAborted(error: unknown): undefined {
  if ((error as Error)?.name === 'AbortError') throw error;
  return undefined;
}

interface Hit {
  url: string;
  size: number;
  year: number;
  place: string;
  member: ZipMember;
  cell: Box;
}

export const texas: Provider = {
  id: 'texas',
  name: 'TxGIO StratMap',
  areas: [[-106.7, 25.8, -93.5, 36.6]],
  async discover(fetcher, bbox, failures) {
    if (!proxyAvailable()) return [];
    const zips: { url: string; size: number; collection: string; year: number; place: string; quad: Box; code: string }[] = [];
    await Promise.all(
      [...quarterQuads(bbox)].map(async ([code, quad]) => {
        const answer = (await fetcher.json(`${API}resources/?resource__icontains=_${code}_lpc&limit=100`)) as { results?: Resource[] };
        if (!Array.isArray(answer.results)) throw new Error('Catalog returned no resources');
        for (const row of answer.results) {
          const url = row.resource ?? '';
          const parts = nameParts(url.slice(url.lastIndexOf('/') + 1));
          if (!parts || !url.startsWith(FILES) || row.resource_type_abbreviation !== 'LPC' || !url.endsWith(`_${code}_lpc.zip`) || !row.collection_id || !row.filesize) continue;
          if (parts.agency === 'usgs' || parts.year < OLDEST) continue;
          zips.push({ url, size: row.filesize, collection: row.collection_id, year: parts.year, place: parts.place, quad, code });
        }
      }),
    );

    const collections = new Map<string, Hit[]>();
    await Promise.all(
      zips.map(async (zip) => {
        let members: ZipMember[];
        try {
          members = await centralMembers(async (start, end) => new Uint8Array(await fetcher.range(zip.url, start, end)), zip.size);
        } catch (error) {
          // One ZIP that won't read (a 404, the proxy dropping a request)
          // loses its own cells, not every TxGIO collection.
          if ((error as Error)?.name === 'AbortError') throw error;
          const source = `TxGIO StratMap ${zip.year} ${title(zip.place)}`;
          if (!failures.some((f) => f.source === source)) failures.push({ source, reason: briefly(error) });
          return;
        }
        for (const member of members) {
          // Prefixes vary inside one ZIP (El Paso has 35 and 50 cm members), so the code decides.
          const match = /_(\d{7})([a-d])([1-4])\.laz$/i.exec(member.name);
          if (!match || match[1] !== zip.code || (member.method === 8 && member.size > MAX_INFLATED)) continue;
          const cell = memberCell(zip.quad, match[2].toLowerCase(), match[3]);
          if (!overlaps(cell, bbox)) continue;
          const hits = collections.get(zip.collection) ?? [];
          collections.set(zip.collection, hits);
          hits.push({ ...zip, member, cell });
        }
      }),
    );

    const mx = (bbox.west + bbox.east) / 2;
    const my = (bbox.south + bbox.north) / 2;
    const away = (hit: Hit) => ((hit.cell[0] + hit.cell[2]) / 2 - mx) ** 2 + ((hit.cell[1] + hit.cell[3]) / 2 - my) ** 2;
    const surveys = new Surveys();
    const described = await Promise.all(
      [...collections].map(async ([collection, hits]) => {
        hits.sort((a, b) => (`${a.url}#${a.member.name}` < `${b.url}#${b.member.name}` ? -1 : 1));
        // The collection's name and flight date are only in the catalog. Without them the name comes from the file.
        const about = await fetcher
          .json(`${API}collections_catalog/?collection_id=${collection}`, WEEK_MS)
          .then((answer) => (answer as { results?: { name?: string; acquisition_date?: string }[] }).results?.[0])
          .catch(unlessAborted);
        const middle = hits.reduce((best, hit) => (away(hit) < away(best) ? hit : best));
        const density = await memberDensity(fetcher, middle.url, middle.size, middle.member, middle.cell).catch(unlessAborted);
        return { collection, hits, about, density };
      }),
    );
    // Newest first, whatever order the directories came back in.
    described.sort((a, b) => b.hits[0].year - a.hits[0].year || (a.collection < b.collection ? -1 : 1));
    for (const { collection, hits, about, density } of described) {
      const { year, place } = hits[0];
      const date = /^\d{4}-\d{2}-\d{2}$/.test(about?.acquisition_date ?? '') ? about!.acquisition_date : undefined;
      for (const { url, size, member, cell } of hits) {
        const square: Polygon = [[[cell[0], cell[1]], [cell[2], cell[1]], [cell[2], cell[3]], [cell[0], cell[3]]]];
        surveys.add(
          collection,
          () => ({
            provider: 'TxGIO',
            id: collection,
            name: `TxGIO ${about?.name?.trim() || `StratMap ${year} ${title(place)}`}`,
            url: `${FILES}${collection}/resources/#lpc`,
            format: 'LAZ',
            densityM2: density,
            acquisitionStart: date ?? `${year}-01-01`,
            acquisitionEnd: `${year}-12-31`,
            license: 'CC0 1.0',
            attribution: 'TxGIO / Texas Water Development Board, StratMap',
            sourcePage: `https://data.geographic.texas.gov/collection/?c=${collection}`,
            authoritative: true,
            projectYearHint: year,
          }),
          { url, member: member.name, size, bytes: member.compressedSize, bbox: cell },
          [square],
        );
      }
    }
    return surveys.list();
  },
};
