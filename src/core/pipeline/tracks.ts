// Imported routes on a map model: a ribbon on the ground, a part of its own
// in the route colour, a little taller than the roads so a route along a
// road stands proud of it. Routes never go through the road tidy. A
// recorded track can be moved onto the roads it followed first
// (tracks/snap.ts), using the road lines as tidied, so it sits on the roads
// that are printed. Roads, paths and land cover are cut away under its
// ground (generate.ts), so it never needs the slicer's order to win them.
//
// Buildings aren't cut out of a route. It's listed before them, so where GPS
// drifts into a building the building keeps the overlap and its walls stay
// its own colour. A low building only takes the bottom of the route, whose
// top stays whole: cut out, a route 27 m wide at a small scale was shredded
// into dashes by the houses either side of a street. A bridge deck the route
// runs along carries it, and one it only passes under is cut out of it.
// Snapped, that's decided by the line it was matched to, so a street under a
// viaduct beside it never lifts the route onto the deck.

import { bufferLines, clipLines, difference, dropSmall, intersection, multiArea, offsetPolygons, pointInMulti, union } from '../geometry/polygon';
import type { HeightFn } from '../geometry/solid';
import { markerEnds, markerShapes } from '../tracks/markers';
import { snapToNetwork } from '../tracks/snap';
import { SNAP_MARGIN_M, trackLengthM, type TrackLines } from '../tracks/track';
import type { MultiPolygon, Vec2 } from '../types';
import type { DeckPiece } from './bridges';
import { count, describeObject, type Context } from './context';

/** Markers are this many times the route's width. */
export const MARKER_WIDTHS = 3;
// A deck carries the route when this share of the route inside its ribbon
// runs along it, within ALONG_COS of its direction.
const ALONG_SHARE = 0.6;
const ALONG_COS = Math.cos((30 * Math.PI) / 180);
const SPECK_MM2 = 0.005;
// A marker moves onto the route's line from the recorded end within this,
// in real metres: the snap's own reach.
const MARKER_REACH_M = 40;

export interface TrackPiece {
  /** Editor key: rt:<track id>. */
  key: string;
  /** On the ground. */
  ground: MultiPolygon;
  /** On the decks that carry it, with each deck's key and top and how finely that's sampled. */
  decks: { key: string; polygons: MultiPolygon; top: HeightFn; drape: number }[];
}

export interface TrackLayout {
  pieces: TrackPiece[];
  /** Every route on the ground together, for the water and the trees. */
  ground: MultiPolygon;
}

/**
 * Model lines of a track, snapped if asked, before they're clipped to the
 * model. `via` is the network line each segment was matched along, or -1.
 */
export function trackModelLines(
  track: TrackLines,
  ctx: Pick<Context, 'projection' | 'cropSet'>,
  network: Vec2[][],
  snap: boolean,
): { lines: Vec2[][]; via: Int32Array[]; snapped: number } {
  const mm = ctx.projection.mmPerMetre;
  const near = offsetPolygons(ctx.cropSet, SNAP_MARGIN_M * mm);
  const projected = track.lines.map((line) => line.map(([lon, lat]) => ctx.projection.toModel(lon, lat)));
  const lines = clipLines(projected, near).filter((line) => line.length >= 2);
  if (!snap || !network.length || !lines.length) return { lines, via: lines.map((line) => new Int32Array(line.length - 1).fill(-1)), snapped: 0 };
  return snapToNetwork(lines, network, { unitsPerMetre: mm });
}

/** Start and finish markers for a track laid out as `lines`, `size` across. */
export function trackMarkers(track: TrackLines, lines: readonly Vec2[][], ctx: Pick<Context, 'projection' | 'cropSet'>, size: number): Vec2[][] {
  const first = track.lines[0];
  const last = track.lines[track.lines.length - 1];
  if (!first?.length || !last?.length) return [];
  const toModel = ([lon, lat]: [number, number]) => ctx.projection.toModel(lon, lat);
  const recorded = [[toModel(first[0])], last.map(toModel)];
  const inside = ([x, y]: Vec2) => pointInMulti(x, y, ctx.cropSet);
  return markerShapes(markerEnds(recorded, lines, inside, MARKER_REACH_M * ctx.projection.mmPerMetre, size), size, 0.01);
}

/** The network lines a deck lies on, which the snap can have matched the route to. */
function deckLines(deck: DeckPiece, network: readonly Vec2[][], boxes: readonly number[][]): Set<number> {
  const out = new Set<number>();
  // A quarter and three quarters along the deck. Decks are cut from these
  // lines, so both are on one exactly, and a line crossing it has one at most.
  const a = pointAlong(deck.points, 0.25);
  const b = pointAlong(deck.points, 0.75);
  if (!a || !b) return out;
  const probes = [a, b];
  const eps = 1e-3;
  network.forEach((line, index) => {
    const [x0, y0, x1, y1] = boxes[index];
    if (probes.every(([x, y]) => x >= x0 - eps && x <= x1 + eps && y >= y0 - eps && y <= y1 + eps && distanceToLine(line, x, y) <= eps)) out.add(index);
  });
  return out;
}

function pointAlong(points: readonly Vec2[], share: number): Vec2 | null {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  if (!(total > 0)) return null;
  let left = total * share;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const length = Math.hypot(bx - ax, by - ay);
    if (length >= left && length > 0) return [ax + ((bx - ax) * left) / length, ay + ((by - ay) * left) / length];
    left -= length;
  }
  return points[points.length - 1];
}

function distanceToLine(line: readonly Vec2[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1];
    const dx = line[i][0] - ax;
    const dy = line[i][1] - ay;
    const length2 = dx * dx + dy * dy;
    const t = length2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length2)) : 0;
    best = Math.min(best, Math.hypot(ax + dx * t - x, ay + dy * t - y));
  }
  return best;
}

/**
 * Whether the route runs along a deck rather than under or across it. Where
 * it was snapped only a match to the deck's own line counts. Where it wasn't,
 * a stretch along the deck only counts when it gets on and off at the deck's
 * ends (or the model's edge, or the route's own ends): coming in from the
 * side, it's a street under the deck.
 */
function carries(deck: DeckPiece, own: Set<number>, ribbon: MultiPolygon, route: { lines: readonly Vec2[][]; via: readonly Int32Array[] }, step: number, crop: MultiPolygon): boolean {
  const ends = [deck.points[0], deck.points[deck.points.length - 1]];
  const reach = deck.widthMm + 2 * step;
  const atEnd = (x: number, y: number) => !pointInMulti(x, y, crop) || ends.some(([ex, ey]) => Math.hypot(x - ex, y - ey) <= reach);
  let inside = 0;
  let along = 0;
  route.lines.forEach((line, l) => {
    const via = route.via[l];
    // An unsnapped stretch inside the ribbon: how much of it runs along, and whether it got on at an end.
    let open = false;
    let pending = 0;
    let gotOn = false;
    let last: Vec2 | null = null;
    let lastWay = -1;
    const close = (offAtEnd: boolean) => {
      if (open && gotOn && offAtEnd) along += pending;
      open = false;
      pending = 0;
    };
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = line[i - 1];
      const [bx, by] = line[i];
      const length = Math.hypot(bx - ax, by - ay);
      if (!(length > 0)) continue;
      const ux = (bx - ax) / length;
      const uy = (by - ay) / length;
      const way = via[i - 1] ?? -1;
      const steps = Math.max(1, Math.ceil(length / step));
      for (let k = 0; k < steps; k++) {
        const t = (k + 0.5) / steps;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        const piece = length / steps;
        if (!pointInMulti(x, y, ribbon)) {
          close(atEnd(x, y));
          last = [x, y];
          lastWay = way;
          continue;
        }
        inside += piece;
        const direction = deckDirection(deck.points, x, y);
        const runsAlong = !!direction && Math.abs(direction[0] * ux + direction[1] * uy) >= ALONG_COS;
        if (way >= 0) {
          close(own.has(way));
          if (runsAlong && own.has(way)) along += piece;
        } else {
          if (!open) {
            open = true;
            gotOn = last === null || atEnd(last[0], last[1]) || own.has(lastWay);
          }
          if (runsAlong) pending += piece;
        }
        last = [x, y];
        lastWay = way;
      }
    }
    close(true);
  });
  return inside > 0 && along >= ALONG_SHARE * inside;
}

function deckDirection(points: readonly Vec2[], x: number, y: number): Vec2 | null {
  let best = Infinity;
  let out: Vec2 | null = null;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const dx = bx - ax;
    const dy = by - ay;
    const length2 = dx * dx + dy * dy;
    if (!(length2 > 0)) continue;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length2));
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    if (d < best) {
      best = d;
      const length = Math.sqrt(length2);
      out = [dx / length, dy / length];
    }
  }
  return out;
}

/**
 * Where each route goes: its ribbon and markers on the ground, cut around
 * the decks it passes under, and on the decks it runs along. `network` is
 * the road lines it can be snapped to, decks included.
 */
export async function layOutTracks(tracks: readonly TrackLines[], ctx: Context, input: { network: Vec2[][]; decks: DeckPiece[] }): Promise<TrackLayout> {
  const s = ctx.settings.tracks;
  const width = s.widthMm;
  const deckRibbons = input.decks.map((deck) => dropSmall(intersection(bufferLines([{ points: deck.points, width: deck.widthMm }], 'round'), ctx.cropSet), 0.01));
  let boxes: number[][] | null = null;
  const owns = new Map<number, Set<number>>();
  const ownLines = (k: number) => {
    boxes ??= input.network.map((line) => {
      const box = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [x, y] of line) {
        box[0] = Math.min(box[0], x);
        box[1] = Math.min(box[1], y);
        box[2] = Math.max(box[2], x);
        box[3] = Math.max(box[3], y);
      }
      return box;
    });
    let found = owns.get(k);
    if (!found) owns.set(k, (found = deckLines(input.decks[k], input.network, boxes)));
    return found;
  };
  const pieces: TrackPiece[] = [];
  let snappedShare = 0;
  let snappedCount = 0;
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    await ctx.progress.checkpoint(i / tracks.length);
    const { lines, via, snapped } = trackModelLines(track, ctx, input.network, s.snap);
    if (!lines.length) continue;
    if (s.snap && input.network.length) {
      snappedShare += snapped;
      snappedCount++;
    }
    const markers = s.markers ? trackMarkers(track, lines, ctx, width * MARKER_WIDTHS) : [];
    const shapes = union(bufferLines(lines.map((points) => ({ points, width })), 'round'), markers.map((ring) => [ring]));
    let ribbon = dropSmall(intersection(shapes, ctx.cropSet), SPECK_MM2);
    if (!ribbon.length) continue;
    const decks: TrackPiece['decks'] = [];
    input.decks.forEach((deck, k) => {
      const deckRibbon = deckRibbons[k];
      if (!deckRibbon.length || !ribbon.length) return;
      if (multiArea(intersection(ribbon, deckRibbon)) < SPECK_MM2) return;
      if (!carries(deck, ownLines(k), deckRibbon, { lines, via }, width / 2, ctx.cropSet)) {
        ribbon = dropSmall(difference(ribbon, deckRibbon), SPECK_MM2);
        return;
      }
      // A route wider than the deck takes its whole width along it, or the
      // strips either side stood on the water and had ground kept under them.
      const along = intersection(bufferLines([{ points: deck.points, width: Math.max(deck.widthMm, width) + 0.02 }], 'butt'), ctx.cropSet);
      decks.push({ key: deck.key, polygons: dropSmall(intersection(ribbon, along), SPECK_MM2), top: deck.top, drape: deck.drape });
      ribbon = dropSmall(difference(ribbon, along), SPECK_MM2);
      count(ctx, 'route_decks');
    });
    const key = `rt:${track.id}`;
    if (!ribbon.length && !decks.length) continue;
    // Its ground keeps land cover off, and an editor that removes it gives that back.
    const ground = ribbon.length ? new Map([['', ribbon]]) : undefined;
    describeObject(ctx, key, { kind: 'route', name: track.name, detail: `${(trackLengthM(track.lines) / 1000).toFixed(1)} km`, ground });
    pieces.push({ key, ground: ribbon, decks });
  }
  if (snappedCount) ctx.stats.route_snapped_share = Math.round((snappedShare / snappedCount) * 100) / 100;
  ctx.stats.routes = pieces.length;
  return { pieces, ground: union(...pieces.map((piece) => piece.ground)) };
}
