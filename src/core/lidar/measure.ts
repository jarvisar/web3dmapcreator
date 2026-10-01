// Footprint-constrained roof evidence and reconstruction, ported from the
// add-on's lidar_measurements.py. The output is roof geometry and heights
// above the survey's own ground, never raw points.
//
// Everything here works in a local metric frame. Points are the normalized
// columns of points.ts; footprints are metre polygons.

import { difference, intersection, union } from '../geometry/polygon';
import type { MultiPolygon } from '../types';
import { measuredTierBoundary } from './boundaries';
import { regularizeGridContours } from './contours';
import { groundAnchor, groundReference } from './ground';
import { sourceHeights, supportedHeight, type CellHeights, type CellSample } from './height';
import { mean, median, quantile, searchLeft, searchRight, sortedQuantile } from './numeric';
import { fitRoofPlanes } from './planes';
import { concatXyz, PointIndex, xyz, type Points, type Xyz } from './points';
import type { LidarRecord, Tier } from './records';
import {
  area,
  boxArea,
  boxShape,
  bounds,
  buffer,
  cellAreas,
  centroid,
  Inside,
  isEmpty,
  longAxis,
  pieces,
  rotate,
  simplifyShape,
  type Box,
} from './shapes';
import type { Props, SourcePart } from './source';
import { BatchSurface, DEFAULT_SURFACE_SCALE, massRise, surfaceAround } from './surface';

export type RoofMode = 'FACETED' | 'TERRACES' | 'HEIGHT_ONLY';

// The rejections a roof filed under a vegetation class can cause.
const VEGETATION_ROOF_REASONS = new Set(['footprint_roof_mismatch', 'observed_ground_in_footprint', 'sparse_or_noisy_roof']);

export interface Outcome {
  record: LidarRecord | null;
  reason: string;
}

const cellKey = (x: number, y: number) => `${x},${y}`;
const parseKey = (key: string) => key.split(',').map(Number) as [number, number];

/** Area of the given 3 m cells inside a region, not the whole squares crossing its edge. */
export function occupiedArea(keys: Iterable<[number, number]>, region: MultiPolygon, cell: number): number {
  let total = 0;
  for (const [x, y] of keys) total += boxArea(region, x * cell, y * cell, (x + 1) * cell, (y + 1) * cell);
  return total;
}

/**
 * Positive ground observations, not missing returns, show absence: 3 m cells
 * with ground returns and no roof return over a fifth of the interior.
 * `covered` holds cells a roof already occupies although no building-class
 * return stands in them (the vegetation pass).
 */
export function observedEmptyArea(footprint: MultiPolygon, points: Points, ground: number, covered: Set<string> = new Set()): boolean {
  const interior = buffer(footprint, -1.5);
  if (isEmpty(interior)) return false;
  const test = new Inside(interior);
  const groundCells = new Map<string, number>();
  const roofCells = new Set<string>();
  for (let i = 0; i < points.count; i++) {
    if (!test.has(points.x[i], points.y[i])) continue;
    const key = cellKey(Math.floor(points.x[i] / 3), Math.floor(points.y[i] / 3));
    const cls = points.cls[i];
    const h = points.z[i] - ground;
    if (cls === 2 && Math.abs(h) < 2) groundCells.set(key, (groundCells.get(key) ?? 0) + 1);
    else if ((cls === 1 || cls === 6) && h > 2) roofCells.add(key);
  }
  const empty: [number, number][] = [];
  for (const [key, count] of groundCells) if (count >= 3 && !roofCells.has(key) && !covered.has(key)) empty.push(parseKey(key));
  const interiorArea = area(interior);
  return empty.length >= 4 && empty.length * 9 >= interiorArea * 0.2 && occupiedArea(empty, interior, 3) >= interiorArea * 0.2;
}

/**
 * How high the trees around a building reach above its ground: the 95th
 * percentile of 3 m cell tops of vegetation returns 3-30 m outside the
 * footprint and every mapped neighbour. 0 without trees.
 */
export function localCanopy(footprint: MultiPolygon, index: PointIndex, ground: number, neighbours: MultiPolygon[] = []): number {
  let ring = difference(buffer(footprint, 30), buffer(footprint, 3));
  if (neighbours.length) ring = difference(ring, buffer(union(...neighbours), 3));
  if (isEmpty(ring)) return 0;
  const [x0, y0, x1, y1] = bounds(ring);
  const test = new Inside(ring);
  const p = index.points;
  const tops = new Map<string, number>();
  let count = 0;
  for (const i of index.queryIndices(x0, y0, x1, y1)) {
    if (p.cls[i] < 3 || p.cls[i] > 5 || !test.has(p.x[i], p.y[i])) continue;
    count++;
    const key = cellKey(Math.floor(p.x[i] / 3), Math.floor(p.y[i] / 3));
    const top = tops.get(key);
    if (top === undefined || p.z[i] > top) tops.set(key, p.z[i]);
  }
  if (count < 20) return 0;
  return quantile([...tops.values()].map((z) => z - ground), 0.95);
}

interface Grid {
  x0: number;
  y0: number;
  cell: number;
  rotated: MultiPolygon;
  parts: MultiPolygon[];
}

interface Coverage {
  cells: Map<string, number>;
  facetSamples: Map<string, number[]>;
  boundary: Xyz[];
  supportedByPiece: number[];
  supportedAreaByPiece: number[];
}

/**
 * Admit roof cells a survey filed under a vegetation class where they
 * continue the roof: a vegetation cell's upper band within a cell's height
 * of a roof cell beside it, grown from cells the building classes support,
 * and only above `floor` (the local canopy plus the admission band), so trees
 * beside a low building never join its roof.
 */
function continueWithVegetation(secondary: Xyz, u: Float64Array, v: Float64Array, grid: Grid, state: Coverage, floor: number): void {
  const { x0, y0, cell, rotated, parts } = grid;
  const groups = new Map<string, number[]>();
  for (let k = 0; k < secondary.count; k++) {
    const key = cellKey(Math.floor((u[k] - x0) / cell), Math.floor((v[k] - y0) / cell));
    const list = groups.get(key);
    if (list) list.push(k);
    else groups.set(key, [k]);
  }
  const bands = new Map<string, { height: number; rows: number[]; low: number; high: number }>();
  for (const [key, rows] of groups) {
    if (state.cells.has(key) || rows.length < 3) continue;
    const z = Float64Array.from(rows, (k) => secondary.z[k]).sort();
    const reach = Math.max(0.8, cell * 0.4);
    const ends = Array.from(z, (value) => searchRight(z, value + reach));
    const support = ends.map((e, i) => e - i);
    const need = Math.max(3, Math.ceil(Math.max(...support) * 0.25));
    let start = -1;
    for (let i = 0; i < support.length; i++) if (support[i] >= need) start = i;
    if (start < 0) continue;
    const height = median(z.subarray(start, ends[start]));
    if (height > floor) bands.set(key, { height, rows, low: z[start], high: z[ends[start] - 1] });
  }
  const frontier = [...state.cells.keys()];
  while (frontier.length) {
    const [x, y] = parseKey(frontier.pop()!);
    const here = state.cells.get(cellKey(x, y))!;
    for (const [ox, oy] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]) {
      const other = cellKey(ox, oy);
      const band = bands.get(other);
      if (!band || Math.abs(band.height - here) > cell) continue;
      bands.delete(other);
      const bx0 = x0 + ox * cell;
      const by0 = y0 + oy * cell;
      const tileArea = boxArea(rotated, bx0, by0, bx0 + cell, by0 + cell);
      if (tileArea < cell * cell * 0.25) continue;
      let component = 0;
      if (parts.length > 1) {
        let best = -1;
        parts.forEach((part, i) => {
          const a = boxArea(part, bx0, by0, bx0 + cell, by0 + cell);
          if (a > best) {
            best = a;
            component = i;
          }
        });
      }
      state.cells.set(other, band.height);
      const inBand = band.rows.filter((k) => secondary.z[k] >= band.low && secondary.z[k] <= band.high);
      inBand.sort((a, b) => secondary.x[a] - secondary.x[b] || secondary.y[a] - secondary.y[b] || secondary.z[a] - secondary.z[b]);
      state.facetSamples.set(other, [mean(inBand.map((k) => secondary.x[k])), mean(inBand.map((k) => secondary.y[k])), mean(inBand.map((k) => secondary.z[k]))]);
      const all = xyz(band.rows.length);
      band.rows.forEach((k, m) => {
        all.x[m] = secondary.x[k];
        all.y[m] = secondary.y[k];
        all.z[m] = secondary.z[k];
      });
      state.boundary.push(all);
      state.supportedByPiece[component]++;
      state.supportedAreaByPiece[component] += parts.length === 1 ? tileArea : boxArea(parts[component], bx0, by0, bx0 + cell, by0 + cell);
      frontier.push(other);
    }
  }
}

export interface MeasureOptions {
  groundM?: number | null;
  roofPlanes?: boolean;
  partFootprints?: MultiPolygon[];
  neighbours?: MultiPolygon[];
  allowComplexHeight?: boolean;
  roofMode?: RoofMode;
  /** Printed mm per ground metre, horizontal and vertical. */
  surfaceScale?: [number, number];
  /** Height-only mode: the feature and its parts, to correct each mass on its own. */
  heightTargets?: { feature: { id: string; props: Props }; parts: SourcePart[] };
  preferLidar?: boolean;
  /** The batch's surface that measured roofs are cut from. Without one, the building's own returns make one. */
  surface?: BatchSurface | null;
}

interface OnceOptions extends MeasureOptions {
  groundM: number;
  detailedSurfaces: boolean;
  heightOnly: boolean;
  gridOffset: [number, number];
  vegetation: boolean;
  coverageOut?: { minimumComponent?: number };
}

/**
 * Retry coverage failures at fixed half-cell grid offsets, without adding
 * returns: every fit still needs three returns per cell and 85% coverage of
 * every component. Only near misses (80% in every component) are retried,
 * and the first complete fit is kept. A roof envelope the building classes
 * cannot establish gets one last pass where vegetation-class returns may
 * continue their roof.
 */
export function measureBuilding(footprint: MultiPolygon, index: PointIndex, minWidthM: number, minStepM: number, options: MeasureOptions = {}): Outcome {
  footprint = union(footprint);
  if (!footprint.length || area(footprint) < 4) return { record: null, reason: 'invalid_or_small_footprint' };
  let groundM = options.groundM ?? null;
  let anchor: [number, number, number] | null = null;
  if (groundM === null) {
    groundM = groundReference(footprint, index);
    if (groundM === null) {
      anchor = groundAnchor(footprint, index);
      if (anchor) groundM = anchor[2];
    }
  }
  if (groundM === null) return { record: null, reason: 'insufficient_ground' };
  const roofPlanes = options.roofPlanes ?? true;
  const roofMode = options.roofMode ?? 'TERRACES';
  if (roofPlanes && roofMode === 'FACETED') {
    const [sx, sz] = options.surfaceScale ?? DEFAULT_SURFACE_SCALE;
    minWidthM = 0.1 / sx;
    minStepM = Math.max(0.25, 0.05 / sz);
  }
  const base: OnceOptions = {
    ...options,
    groundM,
    roofPlanes,
    detailedSurfaces: roofPlanes && roofMode === 'FACETED',
    heightOnly: roofMode === 'HEIGHT_ONLY',
    gridOffset: [0, 0],
    vegetation: false,
  };
  const aligned = (outcome: Outcome): Outcome => {
    if (outcome.record && anchor) {
      outcome.record.groundAnchor = [anchor[0], anchor[1], 0];
      outcome.record.groundReference = 'surrounding_ground_anchor';
    }
    return outcome;
  };
  const coverage: { minimumComponent?: number } = {};
  const first = measureOnce(footprint, index, minWidthM, minStepM, { ...base, coverageOut: coverage });
  if (first.reason === 'footprint_roof_mismatch' && (coverage.minimumComponent ?? 0) >= 0.8) {
    for (const offset of [
      [0.5, 0],
      [0, 0.5],
      [0.5, 0.5],
    ] as [number, number][]) {
      const recovered = measureOnce(footprint, index, minWidthM, minStepM, { ...base, gridOffset: offset, coverageOut: {} });
      if (recovered.record) {
        recovered.record.coverageGridOffset = offset;
        return aligned(recovered);
      }
    }
  }
  // Only once every building-class attempt failed may a roof filed as
  // vegetation continue theirs, so a roof they support keeps its exact fit.
  if (!first.record && VEGETATION_ROOF_REASONS.has(first.reason) && base.detailedSurfaces) {
    const rescued = measureOnce(footprint, index, minWidthM, minStepM, { ...base, vegetation: true });
    if (rescued.record) return aligned(rescued);
  }
  return aligned(first);
}

/** The whole roof envelope, or the terrace fallback; hidden undersides stay source-derived. */
function measureOnce(footprint: MultiPolygon, index: PointIndex, minWidthM: number, minStepM: number, options: OnceOptions): Outcome {
  const { groundM: ground, detailedSurfaces, heightOnly, gridOffset, vegetation, coverageOut } = options;
  const footprintArea = area(footprint);
  if (!footprint.length || footprintArea < 4) return { record: null, reason: 'invalid_or_small_footprint' };
  const box = bounds(footprint);
  const nearby = index.queryIndices(box[0], box[1], box[2], box[3]);
  if (nearby.length < 20) return { record: null, reason: 'insufficient_roof_points' };
  const all = index.points;
  const everything = subset(all, nearby);
  const empty = observedEmptyArea(footprint, everything, ground);
  if (empty && !vegetation) return { record: null, reason: 'observed_ground_in_footprint' };
  const test = new Inside(footprint);
  // Class 6 and single-return unclassified points count only when the coverage
  // and flatness tests below corroborate a broad surface. Vegetation classes
  // hold much of a glazed facade in some surveys; they never establish
  // coverage, ground or height, and only join where the envelope reaches.
  const roofRows: number[] = [];
  const secondaryRows: number[] = [];
  for (const i of nearby) {
    if (!test.has(all.x[i], all.y[i])) continue;
    const cls = all.cls[i];
    const h = all.z[i] - ground;
    if ((cls === 6 || (cls === 1 && all.single[i] === 1)) && h > 2) roofRows.push(i);
    else if (!heightOnly && cls >= 3 && cls <= 5 && h > 2) secondaryRows.push(i);
  }
  const secondary = xyz(secondaryRows.length);
  secondaryRows.forEach((i, k) => {
    secondary.x[k] = all.x[i];
    secondary.y[k] = all.y[i];
    secondary.z[k] = all.z[i] - ground;
  });
  if (roofRows.length < 20) return { record: null, reason: empty ? 'observed_ground_in_footprint' : 'insufficient_roof_points' };

  const angle = longAxis(footprint);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const origin = centroid(footprint);
  const rotated = rotate(footprint, -angle, origin);
  const toU = (x: number, y: number) => (x - origin[0]) * cosine + (y - origin[1]) * sine + origin[0];
  const toV = (x: number, y: number) => -(x - origin[0]) * sine + (y - origin[1]) * cosine + origin[1];
  // Scalar heights need broad support, not a detailed outline: a 3 m grid.
  const cell = heightOnly ? 3 : detailedSurfaces ? 1.5 : Math.max(1.5, minWidthM / 3);
  let [x0, y0, x1, y1] = bounds(rotated);
  x0 -= cell * gridOffset[0];
  y0 -= cell * gridOffset[1];
  const nx = Math.ceil((x1 - x0) / cell);
  const ny = Math.ceil((y1 - y0) / cell);
  if (nx * ny > 40000) return { record: null, reason: empty ? 'observed_ground_in_footprint' : 'footprint_cell_budget' };
  const cellCentre = (ix: number, iy: number): [number, number] => {
    const u = x0 + (ix + 0.5) * cell - origin[0];
    const v = y0 + (iy + 0.5) * cell - origin[1];
    return [origin[0] + u * cosine - v * sine, origin[1] + u * sine + v * cosine];
  };

  const groups = new Map<number, number[]>();
  for (const i of roofRows) {
    const ix = Math.floor((toU(all.x[i], all.y[i]) - x0) / cell);
    const iy = Math.floor((toV(all.x[i], all.y[i]) - y0) / cell);
    const key = ix * 1048576 + iy;
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  }
  const parts = pieces(rotated);
  const tiles = cellAreas(rotated, x0, y0, cell, nx, ny);
  const partTiles = parts.length > 1 ? parts.map((part) => cellAreas(part, x0, y0, cell, nx, ny)) : null;
  const state: Coverage = {
    cells: new Map(),
    facetSamples: new Map(),
    boundary: [],
    supportedByPiece: parts.map(() => 0),
    supportedAreaByPiece: parts.map(() => 0),
  };
  const samples = new Map<string, number[]>();
  const expectedByPiece = parts.map(() => 0);
  let expected = 0;
  let supportedPoints = 0;
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      const c = ix * ny + iy;
      const tileArea = tiles[c];
      if (tileArea < cell * cell * 0.25) continue;
      expected++;
      let component = 0;
      if (partTiles) {
        let best = -1;
        partTiles.forEach((t, i) => {
          if (t[c] > best) {
            best = t[c];
            component = i;
          }
        });
      }
      expectedByPiece[component]++;
      const rows = groups.get(ix * 1048576 + iy);
      if (!rows || rows.length < 3) continue;
      // Several returns at one spot can be a facade, a low podium and the
      // roof. Take the highest dense narrow band, then demand broad
      // coherent support across cells.
      const order = rows.map((_, k) => k).sort((a, b) => all.z[rows[a]] - all.z[rows[b]] || a - b);
      const z = Float64Array.from(order, (k) => all.z[rows[k]] - ground);
      const reach = Math.max(0.8, cell * 0.4);
      const ends = Array.from(z, (value) => searchRight(z, value + reach));
      let most = 0;
      for (let i = 0; i < ends.length; i++) most = Math.max(most, ends[i] - i);
      // A tall facade feeds thousands of returns into one column; detailed
      // envelopes compare local band support only.
      const columnFloor = detailedSurfaces ? 0 : Math.ceil(z.length * 0.06);
      const need = Math.max(3, Math.ceil(most * 0.25), columnFloor);
      let start = -1;
      for (let i = 0; i < ends.length; i++) if (ends[i] - i >= need) start = i;
      if (start < 0) continue;
      const key = cellKey(ix, iy);
      state.cells.set(key, median(z.subarray(start, ends[start])));
      if (detailedSurfaces) {
        // The band proves coverage only; the envelope sees every usable return of the cell.
        const selected = xyz(rows.length);
        rows.forEach((i, m) => {
          selected.x[m] = all.x[i];
          selected.y[m] = all.y[i];
          selected.z[m] = all.z[i] - ground;
        });
        state.boundary.push(selected);
      }
      state.supportedByPiece[component]++;
      state.supportedAreaByPiece[component] += parts.length === 1 ? tileArea : partTiles![component][c];
      supportedPoints += ends[start] - start;
      if (heightOnly) continue;
      // The xyz centroid stays on a plane; separate medians do not.
      const band = order.slice(start, ends[start]).map((k) => rows[k]);
      samples.set(key, [mean(band.map((i) => all.x[i])), mean(band.map((i) => all.y[i])), mean(band.map((i) => all.z[i])) - ground]);
      const lo = z[start];
      const hi = z[ends[start] - 1];
      const facet = rows.filter((i) => all.z[i] - ground >= lo && all.z[i] - ground <= hi);
      facet.sort((a, b) => all.x[a] - all.x[b] || all.y[a] - all.y[b] || all.z[a] - all.z[b]);
      state.facetSamples.set(key, [mean(facet.map((i) => all.x[i])), mean(facet.map((i) => all.y[i])), mean(facet.map((i) => all.z[i])) - ground]);
    }
  }
  if (vegetation && secondary.count) {
    const u = new Float64Array(secondary.count);
    const v = new Float64Array(secondary.count);
    for (let k = 0; k < secondary.count; k++) {
      u[k] = toU(secondary.x[k], secondary.y[k]);
      v[k] = toV(secondary.x[k], secondary.y[k]);
    }
    const floor = localCanopy(footprint, index, ground, options.neighbours ?? []) + massRise((options.surfaceScale ?? DEFAULT_SURFACE_SCALE)[0]);
    continueWithVegetation(secondary, u, v, { x0, y0, cell, rotated, parts }, state, floor);
  }
  const cells = state.cells;
  if (empty) {
    // Only reached on the vegetation pass: the ground test waits for the rescued roof.
    const covered = new Set<string>();
    for (const key of cells.keys()) {
      const [ix, iy] = parseKey(key);
      const [cx, cy] = cellCentre(ix, iy);
      covered.add(cellKey(Math.floor(cx / 3), Math.floor(cy / 3)));
    }
    if (observedEmptyArea(footprint, everything, ground, covered)) return { record: null, reason: 'observed_ground_in_footprint' };
  }
  let coverage = cells.size / Math.max(expected, 1);
  let areaCoverage = false;
  if (coverage < 0.65 || cells.size < 4) return { record: null, reason: 'sparse_or_noisy_roof' };
  if (coverage < 0.85 || expectedByPiece.some((count, i) => state.supportedByPiece[i] < count * 0.85)) {
    // A clipped boundary cell is not a whole missing square: retry the same
    // 85% on the supported footprint area of every component.
    coverage = state.supportedAreaByPiece.reduce((s, a) => s + a, 0) / footprintArea;
    if (coverageOut) coverageOut.minimumComponent = Math.min(coverage, ...parts.map((part, i) => state.supportedAreaByPiece[i] / area(part)));
    if (coverage < 0.85 || parts.some((part, i) => state.supportedAreaByPiece[i] < area(part) * 0.85)) return { record: null, reason: 'footprint_roof_mismatch' };
    areaCoverage = true;
  }
  // A broad classified roof beyond the outline can mean an enlarged or replaced building.
  let ring = difference(buffer(footprint, 6), buffer(footprint, 2));
  const neighbours = options.neighbours ?? [];
  if (neighbours.length) ring = difference(ring, buffer(union(...neighbours), 1));
  if (!isEmpty(ring)) {
    const [rx0, ry0, rx1, ry1] = bounds(ring);
    const outside = index.queryIndices(rx0, ry0, rx1, ry1);
    if (outside.length) {
      const inRing = new Inside(ring);
      const heights = Float64Array.from(cells.values()).sort();
      const occupied = new Map<string, number>();
      for (const i of outside) {
        if (all.cls[i] !== 6 || !inRing.has(all.x[i], all.y[i])) continue;
        const z = all.z[i] - ground;
        const pos = searchLeft(heights, z);
        const near = Math.min(Math.abs(z - heights[Math.min(pos, heights.length - 1)]), Math.abs(z - heights[Math.max(0, pos - 1)]));
        if (near <= 2) {
          const key = cellKey(Math.floor(all.x[i] / 3), Math.floor(all.y[i] / 3));
          occupied.set(key, (occupied.get(key) ?? 0) + 1);
        }
      }
      const full = [...occupied.values()].filter((n) => n >= 3).length * 9;
      const ringArea = area(ring);
      if (full >= Math.max(36, footprintArea * 0.08) && full >= ringArea * 0.25) {
        // Neighbour masks clip most of a square; count what lies in the ring.
        const clipped = occupiedArea(
          [...occupied].filter(([, n]) => n >= 3).map(([key]) => parseKey(key)),
          ring,
          3,
        );
        if (clipped >= Math.max(36, footprintArea * 0.08) && clipped >= ringArea * 0.25) return { record: null, reason: 'roof_extends_outside_footprint' };
      }
    }
  }
  let classifiedCount = 0;
  for (const i of roofRows) if (all.cls[i] === 6) classifiedCount++;
  const classified = classifiedCount / roofRows.length;
  const stats = {
    groundM: ground,
    roofPoints: roofRows.length,
    coverage: Math.round(coverage * 1e4) / 1e4,
    cellM: cell,
    classifiedFraction: classified,
    roofSupportDensityM2: supportedPoints / footprintArea,
  };

  if (heightOnly) {
    const scalar = supportedHeight(cells as CellHeights, cell, classified);
    if (!scalar) return { record: null, reason: 'unsupported_scalar_roof' };
    const record: LidarRecord = { ...stats, heightM: scalar[0], tiers: [], method: 'height_only', explainedFraction: scalar[1] };
    if (areaCoverage) record.coverageBasis = 'footprint_area';
    if (options.heightTargets) {
      const located: CellSample[] = [...cells].map(([key, z]) => {
        const [ix, iy] = parseKey(key);
        const [x, y] = cellCentre(ix, iy);
        return { key, x, y, z };
      });
      const { feature, parts: sourceParts } = options.heightTargets;
      const corrections = sourceHeights(feature, sourceParts, footprint, located, cell, classified, record, options.preferLidar ?? false);
      if (!Object.keys(corrections).length) return { record: null, reason: 'no_supported_main_mass' };
      record.sourceHeights = corrections;
      record.heightM = Math.max(...Object.values(corrections));
    }
    return { record, reason: 'height_only' };
  }

  // Detailed reconstruction starts from supported samples; the acquisition,
  // ground, coverage and contradiction guards above are shared.
  let surfaceFallback: string | null = null;
  if (detailedSurfaces) {
    const surface = options.surface !== undefined ? options.surface : surfaceAround(footprint, index.points, options.surfaceScale ?? DEFAULT_SURFACE_SCALE);
    const { fit, reason } = surface ? surface.fit(footprint, ground, neighbours) : { fit: null, reason: 'insufficient upper surface samples' };
    if (fit) {
      const record: LidarRecord = {
        ...stats,
        explainedFraction: Math.min(1, state.facetSamples.size / Math.max(expected, 1)),
        heightM: fit.heightM,
        tiers: [],
        cap: fit.cap,
        method: 'faceted_roof',
        surfaceReconstruction: 'surface',
        surfaceDiagnostics: fit.diagnostics,
      };
      if (areaCoverage) record.coverageBasis = 'footprint_area';
      return { record, reason: 'faceted_roof' };
    }
    // Failure is explicit: the terrace path below is a conservative fallback.
    surfaceFallback = reason;
    if (vegetation) return { record: null, reason: surfaceFallback ?? 'insufficient upper surface samples' };
  }
  return terraces(footprint, cells, samples, state, { ...options, minWidthM, minStepM, cell, x0, y0, angle, origin, expected, classified, coverage, areaCoverage, stats, surfaceFallback });
}

function subset(points: Points, indices: Int32Array): Points {
  const out: Points = {
    count: indices.length,
    x: new Float64Array(indices.length),
    y: new Float64Array(indices.length),
    z: new Float64Array(indices.length),
    cls: new Uint8Array(indices.length),
    single: new Uint8Array(indices.length),
    year: new Uint16Array(indices.length),
    confidence: new Float32Array(indices.length),
  };
  indices.forEach((i, k) => {
    out.x[k] = points.x[i];
    out.y[k] = points.y[i];
    out.z[k] = points.z[i];
    out.cls[k] = points.cls[i];
    out.single[k] = points.single[i];
  });
  return out;
}

interface TerraceContext extends OnceOptions {
  minWidthM: number;
  minStepM: number;
  cell: number;
  x0: number;
  y0: number;
  angle: number;
  origin: [number, number];
  expected: number;
  classified: number;
  coverage: number;
  areaCoverage: boolean;
  stats: Omit<LidarRecord, 'method' | 'heightM' | 'tiers'>;
  surfaceFallback: string | null;
}

/** True when two shapes cover the same ground (Shapely's equals). */
function sameShape(a: MultiPolygon, b: MultiPolygon): boolean {
  const scale = Math.max(area(a), area(b), 1e-12);
  return area(difference(a, b)) + area(difference(b, a)) <= scale * 1e-9;
}

/**
 * The legacy reconstruction: flood-fill continuous roof surfaces, test each
 * one's flatness, and stack flat regions as tiers. Roof planes, a robust
 * height for mapped parts, and a 90th percentile for classified roofs are the
 * simpler answers it tries first.
 */
function terraces(footprint: MultiPolygon, cells: Map<string, number>, samples: Map<string, number[]>, state: Coverage, ctx: TerraceContext): Outcome {
  const { minWidthM, minStepM, cell, x0, y0, angle, origin, expected, classified, coverage, detailedSurfaces } = ctx;
  const pending = new Set(cells.keys());
  const regions: [number, string[]][] = [];
  const continuous: string[][] = [];
  const keyOrder = (a: string, b: string) => {
    const [ax, ay] = parseKey(a);
    const [bx, by] = parseKey(b);
    return ax - bx || ay - by;
  };
  // Seeds in (ix, iy) order, as Python's min(pending).
  const seeds = [...cells.keys()].sort(keyOrder);
  let next = 0;
  while (pending.size) {
    while (!pending.has(seeds[next])) next++;
    const seed = seeds[next];
    pending.delete(seed);
    let group = [seed];
    const stack = [seed];
    while (stack.length) {
      const [x, y] = parseKey(stack.pop()!);
      const here = cells.get(cellKey(x, y))!;
      for (const other of [cellKey(x - 1, y), cellKey(x + 1, y), cellKey(x, y - 1), cellKey(x, y + 1)]) {
        if (pending.has(other) && Math.abs(cells.get(other)! - here) < minStepM) {
          pending.delete(other);
          group.push(other);
          stack.push(other);
        }
      }
    }
    let elevations = group.map((k) => cells.get(k)!);
    continuous.push(group);
    if (group.length * cell * cell < Math.max(minWidthM ** 2, cell * cell * 4)) continue;
    if (quantile(elevations, 0.9) - quantile(elevations, 0.1) > Math.max(1, minStepM * 0.4)) {
      // Plant and parapet returns can join a broad flat roof. Keep a dominant
      // level if it explains most of the surface; a slope has no majority.
      const order = elevations.map((_, i) => i).sort((a, b) => elevations[a] - elevations[b]);
      const sorted = order.map((i) => elevations[i]);
      const reach = Math.max(1, minStepM * 0.75);
      let best = 0;
      let bestCount = -1;
      for (let i = 0; i < sorted.length; i++) {
        const count = searchRight(sorted, sorted[i] + reach) - i;
        if (count > bestCount) {
          bestCount = count;
          best = i;
        }
      }
      if (bestCount < group.length * 0.6) continue;
      group = order.slice(best, best + bestCount).map((i) => group[i]);
      elevations = group.map((k) => cells.get(k)!);
      if (group.length * cell * cell < Math.max(minWidthM ** 2, cell * cell * 4)) continue;
    }
    regions.push([median(elevations), group]);
  }
  const stats: LidarRecord = {
    ...ctx.stats,
    method: 'flat_regions',
    heightM: 0,
    tiers: [],
    explainedFraction: regions.reduce((s, [, g]) => s + g.length, 0) / Math.max(expected, 1),
  };
  if (ctx.surfaceFallback) stats.facetedFallback = ctx.surfaceFallback;
  if (ctx.areaCoverage) stats.coverageBasis = 'footprint_area';
  const largest = continuous.reduce((best, g) => (g.length > best.length ? g : best), [] as string[]);
  if ((ctx.roofPlanes ?? true) && largest.length >= cells.size * 0.85) {
    const elevations = largest.map((k) => cells.get(k)!);
    if (quantile(elevations, 0.9) - quantile(elevations, 0.1) >= minStepM) {
      const fitted = fitRoofPlanes(footprint, largest.map((k) => samples.get(k)!), minWidthM, minStepM);
      if (fitted) {
        return {
          record: { ...stats, ...fitted, explainedFraction: largest.length / Math.max(expected, 1), tiers: [], method: 'roof_planes' },
          reason: 'roof_planes',
        };
      }
    }
  }
  // A mapped part, or the missing piece of a mapped assembly, can take a
  // robust height without pretending its complex roof is flat terraces.
  if (ctx.allowComplexHeight) {
    const values = Float64Array.from(cells.values()).sort();
    const [low, mid, high, upper] = [0.1, 0.5, 0.9, 0.99].map((q) => sortedQuantile(values, q));
    const edges: number[] = [];
    for (const [key, h] of cells) {
      const [x, y] = parseKey(key);
      for (const other of [cellKey(x + 1, y), cellKey(x, y + 1)]) {
        const o = cells.get(other);
        if (o !== undefined) edges.push(Math.abs(h - o) < Math.max(3, cell) ? 1 : 0);
      }
    }
    const coherent = edges.length ? mean(edges) : 0;
    if (
      coverage >= 0.9 &&
      classified >= 0.4 &&
      (ctx.stats.roofSupportDensityM2 ?? 0) >= 1 &&
      coherent >= 0.8 &&
      high - low <= Math.max(12, mid * 0.2) &&
      upper - high <= Math.max(5, mid * 0.1)
    ) {
      const record: LidarRecord = { ...stats, explainedFraction: coherent, heightM: high, tiers: [], method: 'supported_roof_height' };
      if (regions.length) {
        // A one-metre consensus joins coplanar patches without merging shallow levels.
        let dominant = regions[0];
        let dominantCount = -1;
        for (const item of regions) {
          const count = regions.filter(([h]) => Math.abs(h - item[0]) < 0.5).reduce((s, [, g]) => s + g.length, 0);
          if (count > dominantCount) {
            dominantCount = count;
            dominant = item;
          }
        }
        const support = regions.filter(([h]) => Math.abs(h - dominant[0]) < 0.5).flatMap(([, g]) => g.map((k) => cells.get(k)!));
        if (support.length >= expected * 0.2) record.supportedBaseM = median(support);
      }
      return { record, reason: 'height_only' };
    }
  }
  const p90 = () => quantile([...cells.values()], 0.9);
  if (!regions.length) {
    if (classified < 0.7) return { record: null, reason: 'unclassified_nonplanar_roof' };
    return { record: { ...stats, heightM: p90(), tiers: [], method: 'roof_p90' }, reason: 'height_only' };
  }
  regions.sort((a, b) => a[0] - b[0]);
  // Separate coplanar patches become one level.
  const levels: [number, string[]][] = [];
  for (const [height, group] of regions) {
    const last = levels[levels.length - 1];
    if (last && height - last[0] < minStepM) {
      levels[levels.length - 1] = [(last[0] * last[1].length + height * group.length) / (last[1].length + group.length), [...last[1], ...group]];
    } else levels.push([height, group]);
  }
  if (levels.length > 24 || levels.reduce((s, [, g]) => s + g.length, 0) < cells.size * 0.5) {
    if (classified < 0.7) return { record: null, reason: 'complex_unclassified_roof' };
    return { record: { ...stats, heightM: p90(), tiers: [], method: 'roof_p90' }, reason: 'height_only' };
  }
  const baseHeight = levels[0][0];
  const boundary = state.boundary.length ? concatXyz(state.boundary) : xyz(0);
  const tiers: Tier[] = [];
  let support = footprint;
  let lower = baseHeight;
  const partFootprints = ctx.partFootprints ?? [];
  for (let level = 1; level < levels.length; level++) {
    const height = levels[level][0];
    // Every higher return supports the mass beneath it, not only the flat patches.
    const supported = [...cells].filter(([, h]) => h >= height - minStepM).map(([key]) => parseKey(key));
    let region = union(supported.map(([x, y]) => boxShape(x0 + x * cell, y0 + y * cell, x0 + (x + 1) * cell, y0 + (y + 1) * cell)[0]));
    region = buffer(buffer(region, cell * 0.55, 'miter'), -cell * 0.55, 'miter');
    region = union(region.map((polygon) => [polygon[0]]));
    const sampleRegion = rotate(region, angle, origin);
    let regularized = false;
    let measured = false;
    if (detailedSurfaces) {
      const candidate = regularizeGridContours(region, cell);
      regularized = !sameShape(candidate, region);
      region = candidate;
    }
    region = rotate(region, angle, origin);
    if (detailedSurfaces && height - lower >= Math.max(2, minStepM * 4)) {
      const candidate = measuredTierBoundary(sampleRegion, boundary, (lower + height) * 0.5, cell, minWidthM);
      if (!sameShape(candidate, sampleRegion)) {
        region = candidate;
        regularized = true;
        measured = true;
      }
    }
    const measuredArea = area(intersection(region, footprint));
    // Prefer a mapped part's outline only when it agrees with this plateau.
    const overlapRatio = (shape: MultiPolygon) => area(intersection(shape, region)) / area(union(shape, region));
    let bestMatch: MultiPolygon | null = null;
    let bestRatio = -1;
    for (const part of partFootprints) {
      if (!part.length || area(part) < minWidthM ** 2 || overlapRatio(part) < 0.8) continue;
      const clipped = intersection(part, footprint);
      const ratio = overlapRatio(clipped);
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestMatch = clipped;
      }
    }
    if (bestMatch) {
      const symmetric = area(difference(bestMatch, region)) + area(difference(region, bestMatch));
      if (symmetric <= area(region) * 0.2) {
        region = bestMatch;
        regularized = false;
        measured = false;
        stats.partBoundariesUsed = (stats.partBoundariesUsed ?? 0) + 1;
      }
    }
    // Opening removes strips narrower than a nozzle.
    const radius = minWidthM / 2;
    region = buffer(buffer(region, -radius, 'miter'), radius, 'miter');
    region = intersection(simplifyShape(region, cell * (regularized ? 0.1 : 0.45)), support);
    const keep = pieces(region).filter((p) => area(p) >= minWidthM ** 2 && !isEmpty(buffer(p, -radius * 0.9)));
    // Never quietly replace a tall building by its podium.
    if (!keep.length) return { record: null, reason: 'unprintable_major_tier' };
    region = union(...keep);
    if (area(region) < measuredArea * 0.8) return { record: null, reason: 'unprintable_major_tier' };
    if (tiers.length && sameShape(region, support)) {
      tiers[tiers.length - 1].topM = height;
      lower = height;
      continue;
    }
    if (measured) stats.measuredTierBoundaries = (stats.measuredTierBoundaries ?? 0) + 1;
    tiers.push({ bottomM: lower, topM: height, geometry: region });
    support = region;
    lower = height;
  }
  // A supported high roof too complex to reconstruct must not be swallowed by a lower plateau.
  const higher = [...cells.values()].filter((h) => h > lower + minStepM);
  if (higher.length >= Math.max(4, cells.size * 0.1) && higher.length * cell * cell >= minWidthM ** 2) return { record: null, reason: 'unresolved_upper_roof' };
  return { record: { ...stats, heightM: baseHeight, tiers, method: 'flat_regions' }, reason: tiers.length ? 'tiers' : 'height_only' };
}

export type { Box };
