// Changing how tall a building is. Every height above the building's ground
// level is stretched by one factor, so a tower keeps its crown, a pitched
// roof its pitch and a part standing on another stays on it.

import type { HeightFn, PrismSolid, Solid } from '../geometry/solid';
import type { Polygon } from '../types';

// A draped underside stays in the ground, but at least this far under the
// new top, or a squashed building would turn inside out.
const MIN_THICKNESS_MM = 0.05;

/** Roof pieces are planar, so their extremes are at the outline's corners. */
function topRange(top: HeightFn | number, polygon: Polygon): [number, number] {
  if (typeof top === 'number') return [top, top];
  let low = Infinity;
  let high = -Infinity;
  for (const ring of polygon) {
    for (const [x, y] of ring) {
      const z = top(x, y);
      if (z < low) low = z;
      if (z > high) high = z;
    }
  }
  return [low, high];
}

/** Highest point of a solid. */
export function solidPeak(solid: Solid): number {
  let peak = -Infinity;
  if (solid.kind === 'prism') return topRange(solid.top, solid.polygon)[1];
  const values = solid.kind === 'cap' ? solid.vertices : solid.positions;
  for (let i = 2; i < values.length; i += 3) if (values[i] > peak) peak = values[i];
  return peak;
}

export function lowestTop(solid: PrismSolid): number {
  return topRange(solid.top, solid.polygon)[0];
}

export function lowestBottom(solid: PrismSolid): number {
  return topRange(solid.bottom, solid.polygon)[0];
}

export function peakOf(solids: readonly Solid[]): number {
  let peak = -Infinity;
  for (const solid of solids) peak = Math.max(peak, solidPeak(solid));
  return peak;
}

/** The solid with every height above `base` multiplied by `factor`. */
export function scaleSolid(solid: Solid, base: number, factor: number): Solid {
  const scale = (z: number) => base + (z - base) * factor;
  if (solid.kind === 'cap') {
    const vertices = new Float64Array(solid.vertices);
    for (let i = 2; i < vertices.length; i += 3) vertices[i] = scale(vertices[i]);
    return { ...solid, vertices, bottom: scale(solid.bottom) };
  }
  if (solid.kind === 'mesh') {
    const positions = Float32Array.from(solid.positions);
    for (let i = 2; i < positions.length; i += 3) positions[i] = scale(positions[i]);
    return { ...solid, positions };
  }
  const oldTop = solid.top;
  const top: HeightFn | number = typeof oldTop === 'number' ? scale(oldTop) : (x, y) => scale(oldTop(x, y));
  let bottom = solid.bottom;
  if (typeof bottom === 'number') {
    // An underside below the ground stands on a floor under water and stays there.
    if (bottom > base) bottom = scale(bottom);
  } else {
    const ground = bottom;
    const ceiling = topRange(top, solid.polygon)[0] - MIN_THICKNESS_MM;
    bottom = (x, y) => Math.min(ground(x, y), ceiling);
  }
  return { ...solid, top, bottom } satisfies PrismSolid;
}

/**
 * The factor that takes a group of solids standing on `base` to `heightMm`
 * above it, or 1 when they have no height to scale.
 */
export function heightFactor(solids: readonly Solid[], base: number, heightMm: number): number {
  const current = peakOf(solids) - base;
  if (!(current > 1e-3) || !(heightMm > 0)) return 1;
  return heightMm / current;
}
