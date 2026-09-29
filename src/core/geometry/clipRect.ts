// Integer rings cut to a rectangle, for both the 3D model and SVG maps.
//
// Clipper2's rectClip can drop a corner when a large ring leaves the
// rectangle through one side and comes back in through the next, which lost
// a triangle of road in testing. Sutherland-Hodgman keeps the winding number
// of every point inside the rectangle, which is all a NonZero boolean after
// it needs. Its output can run back and forth along the rectangle's edges,
// so don't use it without that boolean.

import type { Path64, Paths64, Point64, Rect64 } from 'clipper2-ts';

export function clipToRect(rect: Rect64, paths: Paths64): Paths64 {
  const out: Paths64 = [];
  for (const path of paths) {
    const [minX, minY, maxX, maxY] = pathBounds(path);
    if (maxX < rect.left || minX > rect.right || maxY < rect.top || minY > rect.bottom) continue;
    let kept = path;
    if (minX < rect.left) kept = clipSide(kept, 0, rect.left);
    if (maxX > rect.right) kept = clipSide(kept, 1, rect.right);
    if (minY < rect.top) kept = clipSide(kept, 2, rect.top);
    if (maxY > rect.bottom) kept = clipSide(kept, 3, rect.bottom);
    if (kept.length >= 3) out.push(kept);
  }
  return out;
}

/** minX, minY, maxX, maxY */
export function pathBounds(path: Path64): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { x, y } of path) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/** Keeps x >= v, x <= v, y >= v or y <= v for sides 0 to 3. */
function clipSide(path: Path64, side: number, v: number): Path64 {
  const out: Path64 = [];
  if (!path.length) return out;
  const inside = (p: Point64) => (side === 0 ? p.x >= v : side === 1 ? p.x <= v : side === 2 ? p.y >= v : p.y <= v);
  let prev = path[path.length - 1];
  let prevIn = inside(prev);
  for (const point of path) {
    const pointIn = inside(point);
    if (pointIn !== prevIn) {
      if (side < 2) {
        const t = (v - prev.x) / (point.x - prev.x);
        out.push({ x: v, y: Math.round(prev.y + t * (point.y - prev.y)) });
      } else {
        const t = (v - prev.y) / (point.y - prev.y);
        out.push({ x: Math.round(prev.x + t * (point.x - prev.x)), y: v });
      }
    }
    if (pointIn) out.push(point);
    prev = point;
    prevIn = pointIn;
  }
  return out;
}
