// GEOS 3.13 and CPython 3.11 arithmetic that measurements depend on to the
// last bit, as Shapely 2.1 runs them in the add-on. The coverage grid follows
// the longest side of the minimum rotated rectangle, and opposite sides of a
// rectangle are the same length to within rounding, so a generic rectangle
// fit turns half of all grids by 180 degrees and moves every cell.
// Checked against Shapely on random and real footprints.

import { orient2d } from 'robust-predicates';
import type { Vec2 } from '../types';

/** GEOS Orientation::index: 1 counterclockwise, -1 clockwise, 0 collinear, exactly. */
export function orientation(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  // robust-predicates has y pointing down.
  return -Math.sign(orient2d(ax, ay, bx, by, cx, cy)) || 0;
}

// GEOS math::DD, double-double arithmetic, operation for operation.
const SPLIT = 134217729.0;

class DD {
  constructor(
    public hi: number,
    public lo = 0,
  ) {}

  add(y: DD): DD {
    const [yhi, ylo] = [y.hi, y.lo];
    let S = this.hi + yhi;
    let T = this.lo + ylo;
    let e = S - this.hi;
    let f = T - this.lo;
    let s = S - e;
    let t = T - f;
    s = yhi - e + (this.hi - s);
    t = ylo - f + (this.lo - t);
    e = s + T;
    const H = S + e;
    const h = e + (S - H);
    e = t + h;
    const zhi = H + e;
    return new DD(zhi, e + (H - zhi));
  }

  sub(y: DD): DD {
    return this.add(new DD(-1 * y.hi, -1 * y.lo));
  }

  mul(y: DD): DD {
    const { hi, lo } = this;
    const [yhi, ylo] = [y.hi, y.lo];
    let C = SPLIT * hi;
    let hx = C - hi;
    let c = SPLIT * yhi;
    hx = C - hx;
    const tx = hi - hx;
    let hy = c - yhi;
    C = hi * yhi;
    hy = c - hy;
    const ty = yhi - hy;
    c = hx * hy - C + hx * ty + tx * hy + tx * ty + (hi * ylo + lo * yhi);
    const zhi = C + c;
    hx = C - zhi;
    return new DD(zhi, c + hx);
  }

  div(y: DD): DD {
    const { hi, lo } = this;
    const [yhi, ylo] = [y.hi, y.lo];
    const C = hi / yhi;
    let c = SPLIT * C;
    let hc = c - C;
    let u = SPLIT * yhi;
    hc = c - hc;
    const tc = C - hc;
    let hy = u - yhi;
    const U = C * yhi;
    hy = u - hy;
    const ty = yhi - hy;
    u = hc * hy - U + hc * ty + tc * hy + tc * ty;
    c = (hi - U - u + lo - C * ylo) / yhi;
    u = C + c;
    return new DD(u, C - u + c);
  }

  value(): number {
    return this.hi + this.lo;
  }
}

/** GEOS CGAlgorithmsDD::intersection of the lines through p1-p2 and q1-q2. */
function lineIntersection(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): Vec2 {
  const [p1x, p1y, p2x, p2y] = [new DD(p1[0]), new DD(p1[1]), new DD(p2[0]), new DD(p2[1])];
  const [q1x, q1y, q2x, q2y] = [new DD(q1[0]), new DD(q1[1]), new DD(q2[0]), new DD(q2[1])];
  const px = p1y.sub(p2y);
  const py = p2x.sub(p1x);
  const pw = p1x.mul(p2y).sub(p2x.mul(p1y));
  const qx = q1y.sub(q2y);
  const qy = q2x.sub(q1x);
  const qw = q1x.mul(q2y).sub(q2x.mul(q1y));
  const x = py.mul(qw).sub(qy.mul(pw));
  const y = qx.mul(pw).sub(px.mul(qw));
  const w = px.mul(qy).sub(qx.mul(py));
  return [x.div(w).value(), y.div(w).value()];
}

const same = (a: Vec2, b: Vec2) => a[0] === b[0] && a[1] === b[1];
const distance = (a: Vec2, b: Vec2) => Math.sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]));

/** Distance::pointToLinePerpendicular, via LineSegment::distancePerpendicular. */
function perpendicular(a: Vec2, b: Vec2, p: Vec2): number {
  if (same(a, b)) return distance(a, p);
  const len2 = (b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]);
  const s = ((a[1] - p[1]) * (b[0] - a[0]) - (a[0] - p[0]) * (b[1] - a[1])) / len2;
  return Math.abs(s) * Math.sqrt(len2);
}

function oriented(a: Vec2, b: Vec2, p: Vec2, orient: number): number {
  let d: number;
  if (same(a, b)) d = distance(a, p);
  else {
    d = perpendicular(a, b, p);
    if (orientation(a[0], a[1], b[0], b[1], p[0], p[1]) < 0) d = -d;
  }
  return orient === 0 ? Math.abs(d) : d;
}

function project(a: Vec2, b: Vec2, p: Vec2): Vec2 {
  if (same(p, a) || same(p, b)) return p;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const r = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
  return [a[0] + r * (b[0] - a[0]), a[1] + r * (b[1] - a[1])];
}

/**
 * The convex hull as GEOS returns it: strictly convex vertices, clockwise,
 * from the lowest point (leftmost among equals), closed.
 */
export function hullRing(points: Vec2[]): Vec2[] {
  const unique = new Map<string, Vec2>();
  for (const p of points) unique.set(`${p[0]},${p[1]}`, p);
  const sorted = [...unique.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const chain = (list: Vec2[]) => {
    const out: Vec2[] = [];
    for (const p of list) {
      while (out.length >= 2 && orientation(...out[out.length - 2], ...out[out.length - 1], ...p) >= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  // Clockwise: the upper chain left to right, then the lower one back.
  const ring = [...chain(sorted), ...chain([...sorted].reverse())];
  let start = 0;
  for (let i = 1; i < ring.length; i++) {
    if (ring[i][1] < ring[start][1] || (ring[i][1] === ring[start][1] && ring[i][0] < ring[start][0])) start = i;
  }
  const out = [...ring.slice(start), ...ring.slice(0, start)];
  out.push(out[0]);
  return out;
}

function furthest(ring: Vec2[], a: Vec2, b: Vec2, start: number, orient: number): number {
  const further = (d1: number, d2: number) => (orient === 0 ? Math.abs(d1) >= Math.abs(d2) : orient === 1 ? d1 >= d2 : d1 <= d2);
  let maxDistance = oriented(a, b, ring[start], orient);
  let nextDistance = maxDistance;
  let maxIndex = start;
  let nextIndex = maxIndex;
  while (further(nextDistance, maxDistance)) {
    maxDistance = nextDistance;
    maxIndex = nextIndex;
    nextIndex = maxIndex + 1 >= ring.length - 1 ? 0 : maxIndex + 1;
    if (nextIndex === start) break;
    nextDistance = oriented(a, b, ring[nextIndex], orient);
  }
  return maxIndex;
}

/** Rectangle::createLineForStandardEquation, as two points on the line. */
function standardLine(a: number, b: number, c: number): [Vec2, Vec2] {
  if (Math.abs(b) > Math.abs(a)) return [[0.0, c / b], [1.0, c / b - a / b]];
  return [[c / a, 0.0], [c / a - b / a, 1.0]];
}

/**
 * MinimumAreaRectangle::getMinimumRectangle: its four corners in GEOS's
 * order, or null when the points are collinear.
 */
export function minimumAreaRectangle(points: Vec2[]): Vec2[] | null {
  const ring = hullRing(points);
  if (ring.length < 4) return null;
  let minArea = Number.MAX_VALUE;
  let base = -1;
  let diam = -1;
  let left = -1;
  let right = -1;
  let diameterIndex = 1;
  let leftIndex = 1;
  let rightIndex = -1;
  for (let i = 0; i < ring.length - 1; i++) {
    const [a, b] = [ring[i], ring[i + 1]];
    diameterIndex = furthest(ring, a, b, diameterIndex, 0);
    const diamPt = ring[diameterIndex];
    const diamBase = project(a, b, diamPt);
    leftIndex = furthest(ring, diamBase, diamPt, leftIndex, 1);
    if (i === 0) rightIndex = diameterIndex;
    rightIndex = furthest(ring, diamBase, diamPt, rightIndex, -1);
    const width = perpendicular(diamBase, diamPt, ring[leftIndex]) + perpendicular(diamBase, diamPt, ring[rightIndex]);
    const area = distance(diamBase, diamPt) * width;
    if (area < minArea) {
      minArea = area;
      [base, diam, left, right] = [i, diameterIndex, leftIndex, rightIndex];
    }
  }
  // Rectangle::createFromSidePts
  const [baseRight, baseLeft, opposite, leftSide, rightSide] = [ring[base], ring[base + 1], ring[diam], ring[left], ring[right]];
  const dx = baseLeft[0] - baseRight[0];
  const dy = baseLeft[1] - baseRight[1];
  const equationC = (a: number, b: number, p: Vec2) => a * p[1] - b * p[0];
  const baseLine = standardLine(-dy, dx, equationC(dx, dy, baseRight));
  const oppLine = standardLine(-dy, dx, equationC(dx, dy, opposite));
  const leftLine = standardLine(-dx, -dy, equationC(-dy, dx, leftSide));
  const rightLine = standardLine(-dx, -dy, equationC(-dy, dx, rightSide));
  return [
    same(rightSide, baseRight) ? baseRight : lineIntersection(...baseLine, ...rightLine),
    same(leftSide, baseLeft) ? baseLeft : lineIntersection(...baseLine, ...leftLine),
    same(leftSide, opposite) ? opposite : lineIntersection(...oppLine, ...leftLine),
    same(rightSide, opposite) ? opposite : lineIntersection(...oppLine, ...rightLine),
  ];
}

const T27 = 134217729.0;

/** CPython 3.11 math.dist in two dimensions (vector_norm), which is not Math.hypot. */
export function pyDist(a: Vec2, b: Vec2): number {
  const vec = [Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])];
  const max = Math.max(vec[0], vec[1]);
  if (!Number.isFinite(max)) return max;
  if (max === 0) return 0;
  let e = Math.floor(Math.log2(max)) + 1;
  // frexp's exponent: max * 2^-e in [0.5, 1).
  if (max * 2 ** -e < 0.5) e--;
  else if (max * 2 ** -e >= 1) e++;
  // Subnormal differences take another path in CPython. Never met here.
  if (e < -1023) return Math.hypot(vec[0], vec[1]);
  const scale = 2 ** -e;
  let csum = 1.0;
  let frac1 = 0.0;
  let frac2 = 0.0;
  let frac3 = 0.0;
  let x: number, t: number, hi: number, lo: number, oldcsum: number;
  for (const value of vec) {
    x = value * scale;
    t = x * T27;
    hi = t - (t - x);
    lo = x - hi;
    x = hi * hi;
    oldcsum = csum;
    csum += x;
    frac1 += oldcsum - csum + x;
    x = 2.0 * hi * lo;
    oldcsum = csum;
    csum += x;
    frac2 += oldcsum - csum + x;
    frac3 += lo * lo;
  }
  const h = Math.sqrt(csum - 1.0 + (frac1 + frac2 + frac3));
  x = h;
  t = x * T27;
  hi = t - (t - x);
  lo = x - hi;
  x = -hi * hi;
  oldcsum = csum;
  csum += x;
  frac1 += oldcsum - csum + x;
  x = -2.0 * hi * lo;
  oldcsum = csum;
  csum += x;
  frac2 += oldcsum - csum + x;
  x = -lo * lo;
  oldcsum = csum;
  csum += x;
  frac3 += oldcsum - csum + x;
  x = csum - 1.0 + (frac1 + frac2 + frac3);
  return (h + x / (2.0 * h)) / scale;
}
