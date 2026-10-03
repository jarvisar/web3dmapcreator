// What a share link carries of the edits, picked roads and imported routes:
// only what's on the area it shares. All three are kept for every area, and
// a link for one city carried a "Home" pin, and exactly where it is, from
// another.

import { roadSegment } from '../../core/edit/blocks';
import { kindOf, objectOf } from '../../core/edit/keys';
import type { AddedShape, ModelEdits } from '../../core/edit/types';
import { Projection } from '../../core/geo/projection';
import type { AreaSpec } from '../../core/settings';
import type { Picks } from '../../core/svgmap/routes';
import { encodePolyline } from '../../core/tracks/polyline';
import { decodeTrack, encodeTrack, MAX_TRACK_POINTS, SNAP_MARGIN_M, trackPoints, type Track } from '../../core/tracks/track';
import type { LonLat, Vec2 } from '../../core/types';
import type { EditData } from './model';

// Shapes and roads a little past the edge still count, the shape's corners
// and a road just outside a round piece.
const MARGIN = 0.05;

interface Box {
  projection: Projection;
  halfW: number;
  halfH: number;
}

/** The area's box in its own frame, in metres, `extra` metres bigger all round. */
function areaBox(area: AreaSpec, extra = 0): Box {
  const margin = MARGIN * Math.max(area.widthM, area.heightM) + extra;
  return { projection: new Projection(area.center, area.rotationDeg, 1), halfW: area.widthM / 2 + margin, halfH: area.heightM / 2 + margin };
}

const inBox = ({ halfW, halfH }: Box, [x, y]: Vec2) => Math.abs(x) <= halfW && Math.abs(y) <= halfH;

/** Where a segment is in the box, as a share of the way from `a` to `b` (Liang-Barsky), or null where it misses. */
function clipSegment({ halfW, halfH }: Box, [ax, ay]: Vec2, [bx, by]: Vec2): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const sides: [number, number][] = [
    [-dx, ax + halfW],
    [dx, halfW - ax],
    [-dy, ay + halfH],
    [dy, halfH - ay],
  ];
  for (const [p, q] of sides) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

/** Whether any part of a line in the box's frame is in it, segments included. */
function lineInBox(box: Box, line: readonly Vec2[]): boolean {
  if (line.length === 1) return inBox(box, line[0]);
  for (let i = 1; i < line.length; i++) if (clipSegment(box, line[i - 1], line[i])) return true;
  return false;
}

/**
 * Whether any part of a lon/lat line is on the area, segments included: a
 * simplified route can cross it with no point on it.
 */
function lineTest(area: AreaSpec): (line: readonly [number, number][]) => boolean {
  const box = areaBox(area);
  return (line) => lineInBox(box, line.map(([lon, lat]) => box.projection.toModel(lon, lat)));
}

function insideRing(ring: readonly Vec2[], [x, y]: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Whether any of a shape is on the area, not just its anchor or points: a
 * drawn road across the area with both ends off it, a filled area around
 * it, or a big box beside it all print. Sizes are printed mm, so they go by
 * the scale. Text is taken as a circle a little wider than its letters.
 */
function shapeTest(area: AreaSpec, mmPerMetre: number): (shape: AddedShape) => boolean {
  const box = areaBox(area);
  const local = ([lon, lat]: LonLat) => box.projection.toModel(lon, lat);
  const metres = (mm: number) => (mmPerMetre > 0 ? mm / mmPerMetre : 0);
  // The box grown by `r` all round, for a line `r` either side of its centreline or a circle of `r`.
  const grown = (r: number): Box => ({ ...box, halfW: box.halfW + r, halfH: box.halfH + r });
  return (shape) => {
    const points = shape.points.map(local);
    if (inBox(box, local(shape.at)) || points.some((p) => inBox(box, p))) return true;
    switch (shape.kind) {
      case 'path':
        return points.length > 0 && lineInBox(grown(metres(shape.sizeMm) / 2), points);
      case 'area':
        return points.length >= 3 && (lineInBox(box, [...points, points[0]]) || insideRing(points, [0, 0]));
      case 'box': {
        const at = local(shape.at);
        const phi = ((shape.rotationDeg - area.rotationDeg) * Math.PI) / 180;
        const w = metres(shape.sizeMm) / 2;
        const d = metres(shape.depthMm) / 2;
        const corner = (u: number, v: number): Vec2 => [at[0] + u * Math.cos(phi) + v * Math.sin(phi), at[1] - u * Math.sin(phi) + v * Math.cos(phi)];
        const ring = [corner(-w, -d), corner(w, -d), corner(w, d), corner(-w, d)];
        return lineInBox(box, [...ring, ring[0]]) || insideRing(ring, [0, 0]);
      }
      default: {
        // A cylinder's radius, a pin's head reaching 1.45 sizes from its tip, or text.
        const reach = shape.kind === 'cylinder' ? 0.5 : shape.kind === 'pin' ? 1.45 : 0.6 * shape.text.trim().length + 1;
        return inBox(grown(metres(shape.sizeMm * reach)), local(shape.at));
      }
    }
  };
}

export interface ScopedEdits {
  edits: ModelEdits;
  /** Edits left out as being elsewhere. */
  left: number;
  /** Object edits left out because there's no model of this area to tell where they are. */
  unplaced: number;
}

/** Whether two areas are the same one, give or take rounding. */
function sameArea(a: AreaSpec, b: AreaSpec): boolean {
  return (
    a.shape === b.shape &&
    Math.abs(a.center[0] - b.center[0]) < 1e-9 &&
    Math.abs(a.center[1] - b.center[1]) < 1e-9 &&
    Math.abs(a.widthM - b.widthM) < 1e-3 &&
    Math.abs(a.heightM - b.heightM) < 1e-3 &&
    Math.abs(a.rotationDeg - b.rotationDeg) < 1e-6 &&
    Math.abs(a.cornerRadius - b.cornerRadius) < 1e-9
  );
}

/**
 * The edits on this area. Object edits are keyed by map feature with no
 * place of their own, so they go when the model shown was made for this
 * area and has them, and are left out without one. A model of another area
 * can't tell: one made before the area was made smaller had edits from
 * outside it, and one made before it grew lacked what's new, which counted
 * as made elsewhere. Layers go when something that goes is in them.
 * `mmPerMetre` sizes shapes when there's no model of this area to take the
 * scale from.
 */
export function editsForArea(edits: ModelEdits, area: AreaSpec, model: { data: EditData; trees: boolean } | null, mmPerMetre: number): ScopedEdits {
  const here = model?.data.frame && model.data.editable ? sameArea(model.data.frame.area, area) : false;
  const onArea = shapeTest(area, here ? model!.data.frame!.mmPerMetre : mmPerMetre);
  const roads = new Set(model?.data.roads?.keys ?? []);
  const has = (key: string) => {
    if (!model || !here) return false;
    const kind = kindOf(key);
    if (kind === 'tree') return model.trees;
    if (kind === 'road') return roads.has(roadSegment(key));
    return objectOf(key) in model.data.objects;
  };
  const objects: ModelEdits['objects'] = {};
  let left = 0;
  let unplaced = 0;
  for (const [key, edit] of Object.entries(edits.objects)) {
    if (has(key)) objects[key] = edit;
    else if (here) left++;
    else unplaced++;
  }
  const shapes = edits.shapes.filter(onArea);
  left += edits.shapes.length - shapes.length;
  const used = new Set([...Object.values(objects).map((edit) => edit.layer), ...shapes.map((shape) => shape.layer)]);
  const layers = edits.layers.filter((layer) => used.has(layer.id));
  return { edits: { ...edits, layers, objects, shapes }, left, unplaced };
}

/** The imported routes with any of their line on this area, and how many weren't. Whole, for an options file. */
export function tracksForArea(tracks: readonly Track[], area: AreaSpec): { tracks: Track[]; left: number } {
  const onArea = lineTest(area);
  const kept = tracks.filter((track) => decodeTrack(track).some(onArea));
  return { tracks: kept, left: tracks.length - kept.length };
}

/**
 * The routes for a share link: the shown ones on this area, cut to it plus
 * what generation reads past its edge, so the model comes out the same.
 * Hidden routes aren't in the model, and a run that starts at home and
 * crosses the area shouldn't give the home away. A route the cut leaves
 * whole is passed on as it is.
 */
export function tracksForLink(tracks: readonly Track[], area: AreaSpec): Track[] {
  const box = areaBox(area, SNAP_MARGIN_M);
  return tracksForArea(
    tracks.filter((track) => track.visible),
    area,
  ).tracks.flatMap((track) => {
    const lines = cutLines(decodeTrack(track), box);
    if (!lines) return [track];
    if (!lines.length) return [];
    const encoded = lines.map(encodePolyline);
    // Cut ends add a point, which could take a route at the limit over it.
    return [{ ...track, lines: trackPoints(encoded) > MAX_TRACK_POINTS ? encodeTrack(lines) : encoded }];
  });
}

/**
 * Lon/lat lines cut to a box, in order, with a new point where a line
 * crosses its edge. Null when every point is in it already.
 */
function cutLines(lines: readonly LonLat[][], box: Box): LonLat[][] | null {
  const local = lines.map((line) => line.map(([lon, lat]) => box.projection.toModel(lon, lat)));
  if (local.every((line) => line.every((p) => inBox(box, p)))) return null;
  const at = (a: Vec2, b: Vec2, t: number): LonLat => box.projection.localToGeo(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
  const out: LonLat[][] = [];
  lines.forEach((line, l) => {
    const points = local[l];
    let piece: LonLat[] = [];
    const end = () => {
      if (piece.length >= 2) out.push(piece);
      piece = [];
    };
    for (let i = 1; i < points.length; i++) {
      const span = clipSegment(box, points[i - 1], points[i]);
      // Only touching the edge leaves nothing between, not a repeated point.
      if (!span || span[1] <= span[0]) {
        end();
        continue;
      }
      const [t0, t1] = span;
      if (!piece.length) piece.push(t0 > 0 ? at(points[i - 1], points[i], t0) : line[i - 1]);
      piece.push(t1 < 1 ? at(points[i - 1], points[i], t1) : line[i]);
      if (t1 < 1) end();
    }
    end();
  });
  return out;
}

/** The picked roads on this area, and how many lines were left out. Routes with nothing here go too. */
export function picksForArea(picks: Picks, area: AreaSpec): { picks: Picks; left: number } {
  const onArea = lineTest(area);
  let left = 0;
  const keep = (lines: Picks['hiddenLines']) => {
    const kept = lines.filter(onArea);
    left += lines.length - kept.length;
    return kept;
  };
  const routes = picks.routes.map((route) => ({ ...route, lines: keep(route.lines) })).filter((route) => route.lines.length > 0);
  return { picks: { routes, hiddenLines: keep(picks.hiddenLines) }, left };
}
