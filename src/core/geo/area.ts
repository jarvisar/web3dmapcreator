// The selected area: its outline in model space and on the map, the data
// bounds it needs, and its printed size.

import type { AreaSpec, ModelSettings } from '../settings';
import type { GeoBounds, LonLat, Ring } from '../types';
import { Projection } from './projection';

// The elevation tiles are Web Mercator and end here.
export const MAX_LATITUDE = 85.05112878;
export const MIN_SIDE_M = 50;
export const MAX_SIDE_M = 60000;
const CHORD_TOLERANCE_MM = 0.1;

export function circleSegments(radius: number, tolerance = CHORD_TOLERANCE_MM): number {
  if (radius <= tolerance) return 32;
  let count = Math.ceil(Math.PI / Math.acos(1 - tolerance / radius));
  count = Math.min(192, Math.max(32, count));
  return count + ((4 - (count % 4)) % 4);
}

/**
 * Counter-clockwise outline centred on the origin that fits inside width x
 * height. Circles and hexagons are regular and as large as fits, and the hexagon
 * has flat north and south sides. `tolerance` is the largest gap between a
 * curve and its chords, in the same units as width and height.
 */
export function shapeRing(
  shape: AreaSpec['shape'],
  width: number,
  height: number,
  cornerRadius = 0,
  tolerance = CHORD_TOLERANCE_MM,
): Ring {
  const w = width / 2;
  const h = height / 2;
  if (shape === 'rectangle' || (shape === 'rounded' && cornerRadius <= 0)) {
    return [[-w, -h], [w, -h], [w, h], [-w, h]];
  }
  if (shape === 'rounded') {
    const r = Math.min(cornerRadius, w, h);
    const segments = Math.max(2, circleSegments(r, tolerance) / 4);
    const ring: Ring = [];
    const corners: [number, number, number][] = [
      [w - r, -h + r, -Math.PI / 2],
      [w - r, h - r, 0],
      [-w + r, h - r, Math.PI / 2],
      [-w + r, -h + r, Math.PI],
    ];
    const eps = 1e-9 * Math.max(w, h);
    for (const [cx, cy, start] of corners) {
      for (let i = 0; i <= segments; i++) {
        const a = start + ((Math.PI / 2) * i) / segments;
        const p: [number, number] = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
        const last = ring[ring.length - 1];
        if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > eps) ring.push(p);
      }
    }
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) <= eps) ring.pop();
    return ring;
  }
  if (shape === 'circle') {
    const radius = Math.min(w, h);
    const segments = circleSegments(radius, tolerance);
    const ring: Ring = [];
    for (let i = 0; i < segments; i++) {
      const a = (2 * Math.PI * i) / segments;
      ring.push([radius * Math.cos(a), radius * Math.sin(a)]);
    }
    return ring;
  }
  // Hexagon with flat north and south sides.
  const radius = Math.min(w, height / Math.sqrt(3));
  const ring: Ring = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    ring.push([radius * Math.cos(a), radius * Math.sin(a)]);
  }
  return ring;
}

/** Horizontal scale for an area, in printed mm per real metre. */
export function effectiveScale(area: AreaSpec, scale: ModelSettings['scale']): number {
  if (scale.mode === 'fit') {
    const longest = Math.max(area.widthM, area.heightM);
    return scale.fitMm / Math.max(longest, 1);
  }
  return scale.mmPerMetre;
}

/** Printed width and depth of the area's bounding box. */
export function modelSizeMm(area: AreaSpec, scale: ModelSettings['scale']): { width: number; depth: number } {
  const s = effectiveScale(area, scale);
  return { width: area.widthM * s, depth: area.heightM * s };
}

/** Outline of the area in model millimetres, centred on the origin. */
export function areaModelRing(area: AreaSpec, mmPerMetre: number): Ring {
  const width = area.widthM * mmPerMetre;
  const height = area.heightM * mmPerMetre;
  const radius = area.cornerRadius * Math.min(width, height);
  return shapeRing(area.shape, width, height, radius);
}

/** Outline of the area on the map, closed (first point repeated). */
export function areaGeoRing(area: AreaSpec): LonLat[] {
  const projection = new Projection(area.center, area.rotationDeg, 1);
  const radius = area.cornerRadius * Math.min(area.widthM, area.heightM);
  // Metre units here, so allow a proportionate chord error.
  const ring = shapeRing(area.shape, area.widthM, area.heightM, radius, Math.max(area.widthM, area.heightM) / 2000);
  const out = ring.map(([x, y]) => projection.localToGeo(x, y));
  out.push(out[0]);
  return out;
}

/**
 * Geographic bounds that cover the area plus a margin in metres. Features
 * crossing the edge are fetched whole and clipped during generation.
 */
export function areaGeoBounds(area: AreaSpec, marginM = 0): GeoBounds {
  const projection = new Projection(area.center, area.rotationDeg, 1);
  const w = area.widthM / 2 + marginM;
  const h = area.heightM / 2 + marginM;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  // Sample the edges: the ENU box is slightly curved in degrees.
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    const t = -1 + (2 * i) / steps;
    for (const [x, y] of [[t * w, -h], [t * w, h], [-w, t * h], [w, t * h]] as const) {
      const [lon, lat] = projection.localToGeo(x, y);
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  }
  return { west, south, east, north };
}

export function areaKm2(area: AreaSpec): number {
  return (area.widthM * area.heightM) / 1e6;
}

/** Why an area cannot be generated, or null when it can. */
export function validateArea(area: AreaSpec): string | null {
  const [lon, lat] = area.center;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return 'The area centre is not a valid coordinate.';
  if (Math.abs(lat) > MAX_LATITUDE - 0.5) return 'Areas this close to the poles are not supported.';
  if (!(area.widthM >= MIN_SIDE_M && area.heightM >= MIN_SIDE_M)) return `Each side must be at least ${MIN_SIDE_M} m.`;
  if (area.widthM > MAX_SIDE_M || area.heightM > MAX_SIDE_M) return `Each side is limited to ${MAX_SIDE_M / 1000} km.`;
  const bounds = areaGeoBounds(area);
  if (bounds.west < -180 || bounds.east > 180 || bounds.east - bounds.west > 180) {
    return 'Areas that cross the 180th meridian are not supported.';
  }
  return null;
}

/** The area centred on a geographic box with the same real size, unrotated. */
export function areaFromBounds(bounds: GeoBounds, shape: AreaSpec['shape'] = 'rectangle'): AreaSpec {
  const center: LonLat = [(bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2];
  const projection = new Projection(center, 0, 1);
  const [x0] = projection.toLocal(bounds.west, center[1]);
  const [x1] = projection.toLocal(bounds.east, center[1]);
  const [, y0] = projection.toLocal(center[0], bounds.south);
  const [, y1] = projection.toLocal(center[0], bounds.north);
  return {
    center,
    widthM: Math.round(Math.abs(x1 - x0)),
    heightM: Math.round(Math.abs(y1 - y0)),
    rotationDeg: 0,
    shape,
    cornerRadius: 0.1,
  };
}

// Minus signs web pages and word processors use in place of "-".
const MINUS = /[−–﹣－]/g;

/**
 * Read "west,south,east,north" decimal degrees. Separators are loose, the
 * order is never guessed: a lat/lon swap of a real box is often another
 * valid box somewhere else.
 */
export function parseBoundsText(text: string): GeoBounds {
  let cleaned = text.replace(MINUS, '-').trim();
  if (cleaned.includes('=')) cleaned = cleaned.slice(cleaned.lastIndexOf('=') + 1);
  cleaned = cleaned.replace(/^[\s()[\]{}<>"']+|[\s()[\]{}<>"']+$/g, '');
  const tokens = cleaned.split(/[,;\s]+/).filter(Boolean);
  if (tokens.length !== 4) {
    const hint = tokens.length === 8 ? '; use a point for decimals' : '';
    throw new Error(`Expected 4 numbers as west,south,east,north; found ${tokens.length}${hint}`);
  }
  const names = ['west', 'south', 'east', 'north'] as const;
  const values = tokens.map((token, i) => {
    const value = Number(token);
    if (!Number.isFinite(value)) throw new Error(`${names[i]} is not a number: ${token}`);
    return value;
  });
  const [west, south, east, north] = values;
  if (Math.abs(west) > 180 || Math.abs(east) > 180) throw new Error('Longitudes must be between -180 and 180');
  if (Math.abs(south) > 90 || Math.abs(north) > 90) throw new Error('Latitudes must be between -90 and 90');
  if (east <= west) throw new Error('East must be greater than west (areas crossing the 180th meridian are not supported)');
  if (north <= south) throw new Error('North must be greater than south');
  return { west, south, east, north };
}

/** Parse "lat, lon" typed into the search box. */
export function parseLatLon(text: string): LonLat | null {
  const match = text
    .replace(MINUS, '-')
    .trim()
    .match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lon, lat];
}
