import { describe, expect, it } from 'vitest';
import { collapse, MIN_GAP } from './simplify';

type Grid = { values: Float64Array; nx: number; ny: number };

function raster(nx: number, ny: number, fn: (i: number, j: number) => number): Grid {
  const values = new Float64Array(nx * ny);
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) values[i * ny + j] = fn(i, j);
  return { values, nx, ny };
}

/** A height raster triangulated on its grid, each cell split along the diagonal of closest corners. */
function grid(h: Grid, pitch = 0.5): { vertices: Float64Array; faces: Uint32Array } {
  const { nx, ny, values } = h;
  const vertices = new Float64Array(nx * ny * 3);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const k = i * ny + j;
      vertices.set([i * pitch, j * pitch, values[k]], 3 * k);
    }
  }
  const first: number[] = [];
  const second: number[] = [];
  for (let i = 0; i < nx - 1; i++) {
    for (let j = 0; j < ny - 1; j++) {
      const a = i * ny + j;
      const b = (i + 1) * ny + j;
      const c = (i + 1) * ny + j + 1;
      const d = i * ny + j + 1;
      if (Math.abs(values[b] - values[d]) < Math.abs(values[a] - values[c])) {
        first.push(a, b, d);
        second.push(b, c, d);
      } else {
        first.push(a, b, c);
        second.push(a, c, d);
      }
    }
  }
  return { vertices, faces: Uint32Array.from([...first, ...second]) };
}

/** A tall block turned `angle` degrees to the grid on a flat plaza. */
function block(angle: number, pitch = 0.5, size = 60, top = 60): Grid {
  const n = Math.floor(size / pitch) + 1;
  const r = (angle * Math.PI) / 180;
  return raster(n, n, (i, j) => {
    const x = i * pitch - size / 2;
    const y = j * pitch - size / 2;
    const u = x * Math.cos(r) + y * Math.sin(r);
    const v = -x * Math.sin(r) + y * Math.cos(r);
    return Math.abs(u) < 15 && Math.abs(v) < 10 ? top : 0;
  });
}

function height(vertices: Float64Array, faces: Uint32Array, x: number, y: number): number {
  for (let f = 0; f < faces.length; f += 3) {
    const [a, b, c] = [faces[f], faces[f + 1], faces[f + 2]];
    const [x1, y1, z1] = [vertices[3 * a], vertices[3 * a + 1], vertices[3 * a + 2]];
    const [x2, y2, z2] = [vertices[3 * b], vertices[3 * b + 1], vertices[3 * b + 2]];
    const [x3, y3, z3] = [vertices[3 * c], vertices[3 * c + 1], vertices[3 * c + 2]];
    const det = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
    const u = ((y2 - y3) * (x - x3) + (x3 - x2) * (y - y3)) / det;
    const v = ((y3 - y1) * (x - x3) + (x1 - x3) * (y - y3)) / det;
    if (Math.min(u, v, 1 - u - v) >= -1e-9) return u * z1 + v * z2 + (1 - u - v) * z3;
  }
  throw new Error('point outside the cap');
}

/** Azimuth changes between neighbouring wall facets, and their plan widths. */
function walls(vertices: Float64Array, faces: Uint32Array, tall = 30): { change: number[]; width: number[] } {
  const facets: { azimuth: number; angle: number; width: number }[] = [];
  for (let f = 0; f < faces.length; f += 3) {
    const p = [0, 1, 2].map((k) => [vertices[3 * faces[f + k]], vertices[3 * faces[f + k] + 1], vertices[3 * faces[f + k] + 2]]);
    const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.max(Math.hypot(n[0], n[1], n[2]), 1e-12);
    n = n.map((c) => c / length);
    const zs = p.map((q) => q[2]);
    if (!(Math.abs(n[2]) < 0.5 && Math.max(...zs) - Math.min(...zs) > tall)) continue;
    const width = Math.max(...[0, 1, 2].map((k) => Math.hypot(p[(k + 1) % 3][0] - p[k][0], p[(k + 1) % 3][1] - p[k][1])));
    const cx = (p[0][0] + p[1][0] + p[2][0]) / 3;
    const cy = (p[0][1] + p[1][1] + p[2][1]) / 3;
    facets.push({ azimuth: (Math.atan2(n[1], n[0]) * 180) / Math.PI, angle: Math.atan2(cy - 30, cx - 30), width });
  }
  facets.sort((a, b) => a.angle - b.angle);
  const change: number[] = [];
  for (let i = 1; i < facets.length; i++) {
    const d = facets[i].azimuth - facets[i - 1].azimuth;
    change.push(Math.abs((((d + 180) % 360) + 360) % 360 - 180));
  }
  return { change, width: facets.map((w) => w.width) };
}

function checkCap(vertices: Float64Array, faces: Uint32Array) {
  let minPlan = Infinity;
  let minAltitude = Infinity;
  for (let f = 0; f < faces.length; f += 3) {
    const p = [0, 1, 2].map((k) => [vertices[3 * faces[f + k]], vertices[3 * faces[f + k] + 1]]);
    const plan = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]);
    const longest = Math.max(...[0, 1, 2].map((k) => Math.hypot(p[(k + 1) % 3][0] - p[k][0], p[(k + 1) % 3][1] - p[k][1])));
    minPlan = Math.min(minPlan, plan);
    minAltitude = Math.min(minAltitude, plan / longest);
  }
  expect(minPlan, 'every face keeps its plan orientation').toBeGreaterThan(0);
  expect(minAltitude).toBeGreaterThanOrEqual(MIN_GAP * 0.999);
  const order = [...Array(vertices.length / 3).keys()].sort((a, b) => vertices[3 * a] - vertices[3 * b] || vertices[3 * a + 1] - vertices[3 * b + 1]);
  let gap = Infinity;
  for (let i = 1; i < order.length; i++) {
    gap = Math.min(gap, Math.hypot(vertices[3 * order[i]] - vertices[3 * order[i - 1]], vertices[3 * order[i] + 1] - vertices[3 * order[i - 1] + 1]));
  }
  expect(gap).toBeGreaterThanOrEqual(MIN_GAP * 0.999);
}

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

describe('collapse', () => {
  it('turns a grid staircase into straight facets', () => {
    const { vertices, faces } = grid(block(30));
    const before = walls(vertices, faces);
    expect(before.change.filter((c) => c > 20).length / before.change.length).toBeGreaterThan(0.3);
    expect(before.change.length).toBeGreaterThan(300);
    const out = collapse(vertices, faces, 8, 1e6);
    checkCap(out.vertices, out.faces);
    const after = walls(out.vertices, out.faces);
    expect(out.faces.length).toBeLessThan(faces.length * 0.05);
    expect(after.change.length).toBeLessThan(40);
    expect(median(after.width)).toBeGreaterThan(2);
    const r = (30 * Math.PI) / 180;
    let worst = 0;
    for (let i = 0; i < out.vertices.length; i += 3) {
      if (out.vertices[i + 2] <= 59) continue;
      const x = out.vertices[i] - 30;
      const y = out.vertices[i + 1] - 30;
      const u = x * Math.cos(r) + y * Math.sin(r);
      const v = -x * Math.sin(r) + y * Math.cos(r);
      worst = Math.max(worst, Math.abs(Math.max(Math.abs(u) - 15, Math.abs(v) - 10)));
    }
    expect(worst).toBeLessThan(0.5);
    // A wall aligned with the grid is already straight and stays so.
    const aligned = grid(block(0));
    const kept = collapse(aligned.vertices, aligned.faces, 8, 1e6);
    const { change } = walls(kept.vertices, kept.faces);
    expect([...change].sort((a, b) => a - b)[change.length - 5]).toBeLessThan(1);
  });

  it('keeps a flat roof exact and its plant room', () => {
    const base = block(30);
    const heights = raster(base.nx, base.ny, (i, j) => (i >= 58 && i < 64 && j >= 58 && j < 64 ? 63 : base.values[i * base.ny + j]));
    const { vertices, faces } = grid(heights);
    // Without a deviation bound the plant room is lowered corner by corner.
    const eroded = collapse(vertices, faces, 8, 1e6);
    let survived = false;
    for (let i = 2; i < eroded.vertices.length; i += 3) if (Math.abs(eroded.vertices[i] - 63) < 0.1) survived = true;
    expect(survived).toBe(false);
    const out = collapse(vertices, faces, 8, 1e6, { deviation: 1 });
    checkCap(out.vertices, out.faces);
    let worst = 0;
    let plant = false;
    for (let i = 2; i < out.vertices.length; i += 3) {
      const z = out.vertices[i];
      if (Math.abs(z - 63) < 0.1) plant = true;
      if (z > 1) worst = Math.max(worst, Math.abs(z - (z > 61.5 ? 63 : 60)));
    }
    expect(worst).toBeLessThan(0.1);
    expect(plant).toBe(true);
    let roofFaces = 0;
    for (let f = 0; f < out.faces.length; f += 3) {
      const top = Math.max(out.vertices[3 * out.faces[f] + 2], out.vertices[3 * out.faces[f + 1] + 2], out.vertices[3 * out.faces[f + 2] + 2]);
      if (Math.abs(top - 60) < 1e-9) roofFaces++;
    }
    expect(roofFaces).toBeLessThan(60);
  });

  it('holds slender towers with fine vertices', () => {
    const tops = [30, 38, 26];
    for (const width of [4, 5]) {
      const centres: [number, number][] = [];
      const cells = new Map<number, number>();
      tops.forEach((top, k) => {
        const start = 12 + k * (width + 3);
        for (let i = start; i < start + width; i++) for (let j = 18; j < 18 + width; j++) cells.set(i * 41 + j, top);
        centres.push([(start + (width - 1) / 2) * 0.5, (18 + (width - 1) / 2) * 0.5]);
      });
      const heights = raster(61, 41, (i, j) => cells.get(i * 41 + j) ?? 10);
      const { vertices, faces } = grid(heights);
      const measured = (fine: number[]) => {
        const out = collapse(vertices, faces, 8, 1e6, { deviation: 1, fine });
        checkCap(out.vertices, out.faces);
        return centres.map(([x, y]) => height(out.vertices, out.faces, x, y));
      };
      const plain = measured([]);
      expect(Math.max(...plain.map((h, k) => Math.abs(h - tops[k])))).toBeGreaterThan(2);
      const fine: number[] = [];
      heights.values.forEach((h, k) => h > 20 && fine.push(k));
      const held = measured(fine);
      held.forEach((h, k) => expect(Math.abs(h - tops[k])).toBeLessThan(0.1));
    }
  });

  it('respects the budget, keeps the rim and is deterministic', () => {
    const { vertices, faces } = grid(raster(21, 21, () => 0));
    const out = collapse(vertices, faces, 0, 100);
    expect(out.faces.length / 3).toBeLessThanOrEqual(100);
    checkCap(out.vertices, out.faces);
    const kept = new Set<string>();
    for (let i = 0; i < out.vertices.length; i += 3) kept.add(`${out.vertices[i]},${out.vertices[i + 1]},${out.vertices[i + 2]}`);
    for (let i = 0; i < vertices.length; i += 3) {
      const [x, y] = [vertices[i], vertices[i + 1]];
      if (x === 0 || x === 10 || y === 0 || y === 10) expect(kept.has(`${x},${y},${vertices[i + 2]}`)).toBe(true);
    }
    const again = collapse(vertices, faces, 0, 100);
    expect(again.vertices).toEqual(out.vertices);
    expect(again.faces).toEqual(out.faces);
    const flat = collapse(vertices, faces, 1e-9, 1e6);
    expect(flat.faces.length / 3).toBeLessThan(200);
  });
});
