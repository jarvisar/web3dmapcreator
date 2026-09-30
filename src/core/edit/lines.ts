// Road centrelines for the viewer, which picks and highlights roads by them:
// a street is one polygon with its neighbours once widened, so the lines are
// the only way to tell one road from the next. Points are densified to half
// a terrain cell so an outline drawn along them stays on the ground.

import { densifyLine } from '../geometry/polygon';
import type { EditContext } from '../pipeline/generate';
import type { RoadGroup } from '../pipeline/roads';

export interface RoadLines {
  /** Per piece. Pieces of one road share its key. */
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
  const starts = new Uint32Array(pieces.length + 1);
  pieces.forEach((piece, i) => {
    starts[i] = coords.length / 3;
    const points = Number.isFinite(spacing) ? densifyLine(piece.points, spacing) : piece.points;
    for (const [x, y] of points) coords.push(x, y, ctx.heightAt(x, y) + zShift);
  });
  starts[pieces.length] = coords.length / 3;
  return {
    keys: pieces.map((p) => `r:${p.sourceId}`),
    names: pieces.map((p) => p.name ?? ''),
    classes: pieces.map((p) => p.roadClass),
    groups: Uint8Array.from(pieces, (p) => ROAD_GROUP_INDEX[p.group]),
    widths: Float32Array.from(pieces, (p) => p.widthMm),
    starts,
    points: Float32Array.from(coords),
    thicknessMm,
    decks: deckEnds(ctx),
  };
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
