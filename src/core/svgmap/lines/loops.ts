import { type LineItem, type Path, type Point, cellKey, pathLength, pointSegmentDistanceSq } from './geometry';

interface Collapse {
  centre: Point;
  reach: number;
  ring: Path;
}

// A turning circle smaller than the beam burns as a solid dot. Culling can't
// catch it because a ring is only close to itself, and deleting it would leave
// every road that met it a diameter short. So the ring shrinks to its centre and
// everything touching it (including loose ends inside it) moves with it.
//
// Only closed paths qualify. A crossroads is a cycle in the network but not a
// closed path, and contracting network cycles was tried in the original
// pipeline and pulled whole road bundles into starbursts.
export function collapseFilledLoops<K>(
  items: readonly LineItem<K>[],
  minOpenRadius: number,
  touchTolerance: number,
): { items: LineItem<K>[]; collapsed: number } {
  if (items.length === 0 || minOpenRadius <= 0) return { items: [...items], collapsed: 0 };

  const collapses: Collapse[] = [];
  const doomed = new Set<number>();
  items.forEach((item, index) => {
    const path = item.path;
    if (path.length < 4) return;
    const first = path[0];
    const last = path[path.length - 1];
    if (Math.hypot(last[0] - first[0], last[1] - first[1]) > touchTolerance) return;
    let twiceArea = 0;
    for (let i = 1; i < path.length; i++) {
      twiceArea += path[i - 1][0] * path[i][1] - path[i][0] * path[i - 1][1];
    }
    const area = Math.abs(twiceArea) * 0.5;
    const perimeter = pathLength(path);
    if (perimeter <= 1e-9) return;
    // Radius of the largest disc of untouched wood the ring can hold.
    if ((2 * area) / perimeter >= minOpenRadius) return;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < path.length - 1; i++) {
      cx += path[i][0];
      cy += path[i][1];
    }
    cx /= path.length - 1;
    cy /= path.length - 1;
    let reach = 0;
    for (const p of path) reach = Math.max(reach, Math.hypot(p[0] - cx, p[1] - cy));
    collapses.push({ centre: [cx, cy], reach: reach + touchTolerance, ring: path });
    doomed.add(index);
  });
  if (collapses.length === 0) return { items: [...items], collapsed: 0 };

  collapses.sort((p, q) => p.centre[0] - q.centre[0] || p.centre[1] - q.centre[1]);

  const cell = Math.max(Math.max(...collapses.map((c) => c.reach)), 1e-9);
  const lookup = new Map<number, Collapse[]>();
  for (const entry of collapses) {
    const ix = Math.floor(entry.centre[0] / cell);
    const iy = Math.floor(entry.centre[1] / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = cellKey(ix + dx, iy + dy);
        const list = lookup.get(key);
        if (list) list.push(entry);
        else lookup.set(key, [entry]);
      }
    }
  }

  const touchSq = touchTolerance * touchTolerance;
  const moved = (point: Point, isEnd: boolean): Point => {
    const candidates = lookup.get(cellKey(Math.floor(point[0] / cell), Math.floor(point[1] / cell)));
    if (!candidates) return point;
    for (const { centre, reach, ring } of candidates) {
      if (Math.hypot(point[0] - centre[0], point[1] - centre[1]) > reach) continue;
      // Loose ends inside the ring come too, or a footway stopping just short
      // of the circle would be left with a gap.
      if (isEnd) return centre;
      for (let i = 1; i < ring.length; i++) {
        if (pointSegmentDistanceSq(point, ring[i - 1], ring[i]) <= touchSq) return centre;
      }
    }
    return point;
  };

  const kept: LineItem<K>[] = [];
  items.forEach((item, index) => {
    if (doomed.has(index)) return;
    const path = item.path;
    const rebuilt: Path = [];
    path.forEach((point, position) => {
      const next = moved(point, position === 0 || position === path.length - 1);
      const prev = rebuilt[rebuilt.length - 1];
      if (!prev || prev[0] !== next[0] || prev[1] !== next[1]) rebuilt.push(next);
    });
    if (rebuilt.length >= 2) kept.push({ rank: item.rank, key: item.key, path: rebuilt });
  });
  return { items: kept, collapsed: collapses.length };
}
