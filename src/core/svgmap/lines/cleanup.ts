// Weld, cull, collapse loops, snap gaps, prune tangles, thin dense patches, weld
// again, prune stubs. The order matters, see the notes below.
import { cullRanked } from './cull';
import { relieveDenseClusters } from './dense';
import type { LineItem, Point } from './geometry';
import { collapseFilledLoops } from './loops';
import { pruneCompactTangles, pruneDanglingStubs } from './prune';
import { snapDanglingEnds } from './snap';
import { weldPaths } from './weld';

export interface CleanupSettings {
  enabled: boolean;
  weld: boolean;
  weldTolerance: number;
  weldThroughJunctions: boolean;
  junctionMaxTurn: number;
  cull: boolean;
  // About one beam or pen width.
  lineSpacing: number;
  parallelAngle: number;
  wholePaths: boolean;
  shadowFraction: number;
  // Footpaths get trimmed segment by segment, tangle pruning and longer stubs.
  aggressivePaths: boolean;
  pathStubs: number;
  tangleSpan: number;
  tangleSegments: number;
  tangleRatio: number;
  collapseLoops: boolean;
  loopRadius: number;
  dense: boolean;
  denseLimit: number;
  denseWindow: number;
  denseSeparation: number;
  denseHotFraction: number;
  denseShadowFraction: number;
  denseProtectRank: number;
  denseMeshMax: number;
  denseMeshDetour: number;
  denseCountsFill: boolean;
  denseCoveredScale: number;
  snapGap: number;
  pruneStubs: number;
  coverageTolerance: number;
}

// Defaults from the original pipeline, tuned on real plaques. Welding through
// junctions was off there because OSM ways rarely need it. Tile data is also
// split at tile edges, and on the Chicago Loop it cut separate burns by about 20%.
export const DEFAULT_CLEANUP: CleanupSettings = {
  enabled: true,
  weld: true,
  weldTolerance: 0.03,
  weldThroughJunctions: true,
  junctionMaxTurn: 45,
  cull: true,
  lineSpacing: 0.3,
  parallelAngle: 28,
  wholePaths: true,
  shadowFraction: 0.68,
  aggressivePaths: true,
  pathStubs: 1.2,
  tangleSpan: 6,
  tangleSegments: 20,
  tangleRatio: 3.6,
  collapseLoops: true,
  loopRadius: 0.25,
  dense: true,
  denseLimit: 2.7,
  denseWindow: 2,
  denseSeparation: 0.5,
  denseHotFraction: 0.6,
  denseShadowFraction: 0.88,
  denseProtectRank: 6,
  denseMeshMax: 2.5,
  denseMeshDetour: 4,
  denseCountsFill: true,
  denseCoveredScale: 0.6,
  snapGap: 0.3,
  pruneStubs: 0.7,
  coverageTolerance: 0.2,
};

export interface CleanupStats {
  pathsBefore: number;
  pathsAfter: number;
  weldedJoins: number;
  culledPaths: number;
  trimmedPaths: number;
  culledMm: number;
  collapsedLoops: number;
  snappedGaps: number;
  prunedTangles: number;
  denseDropped: number;
  denseMesh: number;
  denseMm: number;
  denseCells: number;
  prunedStubs: number;
  stages: Record<string, Record<string, number>>;
}

export interface CleanupContext<K> {
  groupOf: (key: K) => string;
  isPathGroup: (key: K) => boolean;
  // Ends cut by the crop are not loose ends.
  onBoundary?: (point: Point) => boolean;
  coveredFn?: ((point: Point) => boolean) | null;
}

function countByGroup<K>(items: readonly LineItem<K>[], groupOf: (key: K) => string) {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const group = groupOf(item.key);
    counts[group] = (counts[group] ?? 0) + 1;
  }
  return counts;
}

export function cleanupLines<K>(
  input: readonly LineItem<K>[],
  settings: CleanupSettings,
  context: CleanupContext<K>,
): { items: LineItem<K>[]; stats: CleanupStats } {
  const stats: CleanupStats = {
    pathsBefore: input.length,
    pathsAfter: input.length,
    weldedJoins: 0,
    culledPaths: 0,
    trimmedPaths: 0,
    culledMm: 0,
    collapsedLoops: 0,
    snappedGaps: 0,
    prunedTangles: 0,
    denseDropped: 0,
    denseMesh: 0,
    denseMm: 0,
    denseCells: 0,
    prunedStubs: 0,
    stages: {},
  };
  if (!settings.enabled) return { items: [...input], stats };

  const { groupOf, isPathGroup, onBoundary, coveredFn } = context;
  const stage = (name: string, items: readonly LineItem<K>[]) => {
    stats.stages[name] = countByGroup(items, groupOf);
  };
  const weld = (items: LineItem<K>[]) => {
    if (!settings.weld) return items;
    const result = weldPaths(items, settings.weldTolerance, {
      groupFn: groupOf,
      junctionTurnDeg: settings.weldThroughJunctions ? settings.junctionMaxTurn : null,
    });
    stats.weldedJoins += result.joins;
    return result.items;
  };

  let items: LineItem<K>[] = [...input];
  stage('input', items);

  // Weld first. Whole-path culling only protects a road if the path is the whole road.
  items = weld(items);
  stage('afterWeld', items);

  if (settings.cull) {
    const culled = cullRanked(items, settings.lineSpacing, {
      maxAngleDeg: settings.parallelAngle,
      wholePaths: (key: K) => settings.wholePaths && !(settings.aggressivePaths && isPathGroup(key)),
      shadowFraction: settings.shadowFraction,
    });
    items = culled.kept;
    stats.culledPaths = culled.stats.dropped;
    stats.trimmedPaths = culled.stats.trimmed;
    stats.culledMm = culled.stats.removedLength;
  }
  stage('afterCull', items);

  if (settings.collapseLoops) {
    const result = collapseFilledLoops(items, settings.loopRadius, settings.weldTolerance);
    items = result.items;
    stats.collapsedLoops = result.collapsed;
  }

  if (settings.snapGap > 0) {
    const result = snapDanglingEnds(items, settings.snapGap, settings.weldTolerance, onBoundary);
    items = result.items;
    stats.snappedGaps = result.snapped;
  }

  if (settings.aggressivePaths) {
    const result = pruneCompactTangles(
      items,
      settings.tangleSpan,
      settings.tangleSegments,
      settings.tangleRatio,
      settings.weldTolerance,
      isPathGroup,
    );
    items = result.items;
    stats.prunedTangles = result.removed;
  }
  stage('afterTangle', items);

  // Last of the removals. Run earlier, it took bites out of tangles that would
  // have been removed whole, and the leftovers survived.
  if (settings.dense) {
    const result = relieveDenseClusters(items, settings.denseLimit, settings.denseWindow, settings.denseSeparation, {
      maxAngleDeg: settings.parallelAngle,
      hotFraction: settings.denseHotFraction,
      shadowFraction: settings.denseShadowFraction,
      protectRank: settings.denseProtectRank,
      meshMaxLength: settings.denseMeshMax,
      meshDetour: settings.denseMeshDetour,
      weldTolerance: settings.weldTolerance,
      coveredFn: settings.denseCountsFill ? (coveredFn ?? null) : null,
      coveredLimitScale: settings.denseCoveredScale,
    });
    items = result.items;
    stats.denseDropped = result.stats.dropped;
    stats.denseMesh = result.stats.meshDropped;
    stats.denseMm = result.stats.removedLength;
    stats.denseCells = result.stats.hotCells;
  }
  stage('afterDensity', items);

  // Culling trims paths into pieces and snapping brings ends together, so weld again.
  items = weld(items);
  stage('afterReweld', items);

  if (settings.pruneStubs > 0) {
    const limit = (key: K) =>
      settings.aggressivePaths && isPathGroup(key) ? settings.pathStubs : settings.pruneStubs;
    const result = pruneDanglingStubs(items, limit, settings.weldTolerance, onBoundary);
    items = result.items;
    stats.prunedStubs = result.removed;
  }
  stage('final', items);
  stats.pathsAfter = items.length;
  return { items, stats };
}
