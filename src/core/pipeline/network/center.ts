// Moving a kept carriageway onto the middle of its street. Where one of a
// divided street's carriageways is dropped as doubled, the one kept runs off
// to one side of the street by half the median, and the printed road jogs
// sideways wherever the carriageways split and join again. The kept line
// moves halfway towards its dropped twin of the same class and subclass.
//
// The shift is worked out along whole streets: kept pieces of one class are
// chained where exactly two of their ends meet, so the single carriageway
// either side of a divided stretch is part of the same line. Along a chain
// the shift changes by at most a third of the distance travelled, and it's
// held at zero where three or more ends meet, so the road bends in gently and
// junctions stay where they were. A line never moves into the corridor of
// another it wasn't already doubling.

import { densifyLine } from '../../geometry/polygon';
import type { Vec2 } from '../../types';
import type { Twin } from './cull';
import { SegmentIndex } from './lines';
import type { Candidate, Part } from './routes';

// Carriageways often split at 30 to 50 degrees before running side by side,
// and centering only where they're parallel left the kept one's bend in. The
// shift is sideways only, so a steep bit of twin can't drag the line along.
const PARALLEL_DEG = 60;
const ALIGNED_DEG = 30;
const SPACING_MM = 0.25;
const TAPER_RATIO = 3;

export function centerOnTwins(parts: Part[], candidates: Candidate[], twins: Twin[], gap: number): number {
  if (!twins.length) return 0;
  const maxHalfWidth = candidates.reduce((m, c) => Math.max(m, c.halfWidth), 0);
  const index = new SegmentIndex(Math.max(gap + 2 * maxHalfWidth, 0.1));
  twins.forEach((twin, i) => index.add(twin.points, i));
  const parallel = Math.cos((PARALLEL_DEG * Math.PI) / 180);
  const aligned = Math.cos((ALIGNED_DEG * Math.PI) / 180);

  // Halfway across to the nearest twin beside this point, less as the two
  // part. Only sideways: near a bend the nearest point of the twin can lie
  // ahead, and moving towards it bunched the line up into a zigzag.
  const raw = ([x, y]: Vec2, ux: number, uy: number, c: Candidate): Vec2 => {
    let best = Infinity;
    let move: Vec2 = [0, 0];
    index.near(x, y, (s) => {
      const twin = twins[index.owner[s]];
      // A parking aisle isn't a service road's other carriageway, nor a ramp the motorway's.
      if (twin.roadClass !== c.piece.roadClass || twin.subclass !== c.piece.subclass) return;
      const t = index.along(s, x, y);
      if ((t <= 0 && index.first[s]) || (t >= 1 && index.last[s])) return;
      const d = index.distance(s, x, y, t);
      const corridor = gap + c.halfWidth + twin.halfWidth;
      const cos = Math.abs(ux * index.ux[s] + uy * index.uy[s]);
      if (d >= corridor || d >= best || cos < parallel) return;
      const [qx, qy] = index.closest(s, x, y);
      const w = Math.min(1, (cos - parallel) / (aligned - parallel));
      const across = ((qx - x) * -uy + (qy - y) * ux) * w * 0.5;
      best = d;
      move = [-uy * across, ux * across];
    });
    return move;
  };

  // Chains of kept pieces of one class and subclass, through points where exactly two ends meet.
  const eligible = parts.map((p) => !candidates[p.source].deck && !candidates[p.source].minor);
  const kind = (p: Part) => `${candidates[p.source].piece.roadClass}/${candidates[p.source].piece.subclass}`;
  const key = (p: Vec2) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
  const at = new Map<string, { part: number; tail: boolean }[]>();
  parts.forEach((p, i) => {
    if (!eligible[i]) return;
    for (const tail of [false, true]) {
      const k = `${kind(p)}|${key(tail ? p.points[p.points.length - 1] : p.points[0])}`;
      const list = at.get(k);
      if (list) list.push({ part: i, tail });
      else at.set(k, [{ part: i, tail }]);
    }
  });
  const endsAt = (i: number, tail: boolean) => {
    const p = parts[i];
    return at.get(`${kind(p)}|${key(tail ? p.points[p.points.length - 1] : p.points[0])}`)!;
  };
  // Every other kept line on the ground, so a shift never carries a line into
  // the corridor of one it didn't double already: stacked roads like upper
  // and lower Wacker each moved towards twins between them and met.
  const kept = new SegmentIndex(Math.max(gap + 2 * maxHalfWidth, 0.1));
  parts.forEach((p, i) => {
    if (!candidates[p.source].deck) kept.add(p.points, i);
  });
  const chainOf = new Int32Array(parts.length).fill(-1);
  const crowds = (from: Vec2, to: Vec2, ux: number, uy: number, c: Candidate, chain: number) =>
    kept.near(to[0], to[1], (s) => {
      const o = kept.owner[s];
      if (chainOf[o] === chain) return false;
      const other = candidates[parts[o].source];
      if (Math.abs(ux * kept.ux[s] + uy * kept.uy[s]) < parallel) return false;
      const corridor = gap + c.halfWidth + other.halfWidth;
      const after = kept.distance(s, to[0], to[1]);
      return after < corridor && after < kept.distance(s, from[0], from[1]);
    });

  const used = new Set<number>();
  let moved = 0;
  for (let start = 0; start < parts.length; start++) {
    if (!eligible[start] || used.has(start)) continue;
    used.add(start);
    const chain: { part: number; reversed: boolean }[] = [{ part: start, reversed: false }];
    const pinned = [false, false];
    for (const forwards of [true, false]) {
      for (;;) {
        const end = forwards ? chain[chain.length - 1] : chain[0];
        const tail = forwards !== end.reversed;
        const others = endsAt(end.part, tail).filter((e) => e.part !== end.part);
        if (others.length !== 1) {
          pinned[forwards ? 1 : 0] = others.length > 1;
          break;
        }
        const next = others[0];
        if (used.has(next.part)) break;
        used.add(next.part);
        // Leaving the shared point at its head means running with the chain.
        if (forwards) chain.push({ part: next.part, reversed: next.tail });
        else chain.unshift({ part: next.part, reversed: !next.tail });
      }
    }

    for (const { part } of chain) chainOf[part] = start;

    // One polyline for the chain, remembering where each part starts.
    const points: Vec2[] = [];
    const starts: number[] = [];
    for (const { part, reversed } of chain) {
      const own = densifyLine(parts[part].points, SPACING_MM);
      const run = reversed ? [...own].reverse() : own;
      starts.push(Math.max(0, points.length - 1));
      for (let k = points.length ? 1 : 0; k < run.length; k++) points.push(run[k]);
    }
    const c = candidates[parts[chain[0].part].source];
    const shifts = points.map((p, k): Vec2 => {
      const a = points[Math.max(0, k - 1)];
      const b = points[Math.min(points.length - 1, k + 1)];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const ux = (b[0] - a[0]) / length;
      const uy = (b[1] - a[1]) / length;
      const [dx, dy] = raw(p, ux, uy, c);
      for (let f = 1; f > 0; f -= 0.25) {
        if (!crowds(p, [p[0] + dx * f, p[1] + dy * f], ux, uy, c, start)) return [dx * f, dy * f];
      }
      return [0, 0];
    });
    if (shifts.every(([dx, dy]) => dx === 0 && dy === 0)) continue;
    const size = shifts.map(([dx, dy]) => Math.hypot(dx, dy));
    if (pinned[0]) size[0] = 0;
    if (pinned[1]) size[size.length - 1] = 0;
    for (let k = 1; k < size.length; k++) size[k] = Math.min(size[k], size[k - 1] + Math.hypot(points[k][0] - points[k - 1][0], points[k][1] - points[k - 1][1]) / TAPER_RATIO);
    for (let k = size.length - 2; k >= 0; k--) size[k] = Math.min(size[k], size[k + 1] + Math.hypot(points[k + 1][0] - points[k][0], points[k + 1][1] - points[k][1]) / TAPER_RATIO);
    const out = points.map((p, k): Vec2 => {
      const [dx, dy] = shifts[k];
      const length = Math.hypot(dx, dy);
      return length > 0 ? [p[0] + (dx * size[k]) / length, p[1] + (dy * size[k]) / length] : p;
    });
    chain.forEach(({ part, reversed }, n) => {
      const from = starts[n];
      const to = n + 1 < chain.length ? starts[n + 1] : out.length - 1;
      const run = out.slice(from, to + 1);
      parts[part].points = reversed ? run.reverse() : run;
    });
    moved += chain.length;
  }
  return moved;
}
