// Road centrelines for the viewer, which picks and highlights roads by them:
// a street is one polygon with its neighbours once widened, so the lines are
// the only way to tell one road from the next. Points are densified to half
// a terrain cell so an outline drawn along them stays on the ground.

import { densifyLine } from '../geometry/polygon';
import type { EditContext } from '../pipeline/generate';
import type { RoadGroup } from '../pipeline/roads';
import type { Vec2 } from '../types';

export interface RoadLines {
  /** Per piece, the segment's key. Pieces of one road share it. */
  keys: string[];
  names: string[];
  classes: string[];
  /** 0 road, 1 railway, 2 path. */
  groups: Uint8Array;
  /** Printed width in mm, as generated. */
  widths: Float32Array;
  /** Where each piece's points start, with the total at the end. */
  starts: Uint32Array;
  /** x, y and the ground's z per point, in the viewer's coordinates. */
  points: Float32Array;
  /** Where each point lies along its segment, 0 to 1, or NaN for a piece that wasn't measured (blocks.ts). */
  measures?: Float32Array;
  /** Where blocks of a segment end, by its key, for segments with junctions. */
  junctions?: Record<string, number[]>;
  /** Per piece, a divided road's merged line: the other carriageway's segment key, whose edits it carries, or ''. */
  partners?: string[];
  /** Where each point lies along that segment, NaN for pieces without one. */
  partnerMeasures?: Float32Array;
  /** How far roads stand above the ground, unless edited. */
  thicknessMm: number;
  /** Bridge decks, so a street can be followed across them: both ends (x, y, x, y) of each. */
  decks?: { keys: string[]; names: string[]; classes: string[]; ends: Float32Array };
}

export const ROAD_GROUP_INDEX: Record<RoadGroup, number> = { road: 0, rail: 1, path: 2 };

export function roadLines(ctx: EditContext, zShift: number, thicknessMm: number): RoadLines {
  const pieces = ctx.roads;
  const spacing = ctx.heightfield && !ctx.heightfield.flat ? ctx.heightfield.step / 2 : Infinity;
  const coords: number[] = [];
  const along: number[] = [];
  const carried: number[] = [];
  const starts = new Uint32Array(pieces.length + 1);
  pieces.forEach((piece, i) => {
    starts[i] = coords.length / 3;
    const n = piece.points.length;
    const own = piece.measure?.length === n ? piece.measure : null;
    const partner = piece.partner && piece.partnerMeasure?.length === n ? piece.partnerMeasure : null;
    const { points, values } = densified(piece.points, [own, partner], spacing);
    points.forEach(([x, y], k) => {
      coords.push(x, y, ctx.heightAt(x, y) + zShift);
      along.push(values[0] ? values[0][k] : NaN);
      carried.push(values[1] ? values[1][k] : NaN);
    });
  });
  starts[pieces.length] = coords.length / 3;
  const junctions: Record<string, number[]> = {};
  for (const [key, list] of ctx.junctions ?? []) junctions[key] = list;
  return {
    keys: pieces.map((p) => `r:${p.sourceId}`),
    names: pieces.map((p) => p.name ?? ''),
    classes: pieces.map((p) => p.roadClass),
    groups: Uint8Array.from(pieces, (p) => ROAD_GROUP_INDEX[p.group]),
    widths: Float32Array.from(pieces, (p) => p.widthMm),
    starts,
    points: Float32Array.from(coords),
    measures: Float32Array.from(along),
    junctions,
    partners: pieces.map((p) => (p.partner && p.partnerMeasure ? `r:${p.partner}` : '')),
    partnerMeasures: Float32Array.from(carried),
    thicknessMm,
    decks: deckEnds(ctx),
  };
}

/** Points no further apart than `spacing`, with per-point values (measures along a segment) carried along. */
function densified(points: Vec2[], values: (number[] | null)[], spacing: number): { points: Vec2[]; values: (number[] | null)[] } {
  if (!Number.isFinite(spacing)) return { points, values };
  if (values.every((v) => !v)) return { points: densifyLine(points, spacing), values };
  const outPoints: Vec2[] = [points[0]];
  const outValues = values.map((v) => (v ? [v[0]] : null));
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / spacing);
    for (let k = 1; k <= steps; k++) {
      outPoints.push([ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps]);
      values.forEach((v, j) => v && outValues[j]!.push(v[i - 1] + ((v[i] - v[i - 1]) * k) / steps));
    }
  }
  return { points: outPoints, values: outValues };
}

function deckEnds(ctx: EditContext): RoadLines['decks'] {
  const decks = ctx.decks.filter((deck) => ctx.objects.has(deck.key) && deck.points.length >= 2);
  const ends = new Float32Array(decks.length * 4);
  decks.forEach((deck, i) => {
    const a = deck.points[0];
    const b = deck.points[deck.points.length - 1];
    ends.set([a[0], a[1], b[0], b[1]], i * 4);
  });
  return {
    keys: decks.map((deck) => deck.key),
    names: decks.map((deck) => ctx.objects.get(deck.key)?.name ?? ''),
    classes: decks.map((deck) => ctx.objects.get(deck.key)?.detail ?? ''),
    ends,
  };
}
