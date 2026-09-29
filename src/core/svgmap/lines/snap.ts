import {
  type LineItem,
  type Path,
  type Point,
  TaggedSegmentIndex,
  closestPointOnSegment,
  pathLength,
  pointSegmentDistanceSq,
} from './geometry';

// Pulls a loose end onto the line it nearly meets. Map data is full of ways that
// stop just short of the road they join, and once duplicates are gone those gaps
// show. Nothing moves further than snapTolerance, and ends on the crop edge stay.
export function snapDanglingEnds<K>(
  items: readonly LineItem<K>[],
  snapTolerance: number,
  touchTolerance: number,
  onBoundary?: (point: Point) => boolean,
): { items: LineItem<K>[]; snapped: number } {
  if (snapTolerance <= 0 || items.length < 2) return { items: [...items], snapped: 0 };

  const index = new TaggedSegmentIndex(
    items.map((item) => item.path),
    Math.max(snapTolerance * 2, 1e-9),
  );
  const snapSq = snapTolerance * snapTolerance;
  const touchSq = touchTolerance * touchTolerance;
  const output: LineItem<K>[] = [];
  let snapped = 0;

  items.forEach((item, self) => {
    const path: Path = [...item.path];
    // Snapping a path this short would collapse it to nothing. Stub pruning handles it.
    if (pathLength(path) <= snapTolerance) {
      output.push({ rank: item.rank, key: item.key, path });
      return;
    }
    for (const end of [0, path.length - 1]) {
      const point = path[end];
      if (onBoundary && onBoundary(point)) continue;
      let best: [Point, Point] | null = null;
      let bestDistance = Infinity;
      const touching = index.someNear(point, (other, a, b) => {
        if (other === self) return false;
        const distance = pointSegmentDistanceSq(point, a, b);
        if (distance <= touchSq) return true;
        if (distance <= snapSq && distance < bestDistance) {
          bestDistance = distance;
          best = [a, b];
        }
        return false;
      });
      if (touching || best === null) continue;
      const [a, b] = best as [Point, Point];
      const target = closestPointOnSegment(point, a, b);
      const neighbour = end === 0 ? path[1] : path[path.length - 2];
      // Never collapse the segment being moved.
      if (Math.hypot(target[0] - neighbour[0], target[1] - neighbour[1]) <= touchTolerance) continue;
      path[end] = target;
      snapped++;
    }
    output.push({ rank: item.rank, key: item.key, path });
  });
  return { items: output, snapped };
}
