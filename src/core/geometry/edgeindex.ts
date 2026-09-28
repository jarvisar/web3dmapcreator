// Distance and containment queries against polygon outlines. Edges are
// bucketed on a grid for distance and in horizontal strips for containment,
// so a query only looks at the edges near it, even for a road network with
// tens of thousands of edges.

import type { MultiPolygon } from '../types';

export class EdgeIndex {
  private readonly buckets = new Map<number, number[]>();
  private readonly strips = new Map<number, number[]>();
  private readonly edges: number[] = [];
  private readonly cell: number;

  constructor(polygons: MultiPolygon, cell: number) {
    this.cell = Math.max(cell, 1e-3);
    for (const polygon of polygons) {
      for (const ring of polygon) {
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % ring.length];
          const e = this.edges.length;
          this.edges.push(a[0], a[1], b[0], b[1]);
          const c0 = Math.floor(Math.min(a[0], b[0]) / this.cell);
          const c1 = Math.floor(Math.max(a[0], b[0]) / this.cell);
          const r0 = Math.floor(Math.min(a[1], b[1]) / this.cell);
          const r1 = Math.floor(Math.max(a[1], b[1]) / this.cell);
          for (let r = r0; r <= r1; r++) {
            const strip = this.strips.get(r);
            if (strip) strip.push(e);
            else this.strips.set(r, [e]);
            for (let c = c0; c <= c1; c++) {
              const key = this.key(c, r);
              const list = this.buckets.get(key);
              if (list) list.push(e);
              else this.buckets.set(key, [e]);
            }
          }
        }
      }
    }
  }

  private key(c: number, r: number): number {
    return (c + 1048576) * 2097152 + (r + 1048576);
  }

  get empty(): boolean {
    return this.edges.length === 0;
  }

  /** Winding-number containment using only the edges in the point's strip. */
  contains(x: number, y: number): boolean {
    const strip = this.strips.get(Math.floor(y / this.cell));
    if (!strip) return false;
    let winding = 0;
    for (const e of strip) {
      const x1 = this.edges[e];
      const y1 = this.edges[e + 1];
      const x2 = this.edges[e + 2];
      const y2 = this.edges[e + 3];
      if (y1 <= y) {
        if (y2 > y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) > 0) winding++;
      } else if (y2 <= y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) < 0) {
        winding--;
      }
    }
    return winding !== 0;
  }

  /** Distance to the nearest outline edge, or `limit` when none is that close. */
  distance(x: number, y: number, limit: number): number {
    let best = limit;
    const reach = Math.ceil(limit / this.cell);
    const c = Math.floor(x / this.cell);
    const r = Math.floor(y / this.cell);
    for (let dc = -reach; dc <= reach; dc++) {
      for (let dr = -reach; dr <= reach; dr++) {
        const list = this.buckets.get(this.key(c + dc, r + dr));
        if (!list) continue;
        for (const e of list) {
          const ax = this.edges[e];
          const ay = this.edges[e + 1];
          const dx = this.edges[e + 2] - ax;
          const dy = this.edges[e + 3] - ay;
          const l2 = dx * dx + dy * dy;
          let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
          if (d < best) best = d;
        }
      }
    }
    return best;
  }

  /** Whether a disc of radius r at (x, y) touches the polygons. */
  touches(x: number, y: number, r: number): boolean {
    return this.contains(x, y) || this.distance(x, y, r) < r;
  }
}
