// Dropping lines that run alongside a more important line closer than a
// printable gap: the footway that is a sidewalk in all but tag, the cycle
// track beside the road, the tram in the street, the service road along an
// arterial.
//
// Routes go in order of importance, longest first within a rank, and each is
// judged against what's already kept. A line only loses to one strictly more
// important. Lines of one rank side by side (both carriageways of a divided
// street, the tracks of a rail yard, the aisles of a car park) stay, apart
// from what divided.ts merges: thinning them to every other line broke them
// into ladders, and yards read fine as they are. "Close" is edge to edge: two ribbons nearer than the gap
// leave a strip of ground too thin to print between them.

import { densifyLine } from '../../geometry/polygon';
import { intervals, pointAt, SegmentIndex, slice, cumulative } from './lines';
import type { Candidate, EndOrigin, Part, Route } from './routes';

export interface CullOptions {
  gap: number;
  stub: number;
}

export interface CullResult {
  parts: Part[];
  droppedRoutes: number;
  hiddenParts: number;
}

const PARALLEL_DEG = 28;
// A street is dropped (all but the stretches nothing doubles) when this much
// of it is doubled. Below that it stays whole, so a street never loses a
// bite from its middle for running beside a main road for a block.
const SHADOW_FRACTION = 0.68;
const STEP = 0.2;
// How far a losing street's surviving stretch may follow its own line back
// to reach the road that doubled it, in corridor widths.
const FOLLOW_CORRIDORS = 4;
const EPSILON = 1e-7;

export function cull(candidates: Candidate[], routes: Route[], origins: [EndOrigin, EndOrigin][], options: CullOptions): CullResult {
  const { gap, stub } = options;
  const maxHalfWidth = candidates.reduce((m, c) => Math.max(m, c.halfWidth), 0);
  const corridor = gap + 2 * maxHalfWidth;
  const cos = Math.cos((PARALLEL_DEG * Math.PI) / 180);
  const kept = new SegmentIndex(Math.max(corridor, 0.1));
  const keptHalfWidth: number[] = [];
  const keptRank: number[] = [];
  const keptDeck: boolean[] = [];
  const keptRoute: number[] = [];
  const pieceCum = candidates.map((c) => cumulative(c.points));
  const parts: Part[] = [];

  // Decks only ever double decks, and a twin deck goes whole, so of two
  // bridge carriageways one is kept.
  const beats = (o: number, deck: boolean, rank: number) => keptDeck[o] === deck && (deck ? keptRank[o] <= rank : keptRank[o] < rank);

  // Beside a kept line, not past its end: the stem of a divided street through
  // an intersection starts where the kept carriageway stops, and measured to
  // its end it would read as doubled by the line it continues.
  const alongside = (x: number, y: number, ux: number, uy: number, halfWidth: number, deck: boolean, rank: number) =>
    kept.near(x, y, (s) => {
      const o = kept.owner[s];
      if (!beats(o, deck, rank)) return false;
      const t = kept.along(s, x, y);
      if ((t <= 0 && kept.first[s]) || (t >= 1 && kept.last[s])) return false;
      if (kept.distance(s, x, y, t) > gap + halfWidth + keptHalfWidth[o]) return false;
      return Math.abs(ux * kept.ux[s] + uy * kept.uy[s]) >= cos && kept.beside(s, x, y, ux, uy);
    });

  // Inside the ribbon of a line that beats this one.
  const covered = (x: number, y: number, deck: boolean, rank: number, self = -1) =>
    kept.near(x, y, (s) => {
      const o = kept.owner[s];
      return beats(o, deck, rank) && keptRoute[o] !== self && kept.distance(s, x, y) <= keptHalfWidth[o];
    });

  const clear = (x: number, y: number, halfWidth: number, deck: boolean, rank: number, self: number) =>
    !kept.near(x, y, (s) => {
      const o = kept.owner[s];
      return beats(o, deck, rank) && keptRoute[o] !== self && kept.distance(s, x, y) <= gap + halfWidth + keptHalfWidth[o];
    });

  const sample = (route: Route) => {
    const count = Math.max(1, Math.ceil(route.length / STEP));
    const samples = intervals(route.points, route.cum, count);
    const halfWidths: number[] = [];
    let m = 0;
    for (let k = 0; k < count; k++) {
      const s = ((k + 0.5) * route.length) / count;
      while (m < route.members.length - 1 && route.members[m].to < s) m++;
      halfWidths.push(candidates[route.members[m].source].halfWidth);
    }
    return { step: route.length / count, samples, halfWidths };
  };

  /** Keep the stretch [a, b] of a route as parts of its pieces. */
  const keep = (id: number, route: Route, a: number, b: number) => {
    for (const member of route.members) {
      const x = Math.max(a, member.from);
      const y = Math.min(b, member.to);
      if (y - x <= EPSILON) continue;
      const c = candidates[member.source];
      const cum = pieceCum[member.source];
      const length = cum[cum.length - 1];
      const scale = length / (member.to - member.from || 1);
      const local = (s: number) => (member.reversed ? length - (s - member.from) * scale : (s - member.from) * scale);
      const l0 = Math.max(0, Math.min(local(x), local(y)));
      const l1 = Math.min(length, Math.max(local(x), local(y)));
      if (l1 - l0 <= EPSILON) continue;
      const points = slice(c.points, cum, l0, l1);
      if (points.length < 2) continue;
      const origin = origins[member.source];
      const ends: [EndOrigin, EndOrigin] = [l0 <= EPSILON ? origin[0] : 'met', l1 >= length - EPSILON ? origin[1] : 'met'];
      // Which of the part's ends are ends of the kept stretch, not joints inside it.
      const atStart = x <= a + EPSILON;
      const atEnd = y >= b - EPSILON;
      const [head, tail] = member.reversed ? [atEnd, atStart] : [atStart, atEnd];
      parts.push({ source: member.source, points, ends });
      keptHalfWidth.push(c.halfWidth);
      keptRank.push(c.rank);
      keptDeck.push(c.deck);
      keptRoute.push(id);
      kept.add(points, keptHalfWidth.length - 1, [head, tail]);
    }
  };

  // Cuts land on the sample grid. One that close to a corner moves to it, or
  // it leaves a scrap of the doubled stretch pointing along the road.
  const snap = (route: Route, s: number) => {
    let best = s;
    for (const a of route.cum) if (Math.abs(a - s) <= STEP && Math.abs(a - s) < Math.abs(best - s) + (best === s ? STEP : 0)) best = a;
    return best;
  };

  const keepAllBut = (id: number, route: Route, cuts: [number, number][]) => {
    let from = 0;
    for (const [a, b] of cuts) {
      const cutFrom = a > EPSILON ? snap(route, a) : a;
      if (cutFrom - from > EPSILON) keep(id, route, from, cutFrom);
      from = b < route.length - EPSILON ? snap(route, b) : b;
    }
    if (route.length - from > EPSILON) keep(id, route, from, route.length);
  };

  // Runs of equal flags as index ranges [k0, k1).
  const runs = (flags: boolean[], value: boolean): [number, number][] => {
    const out: [number, number][] = [];
    let start = -1;
    for (let k = 0; k <= flags.length; k++) {
      const on = k < flags.length && flags[k] === value;
      if (on && start < 0) start = k;
      else if (!on && start >= 0) {
        out.push([start, k]);
        start = -1;
      }
    }
    return out;
  };

  // A losing street's surviving stretch, cut at `s`, runs on along its own
  // line until it's inside the ribbon that beat it, so it still meets that
  // road. Nothing is drawn that wasn't mapped: when the ribbon is out of
  // reach the stretch stops where it was cut.
  const follow = (id: number, route: Route, s: number, direction: 1 | -1, halfWidth: number): number => {
    const step = Math.max(Math.min(halfWidth, STEP), 0.02);
    for (let travelled = step; travelled <= FOLLOW_CORRIDORS * corridor; travelled += step) {
      const at = s + direction * travelled;
      if (at < 0 || at > route.length) break;
      const [x, y] = pointAt(route.points, route.cum, at);
      if (covered(x, y, route.deck, route.rank, id)) return at;
    }
    return s;
  };

  const order = [...routes].sort((p, q) => p.rank - q.rank || q.length - p.length || p.order - q.order);
  const losing: number[] = [];
  let droppedRoutes = 0;
  for (let id = 0; id < order.length; id++) {
    const route = order[id];
    const { step, samples, halfWidths } = sample(route);
    const flags = samples.map((p, k) => alongside(p.x, p.y, p.ux, p.uy, halfWidths[k], route.deck, route.rank));
    const shadowed = flags.filter(Boolean).length * step;
    if (route.deck) {
      // Whole or nothing: a footbridge can't keep one end in the air.
      if (shadowed >= SHADOW_FRACTION * route.length) droppedRoutes++;
      else keep(id, route, 0, route.length);
      continue;
    }
    // A doubled stretch shorter than a stub stays, so a path isn't cut for
    // brushing past a road, unless it's the route's end: a tail can go
    // without leaving a gap.
    const doubled = runs(flags, true).filter(([k0, k1]) => (k1 - k0) * step >= stub || (route.minor && (k0 === 0 || k1 === flags.length)));
    if (route.minor) {
      keepAllBut(id, route, doubled.map(([k0, k1]) => [k0 * step, k1 * step]));
    } else if (shadowed >= SHADOW_FRACTION * route.length) {
      // Settled once everything else is kept.
      losing.push(id);
    } else {
      // A kept street still loses a doubled stretch where it runs inside the
      // other ribbon at both ends: the road carries on through the winner.
      const cuts: [number, number][] = [];
      for (const [k0, k1] of doubled) {
        let c0 = -1;
        let c1 = -1;
        for (let k = k0; k < k1; k++) {
          if (!covered(samples[k].x, samples[k].y, route.deck, route.rank)) continue;
          if (c0 < 0) c0 = k;
          c1 = k;
        }
        if (c0 >= 0 && (c1 - c0) * step >= stub) cuts.push([(c0 + 0.5) * step, (c1 + 0.5) * step]);
      }
      keepAllBut(id, route, cuts);
    }
  }

  // A losing street keeps the stretches nothing more important doubles (a
  // ramp curving away, a service road turning into a car park), when
  // they're long enough to read as a line of their own.
  for (const id of losing) {
    const route = order[id];
    const { step, samples, halfWidths } = sample(route);
    const flags = samples.map((p, k) => alongside(p.x, p.y, p.ux, p.uy, halfWidths[k], false, route.rank));
    let any = false;
    for (const [k0, k1] of runs(flags, false)) {
      const a = k0 * step;
      const b = k1 * step;
      if (b - a < stub) continue;
      let visible = 0;
      for (let k = k0; k < k1; k++) if (clear(samples[k].x, samples[k].y, halfWidths[k], false, route.rank, id)) visible += step;
      if (visible < stub) continue;
      const start = a > EPSILON ? follow(id, route, a, -1, halfWidths[k0]) : a;
      const end = b < route.length - EPSILON ? follow(id, route, b, 1, halfWidths[k1 - 1]) : b;
      keep(id, route, start, end);
      any = true;
    }
    if (!any) droppedRoutes++;
  }

  // A part lying wholly inside a ribbon at least as important adds nothing
  // but the sliver of its own ribbon poking out: a flight of steps inside a
  // road, a scrap of footway zigzagging across an alley mouth. Least
  // important first, so of two identical lines one stays.
  const alive = parts.map(() => true);
  const hidden = (i: number) => {
    const c = candidates[parts[i].source];
    return densifyLine(parts[i].points, 0.1).every(([x, y]) =>
      kept.near(x, y, (s) => {
        const o = kept.owner[s];
        return (
          o !== i && alive[o] && keptRoute[o] !== keptRoute[i] && keptDeck[o] === c.deck && keptRank[o] <= c.rank && kept.distance(s, x, y) <= keptHalfWidth[o]
        );
      }),
    );
  };
  const byImportance = parts.map((_p, i) => i).sort((a, b) => keptRank[b] - keptRank[a] || a - b);
  let hiddenParts = 0;
  for (const i of byImportance) {
    if (!hidden(i)) continue;
    alive[i] = false;
    hiddenParts++;
  }
  return { parts: parts.filter((_p, i) => alive[i]), droppedRoutes, hiddenParts };
}

/** Parts of a route as they are, for when nothing is culled. */
export function wholeParts(candidates: Candidate[], origins: [EndOrigin, EndOrigin][]): Part[] {
  return candidates.map((c, i): Part => ({ source: i, points: [...c.points], ends: origins[i] }));
}

