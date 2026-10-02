// Roads in the viewer, by their centrelines. Widened and unioned, a city's
// streets are one mesh, so a click on it is matched to the nearest line
// instead, and a picked road is shown as a ribbon laid over it. The lines
// are cut into blocks (blocks.ts), so a pick is a block's key.

import { parseRoadKey, roadSegment } from '../../core/edit/blocks';
import type { RoadLines } from '../../core/edit/lines';

const CELL_MM = 4;
// Ends closer than this belong to one junction.
const JOIN_MM = 0.05;

export interface RoadPick {
  piece: number;
  key: string;
  distance: number;
  /** The nearest point on the line, its direction there, and where it is along its segment (NaN when unknown). */
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  at: number;
}

/** A point on a road's line with its direction, as for a mark across it. */
export interface RoadMark {
  piece: number;
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
}

export class RoadIndex {
  private readonly grid = new Map<number, number[]>();
  private readonly byKey = new Map<string, number[]>();
  private readonly bySegment = new Map<string, number[]>();
  /** Merged divided roads by the other carriageway's segment, which they stand for too. */
  private readonly byPartner = new Map<string, number[]>();
  /** Segment start point index per segment, and its piece. */
  private readonly segmentPiece: Int32Array;
  private readonly segmentStart: Int32Array;

  constructor(readonly lines: RoadLines) {
    const { starts, points } = lines;
    const segments = starts[starts.length - 1] - (starts.length - 1);
    this.segmentPiece = new Int32Array(Math.max(0, segments));
    this.segmentStart = new Int32Array(Math.max(0, segments));
    let s = 0;
    for (let piece = 0; piece < lines.keys.length; piece++) {
      const list = this.byKey.get(lines.keys[piece]);
      if (list) list.push(piece);
      else this.byKey.set(lines.keys[piece], [piece]);
      const segment = roadSegment(lines.keys[piece]);
      const pieces = this.bySegment.get(segment);
      if (pieces) pieces.push(piece);
      else this.bySegment.set(segment, [piece]);
      const partner = lines.partners?.[piece];
      if (partner) {
        const carried = this.byPartner.get(partner);
        if (carried) carried.push(piece);
        else this.byPartner.set(partner, [piece]);
      }
      for (let p = starts[piece]; p < starts[piece + 1] - 1; p++) {
        this.segmentPiece[s] = piece;
        this.segmentStart[s] = p;
        const x0 = Math.min(points[p * 3], points[p * 3 + 3]);
        const x1 = Math.max(points[p * 3], points[p * 3 + 3]);
        const y0 = Math.min(points[p * 3 + 1], points[p * 3 + 4]);
        const y1 = Math.max(points[p * 3 + 1], points[p * 3 + 4]);
        for (let cx = Math.floor(x0 / CELL_MM); cx <= Math.floor(x1 / CELL_MM); cx++) {
          for (let cy = Math.floor(y0 / CELL_MM); cy <= Math.floor(y1 / CELL_MM); cy++) {
            const cell = cellKey(cx, cy);
            const bucket = this.grid.get(cell);
            if (bucket) bucket.push(s);
            else this.grid.set(cell, [s]);
          }
        }
        s++;
      }
    }
  }

  get count(): number {
    return this.lines.keys.length;
  }

  has(key: string): boolean {
    return this.byKey.has(key) || this.bySegment.has(key) || this.byPartner.has(key);
  }

  /**
   * The pieces of a block, a whole segment, or any range of one: those whose
   * middle lies in it, and a divided road's merged line standing for it.
   */
  piecesOf(key: string): number[] {
    const range = parseRoadKey(key);
    const carried = range ? (this.byPartner.get(range.segment) ?? []) : [];
    const exact = this.byKey.get(key);
    if (exact && !carried.length) return exact;
    if (!range) return exact ?? [];
    const whole = range.from <= 0 && range.to >= 1;
    const inside = (at: number) => whole || (at === at && at >= range.from - 1e-7 && at <= range.to + 1e-7);
    const own = exact ?? (this.bySegment.get(range.segment) ?? []).filter((piece) => inside(this.middleAt(piece)));
    return [...own, ...carried.filter((piece) => inside(this.partnerMiddleAt(piece)))];
  }

  /** Where a merged divided road's middle lies along the other carriageway, NaN when unknown. */
  private partnerMiddleAt(piece: number): number {
    const m = this.lines.partnerMeasures;
    if (!m) return NaN;
    return (m[this.lines.starts[piece]] + m[this.lines.starts[piece + 1] - 1]) / 2;
  }

  /** A piece's line in plan. */
  lineOf(piece: number): [number, number][] {
    const { starts, points } = this.lines;
    const out: [number, number][] = [];
    for (let p = starts[piece]; p < starts[piece + 1]; p++) out.push([points[p * 3], points[p * 3 + 1]]);
    return out;
  }

  /** Pieces of a segment, by its key. */
  segmentPieces(segment: string): number[] {
    return this.bySegment.get(segment) ?? [];
  }

  /** Where a piece's middle lies along its segment, NaN when unknown. */
  middleAt(piece: number): number {
    const m = this.lines.measures;
    if (!m) return NaN;
    return (m[this.lines.starts[piece]] + m[this.lines.starts[piece + 1] - 1]) / 2;
  }

  /** Where a segment's line is at a point along it, with its direction, or null where the model doesn't show it. */
  markAt(segment: string, at: number, prefer?: (piece: number) => boolean): RoadMark | null {
    const { starts, points, measures } = this.lines;
    if (!measures) return null;
    const pieces = this.bySegment.get(segment) ?? [];
    const ordered = prefer ? [...pieces.filter(prefer), ...pieces.filter((piece) => !prefer(piece))] : pieces;
    for (const piece of ordered) {
      for (let p = starts[piece]; p < starts[piece + 1] - 1; p++) {
        const a = measures[p];
        const b = measures[p + 1];
        if (!(Math.min(a, b) <= at + 1e-7 && Math.max(a, b) >= at - 1e-7) || a === b) continue;
        const t = (at - a) / (b - a);
        const ax = points[p * 3];
        const ay = points[p * 3 + 1];
        const ex = points[p * 3 + 3] - ax;
        const ey = points[p * 3 + 4] - ay;
        const length = Math.hypot(ex, ey) || 1;
        return { piece, x: ax + ex * t, y: ay + ey * t, z: points[p * 3 + 2] + (points[p * 3 + 5] - points[p * 3 + 2]) * t, dx: ex / length, dy: ey / length };
      }
    }
    return null;
  }

  keys(): string[] {
    return [...this.byKey.keys()];
  }

  /** The road whose ribbon holds the point, or else the nearest within `reach` of its edge. */
  nearest(x: number, y: number, accept: (piece: number) => boolean, widthOf: (piece: number) => number, reach = 0.4): RoadPick | null {
    const { points } = this.lines;
    let best: RoadPick | null = null;
    const radius = Math.ceil((6 + reach) / CELL_MM);
    const cx = Math.floor(x / CELL_MM);
    const cy = Math.floor(y / CELL_MM);
    const seen = new Set<number>();
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (const s of this.grid.get(cellKey(cx + dx, cy + dy)) ?? []) {
          if (seen.has(s)) continue;
          seen.add(s);
          const piece = this.segmentPiece[s];
          if (!accept(piece)) continue;
          const p = this.segmentStart[s] * 3;
          const d = segmentDistance(x, y, points[p], points[p + 1], points[p + 3], points[p + 4]);
          // Distance past the ribbon's edge, so a wide road wins over a thin path beside it.
          const past = d - widthOf(piece) / 2;
          if (past > reach) continue;
          if (!best || past < best.distance) best = this.pickOn(piece, this.segmentStart[s], x, y, past);
        }
      }
    }
    return best;
  }

  private pickOn(piece: number, point: number, x: number, y: number, distance: number): RoadPick {
    const { points, measures } = this.lines;
    const p = point * 3;
    const ax = points[p];
    const ay = points[p + 1];
    const ex = points[p + 3] - ax;
    const ey = points[p + 4] - ay;
    const length2 = ex * ex + ey * ey;
    const t = length2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / length2)) : 0;
    const length = Math.sqrt(length2) || 1;
    const at = measures ? measures[point] + (measures[point + 1] - measures[point]) * t : NaN;
    const z = points[p + 2] + (points[p + 5] - points[p + 2]) * t;
    return { piece, key: this.lines.keys[piece], distance, x: ax + ex * t, y: ay + ey * t, z, dx: ex / length, dy: ey / length, at };
  }

  /** Middle of a piece's line, for box selection. */
  midpoint(piece: number): [number, number, number] {
    const { starts, points } = this.lines;
    const i = Math.floor((starts[piece] + starts[piece + 1] - 1) / 2) * 3;
    return [points[i], points[i + 1], points[i + 2]];
  }

  /**
   * Every road joined to this one end to end with the same name, or the same
   * class when it has none: a whole street, or a whole unnamed track. It
   * carries on across bridge decks, so a route over a river stays one street.
   */
  connected(key: string): string[] {
    const { starts, points, names, classes } = this.lines;
    const decks = this.lines.decks;
    const count = this.lines.keys.length;
    // Items are the pieces, then the decks.
    const total = count + (decks?.keys.length ?? 0);
    const keyOf = (item: number) => (item < count ? this.lines.keys[item] : decks!.keys[item - count]);
    const nameOf = (item: number) => (item < count ? names[item] : decks!.names[item - count]);
    const classOf = (item: number) => (item < count ? classes[item] : decks!.classes[item - count]);
    const endsOf = (item: number): [number, number][] => {
      if (item >= count) {
        const e = (item - count) * 4;
        return [
          [decks!.ends[e], decks!.ends[e + 1]],
          [decks!.ends[e + 2], decks!.ends[e + 3]],
        ];
      }
      const a = starts[item] * 3;
      const b = (starts[item + 1] - 1) * 3;
      return [
        [points[a], points[a + 1]],
        [points[b], points[b + 1]],
      ];
    };
    const byKey = new Map<string, number[]>();
    for (let item = 0; item < total; item++) {
      const list = byKey.get(keyOf(item));
      if (list) list.push(item);
      else byKey.set(keyOf(item), [item]);
    }
    const start = byKey.get(key);
    if (!start) return [];
    const name = nameOf(start[0]);
    const cls = classOf(start[0]);
    const same = (item: number) => (name ? nameOf(item) === name : !nameOf(item) && classOf(item) === cls);
    const cell = ([x, y]: [number, number]) => [Math.round(x / JOIN_MM), Math.round(y / JOIN_MM)];
    const ends = new Map<number, number[]>();
    for (let item = 0; item < total; item++) {
      if (!same(item)) continue;
      for (const end of endsOf(item)) {
        const [cx, cy] = cell(end);
        const k = cellKey(cx, cy);
        const list = ends.get(k);
        if (list) list.push(item);
        else ends.set(k, [item]);
      }
    }
    const found = new Set<string>([key]);
    const stack = [...start];
    const visited = new Set<number>(stack);
    while (stack.length) {
      const item = stack.pop()!;
      for (const end of endsOf(item)) {
        const [px, py] = cell(end);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (const next of ends.get(cellKey(px + dx, py + dy)) ?? []) {
              if (visited.has(next)) continue;
              found.add(keyOf(next));
              for (const sibling of byKey.get(keyOf(next))!) {
                if (visited.has(sibling)) continue;
                visited.add(sibling);
                stack.push(sibling);
              }
            }
          }
        }
      }
    }
    return [...found];
  }

  /**
   * Triangles along the pieces, `lift` over their ground plus their
   * thickness, as flat xyz triplets: a band down each edge of the road, so
   * its own colour still shows, or with `band` 0 the whole ribbon.
   */
  ribbon(pieces: number[], widthOf: (piece: number) => number, heightOf: (piece: number) => number, lift: number, band = 0): Float32Array {
    const { starts, points } = this.lines;
    const out: number[] = [];
    const quad = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, nx: number, ny: number, from: number, to: number) => {
      const [a0x, a0y, a1x, a1y] = [ax + nx * from, ay + ny * from, ax + nx * to, ay + ny * to];
      const [b0x, b0y, b1x, b1y] = [bx + nx * from, by + ny * from, bx + nx * to, by + ny * to];
      out.push(a0x, a0y, az, b0x, b0y, bz, b1x, b1y, bz, a0x, a0y, az, b1x, b1y, bz, a1x, a1y, az);
    };
    for (const piece of pieces) {
      const half = widthOf(piece) / 2;
      const up = heightOf(piece) + lift;
      for (let p = starts[piece]; p < starts[piece + 1] - 1; p++) {
        const ax = points[p * 3];
        const ay = points[p * 3 + 1];
        const az = points[p * 3 + 2] + up;
        const bx = points[p * 3 + 3];
        const by = points[p * 3 + 4];
        const bz = points[p * 3 + 5] + up;
        const length = Math.hypot(bx - ax, by - ay);
        if (length < 1e-9) continue;
        const nx = -(by - ay) / length;
        const ny = (bx - ax) / length;
        if (band > 0) {
          quad(ax, ay, az, bx, by, bz, nx, ny, half - band, half);
          quad(ax, ay, az, bx, by, bz, nx, ny, -half, -half + band);
        } else {
          quad(ax, ay, az, bx, by, bz, nx, ny, -half, half);
        }
      }
      // Round joints, so bends don't gap.
      for (let p = starts[piece]; p < starts[piece + 1]; p++) disc(out, points[p * 3], points[p * 3 + 1], points[p * 3 + 2] + up, half, band);
    }
    return Float32Array.from(out);
  }
}

/** A disc, or with `band` a ring that wide inside its edge. */
function disc(out: number[], x: number, y: number, z: number, radius: number, band = 0) {
  const sides = 12;
  const inner = band > 0 ? Math.max(0, radius - band) : 0;
  for (let i = 0; i < sides; i++) {
    const a = (2 * Math.PI * i) / sides;
    const b = (2 * Math.PI * (i + 1)) / sides;
    const [ca, sa, cb, sb] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)];
    if (inner <= 0) {
      out.push(x, y, z, x + ca * radius, y + sa * radius, z, x + cb * radius, y + sb * radius, z);
      continue;
    }
    out.push(x + ca * inner, y + sa * inner, z, x + ca * radius, y + sa * radius, z, x + cb * radius, y + sb * radius, z);
    out.push(x + ca * inner, y + sa * inner, z, x + cb * radius, y + sb * radius, z, x + cb * inner, y + sb * inner, z);
  }
}

function cellKey(x: number, y: number): number {
  return (x + 2 ** 20) * 2 ** 21 + (y + 2 ** 20);
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length2 = dx * dx + dy * dy;
  let t = length2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / length2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
