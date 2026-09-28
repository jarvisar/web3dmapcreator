// A few supported roof planes cut to the footprint, for shed, gable, hip
// and broad sloping roofs in the terrace fallback. Ported from the add-on's
// lidar_planes.py. RANSAC samples come from a small seeded generator rather
// than numpy's; each plane is refitted on its inliers afterwards, so the
// sample order rarely changes the result.

import { intersection, multiArea } from '../geometry/polygon';
import type { MultiPolygon, Vec2 } from '../types';
import { lstsq, sortedQuantile } from './numeric';
import type { RoofSurface } from './records';
import { buffer, bounds, hullShape, Inside, isEmpty, pieces } from './shapes';

/** The part of `box` where a*x + b*y + c >= 0. */
function halfPlane(box: [number, number, number, number], a: number, b: number, c: number): MultiPolygon {
  const ring: Vec2[] = [
    [box[0], box[1]],
    [box[2], box[1]],
    [box[2], box[3]],
    [box[0], box[3]],
  ];
  const out: Vec2[] = [];
  for (let k = 0; k < 4; k++) {
    const p = ring[k];
    const q = ring[(k + 1) % 4];
    const fp = a * p[0] + b * p[1] + c;
    const fq = a * q[0] + b * q[1] + c;
    if (fp >= 0) out.push(p);
    if (fp >= 0 !== fq >= 0) {
      const t = fp / (fp - fq);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
    }
  }
  return out.length >= 3 ? [[out]] : [];
}

export interface PlaneFit {
  heightM: number;
  roofSurfaces: RoofSurface[];
  roofFitP90M: number;
}

/**
 * Eave height and supported planar polygons, or null. Samples are one xyz per
 * roof cell. The final envelope must explain 90% of the samples and cover
 * the whole outline.
 */
export function fitRoofPlanes(footprint: MultiPolygon, samples: number[][], minWidth: number, minRise: number, tolerance = 0.45): PlaneFit | null {
  const n = samples.length;
  if (n < 12) return null;
  let cx = 0;
  let cy = 0;
  for (const s of samples) {
    cx += s[0];
    cy += s[1];
  }
  cx /= n;
  cy /= n;
  const design = new Float64Array(n * 3);
  const heights = new Float64Array(n);
  samples.forEach((s, k) => {
    design[3 * k] = s[0] - cx;
    design[3 * k + 1] = s[1] - cy;
    design[3 * k + 2] = 1;
    heights[k] = s[2];
  });
  const predict = (coef: number[], k: number) => design[3 * k] * coef[0] + design[3 * k + 1] * coef[1] + coef[2];
  const fit = (rows: number[]) => {
    const d = new Float64Array(rows.length * 3);
    const r = new Float64Array(rows.length);
    rows.forEach((k, m) => {
      d.set(design.subarray(3 * k, 3 * k + 3), 3 * m);
      r[m] = heights[k];
    });
    return lstsq(d, r, 3);
  };
  let seed = 0x9e3779b9;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const remaining = new Uint8Array(n).fill(1);
  const planes: number[][] = [];
  const minimum = Math.max(6, Math.floor(n * 0.1));
  const inliers = (coef: number[]) => {
    const out: number[] = [];
    for (let k = 0; k < n; k++) if (remaining[k] && Math.abs(predict(coef, k) - heights[k]) <= tolerance) out.push(k);
    return out;
  };
  for (let round = 0; round < 4; round++) {
    const indices: number[] = [];
    for (let k = 0; k < n; k++) if (remaining[k]) indices.push(k);
    if (indices.length < minimum) break;
    let best: number[] = [];
    for (let attempt = 0; attempt < 160; attempt++) {
      let chosen = indices;
      if (attempt) {
        const picked = new Set<number>();
        while (picked.size < 3) picked.add(indices[Math.floor(random() * indices.length)]);
        chosen = [...picked];
      }
      const { coef, rank } = fit(chosen);
      if (rank !== 3 || Math.hypot(coef[0], coef[1]) > 3) continue;
      const keep = inliers(coef);
      if (keep.length > best.length) best = keep;
    }
    if (best.length < minimum) break;
    let coef = fit(best).coef;
    for (let refit = 0; refit < 2; refit++) {
      best = inliers(coef);
      if (best.length < minimum) break;
      coef = fit(best).coef;
    }
    if (best.length < minimum || Math.hypot(coef[0], coef[1]) > 3) break;
    planes.push(coef);
    for (const k of best) remaining[k] = 0;
    let left = 0;
    for (let k = 0; k < n; k++) left += remaining[k];
    if (left <= n * 0.08) break;
  }
  if (!planes.length) return null;
  const envelope = new Float64Array(n).fill(Infinity);
  const owner = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    planes.forEach((coef, i) => {
      const z = predict(coef, k);
      if (z < envelope[k]) {
        envelope[k] = z;
        owner[k] = i;
      }
    });
  }
  let explained = 0;
  const residuals = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    residuals[k] = Math.abs(envelope[k] - heights[k]);
    if (residuals[k] <= tolerance * 1.5) explained++;
  }
  if (explained / n < 0.9) return null;
  // Reject extrapolated planes and tiny facets: ownership must agree with the samples.
  const global = planes.map((c) => [c[0], c[1], c[2] - (c[0] * cx + c[1] * cy)]);
  const box = bounds(footprint);
  const surfaces: RoofSurface[] = [];
  const extrema: number[] = [];
  for (let i = 0; i < global.length; i++) {
    let region = footprint;
    for (let j = 0; j < global.length; j++) {
      if (i === j) continue;
      region = intersection(region, halfPlane(box, global[j][0] - global[i][0], global[j][1] - global[i][1], global[j][2] - global[i][2]));
    }
    for (const polygon of pieces(region)) {
      if (multiArea(polygon) < minWidth ** 2 || isEmpty(buffer(polygon, -minWidth * 0.35))) return null;
      const near = new Inside(buffer(polygon, 0.1));
      const owned: number[] = [];
      for (let k = 0; k < n; k++) if (owner[k] === i && near.has(samples[k][0], samples[k][1])) owned.push(samples[k][0], samples[k][1]);
      if (owned.length / 2 < minimum) return null;
      // A narrow scan strip must not support a plane far beyond it.
      if (multiArea(hullShape(owned)) < multiArea(polygon) * 0.45) return null;
      const coef = global[i];
      const rings = polygon[0].map((ring) =>
        [...ring, ring[0]].map(([x, y]) => {
          const z = coef[0] * x + coef[1] * y + coef[2];
          extrema.push(z);
          return [x, y, z] as [number, number, number];
        }),
      );
      surfaces.push({ rings, bottomM: 0 });
    }
  }
  if (!surfaces.length || surfaces.length > 8 || Math.max(...extrema) - Math.min(...extrema) < minRise) return null;
  const lowest = Math.min(...extrema);
  if (lowest <= 2 || lowest < Math.min(...heights) - minWidth * 3) return null;
  // At least one real slope: a noisy flat plane is never roof detail.
  if (Math.max(...planes.map((c) => Math.hypot(c[0], c[1]))) < 0.06) return null;
  for (const surface of surfaces) surface.bottomM = lowest;
  return { heightM: lowest, roofSurfaces: surfaces, roofFitP90M: sortedQuantile(Float64Array.from(residuals).sort(), 0.9) };
}
