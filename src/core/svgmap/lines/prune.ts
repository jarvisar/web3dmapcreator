import {
  DisjointSet,
  type LineItem,
  type Point,
  TaggedSegmentIndex,
  pathLength,
  pointSegmentDistanceSq,
} from './geometry';

// Removes short pieces that lead nowhere, like the stub of a footway whose
// sidewalk was culled. An end counts as connected when any other path passes
// within tolerance of it, not only another path's end. After welding, a side
// street usually meets the middle of a long road.
//
// Ends on the crop edge (onBoundary) continue off the map and are never loose.
// Removing one stub can expose the next, which a work queue handles without
// rescanning everything.
export function pruneDanglingStubs<K>(
  items: readonly LineItem<K>[],
  maxStubLength: number | ((key: K) => number),
  weldTolerance: number,
  onBoundary?: (point: Point) => boolean,
): { items: LineItem<K>[]; removed: number } {
  if (items.length === 0) return { items: [], removed: 0 };
  if (typeof maxStubLength !== 'function' && maxStubLength <= 0) {
    return { items: [...items], removed: 0 };
  }

  const tolerance = Math.max(weldTolerance, 1e-12);
  const toleranceSq = tolerance * tolerance;
  const alive = [...items];
  const lengths = alive.map((item) => pathLength(item.path));
  const limits = alive.map((item) =>
    Math.max(0, typeof maxStubLength === 'function' ? maxStubLength(item.key) : maxStubLength),
  );
  const anchored = alive.map((item) => [
    Boolean(onBoundary && onBoundary(item.path[0])),
    Boolean(onBoundary && onBoundary(item.path[item.path.length - 1])),
  ]);

  const index = new TaggedSegmentIndex(
    alive.map((item) => item.path),
    Math.max(tolerance * 4, 1e-9),
  );

  const supporters = (self: number, point: Point): Set<number> => {
    const found = new Set<number>();
    index.someNear(point, (other, a, b) => {
      if (other !== self && pointSegmentDistanceSq(point, a, b) <= toleranceSq) found.add(other);
      return false;
    });
    return found;
  };

  const support = alive.map((item, i) => [
    supporters(i, item.path[0]),
    supporters(i, item.path[item.path.length - 1]),
  ]);

  // Who leans on whom, so a removal only rechecks its neighbours.
  const dependents = new Map<number, Set<number>>();
  support.forEach(([first, last], i) => {
    for (const other of [...first, ...last]) {
      const set = dependents.get(other);
      if (set) set.add(i);
      else dependents.set(other, new Set([i]));
    }
  });

  const removedFlags = new Uint8Array(alive.length);
  const hasLiveSupport = (set: Set<number>) => {
    for (const other of set) if (!removedFlags[other]) return true;
    return false;
  };
  const isStub = (i: number): boolean => {
    if (removedFlags[i] || limits[i] <= 0 || lengths[i] >= limits[i]) return false;
    const freeFirst = !hasLiveSupport(support[i][0]);
    const freeLast = !hasLiveSupport(support[i][1]);
    return (freeFirst && !anchored[i][0]) || (freeLast && !anchored[i][1]);
  };

  const queue: number[] = [];
  for (let i = 0; i < alive.length; i++) if (isStub(i)) queue.push(i);
  let removed = 0;
  while (queue.length > 0) {
    const i = queue.pop()!;
    if (!isStub(i)) continue;
    removedFlags[i] = 1;
    removed++;
    for (const other of dependents.get(i) ?? []) {
      if (!removedFlags[other] && isStub(other)) queue.push(other);
    }
  }
  return { items: alive.filter((_, i) => !removedFlags[i]), removed };
}

// Removes small, dense mazes of footpaths. They have no loose ends and nothing
// parallel to them, so neither culling nor stub pruning catches them. Only
// components that are both small and line-dense go. A simple loop stays under
// the length/span ratio.
export function pruneCompactTangles<K>(
  items: readonly LineItem<K>[],
  maxSpan: number,
  minSegments: number,
  minLengthToSpan: number,
  touchTolerance: number,
  targetFn?: (key: K) => boolean,
): { items: LineItem<K>[]; removed: number } {
  if (items.length === 0 || maxSpan <= 0 || minSegments <= 0 || minLengthToSpan <= 0) {
    return { items: [...items], removed: 0 };
  }

  const candidateIndices: number[] = [];
  items.forEach((item, i) => {
    if (targetFn && !targetFn(item.key)) return;
    if (item.path.length < 2) return;
    if (spanOf([item.path]) <= maxSpan) candidateIndices.push(i);
  });
  if (candidateIndices.length === 0) return { items: [...items], removed: 0 };

  const candidates = candidateIndices.map((i) => items[i]);
  const tolerance = Math.max(touchTolerance, 1e-12);
  const toleranceSq = tolerance * tolerance;
  const index = new TaggedSegmentIndex(
    candidates.map((item) => item.path),
    Math.max(tolerance * 4, 1e-9),
  );
  const sets = new DisjointSet(candidates.length);
  candidates.forEach((item, i) => {
    for (const point of [item.path[0], item.path[item.path.length - 1]]) {
      index.someNear(point, (other, a, b) => {
        if (other !== i && pointSegmentDistanceSq(point, a, b) <= toleranceSq) sets.union(i, other);
        return false;
      });
    }
  });

  const components = new Map<number, number[]>();
  candidates.forEach((_, i) => {
    const root = sets.root(i);
    const list = components.get(root);
    if (list) list.push(i);
    else components.set(root, [i]);
  });

  const removedGlobal = new Set<number>();
  for (const component of components.values()) {
    const paths = component.map((i) => candidates[i].path);
    const span = spanOf(paths);
    let segments = 0;
    let total = 0;
    for (const path of paths) {
      segments += Math.max(0, path.length - 1);
      total += pathLength(path);
    }
    if (span <= maxSpan && segments >= minSegments && total >= minLengthToSpan * Math.max(span, 1e-12)) {
      for (const i of component) removedGlobal.add(candidateIndices[i]);
    }
  }
  return {
    items: items.filter((_, i) => !removedGlobal.has(i)),
    removed: removedGlobal.size,
  };
}

function spanOf(paths: readonly Point[][]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const path of paths) {
    for (const [x, y] of path) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return Math.hypot(maxX - minX, maxY - minY);
}
