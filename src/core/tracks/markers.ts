// Start and finish markers: a dot at the start and a bar across the finish,
// like a finish line. A loop starts and finishes in the same place, so it
// only gets the dot. From SVGmap. Shapes are rings in the lines' own units,
// either way round.

import type { Vec2 } from '../types';

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

/** `size` is the dot's diameter. `tolerance` is how far the dot's sides may sit off a true circle. */
export function markerShapes(lines: readonly Vec2[][], size: number, tolerance = 0.005): Vec2[][] {
  if (!lines.length || !(size > 0)) return [];
  const start = lines[0][0];
  const last = lines[lines.length - 1];
  const end = last[last.length - 1];
  const shapes = [circle(start, size / 2, tolerance)];
  if (Math.hypot(end[0] - start[0], end[1] - start[1]) >= size) {
    const [dx, dy] = finishDirection(last, size / 2);
    const along = size * 0.2;
    const across = size * 0.6;
    const corner = (a: number, b: number): Vec2 => [end[0] - dy * across * a + dx * along * b, end[1] + dx * across * a + dy * along * b];
    shapes.push([corner(1, -1), corner(1, 1), corner(-1, 1), corner(-1, -1)]);
  }
  return shapes;
}
