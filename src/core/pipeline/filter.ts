// Which downloaded rows generation can use at all, decided from the small
// columns before any geometry is read. Anything this drops would be ignored
// later anyway, so the data layer never downloads its geometry.

import type { ModelSettings } from '../settings';
import type { GeoBounds } from '../types';
import { LAND_CLASS, LAND_COVER_SUBTYPE, LAND_USE_CLASS, WATER_DECK } from './classify';
import { MINOR_ROAD_CLASSES } from './linework';
import { AIRPORT_AREAS, AIRPORT_LINE_WIDTH_M } from './roads';
import { MAXIMUM_EXTENT_RATIO, str, type SourceType } from './source';

export type RowFilter = (type: SourceType, props: Record<string, unknown>, bbox: [number, number, number, number]) => boolean;

export function rowFilter(settings: ModelSettings, bounds: GeoBounds): RowFilter {
  const selection = Math.max((bounds.east - bounds.west) * (bounds.north - bounds.south), 1e-12);
  // A polygon far larger than the selection describes a region, not this place.
  const regional = (bbox: [number, number, number, number]) =>
    ((bbox[2] - bbox[0]) * (bbox[3] - bbox[1])) / selection > MAXIMUM_EXTENT_RATIO;
  const trees = settings.trees.enabled;
  const mappedTrees = trees && settings.trees.mapped;
  const forestTrees = trees && settings.trees.forestScatter;
  const surfaces = settings.land.enabled;
  const decks = settings.supports;
  const lidarRock =
    settings.buildings.enabled && settings.lidar.enabled && settings.lidar.rockSurfaces && settings.lidar.roofMode === 'envelope';

  return (type, props, bbox) => {
    const cls = str(props.class);
    const subtype = str(props.subtype);
    switch (type) {
      case 'building':
      case 'building_part':
        return props.is_underground !== true;
      case 'segment':
        if (subtype === 'rail') return settings.roads.includeRail;
        if (subtype !== 'road') return false;
        return settings.roads.includePaths || !MINOR_ROAD_CLASSES.has(cls);
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
        if (!category || regional(bbox)) return false;
        return surfaces || (forestTrees && settings.trees.landCoverScatter && category === 'forest');
      }
      case 'infrastructure':
        if (subtype === 'airport') {
          return settings.roads.enabled && settings.roads.includeAirports && (AIRPORT_AREAS.has(cls) || cls in AIRPORT_LINE_WIDTH_M);
        }
        return decks && (WATER_DECK.has(cls) || WATER_DECK.has(subtype));
    }
    return true;
  };
}
