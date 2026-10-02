// The area that frames imported routes: the area's own shape around them
// with a margin, centred on them, optionally turned to whatever rotation
// frames them smallest. Every area shape is convex, so only the corners of
// the routes' hull need to fit.

import { MAX_SIDE_M, MIN_SIDE_M, shapeRing } from '../geo/area';
import { Projection } from '../geo/projection';
import { pointInPolygon } from '../geometry/polygon';
import type { AreaSpec } from '../settings';
import type { LonLat, Vec2 } from '../types';

const HEX_RATIO = Math.sqrt(3) / 2;
// Margin on every side, as a share of the routes' extent.
const MARGIN = 0.06;
// Turning the area has to frame the routes this much smaller to be worth it.
const TURN_GAIN = 1.1;

/** Andrew's monotone chain. */
function hull(points: Vec2[]): number[] {
  const order = points.map((_, i) => i).sort((a, b) => points[a][0] - points[b][0] || points[a][1] - points[b][1]);
  if (order.length < 3) return order;
  const cross = (o: number, a: number, b: number) =>
    (points[a][0] - points[o][0]) * (points[b][1] - points[o][1]) - (points[a][1] - points[o][1]) * (points[b][0] - points[o][0]);
  const half = (list: number[]) => {
    const out: number[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(order), ...half([...order].reverse())];
}

interface Framing {
  rotationDeg: number;
  center: LonLat;
  widthM: number;
  heightM: number;
}

function frameAt(corners: LonLat[], anchor: LonLat, base: Pick<AreaSpec, 'shape' | 'cornerRadius'>, rotationDeg: number, margin: number): Framing {
  let projection = new Projection(anchor, rotationDeg, 1);
  let local = corners.map(([lon, lat]) => projection.toModel(lon, lat));
  const xs = local.map((p) => p[0]);
  const ys = local.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const center = projection.localToGeo(cx, cy);
  projection = new Projection(center, rotationDeg, 1);
  local = corners.map(([lon, lat]) => projection.toModel(lon, lat));
  let w = Math.max(...local.map((p) => Math.abs(p[0]))) * 2;
  let h = Math.max(...local.map((p) => Math.abs(p[1]))) * 2;
  if (base.shape === 'circle') w = h = Math.max(...local.map((p) => Math.hypot(p[0], p[1]))) * 2;
  else if (base.shape === 'hexagon') {
    w = Math.max(w, h / HEX_RATIO);
    h = w * HEX_RATIO;
  }
  // Grown until the shape itself holds every corner: a hexagon's or a rounded
  // rectangle's corners are cut off its box.
  if (base.shape === 'hexagon' || base.shape === 'rounded') {
    const fits = (k: number) => {
      const ring = shapeRing(base.shape, w * k, h * k, base.cornerRadius * Math.min(w, h) * k, Math.max(w, h) / 2000);
      return local.every(([x, y]) => pointInPolygon(x, y, [ring]));
    };
    let low = 1;
    let high = 1;
    while (!fits(high) && high < 4) high *= 1.25;
    for (let i = 0; i < 20 && high - low > 1e-3; i++) {
      const mid = (low + high) / 2;
      if (fits(mid)) high = mid;
      else low = mid;
    }
    w *= high;
    h *= high;
  }
  const grow = 1 + 2 * margin;
  return { rotationDeg, center, widthM: w * grow, heightM: h * grow };
}

/**
 * An area of the same shape around the routes. With `turn`, it's also turned
 * when that frames them at least 10% smaller. Null without any points.
 */
export function areaAroundTracks(lines: readonly LonLat[][], base: AreaSpec, turn = false, margin = MARGIN): AreaSpec | null {
  const points: LonLat[] = [];
  for (const line of lines) for (const p of line) points.push(p);
  if (!points.length) return null;
  const anchor: LonLat = [points.reduce((s, p) => s + p[0], 0) / points.length, points.reduce((s, p) => s + p[1], 0) / points.length];
  const enu = new Projection(anchor, 0, 1);
  const corners = hull(points.map(([lon, lat]) => enu.toModel(lon, lat))).map((i) => points[i]);
  const area = (f: Framing) => Math.max(f.widthM, MIN_SIDE_M) * Math.max(f.heightM, MIN_SIDE_M);
  let best = frameAt(corners, anchor, base, base.rotationDeg, margin);
  if (turn && base.shape !== 'circle') {
    const current = best;
    for (let r = -90; r < 90; r++) {
      const framed = frameAt(corners, anchor, base, r, margin);
      if (area(framed) < area(best)) best = framed;
    }
    if (area(best) * TURN_GAIN > area(current)) best = current;
  }
  // Too big for an area, the box is the largest one, still centred.
  const fit = Math.min(1, MAX_SIDE_M / Math.max(best.widthM, best.heightM));
  return {
    ...base,
    center: best.center,
    rotationDeg: best.rotationDeg,
    widthM: Math.max(MIN_SIDE_M, best.widthM * fit),
    heightM: Math.max(MIN_SIDE_M, best.heightM * fit),
  };
}

/** Share of the routes' points outside an area, 0 to 1. Long routes are sampled. */
export function shareOutside(lines: readonly LonLat[][], area: AreaSpec): number {
  const projection = new Projection(area.center, area.rotationDeg, 1);
  const ring = shapeRing(area.shape, area.widthM, area.heightM, area.cornerRadius * Math.min(area.widthM, area.heightM), Math.max(area.widthM, area.heightM) / 2000);
  let total = 0;
  let out = 0;
  for (const line of lines) {
    const step = Math.max(1, Math.floor(line.length / 500));
    for (let i = 0; i < line.length; i += step) {
      total++;
      const [x, y] = projection.toModel(line[i][0], line[i][1]);
      if (!pointInPolygon(x, y, [ring])) out++;
    }
  }
  return total ? out / total : 0;
}
