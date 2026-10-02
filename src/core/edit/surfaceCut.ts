// A LiDAR only model's surface with the trees over drawn roads cleared
// (drawn.ts): the cleared cells cut out of it and filled with the bare ground.
//
// Cutting the whole surface took about 0.4 s for the Loop's 860,000
// triangles, plus 0.3 s for its boundary and 0.2 s to mesh it, on every
// change to a road. So the viewer's copy is split once: square tiles around
// what the roads clear, each cut and meshed on its own, and the rest, meshed
// once. A change only cuts and meshes again the tiles whose part of the hole
// changed. Splitting again takes two cuts of the whole surface, so the tiles
// next to the ones a road reaches come in too, and a road moved a little
// stays inside them. The seams are walls inside the solid, which the view
// never shows but an export would carry, so exports cut the whole surface in
// one go.

import { cutSurface } from '../dsm/model';
import { boxesOverlap, difference, dropSmall, intersection, offsetPolygons, rectangle, union, type Box } from '../geometry/polygon';
import type { CapSolid, HeightFn, Layer, PrismSolid } from '../geometry/solid';
import { clipTin, type Tin } from '../geometry/tinclip';
import type { MeshPart, MultiPolygon } from '../types';
import { TileGrid } from './roads';

// Holes smaller than this are rounding where a road's corridor met the water.
const SPECK_MM2 = 1e-3;
// How far the hole grows, to join cells meeting at a corner.
const JOIN_MM = 0.005;
// Tiles are taken this far around a hole, so it never touches their outline.
const MARGIN_MM = 1;
// Tiles are a sixteenth of the area's side, within these.
const TILE_MM: [number, number] = [6, 15];

interface Tile {
  region: MultiPolygon;
  box: Box;
  tin: Tin;
  /** Its piece of the hole when it was last meshed, and the mesh. */
  signature?: string;
  mesh?: MeshPart;
}

export class SurfaceCut {
  private readonly grid: TileGrid;
  private readonly cap: CapSolid;
  /** The tiles the view's copy is split into, and the mesh of the rest. */
  private tiles = new Map<number, Tile>();
  /** Every tile index taken, those outside the area too. */
  private taken = new Set<number>();
  private rest: MeshPart | null = null;
  private holeCache: { signature: string; hole: MultiPolygon } | null = null;

  constructor(
    private readonly city: Layer,
    private readonly crop: MultiPolygon,
    /** Cut water, which has no surface to clear. */
    private readonly water: MultiPolygon,
    /** The bare ground, for the fill. */
    private readonly ground: HeightFn,
    private readonly drape: number,
  ) {
    const cap = city.solids.find((solid): solid is CapSolid => solid.kind === 'cap');
    if (!cap) throw new Error('The surface has no cap to cut');
    this.cap = cap;
    const box = boundsOf(crop);
    const side = Math.max(box[2] - box[0], box[3] - box[1]);
    this.grid = new TileGrid(box, Math.min(TILE_MM[1], Math.max(TILE_MM[0], side / 16)));
  }

  /** What the cleared pieces cut, keyed by their signature. Empty when it's all water or specks. */
  hole(pieces: MultiPolygon, signature: string): MultiPolygon {
    if (this.holeCache?.signature === signature) return this.holeCache.hole;
    // Cleared cells meeting only at a corner pinch the surface left between
    // them, and cutSurface then pulls the whole surface in by a micron. Grown
    // a little they merge.
    let hole = intersection(offsetPolygons(union(pieces), JOIN_MM, 'miter'), this.crop);
    if (this.water.length) hole = difference(hole, this.water);
    hole = dropSmall(hole, SPECK_MM2);
    this.holeCache = { signature, hole };
    return hole;
  }

  /**
   * The city layer for an export: the whole surface cut, and the fill. Throws
   * when the surface can't be cut. Not kept, since it's as big as the surface.
   */
  layer(hole: MultiPolygon): Layer {
    const tin = cutSurface(this.cap, difference(this.crop, hole), this.crop);
    const solids = this.city.solids.flatMap((solid) => (solid === this.cap ? [...this.withTin(tin), ...this.fill(hole)] : [solid]));
    return { ...this.city, solids };
  }

  /** The city part for the viewer. Throws when the surface can't be cut. */
  async view(hole: MultiPolygon, mesh: (layer: Layer) => Promise<MeshPart>): Promise<MeshPart> {
    await this.splitFor(hole, mesh);
    const boxes = hole.map((polygon) => boundsOf([polygon]));
    const parts: MeshPart[] = [this.rest!];
    for (const tile of this.tiles.values()) {
      const near = hole.filter((_, i) => boxesOverlap(boxes[i], tile.box));
      const piece = near.length ? intersection(near, tile.region) : [];
      const signature = JSON.stringify(piece);
      if (tile.signature !== signature || !tile.mesh) {
        const tin = piece.length ? cut(tile.tin, difference(tile.region, piece), tile.region) : tile.tin;
        tile.mesh = await mesh({ ...this.city, solids: [...this.withTin(tin), ...this.fill(piece)] });
        tile.signature = signature;
      }
      parts.push(tile.mesh);
    }
    return joined(parts);
  }

  private fill(hole: MultiPolygon): PrismSolid[] {
    return hole.map((polygon) => ({ kind: 'prism', role: 'terrain', polygon, top: this.ground, bottom: this.cap.bottom, drape: this.drape }));
  }

  private withTin(tin: Tin): CapSolid[] {
    return tin.triangles.length ? [{ ...this.cap, vertices: tin.vertices, triangles: tin.triangles }] : [];
  }

  /** The surface split at the tiles around the hole, split again when the hole reaches past them. */
  private async splitFor(hole: MultiPolygon, mesh: (layer: Layer) => Promise<MeshPart>): Promise<void> {
    const wanted = new Set(this.taken);
    for (const polygon of hole) {
      const [x0, y0, x1, y1] = boundsOf([polygon]);
      for (const tile of this.grid.tilesTouching([x0 - MARGIN_MM, y0 - MARGIN_MM, x1 + MARGIN_MM, y1 + MARGIN_MM])) wanted.add(tile);
    }
    if (this.rest && wanted.size === this.taken.size) return;
    for (const tile of [...wanted]) for (const next of this.grid.around(tile)) wanted.add(next);
    this.closeCorners(wanted);
    const rects = new Map([...wanted].map((tile) => [tile, intersection(rectangle(...this.grid.rect(tile)), this.crop)]));
    const region = union(...rects.values());
    const others = this.city.solids.filter((solid) => solid !== this.cap);
    const outside = difference(this.crop, region);
    const restTin = outside.length ? cut(this.cap, outside, this.crop) : null;
    const rest = await mesh({ ...this.city, solids: restTin ? [...this.withTin(restTin), ...others] : others });
    // Each tile from the triangles near it, so it doesn't take a pass over the whole surface.
    const near = cut(this.cap, region, this.crop);
    const tiles = new Map<number, Tile>();
    for (const [index, tileRegion] of rects) {
      const known = this.tiles.get(index);
      if (known) {
        tiles.set(index, known);
        continue;
      }
      if (!tileRegion.length) continue;
      const box = boundsOf(tileRegion);
      const part = trianglesIn(near, box);
      tiles.set(index, { region: tileRegion, box, tin: part.triangles.length ? cut(part, tileRegion, tileRegion) : part });
    }
    // All together once nothing can throw: the rest with the old tiles leaves a band of the surface out.
    this.rest = rest;
    this.tiles = tiles;
    this.taken = wanted;
  }

  /** Tiles meeting only at a corner would pinch the region there, so one of the tiles beside both joins in. */
  private closeCorners(tiles: Set<number>): void {
    const { cols, rows } = this.grid;
    for (let changed = true; changed; ) {
      changed = false;
      for (const tile of [...tiles]) {
        const c = tile % cols;
        const r = Math.floor(tile / cols);
        for (const dc of [-1, 1]) {
          const rr = r + 1;
          const cc = c + dc;
          if (rr >= rows || cc < 0 || cc >= cols || !tiles.has(rr * cols + cc)) continue;
          if (tiles.has(r * cols + cc) || tiles.has(rr * cols + c)) continue;
          tiles.add(r * cols + cc);
          changed = true;
        }
      }
    }
  }
}

/** cutSurface, but empty where the region misses the surface (a tile of cut water) rather than failing. */
function cut(tin: Tin, region: MultiPolygon, shape: MultiPolygon): Tin {
  try {
    return cutSurface(tin, region, shape);
  } catch (error) {
    const plain = clipTin(tin, region);
    if (plain && !plain.triangles.length) return plain;
    throw error;
  }
}

function boundsOf(polygons: MultiPolygon): Box {
  const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const polygon of polygons) {
    for (const [x, y] of polygon[0]) {
      box[0] = Math.min(box[0], x);
      box[1] = Math.min(box[1], y);
      box[2] = Math.max(box[2], x);
      box[3] = Math.max(box[3], y);
    }
  }
  return box;
}

/** The triangles of a TIN whose boxes overlap `box`, as a TIN of their own. */
function trianglesIn(tin: Tin, box: Box): Tin {
  const v = tin.vertices;
  const f = tin.triangles;
  const index = new Int32Array(v.length / 3).fill(-1);
  const points: number[] = [];
  const out: number[] = [];
  for (let t = 0; t < f.length; t += 3) {
    const a = 3 * f[t];
    const b = 3 * f[t + 1];
    const c = 3 * f[t + 2];
    if (Math.max(v[a], v[b], v[c]) < box[0] || Math.min(v[a], v[b], v[c]) > box[2] || Math.max(v[a + 1], v[b + 1], v[c + 1]) < box[1] || Math.min(v[a + 1], v[b + 1], v[c + 1]) > box[3]) continue;
    for (let k = 0; k < 3; k++) {
      const p = f[t + k];
      if (index[p] < 0) {
        index[p] = points.length / 3;
        points.push(v[3 * p], v[3 * p + 1], v[3 * p + 2]);
      }
      out.push(index[p]);
    }
  }
  return { vertices: Float64Array.from(points), triangles: Uint32Array.from(out) };
}

function joined(parts: MeshPart[]): MeshPart {
  let vertices = 0;
  let indices = 0;
  for (const part of parts) {
    vertices += part.positions.length;
    indices += part.indices.length;
  }
  const positions = new Float32Array(vertices);
  const out = new Uint32Array(indices);
  let v = 0;
  let i = 0;
  for (const part of parts) {
    positions.set(part.positions, v);
    const offset = v / 3;
    for (let k = 0; k < part.indices.length; k++) out[i + k] = part.indices[k] + offset;
    v += part.positions.length;
    i += part.indices.length;
  }
  return { ...parts[0], positions, indices: out };
}
