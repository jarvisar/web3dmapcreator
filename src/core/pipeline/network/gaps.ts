// Ground too thin to print between roads can't print as a strip of its own:
// the gore where a ramp leaves the motorway, a street beside a ramp it
// doesn't quite double, the median of a divided road that isn't merged,
// the hairlines between the tracks of a rail yard. It's filled, so the two
// print as one wider road.
//
// Between lines running side by side the fill is a strip from one centerline
// across to the other, unioned with the roads. A strip starts where the gap
// gets too thin and carries on until it's clearly printable again, so lines
// hovering around the limit give one band instead of a row of rungs. Enclosed
// ground is filled whole when no part of it is as wide as the gap: a plaza
// criss-crossed by paths, a mini roundabout's island. Only lines alongside
// each other count for the strips, so a street corner keeps its shape.

import { offsetPolygons, ringArea } from '../../geometry/polygon';
import type { MultiPolygon, Polygon, Ring, Vec2 } from '../../types';
import type { RoadGroup, RoadPiece } from '../roads';
import { SegmentIndex } from './lines';

const PARALLEL_DEG = 28;
const STEP_MM = 0.2;
// A strip carries on until the gap is this much wider than the limit.
const HYSTERESIS = 1.3;
// Shorter strips are left out: a sliver of fill where two lines brush past.
const MIN_STRIP_MM = 0.5;
const GROUPS: RoadGroup[] = ['road', 'rail', 'path'];

/**
 * Strips filling each too-thin gap. A strip between a street and a path or
 * track takes the path's or track's colour, so the street keeps its edge.
 */
export function gapStrips(pieces: RoadPiece[], gap: number): Record<RoadGroup, Polygon[]> {
  const strips: Record<RoadGroup, Polygon[]> = { road: [], rail: [], path: [] };
  if (!(gap > 0) || !pieces.length) return strips;
  const maxHalfWidth = pieces.reduce((m, p) => Math.max(m, p.widthMm / 2), 0);
  const index = new SegmentIndex(Math.max(HYSTERESIS * gap + 2 * maxHalfWidth, 0.1));
  pieces.forEach((p, i) => index.add(p.points, i));
  const cos = Math.cos((PARALLEL_DEG * Math.PI) / 180);

  pieces.forEach((piece, i) => {
    const halfWidth = piece.widthMm / 2;
    // A run of samples all facing the same neighbour, and the points across from them.
    let near: Vec2[] = [];
    let far: Vec2[] = [];
    let other = -1;
    let length = 0;
    const flush = () => {
      if (near.length >= 2 && length >= MIN_STRIP_MM) {
        const group = GROUPS[Math.max(GROUPS.indexOf(piece.group), GROUPS.indexOf(pieces[other].group))];
        strips[group].push([[...near, ...[...far].reverse()]]);
      }
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
          if (j <= i) return;
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
 * Ground enclosed by one group's ribbons that is nowhere as wide as the gap,
 * filled. Each hole is tested on its own, and most (city blocks) are
 * dismissed by their area against their outline first.
 */
export function fillThinHoles(polygons: MultiPolygon, gap: number): { polygons: MultiPolygon; filled: number } {
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
