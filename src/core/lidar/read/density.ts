// Returns per m² a survey has near an area, from its index alone: an EPT's
// hierarchy, or the headers of a few tiles. Catalog densities are averages
// over a whole outline and run 2x off where it matters. San Francisco's 2023
// survey averages 62 per m² and has 150 in the Financial District, King
// County's 2016-17 one averages 26 and has 14 in downtown Seattle. Walking
// the hierarchy over 800 m came within 30% of the returns counted in the
// middle of it, for a few KB.

import type { GeoBounds } from '../../types';
import type { Candidate } from '../sources';
import { lonLatTransforms, crsFromEpsg, crsFromWkt, type CrsInfo } from './crs';
import { nodePath, type EptMetadata } from './ept';
import type { Fetcher } from './fetcher';
import { queryBounds } from './normalize';
import { tileDensity } from './tiles';

// Columns of about this many metres. Water and holes in the survey are
// columns well under the others, and are left out of the density.
const COLUMN_M = 32;
// A column counts when it has at least this share of the 90th percentile.
const LAND_SHARE = 0.25;
// Hierarchy pages read at once, and at most. Minneapolis's 2022 survey has a
// page per level and took 170 pages over 800 m.
const PAGES_AT_ONCE = 12;
const MAX_PAGES = 256;
// Tiles whose headers are read, nearest the middle of the box first.
const MAX_TILES = 4;
// Less isn't a survey of the area. Las Vegas's 2010 one has 0.4.
const MIN_DENSITY = 0.05;

/** Returns per m² on land in `box`, or null when the index can't tell. `inside` limits it to where the survey's outline is. */
export async function localDensity(fetcher: Fetcher, survey: Candidate, box: GeoBounds, inside?: (lon: number, lat: number) => boolean): Promise<number | null> {
  if (survey.format === 'EPT') return eptDensity(fetcher, survey.url, box, inside);
  // Scene layers rank on their provider's figure.
  if (survey.format === 'I3S') return null;
  return tilesDensity(fetcher, survey, box);
}

function eptCrs(meta: EptMetadata): CrsInfo | null {
  const srs = meta.srs ?? {};
  if (srs.wkt) return crsFromWkt(srs.wkt);
  if (srs.horizontal) return crsFromEpsg(Number(srs.horizontal));
  return null;
}

export async function eptDensity(fetcher: Fetcher, url: string, box: GeoBounds, inside?: (lon: number, lat: number) => boolean): Promise<number | null> {
  const meta = (await fetcher.json(url)) as EptMetadata;
  if (meta.hierarchyType !== 'json' || meta.bounds?.length !== 6) return null;
  const crs = eptCrs(meta);
  if (!crs || crs.geographic) return null;
  const { fromLonLat, toLonLat } = lonLatTransforms(crs);
  const q = queryBounds(box, fromLonLat);
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  const root = meta.bounds;
  const rootWidth = root[3] - root[0];
  // Ground metres per unit of the cloud. Web Mercator stretches by sec(latitude).
  let metres = crs.horizontalFactor;
  if (crs.epsg === 3857) metres *= Math.cos((((box.south + box.north) / 2) * Math.PI) / 180);
  const width = COLUMN_M / metres;
  const nx = Math.max(1, Math.ceil((q[2] - q[0]) / width));
  const ny = Math.max(1, Math.ceil((q[3] - q[1]) / width));
  const columns = new Float64Array(nx * ny);

  // Nodes are additive, so every node's points are spread over the columns it
  // overlaps, as if even within it. Deep nodes are a column or less across.
  const add = (node: string, count: number) => {
    const [depth, ix, iy] = node.split('-').map(Number);
    const size = rootWidth / 2 ** depth;
    const x0 = root[0] + ix * size;
    const y0 = root[1] + iy * size;
    const c0 = Math.max(0, Math.floor((x0 - q[0]) / width));
    const c1 = Math.min(nx - 1, Math.floor((x0 + size - q[0]) / width));
    const r0 = Math.max(0, Math.floor((y0 - q[1]) / width));
    const r1 = Math.min(ny - 1, Math.floor((y0 + size - q[1]) / width));
    for (let r = r0; r <= r1; r++) {
      const cy = q[1] + r * width;
      const oy = Math.min(y0 + size, cy + width, q[3]) - Math.max(y0, cy);
      if (oy <= 0) continue;
      for (let c = c0; c <= c1; c++) {
        const cx = q[0] + c * width;
        const ox = Math.min(x0 + size, cx + width, q[2]) - Math.max(x0, cx);
        if (ox > 0) columns[r * nx + c] += (count * ox * oy) / (size * size);
      }
    }
  };
  const touches = (node: string) => {
    const [depth, ix, iy] = node.split('-').map(Number);
    const size = rootWidth / 2 ** depth;
    const x0 = root[0] + ix * size;
    const y0 = root[1] + iy * size;
    return x0 < q[2] && x0 + size > q[0] && y0 < q[3] && y0 + size > q[1];
  };

  let pending = ['0-0-0-0'];
  const seen = new Set<string>();
  while (pending.length) {
    if (seen.size + pending.length > MAX_PAGES) return null;
    const batch = pending.splice(0, PAGES_AT_ONCE);
    for (const key of batch) seen.add(key);
    const pages = await Promise.all(batch.map((key) => fetcher.json(`${base}ept-hierarchy/${nodePath(meta, key)}.json`) as Promise<Record<string, number>>));
    const next: string[] = [];
    batch.forEach((key, i) => {
      for (const [node, count] of Object.entries(pages[i])) {
        if (!touches(node)) continue;
        if (count === -1) {
          if (node !== key && !seen.has(node)) next.push(node);
        } else if (count > 0) add(node, count);
      }
    });
    pending = [...pending, ...next];
  }

  // Column areas on the ground, the last row and column cut by the box.
  const densities: number[] = [];
  for (let r = 0; r < ny; r++) {
    const h = Math.min(width, q[3] - (q[1] + r * width));
    for (let c = 0; c < nx; c++) {
      const w = Math.min(width, q[2] - (q[0] + c * width));
      if (w <= 0 || h <= 0) continue;
      if (inside) {
        const [lon, lat] = toLonLat(q[0] + (c + 0.5) * width, q[1] + (r + 0.5) * width);
        if (!inside(lon, lat)) continue;
      }
      densities.push(columns[r * nx + c] / (w * h * metres * metres));
    }
  }
  return landDensity(densities);
}

// Presence is judged in about this many columns along the area's longer
// side, and never finer than PRESENCE_MIN_M.
const PRESENCE_COLUMNS = 40;
const PRESENCE_MIN_M = 32;

/**
 * The share of `box` an EPT has points in, from its hierarchy down to nodes
 * about a column across, or null when the hierarchy can't tell. Catalog
 * outlines can claim far more: NOAA's 2018-19 Irma survey claims all of
 * downtown Miami and has points in 44% of it. A node only says there are
 * points somewhere in it, so a column counts once a node no bigger than two
 * columns has some, and a leaf above that depth counts for everything it
 * covers. `inside` limits it to the columns whose middle is in the area.
 */
export async function eptPresence(fetcher: Fetcher, url: string, box: GeoBounds, inside?: (lon: number, lat: number) => boolean): Promise<number | null> {
  const meta = (await fetcher.json(url)) as EptMetadata;
  if (meta.hierarchyType !== 'json' || meta.bounds?.length !== 6) return null;
  const crs = eptCrs(meta);
  if (!crs || crs.geographic) return null;
  const { fromLonLat, toLonLat } = lonLatTransforms(crs);
  const q = queryBounds(box, fromLonLat);
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  const root = meta.bounds;
  const rootWidth = root[3] - root[0];
  let metres = crs.horizontalFactor;
  if (crs.epsg === 3857) metres *= Math.cos((((box.south + box.north) / 2) * Math.PI) / 180);
  const columnM = Math.max(PRESENCE_MIN_M, (Math.max(q[2] - q[0], q[3] - q[1]) * metres) / PRESENCE_COLUMNS);
  const width = columnM / metres;
  // Rounding in the projection can leave a sliver past the last column.
  const nx = Math.max(1, Math.ceil((q[2] - q[0]) / width - 1e-6));
  const ny = Math.max(1, Math.ceil((q[3] - q[1]) / width - 1e-6));
  // The deepest level whose nodes are still at least a column across.
  const maxDepth = Math.max(0, Math.floor(Math.log2(rootWidth / width) + 1e-6));
  const nodeBox = (node: string) => {
    const [depth, ix, iy] = node.split('-').map(Number);
    const size = rootWidth / 2 ** depth;
    return [root[0] + ix * size, root[1] + iy * size, size] as const;
  };
  const touches = (node: string) => {
    const [x0, y0, size] = nodeBox(node);
    return x0 < q[2] && x0 + size > q[0] && y0 < q[3] && y0 + size > q[1];
  };
  const nodes = new Set<string>();
  // Every node listed, touching or not, to tell leaves.
  const listed = new Set<string>();
  let pending = ['0-0-0-0'];
  const seen = new Set<string>();
  while (pending.length) {
    if (seen.size + pending.length > MAX_PAGES) return null;
    const batch = pending.splice(0, PAGES_AT_ONCE);
    for (const key of batch) seen.add(key);
    const pages = await Promise.all(batch.map((key) => fetcher.json(`${base}ept-hierarchy/${nodePath(meta, key)}.json`) as Promise<Record<string, number>>));
    const next: string[] = [];
    batch.forEach((key, i) => {
      for (const [node, count] of Object.entries(pages[i])) {
        if (Number(node.split('-')[0]) > maxDepth || !count) continue;
        listed.add(node);
        if (!touches(node)) continue;
        if (count === -1) {
          if (node !== key && !seen.has(node)) next.push(node);
        } else if (count > 0) nodes.add(node);
      }
    });
    pending = [...pending, ...next];
  }
  const present = new Uint8Array(nx * ny);
  for (const node of nodes) {
    const [depth, ix, iy, iz] = node.split('-').map(Number);
    if (depth < maxDepth) {
      let split = false;
      for (let k = 0; k < 8 && !split; k++) split = listed.has(`${depth + 1}-${2 * ix + (k & 1)}-${2 * iy + ((k >> 1) & 1)}-${2 * iz + (k >> 2)}`);
      if (split) continue;
    }
    const [x0, y0, size] = nodeBox(node);
    // The columns it overlaps, past rounding at its edges.
    const span = (from: number, to: number, n: number) => [Math.max(0, Math.floor(from / width + 1e-6)), Math.min(n - 1, Math.ceil(to / width - 1e-6) - 1)];
    const [r0, r1] = span(y0 - q[1], y0 + size - q[1], ny);
    const [c0, c1] = span(x0 - q[0], x0 + size - q[0], nx);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) present[r * nx + c] = 1;
  }
  let columns = 0;
  let found = 0;
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      if (inside) {
        const [lon, lat] = toLonLat(q[0] + (c + 0.5) * width, q[1] + (r + 0.5) * width);
        if (!inside(lon, lat)) continue;
      }
      columns++;
      found += present[r * nx + c];
    }
  }
  return columns ? found / columns : null;
}

/** The mean over columns that aren't water or holes, or null for too few. */
export function landDensity(densities: number[]): number | null {
  if (densities.length < 4) return null;
  const sorted = [...densities].sort((a, b) => a - b);
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length))];
  if (!(p90 > 0)) return null;
  const land = sorted.filter((d) => d >= LAND_SHARE * p90);
  const mean = land.reduce((sum, d) => sum + d, 0) / land.length;
  // An outline drawn wider than the points, where it only grazes the area.
  return mean >= MIN_DENSITY ? mean : null;
}

/** The median of a few tiles' points over the box their header gives, nearest the middle first. */
async function tilesDensity(fetcher: Fetcher, survey: Candidate, box: GeoBounds): Promise<number | null> {
  const mx = (box.west + box.east) / 2;
  const my = (box.south + box.north) / 2;
  const tiles = (survey.tiles ?? [])
    .filter((t) => t.bbox[0] <= box.east && t.bbox[2] >= box.west && t.bbox[1] <= box.north && t.bbox[3] >= box.south)
    .map((t) => ({ t, d: ((t.bbox[0] + t.bbox[2]) / 2 - mx) ** 2 + ((t.bbox[1] + t.bbox[3]) / 2 - my) ** 2 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_TILES);
  const found: number[] = [];
  for (const { t } of tiles) {
    const density = await tileDensity(fetcher, t);
    if (density) found.push(density);
  }
  if (!found.length) return null;
  found.sort((a, b) => a - b);
  return found.length % 2 ? found[found.length >> 1] : (found[found.length / 2 - 1] + found[found.length / 2]) / 2;
}
