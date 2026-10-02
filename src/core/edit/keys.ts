// Object keys. Each names what a solid was built from, so an edit keeps
// finding it in the next model of the same area:
//
//   b:<building id>            a building, with its parts
//   b:<building id>/<part id>  one part (or the main mass) of it
//   r:<segment id>             a road, path or railway
//   br:<segment id>            a bridge deck and its piers
//   w:<feature id>             a body of water
//   t:<feature id>, t:f<r>,<c> a mapped tree, a forest tree
//   k:<record id>              bare rock measured with LiDAR
//   s:<shape id>               a shape added in the editor
//   rt:<track id>              an imported route

import type { ModelEdits, ObjectEdit } from './types';

export type ObjectKind = 'building' | 'road' | 'bridge' | 'water' | 'tree' | 'rock' | 'shape' | 'route';

const PREFIXES: [string, ObjectKind][] = [
  ['br:', 'bridge'],
  ['b:', 'building'],
  ['r:', 'road'],
  ['w:', 'water'],
  ['t:', 'tree'],
  ['k:', 'rock'],
  ['s:', 'shape'],
  ['rt:', 'route'],
];

export function kindOf(key: string): ObjectKind | null {
  for (const [prefix, kind] of PREFIXES) if (key.startsWith(prefix)) return kind;
  return null;
}

/** The object a key belongs to: the building of one of its parts, or the key itself. */
export function objectOf(key: string): string {
  const slash = key.indexOf('/');
  return slash < 0 ? key : key.slice(0, slash);
}

export function partKey(key: string, sub: string): string {
  return sub ? `${key}/${sub}` : key;
}

export function isPartKey(key: string): boolean {
  return key.includes('/');
}

export function shapeKey(id: string): string {
  return `s:${id}`;
}

/**
 * An object's edit as it applies. A bridge deck is its road's segment, so it
 * goes, changes colour and widens with the road unless it has an edit of its
 * own. The road's height stays with the road: a deck's thickness is set with
 * the bridges.
 */
export function editOf(edits: ModelEdits, key: string): ObjectEdit | undefined {
  const own = edits.objects[key];
  if (!key.startsWith('br:')) return own;
  const road = edits.objects[`r:${key.slice(3)}`];
  if (!road) return own;
  const inherited: ObjectEdit = {};
  if (road.removed) inherited.removed = true;
  if (road.layer) inherited.layer = road.layer;
  if (road.widthMm !== undefined) inherited.widthMm = road.widthMm;
  return own ? { ...inherited, ...own } : inherited;
}

/** The bridge deck of a road's segment, and the other way round. */
export function twinOf(key: string): string | null {
  if (key.startsWith('br:')) return `r:${key.slice(3)}`;
  if (key.startsWith('r:')) return `br:${key.slice(2)}`;
  return null;
}
