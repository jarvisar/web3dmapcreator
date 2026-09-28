// How tall a building or part is, from the Overture fields.
//
// Overture reports `height` as the distance from the ground to the top of the
// feature and `min_height` as the level it starts at, so a mass spans
// min_height to height. Reading height as a thickness stacked on min_height
// turns a tower's crown into a spire: Great American Tower's crown is
// published as 140 / 162.7 m and stacking them made a 302.7 m needle.

import { num, positive } from '../source';

// How tall a building of each Overture class is when the source says
// nothing. Without this a third of a downtown gets one number and a stadium,
// a parking deck and a garden shed come out the same height. An explicit
// height or floor count always wins.
export const CLASS_DEFAULT_HEIGHT_M: Readonly<Record<string, number>> = {
  // Venues. A seating bowl is low for its footprint but never one storey.
  stadium: 30,
  grandstand: 12,
  sports_centre: 12,
  sports_hall: 12,
  pavilion: 6,
  riding_hall: 10,
  // Housing.
  house: 7,
  detached: 7,
  semidetached_house: 7,
  terrace: 9,
  bungalow: 4,
  cabin: 4,
  static_caravan: 3,
  houseboat: 4,
  apartments: 18,
  residential: 12,
  dormitory: 15,
  hotel: 20,
  // Work and trade.
  office: 20,
  commercial: 12,
  retail: 8,
  supermarket: 8,
  kiosk: 3,
  industrial: 10,
  warehouse: 10,
  factory: 12,
  hangar: 12,
  // Civic and institutional.
  civic: 12,
  public: 12,
  government: 15,
  hospital: 20,
  school: 10,
  college: 12,
  university: 15,
  kindergarten: 6,
  museum: 14,
  fire_station: 8,
  // Religious.
  cathedral: 35,
  church: 20,
  chapel: 9,
  mosque: 15,
  synagogue: 14,
  temple: 12,
  religious: 12,
  // Transport and infrastructure.
  parking: 15,
  garage: 3,
  garages: 3,
  carport: 3,
  train_station: 15,
  transportation: 10,
  water_tower: 30,
  silo: 15,
  storage_tank: 12,
  service: 4,
  // Small structures. A mapped roof is a canopy, not a floor.
  roof: 4,
  shed: 3,
  hut: 3,
  greenhouse: 4,
  barn: 8,
  farm: 8,
  farm_auxiliary: 5,
  outbuilding: 3,
  container: 3,
};

// Part/parent selection uses fixed values, independent of the settings.
export const SELECTION_FLOOR_HEIGHT_M = 3;
export const SELECTION_DEFAULT_HEIGHT_M = 10;

// The tallest building standing is 828 m with 163 floors. Anything past these
// is a typo in the source (one 3000 m row prints a 231 mm needle), so it is
// read as missing and the next source is used.
export const MAXIMUM_HEIGHT_M = 1000;
export const MAXIMUM_FLOORS = 200;

export type Props = Record<string, unknown>;

export interface VerticalProfile {
  /** Where the mass starts, in real metres above its ground. */
  bottomM: number;
  /** Where it stops: the source's own height. */
  topM: number;
  thicknessM: number;
  /** height, num_floors, class_default:<name> or default, with +invalid_interval when top is not above bottom. */
  heightSource: string;
  /** min_height, min_floor or ground. */
  minHeightSource: string;
  /** A height or floor count was past the plausible maximum and skipped. */
  implausible: boolean;
}

/** A property, or the OSM-style fallback key when the first is absent. A present null still wins, as in the source data. */
export function prop(props: Props, key: string, fallbackKey: string): unknown {
  return Object.prototype.hasOwnProperty.call(props, key) ? props[key] : props[fallbackKey];
}

/** `String(value)` for a truthy value, else "". */
export function text(value: unknown): string {
  return value ? String(value) : '';
}

function nonnegative(value: unknown): number | null {
  const n = num(value);
  return n !== null && n >= 0 ? n : null;
}

/**
 * Numeric metres, or an explicitly unit-tagged OSM length. Units are never
 * stripped to treat feet as metres, and ambiguous lists stay missing.
 */
export function lengthMetres(value: unknown): number | null {
  const n = nonnegative(value);
  if (n !== null) return n;
  if (typeof value !== 'string') return null;
  let match = /^\s*(\d+(?:\.\d+)?)\s*(m|metres|meters|ft|feet)\s*$/.exec(value);
  if (match) return Number(match[1]) * (match[2] === 'ft' || match[2] === 'feet' ? 0.3048 : 1);
  match = /^\s*(\d+)'\s*(\d+(?:\.\d+)?)?"?\s*$/.exec(value);
  if (match) return Number(match[1]) * 0.3048 + Number(match[2] ?? 0) * 0.0254;
  return null;
}

/** The fallback height for a feature's class or subtype, and where it came from. */
export function classDefaultHeight(props: Props, fallbackM: number): [number, string] {
  for (const field of ['class', 'subtype']) {
    const name = text(props[field]).trim().toLowerCase();
    const height = Object.prototype.hasOwnProperty.call(CLASS_DEFAULT_HEIGHT_M, name) ? CLASS_DEFAULT_HEIGHT_M[name] : undefined;
    if (height !== undefined) return [height, `class_default:${name}`];
  }
  return [fallbackM, 'default'];
}

/**
 * The fallback chain: height, then floors, then the class default, then the
 * configured default. Both height and num_floors are measured from the
 * ground, so each gives the top of the mass. An inverted interval is marked
 * and left for the caller to skip. A taller top is never invented.
 */
export function resolveVerticalProfile(props: Props, floorHeightM: number, defaultHeightM: number): VerticalProfile {
  let implausible = false;
  const upTo = (value: number | null, maximum: number): number | null => {
    if (value === null || value <= maximum) return value;
    implausible = true;
    return null;
  };
  const explicitHeight = upTo(positive(lengthMetres(props.height)), MAXIMUM_HEIGHT_M);
  const floors = upTo(positive(prop(props, 'num_floors', 'building:levels')), MAXIMUM_FLOORS);
  let topM: number;
  let heightSource: string;
  if (explicitHeight !== null) {
    topM = explicitHeight;
    heightSource = 'height';
  } else if (floors !== null) {
    topM = floors * floorHeightM;
    heightSource = 'num_floors';
  } else {
    [topM, heightSource] = classDefaultHeight(props, defaultHeightM);
  }

  const explicitMinimum = upTo(lengthMetres(props.min_height), MAXIMUM_HEIGHT_M);
  const minFloor = upTo(nonnegative(prop(props, 'min_floor', 'building:min_level')), MAXIMUM_FLOORS);
  let bottomM = 0;
  let minHeightSource = 'ground';
  if (explicitMinimum !== null) {
    bottomM = explicitMinimum;
    minHeightSource = 'min_height';
  } else if (minFloor !== null) {
    bottomM = minFloor * floorHeightM;
    minHeightSource = 'min_floor';
  }
  if (topM <= bottomM) heightSource += '+invalid_interval';
  return { bottomM, topM, thicknessM: topM - bottomM, heightSource, minHeightSource, implausible };
}

/** Whether a part carries a height or floor count that gives it a real interval. */
export function partHasUsefulVerticalData(props: Props): boolean {
  const profile = resolveVerticalProfile(props, SELECTION_FLOOR_HEIGHT_M, SELECTION_DEFAULT_HEIGHT_M);
  return profile.thicknessM > 0 && (profile.heightSource === 'height' || profile.heightSource === 'num_floors');
}

/**
 * Whether every recorded source of the height is a derived estimate (machine
 * learning or a LiDAR model) rather than a mapped value. The footprint's
 * provider, confidence or edit date says nothing about the height's origin.
 */
export function estimatedHeight(props: Props): boolean {
  const sources = Array.isArray(props.sources) ? props.sources : [];
  const heights = sources.filter(
    (s): s is Record<string, unknown> =>
      s !== null && typeof s === 'object' && !Array.isArray(s) && (s as Record<string, unknown>).property === '/properties/height',
  );
  return heights.length > 0 && heights.every((s) => s.dataset === 'Microsoft ML Buildings' || s.dataset === 'USGS Lidar');
}
