// Stage 1: download, decode, stitch, project and clip. This is the slow part and
// it doesn't depend on styling, cleanup, titles or filters, so the result is
// cached and reused while those change.
import type { Paths64 } from 'clipper2-ts';
import { clipToRect } from '../geometry/clipRect';
import { bboxOf, clipPolylineInside } from './geo/clip';
import { TILE_EXTENT } from './geo/mercator';
import { type AreaSpec, type MapTransform, makeTransform } from './geo/transform';
import { SCALE, bufferLines } from './fills';
import type { Layout } from './layout/layout';
import { shapeCentre, shapePolygon } from './layout/shapes';
import type { Path } from './lines/geometry';
import type { SourceSettings } from './settings';
import { decodeTile } from './tiles/decode';
import {
  type FillLayerId,
  type LineLayerId,
  aerowayLineWidth,
  classifyLine,
  classifyPolygon,
} from './tiles/schema';
import { stitchSeams } from './tiles/stitch';

export interface TileId {
  z: number;
  x: number;
  y: number;
}

export interface TilePlan {
  zoom: number;
  tiles: TileId[];
  transform: MapTransform;
  widthM: number;
  heightM: number;
  warnings: string[];
}

export class AreaTooLargeError extends Error {}

const MIN_ZOOM = 10;
// Same as the most the UI allows. Settings from a share link can't ask for more.
const TILE_LIMIT = 2000;

// Steps down a zoom level at a time for areas that would need more than maxTiles.
export function planTiles(area: AreaSpec, layout: Layout, source: SourceSettings): TilePlan {
  // Zero would put every point at infinity, which Clipper never finishes with.
  if (!(area.widthM > 0 && Number.isFinite(area.widthM))) throw new Error('The map width has to be more than zero.');
  const window = layout.window;
  const corners = shapePolygon({ ...window, kind: 'rect', r: 0 });
  const warnings: string[] = [];
  const maxTiles = Math.min(source.maxTiles, TILE_LIMIT);
  const top = Math.min(14, Math.max(MIN_ZOOM, Math.round(source.maxZoom)));
  for (let zoom = top; zoom >= MIN_ZOOM; zoom--) {
    const transform = makeTransform(area, zoom, shapeCentre(window), window.w);
    const world = corners.map(([x, y]) => transform.toWorld(x, y));
    const [minX, minY, maxX, maxY] = bboxOf(world);
    const x0 = Math.floor(minX / TILE_EXTENT);
    const x1 = Math.floor(maxX / TILE_EXTENT);
    const y0 = Math.max(0, Math.floor(minY / TILE_EXTENT));
    const y1 = Math.min(2 ** zoom - 1, Math.floor(maxY / TILE_EXTENT));
    const count = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (count > maxTiles) continue;
    const tiles: TileId[] = [];
    const n = 2 ** zoom;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) tiles.push({ z: zoom, x: ((x % n) + n) % n, y });
    }
    if (zoom < top) {
      warnings.push(
        `This area needs more than ${maxTiles} tiles at full detail, so it uses zoom ${zoom} data. Small features may be simplified or missing.`,
      );
    }
    const widthM = area.widthM;
    return { zoom, tiles, transform, widthM, heightM: (widthM * window.h) / window.w, warnings };
  }
  throw new AreaTooLargeError('This area is too large to map in one go. Zoom in or choose a smaller area.');
}

export interface PreparedLine {
  layer: LineLayerId;
  cls: string;
  rank: number;
  flags: number;
  path: Path;
}

export interface PreparedPolygon {
  layer: FillLayerId;
  cls: string;
  flags: number;
  rings: Paths64;
}

export interface Prepared {
  zoom: number;
  transform: MapTransform;
  widthM: number;
  heightM: number;
  lines: PreparedLine[];
  polygons: PreparedPolygon[];
  tiles: number;
  /** Tiles that could not be downloaded. */
  missing: number;
  bytes: number;
  warnings: string[];
}

export type TileData = Map<string, ArrayBuffer | null>;

export const tileKey = (t: TileId) => `${t.z}/${t.x}/${t.y}`;

interface WorldLine {
  key: string;
  path: Path;
  layer: LineLayerId;
  cls: string;
  rank: number;
  flags: number;
}

// Synchronous, so run it in the worker.
export function prepareArea(plan: TilePlan, layout: Layout, data: TileData): Prepared {
  const { transform } = plan;
  const window = layout.window;
  const windowPoly = shapePolygon(window);
  const [wx0, wy0, wx1, wy1] = bboxOf(windowPoly);
  const clipRect = {
    left: Math.floor(wx0 * SCALE) - 1,
    top: Math.floor(wy0 * SCALE) - 1,
    right: Math.ceil(wx1 * SCALE) + 1,
    bottom: Math.ceil(wy1 * SCALE) + 1,
  };
  const lines: WorldLine[] = [];
  const polygons: PreparedPolygon[] = [];
  const aerowayLines: { path: Path; widthM: number }[] = [];
  let bytes = 0;
  const warnings = [...plan.warnings];
  let missing = 0;
  // Tiles past the antimeridian are fetched with a wrapped x, so each one goes
  // on the copy of the world nearest the map centre.
  const worldTiles = 2 ** plan.zoom;
  const centreTile = transform.cx / TILE_EXTENT;

  for (const tile of plan.tiles) {
    const key = tileKey(tile);
    if (!data.has(key)) {
      missing++;
      continue;
    }
    const buffer = data.get(key);
    if (!buffer) continue; // an empty tile: nothing mapped there
    bytes += buffer.byteLength;
    const x = tile.x + worldTiles * Math.round((centreTile - tile.x) / worldTiles);
    const decoded = decodeTile(buffer, x, tile.y);
    for (const line of decoded.lines) {
      if (line.layer === 'aeroway') {
        const widthM = aerowayLineWidth(line.props);
        if (widthM) aerowayLines.push({ path: line.path, widthM });
        continue;
      }
      const c = classifyLine(line.layer, line.props);
      if (!c) continue;
      lines.push({ key: `${c.layer}|${c.cls}|${c.rank}|${c.flags}`, path: line.path, ...c });
    }
    for (const polygon of decoded.polygons) {
      const c = classifyPolygon(polygon.layer, polygon.props);
      if (!c) continue;
      const rings = polygon.rings.map((ring) =>
        ring.map((p) => {
          const [x, y] = transform.toCanvas(p.x, p.y);
          return { x: Math.round(x * SCALE), y: Math.round(y * SCALE) };
        }),
      );
      const clipped = clipToRect(clipRect, rings);
      if (clipped.length > 0) polygons.push({ ...c, rings: clipped });
    }
  }
  if (missing > 0) {
    warnings.push(`${missing} map tile(s) could not be downloaded, so parts of the map may be missing.`);
  }

  // Stitch while still in world units, where tile edges are exact.
  stitchSeams(lines);

  const prepared: PreparedLine[] = [];
  for (const line of lines) {
    const mm = line.path.map(([x, y]) => transform.toCanvas(x, y));
    for (const piece of clipPolylineInside(mm, windowPoly)) {
      prepared.push({ layer: line.layer, cls: line.cls, rank: line.rank, flags: line.flags, path: piece });
    }
  }

  const metresPerMm = transform.metresPerMm;
  for (const { path, widthM } of aerowayLines) {
    const mm = path.map(([x, y]) => transform.toCanvas(x, y));
    const band = bufferLines([mm], widthM / metresPerMm / 2, false);
    const clipped = clipToRect(clipRect, band);
    if (clipped.length > 0) polygons.push({ layer: 'aeroways', cls: 'runway', flags: 0, rings: clipped });
  }

  return {
    zoom: plan.zoom,
    transform,
    widthM: plan.widthM,
    heightM: plan.heightM,
    lines: prepared,
    polygons,
    tiles: plan.tiles.length,
    missing,
    bytes,
    warnings,
  };
}
