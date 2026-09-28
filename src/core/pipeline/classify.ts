// Which Overture features become which printable surface. Deliberately an
// allowlist: an unrecognised class produces nothing rather than a guess.

import type { SurfaceCategory } from '../settings';
import { isPolygonal, str, type SourceFeature, type SourceType } from './source';

// base/land: physical ground cover, including individual tree points.
export const LAND_CLASS: Record<string, SurfaceCategory> = {
  forest: 'forest', wood: 'forest', tree_row: 'forest',
  scrub: 'green', shrub: 'green', heath: 'green', grass: 'green', grassland: 'green', meadow: 'green', wetland: 'green',
  sand: 'sand', beach: 'sand', shingle: 'sand', dune: 'sand',
  rock: 'rock', bare_rock: 'rock', scree: 'rock', cliff: 'rock',
};

// base/land_use: how people use the ground.
export const LAND_USE_CLASS: Record<string, SurfaceCategory> = {
  park: 'green', grass: 'green', garden: 'green', forest: 'forest', wood: 'forest', meadow: 'green',
  orchard: 'green', vineyard: 'green', farmland: 'green', allotments: 'green', village_green: 'green',
  recreation_ground: 'green', golf_course: 'green', cemetery: 'green', grave_yard: 'green', pitch: 'green',
  playground: 'green', flowerbed: 'green', dog_park: 'green', nature_reserve: 'green', stadium: 'green',
  pedestrian: 'paved', plaza: 'paved',
};

// base/land_cover: coarse satellite cover. Only vegetation, since "urban" would
// blanket the whole selection.
export const LAND_COVER_SUBTYPE: Record<string, SurfaceCategory> = {
  forest: 'forest', mangrove: 'forest', shrub: 'green', grass: 'green', moss: 'green', wetland: 'green',
};

export function classifySurface(type: SourceType, feature: SourceFeature): SurfaceCategory | null {
  const cls = str(feature.props.class);
  const subtype = str(feature.props.subtype);
  if (type === 'land') return LAND_CLASS[cls] ?? LAND_CLASS[subtype] ?? null;
  if (type === 'land_use') return LAND_USE_CLASS[cls] ?? LAND_USE_CLASS[subtype] ?? null;
  if (type === 'land_cover') return LAND_COVER_SUBTYPE[subtype] ?? LAND_COVER_SUBTYPE[cls] ?? null;
  return null;
}

export function isTreePoint(feature: SourceFeature): boolean {
  if (feature.geometry?.type !== 'Point') return false;
  return str(feature.props.class) === 'tree' || str(feature.props.subtype) === 'tree';
}

// Not printable open water at city scale.
const EXCLUDED_WATER = new Set(['swimming_pool', 'fountain']);

export function isPrintableWater(feature: SourceFeature): boolean {
  return isPolygonal(feature.geometry) && !EXCLUDED_WATER.has(str(feature.props.class));
}

/** OSM tags Overture carries over, plus the few that may sit at the top level. */
export function sourceTags(feature: SourceFeature): Record<string, string> {
  const tags: Record<string, string> = {};
  const props = feature.props;
  for (const key of ['natural', 'water', 'amenity', 'waterway', 'bridge', 'man_made']) {
    if (props[key] !== undefined && props[key] !== null) tags[key] = String(props[key]).trim().toLowerCase();
  }
  for (const key of ['source_tags', 'tags']) {
    const source = props[key];
    if (!source) continue;
    if (source instanceof Map) {
      for (const [k, v] of source) tags[String(k).trim().toLowerCase()] = String(v).trim().toLowerCase();
    } else if (Array.isArray(source)) {
      for (const item of source) {
        if (Array.isArray(item) && item.length === 2) tags[String(item[0]).toLowerCase()] = String(item[1]).toLowerCase();
        else if (item && typeof item === 'object' && 'key' in item && 'value' in item) {
          tags[String((item as { key: unknown }).key).toLowerCase()] = String((item as { value: unknown }).value).toLowerCase();
        }
      }
    } else if (typeof source === 'object') {
      for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
        if (v !== null && v !== undefined) tags[k.trim().toLowerCase()] = String(v).trim().toLowerCase();
      }
    }
  }
  return tags;
}

/** Generic polygonal water eligible for the size-checked recess fallback. */
export function isUntypedWater(feature: SourceFeature): boolean {
  if (!isPolygonal(feature.geometry)) return false;
  const cls = str(feature.props.class);
  const subtype = str(feature.props.subtype);
  const tags = sourceTags(feature);
  return (
    (cls === '' || cls === 'water') &&
    (subtype === '' || subtype === 'water') &&
    Boolean(cls || subtype || tags.natural === 'water') &&
    !tags.water &&
    !tags.waterway &&
    (tags.natural ?? 'water') === 'water' &&
    !tags.amenity
  );
}

const NOT_BASIN = new Set([
  'river', 'stream', 'lake', 'reservoir', 'canal', 'ocean', 'bay', 'sea', 'strait', 'drain', 'ditch', 'swimming_pool',
]);

/**
 * Mapped ponds, fountains and basins, identified by their tags and classes,
 * never by size or name. A point fountain has no footprint to recess.
 */
export function recessedWaterKind(feature: SourceFeature): string | null {
  if (!isPolygonal(feature.geometry)) return null;
  const tags = sourceTags(feature);
  if (['river', 'stream', 'canal', 'drain', 'ditch'].includes(tags.waterway)) return null;
  if (tags.water && tags.water !== 'pond' && tags.water !== 'basin') return null;
  if (tags.amenity === 'fountain') return 'fountain';
  if (tags.natural === 'water' && (tags.water === 'pond' || tags.water === 'basin')) return tags.water;
  const cls = str(feature.props.class);
  const subtype = str(feature.props.subtype);
  if (NOT_BASIN.has(cls)) return null;
  // A mapped basin may carry the broader subtype "reservoir". Its class decides.
  if (cls === 'pond' || cls === 'fountain' || cls === 'basin') return cls;
  if (subtype === 'pond' || subtype === 'fountain' || subtype === 'basin') return subtype;
  return null;
}

// Ground that sits out over water: a pier deck, a quay, a dam crest. A
// marina describes a facility's land and water, not a deck, so it is not here.
export const WATER_DECK = new Set(['pier', 'breakwater', 'quay', 'dam', 'weir', 'boardwalk', 'groyne']);
const WATER_DECK_TYPES = new Set<SourceType>(['land', 'land_use', 'infrastructure']);

export function isWaterDeck(type: SourceType, feature: SourceFeature): boolean {
  if (!WATER_DECK_TYPES.has(type) || !isPolygonal(feature.geometry)) return false;
  return WATER_DECK.has(str(feature.props.class)) || WATER_DECK.has(str(feature.props.subtype));
}

/** A mapped area that is the surface of a bridge rather than ground. */
export function isBridgeArea(feature: SourceFeature): boolean {
  const tags = sourceTags(feature);
  const bridge = tags.bridge ?? '';
  return (bridge !== '' && bridge !== 'no') || tags.man_made === 'bridge';
}
