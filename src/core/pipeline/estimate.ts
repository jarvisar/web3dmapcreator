// How long each step of a job should take, for the progress bar and the time
// left (Progress.plan). Seconds are what the CLI takes on the machine these
// were timed on (out/progress-lab), from feature counts alone, so they can be
// worked out from Overture's row counts before the geometry is downloaded.
// The time left scales them by how this machine compares as steps finish.
//
// They're rough. Roads went from 150 to 580 µs per segment over the regression
// areas (Las Vegas' interchanges are the slow end), but the pace a step shows
// takes over from its estimate as it goes.

import type { Layer } from '../geometry/solid';
import type { AreaSpec, ModelSettings } from '../settings';
import type { PlannedStep } from './context';
import { meshCost } from './mesh';
import type { SourceType } from './source';

export type FeatureCounts = Partial<Record<SourceType, number>>;

// Meshing time per unit of meshCost, the first time in a session and once
// the code is warm, as an export is.
const MESH_SECONDS_PER_COST = 1.85e-6;
const WARM_MESH_SECONDS_PER_COST = 1.4e-6;
const WRITE_SECONDS_PER_TRIANGLE = 1.25e-6;

// Laying out routes, per point of the tracks: snapping is most of it.
const ROUTE_SECONDS_PER_POINT = 2e-4;

/** Laying out imported routes with this many points between them. */
export function routeSeconds(points: number): number {
  return 0.02 + ROUTE_SECONDS_PER_POINT * points;
}

/** The steps of generateModel and the meshing after it, from what the data holds. `routePoints` counts the routes' points. */
export function generationSteps(counts: FeatureCounts, settings: ModelSettings, area: AreaSpec, guess = false, routePoints = 0): PlannedStep[] {
  const n = (type: SourceType) => counts[type] ?? 0;
  const segments = settings.roads.enabled ? n('segment') : 0;
  const buildings = settings.buildings.enabled ? n('building') + n('building_part') : 0;
  const land = settings.land.enabled ? n('land_use') + n('land') + (settings.land.satelliteCover ? n('land_cover') : 0) : 0;
  const water = n('water');
  const tidy = settings.roads.tidy;
  const aspect = Math.min(area.widthM, area.heightM) / Math.max(area.widthM, area.heightM);
  const cells = settings.terrain.resolution ** 2 * aspect;
  const steps: PlannedStep[] = [
    { stage: 'grid', seconds: 0.01 + 6e-7 * cells },
    { stage: 'water', seconds: 0.05 + 2e-4 * water },
  ];
  if (segments) {
    steps.push({ stage: 'roads', seconds: 0.01 + 8e-6 * segments });
    if (tidy) steps.push({ stage: 'tidy', seconds: 0.02 + 7e-5 * segments });
    steps.push({ stage: 'ribbons', seconds: 0.02 + 1.4e-4 * segments });
    if (settings.bridges.enabled) steps.push({ stage: 'bridges', seconds: 0.05 + 3e-5 * segments });
  }
  if (buildings) {
    steps.push({ stage: 'buildings', seconds: 0.02 + 2.8e-5 * buildings });
    // The union of every footprint grows faster than their number.
    steps.push({ stage: 'footprints', seconds: 0.01 + 4.5e-7 * buildings ** 1.5 });
  }
  if (routePoints && settings.tracks.enabled) steps.push({ stage: 'routes', seconds: routeSeconds(routePoints) });
  if (land) steps.push({ stage: 'land', seconds: 0.02 + 4.5e-4 * land });
  steps.push({ stage: 'close', seconds: 0.01 + 1e-4 * water });
  if (settings.trees.enabled) steps.push({ stage: 'trees', seconds: 0.2 + 2e-4 * land });
  steps.push({ stage: 'mesh', seconds: 0.3 + 1.1e-4 * (segments + buildings + land) });
  steps.push({ stage: 'session', seconds: sessionSeconds(counts) });
  return guess ? steps.map((step) => ({ ...step, guess: true })) : steps;
}

/** Setting up the editor on a new model. */
export function sessionSeconds(counts: FeatureCounts): number {
  return 0.02 + 3e-6 * ((counts.segment ?? 0) + (counts.building ?? 0) + (counts.building_part ?? 0));
}

/** A first guess at a download nothing is known about yet: the Loop took 7 s in Edge, San Francisco's 32 km² 12 s. */
export function downloadGuess(area: AreaSpec): number {
  return 4 + (0.25 * area.widthM * area.heightM) / 1e6;
}

// First guesses at reading LiDAR, until the reading shows its own pace.
export const LIDAR_SECONDS_PER_BUILDING = 0.05;
export const LIDAR_SECONDS_PER_CELL = 2e-5;

/** Finding the surveys and reading them, both waits of unknown length. */
export function lidarSteps(seconds: number): PlannedStep[] {
  return [
    { stage: 'surveys', seconds: 8, wait: true, guess: true },
    { stage: 'lidar', seconds: 20 + seconds, wait: true, guess: true },
  ];
}

/** The cells a LiDAR only grid should have, before the survey's density can grow them. */
export function surfaceCells(area: AreaSpec, cellM: number, maxCells?: number): number {
  const cells = (Math.floor(area.widthM / cellM) + 1) * (Math.floor(area.heightM / cellM) + 1);
  return maxCells ? Math.min(cells, maxCells) : cells;
}

/** The steps of a LiDAR only model after its survey is read, from its grid. */
export function surfaceSteps(cells: number, cut: boolean, routePoints = 0): PlannedStep[] {
  return [
    ...(routePoints ? [{ stage: 'routes' as const, seconds: routeSeconds(routePoints) }] : []),
    { stage: 'compose', seconds: 0.05 + 8e-7 * cells },
    // 2 µs a cell for Chicago's 7.9 million, 4 µs for the Ferry Building's million.
    { stage: 'surface', seconds: 0.3 + 2.8e-6 * cells },
    ...(cut ? [{ stage: 'cut' as const, seconds: 0.05 + 3e-7 * cells }] : []),
    { stage: 'mesh', seconds: 0.05 + 2e-8 * cells },
    { stage: 'session', seconds: 0.05 },
  ];
}

/** Rough feature counts for an area before anything is known about it, from the regression downtowns. */
export function guessCounts(area: AreaSpec): FeatureCounts {
  const km2 = (area.widthM * area.heightM) / 1e6;
  return { segment: 1200 * km2, building: 800 * km2, building_part: 100 * km2, land_use: 200 * km2, land: 20 * km2, water: 10 * km2 };
}

/** Seconds to mesh these layers. `warm` once the meshing code has run in this worker, as for an export. */
export function meshSeconds(layers: Layer[], warm = false): number {
  let cost = 0;
  for (const layer of layers) for (const solid of layer.solids) cost += meshCost(solid);
  return 0.02 + cost * (warm ? WARM_MESH_SECONDS_PER_COST : MESH_SECONDS_PER_COST);
}

/**
 * Seconds to write a file of this many triangles. Big files slow down more
 * than their size: Paris (7.3 million) took 11 to 24 s, San Francisco (2.9 million) 3.5 s.
 */
export function writeSeconds(triangles: number): number {
  return 0.05 + triangles * WRITE_SECONDS_PER_TRIANGLE * (1 + (triangles / 1.2e7) ** 2);
}
