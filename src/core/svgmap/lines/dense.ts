import {
  type LineItem,
  type Path,
  type Point,
  TaggedSegmentIndex,
  cellKey,
  interiorSamples,
  nodeKey,
  pathLength,
  samplePoints,
  unit,
} from './geometry';

export interface DenseOptions<K> {
  maxAngleDeg?: number;
  // Share of a path that must lie in over-limit cells before it is considered.
  hotFraction?: number;
  // Share of it a surviving line must run along before it counts as doubled.
  shadowFraction?: number;
  // Nothing ranked this important or better is removed for density.
  protectRank?: number;
  // Mesh links shorter than this can go if their ends stay joined without them. 0 turns it off.
  meshMaxLength?: number;
  meshDetour?: number;
  weldTolerance?: number;
  // Ground already burnt solid by a fill. The limit there is scaled by coveredLimitScale.
  coveredFn?: ((point: Point) => boolean) | null;
  coveredLimitScale?: number;
  targetFn?: (key: K) => boolean;
}

export interface DenseStats {
  dropped: number;
  removedLength: number;
  hotCells: number;
  considered: number;
  meshDropped: number;
}

// Beside the segment, not past its ends. A short link's neighbours touch it end
// to end, and measuring to their ends would call every mesh link doubled by the
// paths it connects.
function alongside(point: Point, a: Point, b: Point, thresholdSq: number): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 1e-18) return false;
  const t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSq;
  if (t <= 0 || t >= 1) return false;
  const ex = point[0] - (a[0] + t * dx);
  const ey = point[1] - (a[1] + t * dy);
  return ex * ex + ey * ey <= thresholdSq;
}

// Culling compares lines in pairs, so it misses a dozen individually fine lines
// piled into one square millimetre, which burns as a black knot. Raising the line
// spacing everywhere would catch it but removes real streets across the whole
// map. This measures density directly (mm of line per mm^2 over a window) and
// only acts inside cells over the limit.
//
// Being in a dense cell only makes a path a candidate. It is removed if it is
// doubled by a surviving line, or if it is a short mesh link whose ends still
// reach each other without it. Candidates go least important first and the
// density is updated after each removal, so a patch is thinned, not emptied.
//
// protectRank keeps streets safe: a street with a cycle track along it looks
// doubled end to end. Ground already under a fill gets a lower limit instead of
// counting as dense outright, so a footway crossing a building still stays.
export function relieveDenseClusters<K>(
  items: readonly LineItem<K>[],
  densityLimit: number,
  window: number,
  separation: number,
  options: DenseOptions<K> = {},
): { items: LineItem<K>[]; stats: DenseStats } {
  const stats: DenseStats = { dropped: 0, removedLength: 0, hotCells: 0, considered: 0, meshDropped: 0 };
  if (items.length === 0 || densityLimit <= 0 || window <= 0 || separation <= 0) {
    return { items: [...items], stats };
  }
  const maxAngleDeg = options.maxAngleDeg ?? 30;
  const hotFraction = options.hotFraction ?? 0.6;
  const shadowFraction = options.shadowFraction ?? 0.8;
  const protectRank = options.protectRank ?? -1;
  const meshMaxLength = options.meshMaxLength ?? 0;
  const meshDetour = options.meshDetour ?? 4;
  const weldTolerance = options.weldTolerance ?? 0.03;
  const coveredFn = options.coveredFn ?? null;
  const coveredLimitScale = options.coveredLimitScale ?? 1;
  const targetFn = options.targetFn;

  const cell = window / 3;
  const step = cell * 0.5;
  const load = new Map<number, number>();
  // Packed keys can't be unpacked, so keep each cell's coordinates.
  const cellCoords = new Map<number, [number, number]>();

  const deposit = (path: Path, sign: number) => {
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length <= 1e-12) continue;
      const count = Math.trunc(length / step) + 1;
      const share = (sign * length) / count;
      for (let s = 0; s < count; s++) {
        const t = (s + 0.5) / count;
        const cx = Math.floor((a[0] + (b[0] - a[0]) * t) / cell);
        const cy = Math.floor((a[1] + (b[1] - a[1]) * t) / cell);
        const key = cellKey(cx, cy);
        const previous = load.get(key);
        if (previous === undefined) cellCoords.set(key, [cx, cy]);
        load.set(key, (previous ?? 0) + share);
      }
    }
  };
  for (const item of items) deposit(item.path, 1);

  // Density is read over the 3x3 block around a cell, so window is the patch size.
  const blockArea = (3 * cell) ** 2;
  const coveredLimit = densityLimit * coveredLimitScale;
  const densityAt = (cx: number, cy: number) => {
    let total = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) total += load.get(cellKey(cx + dx, cy + dy)) ?? 0;
    }
    return total / blockArea;
  };
  const isHot = (point: Point) => {
    const limit = coveredFn !== null && coveredFn(point) ? coveredLimit : densityLimit;
    return densityAt(Math.floor(point[0] / cell), Math.floor(point[1] / cell)) > limit;
  };

  for (const [cx, cy] of cellCoords.values()) {
    if (isHot([(cx + 0.5) * cell, (cy + 0.5) * cell])) stats.hotCells++;
  }

  const index = new TaggedSegmentIndex(
    items.map((item) => item.path),
    Math.max(separation, 1e-9),
  );
  const thresholdSq = separation * separation;
  const cosLimit = Math.cos((maxAngleDeg * Math.PI) / 180);
  const removed = new Set<number>();

  const shadowedFraction = (self: number, path: Path): number => {
    let hit = 0;
    let total = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const dir = unit(a, b);
      if (dir === null) continue;
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      total += length;
      for (const point of interiorSamples(a, b, separation)) {
        const found = index.someNear(point, (other, oa, ob) => {
          if (other === self || removed.has(other)) return false;
          if (!alongside(point, oa, ob, thresholdSq)) return false;
          const otherDir = unit(oa, ob);
          if (otherDir === null) return false;
          return Math.abs(dir[0] * otherDir[0] + dir[1] * otherDir[1]) >= cosLimit;
        });
        if (found) {
          hit += length;
          break;
        }
      }
    }
    return total > 0 ? hit / total : 0;
  };

  // Graph for the mesh test. Every vertex is a node, not just path ends, because
  // most links in a mesh meet the middle of another link.
  const quantum = Math.max(weldTolerance, 1e-12);
  const adjacency = new Map<number, { node: number; edge: number; length: number }[]>();
  const endpoints: { start: number; goal: number; length: number }[] = [];
  if (meshMaxLength > 0) {
    items.forEach((item, edgeIndex) => {
      const path = item.path;
      const nodes = path.map((p) => nodeKey(p, quantum));
      for (let i = 1; i < path.length; i++) {
        const u = nodes[i - 1];
        const v = nodes[i];
        if (u === v) continue;
        const length = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
        const listU = adjacency.get(u);
        if (listU) listU.push({ node: v, edge: edgeIndex, length });
        else adjacency.set(u, [{ node: v, edge: edgeIndex, length }]);
        const listV = adjacency.get(v);
        if (listV) listV.push({ node: u, edge: edgeIndex, length });
        else adjacency.set(v, [{ node: u, edge: edgeIndex, length }]);
      }
      endpoints[edgeIndex] = { start: nodes[0], goal: nodes[nodes.length - 1], length: pathLength(path) };
    });
  }

  const stillConnected = (self: number): boolean => {
    const ends = endpoints[self];
    if (!ends || ends.start === ends.goal) return false;
    const budget = ends.length * meshDetour;
    const best = new Map<number, number>([[ends.start, 0]]);
    const stack: [number, number][] = [[ends.start, 0]];
    while (stack.length > 0) {
      const [node, cost] = stack.pop()!;
      if (cost > (best.get(node) ?? cost)) continue;
      for (const { node: other, edge, length } of adjacency.get(node) ?? []) {
        if (edge === self || removed.has(edge)) continue;
        const reached = cost + length;
        if (reached > budget || reached >= (best.get(other) ?? budget + 1)) continue;
        if (other === ends.goal) return true;
        best.set(other, reached);
        stack.push([other, reached]);
      }
    }
    return false;
  };

  // Least important, then shortest, then by position, so input order doesn't matter.
  const lengths = items.map((item) => pathLength(item.path));
  const order = items
    .map((_, i) => i)
    .sort((p, q) => {
      const a = items[p];
      const b = items[q];
      return (
        b.rank - a.rank ||
        lengths[p] - lengths[q] ||
        a.path[0][0] - b.path[0][0] ||
        a.path[0][1] - b.path[0][1]
      );
    });

  for (const i of order) {
    const item = items[i];
    if (item.rank <= protectRank) continue;
    if (targetFn && !targetFn(item.key)) continue;
    const path = item.path;
    if (path.length < 2) continue;

    let hot = 0;
    let sampleCount = 0;
    for (let s = 1; s < path.length; s++) {
      for (const point of samplePoints(path[s - 1], path[s], step)) {
        sampleCount++;
        if (isHot(point)) hot++;
      }
    }
    if (sampleCount === 0 || hot < hotFraction * sampleCount) continue;

    stats.considered++;
    let mesh = false;
    if (shadowedFraction(i, path) < shadowFraction) {
      if (meshMaxLength <= 0 || lengths[i] > meshMaxLength || !stillConnected(i)) continue;
      mesh = true;
    }
    removed.add(i);
    if (mesh) stats.meshDropped++;
    deposit(path, -1);
    stats.dropped++;
    stats.removedLength += lengths[i];
  }
  return { items: items.filter((_, i) => !removed.has(i)), stats };
}
