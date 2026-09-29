// Area helpers the UI needs on top of core/geo/area.ts: keeping the box tight
// around circles and hexagons, clamping, and snapping rotation.

import { areaFromBounds, MAX_LATITUDE, MAX_SIDE_M, MIN_SIDE_M } from '../../core/geo/area';
import type { AreaShape, AreaSpec } from '../../core/settings';
import type { GeoBounds, Ring, Vec2 } from '../../core/types';

export const HEX_RATIO = Math.sqrt(3) / 2;
export const LATITUDE_LIMIT = MAX_LATITUDE - 0.5;
export const SHAPES: AreaShape[] = ['rectangle', 'rounded', 'circle', 'hexagon'];

export const AREA_HINT = 'Drag the box to move it. Drag a corner to resize it, or the round handle to rotate it.';

/** With an SVG map's scale locked the corners can't resize the area. */
export function areaHint(locked: boolean): string {
  return locked ? 'Drag the box to move it, or the round handle to rotate it. Unlock the scale to resize it.' : AREA_HINT;
}

export const SHAPE_LABELS: Record<AreaShape, string> = {
  rectangle: 'Rectangle',
  rounded: 'Rounded',
  circle: 'Circle',
  hexagon: 'Hexagon',
};

// Centimetres, not metres: an SVG map's width sets its 1:n scale, and a whole
// metre off moves a small piece's 1:5,000 to 1:4,996.
const roundSide = (value: number) => Math.round(value * 100) / 100;
const clampSide = (value: number) => Math.min(MAX_SIDE_M, Math.max(MIN_SIDE_M, roundSide(value)));
const MIN_HEX_WIDTH = Math.ceil(MIN_SIDE_M / HEX_RATIO);

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
    w = Math.min(MAX_SIDE_M, Math.max(MIN_HEX_WIDTH, roundSide(w)));
    return [w, roundSide(w * HEX_RATIO)];
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
    width = Math.min(MAX_SIDE_M, Math.max(MIN_HEX_WIDTH, roundSide(width)));
    height = roundSide(Math.max(MIN_SIDE_M, height));
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

// The next two mirror what the export does with Clipper, for the plate count
// on screen. Area outlines are convex and counter-clockwise, which keeps them short.

/** The outline grown by the rim with mitred corners, like the rim in generate.ts. */
export function withRim(ring: Ring, width: number): Ring {
  if (!(width > 0)) return ring;
  const n = ring.length;
  const normal = (a: Vec2, b: Vec2): Vec2 => {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[1] - a[1]) / length, (a[0] - b[0]) / length];
  };
  return ring.map((p, i) => {
    const n1 = normal(ring[(i + n - 1) % n], p);
    const n2 = normal(p, ring[(i + 1) % n]);
    const k = width / (1 + n1[0] * n2[0] + n1[1] * n2[1]);
    return [p[0] + (n1[0] + n2[0]) * k, p[1] + (n1[1] + n2[1]) * k];
  });
}

/** Area of the outline inside a box: west, south, east, north. */
export function areaInBox(ring: Ring, [west, south, east, north]: [number, number, number, number]): number {
  const sides = [(p: Vec2) => p[0] - west, (p: Vec2) => east - p[0], (p: Vec2) => p[1] - south, (p: Vec2) => north - p[1]];
  let points: Vec2[] = ring;
  for (const side of sides) {
    const kept: Vec2[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const da = side(a);
      const db = side(b);
      if (da >= 0) kept.push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        kept.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    points = kept;
    if (!points.length) return 0;
  }
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return twice / 2;
}

/**
 * An area covering the bounds. Bounds are a box, so only a rounded area keeps
 * its shape, unless `keepShape`: an SVG map's piece keeps its shape and its
 * map window is fitted around the bounds instead.
 */
export function areaForBounds(bounds: GeoBounds, current: AreaSpec, keepShape = false): AreaSpec {
  const shape = keepShape || current.shape === 'rounded' ? current.shape : 'rectangle';
  return { ...areaFromBounds(bounds, shape), cornerRadius: current.cornerRadius };
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
