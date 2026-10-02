// Imported routes on a map model: a ribbon on the ground, a part of its own
// in the route colour, a little taller than the roads so a route along a
// road stands proud of it. Routes never go through the road tidy. A
// recorded track can be moved onto the roads it followed first
// (tracks/snap.ts), using the road lines as tidied, so it sits on the roads
// that are printed.
//
// Buildings aren't cut out of a route. It's listed before them, so where GPS
// drifts into a building the building keeps the overlap and its walls stay
// its own colour. A low building only takes the bottom of the route, whose
// top stays whole: cut out, a route 27 m wide at a small scale was shredded
// into dashes by the houses either side of a street. A bridge deck the route
// runs along carries it, and one it only passes under is cut out of it.

import { bufferLines, clipLines, difference, dropSmall, intersection, multiArea, offsetPolygons, pointInMulti, union } from '../geometry/polygon';
import type { HeightFn } from '../geometry/solid';
import { markerShapes } from '../tracks/markers';
import { snapToNetwork } from '../tracks/snap';
import { trackLengthM, type TrackLines } from '../tracks/track';
import type { MultiPolygon, Vec2 } from '../types';
import type { DeckPiece } from './bridges';
import { count, describeObject, type Context } from './context';

/** Markers are this many times the route's width. */
export const MARKER_WIDTHS = 3;
// Track lines are clipped this far past the model before snapping, in real
// metres, so a route leaving the model and coming back is matched as one.
const SNAP_MARGIN_M = 200;
// A deck carries the route when this share of the route inside its ribbon
// runs along it, within ALONG_COS of its direction.
const ALONG_SHARE = 0.6;
const ALONG_COS = Math.cos((30 * Math.PI) / 180);
const SPECK_MM2 = 0.005;

export interface TrackPiece {
  /** Editor key: rt:<track id>. */
  key: string;
  /** On the ground. */
  ground: MultiPolygon;
  /** On the decks that carry it, with each deck's top and how finely that's sampled. */
  decks: { polygons: MultiPolygon; top: HeightFn; drape: number }[];
}

export interface TrackLayout {
  pieces: TrackPiece[];
  /** Every route on the ground together, for the water and the trees. */
  ground: MultiPolygon;
}

/** Model lines of a track, snapped if asked, before they're clipped to the model. */
export function trackModelLines(track: TrackLines, ctx: Pick<Context, 'projection' | 'cropSet'>, network: Vec2[][], snap: boolean): { lines: Vec2[][]; snapped: number } {
  const mm = ctx.projection.mmPerMetre;
  const near = offsetPolygons(ctx.cropSet, SNAP_MARGIN_M * mm);
  const projected = track.lines.map((line) => line.map(([lon, lat]) => ctx.projection.toModel(lon, lat)));
  const lines = clipLines(projected, near).filter((line) => line.length >= 2);
  if (!snap || !network.length || !lines.length) return { lines, snapped: 0 };
  return snapToNetwork(lines, network, { unitsPerMetre: mm });
}

/** Whether the route runs along a deck rather than under or across it. */
function carries(deck: DeckPiece, ribbon: MultiPolygon, lines: readonly Vec2[][], step: number): boolean {
  let inside = 0;
  let along = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = line[i - 1];
      const [bx, by] = line[i];
      const length = Math.hypot(bx - ax, by - ay);
      if (!(length > 0)) continue;
      const ux = (bx - ax) / length;
      const uy = (by - ay) / length;
      const steps = Math.max(1, Math.ceil(length / step));
      for (let k = 0; k < steps; k++) {
        const t = (k + 0.5) / steps;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        if (!pointInMulti(x, y, ribbon)) continue;
        inside += length / steps;
        const direction = deckDirection(deck.points, x, y);
        if (direction && Math.abs(direction[0] * ux + direction[1] * uy) >= ALONG_COS) along += length / steps;
      }
    }
  }
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
  const pieces: TrackPiece[] = [];
  let snappedShare = 0;
  let snappedCount = 0;
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    await ctx.progress.checkpoint(i / tracks.length);
    const { lines, snapped } = trackModelLines(track, ctx, input.network, s.snap);
    if (!lines.length) continue;
    if (s.snap && input.network.length) {
      snappedShare += snapped;
      snappedCount++;
    }
    const markers = s.markers ? markerShapes(lines, width * MARKER_WIDTHS, 0.01) : [];
    const shapes = union(bufferLines(lines.map((points) => ({ points, width })), 'round'), markers.map((ring) => [ring]));
    let ribbon = dropSmall(intersection(shapes, ctx.cropSet), SPECK_MM2);
    if (!ribbon.length) continue;
    const decks: TrackPiece['decks'] = [];
    input.decks.forEach((deck, k) => {
      const deckRibbon = deckRibbons[k];
      if (!deckRibbon.length || !ribbon.length) return;
      if (multiArea(intersection(ribbon, deckRibbon)) < SPECK_MM2) return;
      if (!carries(deck, deckRibbon, lines, width / 2)) {
        ribbon = dropSmall(difference(ribbon, deckRibbon), SPECK_MM2);
        return;
      }
      // A route wider than the deck takes its whole width along it, or the
      // strips either side stood on the water and had ground kept under them.
      const along = intersection(bufferLines([{ points: deck.points, width: Math.max(deck.widthMm, width) + 0.02 }], 'butt'), ctx.cropSet);
      decks.push({ polygons: dropSmall(intersection(ribbon, along), SPECK_MM2), top: deck.top, drape: deck.drape });
      ribbon = dropSmall(difference(ribbon, along), SPECK_MM2);
      count(ctx, 'route_decks');
    });
    const key = `rt:${track.id}`;
    if (!ribbon.length && !decks.length) continue;
    describeObject(ctx, key, { kind: 'route', name: track.name, detail: `${(trackLengthM(track.lines) / 1000).toFixed(1)} km` });
    pieces.push({ key, ground: ribbon, decks });
  }
  if (snappedCount) ctx.stats.route_snapped_share = Math.round((snappedShare / snappedCount) * 100) / 100;
  ctx.stats.routes = pieces.length;
  return { pieces, ground: union(...pieces.map((piece) => piece.ground)) };
}
