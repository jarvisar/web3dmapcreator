// Cyrus-Beck clipping. Every window shape and label box is convex, so this
// covers both keeping lines inside the map and cutting them out under a label.
import type { Path, Point } from '../lines/geometry';

interface Edge {
  px: number;
  py: number;
  nx: number;
  ny: number;
}

function inwardEdges(poly: readonly Point[]): Edge[] {
  let area2 = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    area2 += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  const sign = area2 >= 0 ? 1 : -1;
  const edges: Edge[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    if (dx === 0 && dy === 0) continue;
    // With positive winding the inside is on the left.
    edges.push({ px: a[0], py: a[1], nx: -dy * sign, ny: dx * sign });
  }
  return edges;
}

function insideInterval(a: Point, b: Point, edges: Edge[]): [number, number] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let tE = 0;
  let tL = 1;
  for (const e of edges) {
    const num = e.nx * (a[0] - e.px) + e.ny * (a[1] - e.py);
    const den = e.nx * dx + e.ny * dy;
    if (den === 0) {
      if (num < 0) return null;
      continue;
    }
    const t = -num / den;
    if (den > 0) {
      if (t > tE) tE = t;
    } else if (t < tL) {
      tL = t;
    }
    if (tE > tL) return null;
  }
  return [tE, tL];
}

const lerp = (a: Point, b: Point, t: number): Point =>
  t <= 0 ? [a[0], a[1]] : t >= 1 ? [b[0], b[1]] : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

class PieceBuilder {
  readonly pieces: Path[] = [];
  private current: Path = [];

  add(start: Point, end: Point): void {
    if (start[0] === end[0] && start[1] === end[1]) return;
    const last = this.current[this.current.length - 1];
    if (last && last[0] === start[0] && last[1] === start[1]) {
      this.current.push(end);
    } else {
      this.flush();
      this.current = [start, end];
    }
  }

  flush(): void {
    if (this.current.length >= 2) this.pieces.push(this.current);
    this.current = [];
  }
}

export function clipPolylineInside(path: readonly Point[], poly: readonly Point[]): Path[] {
  const edges = inwardEdges(poly);
  const out = new PieceBuilder();
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const span = insideInterval(a, b, edges);
    if (span === null) {
      out.flush();
      continue;
    }
    out.add(lerp(a, b, span[0]), lerp(a, b, span[1]));
    if (span[1] < 1) out.flush();
  }
  out.flush();
  return out.pieces;
}

export function clipPolylineOutside(path: readonly Point[], poly: readonly Point[]): Path[] {
  const edges = inwardEdges(poly);
  const out = new PieceBuilder();
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const span = insideInterval(a, b, edges);
    if (span === null || span[0] >= span[1]) {
      out.add([a[0], a[1]], [b[0], b[1]]);
      continue;
    }
    if (span[0] > 0) out.add([a[0], a[1]], lerp(a, b, span[0]));
    out.flush();
    if (span[1] < 1) out.add(lerp(a, b, span[1]), [b[0], b[1]]);
  }
  out.flush();
  return out.pieces;
}

// [minX, minY, maxX, maxY]
export function bboxOf(points: readonly Point[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}
