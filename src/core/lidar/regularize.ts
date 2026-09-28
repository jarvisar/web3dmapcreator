// Tidying a roof raster before it is triangulated. Not in the add-on.
//
// The roof is first split into planes by region growing, much like roofer
// (3D BAG) does on points: a cell joins a plane when it lies within `distance`
// of it and the slope of the 3 x 3 cells around it is within `angle` of the
// plane's. A second, looser pass takes in rough roofs. Near-level planes are
// made exactly level.
//
// Then every cell is given one of the planes around it, or none, which keeps
// its own height. The choice weighs how far each cell moves against how much
// boundary there is between labels. A square bump d cells across and h metres
// tall gives way when d * h < feature * layer, so with the caller's printed
// sizes anything under about one feature across and one layer tall goes:
// rooftop plant, parapets, chimneys, vents, slivers along a step, and seams
// between planes that nearly agree. A pit narrower than a feature goes however
// deep it is. Steps and ridges end up where the planes meet. A flat roof
// slices into one clean top layer instead of a speckle of part-layers, and a
// pitched roof keeps straight ridges and hips instead of a crumple of facets.
// Spires, and a cell around them, are never touched.

export interface RegularizeOptions {
  /** Furthest a cell may lie from a plane it joins, in metres. */
  distance: number;
  /** Largest angle between a cell's slope and its plane's, in degrees. */
  angle: number;
  /** Rise over run under which a plane is made level. */
  level: number;
  /** Fewest cells in a plane. */
  minCells: number;
}

export const DEFAULT_REGULARIZE: RegularizeOptions = { distance: 0.3, angle: 25, level: 0.05, minCells: 12 };

/** z = a (i - i0) + b (j - j0) + d, in cells along i and j. */
type Plane = [a: number, b: number, d: number, i0: number, j0: number];

interface Sums {
  n: number;
  u: number;
  v: number;
  z: number;
  uu: number;
  vv: number;
  uv: number;
  uz: number;
  vz: number;
}

// Rise over run of 75 degrees.
const MAX_SLOPE = 3.73;

const FOUR: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * `heights[i * ny + j]` at `pitch` metres, `feature` in cells and `layer` in
 * metres. Only cells in `mask` and not in `keep` change.
 */
export function regularize(
  heights: Float64Array,
  nx: number,
  ny: number,
  pitch: number,
  feature: number,
  layer: number,
  keep: Uint8Array,
  mask: Uint8Array,
  options: RegularizeOptions = DEFAULT_REGULARIZE,
): Float64Array {
  const size = nx * ny;
  const kept = dilate(keep, nx, ny);
  const free = (c: number) => kept[c] === 0 && mask[c] === 1;

  // Slope and roughness of each cell's 3 x 3 neighbourhood.
  const gx = new Float64Array(size);
  const gy = new Float64Array(size);
  const rough = new Float64Array(size).fill(Infinity);
  const cells: number[] = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const c = i * ny + j;
      if (!free(c)) continue;
      cells.length = 0;
      for (let a = Math.max(0, i - 1); a <= Math.min(nx - 1, i + 1); a++) for (let b = Math.max(0, j - 1); b <= Math.min(ny - 1, j + 1); b++) if (!kept[a * ny + b]) cells.push(a * ny + b);
      const plane = fit(heights, cells, ny, i, j);
      if (!plane) continue;
      gx[c] = plane[0] / pitch;
      gy[c] = plane[1] / pitch;
      rough[c] = rms(heights, cells, ny, plane);
    }
  }
  // Grow planes from the smoothest cells out. Each round refits the plane and
  // looks again at every cell next to it, so an early, rough fit from the seed's
  // few cells can't stop a face short.
  const grown = new Int32Array(size).fill(-1);
  const planes: Plane[] = [];
  const grow = (distance: number, angle: number) => {
    const cosLimit = Math.cos((angle * Math.PI) / 180);
    // Within the distance of the plane, measured square to it, and sloping the same way.
    const fits = (k: number, plane: Plane) => {
      const ax = plane[0] / pitch;
      const ay = plane[1] / pitch;
      const norm = ax * ax + ay * ay + 1;
      if (Math.abs(heights[k] - at(plane, k, ny)) > distance * Math.sqrt(norm)) return false;
      return (ax * gx[k] + ay * gy[k] + 1) / Math.sqrt(norm * (gx[k] * gx[k] + gy[k] * gy[k] + 1)) >= cosLimit;
    };
    const order: number[] = [];
    for (let c = 0; c < size; c++) if (grown[c] < 0 && rough[c] <= distance / 2) order.push(c);
    order.sort((p, q) => rough[p] - rough[q]);
    const tried = new Uint8Array(size);
    for (const seed of order) {
      if (grown[seed] >= 0 || tried[seed]) continue;
      const id = planes.length;
      const si = Math.floor(seed / ny);
      const sj = seed % ny;
      let plane: Plane = [gx[seed] * pitch, gy[seed] * pitch, heights[seed], si, sj];
      const members = [seed];
      const sums = emptySums();
      add(sums, heights, seed, ny, si, sj);
      grown[seed] = id;
      for (let round = 0; round < 8; round++) {
        const before = members.length;
        let refit = Math.max(8, Math.ceil(members.length * 1.5));
        for (let q = 0; q < members.length; q++) {
          const c = members[q];
          const i = Math.floor(c / ny);
          const j = c % ny;
          for (const [di, dj] of FOUR) {
            const a = i + di;
            const b = j + dj;
            if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
            const k = a * ny + b;
            if (grown[k] >= 0 || !free(k) || !(rough[k] < Infinity) || !fits(k, plane)) continue;
            grown[k] = id;
            members.push(k);
            add(sums, heights, k, ny, si, sj);
            if (members.length >= refit) {
              plane = solve(sums, si, sj) ?? plane;
              refit = Math.ceil(members.length * 1.5);
            }
          }
        }
        plane = solve(sums, si, sj) ?? plane;
        if (members.length === before) break;
      }
      let final = members.length >= options.minCells ? solve(sums, si, sj) : null;
      // Anything steeper is a wall, which is a step between planes, not a plane.
      if (final && Math.hypot(final[0], final[1]) / pitch > MAX_SLOPE) final = null;
      if (!final) {
        for (const c of members) {
          grown[c] = -1;
          tried[c] = 1;
        }
        continue;
      }
      if (Math.hypot(final[0], final[1]) / pitch <= options.level) {
        let z = 0;
        for (const c of members) z += heights[c];
        planes.push([0, 0, z / members.length, 0, 0]);
      } else planes.push(final);
    }
  };
  grow(options.distance, options.angle);
  // Then once more, looser, over what's left, and whatever way the cells slope.
  // A rough roof (plant all over it, a lattice of rails) is still one plane
  // within half a layer, and a dome becomes a few facets instead of its scan
  // noise.
  grow(layer / 2, 90);

  // Labels: a plane, `none` to keep the cell's own height, -1 for cells that don't change.
  const none = planes.length;
  const edge = (feature * layer) / 4;
  // How far a cell moves onto a plane, square to it, so a cell on a steep face
  // counts how far across it is out. Keeping a cell as measured costs half a
  // layer: a plane nearer than that is always the better choice. Raising a cell
  // costs at most a layer, however deep it sat: a pit narrower than a feature
  // closes up in the slicer anyway, so it goes whatever its depth (a light well,
  // the gaps in a lattice crown).
  const square = planes.map(([a, b]) => 1 / Math.sqrt(1 + (a * a + b * b) / (pitch * pitch)));
  const cost = (c: number, l: number) => {
    if (l === none) return layer / 2;
    const rise = (at(planes[l], c, ny) - heights[c]) * square[l];
    return rise > 0 ? Math.min(rise, layer) : -rise;
  };
  const label = new Int32Array(size).fill(-1);
  const r = Math.max(1, Math.ceil(feature / 2));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const c = i * ny + j;
      if (!free(c)) continue;
      if (grown[c] >= 0) {
        label[c] = grown[c];
        continue;
      }
      let pick = none;
      let best = cost(c, none);
      for (let a = Math.max(0, i - r); a <= Math.min(nx - 1, i + r); a++) {
        for (let b = Math.max(0, j - r); b <= Math.min(ny - 1, j + r); b++) {
          const id = grown[a * ny + b];
          if (id >= 0 && id !== pick && cost(c, id) < best) {
            best = cost(c, id);
            pick = id;
          }
        }
      }
      label[c] = pick;
    }
  }

  // One cell at a time: how far it moves plus `edge` for each neighbour labelled differently.
  const around = new Int32Array(4);
  const relabelCells = () => {
    let changed = 0;
    for (let c = 0; c < size; c++) {
      const own = label[c];
      if (own < 0) continue;
      const i = Math.floor(c / ny);
      const j = c - i * ny;
      let n = 0;
      if (i > 0 && label[c - ny] >= 0) around[n++] = label[c - ny];
      if (i < nx - 1 && label[c + ny] >= 0) around[n++] = label[c + ny];
      if (j > 0 && label[c - 1] >= 0) around[n++] = label[c - 1];
      if (j < ny - 1 && label[c + 1] >= 0) around[n++] = label[c + 1];
      let pick = own;
      let best = Infinity;
      for (let k = -1; k < n; k++) {
        const l = k < 0 ? own : around[k];
        if (k >= 0 && (l === own || around.indexOf(l) < k)) continue;
        let e = cost(c, l);
        for (let q = 0; q < n; q++) if (around[q] !== l) e += edge;
        if (e < best - 1e-9) {
          best = e;
          pick = l;
        }
      }
      if (pick !== own) {
        label[c] = pick;
        changed++;
      }
    }
    return changed;
  };

  // A whole patch at a time, which single cells can't do for anything wider
  // than a cell or two. A patch is a connected run of one label, split where an
  // opening with a square half a feature across would cut it, so a thin arm of
  // a plane can go on its own.
  const t = Math.max(1, Math.floor(feature / 4));
  const core = new Uint8Array(size);
  const opened = new Uint8Array(size);
  const patch = new Int32Array(size);
  const relabelPatches = () => {
    core.fill(0);
    opened.fill(0);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const c = i * ny + j;
        if (label[c] < 0) continue;
        let inside = true;
        for (let a = i - t; a <= i + t && inside; a++) {
          for (let b = j - t; b <= j + t && inside; b++) {
            if (a >= 0 && b >= 0 && a < nx && b < ny && label[a * ny + b] >= 0 && label[a * ny + b] !== label[c]) inside = false;
          }
        }
        if (inside) core[c] = 1;
      }
    }
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const c = i * ny + j;
        if (label[c] < 0) continue;
        for (let a = Math.max(0, i - t); a <= Math.min(nx - 1, i + t) && !opened[c]; a++) {
          for (let b = Math.max(0, j - t); b <= Math.min(ny - 1, j + t); b++) {
            if (core[a * ny + b] && label[a * ny + b] === label[c]) {
              opened[c] = 1;
              break;
            }
          }
        }
      }
    }
    patch.fill(-1);
    const runs: number[][] = [];
    for (let start = 0; start < size; start++) {
      if (label[start] < 0 || patch[start] >= 0) continue;
      const run = [start];
      patch[start] = runs.length;
      for (let q = 0; q < run.length; q++) {
        const c = run[q];
        const i = Math.floor(c / ny);
        const j = c % ny;
        for (const [di, dj] of FOUR) {
          const a = i + di;
          const b = j + dj;
          const k = a * ny + b;
          if (a < 0 || b < 0 || a >= nx || b >= ny || patch[k] >= 0 || label[k] !== label[c] || opened[k] !== opened[c]) continue;
          patch[k] = runs.length;
          run.push(k);
        }
      }
      runs.push(run);
    }
    let changed = 0;
    const order = runs.map((_, id) => id).sort((p, q) => runs[p].length - runs[q].length);
    const next: number[] = [];
    const counts: number[] = [];
    for (const id of order) {
      const run = runs[id];
      const own = label[run[0]];
      // Edges from the patch to each label around it, its own included.
      next.length = 0;
      counts.length = 0;
      for (const c of run) {
        const i = Math.floor(c / ny);
        const j = c % ny;
        for (const [di, dj] of FOUR) {
          const a = i + di;
          const b = j + dj;
          const k = a * ny + b;
          if (a < 0 || b < 0 || a >= nx || b >= ny || label[k] < 0 || patch[k] === id) continue;
          const slot = next.indexOf(label[k]);
          if (slot < 0) {
            next.push(label[k]);
            counts.push(1);
          } else counts[slot]++;
        }
      }
      const inward = counts[next.indexOf(own)] ?? 0;
      let stay = 0;
      for (const c of run) stay += cost(c, own);
      let pick = own;
      let best = 0;
      for (let q = 0; q < next.length; q++) {
        const l = next[q];
        if (l === own) continue;
        let move = -stay - edge * counts[q] + edge * inward;
        for (let k = 0; k < run.length && move < best; k++) move += cost(run[k], l);
        if (move < best - 1e-9) {
          best = move;
          pick = l;
        }
      }
      if (pick === own) continue;
      for (const c of run) {
        label[c] = pick;
        patch[c] = -2;
      }
      changed += run.length;
    }
    return changed;
  };

  // Each move only lowers the total, so this settles. The last rounds move a
  // handful of cells, so it stops once a round moves fewer than 1 in 2,000.
  let labelled = 0;
  for (let c = 0; c < size; c++) if (label[c] >= 0) labelled++;
  for (let round = 0; round < 12; round++) {
    let changed = 0;
    for (let sweep = 0; sweep < 6; sweep++) {
      const n = relabelCells();
      changed += n;
      if (n * 2000 < labelled) break;
    }
    changed += relabelPatches();
    if (changed * 2000 < labelled) break;
  }

  // A plane carried past the cells it came from never goes above or below what was measured.
  let low = Infinity;
  let high = -Infinity;
  for (let c = 0; c < size; c++) {
    if (label[c] < 0) continue;
    low = Math.min(low, heights[c]);
    high = Math.max(high, heights[c]);
  }
  const out = Float64Array.from(heights);
  for (let c = 0; c < size; c++) if (label[c] >= 0 && label[c] !== none) out[c] = Math.min(high, Math.max(low, at(planes[label[c]], c, ny)));
  return out;
}

function emptySums(): Sums {
  return { n: 0, u: 0, v: 0, z: 0, uu: 0, vv: 0, uv: 0, uz: 0, vz: 0 };
}

function add(s: Sums, heights: Float64Array, c: number, ny: number, i0: number, j0: number): void {
  const u = Math.floor(c / ny) - i0;
  const v = (c % ny) - j0;
  const z = heights[c];
  s.n++;
  s.u += u;
  s.v += v;
  s.z += z;
  s.uu += u * u;
  s.vv += v * v;
  s.uv += u * v;
  s.uz += u * z;
  s.vz += v * z;
}

/** Least-squares plane, if the cells spread in two directions. A strip a cell or two thick has no plane to speak of. */
function solve(s: Sums, i0: number, j0: number): Plane | null {
  const { n } = s;
  const mu = s.u / n;
  const mv = s.v / n;
  const mz = s.z / n;
  const cuu = s.uu - n * mu * mu;
  const cvv = s.vv - n * mv * mv;
  const cuv = s.uv - n * mu * mv;
  const cuz = s.uz - n * mu * mz;
  const cvz = s.vz - n * mv * mz;
  const spread = (cuu + cvv - Math.sqrt((cuu - cvv) ** 2 + 4 * cuv * cuv)) / 2 / n;
  if (!(spread >= 0.5)) return null;
  const det = cuu * cvv - cuv * cuv;
  const a = (cuz * cvv - cvz * cuv) / det;
  const b = (cvz * cuu - cuz * cuv) / det;
  return [a, b, mz - a * mu - b * mv, i0, j0];
}

function fit(heights: Float64Array, cells: number[], ny: number, i0: number, j0: number): Plane | null {
  if (cells.length < 6) return null;
  const s = emptySums();
  for (const c of cells) add(s, heights, c, ny, i0, j0);
  return solve(s, i0, j0);
}

function rms(heights: Float64Array, cells: number[], ny: number, plane: Plane): number {
  let squares = 0;
  for (const c of cells) squares += (heights[c] - at(plane, c, ny)) ** 2;
  return Math.sqrt(squares / cells.length);
}

function at(plane: Plane, c: number, ny: number): number {
  return plane[0] * (Math.floor(c / ny) - plane[3]) + plane[1] * ((c % ny) - plane[4]) + plane[2];
}

function dilate(mask: Uint8Array, nx: number, ny: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (!mask[i * ny + j]) continue;
      for (let a = Math.max(0, i - 1); a <= Math.min(nx - 1, i + 1); a++) for (let b = Math.max(0, j - 1); b <= Math.min(ny - 1, j + 1); b++) out[a * ny + b] = 1;
    }
  }
  return out;
}
