// Filled areas, all through Clipper2.
//
// Fills never overlap. Laser software doesn't reliably honour fill-rule (LightBurn
// fills even-odd across a whole layer), so overlapping rings can cancel out and
// burn as bare wood. Every layer is unioned and the layers are split by priority,
// so each spot is claimed by one fill at most.
//
// Water is cut away around structures. Water and buildings are both dark fills,
// so a building on a pier would merge into the water. The gap around it is what
// makes it readable.
import {
  type Path64,
  type Paths64,
  ClipType,
  Clipper64,
  EndType,
  FillRule,
  JoinType,
  difference,
  inflatePaths,
  intersect,
  union,
} from 'clipper2-ts';
import type { Path, Point } from './lines/geometry';
import { fmt } from './svg/format';

// Clipper works on integers. 1 unit = 1 micron.
export const SCALE = 1000;

export function toPath64(ring: readonly Point[]): Path64 {
  return ring.map(([x, y]) => ({ x: Math.round(x * SCALE), y: Math.round(y * SCALE) }));
}

export function fromPath64(path: Path64): Path {
  return path.map((p) => [p.x / SCALE, p.y / SCALE]);
}

export const unionAll = (paths: Paths64): Paths64 => (paths.length ? union(paths, FillRule.NonZero) : []);
export const subtract = (a: Paths64, b: Paths64): Paths64 =>
  a.length === 0 ? [] : b.length === 0 ? a : difference(a, b, FillRule.NonZero);
export const intersectWith = (a: Paths64, b: Paths64): Paths64 =>
  a.length === 0 || b.length === 0 ? [] : intersect(a, b, FillRule.NonZero);

export function dilate(paths: Paths64, mm: number): Paths64 {
  if (paths.length === 0 || mm <= 0) return paths;
  const delta = mm * SCALE;
  // Arc tolerance of 1% of the offset keeps small halos from having lots of vertices.
  return inflatePaths(paths, delta, JoinType.Round, EndType.Polygon, 2, Math.max(1, delta * 0.01));
}

export function bufferLines(lines: readonly Path[], halfWidth: number, roundEnds = false): Paths64 {
  if (lines.length === 0 || halfWidth <= 0) return [];
  const delta = halfWidth * SCALE;
  return inflatePaths(
    lines.map(toPath64),
    delta,
    JoinType.Round,
    roundEnds ? EndType.Round : EndType.Butt,
    2,
    Math.max(1, delta * 0.01),
  );
}

export function linesOutside(lines: readonly Path[], areas: Paths64): Path[] {
  if (lines.length === 0 || areas.length === 0) return [...lines];
  const clipper = new Clipper64();
  clipper.addOpenSubject(lines.map(toPath64));
  clipper.addClip(areas);
  const closed: Paths64 = [];
  const open: Paths64 = [];
  clipper.execute(ClipType.Difference, FillRule.NonZero, closed, open);
  return open.map(fromPath64).filter((p) => p.length >= 2);
}

export function areaMm2(paths: Paths64): number {
  let total = 0;
  for (const path of paths) {
    let a = 0;
    for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
      a += path[j].x * path[i].y - path[i].x * path[j].y;
    }
    total += a / 2;
  }
  return total / (SCALE * SCALE);
}

export function pathsD(paths: Paths64): string {
  const parts: string[] = [];
  for (const path of paths) {
    if (path.length < 3) continue;
    let d = `M${fmt(path[0].x / SCALE)},${fmt(path[0].y / SCALE)}`;
    for (let i = 1; i < path.length; i++) d += `L${fmt(path[i].x / SCALE)},${fmt(path[i].y / SCALE)}`;
    parts.push(d + 'Z');
  }
  return parts.join('');
}

export interface SurfaceInputs {
  buildings: Paths64;
  decks: Paths64;
  water: Paths64;
  aeroways: Paths64;
  rocks: Paths64;
  sand: Paths64;
  greens: Paths64;
  // Cut out of the water only, like the gaps under bridges.
  waterGaps: Paths64;
}

export interface SurfaceOptions {
  // Gap around structures standing in water, mm. 0 turns it off.
  waterHalo: number;
}

export type SurfaceOutputs = Omit<SurfaceInputs, 'waterGaps'>;

// Priority: buildings, decks, water, runways, rock, sand, greens. Layers come in
// unioned and each one loses what the ones above it already claimed.
export function resolveSurfaces(input: SurfaceInputs, options: SurfaceOptions): SurfaceOutputs {
  const { buildings, decks } = input;
  const structures = unionAll([...buildings, ...decks]);
  let water = input.water;

  if (water.length > 0 && structures.length > 0 && options.waterHalo > 0) {
    // Only structures within one halo of the water matter, and offsetting just
    // those is much cheaper than every building downtown.
    const nearWater = intersectWith(structures, dilate(water, options.waterHalo));
    if (nearWater.length > 0) water = subtract(water, dilate(nearWater, options.waterHalo));
  }
  water = subtract(water, structures);
  if (input.waterGaps.length > 0) water = subtract(water, input.waterGaps);

  // Each claimed layer is disjoint from what is already occupied, so concatenating
  // works as a clip set without another union.
  let occupied: Paths64 = [...structures, ...water];
  const claim = (layer: Paths64) => {
    const visible = subtract(layer, occupied);
    if (visible.length > 0) occupied = occupied.concat(visible);
    return visible;
  };
  const aeroways = claim(input.aeroways);
  const rocks = claim(input.rocks);
  const sand = claim(input.sand);
  const greens = claim(input.greens);
  return { buildings, decks: subtract(decks, buildings), water, aeroways, rocks, sand, greens };
}

// Is this point already burnt solid by a fill? Used by dense-patch thinning.
// Non-zero winding, so a courtyard counts as unburnt.
export function makeFillTester(layers: readonly Paths64[]): ((p: Point) => boolean) | null {
  const edges: [number, number, number, number][] = [];
  for (const paths of layers) {
    for (const path of paths) {
      for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
        const a = path[j];
        const b = path[i];
        if (a.x === b.x && a.y === b.y) continue;
        edges.push([a.x / SCALE, a.y / SCALE, b.x / SCALE, b.y / SCALE]);
      }
    }
  }
  if (edges.length === 0) return null;
  let lowest = Infinity;
  let highest = -Infinity;
  for (const [, y0, , y1] of edges) {
    lowest = Math.min(lowest, y0, y1);
    highest = Math.max(highest, y0, y1);
  }
  const rows = Math.max(64, Math.min(4096, Math.floor(edges.length / 8)));
  const scale = rows / Math.max(highest - lowest, 1e-12);
  const buckets: number[][] = Array.from({ length: rows + 1 }, () => []);
  edges.forEach(([, y0, , y1], index) => {
    const first = Math.max(0, Math.min(rows, Math.floor((Math.min(y0, y1) - lowest) * scale)));
    const last = Math.max(0, Math.min(rows, Math.floor((Math.max(y0, y1) - lowest) * scale)));
    for (let row = first; row <= last; row++) buckets[row].push(index);
  });
  return ([x, y]: Point) => {
    if (y < lowest || y > highest) return false;
    let winding = 0;
    for (const index of buckets[Math.max(0, Math.min(rows, Math.floor((y - lowest) * scale)))]) {
      const [x0, y0, x1, y1] = edges[index];
      // Half-open in y so a vertex is only counted once.
      if (y0 <= y) {
        if (y1 > y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) > 0) winding++;
      } else if (y1 <= y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) < 0) {
        winding--;
      }
    }
    return winding !== 0;
  };
}
