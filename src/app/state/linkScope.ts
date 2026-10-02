// What a share link carries of the edits and picked roads: only what's on
// the area it shares. Both are kept for every area, and a link for one city
// carried a "Home" pin, and exactly where it is, from another.

import { roadSegment } from '../../core/edit/blocks';
import { kindOf, objectOf } from '../../core/edit/keys';
import type { ModelEdits } from '../../core/edit/types';
import { Projection } from '../../core/geo/projection';
import type { AreaSpec } from '../../core/settings';
import type { Picks } from '../../core/svgmap/routes';
import { decodeTrack, type Track } from '../../core/tracks/track';
import type { EditData } from './model';

// Shapes and roads a little past the edge still count, the shape's corners
// and a road just outside a round piece.
const MARGIN = 0.05;

function areaBox(area: AreaSpec) {
  const margin = MARGIN * Math.max(area.widthM, area.heightM);
  return { projection: new Projection(area.center, area.rotationDeg, 1), halfW: area.widthM / 2 + margin, halfH: area.heightM / 2 + margin };
}

/** Whether a lon/lat is on the area, or near enough its edge. */
function areaTest(area: AreaSpec): (lonLat: [number, number]) => boolean {
  const { projection, halfW, halfH } = areaBox(area);
  return ([lon, lat]) => {
    const [x, y] = projection.toModel(lon, lat);
    return Math.abs(x) <= halfW && Math.abs(y) <= halfH;
  };
}

/**
 * Whether any part of a lon/lat line is on the area, segments included: a
 * simplified route can cross it with no point on it.
 */
function lineTest(area: AreaSpec): (line: readonly [number, number][]) => boolean {
  const { projection, halfW, halfH } = areaBox(area);
  // Liang-Barsky against the box.
  const crosses = ([ax, ay]: [number, number], [bx, by]: [number, number]) => {
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
        if (q < 0) return false;
        continue;
      }
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
    return true;
  };
  return (line) => {
    let last: [number, number] | null = null;
    for (const [lon, lat] of line) {
      const point = projection.toModel(lon, lat);
      if (last ? crosses(last, point) : Math.abs(point[0]) <= halfW && Math.abs(point[1]) <= halfH) return true;
      last = point;
    }
    return false;
  };
}

export interface ScopedEdits {
  edits: ModelEdits;
  /** Edits left out as being elsewhere. */
  left: number;
  /** Object edits left out because there's no model of this area to tell where they are. */
  unplaced: number;
}

/**
 * The edits on this area. Object edits are keyed by map feature with no
 * place of their own, so they go when the model shown is of this area and
 * has them, and are left out without one. Layers go when something that
 * goes is in them.
 */
export function editsForArea(edits: ModelEdits, area: AreaSpec, model: { data: EditData; trees: boolean } | null): ScopedEdits {
  const inArea = areaTest(area);
  const here = model?.data.frame && model.data.editable ? inArea(model.data.frame.center) : false;
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
  const shapes = edits.shapes.filter((shape) => inArea(shape.at) || shape.points.some(inArea));
  left += edits.shapes.length - shapes.length;
  const used = new Set([...Object.values(objects).map((edit) => edit.layer), ...shapes.map((shape) => shape.layer)]);
  const layers = edits.layers.filter((layer) => used.has(layer.id));
  return { edits: { ...edits, layers, objects, shapes }, left, unplaced };
}

/** The imported routes with any of their line on this area, and how many weren't. */
export function tracksForArea(tracks: readonly Track[], area: AreaSpec): { tracks: Track[]; left: number } {
  const onArea = lineTest(area);
  const kept = tracks.filter((track) => decodeTrack(track).some(onArea));
  return { tracks: kept, left: tracks.length - kept.length };
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
