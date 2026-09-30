// Roads picked out in the preview: put in a route of their own colour, or
// left out. OpenFreeMap tiles merge ways with the same tags and carry no
// names on the road lines, so a pick is kept as the line's geometry in
// lon/lat, and each render gives it back the prepared lines lying along it.
// That happens before the line cleanup, so a route's pieces only weld with
// each other and the cleanup never thins them out.

import { lonLatToWorld, worldToLonLat } from './geo/mercator';
import type { MapTransform } from './geo/transform';
import type { Path, Point } from './lines/geometry';
import type { PreparedLine } from './prepare';
import type { LineLayerId } from './settings';

export type LonLatLine = [number, number][];

/** A colour of the user's own for roads they pick. */
export interface SvgRoute {
  id: string;
  name: string;
  /** #RRGGBB, the same in every mode. */
  color: string;
  /** Stroke width in print mode, mm. Laser and plotter use their hairline or pen. */
  width: number;
  lines: LonLatLine[];
}

export const MAX_ROUTES = 12;
export const MAX_PICKED_LINES = 4000;
/** Points of all picked lines together, which keeps saved settings and option files a sensible size. */
export const MAX_PICKED_POINTS = 50_000;
const MAX_POINTS = 2000;

// A prepared line belongs to a pick when most of it lies this close to it.
const SHARE = 0.7;
const TOLERANCE_M = 4;
const TOLERANCE_MIN_MM = 0.25;
const CELL_MM = 2;

/** Line layers a road can be picked from. */
export const PICK_LAYERS: LineLayerId[] = ['roads', 'paths', 'railways', 'raceways'];

interface Segment {
  owner: number;
  /** The pick it's part of. */
  pick: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

function segmentDistance(px: number, py: number, s: Segment): number {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const length2 = dx * dx + dy * dy;
  let t = length2 > 0 ? ((px - s.ax) * dx + (py - s.ay) * dy) / length2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (s.ax + dx * t), py - (s.ay + dy * t));
}

function toCanvas(line: LonLatLine, transform: MapTransform): Path {
  return line.map(([lon, lat]) => transform.toCanvas(...lonLatToWorld(lon, lat, transform.zoom)));
}

/** Canvas mm back to lon/lat, rounded to about a decimetre. */
export function toLonLat(path: Path, transform: Pick<MapTransform, 'zoom' | 'toWorld'>): LonLatLine {
  return path.map(([x, y]) => {
    const { lon, lat } = worldToLonLat(...transform.toWorld(x, y), transform.zoom);
    return [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
  });
}

/**
 * The prepared lines lying along picked geometry: the route's index for each,
 * or -1 for a line left out. Picks nothing matched go in `missing`: off the
 * map, on a layer that's off, or drawn too differently at this scale.
 */
export function pickedLines(
  lines: PreparedLine[],
  routes: SvgRoute[],
  hidden: LonLatLine[],
  transform: MapTransform,
  missing: LonLatLine[] = [],
): Map<PreparedLine, number> {
  const out = new Map<PreparedLine, number>();
  if (!routes.some((r) => r.lines.length) && !hidden.length) return out;
  const tolerance = Math.max(TOLERANCE_MIN_MM, TOLERANCE_M / transform.metresPerMm);
  const grid = new Map<number, Segment[]>();
  const picks: LonLatLine[] = [];
  const add = (line: LonLatLine, owner: number) => {
    const path = toCanvas(line, transform);
    const pick = picks.push(line) - 1;
    for (let i = 1; i < path.length; i++) {
      const s: Segment = { owner, pick, ax: path[i - 1][0], ay: path[i - 1][1], bx: path[i][0], by: path[i][1] };
      const x0 = Math.floor((Math.min(s.ax, s.bx) - tolerance) / CELL_MM);
      const x1 = Math.floor((Math.max(s.ax, s.bx) + tolerance) / CELL_MM);
      const y0 = Math.floor((Math.min(s.ay, s.by) - tolerance) / CELL_MM);
      const y1 = Math.floor((Math.max(s.ay, s.by) + tolerance) / CELL_MM);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const key = cellKey(x, y);
          const cell = grid.get(key);
          if (cell) cell.push(s);
          else grid.set(key, [s]);
        }
      }
    }
  };
  routes.forEach((route, i) => route.lines.forEach((line) => add(line, i)));
  for (const line of hidden) add(line, -1);

  const votes = new Map<number, number>();
  const found = new Uint8Array(picks.length);
  const nearest: Segment[] = [];
  for (const line of lines) {
    if (!PICK_LAYERS.includes(line.layer)) continue;
    const samples = sample(line.path, 1);
    if (!samples.length) continue;
    votes.clear();
    nearest.length = 0;
    for (const [x, y] of samples) {
      const cell = grid.get(cellKey(Math.floor(x / CELL_MM), Math.floor(y / CELL_MM)));
      if (!cell) continue;
      let best: Segment | null = null;
      let bestDistance = tolerance;
      for (const s of cell) {
        const d = segmentDistance(x, y, s);
        if (d <= bestDistance) {
          bestDistance = d;
          best = s;
        }
      }
      if (!best) continue;
      votes.set(best.owner, (votes.get(best.owner) ?? 0) + 1);
      nearest.push(best);
    }
    let owner = -2;
    let most = 0;
    for (const [candidate, count] of votes) {
      if (count > most) {
        most = count;
        owner = candidate;
      }
    }
    if (owner !== -2 && most >= SHARE * samples.length) {
      out.set(line, owner);
      for (const s of nearest) if (s.owner === owner) found[s.pick] = 1;
    }
  }
  picks.forEach((pick, i) => found[i] || missing.push(pick));
  return out;
}

/** The path's points, and more along any segment longer than `spacing`. */
function sample(path: Path, spacing: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < path.length; i++) {
    if (i > 0) {
      const [ax, ay] = path[i - 1];
      const [bx, by] = path[i];
      const steps = Math.min(200, Math.floor(Math.hypot(bx - ax, by - ay) / spacing));
      for (let k = 1; k < steps; k++) out.push([ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps]);
    }
    out.push(path[i]);
  }
  return out;
}

function cellKey(x: number, y: number): number {
  return (x + 2 ** 20) * 2 ** 21 + (y + 2 ** 20);
}

/** Lines a preview can pick, before any cleanup, and how to take them back to lon/lat. */
export interface PickLines {
  /** Index into PICK_LAYERS, per line. */
  layers: Uint8Array;
  /** The route each line is drawn in, -1 left out, -2 neither. */
  owners: Int8Array;
  classes: string[];
  /** Where each line's points start, with the total at the end. */
  starts: Uint32Array;
  /** x, y in canvas mm. */
  points: Float32Array;
  transform: { zoom: number; cx: number; cy: number; wx: number; wy: number; cos: number; sin: number; mmPerUnit: number };
}

export function pickLines(lines: PreparedLine[], transform: MapTransform, owners: Map<PreparedLine, number> = new Map()): PickLines {
  const picked = lines.filter((l) => PICK_LAYERS.includes(l.layer) && l.path.length >= 2);
  const starts = new Uint32Array(picked.length + 1);
  let total = 0;
  picked.forEach((line, i) => {
    starts[i] = total;
    total += line.path.length;
  });
  starts[picked.length] = total;
  const points = new Float32Array(total * 2);
  picked.forEach((line, i) => {
    let at = starts[i] * 2;
    for (const [x, y] of line.path) {
      points[at++] = x;
      points[at++] = y;
    }
  });
  const { zoom, cx, cy, wx, wy, cos, sin, mmPerUnit } = transform;
  return {
    layers: Uint8Array.from(picked, (l) => PICK_LAYERS.indexOf(l.layer)),
    owners: Int8Array.from(picked, (l) => owners.get(l) ?? -2),
    classes: picked.map((l) => l.cls),
    starts,
    points,
    transform: { zoom, cx, cy, wx, wy, cos, sin, mmPerUnit },
  };
}

/**
 * Whether two picked lines are the same road: most of one lies within a few
 * metres of the other, either way round. The same road picked at another
 * zoom has other vertices.
 */
export function sameLine(a: LonLatLine, b: LonLatLine): boolean {
  if (!a.length || !b.length) return false;
  const [lon0, lat0] = a[0];
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110_574;
  const local = (line: LonLatLine): Path => line.map(([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky]);
  const covers = (x: Path, y: Path) => {
    const samples = sample(x, 2);
    let near = 0;
    for (const [px, py] of samples) {
      for (let i = 1; i < y.length; i++) {
        const s: Segment = { owner: 0, pick: 0, ax: y[i - 1][0], ay: y[i - 1][1], bx: y[i][0], by: y[i][1] };
        if (segmentDistance(px, py, s) <= TOLERANCE_M) {
          near++;
          break;
        }
      }
    }
    return near >= SHARE * samples.length;
  };
  const pa = local(a);
  const pb = local(b);
  return covers(pa, pb) || covers(pb, pa);
}

/** The pick's canvas to world, as makeTransform's toWorld. */
export function pickToWorld(t: PickLines['transform'], x: number, y: number): Point {
  const u = (x - t.wx) / t.mmPerUnit;
  const v = (y - t.wy) / t.mmPerUnit;
  return [t.cx + u * t.cos - v * t.sin, t.cy + u * t.sin + v * t.cos];
}

const HEX = /^#[0-9a-f]{6}$/i;

function lonLatLine(value: unknown): LonLatLine | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const out: LonLatLine = [];
  for (const p of value.slice(0, MAX_POINTS)) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const [lon, lat] = p;
    if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
    out.push([lon, lat]);
  }
  return out;
}

export function sanitizeLines(value: unknown, budget = { points: MAX_PICKED_POINTS }): LonLatLine[] {
  if (!Array.isArray(value)) return [];
  const out: LonLatLine[] = [];
  for (const item of value) {
    if (out.length >= MAX_PICKED_LINES) break;
    const line = lonLatLine(item);
    if (!line) continue;
    if (line.length > budget.points) break;
    budget.points -= line.length;
    out.push(line);
  }
  return out;
}

export function pickedPoints(routes: readonly SvgRoute[], hidden: readonly LonLatLine[]): number {
  let total = 0;
  for (const route of routes) for (const line of route.lines) total += line.length;
  for (const line of hidden) total += line.length;
  return total;
}

/** Routes with anything unknown or out of range dropped or clamped. */
export function sanitizeRoutes(value: unknown): SvgRoute[] {
  if (!Array.isArray(value)) return [];
  const out: SvgRoute[] = [];
  const ids = new Set<string>();
  const budget = { points: MAX_PICKED_POINTS };
  for (const item of value) {
    if (out.length >= MAX_ROUTES) break;
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id || ids.has(r.id)) continue;
    if (typeof r.color !== 'string' || !HEX.test(r.color)) continue;
    ids.add(r.id);
    const width = typeof r.width === 'number' && Number.isFinite(r.width) ? Math.min(5, Math.max(0.02, r.width)) : 0.6;
    out.push({
      id: r.id.slice(0, 64),
      name: (typeof r.name === 'string' ? r.name.slice(0, 60).trim() : '') || 'Route',
      color: r.color.toUpperCase(),
      width,
      lines: sanitizeLines(r.lines, budget),
    });
  }
  return out;
}

/** An SVG group id for a route: safe to write as it is and unique. */
export function routeGroupId(index: number): string {
  return `route-${index + 1}`;
}
