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

export type ObjectKind = 'building' | 'road' | 'bridge' | 'water' | 'tree' | 'rock' | 'shape';

const PREFIXES: [string, ObjectKind][] = [
  ['br:', 'bridge'],
  ['b:', 'building'],
  ['r:', 'road'],
  ['w:', 'water'],
  ['t:', 'tree'],
  ['k:', 'rock'],
  ['s:', 'shape'],
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
