// The roads and paths a route can follow in the route editor, from Overture's
// segments: every road and path, as LiDAR only models snap routes to them,
// less tunnels and corridors inside buildings, which are never printed.
// Bridges stay. They only meet the network where their lines share a vertex
// with it (network.ts), so a route can't drop off one onto the road under it.
//
// The worker builds the graph and posts its arrays. Built on the main thread,
// a 10 km area held the page for a third of a second when its roads came in.

import { splitSegment } from '../pipeline/linework';
import { str, type GeoGeometry, type SourceFeature } from '../pipeline/source';
import type { Vec2 } from '../types';
import type { FlatFrame } from './edit';
import { RoadGraph } from './network';

// Vertices this close are one junction, as for snapping (snap.ts). Edges
// near a point are found through a grid of CELL_M squares.
export const JOIN_M = 0.5;
export const CELL_M = 40;

type Position = number[];

function geometryLines(geometry: GeoGeometry | null | undefined): Position[][] {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates as Position[]];
  if (geometry.type === 'MultiLineString') return geometry.coordinates as Position[][];
  if (geometry.type === 'GeometryCollection') return (geometry.geometries ?? []).flatMap(geometryLines);
  return [];
}

/** Lines in the frame's metres, the editor's own (flatFrame). */
export function followLines(features: readonly SourceFeature[], frame: FlatFrame): Vec2[][] {
  const out: Vec2[][] = [];
  for (const feature of features) {
    if (str(feature.props.subtype) !== 'road') continue;
    for (const coords of geometryLines(feature.geometry)) {
      const line: Vec2[] = [];
      for (const p of coords) {
        if (p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
        const q = frame.toLocal([p[0], p[1]]);
        const last = line[line.length - 1];
        if (!last || last[0] !== q[0] || last[1] !== q[1]) line.push(q);
      }
      if (line.length < 2) continue;
      for (const piece of splitSegment(feature.id, line, feature.props)) {
        if (piece.flags.has('is_tunnel') || piece.flags.has('is_indoor')) continue;
        out.push(piece.points);
      }
    }
  }
  return out;
}

export function roadGraph(lines: readonly Vec2[][]): RoadGraph {
  return RoadGraph.build(lines, lines.map((_, i) => i), JOIN_M, CELL_M);
}
