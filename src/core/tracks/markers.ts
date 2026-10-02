// Start and finish markers: a dot at the start and a bar across the finish,
// like a finish line. A loop starts and finishes in the same place, so it
// only gets the dot. From SVGmap. Shapes are rings in the lines' own units,
// either way round.
//
// The ends come from the recorded track, not the lines as clipped: clipping
// returns the pieces of a route that leaves the area and comes back in any
// order, and their ends are on the area's edge.

import type { Vec2 } from '../types';

export interface MarkerEnds {
  /** Null when the route starts or finishes off the model. */
  start: Vec2 | null;
  finish: Vec2 | null;
  /** Direction of travel into the finish. */
  heading: Vec2;
}

function circle([cx, cy]: Vec2, r: number, tolerance: number): Vec2[] {
  const step = 2 * Math.acos(Math.max(-1, 1 - tolerance / r));
  const n = Math.min(256, Math.max(16, Math.ceil((2 * Math.PI) / step)));
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) out.push([cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
  return out;
}

// Direction of travel into the end, measured over a short stretch so GPS
// wobble right at the finish doesn't tilt the bar.
function finishDirection(line: readonly Vec2[], reach: number): Vec2 {
  const end = line[line.length - 1];
  for (let i = line.length - 2; i >= 0; i--) {
    const d = Math.hypot(end[0] - line[i][0], end[1] - line[i][1]);
    if (d >= reach || (i === 0 && d > 1e-9)) return [(end[0] - line[i][0]) / d, (end[1] - line[i][1]) / d];
  }
  return [1, 0];
}

/** The nearest point on the lines within `reach`, and the line and segment it's on. */
function nearestOn(lines: readonly Vec2[][], [px, py]: Vec2, reach: number): { point: Vec2; line: readonly Vec2[]; segment: number } | null {
  let best = reach;
  let out: { point: Vec2; line: readonly Vec2[]; segment: number } | null = null;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = line[i - 1];
      const dx = line[i][0] - ax;
      const dy = line[i][1] - ay;
      const length2 = dx * dx + dy * dy;
      const t = length2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2)) : 0;
      const x = ax + dx * t;
      const y = ay + dy * t;
      const d = Math.hypot(x - px, y - py);
      if (d <= best) {
        best = d;
        out = { point: [x, y], line, segment: i };
      }
    }
  }
  return out;
}

// Along a line through a point on its segment, back towards its start, or
// forward where the line starts too close. The bar is the same either way round.
function headingAt(line: readonly Vec2[], segment: number, [px, py]: Vec2, reach: number): Vec2 | null {
  let far: Vec2 | null = null;
  for (let i = segment - 1; i >= 0 && !far; i--) if (Math.hypot(line[i][0] - px, line[i][1] - py) >= reach) far = line[i];
  for (let i = segment; i < line.length && !far; i++) if (Math.hypot(line[i][0] - px, line[i][1] - py) >= reach) far = line[i];
  if (!far) return null;
  const d = Math.hypot(far[0] - px, far[1] - py);
  return [(far[0] - px) / d, (far[1] - py) / d];
}

/**
 * Where the markers go: the recorded track's first and last points, moved
 * onto `lines` (clipped, and snapped if asked) when they're within `reach`.
 * An end off the model (`inside` false) gets no marker.
 */
export function markerEnds(recorded: readonly Vec2[][], lines: readonly Vec2[][], inside: (point: Vec2) => boolean, reach: number, size: number): MarkerEnds {
  const first = recorded[0]?.[0];
  const lastLine = recorded[recorded.length - 1];
  const last = lastLine?.[lastLine.length - 1];
  if (!first || !last) return { start: null, finish: null, heading: [1, 0] };
  const start = inside(first) ? (nearestOn(lines, first, reach)?.point ?? first) : null;
  let finish: Vec2 | null = null;
  let heading = finishDirection(lastLine, size / 2);
  if (inside(last)) {
    const near = nearestOn(lines, last, reach);
    finish = near?.point ?? last;
    if (near) heading = headingAt(near.line, near.segment, near.point, size / 2) ?? heading;
  }
  return { start, finish, heading };
}

/** `size` is the dot's diameter. `tolerance` is how far the dot's sides may sit off a true circle. */
export function markerShapes({ start, finish, heading }: MarkerEnds, size: number, tolerance = 0.005): Vec2[][] {
  if (!(size > 0)) return [];
  const shapes: Vec2[][] = [];
  if (start) shapes.push(circle(start, size / 2, tolerance));
  if (finish && !(start && Math.hypot(finish[0] - start[0], finish[1] - start[1]) < size)) {
    const [dx, dy] = heading;
    const along = size * 0.2;
    const across = size * 0.6;
    const corner = (a: number, b: number): Vec2 => [finish[0] - dy * across * a + dx * along * b, finish[1] + dx * across * a + dy * along * b];
    shapes.push([corner(1, -1), corner(1, 1), corner(-1, 1), corner(-1, -1)]);
  }
  return shapes;
}
