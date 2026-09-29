import type { Paths64 } from 'clipper2-ts';
import { SCALE } from './fills';
import type { Path, Point } from './lines/geometry';

export interface HatchSettings {
  spacing: number;
  // Degrees. 0 is horizontal.
  angle: number;
  // A second pass at 90 degrees.
  cross: boolean;
}

const MIN_HATCH_SPACING = 0.02;

// Scanline hatching of non-overlapping rings. Lines sit on one grid so hatching
// in neighbouring areas lines up, and every other line is reversed so the pen
// zig-zags instead of flying back.
export function hatch(paths: Paths64, spacing: number, angleDeg: number): Path[] {
  if (paths.length === 0 || !(spacing > 0)) return [];
  // Finer than any pen, and a line per micron over a whole map never finishes.
  spacing = Math.max(spacing, MIN_HATCH_SPACING);
  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const edges: [number, number, number, number][] = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const path of paths) {
    for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
      const ax = path[j].x / SCALE;
      const ay = path[j].y / SCALE;
      const bx = path[i].x / SCALE;
      const by = path[i].y / SCALE;
      const y0 = -ax * sin + ay * cos;
      const y1 = -bx * sin + by * cos;
      if (y0 === y1) continue;
      const x0 = ax * cos + ay * sin;
      const x1 = bx * cos + by * sin;
      edges.push(y0 < y1 ? [y0, x0, y1, x1] : [y1, x1, y0, x0]);
      minY = Math.min(minY, y0, y1);
      maxY = Math.max(maxY, y0, y1);
    }
  }
  if (edges.length === 0) return [];
  edges.sort((p, q) => p[0] - q[0]);

  const out: Path[] = [];
  const unrotate = (x: number, y: number): Point => [x * cos - y * sin, x * sin + y * cos];
  let next = 0;
  let active: [number, number, number, number][] = [];
  let flip = false;
  // Offset by half a spacing so a line never runs exactly along an edge.
  for (let k = Math.ceil(minY / spacing - 0.5); (k + 0.5) * spacing < maxY; k++) {
    const y = (k + 0.5) * spacing;
    while (next < edges.length && edges[next][0] <= y) active.push(edges[next++]);
    active = active.filter((e) => e[2] > y);
    const xs: number[] = [];
    for (const [y0, x0, y1, x1] of active) {
      if (y0 <= y && y < y1) xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
    }
    xs.sort((p, q) => p - q);
    const row: Path[] = [];
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] > 1e-6) row.push([unrotate(xs[i], y), unrotate(xs[i + 1], y)]);
    }
    if (flip) {
      row.reverse();
      for (const seg of row) seg.reverse();
    }
    flip = !flip;
    out.push(...row);
  }
  return out;
}

export function hatchWith(paths: Paths64, settings: HatchSettings): Path[] {
  const lines = hatch(paths, settings.spacing, settings.angle);
  return settings.cross ? lines.concat(hatch(paths, settings.spacing, settings.angle + 90)) : lines;
}

export function outlines(paths: Paths64): Path[] {
  return paths
    .filter((p) => p.length >= 3)
    .map((p) => {
      const ring: Path = p.map((q) => [q.x / SCALE, q.y / SCALE]);
      ring.push([ring[0][0], ring[0][1]]);
      return ring;
    });
}

export interface OrderResult {
  paths: Path[];
  // Pen-up travel, mm.
  travel: number;
}

// Greedy nearest neighbour, reversing paths when their far end is closer. Not
// optimal, but much less pen-up travel than the input order and fast with a grid.
export function orderForPlotting(input: readonly Path[], start: Point = [0, 0]): OrderResult {
  const paths = input.filter((p) => p.length >= 2);
  const n = paths.length;
  if (n === 0) return { paths: [], travel: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of paths) {
    for (const q of [p[0], p[p.length - 1]]) {
      minX = Math.min(minX, q[0]);
      minY = Math.min(minY, q[1]);
      maxX = Math.max(maxX, q[0]);
      maxY = Math.max(maxY, q[1]);
    }
  }
  const cell = Math.max(Math.hypot(maxX - minX, maxY - minY) / Math.sqrt(n), 1e-3);
  const cols = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const rows = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
  const grid: number[][] = Array.from({ length: cols * rows }, () => []);
  const cellOf = (x: number, y: number): [number, number] => [
    Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / cell))),
    Math.min(rows - 1, Math.max(0, Math.floor((y - minY) / cell))),
  ];
  // 2*i is the start of path i and 2*i+1 its end.
  paths.forEach((p, i) => {
    for (const [e, q] of [
      [2 * i, p[0]],
      [2 * i + 1, p[p.length - 1]],
    ] as const) {
      const [cx, cy] = cellOf(q[0], q[1]);
      grid[cy * cols + cx].push(e);
    }
  });
  const used = new Uint8Array(n);
  const out: Path[] = [];
  let travel = 0;
  let here = start;
  for (let count = 0; count < n; count++) {
    const [hx, hy] = cellOf(here[0], here[1]);
    let best = -1;
    let bestD = Infinity;
    for (let ring = 0; ring < Math.max(cols, rows); ring++) {
      // Stop once this ring of cells is further away than the best hit.
      if (best >= 0 && (ring - 1) * cell > bestD) break;
      for (let dy = -ring; dy <= ring; dy++) {
        const y = hy + dy;
        if (y < 0 || y >= rows) continue;
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
          const x = hx + dx;
          if (x < 0 || x >= cols) continue;
          const bucket = grid[y * cols + x];
          for (let b = bucket.length - 1; b >= 0; b--) {
            const e = bucket[b];
            if (used[e >> 1]) {
              bucket.splice(b, 1);
              continue;
            }
            const p = paths[e >> 1];
            const q = e & 1 ? p[p.length - 1] : p[0];
            const d = Math.hypot(q[0] - here[0], q[1] - here[1]);
            if (d < bestD) {
              bestD = d;
              best = e;
            }
          }
        }
      }
    }
    if (best < 0) break;
    const index = best >> 1;
    used[index] = 1;
    const path = best & 1 ? [...paths[index]].reverse() : paths[index];
    travel += bestD;
    out.push(path);
    here = path[path.length - 1];
  }
  return { paths: out, travel };
}
