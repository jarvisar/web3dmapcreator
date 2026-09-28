import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE, type Palette } from '../settings';
import type { Plate } from '../types';
import { preparePlates } from './common';
import { fileStem, sectionTag, STL_HEADER, stlHeader, writeStl, writeStlZip, type StlZipOptions } from './stl';
import { blobBytes, box, part, plate, unzip } from './test-helpers';

interface Stl {
  header: string;
  count: number;
  normals: number[][];
  corners: number[][][];
  size: number;
}

function readStl(data: Uint8Array): Stl {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint32(80, true);
  const normals: number[][] = [];
  const corners: number[][][] = [];
  for (let t = 0; t < count; t++) {
    const at = 84 + 50 * t;
    const f = (k: number) => view.getFloat32(at + 4 * k, true);
    normals.push([f(0), f(1), f(2)]);
    corners.push([[f(3), f(4), f(5)], [f(6), f(7), f(8)], [f(9), f(10), f(11)]]);
    expect(view.getUint16(at + 48, true)).toBe(0);
  }
  return { header: new TextDecoder().decode(data.subarray(0, 80)), count, normals, corners, size: data.length };
}

async function stlBytes(p: Plate): Promise<Uint8Array> {
  return blobBytes(writeStl(preparePlates([p], DEFAULT_PALETTE).plates[0]));
}

function stlZip(plates: Plate[], palette: Palette, base: string, options?: StlZipOptions) {
  return unzip(writeStlZip(preparePlates(plates, palette), base, options));
}

function signedVolume(corners: number[][][]): number {
  let volume = 0;
  for (const [a, b, c] of corners) {
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return volume;
}

function bounds(corners: number[][][]): number[] {
  const points = corners.flat();
  return [0, 1, 2].flatMap((axis) => [Math.min(...points.map((p) => p[axis])), Math.max(...points.map((p) => p[axis]))]);
}

describe('STL header', () => {
  it('is 80 ASCII bytes carrying the attribution', () => {
    const header = stlHeader();
    expect(header.length).toBe(80);
    const text = new TextDecoder().decode(header);
    expect(text.startsWith('Jarvizar City Model')).toBe(true);
    expect(text).toContain('(c) OpenStreetMap contributors, Overture Maps Foundation');
    expect(text.toLowerCase().startsWith('solid')).toBe(false);
    expect(header[79]).toBe(0);
    for (const bad of ['solid city', 'x'.repeat(81), 'café']) expect(() => stlHeader(bad)).toThrow();
    expect(STL_HEADER.length).toBeLessThanOrEqual(80);
  });
});

describe('writeStl', () => {
  it('writes every part with outward unit normals, centred on the plate, lowest point at zero', async () => {
    const terrain = part('terrain', 'Terrain', 'terrain', box(0, 0, -3, 100, 80, 3));
    const buildings = part('buildings', 'Buildings', 'building', box(10, 10, 0, 10, 20, 30));
    const data = await stlBytes(plate('Map', [terrain, buildings], [0, 0, 100, 80]));
    const stl = readStl(data);
    expect(stl.header).toBe(STL_HEADER.padEnd(80, '\0'));
    expect(stl.count).toBe(24);
    expect(stl.size).toBe(84 + 50 * 24);
    expect(bounds(stl.corners)).toEqual([-50, 50, -40, 40, 0, 33]);
    expect(signedVolume(stl.corners)).toBeCloseTo(100 * 80 * 3 + 10 * 20 * 30, 3);
    for (let t = 0; t < 12; t++) {
      const n = stl.normals[t];
      expect(Math.hypot(...n)).toBeCloseTo(1, 6);
      // Terrain box centre is (0, 0, 1.5) after placement.
      const centre = [0, 1, 2].map((k) => stl.corners[t].reduce((s, p) => s + p[k], 0) / 3 - [0, 0, 1.5][k]);
      expect(n[0] * centre[0] + n[1] * centre[1] + n[2] * centre[2]).toBeGreaterThan(0);
    }
  });

  it('gives degenerate triangles a zero normal', async () => {
    const flat = { id: 'f', name: 'Flat', role: 'terrain' as const, positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]), indices: new Uint32Array([0, 1, 2]) };
    expect(readStl(await stlBytes(plate('Map', [flat], [0, 0, 2, 0]))).normals).toEqual([[0, 0, 0]]);
  });
});

describe('writeStlZip', () => {
  const terrain = part('terrain', 'Terrain', 'terrain', box(-50, -40, -3, 100, 80, 3));
  const buildings = part('buildings', 'Buildings', 'building', box(-10, -10, 0, 5, 5, 20), box(10, 10, 0, 4, 4, 8));
  const roads = part('roads', 'Roads', 'road', box(-50, -1, 0, 100, 2, 0.6));
  const paved = part('paved', 'Paved', 'paved', box(0, 0, 0, 10, 10, 0.5));
  const rim = part('rim', 'Rim', 'rim', box(-52, -42, -3, 2, 84, 4));

  it('writes one file per colour, named by number, colour groups and hex', async () => {
    const palette = { ...DEFAULT_PALETTE, rim: DEFAULT_PALETTE.terrain };
    const files = await stlZip([plate('Map', [terrain, buildings, roads, paved, rim], [-50, -40, 50, 40])], palette, 'loop');
    expect(Object.keys(files)).toEqual([
      'loop_1_Terrain+Rim_FFFFFF.stl',
      'loop_2_Buildings_AE835B.stl',
      'loop_3_Roads+Paved_545454.stl',
    ]);
    const stls = Object.values(files).map(readStl);
    expect(stls.map((s) => s.count)).toEqual([24, 24, 24]);
    expect(stls.map((s) => s.size)).toEqual([84 + 50 * 24, 84 + 50 * 24, 84 + 50 * 24]);
    // Every file shares one frame: the terrain's corner stays where it was relative to the others.
    expect(bounds(stls[0].corners).slice(0, 4)).toEqual([-52, 50, -42, 42]);
    expect(Math.min(...stls.map((s) => bounds(s.corners)[4]))).toBe(0);
    expect(bounds(stls[1].corners)[4]).toBe(3);
  });

  it('numbers colours across sections and names section files', async () => {
    const west = part('terrain', 'Terrain', 'terrain', box(0, 0, -1, 50, 50, 1));
    const east = part('terrain', 'Terrain', 'terrain', box(50, 0, -1, 50, 50, 1));
    const eastRoads = part('roads', 'Roads', 'road', box(60, 10, 0, 30, 2, 0.6));
    const westTrees = part('trees', 'Trees', 'tree', box(10, 10, 0, 2, 2, 2));
    const plates = [
      plate('Section R1 C1', [west, westTrees], [0, 0, 50, 50]),
      plate('Section R1 C2', [eastRoads, east], [50, 0, 100, 50]),
    ];
    const files = await stlZip(plates, DEFAULT_PALETTE, 'city');
    expect(Object.keys(files)).toEqual([
      'city_R1C1_1_Terrain_FFFFFF.stl',
      'city_R1C1_2_Trees_0F2E14.stl',
      'city_R1C2_1_Terrain_FFFFFF.stl',
      'city_R1C2_3_Roads_545454.stl',
    ]);
    // Each section is centred on its own cell.
    const eastTerrain = readStl(files['city_R1C2_1_Terrain_FFFFFF.stl']);
    expect(bounds(eastTerrain.corners)).toEqual([-25, 25, -25, 25, 0, 1]);
    const combined = await stlZip(plates, DEFAULT_PALETTE, 'city', { combined: true });
    expect(Object.keys(combined)).toEqual(['city_R1C1.stl', 'city_R1C2.stl']);
    expect(Object.values(combined).map((d) => readStl(d).count)).toEqual([24, 24]);
  });

  it('pads colour numbers once there are ten or more', async () => {
    const groups = ['terrain', 'buildings', 'roads', 'paved', 'water', 'green', 'forest', 'trees', 'sand', 'rock', 'rim'] as const;
    const roles = ['terrain', 'building', 'road', 'paved', 'water', 'green', 'forest', 'tree', 'sand', 'rock', 'rim'] as const;
    const palette = Object.fromEntries(groups.map((g, i) => [g, { hex: `#0000${i.toString(16).padStart(2, '0')}`, line: 'PLA Basic' }])) as unknown as typeof DEFAULT_PALETTE;
    const parts = roles.map((role, i) => part(role, role, role, box(i, 0, 0, 1, 1, 1)));
    const names = Object.keys(await stlZip([plate('Map', parts, [0, 0, 11, 1])], palette, 'city'));
    expect(names[0]).toBe('city_01_Terrain_000000.stl');
    expect(names.at(-1)).toBe('city_11_Rim_00000A.stl');
    expect(names).toEqual([...names].sort());
  });

  it('makes safe names', () => {
    expect(sectionTag('Section R2 C13', 0)).toBe('R2C13');
    expect(sectionTag('Plate', 4)).toBe('P5');
    expect(fileStem('a/b:c*?')).toBe('a-b-c--');
    expect(fileStem('  ')).toBe('city-model');
    expect(fileStem('Zürich')).toBe('Zürich');
  });
});
