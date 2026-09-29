import { type Path, SegmentGrid, pointSegmentDistanceSq } from './geometry';

// Share of the original linework that still has a kept line within tolerance.
// Removing a doubled carriageway keeps this high. Removing a street lowers it.
export function lineCoverage(original: readonly Path[], final: readonly Path[], tolerance: number): number {
  if (final.length === 0) return 0;
  const grid = new SegmentGrid(final, tolerance);
  const toleranceSq = tolerance * tolerance;
  let covered = 0;
  let total = 0;
  for (const path of original) {
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      total += length;
      const mid: [number, number] = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
      if (grid.someNear(mid, (x, y) => pointSegmentDistanceSq(mid, x, y) <= toleranceSq)) covered += length;
    }
  }
  return total > 0 ? covered / total : 0;
}
