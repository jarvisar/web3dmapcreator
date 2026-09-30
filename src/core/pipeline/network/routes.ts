// What the tidy works on: pieces with their printed width and rank, what
// each end met in the source, and pieces welded end to end into routes.

import type { Vec2 } from '../../types';
import { dedupe, MINOR_ROAD_CLASSES, polylineLength, RAIL_CLASS } from '../linework';
import type { RoadPiece } from '../roads';
import { cumulative, SegmentIndex, unit } from './lines';

// Lower wins when two lines double each other. Rail sits between the streets
// and the service roads: a track beside a residential street yields to the
// street, a service road beside the track yields to the track.
const RANK: Record<string, number> = {
  motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, unclassified: 5, residential: 6, living_street: 6,
  [RAIL_CLASS]: 7, pedestrian: 7, service: 8, track: 9, cycleway: 10, bridleway: 11, footway: 11, path: 11, steps: 11,
};
const UNRANKED = 12;

export function rankOf(roadClass: string): number {
  return RANK[roadClass] ?? UNRANKED;
}

/**
 * What an end met in the source network, sidewalks and crossings included.
 * `edge`: clipped at the model's edge. `dead`: nothing, a real dead end.
 * `portal`: only a tunnel or indoor corridor. `met`: another line, so if
 * nothing touches it now, whatever it met was left out.
 */
export type EndOrigin = 'edge' | 'dead' | 'portal' | 'met';

export interface Candidate {
  piece: RoadPiece;
  points: Vec2[];
  halfWidth: number;
  rank: number;
  deck: boolean;
  /** Footways and the like lose only their doubled stretches. Streets are judged whole. */
  minor: boolean;
  /** Class and subclass: a ramp isn't the motorway's other carriageway, nor a parking aisle a street's. */
  kind: string;
  oneway: -1 | 0 | 1;
}

// Vertices this close are one. A micrometre segment at the end of a line
// takes its end with it, and a road looked like it carried on past its end.
const VERTEX_MM = 0.003;

export function candidate(piece: RoadPiece, deck: boolean): Candidate {
  return {
    piece,
    points: dedupe(piece.points, VERTEX_MM),
    halfWidth: piece.widthMm / 2,
    rank: rankOf(piece.roadClass),
    deck,
    minor: MINOR_ROAD_CLASSES.has(piece.roadClass),
    kind: `${piece.roadClass}/${piece.subclass}`,
    oneway: piece.oneway ?? 0,
  };
}

/** A candidate's line, or part of it, as it stands after a pass. */
export interface Part {
  source: number;
  points: Vec2[];
  ends: [EndOrigin, EndOrigin];
  /** Moved onto the middle of a divided road, standing for both carriageways. */
  merged?: boolean;
}

export function endOrigins(
  candidates: Candidate[],
  leftOut: Vec2[][],
  hidden: Vec2[][],
  onEdge: (point: Vec2) => boolean,
  tolerance: number,
): [EndOrigin, EndOrigin][] {
  const cell = Math.max(tolerance * 8, 0.5);
  const kept = new SegmentIndex(cell);
  candidates.forEach((c, i) => kept.add(c.points, i));
  const others = new SegmentIndex(cell);
  leftOut.forEach((line) => others.add(line, 0));
  const portals = new SegmentIndex(cell);
  hidden.forEach((line) => portals.add(line, 0));
  const meets = (index: SegmentIndex, [x, y]: Vec2, self = -1) =>
    index.near(x, y, (s) => index.owner[s] !== self && index.distance(s, x, y) <= tolerance);

  return candidates.map((c, i) => {
    const first = c.points[0];
    const last = c.points[c.points.length - 1];
    // A closed line's ends meet each other.
    const loop = Math.hypot(first[0] - last[0], first[1] - last[1]) <= tolerance;
    return [first, last].map((point): EndOrigin => {
      if (onEdge(point)) return 'edge';
      if (loop || meets(kept, point, i) || meets(others, point)) return 'met';
      return meets(portals, point) ? 'portal' : 'dead';
    }) as [EndOrigin, EndOrigin];
  });
}

export interface Member {
  source: number;
  reversed: boolean;
  /** Arc range of the member along the route. */
  from: number;
  to: number;
}

export interface Route {
  members: Member[];
  points: Vec2[];
  cum: number[];
  length: number;
  rank: number;
  deck: boolean;
  minor: boolean;
  order: number;
}

// At a junction a route carries on into the one piece of its class within
// this angle of its heading, when nothing else there does. Overture splits
// both carriageways of a divided street at every cross street, and judged
// block by block the kept one hopped sides at each junction.
const CONTINUATION_DEG = 25;
// Where only two ends meet, the pieces are one route through any bend short
// of doubling back. A carriageway leaving the node its twin leaves, beside
// it, must not be welded to that twin.
const REVERSAL_DEG = 120;

/** Ids for points, the same for points within `tolerance`. */
export class Nodes {
  private readonly cells = new Map<string, number[]>();
  private readonly points: Vec2[] = [];

  constructor(private readonly tolerance: number) {}

  id(point: Vec2): number {
    const q = this.tolerance;
    const cx = Math.round(point[0] / q);
    const cy = Math.round(point[1] / q);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const id of this.cells.get(`${cx + dx},${cy + dy}`) ?? []) {
          const p = this.points[id];
          if (Math.hypot(p[0] - point[0], p[1] - point[1]) <= q) return id;
        }
      }
    }
    const id = this.points.length;
    this.points.push(point);
    const key = `${cx},${cy}`;
    const list = this.cells.get(key);
    if (list) list.push(id);
    else this.cells.set(key, [id]);
    return id;
  }
}

type End = { source: number; tail: boolean };

/**
 * Join pieces of one class that meet end to end into routes, so a street is
 * judged as a street and not as the fragment of it beside its own ramp.
 * Welding only groups pieces for decisions. Their own geometry and
 * attributes are untouched.
 */
export function weld(candidates: Candidate[], tolerance: number): Route[] {
  const nodes = new Nodes(tolerance);
  const endNodes = candidates.map((c) => [nodes.id(c.points[0]), nodes.id(c.points[c.points.length - 1])]);
  const continuation = Math.cos((CONTINUATION_DEG * Math.PI) / 180);
  const reversal = Math.cos((REVERSAL_DEG * Math.PI) / 180);

  const groups = new Map<string, number[]>();
  candidates.forEach((c, i) => {
    const key = `${c.piece.roadClass}|${c.deck}`;
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  });

  const leaving = ({ source, tail }: End): Vec2 | null => {
    const p = candidates[source].points;
    return tail ? unit(p[p.length - 1], p[p.length - 2]) : unit(p[0], p[1]);
  };
  const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
  // The one option continuing `heading`, or null when none or several do.
  // Track runs through a switch on its straightest way, the other track
  // leaving at a few degrees. Welded only when unambiguous, a yard came apart
  // into pieces a switch long, and thinned piece by piece it printed as a
  // ladder.
  const pick = <T>(heading: Vec2, options: [Vec2 | null, T][], straightest = false): T | null => {
    const scored = options.filter((o): o is [Vec2, T] => o[0] !== null).map(([d, key]) => [dot(heading, d), key] as const);
    scored.sort((a, b) => b[0] - a[0]);
    if (!scored.length || scored[0][0] < continuation) return null;
    if (!straightest && scored.length > 1 && scored[1][0] >= continuation) return null;
    return scored[0][1];
  };

  const routes: Route[] = [];
  for (const members of groups.values()) {
    const straightest = candidates[members[0]].piece.roadClass === RAIL_CLASS;
    const at = new Map<number, End[]>();
    for (const i of members) {
      for (const tail of [false, true]) {
        const node = endNodes[i][tail ? 1 : 0];
        const list = at.get(node);
        if (list) list.push({ source: i, tail });
        else at.set(node, [{ source: i, tail }]);
      }
    }
    const used = new Set<number>();
    const lengths = new Map(members.map((i) => [i, polylineLength(candidates[i].points)]));
    const ordered = [...members].sort((a, b) => lengths.get(b)! - lengths.get(a)! || a - b);

    for (const start of ordered) {
      if (used.has(start)) continue;
      used.add(start);
      const inChain = new Set([start]);
      const ahead: { source: number; reversed: boolean }[] = [{ source: start, reversed: false }];
      const behind: { source: number; reversed: boolean }[] = [];
      for (const forwards of [true, false]) {
        for (;;) {
          const endMember = forwards ? ahead[ahead.length - 1] : (behind[behind.length - 1] ?? ahead[0]);
          // The node at the chain's open end, and the heading arriving there.
          const atTail = forwards !== endMember.reversed;
          const node = endNodes[endMember.source][atTail ? 1 : 0];
          const p = candidates[endMember.source].points;
          const heading = atTail ? unit(p[p.length - 2], p[p.length - 1]) : unit(p[1], p[0]);
          const here = (at.get(node) ?? []).filter((e) => !inChain.has(e.source));
          const unused = here.filter((e) => !used.has(e.source));
          if (!unused.length || !heading) break;
          let next: End | null = null;
          if (here.length === 1) {
            const direction = leaving(unused[0]);
            if (direction && dot(heading, direction) >= reversal) next = unused[0];
          } else {
            const options = here.map((e) => [leaving(e), e] as [Vec2 | null, End]);
            const best = pick(heading, options, straightest);
            const back = best && !used.has(best.source) ? leaving(best) : null;
            // Unambiguous from both sides: where a divided street merges into
            // one stem, the stem continues either carriageway.
            if (best && back) {
              const reverse: [Vec2 | null, End | 'chain'][] = [[[-heading[0], -heading[1]], 'chain'], ...options.filter((o) => o[1] !== best)];
              if (pick<End | 'chain'>([-back[0], -back[1]], reverse, straightest) === 'chain') next = best;
            }
          }
          if (!next) break;
          used.add(next.source);
          inChain.add(next.source);
          // A piece leaving the node at its head runs with the chain going
          // forwards, and against it going backwards.
          if (forwards) ahead.push({ source: next.source, reversed: next.tail });
          else behind.push({ source: next.source, reversed: !next.tail });
        }
      }
      const chain = [...behind.reverse(), ...ahead];
      const points: Vec2[] = [];
      for (const { source, reversed } of chain) {
        const own = candidates[source].points;
        const run = reversed ? [...own].reverse() : own;
        for (let k = points.length ? 1 : 0; k < run.length; k++) points.push(run[k]);
      }
      const cum = cumulative(points);
      // Members share their joint vertices, so each spans its own segment count.
      let vertex = 0;
      const routeMembers: Member[] = chain.map(({ source, reversed }) => {
        const next = vertex + candidates[source].points.length - 1;
        const member = { source, reversed, from: cum[vertex], to: cum[next] };
        vertex = next;
        return member;
      });
      const first = candidates[start];
      routes.push({
        members: routeMembers,
        points,
        cum,
        length: cum[cum.length - 1],
        rank: first.rank,
        deck: first.deck,
        minor: first.minor,
        order: Math.min(...chain.map((m) => m.source)),
      });
    }
  }
  return routes;
}
