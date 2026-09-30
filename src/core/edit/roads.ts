// Editing roads. Each road group is one unioned polygon set, and a city's
// streets are usually one polygon, so a removed or widened street can't be
// cut out of it on its own. Once a road is edited the groups are split into
// square tiles, and a tile any edited road reaches is rebuilt from the road
// pieces by the same bufferRoads the pipeline uses, laid a millimetre past
// the tile and cut to it. Other tiles keep the generated polygons, cut to
// the tile. Tile edges fall on whole Clipper units, so neighbours meet
// exactly.
//
// A road with its own height or layer owns its ground: the plain groups
// give way to it, and the taller of two such roads wins where they cross.
// Over water a road gets ground kept under it like any other (earth.ts), or
// with supports off it's built down through the water (pipeline/wading.ts).

import type { Rect64 } from 'clipper2-ts';
import { ClipSet, clipToUnits, difference, dropSmall, SCALE, separateTouching, splitToTiles, union, type Box } from '../geometry/polygon';
import { Progress } from '../pipeline/context';
import { bufferRoads, type RoadGroup, type RoadPiece } from '../pipeline/roads';
import type { ModelSettings } from '../settings';
import type { MultiPolygon } from '../types';

export const ROAD_PARTS: Record<RoadGroup, string> = { road: 'roads', rail: 'rail', path: 'paths' };
const GROUPS: RoadGroup[] = ['road', 'rail', 'path'];

export interface RoadStyle {
  removed?: boolean;
  layer?: string;
  heightMm?: number;
  widthMm?: number;
}

/** What one tile holds of a part at one thickness. */
export interface RoadBucket {
  /** 'roads', 'rail', 'paths', or a custom layer's 'layer:<id>'. */
  part: string;
  thickness: number;
  polygons: MultiPolygon;
}

// Ribbons reach this far past their centreline beyond half their width
// (gap strips, rounding), so a tile looks at pieces this much past its edges.
const REACH_MM = 1;
// Tiles are laid this far past their edges and cut to them after.
const TILE_MARGIN_MM = 1;
const MAX_WIDTH_MM = 12;

export function tileSizeMm(cropBox: Box): number {
  const side = Math.max(cropBox[2] - cropBox[0], cropBox[3] - cropBox[1]);
  return Math.min(30, Math.max(12, side / 8));
}

/** The square tiles road edits and land fills are worked out in. */
export class TileGrid {
  readonly step: number;
  readonly left: number;
  readonly top: number;
  readonly cols: number;
  readonly rows: number;

  constructor(cropBox: Box) {
    this.step = Math.round(tileSizeMm(cropBox) * SCALE);
    this.left = Math.floor(cropBox[0] * SCALE);
    this.top = Math.floor(cropBox[1] * SCALE);
    this.cols = Math.max(1, Math.ceil((Math.ceil(cropBox[2] * SCALE) - this.left) / this.step));
    this.rows = Math.max(1, Math.ceil((Math.ceil(cropBox[3] * SCALE) - this.top) / this.step));
  }

  /** The tile's square in Clipper units. */
  units(tile: number): Rect64 {
    const c = tile % this.cols;
    const r = Math.floor(tile / this.cols);
    const left = this.left + c * this.step;
    const top = this.top + r * this.step;
    return { left, top, right: left + this.step, bottom: top + this.step };
  }

  /** The tile's square in mm. */
  rect(tile: number): Box {
    const u = this.units(tile);
    return [u.left / SCALE, u.top / SCALE, u.right / SCALE, u.bottom / SCALE];
  }

  get count(): number {
    return this.cols * this.rows;
  }

  /** The tile and the ones next to it, diagonals too. */
  around(tile: number): number[] {
    const c = tile % this.cols;
    const r = Math.floor(tile / this.cols);
    const out: number[] = [];
    for (let rr = Math.max(0, r - 1); rr <= Math.min(this.rows - 1, r + 1); rr++) {
      for (let cc = Math.max(0, c - 1); cc <= Math.min(this.cols - 1, c + 1); cc++) out.push(rr * this.cols + cc);
    }
    return out;
  }

  tilesTouching(box: Box): number[] {
    const c0 = Math.max(0, Math.floor((box[0] * SCALE - this.left) / this.step));
    const r0 = Math.max(0, Math.floor((box[1] * SCALE - this.top) / this.step));
    const c1 = Math.min(this.cols - 1, Math.floor((box[2] * SCALE - this.left) / this.step));
    const r1 = Math.min(this.rows - 1, Math.floor((box[3] * SCALE - this.top) / this.step));
    const out: number[] = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push(r * this.cols + c);
    return out;
  }
}

export class RoadTiles extends TileGrid {
  private readonly boxes: Float64Array;
  private readonly bySegment = new Map<string, number[]>();
  /** Pieces by the tiles their box reaches, with room for the widest edited ribbon. */
  private readonly near = new Map<number, number[]>();
  /** The generated road polygons cut into tiles, made the first time a tile is asked for. */
  private baseTiles: Map<number, RoadBucket[]> | null = null;
  private readonly crop: ClipSet;

  constructor(
    readonly pieces: RoadPiece[],
    private readonly base: Map<string, MultiPolygon>,
    crop: MultiPolygon,
    cropBox: Box,
    private readonly settings: ModelSettings,
  ) {
    super(cropBox);
    this.crop = new ClipSet([crop]);
    this.boxes = new Float64Array(pieces.length * 4);
    const reach = MAX_WIDTH_MM / 2 + settings.roads.gapMm + REACH_MM;
    pieces.forEach((piece, i) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [x, y] of piece.points) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      this.boxes.set([minX, minY, maxX, maxY], i * 4);
      const key = `r:${piece.sourceId}`;
      const list = this.bySegment.get(key);
      if (list) list.push(i);
      else this.bySegment.set(key, [i]);
      for (const tile of this.tilesTouching([minX - reach, minY - reach, maxX + reach, maxY + reach])) {
        const cell = this.near.get(tile);
        if (cell) cell.push(i);
        else this.near.set(tile, [i]);
      }
    });
  }

  /** Tiles that a road's ribbon reaches, as it was and as `style` has it. */
  tilesOf(key: string, style: RoadStyle | undefined): number[] {
    const out = new Set<number>();
    const gap = this.settings.roads.gapMm;
    for (const i of this.bySegment.get(key) ?? []) {
      const width = Math.max(this.pieces[i].widthMm, style?.widthMm ?? 0);
      const reach = width / 2 + gap + REACH_MM;
      const b = i * 4;
      const box: Box = [this.boxes[b] - reach, this.boxes[b + 1] - reach, this.boxes[b + 2] + reach, this.boxes[b + 3] + reach];
      for (const tile of this.tilesTouching(box)) out.add(tile);
    }
    return [...out];
  }

  /** Segment keys with pieces in the model. */
  has(key: string): boolean {
    return this.bySegment.has(key);
  }

  /** What the generated model has in a tile. */
  baseTile(tile: number): RoadBucket[] {
    if (!this.baseTiles) {
      this.baseTiles = new Map();
      const thickness = this.settings.roads.thicknessMm;
      for (const [part, polygons] of this.base) {
        for (const [index, pieces] of splitToTiles(polygons, this.left, this.top, this.step, this.cols, this.rows)) {
          const list = this.baseTiles.get(index);
          const bucket = { part, thickness, polygons: pieces };
          if (list) list.push(bucket);
          else this.baseTiles.set(index, [bucket]);
        }
      }
    }
    return this.baseTiles.get(tile) ?? [];
  }

  /** The tile rebuilt from the pieces, with each road's style. */
  async tile(tile: number, styleOf: (key: string) => RoadStyle | undefined): Promise<RoadBucket[]> {
    const rect = this.units(tile);
    if (!this.crop.polygonsWithinRect(rect).length) return [];
    // Laid a little past the tile and cut to it at the end. Cut first, the
    // corner of a motorway entering the model just above a tile edge was
    // 0.0197 mm² in the tile, under bufferRoads' 0.02 mm² specks, and went
    // whenever that tile was rebuilt.
    const margin = Math.round(TILE_MARGIN_MM * SCALE);
    const wide = this.crop.polygonsWithinRect({ left: rect.left - margin, top: rect.top - margin, right: rect.right + margin, bottom: rect.bottom + margin });
    const thickness = this.settings.roads.thicknessMm;
    const plain: RoadPiece[] = [];
    // Everything there in the pipeline's order, which the crack strips depend on.
    const all: RoadPiece[] = [];
    const special = new Map<string, { part: string; thickness: number; pieces: RoadPiece[] }>();
    for (const i of this.near.get(tile) ?? []) {
      const piece = this.pieces[i];
      const style = styleOf(`r:${piece.sourceId}`);
      if (style?.removed) continue;
      const sized = style?.widthMm !== undefined ? { ...piece, widthMm: style.widthMm } : piece;
      all.push(sized);
      const height = style?.heightMm ?? thickness;
      if (!style?.layer && Math.abs(height - thickness) < 1e-9) {
        plain.push(sized);
        continue;
      }
      const part = style?.layer ? `layer:${style.layer}` : ROAD_PARTS[piece.group];
      const id = `${part}|${height}`;
      const bucket = special.get(id);
      if (bucket) bucket.pieces.push(sized);
      else special.set(id, { part, thickness: height, pieces: [sized] });
    }

    const out: RoadBucket[] = [];
    const ctx = { settings: this.settings, cropSet: wide, progress: new Progress(), stats: {} };
    const add = (part: string, thickness: number, polygons: MultiPolygon) => {
      const kept = clipToUnits(polygons, rect);
      if (kept.length) out.push({ part, thickness, polygons: kept });
    };
    // Taller roads own their ground where two meet. Each bucket is buffered
    // like the pipeline does, cracks between its own lines filled.
    const ordered = [...special.values()].sort((a, b) => b.thickness - a.thickness || a.part.localeCompare(b.part));
    let owned: MultiPolygon = [];
    for (const bucket of ordered) {
      let polygons = (await bufferRoads(bucket.pieces, ctx)).footprint;
      if (owned.length) polygons = difference(polygons, owned);
      polygons = separateTouching(dropSmall(polygons, 0.02));
      if (!polygons.length) continue;
      owned = union(owned, polygons);
      add(bucket.part, bucket.thickness, polygons);
    }

    // The plain groups keep what's left of every road there buffered
    // together, so cracks filled between an edited road and its neighbours
    // stay filled, in the plain colour. Buffered without the edited roads,
    // giving one a colour of its own opened those cracks again, as bare
    // ground or water.
    if (all.length) {
      const ribbons = await bufferRoads(all, ctx);
      for (const group of GROUPS) {
        let polygons = ribbons[group];
        if (owned.length) polygons = difference(polygons, owned);
        add(ROAD_PARTS[group], thickness, separateTouching(dropSmall(polygons, 0.02)));
      }
    }
    return out;
  }
}
