// What generators return. Almost everything in a city model is a 2.5D prism:
// a polygon with a top and bottom height at every point and vertical walls.
// Keeping solids in that form until the last step means cropping to the area
// shape and splitting into print sections are plain 2D polygon clips, and the
// mesher closes every shell the same way.

import type { MaterialRole, Polygon, Vec2 } from '../types';

export type HeightFn = (x: number, y: number) => number;

export interface PrismSolid {
  kind: 'prism';
  role: MaterialRole;
  /** Outer ring CCW then holes CW, in model mm. */
  polygon: Polygon;
  /** Top of the solid, a constant or a function of (x, y). */
  top: HeightFn | number;
  bottom: HeightFn | number;
  /**
   * Largest cap edge in mm, so a top or bottom that is not planar (terrain,
   * anything draped on it) is sampled across the interior, not only at the
   * outline. 0 for planar caps.
   */
  drape: number;
  /** Put interior sample points on this grid instead of one aligned to the polygon. */
  lattice?: { x0: number; y0: number; step: number };
}

export interface MeshSolid {
  kind: 'mesh';
  role: MaterialRole;
  /** xyz triplets in model mm. */
  positions: ArrayLike<number>;
  /** Triangles, CCW from outside. */
  indices: ArrayLike<number>;
  /** Decides which print section the whole mesh goes to when the model is split. */
  anchor: Vec2;
}

export type Solid = PrismSolid | MeshSolid;

/** A named group of solids that becomes one exported part. */
export interface Layer {
  id: string;
  name: string;
  role: MaterialRole;
  solids: Solid[];
}
