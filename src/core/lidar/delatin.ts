// Greedy insertion of a height grid into a Delaunay TIN until no cell is
// further than a set distance from it (Garland and Heckbert, "Fast Polygonal
// Approximation of Terrains and Height Fields", 1995). The error is measured
// against the grid itself, so a roof step can't be smeared into a slope the way
// a plane-distance simplification lets a vertex slide down a wall.
//
// The distance is square to each triangle rather than vertical, and the bound
// eases from `bound` on a flat triangle to `across` on a wall. On a flat roof
// that's the vertical error. On a wall it's how far across the wall is out, so
// a diagonal wall can run straight past the staircase of cells it crosses
// instead of copying it into ribs.
//
// Ported from Delatin (https://github.com/mapbox/delatin), changed to read our
// grid layout (i * ny + j), to measure the error square to the triangle, to
// count it only inside a mask and scaled per cell, to stop at a triangle budget
// and to return counter-clockwise triangles.
//
// ISC License. Copyright (c) 2019, Michael Fogleman, Vladimir Agafonkin.
// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
// SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER
// RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF
// CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
// CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

/** How close a TIN over a grid has to stay to it. */
export interface Tolerance {
  /** Largest distance from a cell to a flat triangle, in height units. */
  bound: number;
  /** Largest distance from a cell to a wall, across it. */
  across: number;
  /** Spacing of the grid in height units, which gives the triangles their slope. */
  pitch: number;
  /** Cells outside the mask never ask for a vertex, though they still shape the triangles over them. */
  mask?: ArrayLike<number>;
  /** Multiplies each cell's distance, so a cell with 4 is held to a quarter of the bound. */
  weight?: ArrayLike<number>;
}

/**
 * What a vertical distance to the triangle through grid points (x, y, z) is
 * worth as a share of the distance allowed: over 1 is too far.
 */
export function errorScale(ax: number, ay: number, za: number, bx: number, by: number, zb: number, cx: number, cy: number, zc: number, tolerance: Tolerance): number {
  const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  const gx = ((zb - za) * (cy - ay) - (zc - za) * (by - ay)) / det;
  const gy = ((zc - za) * (bx - ax) - (zb - za) * (cx - ax)) / det;
  // Cosine of the slope: the distance square to the triangle per unit vertically.
  const square = 1 / Math.sqrt(1 + (gx * gx + gy * gy) / tolerance.pitch ** 2);
  return square / (tolerance.across + (tolerance.bound - tolerance.across) * square);
}

export interface GridTin {
  /** Grid indices (i, j) per vertex. */
  coords: number[];
  /** Counter-clockwise with i to the right and j up. */
  triangles: number[];
  /** The worst cell's distance as a share of what's allowed. */
  maxError: number;
}

/** `heights[i * ny + j]` over an nx by ny grid. */
export function gridTin(heights: ArrayLike<number>, nx: number, ny: number, tolerance: Tolerance, maxTriangles: number): GridTin {
  const tin = new Delatin(heights, nx, ny, tolerance);
  while (tin.maxError() > 1 && tin.triangles.length / 3 < maxTriangles) tin.refine();
  // Delatin's triangles run clockwise with this orientation.
  const triangles = tin.triangles.slice();
  for (let t = 0; t < triangles.length; t += 3) [triangles[t + 1], triangles[t + 2]] = [triangles[t + 2], triangles[t + 1]];
  return { coords: tin.coords, triangles, maxError: tin.maxError() };
}

class Delatin {
  coords: number[] = [];
  triangles: number[] = [];
  private halfedges: number[] = [];
  private candidates: number[] = [];
  private queueIndices: number[] = [];
  private queue: number[] = [];
  private errors: number[] = [];
  private pending: number[] = [];
  private pendingLen = 0;

  constructor(
    private readonly data: ArrayLike<number>,
    nx: number,
    private readonly ny: number,
    private readonly tolerance: Tolerance,
  ) {
    const x1 = nx - 1;
    const y1 = ny - 1;
    const p0 = this.addPoint(0, 0);
    const p1 = this.addPoint(x1, 0);
    const p2 = this.addPoint(0, y1);
    const p3 = this.addPoint(x1, y1);
    const t0 = this.addTriangle(p3, p0, p2, -1, -1, -1);
    this.addTriangle(p0, p3, p1, t0, -1, -1);
    this.flush();
  }

  maxError(): number {
    return this.errors.length ? this.errors[0] : 0;
  }

  refine(): void {
    this.step();
    this.flush();
  }

  private heightAt(x: number, y: number): number {
    return this.data[x * this.ny + y];
  }

  private flush(): void {
    const c = this.coords;
    for (let i = 0; i < this.pendingLen; i++) {
      const t = this.pending[i];
      const a = 2 * this.triangles[t * 3];
      const b = 2 * this.triangles[t * 3 + 1];
      const d = 2 * this.triangles[t * 3 + 2];
      this.findCandidate(c[a], c[a + 1], c[b], c[b + 1], c[d], c[d + 1], t);
    }
    this.pendingLen = 0;
  }

  // Rasterise a triangle and queue it with its worst cell.
  private findCandidate(p0x: number, p0y: number, p1x: number, p1y: number, p2x: number, p2y: number, t: number): void {
    const minX = Math.min(p0x, p1x, p2x);
    const minY = Math.min(p0y, p1y, p2y);
    const maxX = Math.max(p0x, p1x, p2x);
    const maxY = Math.max(p0y, p1y, p2y);
    let w00 = orient(p1x, p1y, p2x, p2y, minX, minY);
    let w01 = orient(p2x, p2y, p0x, p0y, minX, minY);
    let w02 = orient(p0x, p0y, p1x, p1y, minX, minY);
    const a01 = p1y - p0y;
    const b01 = p0x - p1x;
    const a12 = p2y - p1y;
    const b12 = p1x - p2x;
    const a20 = p0y - p2y;
    const b20 = p2x - p0x;
    const a = orient(p0x, p0y, p1x, p1y, p2x, p2y);
    const h0 = this.heightAt(p0x, p0y);
    const h1 = this.heightAt(p1x, p1y);
    const h2 = this.heightAt(p2x, p2y);
    const z0 = h0 / a;
    const z1 = h1 / a;
    const z2 = h2 / a;
    const { mask, weight } = this.tolerance;
    const scale = errorScale(p0x, p0y, h0, p1x, p1y, h1, p2x, p2y, h2, this.tolerance);
    let maxError = 0;
    let mx = 0;
    let my = 0;
    for (let y = minY; y <= maxY; y++) {
      let dx = 0;
      if (w00 < 0 && a12 !== 0) dx = Math.max(dx, Math.floor(-w00 / a12));
      if (w01 < 0 && a20 !== 0) dx = Math.max(dx, Math.floor(-w01 / a20));
      if (w02 < 0 && a01 !== 0) dx = Math.max(dx, Math.floor(-w02 / a01));
      let w0 = w00 + a12 * dx;
      let w1 = w01 + a20 * dx;
      let w2 = w02 + a01 * dx;
      let wasInside = false;
      for (let x = minX + dx; x <= maxX; x++) {
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
          wasInside = true;
          const c = x * this.ny + y;
          if (!mask || mask[c]) {
            const dz = Math.abs(z0 * w0 + z1 * w1 + z2 * w2 - this.data[c]) * scale * (weight ? weight[c] : 1);
            if (dz > maxError) {
              maxError = dz;
              mx = x;
              my = y;
            }
          }
        } else if (wasInside) {
          break;
        }
        w0 += a12;
        w1 += a20;
        w2 += a01;
      }
      w00 += b12;
      w01 += b20;
      w02 += b01;
    }
    if ((mx === p0x && my === p0y) || (mx === p1x && my === p1y) || (mx === p2x && my === p2y)) maxError = 0;
    this.candidates[2 * t] = mx;
    this.candidates[2 * t + 1] = my;
    this.queuePush(t, maxError);
  }

  // Split the worst triangle at its worst cell.
  private step(): void {
    const t = this.queuePop();
    const e0 = t * 3;
    const e1 = t * 3 + 1;
    const e2 = t * 3 + 2;
    const p0 = this.triangles[e0];
    const p1 = this.triangles[e1];
    const p2 = this.triangles[e2];
    const c = this.coords;
    const [ax, ay, bx, by, cx, cy] = [c[2 * p0], c[2 * p0 + 1], c[2 * p1], c[2 * p1 + 1], c[2 * p2], c[2 * p2 + 1]];
    const px = this.candidates[2 * t];
    const py = this.candidates[2 * t + 1];
    const pn = this.addPoint(px, py);
    if (orient(ax, ay, bx, by, px, py) === 0) this.handleCollinear(pn, e0);
    else if (orient(bx, by, cx, cy, px, py) === 0) this.handleCollinear(pn, e1);
    else if (orient(cx, cy, ax, ay, px, py) === 0) this.handleCollinear(pn, e2);
    else {
      const h0 = this.halfedges[e0];
      const h1 = this.halfedges[e1];
      const h2 = this.halfedges[e2];
      const t0 = this.addTriangle(p0, p1, pn, h0, -1, -1, e0);
      const t1 = this.addTriangle(p1, p2, pn, h1, -1, t0 + 1);
      const t2 = this.addTriangle(p2, p0, pn, h2, t0 + 2, t1 + 1);
      this.legalize(t0);
      this.legalize(t1);
      this.legalize(t2);
    }
  }

  private addPoint(x: number, y: number): number {
    const i = this.coords.length >> 1;
    this.coords.push(x, y);
    return i;
  }

  private addTriangle(a: number, b: number, c: number, ab: number, bc: number, ca: number, e = this.triangles.length): number {
    const t = e / 3;
    this.triangles[e] = a;
    this.triangles[e + 1] = b;
    this.triangles[e + 2] = c;
    this.halfedges[e] = ab;
    this.halfedges[e + 1] = bc;
    this.halfedges[e + 2] = ca;
    if (ab >= 0) this.halfedges[ab] = e;
    if (bc >= 0) this.halfedges[bc] = e + 1;
    if (ca >= 0) this.halfedges[ca] = e + 2;
    this.candidates[2 * t] = 0;
    this.candidates[2 * t + 1] = 0;
    this.queueIndices[t] = -1;
    this.pending[this.pendingLen++] = t;
    return e;
  }

  // Flip until the pair meets the Delaunay condition.
  private legalize(a: number): void {
    const b = this.halfedges[a];
    if (b < 0) return;
    const a0 = a - (a % 3);
    const b0 = b - (b % 3);
    const al = a0 + ((a + 1) % 3);
    const ar = a0 + ((a + 2) % 3);
    const bl = b0 + ((b + 2) % 3);
    const br = b0 + ((b + 1) % 3);
    const p0 = this.triangles[ar];
    const pr = this.triangles[a];
    const pl = this.triangles[al];
    const p1 = this.triangles[bl];
    const c = this.coords;
    if (!inCircle(c[2 * p0], c[2 * p0 + 1], c[2 * pr], c[2 * pr + 1], c[2 * pl], c[2 * pl + 1], c[2 * p1], c[2 * p1 + 1])) return;
    const hal = this.halfedges[al];
    const har = this.halfedges[ar];
    const hbl = this.halfedges[bl];
    const hbr = this.halfedges[br];
    this.queueRemove(a0 / 3);
    this.queueRemove(b0 / 3);
    const t0 = this.addTriangle(p0, p1, pl, -1, hbl, hal, a0);
    const t1 = this.addTriangle(p1, p0, pr, t0, har, hbr, b0);
    this.legalize(t0 + 1);
    this.legalize(t1 + 2);
  }

  // The new point lies on an edge of the triangle.
  private handleCollinear(pn: number, a: number): void {
    const a0 = a - (a % 3);
    const al = a0 + ((a + 1) % 3);
    const ar = a0 + ((a + 2) % 3);
    const p0 = this.triangles[ar];
    const pr = this.triangles[a];
    const pl = this.triangles[al];
    const hal = this.halfedges[al];
    const har = this.halfedges[ar];
    const b = this.halfedges[a];
    if (b < 0) {
      const t0 = this.addTriangle(pn, p0, pr, -1, har, -1, a0);
      const t1 = this.addTriangle(p0, pn, pl, t0, -1, hal);
      this.legalize(t0 + 1);
      this.legalize(t1 + 2);
      return;
    }
    const b0 = b - (b % 3);
    const bl = b0 + ((b + 2) % 3);
    const br = b0 + ((b + 1) % 3);
    const p1 = this.triangles[bl];
    const hbl = this.halfedges[bl];
    const hbr = this.halfedges[br];
    this.queueRemove(b0 / 3);
    const t0 = this.addTriangle(p0, pr, pn, har, -1, -1, a0);
    const t1 = this.addTriangle(pr, p1, pn, hbr, -1, t0 + 1, b0);
    const t2 = this.addTriangle(p1, pl, pn, hbl, -1, t1 + 1);
    const t3 = this.addTriangle(pl, p0, pn, hal, t0 + 2, t2 + 1);
    this.legalize(t0);
    this.legalize(t1);
    this.legalize(t2);
    this.legalize(t3);
  }

  // Max-heap of triangles by error.
  private queuePush(t: number, error: number): void {
    const i = this.queue.length;
    this.queueIndices[t] = i;
    this.queue.push(t);
    this.errors.push(error);
    this.queueUp(i);
  }

  private queuePop(): number {
    const n = this.queue.length - 1;
    this.queueSwap(0, n);
    this.queueDown(0, n);
    return this.queuePopBack();
  }

  private queuePopBack(): number {
    const t = this.queue.pop()!;
    this.errors.pop();
    this.queueIndices[t] = -1;
    return t;
  }

  private queueRemove(t: number): void {
    const i = this.queueIndices[t];
    if (i < 0) {
      const it = this.pending.indexOf(t);
      if (it === -1) throw new Error('Broken triangulation');
      this.pending[it] = this.pending[--this.pendingLen];
      return;
    }
    const n = this.queue.length - 1;
    if (n !== i) {
      this.queueSwap(i, n);
      if (!this.queueDown(i, n)) this.queueUp(i);
    }
    this.queuePopBack();
  }

  private queueLess(i: number, j: number): boolean {
    return this.errors[i] > this.errors[j];
  }

  private queueSwap(i: number, j: number): void {
    const pi = this.queue[i];
    const pj = this.queue[j];
    this.queue[i] = pj;
    this.queue[j] = pi;
    this.queueIndices[pi] = j;
    this.queueIndices[pj] = i;
    const e = this.errors[i];
    this.errors[i] = this.errors[j];
    this.errors[j] = e;
  }

  private queueUp(j0: number): void {
    let j = j0;
    for (;;) {
      const i = (j - 1) >> 1;
      if (i === j || !this.queueLess(j, i)) break;
      this.queueSwap(i, j);
      j = i;
    }
  }

  private queueDown(i0: number, n: number): boolean {
    let i = i0;
    for (;;) {
      const j1 = 2 * i + 1;
      if (j1 >= n || j1 < 0) break;
      const j2 = j1 + 1;
      let j = j1;
      if (j2 < n && this.queueLess(j2, j1)) j = j2;
      if (!this.queueLess(j, i)) break;
      this.queueSwap(i, j);
      i = j;
    }
    return i > i0;
  }
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - cx) * (ay - cy) - (by - cy) * (ax - cx);
}

function inCircle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number): boolean {
  const dx = ax - px;
  const dy = ay - py;
  const ex = bx - px;
  const ey = by - py;
  const fx = cx - px;
  const fy = cy - py;
  const ap = dx * dx + dy * dy;
  const bp = ex * ex + ey * ey;
  const cp = fx * fx + fy * fy;
  return dx * (ey * cp - bp * fy) - dy * (ex * cp - bp * fx) + ap * (ex * fy - ey * fx) < 0;
}
