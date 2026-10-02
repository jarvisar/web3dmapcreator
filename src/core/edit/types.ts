// Edits made to a generated model in the viewer. They're keyed by the map
// features things were built from (see keys.ts), not by triangles, so they
// survive regenerating with other settings and apply to the next model of
// the same area. Sizes are printed millimetres, apart from building heights,
// which are real metres so an edited building keeps up with a new scale.
// Added shapes are placed in lon/lat so they stay put when the area or scale
// changes.

import type { LonLat } from '../types';
import { MAX_SPLITS, normalRoadKey, roundAt } from './blocks';

/** Saved edits of another version are read as far as they still make sense. */
export const EDITS_VERSION = 2;

export type FilamentLine = 'PLA Basic' | 'PLA Matte';

/** A colour of the user's own. Everything in it exports as one part. */
export interface EditLayer {
  id: string;
  name: string;
  hex: string;
  line: FilamentLine;
}

export interface ObjectEdit {
  /** Left out of the model. False keeps a bridge whose road is removed (keys.ts editOf). */
  removed?: boolean;
  /** Water left out keeps its recess, rather than being filled with ground. */
  hollow?: boolean;
  /** Custom layer id. */
  layer?: string;
  /** Buildings: real height above the ground, in metres. */
  heightM?: number;
  /** Roads: printed thickness above the ground. */
  heightMm?: number;
  /** Roads and bridge decks: printed width. */
  widthMm?: number;
  /** A road segment's own edit: where it's split into blocks, as fractions of its length (blocks.ts). */
  splits?: number[];
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
  version: number;
  layers: EditLayer[];
  objects: Record<string, ObjectEdit>;
  shapes: AddedShape[];
}

/**
 * A shape follows the ground only while it's on it. Raised onto a roof or a
 * bridge its top is flat, so it can stand on what's under it rather than
 * run down to the street.
 */
export function followsGround(shape: Pick<AddedShape, 'followGround' | 'liftMm'>): boolean {
  return shape.followGround && !(shape.liftMm > 0);
}

/** The model colour a shape takes without a layer of its own: a drawn road the roads', anything else the buildings'. */
export function shapeGroup(kind: ShapeKind): string {
  return kind === 'path' ? 'roads' : 'buildings';
}

export function emptyEdits(): ModelEdits {
  return { version: EDITS_VERSION, layers: [], objects: {}, shapes: [] };
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
  heightM: [0.5, 5000],
  /** A building's printed height, where the inspector shows it in mm. */
  buildingHeightMm: [0.2, 300],
  roadHeightMm: [0.1, 20],
  widthMm: [0.2, 12],
  sizeMm: [0.5, 300],
  depthMm: [0.5, 300],
  shapeHeightMm: [0.1, 100],
  // As high as the tallest building, so a shape can go on its roof.
  liftMm: [0, 300],
  pathWidthMm: [0.3, 20],
} as const;

export const MAX_TEXT_LENGTH = 80;
export const MAX_SHAPE_POINTS = 2000;
export const MAX_LAYERS = 24;
export const MAX_SHAPES = 500;

/**
 * A building's printed height as the edits can hold it at this scale: the
 * printed limits and the real height's, whichever is tighter.
 */
export function buildingHeightRange(mmPerMetre: number): [number, number] {
  const low = Math.max(EDIT_LIMITS.buildingHeightMm[0], EDIT_LIMITS.heightM[0] * mmPerMetre);
  const high = Math.min(EDIT_LIMITS.buildingHeightMm[1], EDIT_LIMITS.heightM[1] * mmPerMetre);
  return [low, Math.max(low, high)];
}

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
  if (typeof value !== 'string') return '';
  const cut = value.slice(0, max);
  // Not through the middle of an emoji, which left half of one to print as a box.
  return /[\uD800-\uDBFF]$/.test(cut) && value.length > max ? cut.slice(0, -1) : cut;
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
    for (const [name, value] of Object.entries(raw.objects)) {
      if (!isObject(value) || name.length > 300 || !/^[a-z]{1,2}:/.test(name)) continue;
      // A range of a road is written one way, so one block has one key.
      const key = name.startsWith('r:') ? normalRoadKey(name) : name;
      if (!key) continue;
      const edit: ObjectEdit = {};
      if (key.startsWith('r:') && !key.includes('@') && Array.isArray(value.splits)) {
        const splits = [...new Set(value.splits.filter((v): v is number => finite(v) && v > 0 && v < 1).map(roundAt))].filter((v) => v > 0 && v < 1);
        if (splits.length) edit.splits = splits.sort((a, b) => a - b).slice(0, MAX_SPLITS);
      }
      if (value.removed === true) edit.removed = true;
      else if (value.removed === false && key.startsWith('br:')) edit.removed = false;
      if (key.startsWith('w:') && edit.removed && value.hollow === true) edit.hollow = true;
      if (typeof value.layer === 'string' && layerIds.has(value.layer)) edit.layer = value.layer;
      // Older edits held a building's printed height, which can't be told in metres without the scale it was set at.
      if (key.startsWith('b:') && finite(value.heightM)) edit.heightM = clamp(value.heightM, EDIT_LIMITS.heightM);
      if (key.startsWith('r:') && finite(value.heightMm)) edit.heightMm = clamp(value.heightMm, EDIT_LIMITS.roadHeightMm);
      if ((key.startsWith('r:') || key.startsWith('br:')) && finite(value.widthMm)) edit.widthMm = clamp(value.widthMm, EDIT_LIMITS.widthMm);
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

/**
 * Edits from a share link or an options file added to these, rather than put
 * in their place: edits are one document for every area, so replacing them
 * lost everything done elsewhere. Theirs win for an object, shape or layer
 * both have. `added` counts their objects and shapes that weren't here as
 * they are, `replaced` ours that theirs changed, and `left` what the limits
 * left out, which is always theirs since ours come first.
 */
export function mergeEdits(base: ModelEdits, extra: ModelEdits): { edits: ModelEdits; added: number; replaced: number; left: number } {
  let added = 0;
  let replaced = 0;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const byId = <T extends { id: string }>(ours: T[], theirs: T[], counted: boolean): T[] => {
    const incoming = new Map(theirs.map((item) => [item.id, item]));
    const out = ours.map((item) => {
      const other = incoming.get(item.id);
      if (!other) return item;
      incoming.delete(item.id);
      if (!same(item, other)) {
        replaced++;
        if (counted) added++;
      }
      return other;
    });
    for (const item of incoming.values()) {
      out.push(item);
      if (counted) added++;
    }
    return out;
  };
  const layers = byId(base.layers, extra.layers, false);
  const shapes = byId(base.shapes, extra.shapes, true);
  const objects = { ...base.objects };
  for (const [key, edit] of Object.entries(extra.objects)) {
    const before = objects[key];
    if (!before || !same(before, edit)) {
      added++;
      if (before) replaced++;
    }
    objects[key] = edit;
  }
  const edits = sanitizeEdits({ version: EDITS_VERSION, layers, objects, shapes });
  const left = layers.length - edits.layers.length + shapes.length - edits.shapes.length;
  return { edits, added, replaced, left };
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
  const layer = typeof item.layer === 'string' && (layerIds.has(item.layer) || COLOUR_GROUP_KEYS.has(item.layer)) ? item.layer : shapeGroup(kind);
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
const COLOUR_GROUP_KEYS = new Set(['terrain', 'buildings', 'roads', 'route', 'paved', 'water', 'green', 'forest', 'trees', 'sand', 'rock', 'rim']);

/** A shape's layer if it still has it, a custom layer or a model colour, or else its kind's colour. */
export function shapeLayerIn(shape: Pick<AddedShape, 'kind' | 'layer'>, layers: readonly EditLayer[]): string {
  return COLOUR_GROUP_KEYS.has(shape.layer) || layers.some((layer) => layer.id === shape.layer) ? shape.layer : shapeGroup(shape.kind);
}

/** Layers nothing uses any more, for tidying up. */
export function unusedLayers(edits: ModelEdits): string[] {
  const used = new Set<string>();
  for (const edit of Object.values(edits.objects)) if (edit.layer) used.add(edit.layer);
  for (const shape of edits.shapes) used.add(shape.layer);
  return edits.layers.filter((layer) => !used.has(layer.id)).map((layer) => layer.id);
}
