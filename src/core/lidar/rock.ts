// Upper surfaces for explicitly mapped bare rock, from one survey at a time.
// Ported from the add-on's lidar_rock.py. Rock is terrain, so ground returns
// are valid evidence for it; vegetation never supplies its coverage. The
// domains come from mapped rock polygons only, never point landmarks.

import { union } from '../geometry/polygon';
import type { MultiPolygon } from '../types';
import { groundAnchor } from './ground';
import { occupiedArea, type Outcome } from './measure';
import { quantile } from './numeric';
import type { PointIndex } from './points';
import { area, bounds, buffer, Inside, pieces } from './shapes';
import { DEFAULT_SURFACE_SCALE, surfaceAround, type BatchSurface } from './surface';

export interface RockDomain {
  id: string;
  /** Land feature ids merged into this domain. */
  members: string[];
  geometry: MultiPolygon;
}

/** A short stable hash for ids built from several source ids. */
export function shortHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * Mapped bare-rock polygons merged where they overlap, without growing the
 * outlines. `polygons` are the rock land features already projected.
 */
export function rockDomains(polygons: { id: string; geometry: MultiPolygon }[]): RockDomain[] {
  const n = polygons.length;
  const boxes = polygons.map((p) => bounds(p.geometry));
  const seen = new Uint8Array(n);
  const out: RockDomain[] = [];
  const touches = (a: number, b: number) => {
    const [p, q] = [boxes[a], boxes[b]];
    if (p[0] > q[2] || q[0] > p[2] || p[1] > q[3] || q[1] > p[3]) return false;
    return area(union(polygons[a].geometry)) + area(union(polygons[b].geometry)) > area(union(polygons[a].geometry, polygons[b].geometry)) + 1e-9;
  };
  for (let start = 0; start < n; start++) {
    if (seen[start]) continue;
    const group: number[] = [];
    const todo = [start];
    seen[start] = 1;
    while (todo.length) {
      const i = todo.pop()!;
      group.push(i);
      for (let j = 0; j < n; j++) {
        if (seen[j] || !touches(i, j)) continue;
        seen[j] = 1;
        todo.push(j);
      }
    }
    const members = group.map((i) => polygons[i].id).sort();
    out.push({ id: `rock:${shortHash(members.join('\n'))}`, members, geometry: union(...group.map((i) => polygons[i].geometry)) });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Validate coverage and use surrounding ground to align a measured relief.
 * A hillside cannot be one ground plane, so a low, balanced ground cell is
 * the alignment anchor, and every surface height keeps its measured
 * difference from it. The surface itself is the batch's, as for buildings.
 */
export function measureRockSurface(footprint: MultiPolygon, index: PointIndex, scale: [number, number] = DEFAULT_SURFACE_SCALE, surface?: BatchSurface | null): Outcome {
  const footprintArea = area(footprint);
  if (!footprint.length || footprintArea < 4) return { record: null, reason: 'invalid_or_small_footprint' };
  const [x0, y0, x1, y1] = bounds(buffer(footprint, 25));
  const nearby = index.queryIndices(x0, y0, x1, y1);
  const anchor = groundAnchor(footprint, index);
  if (!anchor) return { record: null, reason: 'insufficient_ground' };
  const p = index.points;
  const inside = new Inside(footprint);
  const usable: number[] = [];
  for (const i of nearby) {
    const cls = p.cls[i];
    if ((cls === 2 || cls === 6 || (cls === 1 && p.single[i] === 1)) && inside.has(p.x[i], p.y[i])) usable.push(i);
  }
  if (usable.length < 20) return { record: null, reason: 'insufficient_roof_points' };
  const pitch = 1.5;
  const coverage: number[] = [];
  const bands: number[][] = [];
  for (const domain of pieces(footprint)) {
    const test = new Inside(domain);
    const groups = new Map<string, number[]>();
    for (const i of usable) {
      if (!test.has(p.x[i], p.y[i])) continue;
      const key = `${Math.floor(p.x[i] / pitch)},${Math.floor(p.y[i] / pitch)}`;
      const list = groups.get(key);
      if (list) list.push(i);
      else groups.set(key, [i]);
    }
    const supported = [...groups]
      .filter(([, rows]) => rows.length >= 3)
      .map(([key, rows]) => ({ cell: key.split(',').map(Number) as [number, number], rows }))
      .sort((a, b) => a.cell[0] - b.cell[0] || a.cell[1] - b.cell[1]);
    coverage.push(occupiedArea(supported.map((s) => s.cell), domain, pitch) / area(domain));
    bands.push(...supported.map((s) => s.rows));
  }
  if (!coverage.length || Math.min(...coverage) < 0.85 || bands.length < 4) return { record: null, reason: 'footprint_roof_mismatch' };
  const rows = bands.flat();
  let lowest = Infinity;
  for (const i of rows) lowest = Math.min(lowest, p.z[i]);
  // A small offset below the surface gives the solid a positive base without changing any height.
  const datum = Math.min(anchor[2], lowest - 0.05);
  const heights = Float64Array.from(rows, (i) => p.z[i] - datum);
  if (quantile(heights, 0.99) - quantile(heights, 0.01) < 0.05 / scale[1]) return { record: null, reason: 'no_printable_rock_relief' };
  const source = surface !== undefined ? surface : surfaceAround(footprint, p, scale);
  const { fit, reason } = source ? source.fit(footprint, datum, [], 'rock') : { fit: null, reason: null };
  if (!fit) return { record: null, reason: reason ?? 'insufficient upper surface samples' };
  const least = Math.min(...coverage);
  return {
    record: {
      method: 'faceted_roof',
      surfaceReconstruction: 'surface',
      surfaceKind: 'rock',
      heightM: fit.heightM,
      tiers: [],
      cap: fit.cap,
      surfaceDiagnostics: fit.diagnostics,
      groundM: datum,
      groundReference: 'surrounding_ground_anchor',
      groundAnchor: [anchor[0], anchor[1], anchor[2] - datum],
      coverage: least,
      explainedFraction: least,
      roofSupportDensityM2: rows.length / footprintArea,
      roofPoints: rows.length,
      cellM: pitch,
    },
    reason: 'faceted_roof',
  };
}
