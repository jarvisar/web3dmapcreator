// With supports off, what stands in cut water or a basin is built down
// through the water in its own material instead of on ground kept under it:
// to the floor of the recess, or to the base where the water runs through the
// model. Only the part in the water goes down. The water is cut around it
// either way (generate.ts), so with the water left out in the slicer nothing
// is left standing on air.

import { boxesOverlap, clipToBox, difference, dropSmall, intersection, multiBounds, ringBounds, type Box } from '../geometry/polygon';
import type { PrismSolid } from '../geometry/solid';
import type { MultiPolygon, Polygon } from '../types';

export interface WadeBody {
  /** Where there's no ground in it. */
  polygons: Polygon[];
  box: Box;
  /** What something standing in it is built down to. */
  footing: number;
}

// Pieces of a split smaller than this are rounding.
const MIN_PIECE_MM2 = 1e-4;

export class Wading {
  readonly bodies: WadeBody[];

  constructor(bodies: { polygons: Polygon[]; footing: number }[]) {
    this.bodies = bodies.filter((b) => b.polygons.length).map((b) => ({ ...b, box: multiBounds(b.polygons) }));
  }

  /**
   * A solid standing on the ground, with its part in each body of water
   * built down to that body's footing. Anything else comes back as it was.
   */
  wade(solid: PrismSolid): PrismSolid[] {
    if (typeof solid.bottom === 'number' || !this.bodies.length) return [solid];
    const box = ringBounds(solid.polygon[0]);
    const near = this.bodies.filter((b) => boxesOverlap(b.box, box));
    if (!near.length) return [solid];
    const subject: MultiPolygon = [solid.polygon];
    const wet: { body: WadeBody; pieces: MultiPolygon }[] = [];
    for (const body of near) {
      // A city's streets are one polygon, so only the part near the body takes part.
      const local = clipToBox(subject, body.box);
      const pieces = local.length ? dropSmall(intersection(local, body.polygons), MIN_PIECE_MM2) : [];
      if (pieces.length) wet.push({ body, pieces });
    }
    if (!wet.length) return [solid];
    const dry = dropSmall(difference(subject, wet.flatMap((w) => w.body.polygons)), MIN_PIECE_MM2);
    const out: PrismSolid[] = dry.map((polygon) => ({ ...solid, polygon }));
    for (const { body, pieces } of wet) {
      // A wet piece keeps a little under its own top, like a squashed building.
      for (const polygon of pieces) out.push({ ...solid, polygon, bottom: Math.min(body.footing, lowestTop(solid, polygon) - 0.05) });
    }
    return out;
  }
}

function lowestTop(solid: PrismSolid, polygon: Polygon): number {
  const top = solid.top;
  if (typeof top === 'number') return top;
  let low = Infinity;
  for (const ring of polygon) for (const [x, y] of ring) low = Math.min(low, top(x, y));
  return low;
}
