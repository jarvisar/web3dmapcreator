import { describe, expect, it } from 'vitest';
import { NumpyRandom } from '../lidar/test-helpers';
import { compose, cutWater, narrow, STEP_M, type ComposeSettings } from './compose';
import { despike, fairFaces, fillSmooth, fillVoids, label, straighten } from './filters';
import { emptyLayers, type SurfaceLayers } from './layers';

const CELL = 0.5;
const GROUND = 10;

// numpy's normal() uses a ziggurat, so these are Box-Muller normals from the
// same PCG64 stream. The noise isn't the add-on's but has the same spread.
function normals(seed: number, count: number, mean: number, spread: number): Float64Array {
  const rng = new NumpyRandom(seed);
  const out = new Float64Array(count);
  for (let k = 0; k < count; k++) {
    const u = 1 - rng.random();
    const v = rng.random();
    out[k] = mean + spread * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  return out;
}

/** Open, flat, unclassified ground. */
function blank(ny: number, nx: number, height = GROUND): SurfaceLayers {
  const layers = emptyLayers(nx, ny);
  layers.top.fill(height);
  layers.solid.fill(height);
  layers.ground.fill(height);
  layers.count.fill(6);
  return layers;
}

/** a[r0:r1, c0:c1] = value, with numpy's slice bounds. */
function fill(a: { [i: number]: number }, nx: number, r0: number, r1: number, c0: number, c1: number, value: number): void {
  for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) a[r * nx + c] = value;
}

function shape(nx: number, ny: number, inside: (row: number, col: number) => boolean): Uint8Array {
  const mask = new Uint8Array(nx * ny);
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) mask[r * nx + c] = inside(r, c) ? 1 : 0;
  return mask;
}

const disc = (nx: number, ny: number, row: number, col: number, r2: number) =>
  shape(nx, ny, (r, c) => (r - row) ** 2 + (c - col) ** 2 <= r2);

/** a[mask] = values, in cell order. */
function put(a: { [i: number]: number }, mask: Uint8Array, values: ArrayLike<number> | number): void {
  for (let i = 0, k = 0; i < mask.length; i++) if (mask[i]) a[i] = typeof values === 'number' ? values : values[k++];
}

const cells = (mask: Uint8Array) => mask.reduce((sum, v) => sum + v, 0);

/** 80 x 80 cells: a tower, a tree, a car, a lamp post and a river along the south edge. */
function city(): { layers: SurfaceLayers; crown: Uint8Array } {
  const nx = 80;
  const layers = blank(80, nx);
  fill(layers.top, nx, 20, 40, 20, 45, GROUND + 30);
  fill(layers.solid, nx, 20, 40, 20, 45, GROUND + 30);
  fill(layers.ground, nx, 20, 40, 20, 45, NaN);
  const crown = disc(nx, 80, 60, 60, 36);
  put(layers.top, crown, normals(1, cells(crown), GROUND + 8, 1.5));
  put(layers.vegetation, crown, 6);
  fill(layers.top, nx, 10, 12, 58, 62, GROUND + 1.5); // a car
  layers.top[65 * nx + 20] = GROUND + 9; // a lamp post
  // The river returned little, all of it filed as water.
  for (const layer of [layers.count, layers.water]) fill(layer, nx, 0, 8, 0, nx, 1);
  for (const layer of [layers.top, layers.solid, layers.waterZ]) fill(layer, nx, 0, 8, 0, nx, GROUND - 1.5);
  fill(layers.ground, nx, 0, 8, 0, nx, NaN);
  return { layers, crown };
}

function composeCity(settings: Partial<ComposeSettings> = {}) {
  const { layers, crown } = city();
  return { result: compose(layers, CELL, CELL, 1, 1, { baseMm: 2, waterDepthMm: 1, ...settings }), crown };
}

const at = (a: ArrayLike<number>, nx: number, row: number, col: number) => a[row * nx + col];

describe('compose', () => {
  it('tower street and base', () => {
    const h = composeCity().result.heights;
    const street = at(h, 80, 50, 5);
    expect(Math.abs(at(h, 80, 30, 30) - street - 30)).toBeLessThanOrEqual(0.1);
    expect(Math.min(...h)).toBeCloseTo(2, 7);
    expect(h.every((v) => v >= 2 - 1e-9)).toBe(true);
  });

  it('car and lamp post go', () => {
    const h = composeCity().result.heights;
    const street = at(h, 80, 50, 5);
    expect(Math.abs(at(h, 80, 10, 59) - street)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(at(h, 80, 65, 20) - street)).toBeLessThanOrEqual(0.05);
    const kept = composeCity({ removeClutter: false }).result.heights;
    expect(at(kept, 80, 10, 59) - at(kept, 80, 50, 5)).toBeGreaterThan(1);
  });

  it('river is flat and recessed', () => {
    const { result } = composeCity();
    const river = result.heights.subarray(0, 8 * 80);
    expect(result.water.subarray(0, 8 * 80).every((v) => v === 1)).toBe(true);
    expect(result.water.subarray(8 * 80).some((v) => v)).toBe(false);
    expect(Math.max(...river) - Math.min(...river)).toBeCloseTo(0, 7);
    // 1.5 m below the bank, then recessed 1 mm.
    expect(Math.abs(at(result.heights, 80, 50, 5) - Math.max(...river) - 2.5)).toBeLessThanOrEqual(0.01);
    expect(result.counts.water_bodies).toBe(1);
  });

  it('tree is a dome', () => {
    const { result, crown } = composeCity();
    const h = result.heights;
    const street = at(h, 80, 50, 5);
    expect(result.counts.tree_cells).toBeGreaterThan(50);
    expect(at(h, 80, 60, 60) - street).toBeGreaterThan(5);
    // Rounded: the crown top is higher than its rim, and the rim slopes down to the street.
    expect(at(h, 80, 60, 60)).toBeGreaterThan(at(h, 80, 60, 65) + 1);
    expect(at(h, 80, 60, 68)).toBeGreaterThan(street);
    for (let i = 0; i < crown.length; i++) if (crown[i]) expect(result.detail[i]).toBeLessThan(1);
    const removed = composeCity({ keepTrees: false }).result.heights;
    expect(Math.abs(at(removed, 80, 60, 60) - at(removed, 80, 50, 5))).toBeLessThanOrEqual(0.05);
  });

  it('removed trees leave ordinary ground, with what stood under them cleared', () => {
    // A bench under the crown shows through once the canopy goes.
    const withBench = () => {
      const { layers, crown } = city();
      fill(layers.solid, 80, 60, 62, 60, 62, GROUND + 1.5);
      return { layers, crown };
    };
    const { layers, crown } = withBench();
    const result = compose(layers, CELL, CELL, 1, 1, { keepTrees: false });
    const h = result.heights;
    expect(Math.abs(at(h, 80, 60, 60) - at(h, 80, 50, 5))).toBeLessThanOrEqual(0.05);
    for (let i = 0; i < crown.length; i++) if (crown[i]) expect(result.detail[i]).toBe(1);
    const kept = compose(withBench().layers, CELL, CELL, 1, 1, { keepTrees: false, removeClutter: false });
    expect(at(kept.heights, 80, 60, 60) - at(kept.heights, 80, 50, 5)).toBeCloseTo(1.5, 1);
  });

  it('height scale and exaggeration', () => {
    const h = composeCity({ heightScale: 2 }).result.heights;
    expect(Math.abs(at(h, 80, 30, 30) - at(h, 80, 50, 5) - 60)).toBeLessThanOrEqual(0.2);
  });

  // Not in the add-on: the area shape can leave low cells out of the base.
  it('cells outside the area shape leave the base alone', () => {
    const whole = composeCity().result;
    expect(whole.groundMaxMm).toBeCloseTo(at(whole.heights, 80, 50, 5), 6);
    const { layers } = city();
    const inside = shape(80, 80, (r) => r >= 8);
    const result = compose(layers, CELL, CELL, 1, 1, { baseMm: 2, waterDepthMm: 1 }, inside);
    // Without the river the street sits on the base.
    expect(at(result.heights, 80, 50, 5)).toBeCloseTo(2, 6);
    expect(result.groundMaxMm).toBeCloseTo(2, 6);
  });
});

const trees = (layers: SurfaceLayers) => compose(layers, CELL, CELL, 1, 1).detail.map((v) => (v < 1 ? 1 : 0));

const share = (found: ArrayLike<number>, mask: Uint8Array) => {
  let hit = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] && found[i]) hit++;
  return hit / cells(mask);
};

describe('trees', () => {
  it('unclassified crowns must show the ground', () => {
    // Philadelphia 2015: only ground and the rest. A crown there returns
    // once, an ornate roof returns twice, and only the crown has ground under it.
    const [nx, ny] = [110, 60];
    const layers = blank(ny, nx);
    const crown = disc(nx, ny, 30, 25, 64);
    put(layers.top, crown, normals(2, cells(crown), GROUND + 10, 1.5));
    const roof = shape(nx, ny, (r, c) => r >= 15 && r < 45 && c >= 60 && c < 95);
    put(layers.top, roof, normals(3, cells(roof), GROUND + 12, 1.5));
    put(layers.vegetation, roof, 6);
    put(layers.ground, roof, NaN);
    const found = trees(layers);
    expect(share(found, crown)).toBeGreaterThan(0.8);
    expect(share(found, roof)).toBe(0);
  });

  it('rail deck touching a tree stays a deck', () => {
    // Cook County files a fifth of the L's returns as vegetation and the
    // street shows through its ties. Touching a crown, it used to join the
    // crown's blob, which then passed or failed as one.
    const [nx, ny] = [120, 70];
    const layers = blank(ny, nx);
    fill(layers.top, nx, 0, 8, 0, nx, GROUND + 20);
    fill(layers.solid, nx, 0, 8, 0, nx, GROUND + 20);
    fill(layers.building, nx, 0, 8, 0, nx, 6);
    fill(layers.ground, nx, 0, 8, 0, nx, NaN);
    fill(layers.top, nx, 30, 44, 0, nx, GROUND + 7);
    for (let c = 0; c < nx; c += 2) fill(layers.solid, nx, 30, 44, c, c + 1, NaN);
    fill(layers.vegetation, nx, 30, 44, 0, nx, 2);
    const crown = disc(nx, ny, 50, 60, 64);
    put(layers.top, crown, normals(5, cells(crown), GROUND + 12, 1.5));
    put(layers.solid, crown, NaN);
    put(layers.vegetation, crown, 6);
    const found = trees(layers);
    expect(share(found, crown)).toBeGreaterThan(0.8);
    expect(share(found, shape(nx, ny, (r, c) => r >= 32 && r < 42 && c < 40))).toBe(0);
    expect(share(found, shape(nx, ny, (r, c) => r >= 32 && r < 42 && c >= 80))).toBe(0);
  });

  it('roof garden stays on its roof', () => {
    const nx = 90;
    const layers = blank(90, nx);
    fill(layers.top, nx, 10, 80, 10, 80, GROUND + 20);
    fill(layers.solid, nx, 10, 80, 10, 80, GROUND + 20);
    fill(layers.building, nx, 10, 80, 10, 80, 6);
    fill(layers.ground, nx, 10, 80, 10, 80, NaN);
    const crown = disc(nx, 90, 45, 45, 100);
    put(layers.top, crown, normals(6, cells(crown), GROUND + 24, 3));
    put(layers.solid, crown, NaN);
    put(layers.building, crown, 0);
    put(layers.vegetation, crown, 6);
    const result = compose(layers, CELL, CELL, 1, 1);
    const h = result.heights;
    const roof = at(h, nx, 20, 20);
    expect(share(result.detail.map((v) => (v < 1 ? 1 : 0)), crown)).toBeGreaterThan(0.8);
    // Smoothed against the street 20 m below, its edge used to sink into a trench.
    let lowest = Infinity;
    for (let i = 0; i < crown.length; i++) if (crown[i]) lowest = Math.min(lowest, h[i]);
    expect(lowest).toBeGreaterThan(roof - 1);
    expect(at(h, nx, 45, 45)).toBeGreaterThan(roof + 2);
  });
});

describe('water', () => {
  function hole(layers: SurfaceLayers, r0: number, r1: number, c0: number, c1: number) {
    fill(layers.count, layers.nx, r0, r1, c0, c1, 0);
    for (const layer of [layers.top, layers.solid, layers.ground]) fill(layer, layers.nx, r0, r1, c0, c1, NaN);
  }

  it('scan shadow by a tower is not water', () => {
    const nx = 100;
    const layers = blank(100, nx);
    fill(layers.top, nx, 20, 50, 30, 70, GROUND + 60);
    fill(layers.solid, nx, 20, 50, 30, 70, GROUND + 60);
    fill(layers.ground, nx, 20, 50, 30, 70, NaN);
    hole(layers, 50, 75, 30, 70);
    const result = compose(layers, CELL, CELL, 1, 1);
    expect(result.counts.water_bodies).toBe(0);
    expect(Math.abs(at(result.heights, nx, 60, 50) - at(result.heights, nx, 90, 10))).toBeLessThanOrEqual(0.05);
    // The same hole in a survey that files water elsewhere is not water either.
    fill(layers.water, nx, 0, 4, 0, 4, 6);
    expect(compose(layers, CELL, CELL, 1, 1).counts.water_bodies).toBe(0);
  });

  it('large hole on the ground is water without water returns', () => {
    const nx = 110;
    const layers = blank(110, nx);
    hole(layers, 20, 90, 20, 90);
    const result = compose(layers, CELL, CELL, 1, 1);
    expect(result.counts.water_bodies).toBe(1);
    expect(at(result.water, nx, 55, 55)).toBe(1);
  });

  // Not in the add-on.
  it('grows into cells partly filed as water at its level, but not onto a dock', () => {
    const nx = 100;
    const layers = blank(100, nx);
    // A bay over the south half. Its outer rows are a third water returns, like
    // San Francisco's 2023 survey, and there's a dock a metre above the water.
    for (const layer of [layers.top, layers.solid, layers.waterZ]) fill(layer, nx, 0, 50, 0, nx, GROUND - 2);
    fill(layers.ground, nx, 0, 50, 0, nx, NaN);
    fill(layers.water, nx, 0, 20, 0, nx, 4);
    fill(layers.water, nx, 20, 50, 0, nx, 2);
    fill(layers.top, nx, 30, 40, 40, 60, GROUND - 1);
    fill(layers.solid, nx, 30, 40, 40, 60, GROUND - 1);
    const result = compose(layers, CELL, CELL, 1, 1);
    expect(result.counts.water_bodies).toBe(1);
    expect(at(result.water, nx, 45, 10)).toBe(1);
    expect(at(result.water, nx, 35, 50)).toBe(0);
    expect(result.counts.water_grown_cells).toBe(30 * nx - 10 * 20);
    expect(at(result.heights, nx, 45, 10)).toBeCloseTo(at(result.heights, nx, 5, 10), 6);
  });
});

describe('cut water', () => {
  // 0.035 mm printed cells: a cut has to be 13 cells wide, an island 3,265 cells.
  const SCALE = 0.07;

  function cut(water: Uint8Array, nx: number, minArea = 1000, raised?: Uint8Array) {
    const surface = new Float32Array(water.length).fill(NaN);
    put(surface, water, GROUND - 1);
    if (raised) put(surface, raised, GROUND + 20);
    const ground = new Float32Array(water.length).fill(GROUND);
    return cutWater(water, surface, ground, nx, water.length / nx, CELL, CELL, SCALE, minArea);
  }

  const rows = (a: Uint8Array, nx: number, r0: number, r1: number) => Array.from(a.subarray(r0 * nx, r1 * nx));
  const same = (a: Uint8Array, b: Uint8Array) => a.every((v, i) => v === b[i]);
  const either = (a: Uint8Array, b: Uint8Array) => a.map((v, i) => v | b[i]);

  it('cuts a river to the edge but not a pond', () => {
    const [nx, ny] = [200, 300];
    // 20 m wide and 2,000 m², and a 400 m² pond 80 m away.
    const water = shape(nx, ny, (r, c) => r < 40 || (r >= 200 && r < 240 && c >= 80 && c < 120));
    const result = cut(water, nx);
    expect(rows(result.cut, nx, 0, 40).every(Boolean)).toBe(true);
    expect(rows(result.cut, nx, 40, ny).some(Boolean)).toBe(false);
    expect([result.bodies, result.islands]).toEqual([1, 0]);
  });

  it('counts stretches between bridges as one river', () => {
    const [nx, ny] = [400, 100];
    const bridge = (c: number) => [90, 190, 290].some((x) => c >= x && c < x + 30); // 15 m wide
    const water = shape(nx, ny, (r, c) => r >= 20 && r < 60 && !bridge(c));
    // No stretch reaches 2,000 m² on its own.
    const result = cut(water, nx, 2000);
    expect(same(result.cut, water)).toBe(true);
    expect(result.bodies).toBe(4);
    const first = shape(nx, ny, (r, c) => r >= 20 && r < 60 && c < 90);
    expect(cut(first, nx, 2000).cut.includes(1)).toBe(false);
  });

  it('leaves a narrow channel and a roof pool recessed', () => {
    const [nx, ny] = [200, 300];
    const river = shape(nx, ny, (r) => r < 40);
    const channel = shape(nx, ny, (r, c) => r >= 40 && r < 120 && c >= 100 && c < 108); // 4 m, 0.28 mm printed
    const pool = shape(nx, ny, (r, c) => r >= 200 && r < 280 && c >= 20 && c < 100); // 1,600 m² on a roof
    const result = cut(either(either(river, channel), pool), nx, 1000, pool);
    expect(same(result.cut, river)).toBe(true);
    expect(result.bodies).toBe(1);
  });

  it('takes a boat with the water and leaves an island', () => {
    const [nx, ny] = [400, 300];
    const boat = shape(nx, ny, (r, c) => r >= 40 && r < 50 && c >= 40 && c < 70); // 75 m²
    const island = shape(nx, ny, (r, c) => r >= 150 && r < 230 && c >= 150 && c < 230); // 1,600 m², 7.8 mm² printed
    const water = shape(nx, ny, (r, c) => c < 300 && !boat[r * nx + c] && !island[r * nx + c]);
    const result = cut(water, nx);
    expect(same(result.cut, either(water, boat))).toBe(true);
    expect([result.bodies, result.islands]).toEqual([1, 1]);
  });

  it('cuts the river out and puts the base under the land', () => {
    const options = { baseMm: 2, waterDepthMm: 1, cutWater: true };
    const recessed = compose(city().layers, CELL, CELL, 1, 1, { baseMm: 2, waterDepthMm: 1 });
    const result = compose(city().layers, CELL, CELL, 1, 1, { ...options, cutMinAreaM2: 100 });
    expect(rows(result.cut, 80, 0, 8).every(Boolean)).toBe(true);
    expect(rows(result.cut, 80, 8, 80).some(Boolean)).toBe(false);
    expect(result.counts.cut_water_bodies).toBe(1);
    const land = result.heights.subarray(8 * 80);
    const before = recessed.heights.subarray(8 * 80);
    expect(Math.min(...land)).toBeCloseTo(2, 6);
    // The base sits under the lowest land now, not under the river.
    expect(land.every((v, i) => Math.abs(v - before[i] + 2.5) < 1e-4)).toBe(true);
    // Under the default minimum, the river is recessed as before.
    const small = compose(city().layers, CELL, CELL, 1, 1, options);
    expect(same(new Uint8Array(small.heights.buffer), new Uint8Array(recessed.heights.buffer))).toBe(true);
    expect(small.cut.includes(1)).toBe(false);
  });
});

describe('narrow', () => {
  it('pits fill and jibs go but spires stay', () => {
    const [nx, ny] = [60, 40];
    const z = new Float32Array(nx * ny);
    fill(z, nx, 8, 35, 5, 55, 50);
    fill(z, nx, 20, 21, 20, 22, 1); // a well two cells wide down a tower
    fill(z, nx, 2, 3, 3, 57, 90); // a crane jib over the street
    fill(z, nx, 3, 30, 45, 46, 95); // and one reaching over the roof
    z[20 * nx + 40] = 80; // a spire on the roof
    z[38 * nx + 30] = 12; // a pole on the street
    const ground = new Float32Array(nx * ny);
    const keep = new Uint8Array(nx * ny);
    const { z: out, pits } = narrow(z, nx, ny, ground, keep, true, 1);
    expect(at(out, nx, 20, 20)).toBe(50);
    expect(at(out, nx, 2, 30)).toBe(0);
    expect(at(out, nx, 20, 45)).toBe(50);
    expect(at(out, nx, 20, 40)).toBe(80);
    expect(at(out, nx, 38, 30)).toBe(0);
    expect(at(out, nx, 10, 10)).toBe(50);
    expect(at(out, nx, 8, 5)).toBe(50); // corners stay
    expect(pits).toBeGreaterThanOrEqual(2);
    const kept = narrow(z, nx, ny, ground, keep, false, 1);
    expect([at(kept.z, nx, 2, 30), kept.slivers]).toEqual([90, 0]);
  });
});

describe('rules', () => {
  it('holes take the median on a roof and the street at a wall', () => {
    const z = new Float32Array(81).fill(5);
    fill(z, 9, 0, 9, 4, 9, 30);
    z[2 * 9 + 6] = NaN; // inside the roof
    z[6 * 9 + 4] = NaN; // at the wall
    const out = fillVoids(z, 9, 9, new Uint8Array(81).fill(1), 3, STEP_M);
    expect(out[2 * 9 + 6]).toBe(30);
    expect(out[6 * 9 + 4]).toBe(5);
  });

  it('straighten fills notches and keeps corners', () => {
    const z = new Float32Array(144);
    fill(z, 12, 3, 9, 3, 9, 20);
    z[3 * 12 + 5] = 0; // a notch in the north wall
    z[1 * 12 + 7] = 20; // a lone bump off it
    const out = straighten(z, 12, 12, new Uint8Array(144));
    expect(out[3 * 12 + 5]).toBe(20);
    expect(out[1 * 12 + 7]).toBe(0);
    expect(out[3 * 12 + 3]).toBe(20);
    expect(out[8 * 12 + 8]).toBe(20);
  });

  it('fairFaces takes a fin off a facade and keeps corners and spires', () => {
    const nx = 60;
    const z = new Float32Array(nx * 40);
    fill(z, nx, 10, 30, 10, 50, 40);
    fill(z, nx, 30, 32, 30, 32, 40); // a fin two cells wide off the north wall
    fill(z, nx, 18, 21, 25, 28, 60); // a spire on the roof
    const moved = fairFaces(z, nx, 40, 1, 12, 3, new Uint8Array(z.length));
    expect(moved).toBeGreaterThan(0);
    for (const [r, c] of [[30, 30], [31, 31]]) expect(z[r * nx + c]).toBe(0);
    for (const [r, c] of [[10, 10], [29, 49], [10, 49], [29, 10]]) expect(z[r * nx + c]).toBe(40);
    expect(z[19 * nx + 26]).toBe(60);
  });

  it('fairFaces leaves what it is told to keep', () => {
    const nx = 60;
    const z = new Float32Array(nx * 40);
    fill(z, nx, 10, 30, 10, 50, 40);
    fill(z, nx, 30, 32, 30, 32, 40);
    const keep = new Uint8Array(z.length);
    fill(keep, nx, 30, 32, 30, 32, 1);
    fairFaces(z, nx, 40, 1, 12, 3, keep);
    expect(z[30 * nx + 30]).toBe(40);
  });

  it('despike keeps edges', () => {
    const z = new Float32Array(100);
    fill(z, 10, 2, 6, 2, 6, 12);
    z[8 * 10 + 8] = 9;
    const { z: out, count } = despike(z, 10, 10, 1);
    expect(count).toBe(1);
    expect(out[8 * 10 + 8]).toBe(0);
    expect(out[2 * 10 + 2]).toBe(12);
  });

  it('label and fill smooth', () => {
    const mask = new Uint8Array(36);
    fill(mask, 6, 0, 2, 0, 2, 1);
    fill(mask, 6, 4, 6, 3, 6, 1);
    const labels = label(mask, 6, 6);
    expect(new Set(Array.from(labels).filter((_, i) => mask[i])).size).toBe(2);
    const values = new Float32Array(64).fill(NaN);
    fill(values, 8, 0, 1, 0, 8, 1);
    fill(values, 8, 7, 8, 0, 8, 3);
    const filled = fillSmooth(values, 8, 8);
    expect(filled.some((v) => Number.isNaN(v))).toBe(false);
    expect(filled[4 * 8 + 4]).toBeGreaterThanOrEqual(1);
    expect(filled[4 * 8 + 4]).toBeLessThanOrEqual(3);
  });
});
