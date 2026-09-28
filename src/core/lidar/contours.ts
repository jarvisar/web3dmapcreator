// Removing sampling-grid stairs from tier outlines without rounding real
// corners, ported from the add-on's lidar_contours.py. It reconstructs the
// boundary the raster cells support; it does not add survey resolution.
// Only alternating short orthogonal steps are replaced; long edges and
// genuine corners stay.

import { difference, multiArea } from '../geometry/polygon';
import type { MultiPolygon, Polygon, Ring, Vec2 } from '../types';
import { douglasPeucker, hausdorff, isValidPolygon, pyRound } from './shapes';
import { ringArea } from '../geometry/polygon';

/** Drop vertices that lie exactly on the line between their neighbours (Shapely's simplify(0)). */
function withoutCollinear(ring: Ring): Ring {
  let points = ring.slice();
  let changed = true;
  while (changed && points.length > 3) {
    changed = false;
    for (let i = 0; i < points.length; i++) {
      const a = points[(i + points.length - 1) % points.length];
      const b = points[i];
      const c = points[(i + 1) % points.length];
      if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) === 0) {
        points = [...points.slice(0, i), ...points.slice(i + 1)];
        changed = true;
        break;
      }
    }
  }
  return points;
}

function ringWithoutStairs(ring: Ring, cell: number): Ring {
  const points = withoutCollinear(ring);
  const count = points.length;
  if (count < 8) return points;
  const edges = points.map((p, i) => [points[(i + 1) % count][0] - p[0], points[(i + 1) % count][1] - p[1]] as Vec2);
  const epsilon = cell * 1e-6;
  // Only orthogonal raster staircases; diagonal source edges are authoritative.
  if (edges.some(([dx, dy]) => Math.abs(dx) > epsilon && Math.abs(dy) > epsilon)) return points;
  const lengths = edges.map(([dx, dy]) => Math.hypot(dx, dy));
  const turns = edges.map(([dx, dy], i) => {
    const previous = edges[(i + count - 1) % count];
    return previous[0] * dy - previous[1] * dx > 0 ? 1 : -1;
  });
  // Stairs alternate left and right; repeated turns are a real corner, and
  // long wall runs are anchored at both ends.
  const anchors: number[] = [];
  for (let i = 0; i < count; i++) {
    const before = (i + count - 1) % count;
    if (turns[i] === turns[before] || turns[i] === turns[(i + 1) % count] || lengths[before] > cell * 2.5 || lengths[i] > cell * 2.5) anchors.push(i);
  }
  if (!anchors.length) return points;
  const result: Ring = [];
  anchors.forEach((start, j) => {
    let end = anchors[(j + 1) % anchors.length];
    if (end <= start) end += count;
    let chain: Vec2[] = [];
    for (let i = start; i <= end; i++) chain.push(points[i % count]);
    if (chain.length >= 5) {
      // Fit edge midpoints, which lie between the inward and outward stair
      // corners: simplifying the corners biases the diagonal towards
      // whichever stair phase holds the endpoints.
      const middle = chain.slice(1).map((b, k) => [(chain[k][0] + b[0]) * 0.5, (chain[k][1] + b[1]) * 0.5] as Vec2);
      const origin = chain[0];
      // Cell units, so ties are stable across scales and far-off coordinates.
      const normalized = middle.map(([x, y]) => [roundTo((x - origin[0]) / cell, 8), roundTo((y - origin[1]) / cell, 8)] as Vec2);
      const fitted = douglasPeucker(normalized, 0.35).map(([x, y]) => [origin[0] + x * cell, origin[1] + y * cell] as Vec2);
      chain = [chain[0], ...fitted, chain[chain.length - 1]];
    }
    result.push(...chain.slice(0, -1));
  });
  return result;
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return pyRound(value * factor) / factor;
}

function symmetricArea(a: MultiPolygon, b: MultiPolygon): number {
  return multiArea(difference(a, b)) + multiArea(difference(b, a));
}

/**
 * Straightened or smoothly curved tier outlines, keeping the original where
 * a part would change its area by more than 5%, move by more than 0.8 cells
 * or lose a courtyard.
 */
export function regularizeGridContours(geometry: MultiPolygon, cell: number): MultiPolygon {
  if (!geometry.length || !Number.isFinite(cell) || cell <= 0) return geometry;
  const parts: Polygon[] = [];
  for (const original of geometry) {
    try {
      const candidate: Polygon = original.map((ring) => ringWithoutStairs(ring, cell));
      const before = multiArea([original]);
      const after = multiArea([candidate]);
      if (
        !isValidPolygon(candidate) ||
        after <= 0 ||
        Math.abs(after - before) > before * 0.05 ||
        symmetricArea([candidate], [original]) > before * 0.08 ||
        hausdorff(original, candidate) > cell * 0.8
      ) {
        parts.push(original);
        continue;
      }
      // A small courtyard must not vanish inside an acceptable total error.
      const holes = original.slice(1).some((hole, k) => Math.abs(Math.abs(ringArea(candidate[k + 1])) - Math.abs(ringArea(hole))) > Math.abs(ringArea(hole)) * 0.05);
      parts.push(holes ? original : candidate);
    } catch {
      parts.push(original);
    }
  }
  // Components fitted apart may now touch; never union them, which could merge towers.
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      if (multiArea(difference([parts[i]], [parts[j]])) < multiArea([parts[i]]) - 1e-12) return geometry;
    }
  }
  return parts;
}
