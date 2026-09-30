// What a share link carries of the edits and picked roads: only what's on
// the area it shares. Both are kept for every area, and a link for one city
// carried a "Home" pin, and exactly where it is, from another.

import { kindOf, objectOf } from '../../core/edit/keys';
import type { ModelEdits } from '../../core/edit/types';
import { Projection } from '../../core/geo/projection';
import type { AreaSpec } from '../../core/settings';
import type { Picks } from '../../core/svgmap/routes';
import type { EditData } from './model';

// Shapes and roads a little past the edge still count, the shape's corners
// and a road just outside a round piece.
const MARGIN = 0.05;

/** Whether a lon/lat is on the area, or near enough its edge. */
function areaTest(area: AreaSpec): (lonLat: [number, number]) => boolean {
  const projection = new Projection(area.center, area.rotationDeg, 1);
  const margin = MARGIN * Math.max(area.widthM, area.heightM);
  const halfW = area.widthM / 2 + margin;
  const halfH = area.heightM / 2 + margin;
  return ([lon, lat]) => {
    const [x, y] = projection.toModel(lon, lat);
    return Math.abs(x) <= halfW && Math.abs(y) <= halfH;
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
    if (kind === 'road') return roads.has(key);
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

/** The picked roads on this area, and how many lines were left out. Routes with nothing here go too. */
export function picksForArea(picks: Picks, area: AreaSpec): { picks: Picks; left: number } {
  const inArea = areaTest(area);
  let left = 0;
  const keep = (lines: Picks['hiddenLines']) => {
    const kept = lines.filter((line) => line.some(inArea));
    left += lines.length - kept.length;
    return kept;
  };
  const routes = picks.routes.map((route) => ({ ...route, lines: keep(route.lines) })).filter((route) => route.lines.length > 0);
  return { picks: { routes, hiddenLines: keep(picks.hiddenLines) }, left };
}
