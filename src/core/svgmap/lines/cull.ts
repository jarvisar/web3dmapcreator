// Drops lines that run close to and roughly parallel with a line already kept.
// Two lines closer than the beam or pen width burn as one dark band. Close alone
// is not enough: a footpath running into a road is perpendicular where they
// meet, so it stays connected.
import {
  type LineItem,
  type Path,
  type Point,
  SegmentGrid,
  pathLength,
  pointSegmentDistanceSq,
  samplePoints,
  unit,
} from './geometry';

function shadowed(
  a: Point,
  b: Point,
  dir: Point,
  grid: SegmentGrid,
  thresholdSq: number,
  cosLimit: number,
  spacing: number,
): { hits: number; samples: number } {
  const samples = samplePoints(a, b, spacing);
  let hits = 0;
  for (const point of samples) {
    const hit = grid.someNear(point, (oa, ob, other) => {
      if (pointSegmentDistanceSq(point, oa, ob) > thresholdSq) return false;
      return Math.abs(dir[0] * other[0] + dir[1] * other[1]) >= cosLimit;
    });
    if (hit) hits++;
  }
  return { hits, samples: samples.length };
}

// 60% of the samples, so a segment that only touches a road survives.
function mostlyShadowed(hits: number, samples: number): boolean {
  return hits * 5 >= samples * 3;
}

export interface CullRankedOptions<K> {
  maxAngleDeg?: number;
  // Keep or drop each path whole. Can depend on the item's key.
  wholePaths?: boolean | ((key: K) => boolean);
  shadowFraction?: number;
}

export interface CullStats {
  dropped: number;
  trimmed: number;
  removedLength: number;
}

function samePath(a: Path, b: Path): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  }
  return true;
}

// Paths enter the index most important first, then longest first, and are only
// tested against what is already in it. So a line can only be removed by one at
// least as important, and a motorway never loses to a service road beside it.
//
// With wholePaths a path is kept or dropped entire, which stops culling from
// breaking a road in the middle. That only works if the paths were welded first.
export function cullRanked<K>(
  items: readonly LineItem<K>[],
  minSeparation: number,
  options: CullRankedOptions<K> = {},
): { kept: LineItem<K>[]; stats: CullStats } {
  const maxAngleDeg = options.maxAngleDeg ?? 30;
  const wholePaths = options.wholePaths ?? true;
  const shadowFraction = options.shadowFraction ?? 0.7;

  const lengths = new Map<LineItem<K>, number>();
  for (const item of items) lengths.set(item, pathLength(item.path));
  const ordered = [...items].sort(
    (p, q) => p.rank - q.rank || (lengths.get(q) ?? 0) - (lengths.get(p) ?? 0),
  );

  const grid = new SegmentGrid([], Math.max(minSeparation, 1e-9));
  const thresholdSq = minSeparation * minSeparation;
  const cosLimit = Math.cos((maxAngleDeg * Math.PI) / 180);
  const kept: LineItem<K>[] = [];
  const stats: CullStats = { dropped: 0, trimmed: 0, removedLength: 0 };

  for (const item of ordered) {
    const { path } = item;
    if (minSeparation <= 0 || grid.empty) {
      kept.push(item);
      grid.add(path);
      continue;
    }

    let shadowedLength = 0;
    let totalLength = 0;
    const flags: boolean[] = [];
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const dir = unit(a, b);
      if (dir === null) {
        flags.push(false);
        continue;
      }
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const { hits, samples } = shadowed(a, b, dir, grid, thresholdSq, cosLimit, minSeparation);
      const isShadowed = mostlyShadowed(hits, samples);
      flags.push(isShadowed);
      totalLength += length;
      if (isShadowed) shadowedLength += length;
    }
    if (totalLength <= 0) continue;

    const keepWhole = typeof wholePaths === 'function' ? wholePaths(item.key) : wholePaths;
    if (keepWhole) {
      if (shadowedLength / totalLength >= shadowFraction) {
        stats.dropped++;
        stats.removedLength += totalLength;
      } else {
        kept.push(item);
        grid.add(path);
      }
      continue;
    }

    const pieces: Path[] = [];
    let run: Path = [];
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      if (flags[i - 1]) {
        if (run.length >= 2) pieces.push(run);
        run = [];
        stats.removedLength += Math.hypot(b[0] - a[0], b[1] - a[1]);
        continue;
      }
      if (run.length === 0) run = [a, b];
      else run.push(b);
    }
    if (run.length >= 2) pieces.push(run);

    if (pieces.length !== 1 || !samePath(pieces[0], path)) stats.trimmed++;
    for (const piece of pieces) {
      kept.push({ rank: item.rank, key: item.key, path: piece });
      grid.add(piece);
    }
  }
  return { kept, stats };
}
