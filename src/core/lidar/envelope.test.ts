// Ported from the add-on's test_lidar_envelope.py. Each case is a real
// building that once came out wrong, reduced to a synthetic cloud.

import { describe, expect, it } from 'vitest';
import { difference, intersection, multiArea, pointInPolygon, union } from '../geometry/polygon';
import type { Tin } from '../geometry/tinclip';
import type { MultiPolygon, Polygon, Vec2 } from '../types';
import { envelopeParameters, facetBudget, fitRoofEnvelope, SNAP_GAP, type EnvelopeFit } from './envelope';
import type { Xyz } from './points';
import { rotate } from './shapes';
import { arange, NumpyRandom } from './test-helpers';
import shapelyCircle from './testdata/circle.json';

const box = (x0: number, y0: number, x1: number, y1: number): MultiPolygon => [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]];
/** Strictly inside, like Shapely's contains_xy: a point on the outline is outside. */
function inside(shape: MultiPolygon, x: number, y: number): boolean {
  for (const polygon of shape) {
    for (const ring of polygon) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [ax, ay] = ring[j];
        const [bx, by] = ring[i];
        const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
        if (cross === 0 && x >= Math.min(ax, bx) && x <= Math.max(ax, bx) && y >= Math.min(ay, by) && y <= Math.max(ay, by)) return false;
      }
    }
  }
  return shape.some((p: Polygon) => pointInPolygon(x, y, p));
}



function xyzFrom(rows: number[][]): Xyz {
  return { count: rows.length, x: Float64Array.from(rows, (r) => r[0]), y: Float64Array.from(rows, (r) => r[1]), z: Float64Array.from(rows, (r) => r[2]) };
}

function join(...parts: Xyz[]): Xyz {
  return xyzFrom(parts.flatMap((p) => Array.from({ length: p.count }, (_, k) => [p.x[k], p.y[k], p.z[k]])));
}

/** A 0.4 m grid of returns over the footprint, heights from `roof`. */
function cloud(footprint: MultiPolygon, roof: (x: number, y: number) => number): Xyz {
  const [x0, y0, x1, y1] = footprint.flat(2).reduce(
    (b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
  const rows: number[][] = [];
  for (const y of arange(y0 + 0.2, y1, 0.4)) for (const x of arange(x0 + 0.2, x1, 0.4)) if (inside(footprint, x, y)) rows.push([x, y, roof(x, y)]);
  return xyzFrom(rows);
}

function fit(footprint: MultiPolygon, samples: Xyz, returns: Xyz = samples, options: { secondary?: Xyz; neighbours?: MultiPolygon[]; scale?: [number, number] } = {}): EnvelopeFit {
  const { fit, reason } = fitRoofEnvelope(footprint, samples, 1.5, options.scale ?? [0.07, 0.077], returns, options.secondary ?? null, options.neighbours ?? []);
  expect(fit, reason ?? '').not.toBeNull();
  // The outline passes through the polygon helpers, which keep a 0.1 mm grid in metres.
  expect(Math.abs(capArea(fit!.cap) - multiArea(footprint))).toBeLessThan(2e-3);
  return fit!;
}

function capArea(cap: Tin): number {
  let a = 0;
  const v = cap.vertices;
  for (let t = 0; t < cap.triangles.length; t += 3) {
    const [p, q, r] = [3 * cap.triangles[t], 3 * cap.triangles[t + 1], 3 * cap.triangles[t + 2]];
    a += ((v[q] - v[p]) * (v[r + 1] - v[p + 1]) - (v[r] - v[p]) * (v[q + 1] - v[p + 1])) / 2;
  }
  return a;
}

/** The cap height at a point: the highest face above it. */
function heightAt(record: EnvelopeFit, x: number, y: number): number {
  const v = record.cap.vertices;
  const f = record.cap.triangles;
  let best = -Infinity;
  for (let t = 0; t < f.length; t += 3) {
    const [a, b, c] = [3 * f[t], 3 * f[t + 1], 3 * f[t + 2]];
    const det = (v[b + 1] - v[c + 1]) * (v[a] - v[c]) + (v[c] - v[b]) * (v[a + 1] - v[c + 1]);
    const u = ((v[b + 1] - v[c + 1]) * (x - v[c]) + (v[c] - v[b]) * (y - v[c + 1])) / det;
    const w = ((v[c + 1] - v[a + 1]) * (x - v[c]) + (v[a] - v[c]) * (y - v[c + 1])) / det;
    if (Math.min(u, w, 1 - u - w) < -1e-8) continue;
    best = Math.max(best, u * v[a + 2] + w * v[b + 2] + (1 - u - w) * v[c + 2]);
  }
  if (best === -Infinity) throw new Error(`No envelope above ${x}, ${y}`);
  return best;
}

function maxHeight(record: EnvelopeFit): number {
  let top = -Infinity;
  for (let k = 2; k < record.cap.vertices.length; k += 3) top = Math.max(top, record.cap.vertices[k]);
  return top;
}

/** Where the cap is at least `level`, as polygons. */
function heightContour(record: EnvelopeFit, level: number): MultiPolygon {
  const v = record.cap.vertices;
  const f = record.cap.triangles;
  const pieces: Polygon[] = [];
  for (let t = 0; t < f.length; t += 3) {
    const ring: Vec2[] = [];
    for (let k = 0; k < 3; k++) {
      const a = 3 * f[t + k];
      const b = 3 * f[t + ((k + 1) % 3)];
      if (v[a + 2] >= level) ring.push([v[a], v[a + 1]]);
      if (v[a + 2] >= level !== v[b + 2] >= level) {
        const s = (level - v[a + 2]) / (v[b + 2] - v[a + 2]);
        ring.push([v[a] + s * (v[b] - v[a]), v[a + 1] + s * (v[b + 1] - v[a + 1])]);
      }
    }
    if (ring.length >= 3) pieces.push([ring]);
  }
  return union(pieces);
}

/** Contour segment ends at `level` further than `margin` from the footprint outline. */
function riser(record: EnvelopeFit, level: number, footprint: MultiPolygon, margin: number): Vec2[] {
  const v = record.cap.vertices;
  const f = record.cap.triangles;
  const out: Vec2[] = [];
  const clear = (x: number, y: number) => {
    for (const polygon of footprint) {
      for (const ring of polygon) {
        for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
          const [ax, ay] = ring[j];
          const [bx, by] = ring[i];
          const dx = bx - ax;
          const dy = by - ay;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
          if (Math.hypot(x - ax - t * dx, y - ay - t * dy) < margin) return false;
        }
      }
    }
    return true;
  };
  for (let t = 0; t < f.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = 3 * f[t + k];
      const b = 3 * f[t + ((k + 1) % 3)];
      if (v[a + 2] >= level === v[b + 2] >= level) continue;
      const s = (level - v[a + 2]) / (v[b + 2] - v[a + 2]);
      const x = v[a] + s * (v[b] - v[a]);
      const y = v[a + 1] + s * (v[b + 1] - v[a + 1]);
      if (clear(x, y)) out.push([x, y]);
    }
  }
  return out;
}

const range = arange;

describe('roof envelope', () => {
  it('bridges a deep narrow recess and keeps a broad lower roof', () => {
    const footprint = box(0, 0, 40, 30);
    const record = fit(footprint, cloud(footprint, (x) => (x > 28 ? 20 : x > 12 && x < 12.5 ? 8 : 60)));
    expect(heightAt(record, 12.25, 15)).toBeGreaterThan(57);
    expect(Math.abs(heightAt(record, 36, 15) - 20)).toBeLessThan(0.6);
    expect(Math.abs(heightAt(record, 6, 15) - 60)).toBeLessThan(0.6);
  });

  it('never lets vegetation-filed facade returns pull the roof edge down', () => {
    const footprint = box(0, 0, 30, 24);
    const roof = cloud(box(0, 0, 22, 24), () => 80);
    const facade: number[][] = [];
    for (const x of arange(0.05, 22, 0.1)) for (const y of arange(22.95, 24, 0.25)) for (const z of arange(2, 79, 0.25)) facade.push([x, y, z]);
    const flare = cloud(box(22, 0, 30, 24), (x) => 80 - 5 * (x - 22));
    const record = fit(footprint, roof, roof, { secondary: join(xyzFrom(facade), flare) });
    expect(Math.min(...range(1, 20, 0.5).map((x) => heightAt(record, x, 23.99)))).toBeGreaterThan(79);
    expect(Math.abs(heightAt(record, 26, 12) - 60)).toBeLessThan(1.5);
  });

  it('keeps the roof edge over a dense facade band inside the outline', () => {
    const footprint = box(0, 0, 30, 24);
    const roof = cloud(footprint, () => 80);
    const facade: number[][] = [];
    for (const x of arange(0.05, 30, 0.1)) for (const y of arange(22.95, 24, 0.25)) for (const z of arange(2, 80, 0.25)) facade.push([x, y, z]);
    const record = fit(footprint, roof, join(roof, xyzFrom(facade)));
    expect(Math.min(...range(1, 29, 0.5).map((x) => heightAt(record, x, 23.99)))).toBeGreaterThan(79);
  });

  const towerFacade = (x0: number, x1: number, y0: number, y1: number, top: number) => {
    const rows: number[][] = [];
    for (const x of arange(x0 + 0.05, x1, 0.1)) for (const y of arange(y0 + 0.05, y1, 0.25)) for (const z of arange(22, top, 0.5)) rows.push([x, y, z]);
    return xyzFrom(rows);
  };

  it("does not stand a blade up a mapped neighbour's facade", () => {
    const footprint = box(0, 0, 30, 24);
    const tower = box(0, 24, 30, 40);
    const roof = cloud(footprint, () => 20);
    const returns = join(roof, towerFacade(0, 30, 23, 24, 150));
    const unmapped = fit(footprint, roof, returns);
    expect(heightAt(unmapped, 15, 23.5)).toBeGreaterThan(100);
    const mapped = fit(footprint, roof, returns, { neighbours: [tower] });
    expect(Math.max(...range(0.5, 30, 0.5).map((x) => heightAt(mapped, x, 23.9)))).toBeLessThan(21);
    expect(maxHeight(mapped)).toBeLessThan(21);
  });

  it('keeps a raised edge that reaches the roof inside beside a neighbour', () => {
    const footprint = box(0, 0, 30, 24);
    const neighbour = box(0, 24, 30, 40);
    const raised = union(box(0, 22.5, 30, 24), box(0, 14, 6, 24));
    const roof = cloud(footprint, (x, y) => (inside(raised, x, y) ? 30 : 20));
    const record = fit(footprint, roof, roof, { neighbours: [neighbour] });
    expect(Math.min(...range(1, 29, 1).map((x) => heightAt(record, x, 23.4)))).toBeGreaterThan(29);
    expect(Math.abs(heightAt(record, 3, 18) - 30)).toBeLessThan(0.6);
    expect(Math.abs(heightAt(record, 18, 10) - 20)).toBeLessThan(0.6);
  });

  it('does not hang icicles from a sparse facade band', () => {
    const noise = new NumpyRandom(7);
    const footprint = box(0, 0, 40, 24);
    const rows: number[][] = [];
    for (const y of arange(0.1, 22.9, 0.36)) for (const x of arange(0.1, 40, 0.36)) rows.push([x, y, 60]);
    const jitter = noise.uniform(-0.12, 0.12, rows.length * 2);
    rows.forEach((row, k) => {
      row[0] += jitter[2 * k];
      row[1] += jitter[2 * k + 1];
    });
    const roof = xyzFrom(rows);
    const [wx, wy, wz] = [noise.uniform(0, 40, 240), noise.uniform(22.8, 23.3, 240), noise.uniform(3, 59, 240)];
    const wall = xyzFrom(wx.map((x, k) => [x, wy[k], wz[k]]));
    const record = fit(footprint, roof, join(roof, wall));
    expect(Math.min(...range(0.5, 39.6, 0.25).map((x) => heightAt(record, x, 23.9)))).toBeGreaterThan(58);
  });

  it('treats a ledge, a light well and an eave as geometry, not notches', () => {
    const footprint = box(0, 0, 40, 30);
    const tower = difference(box(0, 0, 40, 28.8), box(18, 0, 21, 7));
    const record = fit(footprint, cloud(footprint, (x, y) => (inside(tower, x, y) ? 60 : 20)));
    for (const [x, y] of [
      [10, 29.6],
      [30, 29.6],
      [19.5, 1],
    ]) {
      expect(Math.abs(heightAt(record, x, y) - 20)).toBeLessThan(0.6);
    }
    const eave = box(0, 0, 30, 20);
    const dormers = [4, 9, 14, 19, 24].map((x) => box(x, 0, x + 1, 6));
    const pitched = fit(eave, cloud(eave, (x, y) => (dormers.some((d) => inside(d, x, y)) ? 36 : 30 + Math.min(y, 6))));
    for (const x of [2, 7, 12, 17, 22, 27]) expect(heightAt(pitched, x, 0.3)).toBeLessThan(31.2);
  });

  it('removes an isolated high return but keeps a supported cap', () => {
    const footprint = box(0, 0, 30, 30);
    const cap = box(12, 12, 18, 18);
    const record = fit(footprint, join(cloud(footprint, (x, y) => (inside(cap, x, y) ? 35 : 20)), xyzFrom([[4.13, 4.17, 100]])));
    expect(heightAt(record, 4.13, 4.17)).toBeLessThan(21);
    expect(Math.abs(heightAt(record, 15, 15) - 35)).toBeLessThan(0.6);
    expect(maxHeight(record)).toBeLessThan(36);
  });

  it('keeps courtyards and separate components apart', () => {
    const first = difference(box(0, 0, 24, 24), box(8, 8, 16, 16));
    const footprint: MultiPolygon = [...first, ...box(25, 0, 35, 24)];
    const record = fit(footprint, cloud(footprint, (x) => (x < 24 ? 30 + 0.1 * x : 8)));
    expect(Math.abs(heightAt(record, 30, 12) - 8)).toBeLessThan(0.3);
    expect(Math.abs(heightAt(record, 22, 12) - 32.2)).toBeLessThan(0.3);
    expect(multiArea(intersection(heightContour(record, 1), box(8, 8, 16, 16)))).toBeLessThan(1e-8);
  });

  it('keeps slender towers at their heights', () => {
    const footprint = box(0, 0, 30, 24);
    const towers: [MultiPolygon, number][] = [
      [box(8, 10, 11, 13), 30],
      [box(13, 10, 16, 13), 38],
      [box(18, 10, 21, 13), 26],
    ];
    const record = fit(footprint, cloud(footprint, (x, y) => towers.find(([t]) => inside(t, x, y))?.[1] ?? 10));
    expect(Math.abs(heightAt(record, 9.5, 11.5) - 30)).toBeLessThan(0.3);
    expect(Math.abs(heightAt(record, 14.5, 11.5) - 38)).toBeLessThan(0.3);
    expect(Math.abs(heightAt(record, 19.5, 11.5) - 26)).toBeLessThan(0.3);
    expect(Math.max(heightAt(record, 12, 11.5), heightAt(record, 17, 11.5))).toBeLessThan(11);
  });

  it('grids a steep spire as finely as it was scanned', () => {
    // Shapely's Point(0, 0).buffer(8). Every side of a regular polygon gives
    // the same rectangle area, so the raster's axis comes down to rounding in
    // the exact vertices.
    const footprint: MultiPolygon = [[shapelyCircle as Vec2[]]];
    const record = fit(footprint, cloud(footprint, (x, y) => 40 - 3 * Math.hypot(x, y)));
    expect(record.diagnostics.envelope_pitch_m).toBe(0.5);
    expect(heightAt(record, 0, 0)).toBeGreaterThan(38);
  });

  it('does not terrace a noisy slope', () => {
    const noise = new NumpyRandom(3);
    const footprint = box(0, 0, 40, 30);
    const record = fit(footprint, cloud(footprint, (x) => 20 + 0.4 * x + noise.uniform(-2, 2)[0]));
    expect(record.diagnostics.envelope_pitch_m as number).toBeGreaterThan(0.5);
    const xs = range(4, 36, 0.25);
    const profiles = [7.3, 15.1, 22.7].map((y) => xs.map((x) => heightAt(record, x, y)));
    let flat = 0;
    let total = 0;
    for (const p of profiles) for (let k = 1; k < p.length; k++, total++) if ((p[k] - p[k - 1]) / 0.25 < 0.1) flat++;
    expect(flat / total).toBeLessThan(0.05);
    // Residual about a straight trend.
    const all = profiles.flatMap((p) => p.map((z, k) => [xs[k], z]));
    const n = all.length;
    const mx = all.reduce((s, [x]) => s + x, 0) / n;
    const mz = all.reduce((s, [, z]) => s + z, 0) / n;
    const slope = all.reduce((s, [x, z]) => s + (x - mx) * (z - mz), 0) / all.reduce((s, [x]) => s + (x - mx) ** 2, 0);
    const std = Math.sqrt(all.reduce((s, [x, z]) => s + (z - mz - slope * (x - mx)) ** 2, 0) / n);
    expect(std).toBeLessThan(0.16);
  });

  it('does not rib the roof wall of a rotated building', () => {
    const angle = (30 * Math.PI) / 180;
    const footprint = rotate(box(0, 0, 60, 24), angle, [0, 0]);
    const across = (x: number, y: number) => -x * Math.sin(angle) + y * Math.cos(angle);
    const record = fit(footprint, cloud(footprint, (x, y) => (across(x, y) < 12 ? 40 : 25)));
    const offsets = riser(record, 32.5, footprint, 1.5).map(([x, y]) => across(x, y));
    expect(offsets.length).toBeGreaterThan(0);
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThan(0.5);
    expect(Math.abs(offsets.reduce((s, o) => s + o, 0) / offsets.length - 12)).toBeLessThan(1);
  });

  it('does not rib a diagonal tower wall', () => {
    const footprint = box(0, 0, 40, 40);
    const record = fit(footprint, cloud(footprint, (x, y) => (x + y < 40.5 ? 60 : 20)));
    const offsets = riser(record, 40, footprint, 3).map(([x, y]) => (x + y) / Math.SQRT2);
    expect(offsets.length).toBeGreaterThan(0);
    // The add-on held this to 0.2 m by moving vertices off the grid. Here they
    // stay on grid points, and the 0.4 m returns alias against 0.5 m cells into
    // a staircase, so the wall is held to within one cell's diagonal instead.
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThan(0.75);
  });

  it('does not rib a curved tower face inside the footprint', () => {
    const footprint = box(0, 0, 90, 70);
    const face = (x: number) => 40 + 12 * (1 - ((x - 45) / 45) ** 2);
    const record = fit(footprint, cloud(footprint, (x, y) => (y < face(x) ? 200 : 10)));
    const points = riser(record, 105, footprint, 3).sort((a, b) => a[0] - b[0]);
    const offsets = points.map(([x, y]) => (y - face(x)) / Math.hypot(1, (24 * (x - 45)) / 45 ** 2));
    const trend = points.map(([at]) => {
      const near = points.map(([x], k) => [x, offsets[k]]).filter(([x]) => Math.abs(x - at) < 2);
      return near.reduce((s, [, o]) => s + o, 0) / near.length;
    });
    expect(Math.max(...offsets.map((o, k) => Math.abs(o - trend[k])))).toBeLessThan(0.2);
    expect(Math.abs(offsets.reduce((s, o) => s + o, 0) / offsets.length)).toBeLessThan(0.5);
    expect(record.cap.triangles.length / 3).toBeLessThan(1500);
  });

  it('straightens narrow piers on a leaning face', () => {
    const footprint = box(0, 0, 72, 40);
    const pier = (x: number) => (x % 12 < 3 ? 1.2 : 0);
    const record = fit(footprint, cloud(footprint, (x, y) => Math.min(150, Math.max(10, 10 + 35 * (y - 10 + pier(x))))));
    for (const level of [40, 80, 120]) {
      const ys = riser(record, level, footprint, 3).map(([, y]) => y);
      expect(ys.length).toBeGreaterThan(0);
      expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(0.6);
    }
  });

  it('keeps masses on a roof that can print and flattens the rest', () => {
    const footprint = box(0, 0, 40, 30);
    const room = box(10, 10, 13, 13);
    const wall = box(20, 5, 22.5, 14);
    const plant = box(28, 16, 34, 24);
    const roof = (x: number, y: number) => (inside(room, x, y) ? 33 : inside(wall, x, y) ? 32 : inside(plant, x, y) ? 34 : 30);
    // At the default scale the room is 0.21 mm across and the wall 0.18 mm
    // thick, each about a layer tall: less than a nozzle can print.
    const record = fit(footprint, cloud(footprint, roof));
    expect(heightAt(record, 11.5, 11.5)).toBeCloseTo(30, 1);
    expect(heightAt(record, 21.25, 9.5)).toBeCloseTo(30, 1);
    expect(heightAt(record, 31, 20)).toBeGreaterThan(33.5);
    // Printed at 0.2 mm per metre they're three times the size, and stay.
    const large = fit(footprint, cloud(footprint, roof), undefined, { scale: [0.2, 0.22] });
    expect(heightAt(large, 11.5, 11.5)).toBeGreaterThan(32.5);
    expect(heightAt(large, 21.25, 9.5)).toBeGreaterThan(31.5);
  });

  it('keeps the steps of stepped tower corners', () => {
    const footprint = box(0, 0, 60, 80);
    const tower = union(box(0, 39.5, 60, 80), box(3.5, 36.5, 56.5, 80), box(6.5, 33.5, 53.5, 80), box(9.5, 30.5, 50.5, 80));
    const record = fit(footprint, cloud(footprint, (x, y) => (inside(tower, x, y) ? 160 : 20)));
    for (const [x, y] of [
      [1.75, 38],
      [5, 35],
      [8, 32],
      [58.25, 38],
      [55, 35],
      [52, 32],
    ]) {
      expect(Math.abs(heightAt(record, x, y) - 20)).toBeLessThan(0.6);
    }
    for (const [x, y] of [
      [1.75, 41],
      [5, 38],
      [8, 35],
      [11, 32],
      [58.25, 41],
      [55, 38],
      [52, 35],
      [49, 32],
    ]) {
      expect(Math.abs(heightAt(record, x, y) - 160)).toBeLessThan(0.6);
    }
    const wall = heightContour(record, 90);
    const symmetric = multiArea(wall) + multiArea(tower) - 2 * multiArea(intersection(wall, tower));
    expect(symmetric).toBeLessThan(20);
  });

  it('follows print scale and survey density', () => {
    expect(envelopeParameters([0.035, 0.0385])[0]).toBeCloseTo(1, 9);
    expect(envelopeParameters([0.07, 0.077])[0]).toBeCloseTo(0.8, 9);
    expect(envelopeParameters([0.07, 0.077], 20)[0]).toBeCloseTo(0.5, 9);
    expect(envelopeParameters([0.07, 0.077], 2.25)[0]).toBeCloseTo(2 / 3, 9);
    expect(envelopeParameters([0.28, 0.308], 1)[0]).toBeCloseTo(0.8, 9);
    expect(envelopeParameters([0.0175, 0.0193], 50)[0]).toBeCloseTo(2, 9);
    expect(facetBudget(1)).toBe(16384);
    expect(facetBudget(2)).toBe(16384);
    expect(facetBudget(0.5)).toBe(65536);
  });

  it('leaves no sliver corners when the outline is a hair off a grid line', () => {
    const footprint = box(0, 0, 24.001, 20);
    const record = fit(footprint, cloud(footprint, () => 30));
    const ring = footprint[0][0];
    for (let k = 0; k < record.cap.vertices.length; k += 3) {
      const [x, y] = [record.cap.vertices[k], record.cap.vertices[k + 1]];
      let distance = Infinity;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [ax, ay] = ring[j];
        const [bx, by] = ring[i];
        const dx = bx - ax;
        const dy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
        distance = Math.min(distance, Math.hypot(x - ax - t * dx, y - ay - t * dy));
      }
      expect(distance < 1e-9 || distance >= SNAP_GAP - 1e-9).toBe(true);
    }
  });

  it('fails explicitly on invalid input', () => {
    const footprint = box(0, 0, 24, 24);
    const samples = cloud(footprint, (x) => 20 + x * 0.1);
    expect(() => fitRoofEnvelope(footprint, samples, 0)).toThrow();
    expect(fitRoofEnvelope(footprint, xyzFrom([[0, 0, 1]]), 1.5).reason).toBe('insufficient upper surface samples');
  });
});
