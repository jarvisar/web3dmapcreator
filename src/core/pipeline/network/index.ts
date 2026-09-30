// Tidying the road and path network before it's widened into ribbons.
//
// Overture hands over every mapped way: both carriageways of a divided
// street, footways that are sidewalks in all but tag, a street split at every
// tag change, and once sidewalks, crossings and tunnels are left out, the
// scraps that joined them. Printed as they are, those make doubled ribbons
// with hairlines of ground between them, paths stopping just short of the
// street, and specks of road filament floating in plazas.
//
// The tidy merges the carriageways of divided roads onto the middle of the
// road (divided.ts), drops lines doubling a more important one (cull.ts),
// pulls loose ends onto the road they nearly meet (join.ts), and removes
// spurs and fragments that lead nowhere (prune.ts). Merging goes first: a
// service road beside one carriageway was dropped for doubling it, and then
// the carriageway moved away onto the middle. It changes as little as
// it can: lines are cut, dropped, extended a little or moved onto the middle
// of their own road, never bent towards something else. What's left too
// close to print apart is filled in after widening (gaps.ts). Thresholds are
// printed millimetres.

import type { Vec2 } from '../../types';
import { polylineLength } from '../linework';
import type { RoadPiece } from '../roads';
import { cull, wholeParts } from './cull';
import { mergeDivided } from './divided';
import { joinEnds } from './join';
import { prune } from './prune';
import { candidate, endOrigins, weld } from './routes';

// Less than this doesn't read as a line of its own: the kerb stub of a
// dropped crossing, the scrap of a footway left beside the road it doubled.
const STUB_MM = 0.7;
// Anything touching nothing else and shorter than this in total is a speck:
// the flight of steps between two dropped sidewalks.
const ISLAND_MM = 1.4;
// Ends closer than this share a node. Overture repeats a connector's
// coordinates on every segment through it, so this only absorbs rounding.
const NODE_MM = 0.03;

export interface NetworkInput {
  pieces: RoadPiece[];
  /** Lines left out before the tidy, sidewalks and crossings: an end that met one was connected. */
  leftOut: Vec2[][];
  /** Tunnels and indoor corridors: an end that met only these carries on, but not in print. */
  hidden: Vec2[][];
  /** Ends cut by the edge of the data window, which aren't loose. */
  onEdge: (point: Vec2) => boolean;
  /** Pieces built as bridge decks. They never double ground roads and their ends never move. */
  isDeck: (piece: RoadPiece) => boolean;
  /** Narrowest strip of ground left between two ribbons running alongside each other. */
  gapMm: number;
  removeDoubled: boolean;
  mergeDivided: boolean;
  joinEnds: boolean;
  removeFragments: boolean;
}

export interface NetworkStats {
  network_culled_mm: number;
  network_culled_routes: number;
  network_hidden_parts: number;
  network_merged_pairs: number;
  network_merged_mm: number;
  network_joined_ends: number;
  network_pruned_stubs: number;
  network_pruned_nubs: number;
  network_pruned_islands: number;
  network_pruned_mm: number;
}

export function tidyNetwork(input: NetworkInput): { pieces: RoadPiece[]; stats: NetworkStats } {
  const gap = Math.max(0, input.gapMm);
  const candidates = input.pieces.map((p) => candidate(p, input.isDeck(p))).filter((c) => c.points.length >= 2);
  const origins = endOrigins(candidates, input.leftOut, input.hidden, input.onEdge, NODE_MM);
  const length = (parts: { points: Vec2[] }[]) => parts.reduce((sum, p) => sum + polylineLength(p.points), 0);

  let parts = wholeParts(candidates, origins);
  const merged = input.mergeDivided ? mergeDivided(parts, candidates, gap, NODE_MM) : { pairs: 0, droppedMm: 0 };
  const afterMerge = length(parts);
  let culled = { droppedRoutes: 0, hiddenParts: 0 };
  if (input.removeDoubled) {
    // Cull works on whole candidates, so each part stands in as one.
    const lines = parts.map((p) => ({ ...candidates[p.source], points: p.points }));
    const result = cull(lines, weld(lines, NODE_MM), parts.map((p) => p.ends), { gap, stub: STUB_MM });
    parts = result.parts.map((q) => ({ ...q, source: parts[q.source].source, merged: parts[q.source].merged }));
    culled = result;
  }
  const afterCull = length(parts);
  const joined = input.joinEnds ? joinEnds(parts, candidates, gap, NODE_MM) : 0;
  const afterJoin = length(parts);
  const pruned = input.removeFragments
    ? prune(parts, candidates, { stub: STUB_MM, island: ISLAND_MM, tolerance: NODE_MM })
    : { parts, stubs: 0, nubs: 0, islands: 0 };

  const out = pruned.parts.sort((a, b) => a.source - b.source);
  const round = (mm: number) => Math.round(mm * 10) / 10;
  return {
    pieces: out.map((part) => ({ ...candidates[part.source].piece, points: part.points })),
    stats: {
      network_culled_mm: round(afterMerge - afterCull),
      network_culled_routes: culled.droppedRoutes,
      network_hidden_parts: culled.hiddenParts,
      network_merged_pairs: merged.pairs,
      network_merged_mm: round(merged.droppedMm),
      network_joined_ends: joined,
      network_pruned_stubs: pruned.stubs,
      network_pruned_nubs: pruned.nubs,
      network_pruned_islands: pruned.islands,
      network_pruned_mm: round(afterJoin - length(out)),
    },
  };
}
