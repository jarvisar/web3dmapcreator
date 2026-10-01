// capBoundary against the Set it used to be built on: same edges in the same
// order, or null in the same cases. The order matters, since the underside
// is triangulated from the loops it traces.

import { describe, expect, it } from 'vitest';
import { capBoundary } from './cap';
import type { Tin } from './tinclip';

function setBoundary(tin: Tin): [number, number][] | null {
  const t = tin.triangles;
  const n = tin.vertices.length / 3;
  const directed = new Set<number>();
  for (let i = 0; i < t.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const key = t[i + k] * n + t[i + ((k + 1) % 3)];
      if (directed.has(key)) return null;
      directed.add(key);
    }
  }
  const boundary: [number, number][] = [];
  const outgoing = new Uint32Array(n);
  for (const key of directed) {
    const a = Math.floor(key / n);
    const b = key - a * n;
    if (directed.has(b * n + a)) continue;
    boundary.push([a, b]);
    if (++outgoing[a] > 1) return null;
  }
  return boundary;
}

/** Deterministic, so a failure can be run again. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A grid TIN with cells dropped and shuffled, and sometimes a triangle repeated, flipped or welded. */
function messyTin(n: number, seed: number, clean = false): Tin {
  const r = random(seed);
  const vertices = new Float64Array(3 * (n + 1) * (n + 1));
  const id = (i: number, j: number) => i * (n + 1) + j;
  const triangles: number[] = [];
  const drop = clean ? 0 : r() * 0.4;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (r() < drop) continue;
      triangles.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1));
    }
  }
  // Shuffle whole triangles, so the boundary isn't in grid order.
  const count = triangles.length / 3;
  for (let k = count - 1; k > 0; k--) {
    const m = Math.floor(r() * (k + 1));
    for (let c = 0; c < 3; c++) [triangles[3 * k + c], triangles[3 * m + c]] = [triangles[3 * m + c], triangles[3 * k + c]];
  }
  const mess = clean ? 1 : r();
  if (mess < 0.15 && count) triangles.push(...triangles.slice(0, 3));
  else if (mess < 0.3 && count) [triangles[1], triangles[2]] = [triangles[2], triangles[1]];
  else if (mess < 0.4 && count) triangles[3 * Math.floor(r() * count) + 1] = triangles[3 * Math.floor(r() * count)];
  return { vertices, triangles: Uint32Array.from(triangles) };
}

describe('capBoundary', () => {
  it('gives the same boundary, in the same order, as a Set of edges', () => {
    let nulls = 0;
    let boundaries = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const tin = messyTin(2 + (seed % 9), seed);
      const expected = setBoundary(tin);
      expect(capBoundary(tin)).toEqual(expected);
      if (expected) boundaries++;
      else nulls++;
    }
    // Both kinds of answer came up.
    expect(nulls).toBeGreaterThan(20);
    expect(boundaries).toBeGreaterThan(100);
  });

  it('handles more edges than a Set holds', () => {
    // 3 x 1,800^2 x 2 = 19.4 million directed edges, over 2^24.
    const n = 1800;
    const tin = messyTin(n, 7, true);
    const boundary = capBoundary(tin);
    expect(boundary).not.toBeNull();
    expect(boundary!.length).toBe(4 * n);
    // A repeated edge is still found.
    const doubled: Tin = { vertices: tin.vertices, triangles: Uint32Array.from([...tin.triangles.subarray(0, 6), ...tin.triangles.subarray(0, 3)]) };
    expect(capBoundary(doubled)).toBeNull();
  });
});
