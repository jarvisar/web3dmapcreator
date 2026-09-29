// Tidying the road and path network before it's widened into ribbons.
//
// Overture hands over every mapped way: both carriageways of a divided
// street, footways that are sidewalks in all but tag, a street split at every
// tag change, and once sidewalks, crossings and tunnels are left out, the
// scraps that joined them. Printed as they are, those make doubled ribbons
// with hairlines of ground between them, paths stopping just short of the
// street, and specks of road filament floating in plazas.
//
// The tidy drops lines doubling a more important one (cull.ts), moves a kept
// carriageway onto the middle of its street (center.ts), pulls loose ends
// onto the road they nearly meet (join.ts), and removes spurs and fragments
// that lead nowhere (prune.ts). Pieces keep their own attributes
// and are only cut, extended or dropped. Thresholds are printed millimetres.

import type { Vec2 } from '../../types';
import { polylineLength } from '../linework';
import type { RoadPiece } from '../roads';
import { centerOnTwins } from './center';
import { cull } from './cull';
import { joinEnds } from './join';
import { prune } from './prune';
import { candidate, endOrigins, weld, type Part } from './routes';

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
  joinEnds: boolean;
  removeFragments: boolean;
}

export interface NetworkStats {
  network_culled_mm: number;
  network_culled_routes: number;
  network_hidden_parts: number;
  network_centered_parts: number;
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

  const culled = input.removeDoubled
    ? cull(candidates, weld(candidates, NODE_MM), origins, { gap, stub: STUB_MM })
    : { parts: candidates.map((c, i): Part => ({ source: i, points: [...c.points], ends: origins[i] })), droppedRoutes: 0, hiddenParts: 0, twins: [] };
  const afterCull = length(culled.parts);
  const centered = centerOnTwins(culled.parts, candidates, culled.twins, gap);
  const joined = input.joinEnds ? joinEnds(culled.parts, candidates, gap, NODE_MM) : 0;
  const afterJoin = length(culled.parts);
  const pruned = input.removeFragments
    ? prune(culled.parts, candidates, { stub: STUB_MM, island: ISLAND_MM, tolerance: NODE_MM })
    : { parts: culled.parts, stubs: 0, nubs: 0, islands: 0 };

  const parts = pruned.parts.sort((a, b) => a.source - b.source);
  const round = (mm: number) => Math.round(mm * 10) / 10;
  return {
    pieces: parts.map((part) => ({ ...candidates[part.source].piece, points: part.points })),
    stats: {
      network_culled_mm: round(length(candidates) - afterCull),
      network_culled_routes: culled.droppedRoutes,
      network_hidden_parts: culled.hiddenParts,
      network_centered_parts: centered,
      network_joined_ends: joined,
      network_pruned_stubs: pruned.stubs,
      network_pruned_nubs: pruned.nubs,
      network_pruned_islands: pruned.islands,
      network_pruned_mm: round(afterJoin - length(parts)),
    },
  };
}
