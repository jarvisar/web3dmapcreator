// All distances in engine/lines are finished millimetres on the piece.

export type Point = [number, number];
export type Path = Point[];

// Lower rank is more important. The key is whatever the caller uses to tell groups apart.
export interface LineItem<K = string> {
  rank: number;
  key: K;
  path: Path;
}

export function pointSegmentDistanceSq(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 1e-18) {
    const ex = p[0] - a[0];
    const ey = p[1] - a[1];
    return ex * ex + ey * ey;
  }
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = p[0] - (a[0] + t * dx);
  const ey = p[1] - (a[1] + t * dy);
  return ex * ex + ey * ey;
}

export function closestPointOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 1e-18) return [a[0], a[1]];
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return [a[0] + t * dx, a[1] + t * dy];
}

export function unit(a: Point, b: Point): Point | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const n = Math.hypot(dx, dy);
  if (n <= 1e-18) return null;
  return [dx / n, dy / n];
}

export function pathLength(path: Path): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  }
  return total;
}

export function samplePoints(a: Point, b: Point, spacing: number, cap = 8): Point[] {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let count = spacing > 0 ? Math.trunc(length / spacing) : 0;
  count = Math.max(1, Math.min(count, cap));
  const out: Point[] = [];
  for (let i = 0; i <= count; i++) {
    out.push([a[0] + ((b[0] - a[0]) * i) / count, a[1] + ((b[1] - a[1]) * i) / count]);
  }
  return out;
}

// Leaves out the endpoints. Lines always touch their neighbours there, so
// counting them makes short paths look doubled.
export function interiorSamples(a: Point, b: Point, spacing: number, cap = 8): Point[] {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let count = spacing > 0 ? Math.trunc(length / spacing) : 0;
  count = Math.max(1, Math.min(count, cap));
  const out: Point[] = [];
  for (let i = 0; i < count; i++) {
    out.push([
      a[0] + ((b[0] - a[0]) * (i + 0.5)) / count,
      a[1] + ((b[1] - a[1]) * (i + 0.5)) / count,
    ]);
  }
  return out;
}

// Rounds halves to even like Python's round(), so points quantise the same way
// as in the original pipeline.
export function roundHalfEven(x: number): number {
  const r = Math.round(x);
  if (Math.abs(x % 1) === 0.5) return 2 * Math.round(x / 2);
  return r;
}

// Unique while |iy| stays under 2^25 cells.
export function cellKey(ix: number, iy: number): number {
  return ix * 67108864 + iy;
}

export function nodeKey(point: Point, quantum: number): number {
  return cellKey(roundHalfEven(point[0] / quantum), roundHalfEven(point[1] / quantum));
}

// A bigger cell only makes lookups slower, never wrong. A tolerance of zero would
// otherwise mean billions of cells per segment.
const MIN_CELL = 0.05;

interface GridSegment {
  a: Point;
  b: Point;
  dir: Point;
}

// Filled incrementally. Rebuilding an index inside a loop is what caused the
// original pipeline's O(n^2) hangs.
export class SegmentGrid {
  readonly cell: number;
  private readonly cells = new Map<number, GridSegment[]>();
  empty = true;

  constructor(paths: Iterable<Path> = [], cell = 1.0) {
    this.cell = Math.max(cell, MIN_CELL);
    for (const path of paths) this.add(path);
  }

  add(path: Path): void {
    const cell = this.cell;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const dir = unit(a, b);
      if (dir === null) continue;
      const item: GridSegment = { a, b, dir };
      this.empty = false;
      const steps = Math.trunc(Math.hypot(b[0] - a[0], b[1] - a[1]) / cell) + 1;
      const seen = new Set<number>();
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        seen.add(
          cellKey(
            Math.floor((a[0] + (b[0] - a[0]) * t) / cell),
            Math.floor((a[1] + (b[1] - a[1]) * t) / cell),
          ),
        );
      }
      for (const key of seen) {
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(item);
        else this.cells.set(key, [item]);
      }
    }
  }

  // Stops as soon as visit returns true.
  someNear(point: Point, visit: (a: Point, b: Point, dir: Point) => boolean): boolean {
    const cx = Math.floor(point[0] / this.cell);
    const cy = Math.floor(point[1] / this.cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = this.cells.get(cellKey(cx + dx, cy + dy));
        if (!bucket) continue;
        for (const s of bucket) if (visit(s.a, s.b, s.dir)) return true;
      }
    }
    return false;
  }
}

interface TaggedSegment {
  index: number;
  a: Point;
  b: Point;
}

// Segments tagged with their path, so a point can be tested against other paths.
export class TaggedSegmentIndex {
  readonly cell: number;
  private readonly buckets = new Map<number, TaggedSegment[]>();

  constructor(paths: readonly Path[], cell: number) {
    this.cell = Math.max(cell, MIN_CELL);
    paths.forEach((path, index) => this.addPath(index, path));
  }

  addPath(index: number, path: Path): void {
    const cell = this.cell;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const steps = Math.trunc(Math.hypot(b[0] - a[0], b[1] - a[1]) / cell) + 1;
      const seen = new Set<number>();
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        seen.add(
          cellKey(
            Math.floor((a[0] + (b[0] - a[0]) * t) / cell),
            Math.floor((a[1] + (b[1] - a[1]) * t) / cell),
          ),
        );
      }
      const item: TaggedSegment = { index, a, b };
      for (const key of seen) {
        const bucket = this.buckets.get(key);
        if (bucket) bucket.push(item);
        else this.buckets.set(key, [item]);
      }
    }
  }

  someNear(point: Point, visit: (index: number, a: Point, b: Point) => boolean): boolean {
    const cx = Math.floor(point[0] / this.cell);
    const cy = Math.floor(point[1] / this.cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = this.buckets.get(cellKey(cx + dx, cy + dy));
        if (!bucket) continue;
        for (const s of bucket) if (visit(s.index, s.a, s.b)) return true;
      }
    }
    return false;
  }
}

export class DisjointSet {
  private readonly parent: Int32Array;

  constructor(size: number) {
    this.parent = new Int32Array(size);
    for (let i = 0; i < size; i++) this.parent[i] = i;
  }

  root(index: number): number {
    const parent = this.parent;
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  }

  union(a: number, b: number): void {
    const ra = this.root(a);
    const rb = this.root(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}
