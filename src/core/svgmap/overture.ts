// Building footprints Overture has and the OSM tiles don't: Microsoft's and
// Google's ML footprints, Esri's community buildings and a few national
// datasets. Overture only keeps one of those where no OSM building overlaps
// it, so the rest of Overture's buildings are already in the tiles and aren't
// read. The tiles come from a newer OSM than Overture's, so an added building
// that mostly overlaps a tile building (mapped since) is dropped too.
import type { Paths64 } from 'clipper2-ts';
import type { MultiPolygon, OvertureFeature, Polygon } from '../data/features';
import { clipToRect, pathBounds } from '../geometry/clipRect';
import type { GeoBounds } from '../types';
import { SCALE, areaMm2, intersectWith, unionAll } from './fills';
import { lonLatToWorld, worldToLonLat } from './geo/mercator';
import type { MapTransform } from './geo/transform';
import type { Layout } from './layout/layout';
import { shapePolygon } from './layout/shapes';
import type { PreparedPolygon } from './prepare';

export const OSM_DATASET = 'OpenStreetMap';

// Columns read on top of id, geometry and bbox. Sources are pruned to these
// two fields (overture.ts), and record_id would be most of their bytes.
export const BUILDING_COLUMNS = ['sources', 'is_underground'] as const;

// Share of an added building's area that can overlap tile buildings before
// it's taken for one mapped in OSM since Overture's release.
const MAX_OVERLAP = 0.25;

/** The dataset the feature's geometry came from: the source without a property, else the first. */
export function geometryDataset(sources: unknown): string | undefined {
  if (!Array.isArray(sources) || sources.length === 0) return undefined;
  const whole = sources.find((s) => s && typeof s === 'object' && !(s as { property?: unknown }).property);
  const dataset = ((whole ?? sources[0]) as { dataset?: unknown } | null)?.dataset;
  return typeof dataset === 'string' ? dataset : undefined;
}

/** Rows worth reading: above ground and not from OSM. A row without sources is kept, since it can't be in the tiles. */
export function isMissingFromOsm(props: Record<string, unknown>): boolean {
  if (props.is_underground === true) return false;
  return geometryDataset(props.sources) !== OSM_DATASET;
}

/**
 * The lon/lat box around the map window, or null when it crosses the
 * antimeridian, which the Overture reader doesn't take.
 */
export function windowBounds(transform: MapTransform, layout: Layout): GeoBounds | null {
  const corners = shapePolygon({ ...layout.window, kind: 'rect', r: 0 }).map(([x, y]) => {
    const [wx, wy] = transform.toWorld(x, y);
    return worldToLonLat(wx, wy, transform.zoom);
  });
  const west = Math.min(...corners.map((c) => c.lon));
  const east = Math.max(...corners.map((c) => c.lon));
  const south = Math.min(...corners.map((c) => c.lat));
  const north = Math.max(...corners.map((c) => c.lat));
  if (west < -180 || east > 180 || !(west < east) || !(south < north)) return null;
  return { west, south, east, north };
}

type Rect = { left: number; top: number; right: number; bottom: number };

function polygonsOf(feature: OvertureFeature): number[][][][] {
  const g = feature.geometry as Polygon | MultiPolygon;
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

/** Footprints in canvas units (microns), cut to `rect` like the tiles' polygons. */
export function projectFootprints(features: readonly OvertureFeature[], transform: MapTransform, rect: Rect): Paths64[] {
  const out: Paths64[] = [];
  for (const feature of features) {
    const rings: Paths64 = [];
    for (const polygon of polygonsOf(feature)) {
      for (const ring of polygon) {
        if (ring.length < 4) continue;
        rings.push(
          ring.map(([lon, lat]) => {
            const [wx, wy] = lonLatToWorld(lon, lat, transform.zoom);
            const [x, y] = transform.toCanvas(wx, wy);
            return { x: Math.round(x * SCALE), y: Math.round(y * SCALE) };
          }),
        );
      }
    }
    if (!rings.length) continue;
    const clipped = clipToRect(rect, rings);
    if (clipped.length) out.push(clipped);
  }
  return out;
}

type Box = [number, number, number, number];

// Rings by the grid cells their boxes touch. A tile feature can hold many
// buildings, so rings are indexed on their own. A hole's outer ring always
// meets any box the hole meets, so a union of the rings found keeps courtyards
// open (NonZero, with holes wound the other way).
class RingGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly boxes: Box[] = [];
  private readonly cell: number;
  private readonly columns: number;
  private readonly x0: number;
  private readonly y0: number;

  constructor(readonly rings: Paths64) {
    this.boxes = rings.map(pathBounds);
    const all = boundsOf(rings);
    this.x0 = Number.isFinite(all[0]) ? all[0] : 0;
    this.y0 = Number.isFinite(all[1]) ? all[1] : 0;
    // About 200 cells across the larger side.
    const span = Number.isFinite(all[0]) ? Math.max(all[2] - all[0], all[3] - all[1]) : 0;
    this.cell = Math.max(100, Math.ceil(span / 200));
    this.columns = Math.floor(span / this.cell) + 2;
    this.boxes.forEach((box, i) => {
      for (const key of this.keys(box)) {
        const list = this.cells.get(key);
        if (list) list.push(i);
        else this.cells.set(key, [i]);
      }
    });
  }

  private *keys([x0, y0, x1, y1]: Box) {
    const clamp = (v: number) => Math.min(this.columns - 1, Math.max(0, v));
    const cx0 = clamp(Math.floor((x0 - this.x0) / this.cell));
    const cx1 = clamp(Math.floor((x1 - this.x0) / this.cell));
    const cy0 = clamp(Math.floor((y0 - this.y0) / this.cell));
    const cy1 = clamp(Math.floor((y1 - this.y0) / this.cell));
    for (let x = cx0; x <= cx1; x++) {
      for (let y = cy0; y <= cy1; y++) yield y * this.columns + x;
    }
  }

  near(box: Box): Paths64 {
    const found = new Set<number>();
    for (const key of this.keys(box)) {
      for (const i of this.cells.get(key) ?? []) {
        const b = this.boxes[i];
        if (b[0] <= box[2] && b[2] >= box[0] && b[1] <= box[3] && b[3] >= box[1]) found.add(i);
      }
    }
    return [...found].map((i) => this.rings[i]);
  }
}

function boundsOf(rings: Paths64): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const ring of rings) {
    const [a, b, c, d] = pathBounds(ring);
    x0 = Math.min(x0, a);
    y0 = Math.min(y0, b);
    x1 = Math.max(x1, c);
    y1 = Math.max(y1, d);
  }
  return [x0, y0, x1, y1];
}

/**
 * A test for footprints that aren't already tile buildings: false for one
 * that overlaps them by more than MAX_OVERLAP of its area.
 */
export function notInTiles(tileBuildings: readonly PreparedPolygon[]): (footprint: Paths64) => boolean {
  const grid = new RingGrid(tileBuildings.flatMap((p) => p.rings));
  return (footprint) => {
    const merged = unionAll(footprint);
    const area = Math.abs(areaMm2(merged));
    if (!(area > 0)) return false;
    const near = grid.near(boundsOf(footprint));
    if (!near.length) return true;
    const overlap = Math.abs(areaMm2(intersectWith(merged, unionAll(near))));
    return overlap <= MAX_OVERLAP * area;
  };
}

/** Footprints as building polygons, less those already in the tiles. They're unioned with the tile buildings at render time. */
export function missingBuildings(footprints: readonly Paths64[], tileBuildings: readonly PreparedPolygon[]): PreparedPolygon[] {
  const missing = notInTiles(tileBuildings);
  return footprints.filter(missing).map((rings) => ({ layer: 'buildings', cls: 'building', flags: 0, rings }));
}
