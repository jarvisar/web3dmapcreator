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
// A road in a custom layer is printed as mapped, not as tidied: someone
// picked it out, so it shouldn't come out merged onto the middle of its
// divided road, cut where it doubled another, or pulled onto a neighbour.
// Its stretches are drawn from the pieces as they were before the tidy
// (`MappedRoads`), and a merged line it was part of gives the other
// carriageway back too, in that one's own style. The roads around it keep
// their tidy. With no road in a layer nothing here changes.
//
// Every road gives way to an imported route, as in the pipeline, unless the
// route is removed, and to a road drawn in the editor on the ground (`cuts`
// in RoadStyles). Over water a road gets ground kept under it like any
// other (earth.ts), or with supports off it's built down through the water
// (pipeline/wading.ts).

import type { Rect64 } from 'clipper2-ts';
import { boxesOverlap, bufferLines, ClipSet, clipToUnits, difference, differenceSet, dropSmall, intersection, multiBounds, pointInMulti, SCALE, separateTouching, splitToTiles, union, type Box } from '../geometry/polygon';
import type { DeckPiece } from '../pipeline/bridges';
import { Progress } from '../pipeline/context';
import { measurePoints, type SegmentLine } from '../pipeline/measure';
import { bufferRoads, type RoadGroup, type RoadPiece } from '../pipeline/roads';
import type { ModelSettings } from '../settings';
import type { TrackGround } from '../pipeline/generate';
import type { MultiPolygon, Vec2 } from '../types';
import { carryEdit, parseRoadKey, roadSegment } from './blocks';

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

/** Road styles by edit key, with each segment's ranges widest first, and what drawn roads take from them. */
export class RoadStyles {
  private readonly segments = new Map<string, StyledRange[]>();
  readonly cuts: { polygons: MultiPolygon; box: Box }[];

  constructor(
    readonly byKey: ReadonlyMap<string, RoadStyle>,
    /** Footprints of drawn roads on the ground, by shape key. */
    cuts: ReadonlyMap<string, MultiPolygon> = new Map(),
  ) {
    this.cuts = [...cuts.values()].filter((polygons) => polygons.length).map((polygons) => ({ polygons, box: multiBounds(polygons) }));
    for (const [key, style] of byKey) {
      const range = parseRoadKey(key);
      if (!range) continue;
      let list = this.segments.get(range.segment);
      if (!list) this.segments.set(range.segment, (list = []));
      list.push({ from: range.from, to: range.to, style });
    }
    for (const list of this.segments.values()) list.sort((a, b) => b.to - b.from - (a.to - a.from) || a.from - b.from);
    this.hasLayers = [...byKey].some(([key, style]) => key.startsWith('r:') && !!style.layer);
  }

  /** Whether any road is in a custom layer. */
  readonly hasLayers: boolean;

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
    // Looser than the cuts, so a stretch cut at a vertex just short of a range's end is still held by it.
    if (range.from > from + 1e-6 || range.to < to - 1e-6) continue;
    out = { ...out, ...range.style };
  }
  return out;
}

/**
 * A piece cut where the ranges of its segment end, each stretch with its
 * style. A divided road's merged line lies along the other carriageway's
 * segment too (`partner`), and is cut where that one's ranges end as well:
 * its colour, width and height fill in wherever the piece's own edits leave
 * them. Not its removal, since the merged line stands for both
 * carriageways, and the other one taken out leaves this one. A piece no
 * range ends within comes back as itself.
 */
export function styledPieces(piece: RoadPiece, ranges: readonly StyledRange[], partnerRanges: readonly StyledRange[] = []): StyledPiece[] {
  const n = piece.points.length;
  const own = piece.measure?.length === n ? piece.measure : null;
  const other = partnerRanges.length && piece.partnerMeasure?.length === n ? piece.partnerMeasure : null;
  if (!ranges.length && !other) return [{ piece, style: undefined, cut: [false, false] }];
  if (!own) return [{ piece, style: combine(mergeStyles(ranges, 0, 1), undefined), cut: [false, false] }];
  // Distance along the piece, which both measures are cut by.
  const along = [0];
  for (let i = 1; i < n; i++) along.push(along[i - 1] + Math.hypot(piece.points[i][0] - piece.points[i - 1][0], piece.points[i][1] - piece.points[i - 1][1]));
  const length = along[n - 1];
  const cuts: number[] = [];
  const cutAt = (measure: number[], list: readonly StyledRange[]) => {
    for (const range of list) {
      for (const v of [range.from, range.to]) {
        // A range ending on a vertex (a junction often is one) is cut there.
        // The spans either side both leave it out as one of their ends.
        for (let i = 1; i < n - 1; i++) if (Math.abs(measure[i] - v) <= 1e-7) cuts.push(along[i]);
        for (let i = 1; i < n; i++) {
          const a = measure[i - 1];
          const b = measure[i];
          if (Math.abs(b - a) < AT_EPSILON || v <= Math.min(a, b) + 1e-7 || v >= Math.max(a, b) - 1e-7) continue;
          cuts.push(along[i - 1] + ((v - a) / (b - a)) * (along[i] - along[i - 1]));
        }
      }
    }
  };
  cutAt(own, ranges);
  if (other) cutAt(other, partnerRanges);
  const bounds = [0];
  for (const s of cuts.sort((a, b) => a - b)) if (s > 1e-6 && s < length - 1e-6 && s - bounds[bounds.length - 1] > 1e-6) bounds.push(s);
  bounds.push(length);
  // The measures between two distances along the piece, low to high.
  const span = (measure: number[], from: number, to: number): [number, number] => {
    const a = valueAt(along, measure, from);
    const b = valueAt(along, measure, to);
    return a <= b ? [a, b] : [b, a];
  };
  // Stretches between the cuts, neighbours with the same style together.
  const stretches: { from: number; to: number; style: RoadStyle | undefined }[] = [];
  for (let i = 1; i < bounds.length; i++) {
    const style = combine(mergeStyles(ranges, ...span(own, bounds[i - 1], bounds[i])), other ? mergeStyles(partnerRanges, ...span(other, bounds[i - 1], bounds[i])) : undefined);
    const last = stretches[stretches.length - 1];
    if (last && JSON.stringify(last.style) === JSON.stringify(style)) last.to = bounds[i];
    else stretches.push({ from: bounds[i - 1], to: bounds[i], style });
  }
  if (stretches.length === 1) return [{ piece, style: stretches[0].style, cut: [false, false] }];
  return stretches.map((stretch) => ({ piece: slicePiece(piece, along, stretch.from, stretch.to), style: stretch.style, cut: [stretch.from > 0, stretch.to < length] }));
}

/** A piece's own style over the other carriageway's, without that one's removal. */
function combine(own: RoadStyle | undefined, partner: RoadStyle | undefined): RoadStyle | undefined {
  return carryEdit(own, partner);
}

/** Whether a piece's measures reach into [from, to]. */
function overlaps(measure: readonly number[], from: number, to: number): boolean {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of measure) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return hi >= from - 1e-7 && lo <= to + 1e-7;
}

/** A per-point value at a distance along the piece. */
function valueAt(along: number[], values: number[], s: number): number {
  let i = 1;
  while (i < along.length - 1 && along[i] < s) i++;
  const span = along[i] - along[i - 1];
  const t = span > 0 ? Math.max(0, Math.min(1, (s - along[i - 1]) / span)) : 0;
  return values[i - 1] + (values[i] - values[i - 1]) * t;
}

/** The piece between two distances along it, its measures with it. */
function slicePiece(piece: RoadPiece, along: number[], from: number, to: number): RoadPiece {
  const points: Vec2[] = [];
  const at = (s: number) => {
    let i = 1;
    while (i < along.length - 1 && along[i] < s) i++;
    const span = along[i] - along[i - 1];
    return { i, t: span > 0 ? Math.max(0, Math.min(1, (s - along[i - 1]) / span)) : 0 };
  };
  const start = at(from);
  const end = at(to);
  const pointOf = ({ i, t }: { i: number; t: number }): Vec2 => [
    piece.points[i - 1][0] + (piece.points[i][0] - piece.points[i - 1][0]) * t,
    piece.points[i - 1][1] + (piece.points[i][1] - piece.points[i - 1][1]) * t,
  ];
  const valueOf = (values: number[] | undefined, { i, t }: { i: number; t: number }) => (values ? values[i - 1] + (values[i] - values[i - 1]) * t : NaN);
  const measure: number[] = [];
  const partner: number[] = [];
  const push = (p: Vec2, m: number, q: number) => {
    points.push(p);
    measure.push(m);
    partner.push(q);
  };
  push(pointOf(start), valueOf(piece.measure, start), valueOf(piece.partnerMeasure, start));
  for (let k = start.i; k < end.i; k++) {
    if (along[k] <= from || along[k] >= to) continue;
    push(piece.points[k], piece.measure?.[k] ?? NaN, piece.partnerMeasure?.[k] ?? NaN);
  }
  push(pointOf(end), valueOf(piece.measure, end), valueOf(piece.partnerMeasure, end));
  return { ...piece, points, measure: piece.measure ? measure : undefined, partnerMeasure: piece.partnerMeasure ? partner : undefined };
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

  /**
   * Tiles polygons reach, within `margin`: the ones their edges pass through,
   * and the ones wholly inside them. A long diagonal road has a box over
   * nearly every tile, and a 20 mm drawn road can cover a 12 mm tile.
   */
  tilesReached(polygons: MultiPolygon, margin = 0): number[] {
    if (!polygons.length) return [];
    const out = new Set<number>();
    for (const polygon of polygons) {
      for (const ring of polygon) {
        for (let i = 0; i < ring.length; i++) {
          const [ax, ay] = ring[i];
          const [bx, by] = ring[(i + 1) % ring.length];
          for (const tile of this.tilesTouching([Math.min(ax, bx) - margin, Math.min(ay, by) - margin, Math.max(ax, bx) + margin, Math.max(ay, by) + margin])) out.add(tile);
        }
      }
    }
    for (const tile of this.tilesTouching(multiBounds(polygons))) {
      if (out.has(tile)) continue;
      const [x0, y0, x1, y1] = this.rect(tile);
      if (pointInMulti((x0 + x1) / 2, (y0 + y1) / 2, polygons)) out.add(tile);
    }
    return [...out].sort((a, b) => a - b);
  }
}

/** The roads as mapped, before the tidy, and what's needed to place them along their segments. */
export interface MappedRoads {
  pieces: readonly RoadPiece[];
  lines: ReadonlyMap<string, SegmentLine>;
  /** Bridge decks, whose stretches of a segment aren't ground. */
  decks: readonly DeckPiece[];
}

type Intervals = [number, number][];

function joinIntervals(list: Intervals): Intervals {
  const out: Intervals = [];
  for (const [a, b] of [...list].sort((p, q) => p[0] - q[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1e-9) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** `list` less `minus`, both joined. */
function subtractIntervals(list: Intervals, minus: Intervals): Intervals {
  const out: Intervals = [];
  for (const [a, b] of list) {
    let from = a;
    for (const [c, d] of minus) {
      if (d <= from || c >= b) continue;
      if (c > from) out.push([from, c]);
      from = Math.max(from, d);
    }
    if (b - from > 1e-9) out.push([from, b]);
  }
  return out;
}

/** The other carriageway's measure at `v` on this one, from pairs sorted by this one's. */
function across(pairs: readonly [number, number][], v: number): number {
  if (v <= pairs[0][0]) return pairs[0][1];
  for (let k = 1; k < pairs.length; k++) {
    const [a, p] = pairs[k - 1];
    const [b, q] = pairs[k];
    if (v <= b) return b > a ? p + ((v - a) / (b - a)) * (q - p) : q;
  }
  return pairs[pairs.length - 1][1];
}

const within = (list: Intervals, v: number) => list.some(([a, b]) => v >= a - 1e-9 && v <= b + 1e-9);

function extent(values: readonly number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return [lo, hi];
}

function pointsBox(points: readonly Vec2[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/** Where along a piece lying on its segment the segment's measure `v` falls, clamped to the piece. */
function alongAtMeasure(along: readonly number[], measure: readonly number[], v: number): number {
  const n = measure.length;
  const rising = measure[n - 1] >= measure[0];
  if (v <= Math.min(measure[0], measure[n - 1])) return rising ? 0 : along[n - 1];
  if (v >= Math.max(measure[0], measure[n - 1])) return rising ? along[n - 1] : 0;
  for (let i = 1; i < n; i++) {
    const a = measure[i - 1];
    const b = measure[i];
    if (v < Math.min(a, b) || v > Math.max(a, b)) continue;
    return along[i - 1] + (b !== a ? (v - a) / (b - a) : 0) * (along[i] - along[i - 1]);
  }
  return 0;
}

/** The stretches of a piece lying on its segment within measure intervals, with which of their ends were cut. */
function slicesWithin(piece: RoadPiece, intervals: Intervals): { piece: RoadPiece; cut: [boolean, boolean] }[] {
  const measure = piece.measure;
  const n = piece.points.length;
  if (!measure || measure.length !== n || n < 2) return [];
  const along = [0];
  for (let i = 1; i < n; i++) along.push(along[i - 1] + Math.hypot(piece.points[i][0] - piece.points[i - 1][0], piece.points[i][1] - piece.points[i - 1][1]));
  const length = along[n - 1];
  const spans = intervals.map(([a, b]): [number, number] => {
    const p = alongAtMeasure(along, measure, a);
    const q = alongAtMeasure(along, measure, b);
    return [Math.min(p, q), Math.max(p, q)];
  });
  const out: { piece: RoadPiece; cut: [boolean, boolean] }[] = [];
  for (const [s0, s1] of joinIntervals(spans)) {
    if (s1 - s0 <= 1e-6) continue;
    const cut: [boolean, boolean] = [s0 > 1e-6, s1 < length - 1e-6];
    out.push({ piece: cut[0] || cut[1] ? slicePiece(piece, along, s0, s1) : piece, cut });
  }
  return out;
}

/** A piece as mapped, measured along its segment, with its segment's decks taken out: they stay as built. */
export function mappedGround(original: RoadPiece, line: SegmentLine, decks: readonly DeckPiece[] | undefined): RoadPiece[] {
  const piece: RoadPiece = { ...original, measure: measurePoints(original.points, line) };
  if (!decks?.length) return [piece];
  const ground: Intervals = [];
  let from = 0;
  for (const [a, b] of joinIntervals(decks.map((deck) => extent(measurePoints(deck.points, line))))) {
    if (a > from) ground.push([from, a]);
    from = Math.max(from, b);
  }
  if (from < 1) ground.push([from, 1]);
  return slicesWithin(piece, ground).map((slice) => slice.piece);
}

interface MappedIndex {
  /** Pieces as mapped, on segments with a line to measure them along. */
  pieces: RoadPiece[];
  boxes: Box[];
  bySegment: Map<string, number[]>;
  near: Map<number, number[]>;
  /** The two carriageways of every merged line, each by the other. */
  links: Map<string, Set<string>>;
  /** Decks by segment id. */
  decks: Map<string, DeckPiece[]>;
  /** Each piece measured along its segment, decks taken out, worked out when first drawn. */
  ground: (RoadPiece[] | undefined)[];
}

export class RoadTiles extends TileGrid {
  private readonly boxes: Float64Array;
  private readonly bySegment = new Map<string, number[]>();
  /** Merged divided roads by the other carriageway's segment, whose edits they carry. */
  private readonly byPartner = new Map<string, number[]>();
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
    /** The roads before the tidy, when it ran, for roads in custom layers. */
    private readonly mapped?: MappedRoads,
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
      if (piece.partner) {
        const partner = this.byPartner.get(`r:${piece.partner}`);
        if (partner) partner.push(i);
        else this.byPartner.set(`r:${piece.partner}`, [i]);
      }
      for (const tile of this.tilesTouching([minX - reach, minY - reach, maxX + reach, maxY + reach])) {
        const cell = this.near.get(tile);
        if (cell) cell.push(i);
        else this.near.set(tile, [i]);
      }
    });
  }

  private mappedIndex: MappedIndex | null = null;

  /** Built the first time a road is in a custom layer. */
  private mappedRoads(): MappedIndex | null {
    if (this.mappedIndex || !this.mapped) return this.mappedIndex;
    const { lines } = this.mapped;
    const pieces = this.mapped.pieces.filter((piece) => piece.points.length >= 2 && lines.has(piece.sourceId));
    const reach = MAX_WIDTH_MM / 2 + this.settings.roads.gapMm + REACH_MM;
    const index: MappedIndex = { pieces, boxes: [], bySegment: new Map(), near: new Map(), links: new Map(), decks: new Map(), ground: [] };
    pieces.forEach((piece, i) => {
      const box = pointsBox(piece.points);
      index.boxes.push(box);
      const key = `r:${piece.sourceId}`;
      const list = index.bySegment.get(key);
      if (list) list.push(i);
      else index.bySegment.set(key, [i]);
      for (const tile of this.tilesTouching([box[0] - reach, box[1] - reach, box[2] + reach, box[3] + reach])) {
        const cell = index.near.get(tile);
        if (cell) cell.push(i);
        else index.near.set(tile, [i]);
      }
    });
    const link = (a: string, b: string) => {
      const set = index.links.get(a);
      if (set) set.add(b);
      else index.links.set(a, new Set([b]));
    };
    for (const piece of this.pieces) {
      if (!piece.partner) continue;
      link(`r:${piece.sourceId}`, `r:${piece.partner}`);
      link(`r:${piece.partner}`, `r:${piece.sourceId}`);
    }
    for (const deck of this.mapped.decks) {
      if (!deck.key.startsWith('br:') || deck.points.length < 2) continue;
      const id = deck.key.slice(3);
      const list = index.decks.get(id);
      if (list) list.push(deck);
      else index.decks.set(id, [deck]);
    }
    this.mappedIndex = index;
    return index;
  }

  /** A mapped piece's ground stretches, measured along its segment. Decks stay as built. */
  private mappedGround(index: MappedIndex, i: number): RoadPiece[] {
    const known = index.ground[i];
    if (known) return known;
    const piece = index.pieces[i];
    const out = mappedGround(piece, this.mapped!.lines.get(piece.sourceId)!, index.decks.get(piece.sourceId));
    index.ground[i] = out;
    return out;
  }

  /** Tiles that a road's ribbon reaches, as it was and as `style` has it, or a route's. A range reaches the pieces lying along it. */
  tilesOf(key: string, style: RoadStyle | undefined): number[] {
    const cut = this.cuts.find((c) => c.key === key);
    if (cut) return this.tilesReached(cut.pieces);
    const out = new Set<number>();
    const gap = this.settings.roads.gapMm;
    const range = parseRoadKey(key);
    const segment = roadSegment(key);
    const own = (this.bySegment.get(segment) ?? []).map((i) => [i, this.pieces[i].measure] as const);
    const carried = (this.byPartner.get(segment) ?? []).map((i) => [i, this.pieces[i].partnerMeasure] as const);
    for (const [i, measure] of [...own, ...carried]) {
      if (range && measure && !overlaps(measure, range.from, range.to)) continue;
      const width = Math.max(this.pieces[i].widthMm, style?.widthMm ?? 0);
      const reach = width / 2 + gap + REACH_MM;
      const b = i * 4;
      const box: Box = [this.boxes[b] - reach, this.boxes[b + 1] - reach, this.boxes[b + 2] + reach, this.boxes[b + 3] + reach];
      for (const tile of this.tilesTouching(box)) out.add(tile);
    }
    // Drawn as mapped while in a layer, with the other carriageway of a
    // merged line, and those can reach tiles the tidied line doesn't.
    const mapped = style?.layer ? this.mappedRoads() : this.mappedIndex;
    if (mapped) {
      for (const linked of [segment, ...(mapped.links.get(segment) ?? [])]) {
        for (const i of mapped.bySegment.get(linked) ?? []) {
          const reach = Math.max(mapped.pieces[i].widthMm, style?.widthMm ?? 0) / 2 + gap + REACH_MM;
          const [x0, y0, x1, y1] = mapped.boxes[i];
          for (const tile of this.tilesTouching([x0 - reach, y0 - reach, x1 + reach, y1 + reach])) out.add(tile);
        }
      }
    }
    return [...out];
  }

  /** Road keys, whole segments or ranges, with pieces in the model. */
  has(key: string): boolean {
    const segment = roadSegment(key);
    return this.bySegment.has(segment) || this.byPartner.has(segment);
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
    const place = (styled: StyledPiece) => {
      const { piece, style } = styled;
      if (style?.removed) return;
      const sized = style?.widthMm !== undefined ? { ...piece, widthMm: style.widthMm } : piece;
      all.push(sized);
      const height = style?.heightMm ?? thickness;
      if (!style?.layer && Math.abs(height - thickness) < 1e-9) {
        plain.push(sized);
        return;
      }
      const part = style?.layer ? `layer:${style.layer}` : ROAD_PARTS[piece.group];
      const id = `${part}|${height}`;
      let bucket = special.get(id);
      if (!bucket) special.set(id, (bucket = { part, thickness: height, pieces: [], styled: [], cut: false }));
      bucket.pieces.push(sized);
      bucket.styled.push({ ...styled, piece: sized });
      if (styled.cut[0] || styled.cut[1]) bucket.cut = true;
    };
    // Stretches of each segment in a custom layer, and what's drawn as mapped.
    const mapped = styles.hasLayers ? this.mappedRoads() : null;
    const layered = new Map<string, Intervals>();
    const layeredOf = (segment: string) => {
      let list = layered.get(segment);
      if (!list) layered.set(segment, (list = joinIntervals(styles.ranges(segment).flatMap((r): Intervals => (r.style.layer ? [[r.from, r.to]] : [])))));
      return list;
    };
    // What's drawn as mapped, by segment. A merged line gives both its
    // carriageways back still tied to each other where it ran (`link`): each
    // carries the other's edits there, as the merged line did, so colouring
    // the road colours both.
    const restore = new Map<string, { span: [number, number]; link?: { partner: string; pairs: [number, number][] } }[]>();
    // In the pipeline's order, with each segment drawn as mapped where its
    // first replaced stretch was: the crack strips depend on the order.
    const order: (StyledPiece | string)[] = [];
    const restoreOn = (segment: string, span: [number, number], link?: { partner: string; pairs: [number, number][] }) => {
      const list = restore.get(segment);
      if (list) list.push({ span, link });
      else {
        restore.set(segment, [{ span, link }]);
        order.push(segment);
      }
    };
    for (const i of this.near.get(tile) ?? []) {
      const original = this.pieces[i];
      const own = `r:${original.sourceId}`;
      const partner = original.partner ? `r:${original.partner}` : null;
      const carried = partner ? styles.ranges(partner) : [];
      for (const styled of styledPieces(original, styles.ranges(own), carried)) {
        // Stretches are cut at every range's ends, so one is wholly in a layer or wholly out.
        const measure = styled.piece.measure;
        const partnerMeasure = partner ? styled.piece.partnerMeasure : undefined;
        if (mapped && measure?.length && mapped.bySegment.has(own)) {
          const ownSpan = extent(measure);
          const partnerSpan = partnerMeasure?.length === measure.length && mapped.bySegment.has(partner!) ? extent(partnerMeasure) : null;
          const inLayer = within(layeredOf(own), (ownSpan[0] + ownSpan[1]) / 2) || (partnerSpan && within(layeredOf(partner!), (partnerSpan[0] + partnerSpan[1]) / 2));
          if (inLayer) {
            if (partnerSpan) {
              restoreOn(own, ownSpan, { partner: partner!, pairs: measure.map((m, k): [number, number] => [m, partnerMeasure![k]]) });
              restoreOn(partner!, partnerSpan, { partner: own, pairs: partnerMeasure!.map((q, k): [number, number] => [q, measure[k]]) });
            } else restoreOn(own, ownSpan);
            continue;
          }
        }
        order.push(styled);
      }
    }
    const restored = new Map<string, StyledPiece[]>();
    if (mapped) {
      const near = mapped.near.get(tile) ?? [];
      // Whole layered ranges, so stretches the tidy dropped come back too.
      for (const i of near) {
        const segment = `r:${mapped.pieces[i].sourceId}`;
        for (const range of layeredOf(segment)) restoreOn(segment, range);
      }
      for (const i of near) {
        const segment = `r:${mapped.pieces[i].sourceId}`;
        const wanted = restore.get(segment);
        if (!wanted) continue;
        let list = restored.get(segment);
        if (!list) restored.set(segment, (list = []));
        const push = (slice: { piece: RoadPiece; cut: [boolean, boolean] }, carried: readonly StyledRange[]) => {
          const stretches = styledPieces(slice.piece, styles.ranges(segment), carried);
          stretches.forEach((stretch, k) => {
            list.push({ ...stretch, cut: [stretch.cut[0] || (k === 0 && slice.cut[0]), stretch.cut[1] || (k === stretches.length - 1 && slice.cut[1])] });
          });
        };
        const linked = wanted.filter((entry) => entry.link);
        const plain = subtractIntervals(
          joinIntervals(wanted.filter((entry) => !entry.link).map((entry) => entry.span)),
          joinIntervals(linked.map((entry) => entry.span)),
        );
        for (const ground of this.mappedGround(mapped, i)) {
          for (const { span, link } of linked) {
            const pairs = [...link!.pairs].sort((a, b) => a[0] - b[0]);
            for (const slice of slicesWithin(ground, [span])) {
              const piece = { ...slice.piece, partner: link!.partner.slice(2), partnerMeasure: slice.piece.measure!.map((v) => across(pairs, v)) };
              push({ piece, cut: slice.cut }, styles.ranges(link!.partner));
            }
          }
          for (const slice of slicesWithin(ground, plain)) push(slice, []);
        }
      }
    }
    for (const entry of order) {
      if (typeof entry !== 'string') place(entry);
      else for (const styled of restored.get(entry) ?? []) place(styled);
    }

    const out: RoadBucket[] = [];
    const ctx = { settings: this.settings, cropSet: wide, progress: new Progress(), stats: {} };
    // Routes still in the model near the tile, and drawn roads, which every road gives way to.
    const near: Box = [(rect.left - margin) / SCALE, (rect.top - margin) / SCALE, (rect.right + margin) / SCALE, (rect.bottom + margin) / SCALE];
    const routes = this.cuts.filter((cut, i) => !styles.get(cut.key)?.removed && boxesOverlap(this.cutBoxes[i], near)).flatMap((cut) => cut.pieces);
    const drawn = styles.cuts.filter((cut) => boxesOverlap(cut.box, near)).flatMap((cut) => cut.polygons);
    const cut = routes.length || drawn.length ? new ClipSet([routes, drawn]) : null;
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
