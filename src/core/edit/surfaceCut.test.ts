// The LiDAR only surface cut where drawn roads clear it: the viewer's split
// copy and the export's whole cut have to agree.

import { describe, expect, it } from 'vitest';
import { multiArea, rectangle, union } from '../geometry/polygon';
import type { CapSolid, Layer } from '../geometry/solid';
import { tinArea } from '../geometry/tinclip';
import { edgeReport, signedVolume } from '../geometry/validate';
import { meshLayers } from '../pipeline/mesh';
import type { MeshPart, MultiPolygon } from '../types';
import { SurfaceCut } from './surfaceCut';

const SIZE = 60;
const ground = (x: number, y: number) => 2 + 0.2 * Math.sin(x / 7) * Math.cos(y / 5);

/** A TIN on a 1 mm lattice over the square, a bump of trees in the middle. */
function city(): { layer: Layer; cap: CapSolid } {
  const n = SIZE + 1;
  const vertices = new Float64Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = 3 * (j * n + i);
      vertices[k] = i;
      vertices[k + 1] = j;
      vertices[k + 2] = ground(i, j) + (Math.hypot(i - 30, j - 30) < 8 ? 1.5 : 0);
    }
  }
  const triangles: number[] = [];
  for (let j = 0; j < SIZE; j++) {
    for (let i = 0; i < SIZE; i++) {
      const a = j * n + i;
      triangles.push(a, a + 1, a + n + 1, a, a + n + 1, a + n);
    }
  }
  const cap: CapSolid = { kind: 'cap', role: 'terrain', vertices, triangles: Uint32Array.from(triangles), bottom: 0 };
  return { layer: { id: 'city', name: 'City', role: 'terrain', solids: [cap] }, cap };
}

const crop: MultiPolygon = rectangle(0, 0, SIZE, SIZE);
const signature = (hole: MultiPolygon) => JSON.stringify(hole);

describe('the surface cut for drawn roads', () => {
  it('cuts cleared cells meeting at a corner without pulling the surface in', () => {
    const { layer, cap } = city();
    const cut = new SurfaceCut(layer, crop, [], ground, 0.5);
    // Two cells touching only at (31, 31).
    const pieces = union(rectangle(30, 30, 31, 31), rectangle(31, 31, 32, 32));
    const hole = cut.hole(pieces, 'a');
    const out = cut.layer(hole, 'a');
    const cutCap = out.solids.find((s) => s.kind === 'cap') as CapSolid;
    // A micron all round the 240 mm outline would take another 0.24 mm².
    expect(tinArea(cap) - tinArea(cutCap)).toBeCloseTo(multiArea(hole), 3);
    expect(multiArea(hole)).toBeLessThan(2.05);
  });

  it('leaves water and specks out of the hole', () => {
    const { layer } = city();
    const water = rectangle(0, 0, SIZE, 10);
    const cut = new SurfaceCut(layer, crop, water, ground, 0.5);
    const hole = cut.hole(union(rectangle(20, 5, 24, 14), rectangle(50, 50, 50.01, 50.01)), 'b');
    expect(hole.length).toBe(1);
    expect(multiArea(hole)).toBeCloseTo(4 * 4.005, 1);
  });

  it('gives the viewer the same solid as the export, and only meshes the tiles near the roads again', async () => {
    const { layer } = city();
    const cut = new SurfaceCut(layer, crop, [], ground, 0.5);
    let meshed = 0;
    const mesh = async (l: Layer): Promise<MeshPart> => {
      meshed++;
      const { parts } = await meshLayers([l], { zShift: 0 });
      return parts[0];
    };
    const road = (y: number) => rectangle(22, y, 38, y + 1.2);
    const exported = async (hole: MultiPolygon) => {
      const { parts } = await meshLayers([cut.layer(hole, signature(hole))], { zShift: 0 });
      return parts[0];
    };

    const first = cut.hole(road(29), signature(road(29)));
    const view = await cut.view(first, mesh);
    // The rest, and every tile around the road.
    const split = meshed;
    expect(split).toBeGreaterThan(2);
    const whole = await exported(first);
    expect(edgeReport(view.indices, view.positions.length / 3).open).toBe(0);
    expect(edgeReport(whole.indices, whole.positions.length / 3).open).toBe(0);
    expect(signedVolume(view.positions, view.indices)).toBeCloseTo(signedVolume(whole.positions, whole.indices), 3);

    // Moved a little, it stays in the same tiles: only those it was or is in are meshed again.
    const moved = cut.hole(road(30), signature(road(30)));
    const again = await cut.view(moved, mesh);
    expect(meshed - split).toBeGreaterThan(0);
    expect(meshed - split).toBeLessThan(split - 1);
    const count = meshed;
    await cut.view(moved, mesh);
    expect(meshed).toBe(count);
    expect(signedVolume(again.positions, again.indices)).toBeCloseTo(signedVolume((await exported(moved)).positions, (await exported(moved)).indices), 3);
    // The fill is the ground: what's left is lower than the trees were.
    expect(signedVolume(again.positions, again.indices)).toBeLessThan(signedVolume(view.positions, view.indices) + 1e-6);
  });
});
