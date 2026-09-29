// Beaches: where sand runs down to cut water, the ground slopes to the
// water's surface instead of ending in a bank, and the sand thins out on top
// of it to a lip just above the water.
//
// The slope is worked into the height grid, so everything draped on it
// follows and nothing is left standing on the old ground. Grid points under
// or next to roads, buildings, bridges and ponds keep their height. Land cover
// behind a beach can slope with it, since it's draped too. The grid is
// coarser than a beach at most scales, so the ground's slope is at least a
// cell and a half wide. The sand's own taper is on a finer lattice.

import { EdgeIndex } from '../geometry/edgeindex';
import { boxesOverlap, bufferLines, clipToBox, difference, intersection, multiArea, multiBounds, offsetPolygons, polygonArea, ringBounds, union } from '../geometry/polygon';
import type { HeightField } from '../terrain/heightfield';
import { SLIVER_MM } from './land';
import type { MultiPolygon, Polygon, Vec2 } from '../types';

// Waterlines are judged in pieces this long, so a beach ends close to where
// the sand does.
const PIECE_MM = 0.5;
// Smaller scraps of bare ground left between sand and water aren't worth a polygon.
const MINIMUM_FILL_MM2 = 0.01;

export interface BeachInput {
  /** Cut water left open by the ground kept under structures, with its surface. */
  cut: { polygons: Polygon[]; top: number }[];
  crop: MultiPolygon;
  /** Land, less cut water and ponds. */
  ground: MultiPolygon;
  sand: MultiPolygon;
  /** Everything that keeps its ground: roads, buildings, bridges and small water. */
  blockers: MultiPolygon;
  /** Other land cover. A beach doesn't reach past it, but the ground under it can slope. */
  cover: MultiPolygon;
  /** Printed distance from the waterline over which a beach rises to the ground around it. */
  width: number;
}

export interface Beaches {
  /** Distance to the nearest beach waterline, or `limit` when none is that close. */
  distance(x: number, y: number, limit: number): number;
  /** Distance to the nearest edge of other land cover, or `limit`. */
  toCover(x: number, y: number, limit: number): number;
  /** The sand, run on to the water across bare ground it stopped short of. */
  sand: MultiPolygon;
  /** Sand added, mm². */
  filled: number;
  /** Grid points lowered. */
  lowered: number;
}

/**
 * Finds the waterlines sand runs down to and lowers the ground near them.
 * A stretch of shore is a beach where sand lies within the beach width of it
 * with nothing else in between, so sand behind a promenade leaves the
 * promenade's bank alone. Returns null when there are no beaches.
 */
export function shapeBeaches(hf: HeightField, input: BeachInput): Beaches | null {
  const { width } = input;
  if (!(width > 0) || !input.sand.length || !input.cut.length) return null;
  const sand = new EdgeIndex(input.sand, width);
  const blockers = new EdgeIndex(input.blockers, width);
  const cover = new EdgeIndex(input.cover, width);
  const between = new EdgeIndex([...input.blockers, ...input.cover], width);
  const crop = new EdgeIndex(input.crop, width);

  const waterlines: { index: EdgeIndex; top: number; box: [number, number, number, number] }[] = [];
  const runs: Vec2[][] = [];
  for (const body of input.cut) {
    const pieces: Vec2[][] = [];
    for (const polygon of body.polygons) {
      for (const ring of polygon) {
        let run: Vec2[] = [];
        const flush = () => {
          if (run.length > 1) runs.push(run);
          run = [];
        };
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % ring.length];
          const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / PIECE_MM));
          for (let k = 0; k < n; k++) {
            const p: Vec2 = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
            const q: Vec2 = [a[0] + ((b[0] - a[0]) * (k + 1)) / n, a[1] + ((b[1] - a[1]) * (k + 1)) / n];
            const mx = (p[0] + q[0]) / 2;
            const my = (p[1] + q[1]) / 2;
            const toSand = sand.distance(mx, my, width);
            const beach =
              // Water running off the model edge has no shore there.
              crop.distance(mx, my, 1e-3) >= 1e-3 &&
              toSand < width &&
              !between.contains(mx, my) &&
              between.distance(mx, my, toSand) >= toSand;
            if (!beach) {
              flush();
              continue;
            }
            pieces.push([p, q]);
            if (!run.length) run.push(p);
            run.push(q);
          }
        }
        flush();
      }
    }
    if (!pieces.length) continue;
    const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [p, q] of pieces) {
      box[0] = Math.min(box[0], p[0], q[0]);
      box[1] = Math.min(box[1], p[1], q[1]);
      box[2] = Math.max(box[2], p[0], q[0]);
      box[3] = Math.max(box[3], p[1], q[1]);
    }
    waterlines.push({ index: new EdgeIndex(pieces.map((piece) => [piece]), width), top: body.top, box });
  }
  if (!waterlines.length) return null;

  const nearest = (x: number, y: number, limit: number): { d: number; top: number } => {
    let best = { d: limit, top: 0 };
    for (const line of waterlines) {
      const [x0, y0, x1, y1] = line.box;
      if (x < x0 - best.d || x > x1 + best.d || y < y0 - best.d || y > y1 + best.d) continue;
      const d = line.index.distance(x, y, best.d);
      if (d < best.d) best = { d, top: line.top };
    }
    return best;
  };

  const wet = new EdgeIndex(input.cut.flatMap((body) => body.polygons), width);

  // Mapped sand often stops a little short of the mapped water, leaving a
  // strip of bare ground along the beach. A closing of sand and water together
  // fills gaps up to the beach width, and only turns the corner at the ends
  // of a beach instead of running the sand on past them.
  const band = bufferLines(runs.map((points) => ({ points, width: 2 * width })));
  const bandBox = multiBounds(band);
  const nearBand = (polygons: MultiPolygon) => polygons.filter((polygon) => boxesOverlap(ringBounds(polygon[0]), bandBox));
  const backing = nearBand(input.sand);
  const local = clipToBox([...backing, ...input.cut.flatMap((body) => body.polygons)], bandBox, width);
  const closed = offsetPolygons(offsetPolygons(local, width / 2, 'round'), -width / 2, 'round');
  let fill = difference(intersection(intersection(closed, band), input.ground), union([...nearBand(input.blockers), ...nearBand(input.cover)], backing));
  const touches = (index: EdgeIndex, polygon: Polygon) => polygon.some((ring) => ring.some(([x, y]) => index.distance(x, y, 1e-3) < 1e-3));
  if (fill.length) {
    // Opened with the sand it joins, so a strip too thin to print is only
    // kept when sand backs it.
    const opened = offsetPolygons(offsetPolygons(union(backing, fill), -SLIVER_MM, 'round'), SLIVER_MM, 'round');
    fill = intersection(fill, opened).filter(
      (polygon) => polygonArea(polygon) >= MINIMUM_FILL_MM2 && touches(sand, polygon) && touches(wet, polygon),
    );
  }
  const extended = fill.length ? union(input.sand, fill) : input.sand;

  const ramp = Math.max(width, 1.5 * hf.step);
  const { cols, rows, step } = hf;
  const seen = new Uint8Array(cols * rows);
  const lowered: [number, number][] = [];
  for (const line of waterlines) {
    const [x0, y0, x1, y1] = line.box;
    const c0 = Math.max(0, Math.floor((x0 - ramp - hf.minX) / step));
    const c1 = Math.min(cols - 1, Math.ceil((x1 + ramp - hf.minX) / step));
    const r0 = Math.max(0, Math.floor((y0 - ramp - hf.minY) / step));
    const r1 = Math.min(rows - 1, Math.ceil((y1 + ramp - hf.minY) / step));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const n = r * cols + c;
        if (seen[n]) continue;
        seen[n] = 1;
        const x = hf.minX + c * step;
        const y = hf.minY + r * step;
        const { d, top } = nearest(x, y, ramp);
        if (d >= ramp) continue;
        const h = hf.values[n];
        // A cell and a half keeps every grid triangle under a blocker whole.
        if (h <= top || blockers.touches(x, y, 1.5 * step)) continue;
        // Water nodes only shape the waterline here: at the surface, the
        // ground meets the water flush.
        if (wet.contains(x, y)) {
          if (d < 1.5 * step) lowered.push([n, top]);
        } else {
          lowered.push([n, top + (h - top) * (d / ramp)]);
        }
      }
    }
  }
  for (const [n, h] of lowered) hf.values[n] = h;

  return {
    distance: (x, y, limit) => nearest(x, y, limit).d,
    toCover: (x, y, limit) => cover.distance(x, y, limit),
    sand: extended,
    filled: multiArea(fill),
    lowered: lowered.length,
  };
}
