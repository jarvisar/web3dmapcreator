// Joins fragments that meet end to end. OSM splits a street wherever a tag
// changes and tiles split it again at every tile edge. Joined streets burn in one
// pass and stop looking like short stubs to the pruner.
//
// This has to run before culling. Whole-path culling only protects a road if the
// path is the whole road. Culled as fragments, a motorway can lose the one piece
// running beside its own off-ramp (links rank the same as their road) and end up
// with a hole in the middle.
import { type LineItem, type Path, type Point, nodeKey } from './geometry';

function turnAngle(dot: number): number {
  return Math.acos(dot < -1 ? -1 : dot > 1 ? 1 : dot);
}

// Direction of travel leaving the given end of the path.
export function endDirection(path: Path, tail: boolean): Point | null {
  let a: Point;
  let b: Point | undefined;
  if (tail) {
    a = path[path.length - 1];
    for (let i = path.length - 2; i >= 0; i--) {
      if (path[i][0] !== a[0] || path[i][1] !== a[1]) {
        b = path[i];
        break;
      }
    }
  } else {
    a = path[0];
    for (let i = 1; i < path.length; i++) {
      if (path[i][0] !== a[0] || path[i][1] !== a[1]) {
        b = path[i];
        break;
      }
    }
  }
  if (b === undefined) return null;
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const n = Math.hypot(dx, dy);
  return n <= 1e-18 ? null : [dx / n, dy / n];
}

export interface WeldOptions<K> {
  // Only items in the same group can weld.
  groupFn?: (key: K) => unknown;
  // Continue through a junction of three or more ends into the straightest arm
  // turning less than this many degrees. Without it junctions are left alone,
  // which is fine for OSM ways but joins almost nothing in data split at every
  // intersection.
  junctionTurnDeg?: number | null;
  junctionSameRank?: boolean;
  // The runner-up must turn at least this much more, or it counts as a fork.
  junctionMarginDeg?: number;
}

interface End {
  index: number;
  tail: boolean;
}

export function weldPaths<K>(
  items: readonly LineItem<K>[],
  tolerance: number,
  options: WeldOptions<K> = {},
): { items: LineItem<K>[]; joins: number } {
  if (tolerance <= 0 || items.length < 2) return { items: [...items], joins: 0 };

  const groupFn = options.groupFn ?? (() => null);
  const quantum = Math.max(tolerance, 1e-12);
  const cosLimit =
    options.junctionTurnDeg == null ? null : Math.cos((options.junctionTurnDeg * Math.PI) / 180);
  const sameRank = options.junctionSameRank ?? true;
  const margin = ((options.junctionMarginDeg ?? 10) * Math.PI) / 180;

  const buckets = new Map<unknown, LineItem<K>[]>();
  for (const item of items) {
    const group = groupFn(item.key);
    const bucket = buckets.get(group);
    if (bucket) bucket.push(item);
    else buckets.set(group, [item]);
  }

  const output: LineItem<K>[] = [];
  let joins = 0;

  for (const bucket of buckets.values()) {
    const paths = bucket.map((item) => item.path);
    const atNode = new Map<number, End[]>();
    const addEnd = (point: Point, end: End) => {
      const key = nodeKey(point, quantum);
      const list = atNode.get(key);
      if (list) list.push(end);
      else atNode.set(key, [end]);
    };
    paths.forEach((path, index) => {
      addEnd(path[0], { index, tail: false });
      addEnd(path[path.length - 1], { index, tail: true });
    });
    const used = new Uint8Array(paths.length);

    const straightest = (
      at: End[],
      incoming: Point | null,
      rank: number,
      exclude: number,
      allow: number | null,
    ): End | null => {
      if (cosLimit === null) return null;
      let best: End | null = null;
      let bestDot: number | null = null;
      let secondDot: number | null = null;
      for (const end of at) {
        if (end.index === exclude || (used[end.index] && end.index !== allow)) continue;
        if (sameRank && bucket[end.index].rank !== rank) continue;
        const out = endDirection(paths[end.index], end.tail);
        if (incoming === null || out === null) continue;
        // out points into the shared end, so going straight on is the exact opposite of incoming.
        const dot = -(incoming[0] * out[0] + incoming[1] * out[1]);
        if (dot < cosLimit) continue;
        if (bestDot === null || dot > bestDot) {
          secondDot = bestDot;
          best = end;
          bestDot = dot;
        } else if (secondDot === null || dot > secondDot) {
          secondDot = dot;
        }
      }
      if (best === null || bestDot === null) return null;
      // Two arms equally straight ahead is a fork, not a continuation.
      if (secondDot !== null && turnAngle(secondDot) - turnAngle(bestDot) < margin) return null;
      return best;
    };

    // Most points first. Array.sort is stable, like Python's sorted().
    const order = paths.map((_, index) => index).sort((p, q) => paths[q].length - paths[p].length);

    for (const start of order) {
      if (used[start]) continue;
      used[start] = 1;
      let chain: Path = [...paths[start]];
      let rank = bucket[start].rank;
      const key = bucket[start].key;
      // Which original path provides each end of the chain.
      const ends = { forwards: start, backwards: start };

      for (const forwards of [true, false]) {
        for (;;) {
          const endPoint = forwards ? chain[chain.length - 1] : chain[0];
          const at = atNode.get(nodeKey(endPoint, quantum)) ?? [];
          let next: End | null = null;
          if (at.length === 2) {
            for (const end of at) {
              if (!used[end.index]) {
                next = end;
                break;
              }
            }
          } else if (cosLimit !== null && at.length > 2) {
            const here = forwards ? ends.forwards : ends.backwards;
            const candidate = straightest(at, endDirection(chain, forwards), rank, here, null);
            if (candidate !== null) {
              // Only if the choice is mutual. Otherwise the junction has no single continuation.
              const mine = straightest(
                at,
                endDirection(paths[candidate.index], candidate.tail),
                bucket[candidate.index].rank,
                candidate.index,
                here,
              );
              if (mine !== null && mine.index === here) next = candidate;
            }
          }
          if (next === null) break;

          used[next.index] = 1;
          const piece = [...paths[next.index]];
          if (next.tail) piece.reverse();
          joins++;
          if (forwards) {
            for (let i = 1; i < piece.length; i++) chain.push(piece[i]);
            ends.forwards = next.index;
          } else {
            const prefix = piece.slice(1).reverse();
            chain = prefix.concat(chain);
            ends.backwards = next.index;
          }
          rank = Math.min(rank, bucket[next.index].rank);
        }
      }
      output.push({ rank, key, path: chain });
    }
  }
  return { items: output, joins };
}
