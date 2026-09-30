// Pulling a loose end onto the road it nearly meets. Once sidewalks are left
// out, a park path stops at the kerb, and a side street that met the dropped
// carriageway of a divided road stops short of the one kept.
//
// An end that met something in the source that's gone now is joined to a
// road at least as important within twice the gap of its edge. A real dead
// end (a cul-de-sac, a driveway stopping short of the next street) is only
// joined when the ground left would be too thin to print, so no junction is
// invented. The join carries the line straight on when that meets the road,
// and otherwise takes the shortest way across, but only heading on the way
// the line was going and never across another line. Nothing bends: a taper
// sideways into a road drew long diagonals where nothing was mapped. Ends on
// the model's edge and bridge decks never move.

import type { Vec2 } from '../../types';
import { polylineLength } from '../linework';
import { SegmentIndex } from './lines';
import type { Candidate, Part } from './routes';

const PARALLEL_DEG = 28;
// How far off its own heading the shortest way across may point.
const AHEAD_DEG = 60;

export function joinEnds(parts: Part[], candidates: Candidate[], gap: number, tolerance: number): number {
  const maxHalfWidth = candidates.reduce((m, c) => Math.max(m, c.halfWidth), 0);
  const index = new SegmentIndex(Math.max(2 * gap + 2 * maxHalfWidth, 0.1));
  parts.forEach((part, i) => {
    if (!candidates[part.source].deck) index.add(part.points, i);
  });
  const parallel = Math.cos((PARALLEL_DEG * Math.PI) / 180);
  const ahead = Math.cos((AHEAD_DEG * Math.PI) / 180);
  let joined = 0;

  // Whether the straight join from p to q crosses any line but the target's.
  const crosses = (p: Vec2, q: Vec2, self: number, target: number) => {
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const length = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(length / (index.cell / 2)));
    for (let k = 0; k <= steps; k++) {
      const x = p[0] + (dx * k) / steps;
      const y = p[1] + (dy * k) / steps;
      const hit = index.near(x, y, (s) => {
        const o = index.owner[s];
        if (o === self || o === target) return false;
        return segmentsCross(p, q, [index.ax[s], index.ay[s]], [index.bx[s], index.by[s]]);
      });
      if (hit) return true;
    }
    return false;
  };

  parts.forEach((part, i) => {
    const c = candidates[part.source];
    if (c.deck) return;
    // No longer than the gap it would cross: joining would fold it up.
    if (polylineLength(part.points) <= 2 * gap + 2 * c.halfWidth) return;
    for (const end of [0, 1] as const) {
      const origin = part.ends[end];
      if (origin === 'edge') continue;
      const point = end ? part.points[part.points.length - 1] : part.points[0];
      const heading = outward(part.points, end);
      if (!heading) continue;
      const orphan = origin === 'met';
      const reach = (orphan ? 2 * gap : gap) + c.halfWidth;
      let touching = false;
      let straight = { distance: Infinity, target: null as Vec2 | null, owner: -1 };
      let across = { distance: Infinity, target: null as Vec2 | null, owner: -1 };
      index.near(point[0], point[1], (s) => {
        const o = index.owner[s];
        const other = candidates[parts[o].source];
        if (o === i || other.rank > c.rank) return false;
        const distance = index.distance(s, point[0], point[1]);
        if (distance <= Math.max(other.halfWidth, tolerance)) {
          touching = true;
          return true;
        }
        if (distance > reach + other.halfWidth) return false;
        // Running alongside rather than heading in.
        if (Math.abs(heading[0] * index.ux[s] + heading[1] * index.uy[s]) >= parallel) return false;
        const hit = rayHit(point, heading, [index.ax[s], index.ay[s]], [index.bx[s], index.by[s]]);
        if (hit !== null && hit <= reach + other.halfWidth && hit < straight.distance) {
          straight = { distance: hit, target: [point[0] + heading[0] * hit, point[1] + heading[1] * hit], owner: o };
        }
        const q = index.closest(s, point[0], point[1]);
        const toward = ((q[0] - point[0]) * heading[0] + (q[1] - point[1]) * heading[1]) / (distance || 1);
        if (toward >= ahead && distance < across.distance) across = { distance, target: q, owner: o };
        return false;
      });
      if (touching) continue;
      const choice = straight.target ? straight : across;
      if (!choice.target) continue;
      // A real dead end only joins across ground too thin to print.
      if (!orphan) {
        const other = candidates[parts[choice.owner].source];
        if (choice.distance - c.halfWidth - other.halfWidth >= gap) continue;
      }
      if (crosses(point, choice.target, i, choice.owner)) continue;
      if (end) part.points.push(choice.target);
      else part.points.unshift(choice.target);
      joined++;
    }
  });
  return joined;
}

// The way a line points at its end, over its last 0.2 mm, so a scrap of a
// last segment doesn't decide it.
function outward(points: Vec2[], end: 0 | 1): Vec2 | null {
  const n = points.length;
  const tip = end ? points[n - 1] : points[0];
  for (let k = 1; k < n; k++) {
    const v = end ? points[n - 1 - k] : points[k];
    const d = Math.hypot(tip[0] - v[0], tip[1] - v[1]);
    if (d >= 0.2 || k === n - 1) return d > 1e-12 ? [(tip[0] - v[0]) / d, (tip[1] - v[1]) / d] : null;
  }
  return null;
}

// Distance along a ray from p in direction u to where it crosses segment ab, or null.
function rayHit(p: Vec2, u: Vec2, a: Vec2, b: Vec2): number | null {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const denominator = u[0] * ey - u[1] * ex;
  if (Math.abs(denominator) < 1e-12) return null;
  const t = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / denominator;
  const s = ((a[0] - p[0]) * u[1] - (a[1] - p[1]) * u[0]) / denominator;
  return t >= 0 && s >= 0 && s <= 1 ? t : null;
}

// Proper crossings only: touching at an end doesn't count.
function segmentsCross(p: Vec2, q: Vec2, a: Vec2, b: Vec2): boolean {
  const d = (u: Vec2, v: Vec2, w: Vec2) => (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
  const d1 = d(a, b, p);
  const d2 = d(a, b, q);
  const d3 = d(p, q, a);
  const d4 = d(p, q, b);
  return d1 * d2 < -1e-12 && d3 * d4 < -1e-12;
}
