import { describe, expect, it } from 'vitest';
import { emptyEdits, type AddedShape, type ModelEdits } from '../../core/edit/types';
import { DEFAULT_AREA, type AreaSpec } from '../../core/settings';
import { editsForArea, picksForArea } from './linkScope';
import type { EditData } from './model';

// Chicago's Loop, and far away San Francisco.
const loop: AreaSpec = { ...DEFAULT_AREA, center: [-87.63, 41.88], widthM: 2000, heightM: 2000, rotationDeg: 0 };
const sf: [number, number] = [-122.41, 37.78];

function pin(id: string, at: [number, number], layer = 'buildings'): AddedShape {
  return { id, kind: 'pin', layer, at, points: [], rotationDeg: 0, sizeMm: 5, depthMm: 5, heightMm: 2, liftMm: 0, followGround: false, text: '', font: 'montserrat' };
}

const data: EditData = {
  editable: true,
  roads: { keys: ['r:wacker'] } as EditData['roads'],
  objects: { 'b:willis': { kind: 'building' } },
  ground: null,
  frame: { center: loop.center, rotationDeg: 0, mmPerMetre: 0.07, buildingMmPerMetre: 0.07 },
};

const edits: ModelEdits = {
  ...emptyEdits(),
  layers: [
    { id: 'race', name: 'Race', hex: '#FF0000', line: 'PLA Basic' },
    { id: 'commute', name: 'Commute', hex: '#0000FF', line: 'PLA Basic' },
  ],
  objects: {
    'b:willis': { heightM: 500 },
    'b:willis/top': { removed: true },
    'r:wacker': { layer: 'race' },
    'b:salesforce': { removed: true },
    't:f3,4': { removed: true },
  },
  shapes: [pin('here', [-87.632, 41.881]), pin('home', sf, 'commute')],
};

describe('what a share link carries', () => {
  it("carries this area's edits and shapes, and the layers they use", () => {
    const { edits: scoped, left, unplaced } = editsForArea(edits, loop, { data, trees: true });
    expect(Object.keys(scoped.objects).sort()).toEqual(['b:willis', 'b:willis/top', 'r:wacker', 't:f3,4']);
    expect(scoped.shapes.map((s) => s.id)).toEqual(['here']);
    expect(scoped.layers.map((l) => l.id)).toEqual(['race']);
    expect([left, unplaced]).toEqual([2, 0]);
  });

  it("leaves object edits out without a model of this area, and still carries its shapes", () => {
    for (const model of [null, { data: { ...data, frame: { ...data.frame!, center: sf } }, trees: true }]) {
      const { edits: scoped, unplaced } = editsForArea(edits, loop, model);
      expect(scoped.objects).toEqual({});
      expect(scoped.shapes.map((s) => s.id)).toEqual(['here']);
      expect(unplaced).toBe(5);
    }
  });

  it('carries only the picked roads on the map, and routes that have some', () => {
    const near: [number, number][] = [[-87.631, 41.88], [-87.629, 41.88]];
    const far: [number, number][] = [sf, [sf[0] + 0.001, sf[1]]];
    const { picks, left } = picksForArea(
      {
        routes: [
          { id: 'a', name: 'Loop run', color: '#E4002B', width: 0.6, lines: [near, far] },
          { id: 'b', name: 'Home', color: '#0057B8', width: 0.6, lines: [far] },
        ],
        hiddenLines: [far, near],
      },
      loop,
    );
    expect(picks.routes.map((r) => [r.id, r.lines.length])).toEqual([['a', 1]]);
    expect(picks.hiddenLines).toEqual([near]);
    expect(left).toBe(3);
  });
});
