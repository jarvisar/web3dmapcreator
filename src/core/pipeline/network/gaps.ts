// Ground between two roads running side by side that's narrower than the
// gap can't print as a strip of its own: the gore where a ramp leaves the
// motorway, a street beside a ramp it doesn't quite double. It's filled with
// a strip from one centerline across to the other, unioned with the roads,
// so the two print as one wider road. Only lines alongside each other count,
// so a street corner keeps its shape.

import type { Polygon, Vec2 } from '../../types';
import type { RoadGroup, RoadPiece } from '../roads';
import { SegmentIndex } from './lines';

const PARALLEL_DEG = 28;
const STEP_MM = 0.2;
const GROUPS: RoadGroup[] = ['road', 'rail', 'path'];

/** Strips filling each too-thin gap, by the group of the more important road. */
export function gapStrips(pieces: RoadPiece[], gap: number): Record<RoadGroup, Polygon[]> {
  const strips: Record<RoadGroup, Polygon[]> = { road: [], rail: [], path: [] };
  if (!(gap > 0) || !pieces.length) return strips;
  const maxHalfWidth = pieces.reduce((m, p) => Math.max(m, p.widthMm / 2), 0);
  const index = new SegmentIndex(Math.max(gap + 2 * maxHalfWidth, 0.1));
  pieces.forEach((p, i) => index.add(p.points, i));
  const cos = Math.cos((PARALLEL_DEG * Math.PI) / 180);

  pieces.forEach((piece, i) => {
    const halfWidth = piece.widthMm / 2;
    // A run of samples all facing the same neighbour, and the points across from them.
    let near: Vec2[] = [];
    let far: Vec2[] = [];
    let other = -1;
    const flush = () => {
      if (near.length >= 2) {
        const group = GROUPS[Math.min(GROUPS.indexOf(piece.group), GROUPS.indexOf(pieces[other].group))];
        strips[group].push([[...near, ...[...far].reverse()]]);
      }
      near = [];
      far = [];
      other = -1;
    };
    for (let k = 1; k < piece.points.length; k++) {
      const [ax, ay] = piece.points[k - 1];
      const [bx, by] = piece.points[k];
      const length = Math.hypot(bx - ax, by - ay);
      if (length === 0) continue;
      const ux = (bx - ax) / length;
      const uy = (by - ay) / length;
      const count = Math.max(1, Math.round(length / STEP_MM));
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
          if (d <= edges || d >= gap + edges || d >= found.d) return;
          if (Math.abs(ux * index.ux[s] + uy * index.uy[s]) < cos) return;
          found.d = d;
          found.point = index.closest(s, x, y);
          found.owner = j;
        });
        if (!found.point || found.owner !== other) flush();
        if (!found.point) continue;
        other = found.owner;
        near.push([x, y]);
        far.push(found.point);
      }
    }
    flush();
  });
  return strips;
}
