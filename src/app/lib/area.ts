// Area helpers the UI needs on top of core/geo/area.ts: keeping the box tight
// around circles and hexagons, clamping, and snapping rotation.

import { MAX_LATITUDE, MAX_SIDE_M, MIN_SIDE_M } from '../../core/geo/area';
import type { AreaShape, AreaSpec } from '../../core/settings';

export const HEX_RATIO = Math.sqrt(3) / 2;
export const LATITUDE_LIMIT = MAX_LATITUDE - 0.5;
export const SHAPES: AreaShape[] = ['rectangle', 'rounded', 'circle', 'hexagon'];

export const SHAPE_LABELS: Record<AreaShape, string> = {
  rectangle: 'Rectangle',
  rounded: 'Rounded',
  circle: 'Circle',
  hexagon: 'Hexagon',
};

const clampSide = (value: number) => Math.min(MAX_SIDE_M, Math.max(MIN_SIDE_M, Math.round(value)));

/** Rotation in (-180, 180]. */
export function normalizeRotation(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  let value = ((degrees % 360) + 360) % 360;
  if (value > 180) value -= 360;
  return Math.round(value * 10) / 10 || 0;
}

export function wrapLongitude(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Width and height for a shape from a requested box. Circles are as wide as
 * they are tall and hexagons are width x width·√3/2, the box of the largest
 * shape that fits. `keep` says which side the caller set explicitly.
 */
export function constrainSize(
  shape: AreaShape,
  width: number,
  height: number,
  keep: 'width' | 'height' | 'larger' | 'smaller' = 'smaller',
): [number, number] {
  if (shape === 'circle') {
    const side =
      keep === 'width' ? width : keep === 'height' ? height : keep === 'larger' ? Math.max(width, height) : Math.min(width, height);
    const d = clampSide(side);
    return [d, d];
  }
  if (shape === 'hexagon') {
    let w: number;
    if (keep === 'width') w = width;
    else if (keep === 'height') w = height / HEX_RATIO;
    else if (keep === 'larger') w = Math.max(width, height / HEX_RATIO);
    else w = Math.min(width, height / HEX_RATIO);
    w = Math.min(MAX_SIDE_M, Math.max(Math.ceil(MIN_SIDE_M / HEX_RATIO), Math.round(w)));
    return [w, Math.round(w * HEX_RATIO)];
  }
  return [clampSide(width), clampSide(height)];
}

/** A valid, tidy copy: sizes in range and tight around the shape, rotation normalised. */
export function normalizeArea(area: AreaSpec): AreaSpec {
  let lon = Number.isFinite(area.center[0]) ? wrapLongitude(area.center[0]) : 0;
  let lat = Number.isFinite(area.center[1]) ? area.center[1] : 0;
  lat = Math.max(-LATITUDE_LIMIT, Math.min(LATITUDE_LIMIT, lat));
  lon = Math.round(lon * 1e7) / 1e7;
  lat = Math.round(lat * 1e7) / 1e7;
  const shape = SHAPES.includes(area.shape) ? area.shape : 'rectangle';
  let width = Number.isFinite(area.widthM) ? area.widthM : 2000;
  let height = Number.isFinite(area.heightM) ? area.heightM : 2000;
  // Only tighten when the box does not already match the shape, so repeated
  // normalising never walks the size down through rounding.
  if (shape === 'circle' && Math.abs(width - height) > 0.5) {
    [width, height] = constrainSize(shape, width, height, 'smaller');
  } else if (shape === 'hexagon' && Math.abs(height - width * HEX_RATIO) > 1) {
    [width, height] = constrainSize(shape, width, height, 'smaller');
  } else if (shape === 'hexagon') {
    width = Math.min(MAX_SIDE_M, Math.max(Math.ceil(MIN_SIDE_M / HEX_RATIO), Math.round(width)));
    height = Math.round(Math.max(MIN_SIDE_M, height));
  } else {
    width = clampSide(width);
    height = clampSide(height);
  }
  const cornerRadius = Number.isFinite(area.cornerRadius) ? Math.min(0.5, Math.max(0, area.cornerRadius)) : 0.1;
  return { center: [lon, lat], widthM: width, heightM: height, rotationDeg: normalizeRotation(area.rotationDeg), shape, cornerRadius };
}

/** Snap to 0/90/180/270 within 3°, or to 15° steps when `coarse`. */
export function snapRotation(degrees: number, coarse: boolean): number {
  const value = normalizeRotation(degrees);
  if (coarse) return normalizeRotation(Math.round(value / 15) * 15);
  const quarter = Math.round(value / 90) * 90;
  if (Math.abs(value - quarter) <= 3) return normalizeRotation(quarter);
  return value;
}

export function sameArea(a: AreaSpec, b: AreaSpec): boolean {
  return (
    a.center[0] === b.center[0] &&
    a.center[1] === b.center[1] &&
    a.widthM === b.widthM &&
    a.heightM === b.heightM &&
    a.rotationDeg === b.rotationDeg &&
    a.shape === b.shape &&
    a.cornerRadius === b.cornerRadius
  );
}
