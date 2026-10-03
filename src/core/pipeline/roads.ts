// Roads, paths and railways as ground ribbons.
//
// Widths are real widths clamped into the printable band: below the minimum
// a ribbon is thinner than a nozzle line, above the maximum a motorway reads
// as a runway next to the streets around it. Each group is unioned, so
// overlapping pieces become one clean solid instead of stacked shells.

import {
  bufferLines,
  ClipSet,
  clipLines,
  differenceSet,
  dropSmall,
  intersection,
  clipToBox,
  offsetPolygons,
  pointInPolygon,
  separateTouching,
  union,
} from '../geometry/polygon';
import { EdgeIndex } from '../geometry/edgeindex';
import type { MultiPolygon, Polygon, Vec2 } from '../types';
import { MINIMUM_BRIDGE_M } from './bridges';
import { count, type Context } from './context';
import { MINOR_ROAD_CLASSES, polylineLength, RAIL_CLASS, RAIL_WIDTH_M, SIDEPATH_SUBCLASSES, splitSegment, type SubSegment } from './linework';
import { segmentLine, type SegmentLine } from './measure';
import { tidyNetwork } from './network';
import { fillThinHoles, gapStrips } from './network/gaps';
import { projectLines, projectPolygons, str, type SourceFeature } from './source';

// Clipped ends land on the window's edge to Clipper's precision.
const WINDOW_EDGE_MM = 0.05;

export type RoadGroup = 'road' | 'path' | 'rail';

export interface RoadPiece extends SubSegment {
  group: RoadGroup;
  widthMm: number;
  /** Where each point lies along the segment, 0 to 1, for edits to a block of it (measure.ts). Set once laid out. */
  measure?: number[];
  /** A divided road's merged line: the other carriageway's segments (network/divided.ts). */
  partners?: string[];
  /** The one of them it lies along, and where each point lies along that, once laid out. */
  partner?: string;
  partnerMeasure?: number[];
}

export interface RoadResult {
  road: MultiPolygon;
  path: MultiPolygon;
  rail: MultiPolygon;
  /** Every ground ribbon together. */
  footprint: MultiPolygon;
  /** Centerlines of bridge-flagged pieces, in model mm. */
  bridgeLines: Vec2[][];
}

export function groupOf(piece: SubSegment): RoadGroup {
  if (piece.roadClass === RAIL_CLASS) return 'rail';
  if (MINOR_ROAD_CLASSES.has(piece.roadClass) || piece.roadClass === 'pedestrian') return 'path';
  return 'road';
}

/**
 * Split, filter and size every road and rail centerline near the model.
 * `hold` sees the pieces as mapped before the tidy, and can hand back some
 * of them (cut from those) for the tidy to leave alone.
 */
export async function collectRoadPieces(
  features: SourceFeature[],
  ctx: Context,
  hold?: (pieces: RoadPiece[]) => { pieces: RoadPiece[]; held: ReadonlySet<RoadPiece> } | null,
): Promise<{ pieces: RoadPiece[]; bridgeLines: Vec2[][]; lines: Map<string, SegmentLine>; mapped?: RoadPiece[] }> {
  const { settings } = ctx;
  const roads = settings.roads;
  const mm = ctx.projection.mmPerMetre;
  // Only lines near the model matter, so clip generously before buffering.
  const window = offsetPolygons(ctx.cropSet, roads.maxWidthMm + 1);
  let pieces: RoadPiece[] = [];
  // Never built, but the tidy needs to know what an end met.
  const leftOut: Vec2[][] = [];
  const hidden: Vec2[][] = [];
  // Each segment's whole line, which pieces are measured along at the end.
  const lines = new Map<string, SegmentLine>();

  for (let index = 0; index < features.length; index++) {
    const feature = features[index];
    const subtype = str(feature.props.subtype);
    if (subtype === 'rail') {
      if (!roads.includeRail) continue;
    } else if (subtype !== 'road') {
      continue;
    }
    const projected = projectLines(feature.geometry, ctx.projection);
    // Overture segments are single lines. Anything else isn't measured.
    if (projected.length === 1) {
      const line = segmentLine(projected[0]);
      if (line) lines.set(feature.id, line);
    }
    for (const line of projected) {
      const split =
        subtype === 'rail'
          ? splitSegment(feature.id, line, feature.props, { [RAIL_CLASS]: RAIL_WIDTH_M }, RAIL_CLASS)
          : splitSegment(feature.id, line, feature.props);
      for (const piece of split) {
        if (piece.flags.has('is_tunnel')) {
          count(ctx, 'skipped_tunnels');
          hidden.push(piece.points);
          continue;
        }
        // Corridors inside buildings, skyways included. Printed, they only
        // showed where they poked out of a footprint.
        if (piece.flags.has('is_indoor')) {
          count(ctx, 'skipped_indoor');
          hidden.push(piece.points);
          continue;
        }
        if (subtype === 'road' && !roads.includePaths && MINOR_ROAD_CLASSES.has(piece.roadClass)) {
          count(ctx, 'skipped_minor_roads');
          leftOut.push(piece.points);
          continue;
        }
        if (subtype === 'road' && roads.skipSidewalks && SIDEPATH_SUBCLASSES.has(piece.subclass)) {
          count(ctx, 'skipped_sidepaths');
          leftOut.push(piece.points);
          continue;
        }
        const widthMm = Math.min(Math.max(piece.widthM * mm, roads.minWidthMm), Math.max(roads.maxWidthMm, roads.minWidthMm));
        // Only pieces crossing the window's edge need an exact clip.
        const inside = piece.points.every(([x, y]) => pointInPolygon(x, y, window[0]));
        for (const clipped of inside ? [piece.points] : clipLines([piece.points], window)) {
          pieces.push({ ...piece, points: clipped, group: groupOf(piece), widthMm });
        }
      }
    }
    if (index % 64 === 0) await ctx.progress.checkpoint(index / features.length);
  }
  const holding = hold?.(pieces);
  if (holding) pieces = holding.pieces;
  let mapped: RoadPiece[] | undefined;
  if (roads.tidy && (roads.removeDoubled || roads.mergeDivided || roads.joinEnds || roads.removeFragments)) {
    ctx.progress.begin('tidy', 'Tidying the road network');
    const edges = new EdgeIndex(window, 2);
    const minDeck = MINIMUM_BRIDGE_M * mm;
    const tidied = tidyNetwork({
      pieces,
      leftOut,
      hidden,
      onEdge: ([x, y]) => edges.distance(x, y, WINDOW_EDGE_MM) < WINDOW_EDGE_MM,
      isDeck: (piece) => settings.bridges.enabled && piece.flags.has('is_bridge') && polylineLength(piece.points) >= minDeck,
      isHeld: holding?.held.size ? (piece) => holding.held.has(piece) : undefined,
      gapMm: roads.gapMm,
      removeDoubled: roads.removeDoubled,
      mergeDivided: roads.mergeDivided,
      joinEnds: roads.joinEnds,
      removeFragments: roads.removeFragments,
      progress: (fraction) => ctx.progress.report(fraction),
    });
    mapped = pieces;
    pieces = tidied.pieces;
    Object.assign(ctx.stats, tidied.stats);
  }
  const bridgeLines = pieces.filter((p) => p.flags.has('is_bridge')).map((p) => p.points);
  ctx.stats.road_pieces = pieces.length;
  ctx.stats.bridge_pieces = bridgeLines.length;
  return { pieces, bridgeLines, lines, mapped };
}

/**
 * Ribbons for ground pieces, one unioned set per group, clipped to the model.
 * The editor runs it on one tile at a time, with the tile as the crop.
 */
export async function bufferRoads(
  pieces: RoadPiece[],
  ctx: Pick<Context, 'settings' | 'cropSet' | 'progress' | 'stats'>,
  /** The share of the current progress step this call reports over. */
  span: [number, number] = [0, 1],
): Promise<{ road: MultiPolygon; path: MultiPolygon; rail: MultiPolygon; footprint: MultiPolygon }> {
  // Ground too thin to print between two roads side by side is filled in
  // (network/gaps.ts), in the same union as the roads either side of it.
  const roads = ctx.settings.roads;
  const strips = roads.tidy && roads.fillGaps ? gapStrips(pieces, roads.gapMm) : null;
  if (strips) count(ctx, 'road_gaps_filled', strips.road.length + strips.rail.length + strips.path.length);
  let holes = 0;
  const buffer = async (group: RoadGroup, fraction: number) => {
    const lines = pieces.filter((p) => p.group === group).map((p) => ({ points: p.points, width: p.widthMm }));
    let ribbons = bufferLines(lines, 'round', strips?.[group]);
    if (strips && group !== 'rail') {
      const filled = fillThinHoles(ribbons, roads.gapMm);
      ribbons = filled.polygons;
      holes += filled.filled;
    }
    await ctx.progress.checkpoint(span[0] + (span[1] - span[0]) * fraction);
    return ribbons;
  };
  let road = await buffer('road', RIBBON_SHARES.road);
  let rail = await buffer('rail', RIBBON_SHARES.rail);
  let path = await buffer('path', RIBBON_SHARES.path);
  if (holes) count(ctx, 'road_holes_filled', holes);

  // One owner per spot: streets over rail at level crossings, both over paths.
  const clipped = (fraction: number) => ctx.progress.checkpoint(span[0] + (span[1] - span[0]) * fraction);
  road = separateTouching(dropSmall(intersection(road, ctx.cropSet), 0.02));
  await clipped(RIBBON_SHARES.roadClip);
  rail = separateTouching(dropSmall(differenceSet(intersection(rail, ctx.cropSet), new ClipSet([road])), 0.02));
  await clipped(RIBBON_SHARES.railClip);
  path = separateTouching(dropSmall(differenceSet(intersection(path, ctx.cropSet), new ClipSet([road, rail])), 0.02));

  // The groups are disjoint now. Later booleans take touching polygons as they are.
  return { road, path, rail, footprint: [...road, ...rail, ...path] };
}

// Where each group's buffer ends, then its clip, as a share of bufferRoads'
// time. The clips took as long as the buffers, the paths' longest.
const RIBBON_SHARES = { road: 0.4, rail: 0.43, path: 0.48, roadClip: 0.62, railClip: 0.68 };

// Airport paving from base/infrastructure (subtype airport). Aprons and
// helipads are mapped as areas, runways and taxiways as centerlines, widened
// by their tagged width or a typical one. The airport boundary itself is not
// paving: it would cover the grass between the runways.
export const AIRPORT_AREAS = new Set(['apron', 'helipad']);
export const AIRPORT_LINE_WIDTH_M: Record<string, number> = { runway: 45, stopway: 45, taxiway: 23, taxilane: 15 };
const SQUARE_ENDED = new Set(['runway', 'stopway']);

function tagWidthM(props: Record<string, unknown>): number | null {
  const tags = props.source_tags as Record<string, unknown> | undefined;
  const raw = props.width ?? (tags && typeof tags === 'object' ? tags.width : undefined);
  if (typeof raw === 'number') return raw > 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(m|ft|feet)?$/);
  if (!match) return null;
  const value = Number(match[1]) * (match[2] === 'ft' || match[2] === 'feet' ? 0.3048 : 1);
  return value > 0 ? value : null;
}

export function buildAirports(features: SourceFeature[], ctx: Context): MultiPolygon {
  const mm = ctx.projection.mmPerMetre;
  const areas: Polygon[] = [];
  const round: { points: Vec2[]; width: number }[] = [];
  const square: { points: Vec2[]; width: number }[] = [];
  for (const feature of features) {
    if (str(feature.props.subtype) !== 'airport') continue;
    const cls = str(feature.props.class);
    if (AIRPORT_AREAS.has(cls)) {
      areas.push(...projectPolygons(feature.geometry, ctx.projection));
      continue;
    }
    const defaultWidth = AIRPORT_LINE_WIDTH_M[cls];
    if (!defaultWidth) continue;
    const width = (tagWidthM(feature.props) ?? defaultWidth) * mm;
    for (const points of projectLines(feature.geometry, ctx.projection)) {
      (SQUARE_ENDED.has(cls) ? square : round).push({ points, width });
    }
  }
  if (!areas.length && !round.length && !square.length) return [];
  const paving = union(clipToBox(areas, ctx.cropBox), bufferLines(round, 'round'), bufferLines(square, 'butt'));
  const clipped = dropSmall(intersection(paving, ctx.cropSet), 0.05);
  ctx.stats.airport_surfaces = clipped.length;
  return clipped;
}
