// Pulling a loose end onto the road it nearly meets. Once sidewalks are left
// out, a park path stops at the kerb, and a side street that met the culled
// carriageway stops beside the kept one.
//
// An end that met something in the source that's gone now is joined to a
// road at least as important within twice the gap of its edge. A real dead
// end (a cul-de-sac, a driveway stopping short of the next street) is only
// joined when the ground left would be too thin to print, so no junction is
// invented. Ends on the model's edge and bridge decks never move.

import type { Vec2 } from '../../types';
import { polylineLength } from '../linework';
import { endHeading, SegmentIndex } from './lines';
import type { Candidate, Part } from './routes';

const PARALLEL_DEG = 28;
// A sideways merge bends in over this many times the distance it moves.
const TAPER_RATIO = 3;

export function joinEnds(parts: Part[], candidates: Candidate[], gap: number, tolerance: number): number {
  const maxHalfWidth = candidates.reduce((m, c) => Math.max(m, c.halfWidth), 0);
  const index = new SegmentIndex(Math.max(2 * gap + 2 * maxHalfWidth, 0.1));
  parts.forEach((part, i) => {
    if (!candidates[part.source].deck) index.add(part.points, i);
  });
  const cos = Math.cos((PARALLEL_DEG * Math.PI) / 180);
  let joined = 0;

  parts.forEach((part, i) => {
    const c = candidates[part.source];
    if (c.deck) return;
    // No longer than the gap it would cross: joining would fold it up.
    if (polylineLength(part.points) <= 2 * gap + 2 * c.halfWidth) return;
    for (const end of [0, 1] as const) {
      const origin = part.ends[end];
      if (origin === 'edge') continue;
      const point = end ? part.points[part.points.length - 1] : part.points[0];
      const heading = endHeading(part.points, end);
      if (!heading) continue;
      const orphan = origin === 'met';
      const reach = (orphan ? 2 * gap : gap) + c.halfWidth;
      const best = { distance: Infinity, target: null as Vec2 | null, parallel: false };
      const touching = index.near(point[0], point[1], (s) => {
        const o = index.owner[s];
        const other = candidates[parts[o].source];
        if (o === i || other.rank > c.rank) return false;
        const t = index.along(s, point[0], point[1]);
        const distance = index.distance(s, point[0], point[1], t);
        if (distance <= Math.max(other.halfWidth, tolerance)) return true;
        if (distance > reach + other.halfWidth || distance >= best.distance) return false;
        // Running alongside rather than heading in. Only an end whose partner
        // went merges sideways, from inside the corridor that doubled it and
        // beside the road, not past its end: a taper to a road's last point
        // drew a long diagonal where nothing was mapped.
        const parallel = Math.abs(heading[0] * index.ux[s] + heading[1] * index.uy[s]) >= cos;
        const pastEnd = (t <= 0 && index.first[s]) || (t >= 1 && index.last[s]);
        if (parallel && (!orphan || pastEnd || distance > gap + c.halfWidth + other.halfWidth)) return false;
        best.distance = distance;
        best.target = index.closest(s, point[0], point[1]);
        best.parallel = parallel;
        return false;
      });
      if (touching || !best.target) continue;
      const moved = best.parallel ? taper(part.points, end, best.target, tolerance) : connect(part.points, end, best.target, heading, tolerance);
      if (moved) joined++;
    }
  });
  return joined;
}

// A short connector from the end to the road, or the end cut back where it
// ran past it. Moving the end vertex would swing its whole last segment, and
// Overture draws a straight kilometre with two vertices.
function connect(points: Vec2[], end: 0 | 1, target: Vec2, heading: Vec2, tolerance: number): boolean {
  const point = end ? points[points.length - 1] : points[0];
  const dx = target[0] - point[0];
  const dy = target[1] - point[1];
  if (Math.hypot(dx, dy) <= tolerance) return false;
  if (dx * heading[0] + dy * heading[1] < 0) {
    const neighbour = end ? points[points.length - 2] : points[1];
    if (Math.hypot(target[0] - neighbour[0], target[1] - neighbour[1]) <= tolerance) return false;
    if (end) points[points.length - 1] = target;
    else points[0] = target;
    return true;
  }
  if (end) points.push(target);
  else points.unshift(target);
  return true;
}

// Bend the last stretch of a line running beside a road into it. Everything
// before the taper keeps its place.
function taper(points: Vec2[], end: 0 | 1, target: Vec2, tolerance: number): boolean {
  const ordered = end ? [...points] : [...points].reverse();
  const last = ordered[ordered.length - 1];
  const lateral = Math.hypot(target[0] - last[0], target[1] - last[1]);
  if (lateral <= tolerance) return false;
  const length = TAPER_RATIO * lateral;
  if (polylineLength(ordered) < 2 * length) return false;
  let remaining = length;
  for (let i = ordered.length - 1; i > 0; i--) {
    const a = ordered[i - 1];
    const b = ordered[i];
    const segment = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (segment >= remaining) {
      const t = segment > 0 ? (segment - remaining) / segment : 0;
      const start: Vec2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const rebuilt = [...ordered.slice(0, i), start, target];
      if (!end) rebuilt.reverse();
      points.splice(0, points.length, ...rebuilt);
      return true;
    }
    remaining -= segment;
  }
  return false;
}
