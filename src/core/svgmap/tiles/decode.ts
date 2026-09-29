// Decodes vector tiles into world units. Each tile repeats a margin of its
// neighbours, so to put tiles back together without doubling anything:
// lines are cut exactly at the tile edge (stitchSeams rejoins them later), and
// polygons are cut one unit past it so neighbours overlap slightly and the
// union closes the seam.
import { VectorTile, type VectorTileFeature } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { FillRule, type Path64, union } from 'clipper2-ts';
import { clipToRect, pathBounds } from '../../geometry/clipRect';
import type { Path, Point } from '../lines/geometry';
import { TILE_EXTENT } from '../geo/mercator';

export type Props = Record<string, string | number | boolean>;

export interface RawLine {
  layer: string;
  props: Props;
  path: Path;
}

export interface RawPolygon {
  layer: string;
  props: Props;
  // Integer world coordinates. Outer rings positive, holes negative.
  rings: Path64[];
}

export interface DecodedTile {
  lines: RawLine[];
  polygons: RawPolygon[];
}

export const WANTED_LAYERS = new Set([
  'transportation',
  'building',
  'water',
  'waterway',
  'landcover',
  'landuse',
  'aeroway',
]);

function signedArea(ring: Path64): number {
  let total = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    total += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
  }
  return total / 2;
}

// Liang-Barsky. Points where a line crosses the box get the edge coordinate
// exactly instead of an interpolated one, which stitching relies on.
export function clipPolylineToBox(
  path: readonly Point[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Path[] {
  const out: Path[] = [];
  let current: Path = [];
  const flush = () => {
    if (current.length >= 2) out.push(current);
    current = [];
  };
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1];
    const [bx, by] = path[i];
    const dx = bx - ax;
    const dy = by - ay;
    let u0 = 0;
    let u1 = 1;
    let edge0 = -1;
    let edge1 = -1;
    const tests: [number, number][] = [
      [-dx, ax - x0],
      [dx, x1 - ax],
      [-dy, ay - y0],
      [dy, y1 - ay],
    ];
    let rejected = false;
    for (let e = 0; e < 4; e++) {
      const [p, q] = tests[e];
      if (p === 0) {
        if (q < 0) {
          rejected = true;
          break;
        }
        continue;
      }
      const t = q / p;
      if (p < 0) {
        if (t > u1) {
          rejected = true;
          break;
        }
        if (t > u0) {
          u0 = t;
          edge0 = e;
        }
      } else {
        if (t < u0) {
          rejected = true;
          break;
        }
        if (t < u1) {
          u1 = t;
          edge1 = e;
        }
      }
    }
    if (rejected) {
      flush();
      continue;
    }
    const snap = (x: number, y: number, e: number): Point =>
      e === 0 ? [x0, y] : e === 1 ? [x1, y] : e === 2 ? [x, y0] : e === 3 ? [x, y1] : [x, y];
    const start = u0 > 0 ? snap(ax + u0 * dx, ay + u0 * dy, edge0) : ([ax, ay] as Point);
    const end = u1 < 1 ? snap(ax + u1 * dx, ay + u1 * dy, edge1) : ([bx, by] as Point);
    const last = current[current.length - 1];
    if (last && last[0] === start[0] && last[1] === start[1]) {
      current.push(end);
    } else {
      flush();
      current = [start, end];
    }
    if (u1 < 1) flush();
  }
  flush();
  // Lines that only touch the box leave zero-length pieces.
  return out.filter((p) => p.some((q) => q[0] !== p[0][0] || q[1] !== p[0][1]));
}

function toPlainProps(props: VectorTileFeature['properties']): Props {
  const out: Props = {};
  for (const key of Object.keys(props)) {
    if (key.startsWith('name')) continue;
    out[key] = props[key] as string | number | boolean;
  }
  return out;
}

export function decodeTile(buffer: ArrayBuffer | Uint8Array, x: number, y: number): DecodedTile {
  const tile = new VectorTile(new PbfReader(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)));
  const lines: RawLine[] = [];
  const polygons: RawPolygon[] = [];
  const ox = x * TILE_EXTENT;
  const oy = y * TILE_EXTENT;

  for (const layerName of Object.keys(tile.layers)) {
    if (!WANTED_LAYERS.has(layerName)) continue;
    const layer = tile.layers[layerName];
    const k = TILE_EXTENT / layer.extent;
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      if (feature.type === 1) continue;
      const props = toPlainProps(feature.properties);
      const geometry = feature.loadGeometry();
      if (feature.type === 2) {
        for (const part of geometry) {
          const path: Path = part.map((p) => [ox + p.x * k, oy + p.y * k]);
          for (const piece of clipPolylineToBox(path, ox, oy, ox + TILE_EXTENT, oy + TILE_EXTENT)) {
            lines.push({ layer: layerName, props, path: piece });
          }
        }
      } else {
        const rings: Path64[] = [];
        let outerSign = 0;
        for (const part of geometry) {
          if (part.length < 3) continue;
          const ring: Path64 = part.map((p) => ({ x: Math.round(ox + p.x * k), y: Math.round(oy + p.y * k) }));
          const area = signedArea(ring);
          if (area === 0) continue;
          // In MVT the first ring is an outer ring. Rings wound the same way
          // start new polygons and rings wound the other way are holes.
          if (outerSign === 0) outerSign = Math.sign(area);
          const isOuter = Math.sign(area) === outerSign;
          if (isOuter !== area > 0) ring.reverse();
          rings.push(ring);
        }
        if (rings.length === 0) continue;
        const rect = { left: ox - 1, top: oy - 1, right: ox + TILE_EXTENT + 1, bottom: oy + TILE_EXTENT + 1 };
        let clipped = clipToRect(rect, rings);
        // The clip joins the pieces of a ring with edges back and forth along
        // the tile edge. Those cancel out now, but not once prepare rotates and
        // rounds the points, where they left hairline cracks along the seams.
        const crosses = rings.some((ring) => {
          const [x0, y0, x1, y1] = pathBounds(ring);
          return x0 < rect.left || y0 < rect.top || x1 > rect.right || y1 > rect.bottom;
        });
        if (crosses && clipped.length > 0) clipped = union(clipped, FillRule.NonZero);
        if (clipped.length > 0) polygons.push({ layer: layerName, props, rings: clipped });
      }
    }
  }
  return { lines, polygons };
}
