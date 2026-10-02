// Roads drawn in the editor on a LiDAR only model: on the bare ground, with
// the trees over them cleared from the surface.

import { describe, expect, it } from 'vitest';
import { surfaceModel } from '../dsm/model';
import { gridSpec } from '../dsm/grid';
import { emptyLayers } from '../dsm/layers';
import { TREE_CELL } from '../dsm/route';
import { Projection } from '../geo/projection';
import { pointInPolygon } from '../geometry/polygon';
import type { CapSolid, PrismSolid } from '../geometry/solid';
import { tinArea } from '../geometry/tinclip';
import { edgeReport } from '../geometry/validate';
import { meshLayers } from '../pipeline/mesh';
import type { ModelSpec } from '../pipeline/generate';
import { cloneSettings, DEFAULT_PALETTE, type AreaSpec } from '../settings';
import type { LonLat, Polygon } from '../types';
import { drawnRoad } from './drawn';
import { EditSession } from './session';
import { emptyEdits, type AddedShape, type ModelEdits } from './types';

const area: AreaSpec = { center: [-87.63, 41.88], widthM: 160, heightM: 120, rotationDeg: 0, shape: 'rectangle', cornerRadius: 0.1 };
const projection = new Projection(area.center, 0, 1);
const geo = (x: number, y: number): LonLat => projection.localToGeo(x, y);
const SCALE = 0.5;
const GROUND = 100;

/** 1 m cells: ground at 100 m, a row of crowns over the street at y 0, a 30 m tower, and a river to the south. */
function prepared() {
  const grid = gridSpec(area.widthM, area.heightM, 1);
  const layers = emptyLayers(grid.nx, grid.ny);
  for (let j = 0; j < grid.ny; j++) {
    for (let i = 0; i < grid.nx; i++) {
      const k = j * grid.nx + i;
      const x = grid.x0 + i * grid.dx;
      const y = grid.y0 + j * grid.dy;
      layers.count[k] = 6;
      if (y < -45) {
        layers.top[k] = layers.solid[k] = layers.waterZ[k] = 98;
        layers.water[k] = 6;
        continue;
      }
      if (x >= 10 && x < 40 && y >= 5 && y < 35) {
        layers.top[k] = layers.solid[k] = 130;
        layers.building[k] = 6;
        continue;
      }
      layers.ground[k] = GROUND;
      // Three crowns 7 m across, 8 to 11 m up and rough all over, with the ground seen through them.
      const crown = [-40, -28, -16].some((cx) => Math.hypot(x - cx, y) < 7);
      if (crown) {
        const rough = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
        layers.top[k] = GROUND + 9.5 + 1.5 * (2 * (rough - Math.floor(rough)) - 1);
        layers.vegetation[k] = 6;
      } else {
        layers.top[k] = layers.solid[k] = GROUND;
      }
    }
  }
  return { layers, checkpoints: [], grid, requestedCellM: 1, densityM2: 10, coverage: 1, points: 0, noise: 0, surveys: [], failures: [], downloadedBytes: 0, blocks: 1, reusedBlocks: 0, offers: [], found: [] };
}

function settings() {
  const s = cloneSettings();
  s.modelSource = 'lidar';
  s.scale.mmPerMetre = SCALE;
  return s;
}

function road(id: string, points: [number, number][]): AddedShape {
  return { id, kind: 'path', layer: 'roads', at: geo(...points[0]), points: points.map(([x, y]) => geo(x, y)), rotationDeg: 0, sizeMm: 1, depthMm: 1, heightMm: 0.6, liftMm: 0, followGround: true, text: '', font: 'montserrat' };
}

function edits(...shapes: AddedShape[]): ModelEdits {
  return { ...emptyEdits(), shapes };
}

/** The top of the solid under a point given in real metres. */
function topAt(solids: PrismSolid[], x: number, y: number): number {
  const [mx, my] = [x * SCALE, y * SCALE];
  const solid = solids.find((s) => pointInPolygon(mx, my, s.polygon as Polygon));
  if (!solid) throw new Error(`Nothing at ${x}, ${y}`);
  return typeof solid.top === 'number' ? solid.top : solid.top(mx, my);
}

async function model(): Promise<{ spec: ModelSpec; session: EditSession }> {
  const s = settings();
  const spec = await surfaceModel({ area, settings: s, surface: prepared() });
  return { spec, session: new EditSession(spec, s, new Projection(area.center, 0, SCALE)) };
}

const added = (spec: ModelSpec) => (spec.layers.find((layer) => layer.id === 'added-roads')?.solids ?? []) as PrismSolid[];
const cityOf = (spec: ModelSpec) => spec.layers.find((layer) => layer.id === 'city')!;

describe('roads drawn on a LiDAR only model', () => {
  it('keeps the bare ground and the trees for the editor', async () => {
    const { spec } = await model();
    const profile = spec.edit!.profile!;
    expect(profile).toBeDefined();
    const { ground, flags } = profile;
    const at = (x: number, y: number) => Math.round((y * SCALE - ground.minY) / (ground.stepY ?? ground.step)) * ground.cols + Math.round((x * SCALE - ground.minX) / ground.step);
    expect(flags[at(-28, 0)] & TREE_CELL).toBeTruthy();
    expect(flags[at(-60, 20)] & TREE_CELL).toBe(0);
    expect(ground.values[at(-28, 0)]).toBeCloseTo(ground.values[at(-60, 20)], 3);
  });

  it('runs under the trees on the ground, with the trees over it cleared', async () => {
    const { spec, session } = await model();
    const ground = spec.edit!.heightAt(-60 * SCALE, 20 * SCALE);
    const street = road('a', [
      [-70, 0],
      [0, 0],
    ]);
    const update = await session.update(edits(street), 1);
    const city = update.parts.find((part) => part.id === 'city');
    expect(city?.part).toBeTruthy();

    const out = await session.edited(edits(street), DEFAULT_PALETTE);
    // On the street under the middle crown, not on top of it.
    expect(topAt(added(out), -28, 0)).toBeCloseTo(ground + 0.6, 2);
    expect(spec.edit!.heightAt(-28 * SCALE, 0)).toBeGreaterThan(ground + 3);

    // The surface is cut along it and filled with the ground.
    const before = cityOf(spec).solids.find((s) => s.kind === 'cap') as CapSolid;
    const after = cityOf(out);
    const cap = after.solids.find((s) => s.kind === 'cap') as CapSolid;
    expect(tinArea(cap)).toBeLessThan(tinArea(before) - 1);
    const fill = after.solids.filter((s): s is PrismSolid => s.kind === 'prism' && s.role === 'terrain');
    expect(fill.length).toBeGreaterThan(0);
    expect(topAt(fill, -28, 0)).toBeCloseTo(ground, 2);

    const { parts, failed } = await meshLayers(out.layers, { zShift: -out.baseZ });
    expect(failed).toBe(0);
    for (const part of parts) expect(edgeReport(part.indices, part.positions.length / 3).open, part.name).toBe(0);

    // Taken out again, the surface goes back to the generated one.
    const undone = await session.update(emptyEdits(), 2);
    expect(undone.parts.find((part) => part.id === 'city')).toEqual({ id: 'city', part: null });
    const plain = await session.edited(emptyEdits(), DEFAULT_PALETTE);
    expect(cityOf(plain).solids).toEqual(cityOf(spec).solids);
  });

  it('stays at the street where it meets a building, rather than climbing it', async () => {
    const { spec, session } = await model();
    const ground = spec.edit!.heightAt(-60 * SCALE, 20 * SCALE);
    const out = await session.edited(
      edits(
        road('b', [
          [-20, 20],
          [60, 20],
        ]),
      ),
      DEFAULT_PALETTE,
    );
    expect(topAt(added(out), 25, 20)).toBeCloseTo(ground + 0.6, 2);
    expect(topAt(added(out), -10, 20)).toBeCloseTo(ground + 0.6, 2);
  });

  it('says so when it runs into a building and nearly all of it is hidden', async () => {
    const { session } = await model();
    // From a metre outside the tower's west wall to inside its east one.
    const into = road('e', [
      [9, 20],
      [39, 20],
    ]);
    const update = await session.update(edits(into), 1);
    expect(update.notes['s:e']).toMatch(/won't show/);
    const across = await session.update(edits(road('f', [[-60, 20], [60, 20]])), 2);
    expect(across.notes['s:f']).toBeUndefined();
  });

  it('stands on a roof it is drawn on and never leaves', async () => {
    const { spec, session } = await model();
    const roof = spec.edit!.heightAt(25 * SCALE, 20 * SCALE);
    const out = await session.edited(
      edits(
        road('g', [
          [14, 12],
          [36, 28],
        ]),
      ),
      DEFAULT_PALETTE,
    );
    expect(topAt(added(out), 25, 20)).toBeCloseTo(roof + 0.6, 2);
  });

  it('gives a wide road its centreline height right across it', async () => {
    const { spec } = await model();
    const grids = spec.edit!.profile!;
    // 20 mm, the widest the editor allows, along y 0 and then turning north.
    const line: [number, number][] = [
      [-35, 0],
      [-5, 0],
      [-5, 25],
    ];
    const wide = drawnRoad(line, 20, 0.6, grids, 0.04);
    const narrow = drawnRoad(line, 1, 0.6, grids, 0.04);
    for (const [x, y] of [
      [-20, 0],
      [-20, 9.5],
      [-20, -9.5],
      [-14, 15],
      [-5, 12],
    ]) {
      const centre = y > 10 || x === -5 ? [-5, Math.max(0, y)] : [x, 0];
      expect(wide.restsOn(x, y)).toBeCloseTo(narrow.restsOn(centre[0], centre[1]), 6);
    }
  });

  it('leaves the surface alone where nothing over it is cleared', async () => {
    const { session } = await model();
    const open = road('c', [
      [-70, 20],
      [0, 20],
    ]);
    const update = await session.update(edits(open), 1);
    expect(update.parts.find((part) => part.id === 'city')).toBeUndefined();
  });

  it('only changes drawn roads that follow the ground', async () => {
    const { spec, session } = await model();
    const raised = { ...road('d', [
      [-70, 0],
      [0, 0],
    ]), followGround: false };
    const update = await session.update(edits(raised), 1);
    expect(update.parts.find((part) => part.id === 'city')).toBeUndefined();
    const out = await session.edited(edits(raised), DEFAULT_PALETTE);
    // Flat over the highest surface under it, the crowns included.
    expect(topAt(added(out), -60, 0)).toBeGreaterThan(spec.edit!.heightAt(-28 * SCALE, 0));
  });
});
