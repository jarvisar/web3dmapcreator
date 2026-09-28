// Sub-cell tier outlines from supported roof returns, ported from the
// add-on's lidar_boundaries.py. The coarse roof grid still decides which
// masses exist; only a narrow band around a tier's outline is rebuilt from
// observed high and low returns, and anything unsupported keeps its old
// outline.

import Delaunator from 'delaunator';
import { bufferLines, clipLines, difference, intersection, multiArea, multiBounds, union } from '../geometry/polygon';
import type { MultiPolygon, Polygon, Ring, Vec2 } from '../types';
import { solve3 } from './numeric';
import type { Xyz } from './points';
import { buffer, douglasPeucker, hausdorff, Inside, intersects, isEmpty, isValidPolygon } from './shapes';
import { ringArea } from '../geometry/polygon';

const MAX_BOUNDARY_SAMPLES = 4096;

// Savitzky-Golay weights: the value at the centre of a quadratic fitted over 11 samples.
const SMOOTHING = (() => {
  const rows = Array.from({ length: 11 }, (_, k) => [1, k - 5, (k - 5) ** 2]);
  const ata = [0, 1, 2].map((i) => [0, 1, 2].map((j) => rows.reduce((s, r) => s + r[i] * r[j], 0)));
  return rows.map((r) => {
    // First row of (A^T A)^-1 A^T: solve (A^T A) w = e0 then dot with the row.
    const inverse0 = solve3(ata, [1, 0, 0])!;
    return inverse0[0] * r[0] + inverse0[1] * r[1] + inverse0[2] * r[2];
  });
})();

function ringLength(ring: Ring): number {
  let total = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) total += Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]);
  return total;
}

/** Points at the given arc lengths along a closed ring. */
function interpolate(ring: Ring, distances: number[]): Vec2[] {
  const out: Vec2[] = [];
  let edge = 0;
  let travelled = 0;
  const n = ring.length;
  for (const d of distances) {
    for (;;) {
      const a = ring[edge % n];
      const b = ring[(edge + 1) % n];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (travelled + length >= d || edge >= n - 1) {
        const t = length > 0 ? Math.min(1, Math.max(0, (d - travelled) / length)) : 0;
        out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
        break;
      }
      travelled += length;
      edge++;
    }
  }
  return out;
}

/** GEOS's normalized exterior: clockwise, starting at the lexicographically smallest vertex. */
function normalizedRing(ring: Ring): Ring {
  let points = ringArea(ring) > 0 ? ring.slice().reverse() : ring.slice();
  let start = 0;
  points.forEach((p, i) => {
    const q = points[start];
    if (p[0] < q[0] || (p[0] === q[0] && p[1] < q[1])) start = i;
  });
  points = [...points.slice(start), ...points.slice(0, start)];
  return points;
}

/**
 * A local quadratic fit of the ring with resolved corners pinned. Equal
 * arc-length samples keep dense survey edges from weighing more; the
 * quadratic keeps straight lines and follows broad curvature without the
 * shrinking of repeated neighbour averaging.
 */
function fitRing(input: Ring, cell: number): Ring {
  const ring = normalizedRing(input);
  const coarse = douglasPeucker([...ring, ring[0]], cell * 0.4).slice(0, -1);
  const anchors: Vec2[] = [];
  coarse.forEach((point, i) => {
    const prev = coarse[(i + coarse.length - 1) % coarse.length];
    const next = coarse[(i + 1) % coarse.length];
    const before = [point[0] - prev[0], point[1] - prev[1]];
    const after = [next[0] - point[0], next[1] - point[1]];
    const a = Math.hypot(before[0], before[1]);
    const b = Math.hypot(after[0], after[1]);
    if (Math.min(a, b) >= cell * 2 && (before[0] * after[0] + before[1] * after[1]) / (a * b) < Math.cos((35 * Math.PI) / 180)) anchors.push(point);
  });
  const length = ringLength(ring);
  const count = Math.max(12, Math.ceil(length / (cell * 0.2)));
  if (count > MAX_BOUNDARY_SAMPLES) return ring;
  const xy = interpolate(
    ring,
    Array.from({ length: count }, (_, k) => (k * length) / count),
  );
  const fitted = xy.map((_, i) => {
    let x = 0;
    let y = 0;
    SMOOTHING.forEach((w, k) => {
      const p = xy[(((i - (k - 5)) % count) + count) % count];
      x += w * p[0];
      y += w * p[1];
    });
    return [x, y] as Vec2;
  });
  if (anchors.length) {
    xy.forEach((p, i) => {
      if (anchors.some((a) => Math.hypot(p[0] - a[0], p[1] - a[1]) <= cell)) fitted[i] = p;
    });
  }
  // Include the closing edge: no vertex stays fixed just because it came first.
  const simplified = douglasPeucker([...fitted, fitted[0]], cell * 0.1);
  simplified.pop();
  return simplified;
}

function removeUnprintableNoise(geometry: MultiPolygon, original: MultiPolygon, minWidth: number): MultiPolygon {
  const protectedHoles = union(original.flatMap((p) => p.slice(1).map((h) => [h] as Polygon)));
  const cleaned: Polygon[] = [];
  for (const part of geometry) {
    if (multiArea([part]) < minWidth ** 2) continue;
    const holes = part.slice(1).filter((h) => Math.abs(ringArea(h)) >= minWidth ** 2 || intersects([[h]], protectedHoles));
    cleaned.push([part[0], ...holes]);
  }
  return union(cleaned);
}

function boundaryLines(shape: MultiPolygon): Vec2[][] {
  return shape.flatMap((polygon) => polygon.map((ring) => [...ring, ring[0]]));
}

function totalLength(shape: MultiPolygon): number {
  return shape.reduce((s, polygon) => s + polygon.reduce((t, ring) => t + ringLength(ring), 0), 0);
}

function symmetric(a: MultiPolygon, b: MultiPolygon): number {
  return multiArea(difference(a, b)) + multiArea(difference(b, a));
}

/**
 * Refine a tier outline within a sub-cell error envelope, or keep the grid
 * mass. Equal-weight bins bound density, bins with both high and low returns
 * are left out, and only short observed triangles are used, never
 * extrapolated across a gap.
 */
export function measuredTierBoundary(region: MultiPolygon, samples: Xyz, threshold: number, cell: number, minWidth: number): MultiPolygon {
  if (!region.length || samples.count < 12 || !Number.isFinite(cell) || cell <= 0 || !Number.isFinite(minWidth) || minWidth <= 0) return region;
  // Resolved rectangular walls need no contour reconstruction.
  if (region.every((p) => douglasPeucker([...p[0], p[0][0]], cell * 1e-6).length <= 5)) return region;
  try {
    const band = bufferLines(boundaryLines(region).map((points) => ({ points, width: cell * 3 })));
    const inBand = new Inside(band);
    const local: number[] = [];
    for (let k = 0; k < samples.count; k++) if (inBand.has(samples.x[k], samples.y[k])) local.push(k);
    if (local.length < 12 || local.length > MAX_BOUNDARY_SAMPLES * 32) return region;
    const [ox, oy] = multiBounds(region);
    const spacing = Math.max(cell / 4, minWidth / 6);
    const keyOf = (k: number): [number, number] => [Math.floor((samples.x[k] - ox) / spacing), Math.floor((samples.y[k] - oy) / spacing)];
    local.sort((a, b) => {
      const [ax, ay] = keyOf(a);
      const [bx, by] = keyOf(b);
      return ax - bx || ay - by || samples.x[a] - samples.x[b] || samples.y[a] - samples.y[b] || samples.z[a] - samples.z[b];
    });
    const observations: [number, number, number][] = [];
    for (let i = 0; i < local.length; ) {
      const [kx, ky] = keyOf(local[i]);
      let j = i;
      while (j < local.length && keyOf(local[j])[0] === kx && keyOf(local[j])[1] === ky) j++;
      const group = local.slice(i, j);
      const high = group.map((k) => samples.z[k] >= threshold);
      if (high.every(Boolean) || !high.some(Boolean)) {
        observations.push([group.reduce((s, k) => s + samples.x[k], 0) / group.length, group.reduce((s, k) => s + samples.y[k], 0) / group.length, high[0] ? 1 : 0]);
      }
      i = j;
    }
    if (observations.length < 12 || observations.length > MAX_BOUNDARY_SAMPLES) return region;
    const highs = observations.filter((o) => o[2] === 1).length;
    if (Math.min(highs, observations.length - highs) < 6) return region;
    const del = Delaunator.from(observations.map((o) => [o[0], o[1]]));
    const triangles: Polygon[] = [];
    const roof: Polygon[] = [];
    for (let t = 0; t < del.triangles.length; t += 3) {
      const v = [del.triangles[t], del.triangles[t + 1], del.triangles[t + 2]].map((i) => observations[i]);
      let longest = 0;
      for (let k = 0; k < 3; k++) longest = Math.max(longest, Math.hypot(v[k][0] - v[(k + 1) % 3][0], v[k][1] - v[(k + 1) % 3][1]));
      if (longest > cell * 1.5) continue;
      triangles.push([v.map((p) => [p[0], p[1]] as Vec2)]);
      const high = v.map((p) => p[2] > 0.5);
      if (high.every(Boolean)) roof.push([v.map((p) => [p[0], p[1]] as Vec2)]);
      else if (high.some(Boolean)) {
        const ring: Vec2[] = [];
        for (let i = 0; i < 3; i++) {
          const j = (i + 1) % 3;
          if (high[i]) ring.push([v[i][0], v[i][1]]);
          if (high[i] !== high[j]) ring.push([(v[i][0] + v[j][0]) * 0.5, (v[i][1] + v[j][1]) * 0.5]);
        }
        if (ring.length >= 3) roof.push([ring]);
      }
    }
    if (triangles.length < 8 || !roof.length) return region;
    const observed = union(triangles);
    let candidate = union(difference(region, observed), union(roof));
    candidate = removeUnprintableNoise(candidate, region, minWidth);
    const fittedParts = candidate.map((part) => {
      const fitted: Polygon = part.map((ring) => fitRing(ring, cell));
      return isValidPolygon(fitted) ? fitted : part;
    });
    candidate = union(difference(region, observed), intersection(union(fittedParts), observed));
    candidate = removeUnprintableNoise(candidate, region, minWidth);
    if (isEmpty(candidate)) return region;
    // A scan gap can disagree locally while the rest of a long curved wall is
    // well observed: keep the old mass only there.
    const limit = cell * 0.8;
    const unsupported = [
      ...clipLines(boundaryLines(region), bufferLines(boundaryLines(candidate).map((points) => ({ points, width: limit * 2 }))), true),
      ...clipLines(boundaryLines(candidate), bufferLines(boundaryLines(region).map((points) => ({ points, width: limit * 2 }))), true),
    ];
    if (unsupported.length) {
      const preserve = bufferLines(unsupported.map((points) => ({ points, width: cell * 3 })));
      candidate = union(difference(candidate, preserve), intersection(region, preserve));
    }
    const regionArea = multiArea(region);
    const holes = (shape: MultiPolygon) => shape.map((p) => p.length - 1).sort((a, b) => a - b).join(',');
    if (
      candidate.length !== region.length ||
      holes(candidate) !== holes(region) ||
      !candidate.every(isValidPolygon) ||
      Math.abs(multiArea(candidate) - regionArea) > regionArea * 0.05 ||
      symmetric(candidate, region) > regionArea * 0.15 ||
      totalLength(candidate) > totalLength(region) * 1.02 ||
      hausdorff(candidate.flat(), region.flat()) > cell * 0.8
    ) {
      return region;
    }
    const unmatched = candidate.slice();
    for (const old of region) {
      let best = 0;
      let bestArea = -1;
      unmatched.forEach((p, i) => {
        const a = multiArea(intersection([p], [old]));
        if (a > bestArea) {
          bestArea = a;
          best = i;
        }
      });
      const match = unmatched[best];
      const oldArea = multiArea([old]);
      if (bestArea < oldArea * 0.85 || Math.abs(multiArea([match]) - oldArea) > oldArea * 0.05 || match.length !== old.length) return region;
      unmatched.splice(best, 1);
      for (const hole of old.slice(1)) {
        const holeArea = Math.abs(ringArea(hole));
        let closest: Ring | null = null;
        let closestArea = -1;
        for (const h of match.slice(1)) {
          const a = multiArea(intersection([[h]], [[hole]]));
          if (a > closestArea) {
            closestArea = a;
            closest = h;
          }
        }
        if (!closest || Math.abs(Math.abs(ringArea(closest)) - holeArea) > holeArea * 0.05) return region;
      }
    }
    return candidate;
  } catch {
    return region;
  }
}

export { buffer };
