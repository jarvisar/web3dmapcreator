// Cracks between ribbons of one colour. Two roads side by side with a hairline
// of ground between them print with a groove the nozzle can't fill, so a
// crack narrower than half the gap is filled from one centerline across to
// the other, and so is enclosed ground nowhere that wide (a plaza criss-crossed
// by paths, a mini roundabout's island).
//
// This used to fill everything up to the whole gap, between colours too. Four
// ramps side by side printed as one block of road and a track beside a street
// as a brown slab, a lot thicker than the roads looked with the tidy off. A
// crack this narrow closes up in the print anyway, so the fill doesn't change
// how wide anything looks. Wider grooves stay: lines of one rank too close to
// print apart are thinned out before this (cull.ts), and the rest are real
// roads that happen to run close.
//
// A strip starts where the crack gets too thin and carries on until it's
// clearly open again, so lines hovering around the limit give one strip
// instead of a row of rungs. Only lines alongside each other count, so a
// street corner keeps its shape.

import { offsetPolygons, ringArea } from '../../geometry/polygon';
import type { MultiPolygon, Polygon, Ring, Vec2 } from '../../types';
import type { RoadGroup, RoadPiece } from '../roads';
import { SegmentIndex } from './lines';

const PARALLEL_DEG = 28;
const STEP_MM = 0.2;
// Of the gap: cracks narrower than this are filled.
const CRACK = 0.5;
// A strip carries on until the gap is this much wider than the limit.
const HYSTERESIS = 1.3;
// Shorter strips are left out: a sliver of fill where two lines brush past.
const MIN_STRIP_MM = 0.5;

/** Strips filling each crack between two lines of one group. */
export function gapStrips(pieces: RoadPiece[], minimumGap: number): Record<RoadGroup, Polygon[]> {
  const strips: Record<RoadGroup, Polygon[]> = { road: [], rail: [], path: [] };
  const gap = CRACK * minimumGap;
  if (!(gap > 0) || !pieces.length) return strips;
  const maxHalfWidth = pieces.reduce((m, p) => Math.max(m, p.widthMm / 2), 0);
  const index = new SegmentIndex(Math.max(HYSTERESIS * gap + 2 * maxHalfWidth, 0.1));
  pieces.forEach((p, i) => index.add(p.points, i));
  const cos = Math.cos((PARALLEL_DEG * Math.PI) / 180);

  pieces.forEach((piece, i) => {
    // A yard's tracks sit this close and read fine as separate lines. Filled,
    // the yard printed as one band.
    if (piece.group === 'rail') return;
    const halfWidth = piece.widthMm / 2;
    // A run of samples all facing the same neighbour, and the points across from them.
    let near: Vec2[] = [];
    let far: Vec2[] = [];
    let other = -1;
    let length = 0;
    const flush = () => {
      if (near.length >= 2 && length >= MIN_STRIP_MM) strips[piece.group].push([[...near, ...[...far].reverse()]]);
      near = [];
      far = [];
      other = -1;
      length = 0;
    };
    for (let k = 1; k < piece.points.length; k++) {
      const [ax, ay] = piece.points[k - 1];
      const [bx, by] = piece.points[k];
      const segment = Math.hypot(bx - ax, by - ay);
      if (segment === 0) continue;
      const ux = (bx - ax) / segment;
      const uy = (by - ay) / segment;
      const count = Math.max(1, Math.round(segment / STEP_MM));
      for (let n = k === 1 ? 0 : 1; n <= count; n++) {
        const x = ax + (bx - ax) * (n / count);
        const y = ay + (by - ay) * (n / count);
        const found = { d: Infinity, point: null as Vec2 | null, owner: -1 };
        index.near(x, y, (s) => {
          const j = index.owner[s];
          // Each pair once, from the piece with the lower index.
          if (j <= i || pieces[j].group !== piece.group) return;
          const t = index.along(s, x, y);
          if ((t <= 0 && index.first[s]) || (t >= 1 && index.last[s])) return;
          const d = index.distance(s, x, y, t);
          const edges = halfWidth + pieces[j].widthMm / 2;
          // Already overlapping, or far enough apart to print ground between.
          // A strip under way carries on a little further.
          const limit = (j === other ? HYSTERESIS : 1) * gap;
          if (d <= edges || d >= limit + edges || d >= found.d) return;
          if (Math.abs(ux * index.ux[s] + uy * index.uy[s]) < cos || !index.beside(s, x, y, ux, uy)) return;
          found.d = d;
          found.point = index.closest(s, x, y);
          found.owner = j;
        });
        if (!found.point || found.owner !== other) flush();
        if (!found.point) continue;
        if (near.length) length += Math.hypot(x - near[near.length - 1][0], y - near[near.length - 1][1]);
        other = found.owner;
        near.push([x, y]);
        far.push(found.point);
      }
    }
    flush();
  });
  return strips;
}

/**
 * Ground enclosed by one group's ribbons that is nowhere as wide as a crack,
 * filled. Each hole is tested on its own, and most (city blocks) are
 * dismissed by their area against their outline first.
 */
export function fillThinHoles(polygons: MultiPolygon, minimumGap: number): { polygons: MultiPolygon; filled: number } {
  const gap = CRACK * minimumGap;
  if (!(gap > 0)) return { polygons, filled: 0 };
  let filled = 0;
  const out = polygons.map((polygon): Polygon => {
    if (polygon.length < 2) return polygon;
    const holes = polygon.slice(1).filter((hole) => {
      if (!thin(hole, gap)) return true;
      filled++;
      return false;
    });
    return holes.length === polygon.length - 1 ? polygon : [polygon[0], ...holes];
  });
  return { polygons: out, filled };
}

function thin(ring: Ring, gap: number): boolean {
  const signed = ringArea(ring);
  const area = Math.abs(signed);
  let perimeter = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  if (perimeter <= 0) return true;
  // Twice the area over the outline is about the width of a long strip. A
  // hole wider than the gap on average has a part that prints.
  if ((2 * area) / perimeter > gap) return false;
  // Holes run clockwise. As an outer ring, eroded by half the gap, nothing is left of a thin one.
  const outer = signed < 0 ? [...ring].reverse() : ring;
  return offsetPolygons([[outer]], -gap / 2, 'round').length === 0;
}
