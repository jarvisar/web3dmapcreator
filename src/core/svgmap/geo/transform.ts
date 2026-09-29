// World units to canvas millimetres, both y down. The map centre goes to the
// window centre, then rotate by the bearing and scale. The scale is taken at the
// centre latitude, the same way the on-screen map draws it, so the export
// matches what was framed.
import type { Point } from '../lines/geometry';
import { lonLatToWorld, metresPerUnit } from './mercator';

export interface AreaSpec {
  lon: number;
  lat: number;
  // Degrees clockwise from north that point up, same as MapLibre's bearing.
  bearing: number;
  // Ground width of the map window in metres.
  widthM: number;
}

export interface MapTransform {
  zoom: number;
  cx: number;
  cy: number;
  wx: number;
  wy: number;
  cos: number;
  sin: number;
  mmPerUnit: number;
  // The map scale is 1 : metresPerMm * 1000.
  metresPerMm: number;
  toCanvas(x: number, y: number): Point;
  toWorld(x: number, y: number): Point;
}

export function makeTransform(
  area: AreaSpec,
  zoom: number,
  windowCentre: Point,
  windowWidthMm: number,
): MapTransform {
  const [cx, cy] = lonLatToWorld(area.lon, area.lat, zoom);
  const metresPerMm = area.widthM / windowWidthMm;
  const mmPerUnit = metresPerUnit(area.lat, zoom) / metresPerMm;
  const theta = (area.bearing * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const [wx, wy] = windowCentre;
  return {
    zoom,
    cx,
    cy,
    wx,
    wy,
    cos,
    sin,
    mmPerUnit,
    metresPerMm,
    toCanvas(x, y) {
      const dx = x - cx;
      const dy = y - cy;
      return [wx + mmPerUnit * (dx * cos + dy * sin), wy + mmPerUnit * (dy * cos - dx * sin)];
    },
    toWorld(x, y) {
      const u = (x - wx) / mmPerUnit;
      const v = (y - wy) / mmPerUnit;
      return [cx + u * cos - v * sin, cy + u * sin + v * cos];
    },
  };
}
