// Shared geometry and model types. Model space is millimetres, X east, Y north
// (after the area rotation), Z up. Geographic coordinates are [lon, lat].

export type Vec2 = [number, number];
/** Open ring: the last point is not repeated. Outer rings CCW, holes CW. */
export type Ring = Vec2[];
/** Outer ring first, then holes. */
export type Polygon = Ring[];
export type MultiPolygon = Polygon[];

export type LonLat = [number, number];

export interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** What a triangle is made of. Each role belongs to one colour group. */
export type MaterialRole =
  | 'terrain'
  | 'water'
  | 'road'
  | 'path'
  | 'rail'
  | 'airport'
  | 'bridge'
  | 'pier'
  | 'building'
  | 'paved'
  | 'green'
  | 'forest'
  | 'sand'
  | 'rock'
  | 'tree'
  | 'rim';

/** A colour the user picks. Several roles can share one group. */
export type ColourGroup =
  | 'terrain'
  | 'buildings'
  | 'roads'
  | 'paved'
  | 'water'
  | 'green'
  | 'forest'
  | 'trees'
  | 'sand'
  | 'rock'
  | 'rim';

export const ROLE_GROUP: Record<MaterialRole, ColourGroup> = {
  terrain: 'terrain',
  water: 'water',
  road: 'roads',
  path: 'roads',
  rail: 'roads',
  airport: 'roads',
  bridge: 'roads',
  pier: 'roads',
  building: 'buildings',
  paved: 'paved',
  green: 'green',
  forest: 'forest',
  sand: 'sand',
  rock: 'rock',
  tree: 'trees',
  rim: 'rim',
};

/**
 * Which part prints where two overlap, higher first. PrusaSlicer, Bambu
 * Studio and OrcaSlicer give an overlap to the part listed later, so 3MF
 * exports list parts in this order, and the viewer settles coplanar walls the
 * same way. Land, roads, buildings and trees reach a little into the terrain,
 * and the terrain should show there. Water sheets are sunk into the terrain
 * and have to win, or they print as a sliver.
 */
export const OVERLAP_RANK: Partial<Record<MaterialRole, number>> = { terrain: 1, water: 2 };

/** One printable part: a triangle soup of closed shells, all one material. */
export interface MeshPart {
  /** Stable key, unique within a model, e.g. "terrain" or "roads". */
  id: string;
  /** Name shown in the viewer and written to exported files, e.g. "Roads". */
  name: string;
  role: MaterialRole;
  /** xyz triplets in model millimetres. */
  positions: Float32Array;
  /** Three vertex indices per triangle, counter-clockwise seen from outside. */
  indices: Uint32Array;
  /** A custom layer's own colour. Without one the part takes its role's colour group. */
  colour?: PartColour;
  /** Which triangles each keyed solid made. Only meshes for the viewer have this. */
  objects?: PartObjects;
}

/** A colour that isn't one of the palette's groups: a custom layer's. */
export interface PartColour {
  hex: string;
  line: 'PLA Basic' | 'PLA Matte';
  /** Shown where the export lists colours, e.g. "Racetrack". */
  label: string;
}

/**
 * The keyed solids in a part, so the viewer can pick, hide and recolour
 * them one by one. Solids of one object needn't be next to each other, so an
 * object can have several runs.
 */
export interface PartObjects {
  keys: string[];
  /** Sub-object of each entry, '' for none. */
  subs: string[];
  /** Five numbers per run: entry, first triangle, end triangle, first vertex, end vertex. */
  runs: Uint32Array;
}

export interface ModelStats {
  [key: string]: number | string;
}

/** One print bed's worth of parts, for export. */
export interface Plate {
  name: string;
  parts: MeshPart[];
  /** west, south, east, north in model mm used to centre the plate on its bed. */
  bounds: [number, number, number, number];
}
