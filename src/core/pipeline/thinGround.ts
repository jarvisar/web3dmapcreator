// Ground in cut water and basins too thin to print. A pier or breakwater
// narrower than a nozzle line leaves a slot in the water part that neither
// part fills, and it prints as a hole in the water. `water.skipThinGround`
// fills it with water and `water.widenThinGround` widens it into the water.
// With both on, what's under the skip width goes and the rest is widened.
// Specks under the widen width every way go rather than grow.
//
// Thin ground has water on both sides: it's what a closing of the water
// fills. A mapped quay overlapping the water along the shore isn't thin
// however narrow it is there, since the land behind it is part of the gap.

import { boxesOverlap, difference, dropSmall, intersection, multiArea, offsetPolygons, polygonArea, ringBounds, ringPerimeter, union } from '../geometry/polygon';
import type { ModelSettings } from '../settings';
import type { MultiPolygon, Polygon } from '../types';
import type { WaterBody } from './water';

// Where the closing's outline and the water's differ by rounding.
const HAIR_MM = 0.001;
const MIN_PIECE_MM2 = 1e-4;
const WIDEN_PASSES = 3;
// Ground this close to the width is left as it is.
const MIN_GROWTH_MM = 0.005;
// Narrower than this isn't a pier: about 30 cm at the default scale.
const SLIVER_MM = 0.02;

/** Ground narrower than `width` with water on both sides. */
export function thinGround(water: MultiPolygon, width: number): MultiPolygon {
  if (!water.length) return [];
  const closed = offsetPolygons(offsetPolygons(water, width / 2), -width / 2);
  return withoutHairlines(difference(closed, water));
}

function withoutHairlines(mp: MultiPolygon): MultiPolygon {
  return dropSmall(offsetPolygons(offsetPolygons(mp, -HAIR_MM), HAIR_MM), MIN_PIECE_MM2);
}

/**
 * Width of the rectangle with the piece's area and perimeter. Exact for a
 * strip of even width however it bends or branches, and a square's side
 * for a blob.
 */
export function stripWidth(polygon: Polygon): number {
  let half = 0;
  for (const ring of polygon) half += ringPerimeter(ring) / 2;
  const d = half * half - 4 * polygonArea(polygon);
  return d > 0 ? (half - Math.sqrt(d)) / 2 : half / 2;
}

export interface ThinGround {
  bodies: WaterBody[];
  /** Ground kept in the water: mapped piers and the like less what was skipped, and what was widened. */
  decks: MultiPolygon;
  skipped: number;
  widened: number;
}

/**
 * Thin decks are dropped and thin islands and spits join the water beside
 * them, before the terrain under the water is flattened. Widened ground is
 * kept in the water like a mapped pier, so the bodies keep their outlines.
 */
export function settleThinGround(bodies: WaterBody[], decks: MultiPolygon, settings: ModelSettings['water'], areaScale: number): ThinGround {
  const wet = () => union(bodies.filter((b) => b.kind !== 'sheet').map((b) => b.polygon));
  const sheets = bodies.filter((b) => b.kind === 'sheet').map((b) => b.polygon);
  let skipped = 0;
  let widened = 0;
  const skip = (thin: MultiPolygon) => {
    // What isn't a deck is land: an island, or a spit the water's outline runs around.
    const islands = withoutHairlines(difference(thin, union(decks, sheets)));
    decks = dropSmall(difference(decks, offsetPolygons(thin, HAIR_MM)), MIN_PIECE_MM2);
    bodies = fillIslands(bodies, islands, areaScale);
  };

  if (settings.skipThinGround) {
    const thin = thinGround(difference(wet(), decks), settings.skipThinMm);
    if (thin.length) skip(thin);
    skipped = thin.length;
  }

  if (settings.widenThinGround) {
    const width = settings.widenThinMm;
    // A piece grows by its mean width, so a walkway with much thinner fingers
    // leaves the fingers narrow. They're thin pieces of their own next pass.
    for (let pass = 0; pass < WIDEN_PASSES; pass++) {
      const thin = thinGround(difference(wet(), decks), width);
      // Specks under the width every way, like mooring posts, came out as
      // blobs, and slivers where a pier's outline and the water's disagree
      // as strips of their own, so both go instead. Only the first pass
      // looks for specks: later ones find the short ends of fingers.
      const noise = (piece: Polygon) => {
        const across = stripWidth(piece);
        return across < SLIVER_MM || (pass === 0 && polygonArea(piece) / across < width);
      };
      const dropped = thin.filter(noise);
      if (dropped.length) skip(dropped);
      // Later passes find crumbs of the same noise, not more ground.
      if (pass === 0) skipped += dropped.length;
      const grown = thin.flatMap((piece) => {
        const by = (width - stripWidth(piece)) / 2;
        return by > MIN_GROWTH_MM && !noise(piece) ? offsetPolygons([piece], by) : [];
      });
      if (!grown.length) break;
      if (pass === 0) widened = grown.length;
      decks = union(decks, intersection(union(grown), wet()));
    }
  }
  return { bodies, decks, skipped, widened };
}

/** Each island goes to the body it shares the most shore with. */
function fillIslands(bodies: WaterBody[], islands: MultiPolygon, areaScale: number): WaterBody[] {
  if (!islands.length) return bodies;
  const boxes = bodies.map((b) => ringBounds(b.polygon[0]));
  const added = new Map<number, MultiPolygon>();
  for (const island of islands) {
    const box = ringBounds(island[0]);
    const near = bodies.flatMap((b, i) => (b.kind !== 'sheet' && boxesOverlap(boxes[i], box, 4 * HAIR_MM) ? [i] : []));
    // Grown past rounding, so it meets the water without a hairline between them.
    const grown = offsetPolygons([island], 2 * HAIR_MM);
    let best = -1;
    let shore = 0;
    for (const i of near) {
      const shared = multiArea(intersection(grown, [bodies[i].polygon]));
      if (shared > shore) [best, shore] = [i, shared];
    }
    if (best < 0) continue;
    const others = near.filter((i) => i !== best).map((i) => bodies[i].polygon);
    const piece = difference(offsetPolygons([island], HAIR_MM), others);
    added.set(best, [...(added.get(best) ?? []), ...piece]);
  }
  if (!added.size) return bodies;
  return bodies.flatMap((body, i) => {
    const pieces = added.get(i);
    if (!pieces) return [body];
    return union([body.polygon], pieces).map((polygon) => ({ ...body, polygon, areaM2: polygonArea(polygon) / areaScale }));
  });
}
