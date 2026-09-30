// Edits made to a generated model in the viewer. They're keyed by the map
// features things were built from (see keys.ts), not by triangles, so they
// survive regenerating with other settings and apply to the next model of
// the same area. Sizes are printed millimetres. Added shapes are placed in
// lon/lat so they stay put when the area or scale changes.

import type { LonLat } from '../types';

export type FilamentLine = 'PLA Basic' | 'PLA Matte';

/** A colour of the user's own. Everything in it exports as one part. */
export interface EditLayer {
  id: string;
  name: string;
  hex: string;
  line: FilamentLine;
}

export interface ObjectEdit {
  /** Left out of the model. */
  removed?: boolean;
  /** Custom layer id. */
  layer?: string;
  /** Buildings: printed height above the ground. Roads: thickness above the ground. */
  heightMm?: number;
  /** Roads: printed width. */
  widthMm?: number;
}

export type ShapeKind = 'box' | 'cylinder' | 'pin' | 'text' | 'path' | 'area';

export interface AddedShape {
  id: string;
  kind: ShapeKind;
  /** A custom layer id, or a colour group such as 'buildings'. */
  layer: string;
  /** Centre of a box, cylinder or text, the tip of a pin. Paths and areas use `points`. */
  at: LonLat;
  points: LonLat[];
  /** Degrees clockwise from north. */
  rotationDeg: number;
  /** Box width, cylinder and pin diameter, text cap height, path width. */
  sizeMm: number;
  /** Box depth. */
  depthMm: number;
  /** How far it stands above whatever it's on. */
  heightMm: number;
  /** Raised off the ground, e.g. to stand on a roof. */
  liftMm: number;
  /** The top follows the ground, or is flat above the highest ground under it. */
  followGround: boolean;
  text: string;
  font: string;
}

export interface ModelEdits {
  layers: EditLayer[];
  objects: Record<string, ObjectEdit>;
  shapes: AddedShape[];
}

export function emptyEdits(): ModelEdits {
  return { layers: [], objects: {}, shapes: [] };
}

export function hasEdits(edits: ModelEdits): boolean {
  return edits.layers.length > 0 || edits.shapes.length > 0 || Object.keys(edits.objects).length > 0;
}

/** Number of things changed, for a summary. Layers alone don't count. */
export function editCount(edits: ModelEdits): number {
  return Object.keys(edits.objects).length + edits.shapes.length;
}

export const SHAPE_KINDS: readonly ShapeKind[] = ['box', 'cylinder', 'pin', 'text', 'path', 'area'];

/** Limits every number is held to, from the UI, saved state and imports alike. */
export const EDIT_LIMITS = {
  heightMm: [0.1, 150],
  roadHeightMm: [0.1, 20],
  widthMm: [0.2, 12],
  sizeMm: [0.5, 300],
  depthMm: [0.5, 300],
  shapeHeightMm: [0.1, 100],
  liftMm: [0, 150],
  pathWidthMm: [0.3, 20],
} as const;

export const MAX_TEXT_LENGTH = 80;
export const MAX_SHAPE_POINTS = 2000;
export const MAX_LAYERS = 24;
export const MAX_SHAPES = 500;

const HEX = /^#[0-9a-f]{6}$/i;
const clamp = (value: number, [min, max]: readonly [number, number]) => Math.min(max, Math.max(min, value));
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function lonLat(value: unknown): LonLat | null {
  if (!Array.isArray(value) || value.length !== 2 || !finite(value[0]) || !finite(value[1])) return null;
  if (Math.abs(value[0]) > 180 || Math.abs(value[1]) > 90) return null;
  return [value[0], value[1]];
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/**
 * A copy with everything unknown or out of range dropped or clamped, so saved
 * state, option files and the worker all get the same well-formed edits.
 */
export function sanitizeEdits(raw: unknown): ModelEdits {
  const out = emptyEdits();
  if (!isObject(raw)) return out;

  const layerIds = new Set<string>();
  if (Array.isArray(raw.layers)) {
    for (const item of raw.layers) {
      if (!isObject(item) || typeof item.id !== 'string' || !item.id || layerIds.has(item.id)) continue;
      if (typeof item.hex !== 'string' || !HEX.test(item.hex)) continue;
      if (out.layers.length >= MAX_LAYERS) break;
      layerIds.add(item.id);
      out.layers.push({
        id: item.id.slice(0, 64),
        name: text(item.name, 60).trim() || 'Layer',
        hex: item.hex.toUpperCase(),
        line: item.line === 'PLA Matte' ? 'PLA Matte' : 'PLA Basic',
      });
    }
  }

  if (isObject(raw.objects)) {
    for (const [key, value] of Object.entries(raw.objects)) {
      if (!isObject(value) || key.length > 300 || !/^[a-z]{1,2}:/.test(key)) continue;
      const edit: ObjectEdit = {};
      if (value.removed === true) edit.removed = true;
      if (typeof value.layer === 'string' && layerIds.has(value.layer)) edit.layer = value.layer;
      const road = key.startsWith('r:');
      if (finite(value.heightMm)) edit.heightMm = clamp(value.heightMm, road ? EDIT_LIMITS.roadHeightMm : EDIT_LIMITS.heightMm);
      if (finite(value.widthMm) && road) edit.widthMm = clamp(value.widthMm, EDIT_LIMITS.widthMm);
      if (Object.keys(edit).length) out.objects[key] = edit;
    }
  }

  if (Array.isArray(raw.shapes)) {
    const ids = new Set<string>();
    for (const item of raw.shapes) {
      if (out.shapes.length >= MAX_SHAPES) break;
      const shape = sanitizeShape(item, layerIds);
      if (!shape || ids.has(shape.id)) continue;
      ids.add(shape.id);
      out.shapes.push(shape);
    }
  }
  return out;
}

function sanitizeShape(item: unknown, layerIds: Set<string>): AddedShape | null {
  if (!isObject(item) || typeof item.id !== 'string' || !item.id) return null;
  const kind = SHAPE_KINDS.find((k) => k === item.kind);
  if (!kind) return null;
  const at = lonLat(item.at);
  const points: LonLat[] = [];
  if (Array.isArray(item.points)) {
    for (const p of item.points.slice(0, MAX_SHAPE_POINTS)) {
      const q = lonLat(p);
      if (q) points.push(q);
    }
  }
  if (kind === 'path' && points.length < 2) return null;
  if (kind === 'area' && points.length < 3) return null;
  const centre = at ?? points[0];
  if (!centre) return null;
  const layer = typeof item.layer === 'string' && (layerIds.has(item.layer) || COLOUR_GROUP_KEYS.has(item.layer)) ? item.layer : 'buildings';
  const number = (value: unknown, fallback: number, range: readonly [number, number]) => clamp(finite(value) ? value : fallback, range);
  const rotation = finite(item.rotationDeg) ? ((item.rotationDeg % 360) + 360) % 360 : 0;
  return {
    id: item.id.slice(0, 64),
    kind,
    layer,
    at: centre,
    points,
    rotationDeg: rotation,
    sizeMm: number(item.sizeMm, kind === 'path' ? 1.2 : 8, kind === 'path' ? EDIT_LIMITS.pathWidthMm : EDIT_LIMITS.sizeMm),
    depthMm: number(item.depthMm, 8, EDIT_LIMITS.depthMm),
    heightMm: number(item.heightMm, 2, EDIT_LIMITS.shapeHeightMm),
    liftMm: number(item.liftMm, 0, EDIT_LIMITS.liftMm),
    followGround: item.followGround === true,
    text: text(item.text, MAX_TEXT_LENGTH),
    font: typeof item.font === 'string' ? item.font.slice(0, 40) : 'montserrat',
  };
}

// The palette's groups, which a shape can take its colour from. Kept here as
// strings so this module needs nothing from settings.
const COLOUR_GROUP_KEYS = new Set(['terrain', 'buildings', 'roads', 'paved', 'water', 'green', 'forest', 'trees', 'sand', 'rock', 'rim']);

/** Layers nothing uses any more, for tidying up. */
export function unusedLayers(edits: ModelEdits): string[] {
  const used = new Set<string>();
  for (const edit of Object.values(edits.objects)) if (edit.layer) used.add(edit.layer);
  for (const shape of edits.shapes) used.add(shape.layer);
  return edits.layers.filter((layer) => !used.has(layer.id)).map((layer) => layer.id);
}
