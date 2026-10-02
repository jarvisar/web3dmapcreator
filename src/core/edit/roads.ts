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
// Edits can cover a range of a segment (blocks.ts). Pieces are cut where a
// range ends, by where their points lie along the segment, and each stretch
// takes the edit of the narrowest range holding it. A stretch with a colour
// or height of its own ends flat where it was cut, not in a round cap
// pushing into the next block.
//
// Every road gives way to an imported route, as in the pipeline, unless the
// route is removed. Over water a road gets ground kept under it like any
// other (earth.ts), or with supports off it's built down through the water
// (pipeline/wading.ts).

import type { Rect64 } from 'clipper2-ts';
import { boxesOverlap, bufferLines, ClipSet, clipToUnits, difference, differenceSet, dropSmall, intersection, multiBounds, SCALE, separateTouching, splitToTiles, union, type Box } from '../geometry/polygon';
import { Progress } from '../pipeline/context';
import { bufferRoads, type RoadGroup, type RoadPiece } from '../pipeline/roads';
import type { ModelSettings } from '../settings';
import type { TrackGround } from '../pipeline/generate';
import type { MultiPolygon, Vec2 } from '../types';
import { parseRoadKey, roadSegment } from './blocks';

export const ROAD_PARTS: Record<RoadGroup, string> = { road: 'roads', rail: 'rail', path: 'paths' };
const GROUPS: RoadGroup[] = ['road', 'rail', 'path'];

export interface RoadStyle {
  removed?: boolean;
  layer?: string;
  heightMm?: number;
  widthMm?: number;
}

interface StyledRange {
  from: number;
  to: number;
  style: RoadStyle;
}

/** Road styles by edit key, with each segment's ranges widest first. */
export class RoadStyles {
  private readonly segments = new Map<string, StyledRange[]>();

  constructor(readonly byKey: ReadonlyMap<string, RoadStyle>) {
    for (const [key, style] of byKey) {
      const range = parseRoadKey(key);
      if (!range) continue;
      let list = this.segments.get(range.segment);
      if (!list) this.segments.set(range.segment, (list = []));
      list.push({ from: range.from, to: range.to, style });
    }
    for (const list of this.segments.values()) list.sort((a, b) => b.to - b.from - (a.to - a.from) || a.from - b.from);
  }

  get(key: string): RoadStyle | undefined {
    return this.byKey.get(key);
  }

  ranges(segment: string): readonly StyledRange[] {
    return this.segments.get(segment) ?? [];
  }
}

/** A stretch of a piece with the style that applies to it, and which of its ends were cut. */
interface StyledPiece {
  piece: RoadPiece;
  style: RoadStyle | undefined;
  /** Its start and its end, cut where a range ends rather than the piece's own. */
  cut: [boolean, boolean];
}

const AT_EPSILON = 1e-9;

function mergeStyles(ranges: readonly StyledRange[], from: number, to: number): RoadStyle | undefined {
  let out: RoadStyle | undefined;
  for (const range of ranges) {
    if (range.from > from + 1e-7 || range.to < to - 1e-7) continue;
    out = { ...out, ...range.style };
  }
  return out;
}

/**
 * A piece cut where the ranges of its segment end, each stretch with its
 * style. A piece no range ends within comes back as itself.
 */
export function styledPieces(piece: RoadPiece, ranges: readonly StyledRange[]): StyledPiece[] {
  const measure = piece.measure;
  if (!ranges.length) return [{ piece, style: undefined, cut: [false, false] }];
  if (!measure || measure.length !== piece.points.length) return [{ piece, style: mergeStyles(ranges, 0, 1), cut: [false, false] }];
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of measure) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const cuts = new Set<number>();
  for (const range of ranges) for (const v of [range.from, range.to]) if (v > lo + 1e-7 && v < hi - 1e-7) cuts.add(v);
  const bounds = [lo, ...[...cuts].sort((a, b) => a - b), hi];
  // Stretches between the cuts, neighbours with the same style together.
  const stretches: { from: number; to: number; style: RoadStyle | undefined }[] = [];
  for (let i = 1; i < bounds.length; i++) {
    const style = mergeStyles(ranges, bounds[i - 1], bounds[i]);
    const last = stretches[stretches.length - 1];
    if (last && JSON.stringify(last.style) === JSON.stringify(style)) last.to = bounds[i];
    else stretches.push({ from: bounds[i - 1], to: bounds[i], style });
  }
  if (stretches.length === 1) return [{ piece, style: stretches[0].style, cut: [false, false] }];
  const out: StyledPiece[] = [];
  for (const stretch of stretches) {
    for (const run of sliceByMeasure(piece.points, measure, stretch.from, stretch.to)) {
      out.push({ piece: { ...piece, points: run.points, measure: run.measure }, style: stretch.style, cut: run.cut });
    }
  }
  return out;
}

/** The runs of a line whose measure is within [from, to], with which of their ends are cuts. */
function sliceByMeasure(points: Vec2[], measure: number[], from: number, to: number): { points: Vec2[]; measure: number[]; cut: [boolean, boolean] }[] {
  const out: { points: Vec2[]; measure: number[]; cut: [boolean, boolean] }[] = [];
  let run: { points: Vec2[]; measure: number[]; cut: [boolean, boolean] } | null = null;
  const close = (endCut: boolean) => {
    if (run && run.points.length >= 2) {
      run.cut[1] = endCut;
      out.push(run);
    }
    run = null;
  };
  const last = points.length - 2;
  for (let i = 0; i <= last; i++) {
    const a = measure[i];
    const b = measure[i + 1];
    let t0: number;
    let t1: number;
    if (Math.abs(b - a) < AT_EPSILON) {
      const inside = a >= from - 1e-7 && a <= to + 1e-7;
      t0 = inside ? 0 : 1;
      t1 = inside ? 1 : 0;
    } else {
      const tf = (from - a) / (b - a);
      const tt = (to - a) / (b - a);
      t0 = Math.max(0, Math.min(tf, tt));
      t1 = Math.min(1, Math.max(tf, tt));
    }
    if (t1 - t0 < AT_EPSILON) {
      close(true);
      continue;
    }
    const at = (t: number): Vec2 => [points[i][0] + (points[i + 1][0] - points[i][0]) * t, points[i][1] + (points[i + 1][1] - points[i][1]) * t];
    if (!run || t0 > AT_EPSILON) {
      close(true);
      run = { points: [at(t0)], measure: [a + (b - a) * t0], cut: [!(i === 0 && t0 <= AT_EPSILON), false] };
    }
    const current = run as { points: Vec2[]; measure: number[] };
    current.points.push(at(t1));
    current.measure.push(a + (b - a) * t1);
    if (t1 < 1 - AT_EPSILON) close(true);
  }
  close(false);
  return out;
}

/**
 * Where a bucket's ribbons may reach: round past a piece's own ends, flat at
 * its cuts. Wide enough for the strips filled between lines beside it.
 */
function endMask(pieces: readonly StyledPiece[], margin: number): MultiPolygon {
  const butt: { points: Vec2[]; width: number }[] = [];
  const round: { points: Vec2[]; width: number }[] = [];
  for (const { piece, cut } of pieces) {
    const width = piece.widthMm + 2 * margin;
    if (!cut[0] && !cut[1]) {
      round.push({ points: piece.points, width });
      continue;
    }
    butt.push({ points: piece.points, width });
    // A dot for each end of its own, the round cap the ribbon has there.
    const ends: [Vec2, Vec2][] = [];
    if (!cut[0]) ends.push([piece.points[0], piece.points[1]]);
    if (!cut[1]) ends.push([piece.points[piece.points.length - 1], piece.points[piece.points.length - 2]]);
    for (const [end, next] of ends) {
      const length = Math.hypot(next[0] - end[0], next[1] - end[1]) || 1;
      round.push({ points: [end, [end[0] + ((next[0] - end[0]) / length) * 1e-4, end[1] + ((next[1] - end[1]) / length) * 1e-4]], width });
    }
  }
  return union(bufferLines(butt, 'butt'), bufferLines(round, 'round'));
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

  constructor(cropBox: Box, sizeMm = tileSizeMm(cropBox)) {
    this.step = Math.round(sizeMm * SCALE);
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
  private readonly cutBoxes: Box[];

  constructor(
    readonly pieces: RoadPiece[],
    private readonly base: Map<string, MultiPolygon>,
    crop: MultiPolygon,
    cropBox: Box,
    private readonly settings: ModelSettings,
    /** Routes the roads give way to. */
    private readonly cuts: TrackGround[] = [],
  ) {
    super(cropBox);
    this.crop = new ClipSet([crop]);
    this.cutBoxes = cuts.map((cut) => multiBounds(cut.pieces));
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

  /** Tiles that a road's ribbon reaches, as it was and as `style` has it, or a route's. A range reaches the pieces lying along it. */
  tilesOf(key: string, style: RoadStyle | undefined): number[] {
    const cut = this.cuts.findIndex((c) => c.key === key);
    if (cut >= 0) return this.tilesTouching(this.cutBoxes[cut]);
    const out = new Set<number>();
    const gap = this.settings.roads.gapMm;
    const range = parseRoadKey(key);
    for (const i of this.bySegment.get(roadSegment(key)) ?? []) {
      const measure = this.pieces[i].measure;
      if (range && measure && (Math.max(...measure) < range.from - 1e-7 || Math.min(...measure) > range.to + 1e-7)) continue;
      const width = Math.max(this.pieces[i].widthMm, style?.widthMm ?? 0);
      const reach = width / 2 + gap + REACH_MM;
      const b = i * 4;
      const box: Box = [this.boxes[b] - reach, this.boxes[b + 1] - reach, this.boxes[b + 2] + reach, this.boxes[b + 3] + reach];
      for (const tile of this.tilesTouching(box)) out.add(tile);
    }
    return [...out];
  }

  /** Road keys, whole segments or ranges, with pieces in the model. */
  has(key: string): boolean {
    return this.bySegment.has(roadSegment(key));
  }

  /** Route keys the roads gave way to. */
  hasCut(key: string): boolean {
    return this.cuts.some((cut) => cut.key === key);
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
  async tile(tile: number, styles: RoadStyles): Promise<RoadBucket[]> {
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
    const special = new Map<string, { part: string; thickness: number; pieces: RoadPiece[]; styled: StyledPiece[]; cut: boolean }>();
    for (const i of this.near.get(tile) ?? []) {
      for (const styled of styledPieces(this.pieces[i], styles.ranges(`r:${this.pieces[i].sourceId}`))) {
        const { piece, style } = styled;
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
        let bucket = special.get(id);
        if (!bucket) special.set(id, (bucket = { part, thickness: height, pieces: [], styled: [], cut: false }));
        bucket.pieces.push(sized);
        bucket.styled.push({ ...styled, piece: sized });
        if (styled.cut[0] || styled.cut[1]) bucket.cut = true;
      }
    }

    const out: RoadBucket[] = [];
    const ctx = { settings: this.settings, cropSet: wide, progress: new Progress(), stats: {} };
    // Routes still in the model near the tile, which every road gives way to.
    const near: Box = [(rect.left - margin) / SCALE, (rect.top - margin) / SCALE, (rect.right + margin) / SCALE, (rect.bottom + margin) / SCALE];
    const routes = this.cuts.filter((cut, i) => !styles.get(cut.key)?.removed && boxesOverlap(this.cutBoxes[i], near)).flatMap((cut) => cut.pieces);
    const cut = routes.length ? new ClipSet([routes]) : null;
    const add = (part: string, thickness: number, polygons: MultiPolygon) => {
      if (cut) polygons = separateTouching(dropSmall(differenceSet(polygons, cut), 0.02));
      const kept = clipToUnits(polygons, rect);
      if (kept.length) out.push({ part, thickness, polygons: kept });
    };
    // Taller roads own their ground where two meet. Each bucket is buffered
    // like the pipeline does, cracks between its own lines filled.
    const ordered = [...special.values()].sort((a, b) => b.thickness - a.thickness || a.part.localeCompare(b.part));
    let owned: MultiPolygon = [];
    for (const bucket of ordered) {
      let polygons = (await bufferRoads(bucket.pieces, ctx)).footprint;
      if (bucket.cut) polygons = intersection(polygons, endMask(bucket.styled, this.settings.roads.gapMm + REACH_MM / 10));
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
