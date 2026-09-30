// The types and rows generation needs, decided before geometry is read.
// The same requirements key the worker's cached download.

import type { ModelSettings } from '../settings';
import type { GeoBounds } from '../types';
import { LAND_CLASS, LAND_COVER_SUBTYPE, LAND_USE_CLASS, WATER_DECK } from './classify';
import { MINOR_ROAD_CLASSES } from './linework';
import { AIRPORT_AREAS, AIRPORT_LINE_WIDTH_M } from './roads';
import { isDetailedCover, MAXIMUM_EXTENT_RATIO, str, type SourceType } from './source';

export type RowFilter = (type: SourceType, props: Record<string, unknown>, bbox: [number, number, number, number]) => boolean;

interface Requirements {
  roads: boolean;
  buildings: boolean;
  rail: boolean;
  paths: boolean;
  airports: boolean;
  surfaces: boolean;
  landCoverSurfaces: boolean;
  decks: boolean;
  mappedTrees: boolean;
  forestTrees: boolean;
  landCoverTrees: boolean;
  lidarRock: boolean;
}

function requirements(settings: ModelSettings): Requirements {
  const trees = settings.trees;
  const forestTrees = trees.enabled && trees.forestScatter;
  return {
    roads: settings.roads.enabled,
    buildings: settings.buildings.enabled,
    rail: settings.roads.includeRail,
    paths: settings.roads.includePaths,
    airports: settings.roads.enabled && settings.roads.includeAirports,
    surfaces: settings.land.enabled,
    landCoverSurfaces: settings.land.enabled && settings.land.satelliteCover,
    // Mapped piers, quays and dams are ground in cut water whatever the supports.
    decks: true,
    mappedTrees: trees.enabled && trees.mapped,
    forestTrees,
    landCoverTrees: forestTrees && trees.landCoverScatter,
    lidarRock: settings.buildings.enabled && settings.lidar.enabled && settings.lidar.rockSurfaces && settings.lidar.roofMode === 'envelope',
  };
}

function neededTypes(need: Requirements): SourceType[] {
  // Water always shapes the terrain, even when its fill is hidden.
  const types = new Set<SourceType>(['water']);
  if (need.roads) {
    types.add('segment');
    if (need.airports) types.add('infrastructure');
  }
  // Piers keep their ground over cut water even with land surfaces off.
  if (need.decks) types.add('infrastructure');
  if (need.buildings) {
    types.add('building');
    types.add('building_part');
  }
  if (need.surfaces || need.decks || need.forestTrees || need.lidarRock || need.mappedTrees) types.add('land');
  if (need.surfaces || need.decks || need.forestTrees) types.add('land_use');
  if (need.landCoverSurfaces || need.landCoverTrees) types.add('land_cover');
  return [...types];
}

function rowFilter(need: Requirements, bounds: GeoBounds): RowFilter {
  const selection = Math.max((bounds.east - bounds.west) * (bounds.north - bounds.south), 1e-12);
  // A polygon far larger than the selection describes a region, not this place.
  const regional = (bbox: [number, number, number, number]) =>
    ((bbox[2] - bbox[0]) * (bbox[3] - bbox[1])) / selection > MAXIMUM_EXTENT_RATIO;
  const { mappedTrees, forestTrees, surfaces, decks, lidarRock } = need;

  return (type, props, bbox) => {
    const cls = str(props.class);
    const subtype = str(props.subtype);
    switch (type) {
      case 'building':
      case 'building_part':
        return props.is_underground !== true;
      case 'segment':
        if (subtype === 'rail') return need.rail;
        if (subtype !== 'road') return false;
        return need.paths || !MINOR_ROAD_CLASSES.has(cls);
      case 'water':
        return cls !== 'swimming_pool';
      case 'land': {
        if (cls === 'tree' || subtype === 'tree') return mappedTrees;
        if (decks && (WATER_DECK.has(cls) || WATER_DECK.has(subtype))) return true;
        // Mapped bare rock LiDAR measures, whatever its extent (as the add-on's rock domains).
        if (lidarRock && cls === 'bare_rock') return true;
        const category = LAND_CLASS[cls] ?? LAND_CLASS[subtype];
        if (!category || regional(bbox)) return false;
        return surfaces || (forestTrees && category === 'forest');
      }
      case 'land_use': {
        if (decks && (WATER_DECK.has(cls) || WATER_DECK.has(subtype))) return true;
        const category = LAND_USE_CLASS[cls] ?? LAND_USE_CLASS[subtype];
        if (!category || regional(bbox)) return false;
        return surfaces || (forestTrees && category === 'forest');
      }
      case 'land_cover': {
        const category = LAND_COVER_SUBTYPE[subtype] ?? LAND_COVER_SUBTYPE[cls];
        if (!category || !isDetailedCover(props, [bbox[2] - bbox[0], bbox[3] - bbox[1]])) return false;
        return need.landCoverSurfaces || (need.landCoverTrees && category === 'forest');
      }
      case 'infrastructure':
        if (subtype === 'airport') {
          return need.airports && (AIRPORT_AREAS.has(cls) || cls in AIRPORT_LINE_WIDTH_M);
        }
        return decks && (WATER_DECK.has(cls) || WATER_DECK.has(subtype));
    }
    return true;
  };
}

export interface DataPlan {
  types: SourceType[];
  keep: RowFilter;
  /** Selection settings only. The caller also keys the geographic bounds. */
  key: string;
}

export function dataPlan(settings: ModelSettings, bounds: GeoBounds): DataPlan {
  const need = requirements(settings);
  return { types: neededTypes(need), keep: rowFilter(need, bounds), key: JSON.stringify(need) };
}
