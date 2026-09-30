// What the viewer shows of each object, given the edits: hidden, in its
// part's colour, in a custom layer's or, for a shape, in its colour group's.
// Kept apart from the three.js code so scripts/fuzz-edits.ts can hold the
// exports to the same rules.

import type { ModelEdits } from '../../core/edit/types';
import type { Entry } from './composed';

export interface ShownContext {
  edits: ModelEdits;
  /** Parts the user hid, including custom layers as 'layer:<id>' and 'shapes'. */
  hiddenParts: ReadonlySet<string>;
  /** Objects other edits hide, like trees under a shape. */
  implicitHidden: ReadonlySet<string>;
}

export const SHAPES_PART = 'shapes';

/** The custom layer an entry is in, from its own edit or its object's. */
export function layerOf(entry: Entry, edits: ModelEdits): string | null {
  const layers = edits.layers;
  if (entry.key.startsWith('s:')) {
    const shape = edits.shapes.find((s) => `s:${s.id}` === entry.key);
    if (!shape) return null;
    return layers.some((l) => l.id === shape.layer) ? shape.layer : null;
  }
  const own = entry.sub ? edits.objects[`${entry.key}/${entry.sub}`]?.layer : undefined;
  const layer = own ?? edits.objects[entry.key]?.layer;
  return layer && layers.some((l) => l.id === layer) ? layer : null;
}

/**
 * How an entry shows: null when hidden, '' in its part's own colour, or
 * 'layer:<id>' or 'group:<colour group>'. `overridden`: the worker sent new
 * geometry for it, which shows instead.
 */
export function entryColour(entry: Entry, ctx: ShownContext, overridden: boolean): string | null {
  const { key, sub } = entry;
  const edits = ctx.edits;
  if (overridden || ctx.implicitHidden.has(key)) return null;
  if (edits.objects[key]?.removed) return null;
  if (sub && edits.objects[`${key}/${sub}`]?.removed) return null;
  const layer = layerOf(entry, edits);
  if (layer) return ctx.hiddenParts.has(`layer:${layer}`) ? null : `layer:${layer}`;
  if (key.startsWith('s:')) {
    if (ctx.hiddenParts.has(SHAPES_PART)) return null;
    const shape = edits.shapes.find((s) => `s:${s.id}` === key);
    return shape ? `group:${shape.layer}` : null;
  }
  return '';
}
