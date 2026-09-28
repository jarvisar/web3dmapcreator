import { describe, expect, it } from 'vitest';
import type { SourceFeature } from '../source';
import { resolveVerticalProfile } from './heights';
import { findDuplicateOutlines, selectBuildingGeometry } from './selection';

type Coordinates = number[][][];

function feature(id: string, props: Record<string, unknown> = {}, coordinates: Coordinates = [[[0, 0], [1, 0], [1, 1], [0, 0]]]): SourceFeature {
  return { id, props, geometry: { type: 'Polygon', coordinates } };
}

function box(x0: number, y0: number, x1: number, y1: number): Coordinates {
  return [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
}

function rectangle(id: string, bounds: [number, number, number, number] | null, props: Record<string, unknown> = {}): SourceFeature {
  const [x0, y0, x1, y1] = bounds ?? [0, 0, 10, 10];
  return feature(id, props, box(x0, y0, x1, y1));
}

function square(id: string, x: number, y: number, size: number, props: Record<string, unknown> = {}): SourceFeature {
  return feature(id, props, box(x, y, x + size, y + size));
}

const ids = (features: SourceFeature[]) => features.map((f) => f.id);

describe('parent and part selection', () => {
  it('keeps the parent when a part only has a minimum height', () => {
    const parent = feature('parent', { has_parts: true, height: 20 });
    const selection = selectBuildingGeometry([parent], [feature('part', { building_id: 'parent', min_height: 200 })]);
    expect(selection.buildings).toEqual([parent]);
    expect(selection.parts).toEqual([]);
  });

  it('keeps an explicit main mass under a partial upper roof', () => {
    const parent = rectangle('parent', null, { has_parts: true, height: 340 });
    const roof = rectangle('roof', [2, 2, 8, 8], { building_id: 'parent', height: 346 });
    const selection = selectBuildingGeometry([parent], [roof]);
    expect(selection.buildings).toEqual([parent]);
    expect(selection.parts).toEqual([roof]);
    expect(selection.suppressedParentIds.size).toBe(0);
  });

  it('lets complete upper parts supply the main mass', () => {
    const parent = rectangle('parent', null, { has_parts: true, height: 340 });
    const parts = [
      rectangle('west', [0, 0, 5, 10], { building_id: 'parent', height: 346 }),
      rectangle('east', [5, 0, 10, 10], { building_id: 'parent', height: 346 }),
    ];
    const selection = selectBuildingGeometry([parent], parts);
    expect(selection.buildings).toEqual([]);
    expect(selection.parts).toEqual(parts);
  });

  it('does not fill a lower setback to the total height', () => {
    const parent = rectangle('parent', null, { has_parts: true, height: 100 });
    const parts = [
      rectangle('roof', [3, 3, 7, 7], { building_id: 'parent', height: 105 }),
      rectangle('podium', [0, 0, 3, 10], { building_id: 'parent', height: 20 }),
    ];
    const selection = selectBuildingGeometry([parent], parts);
    expect(selection.buildings).toEqual([]);
    expect(selection.parts).toEqual(parts);
  });

  it('does not infer a main mass from incomplete heights', () => {
    const roof = rectangle('roof', [2, 2, 8, 8], { building_id: 'parent', height: 346 });
    for (const props of [{}, { num_floors: 83 }]) {
      const parent = rectangle('parent', null, { has_parts: true, ...props });
      expect(selectBuildingGeometry([parent], [roof]).buildings).toEqual([]);
    }
  });

  it('keeps a recorded podium under heightless detail', () => {
    const parent = rectangle('parent', null, { has_parts: true, height: 10, num_floors: 2 });
    const tower = rectangle('tower', [0, 0, 4, 10], { building_id: 'parent', height: 100 });
    const unknown = rectangle('unknown', [5, 5, 7, 7], { building_id: 'parent' });
    const selection = selectBuildingGeometry([parent], [tower, unknown]);
    expect(selection.buildings).toEqual([parent]);
    expect(selection.parts).toEqual([tower, unknown]);
    expect(selection.suppressedParentIds.size).toBe(0);
    expect(unknown.props).not.toHaveProperty('height');
  });

  it('does not let heightless coverage replace a recorded mass', () => {
    const parent = rectangle('parent', null, { has_parts: true, height: 100 });
    const tower = rectangle('tower', [0, 0, 4, 10], { building_id: 'parent', height: 100 });
    const unknown = rectangle('unknown', [4, 0, 10, 10], { building_id: 'parent' });
    expect(selectBuildingGeometry([parent], [tower, unknown]).buildings).toEqual([parent]);
    // Complete known-height coverage still replaces the redundant parent.
    unknown.props.height = 100;
    expect(selectBuildingGeometry([parent], [tower, unknown]).buildings).toEqual([]);
  });

  it('lets a known lower or invalid part block parent infill', () => {
    const parent = rectangle('parent', null, { has_parts: true, height: 100 });
    const tower = rectangle('tower', [0, 0, 4, 10], { building_id: 'parent', height: 110 });
    const unknown = rectangle('unknown', [5, 5, 7, 7], { building_id: 'parent' });
    for (const props of [{ height: 20 }, { height: 20, min_height: 25 }, { num_floors: 6, min_floor: 7 }]) {
      const lower = rectangle('lower', [4, 0, 10, 4], { building_id: 'parent', ...props });
      const selection = selectBuildingGeometry([parent], [tower, unknown, lower]);
      expect(selection.buildings).toEqual([]);
      expect(selection.parts).toEqual([tower, unknown, lower]);
    }
  });

  it('does not let floor estimates below an explicit parent erase its main mass', () => {
    const parent = rectangle('parent', null, { has_parts: true, height: 10, num_floors: 2 });
    const parts = [
      rectangle('west', [0, 0, 1, 1], { building_id: 'parent', num_floors: 3 }),
      rectangle('east', [9, 9, 10, 10], { building_id: 'parent', num_floors: 3 }),
    ];
    const selection = selectBuildingGeometry([parent], parts);
    expect(selection.buildings).toEqual([parent]);
    expect(selection.parts).toEqual(parts);
    expect(selection.suppressedParentIds.size).toBe(0);
    expect(resolveVerticalProfile(parent.props, 3, 10).topM).toBe(10);
    expect(parts.every((p) => !('height' in p.props))).toBe(true);
    // An actual recorded lower height still establishes a setback.
    parts[0].props.height = 9;
    expect(selectBuildingGeometry([parent], parts).buildings).toEqual([]);
  });

  it('still replaces the parent with a complete floor-derived assembly', () => {
    const parent = rectangle('parent', null, { has_parts: true, height: 10 });
    const part = rectangle('part', null, { building_id: 'parent', num_floors: 3 });
    for (const floors of [3, 4]) {
      part.props.num_floors = floors;
      const selection = selectBuildingGeometry([parent], [part]);
      expect(selection.buildings).toEqual([]);
      expect(selection.parts).toEqual([part]);
    }
  });

  it('does not let a derived parent height supply a missing main mass', () => {
    const roof = rectangle('roof', [2, 2, 8, 8], { building_id: 'parent', height: 346 });
    let parent = rectangle('parent', null);
    for (const dataset of ['Microsoft ML Buildings', 'USGS Lidar']) {
      parent = rectangle('parent', null, { has_parts: true, height: 12, sources: [{ property: '/properties/height', dataset }] });
      expect(selectBuildingGeometry([parent], [roof]).buildings).toEqual([]);
    }
    // The footprint's provider does not imply that its height was estimated.
    (parent.props.sources as Record<string, unknown>[])[0].property = '';
    expect(selectBuildingGeometry([parent], [roof]).buildings).toEqual([parent]);
  });

  it('keeps the recorded parent extent under an equal-height partial part', () => {
    const parent = rectangle('parent', null, { has_parts: true, height: 100 });
    const part = rectangle('part', [2, 2, 8, 8], { building_id: 'parent', height: 100 });
    const selection = selectBuildingGeometry([parent], [part]);
    expect(selection.buildings).toEqual([parent]);
    expect(selection.parts).toEqual([part]);
  });

  it('replaces an advertised parent with useful parts', () => {
    const parent = feature('parent', { has_parts: true, height: 20 });
    const parts = [feature('p1', { building_id: 'parent', height: 8 }), feature('p2', { building_id: 'parent' })];
    const selection = selectBuildingGeometry([parent], parts);
    expect(selection.buildings).toEqual([]);
    expect(new Set(ids(selection.parts))).toEqual(new Set(['p1', 'p2']));
    expect(selection.suppressedParentIds).toEqual(new Set(['parent']));
  });

  it('does not replace a parent with uninformative parts', () => {
    const parent = feature('parent', { has_parts: true });
    const selection = selectBuildingGeometry([parent], [feature('p1', { building_id: 'parent' })]);
    expect(ids(selection.buildings)).toEqual(['parent']);
    expect(selection.parts).toEqual([]);
  });

  it('never emits underground geometry', () => {
    const parent = feature('parent', { is_underground: true });
    const orphan = feature('orphan', { building_id: 'outside', height: 5, is_underground: true });
    const selection = selectBuildingGeometry([parent], [orphan]);
    expect(selection.buildings).toEqual([]);
    expect(selection.parts).toEqual([]);
  });

  it('keeps only useful orphan parts', () => {
    const useful = feature('useful', { building_id: 'elsewhere', height: 12 });
    const vague = feature('vague', { building_id: 'elsewhere' });
    expect(ids(selectBuildingGeometry([], [useful, vague]).parts)).toEqual(['useful']);
  });
});

describe('duplicate outlines', () => {
  const courtyard = (f: SourceFeature) => {
    (f.geometry.coordinates as Coordinates).push([[0.0002, 0.0002], [0.0002, 0.0008], [0.0008, 0.0008], [0.0008, 0.0002], [0.0002, 0.0002]]);
    return f;
  };

  it('does not treat a building inside a part courtyard as a duplicate', () => {
    const parent = square('parent', 0, 0, 0.001, { has_parts: true });
    const part = courtyard(square('part', 0, 0, 0.001, { building_id: 'parent', height: 20 }));
    const inner = square('inner', 0.0004, 0.0004, 0.0002, { height: 10 });
    const selection = selectBuildingGeometry([parent, inner], [part]);
    expect(selection.duplicateIds.has('inner')).toBe(false);
    expect(selection.buildings).toContain(inner);
    // Another part can genuinely fill the courtyard. Holes are per polygon.
    const filling = square('filling', 0.0002, 0.0002, 0.0006, { building_id: 'parent', height: 10 });
    expect(selectBuildingGeometry([parent, inner], [part, filling]).duplicateIds.has('inner')).toBe(true);
  });

  it('does not pair a courtyard footprint with a solid one', () => {
    const hollow = courtyard(square('hollow', 0, 0, 0.001, { height: 20 }));
    const solid = square('solid', 0, 0, 0.001, { height: 10 });
    expect(findDuplicateOutlines([hollow, solid], new Map()).size).toBe(0);
  });

  it('still deduplicates actual courtyard twins', () => {
    const one = courtyard(square('one', 0, 0, 0.001, { height: 20 }));
    const two = courtyard(square('two', 0, 0, 0.001));
    expect(findDuplicateOutlines([one, two], new Map())).toEqual(new Set(['two']));
  });

  it('drops a named box standing over another building\'s parts', () => {
    // The Scripps Center: a plain 143 m box standing exactly over tiered parts.
    const outline = square('outline', 0, 0, 0.001, { has_parts: true });
    const named = square('named', 0, 0, 0.001, { height: 143, names: { primary: 'Scripps' } });
    const parts = [
      square('p1', 0, 0, 0.0005, { building_id: 'outline', height: 100 }),
      square('p2', 0.0005, 0, 0.0005, { building_id: 'outline', height: 120 }),
      feature('p3', { building_id: 'outline', height: 143 }, box(0, 0.0005, 0.001, 0.001)),
    ];
    const selection = selectBuildingGeometry([outline, named], parts);
    expect(selection.duplicateIds).toEqual(new Set(['named']));
    expect(ids(selection.buildings)).toEqual([]);
    expect(selection.parts).toHaveLength(3);
    expect(selection.suppressedParentIds.has('outline')).toBe(true);
  });

  it('keeps a separate building beside the parts', () => {
    const outline = square('outline', 0, 0, 0.001, { has_parts: true });
    const annex = square('annex', 0.0012, 0, 0.0005, { height: 8 });
    const parts = [square('p1', 0, 0, 0.001, { building_id: 'outline', height: 30 })];
    const selection = selectBuildingGeometry([outline, annex], parts);
    expect(selection.duplicateIds.size).toBe(0);
    expect(ids(selection.buildings)).toEqual(['annex']);
  });

  it('keeps a building only partly under the parts', () => {
    const outline = square('outline', 0, 0, 0.001, { has_parts: true });
    const neighbour = square('neighbour', 0.0005, 0, 0.001, { height: 8 });
    const parts = [square('p1', 0, 0, 0.001, { building_id: 'outline', height: 30 })];
    expect(selectBuildingGeometry([outline, neighbour], parts).duplicateIds.size).toBe(0);
  });

  it('keeps the better described of twin partless footprints', () => {
    const described = square('described', 0, 0, 0.001, { height: 24 });
    const vague = square('vague', 0.00002, 0.00002, 0.00098, { names: { primary: 'Centre' } });
    expect(findDuplicateOutlines([described, vague], new Map())).toEqual(new Set(['vague']));
    expect(ids(selectBuildingGeometry([described, vague], []).buildings)).toEqual(['described']);
  });

  it('resolves twins with nothing to choose between deterministically', () => {
    const one = square('b', 0, 0, 0.001);
    const two = square('a', 0, 0, 0.001);
    expect(findDuplicateOutlines([one, two], new Map())).toEqual(new Set(['b']));
    expect(findDuplicateOutlines([two, one], new Map())).toEqual(new Set(['b']));
  });

  it('finds twins among many buildings in the western and southern hemispheres', () => {
    const buildings: SourceFeature[] = [];
    for (let i = 0; i < 400; i++) {
      const x = -87.63 + (i % 20) * 0.0004;
      const y = -41.88 + Math.floor(i / 20) * 0.0004;
      buildings.push(square(`b${i}`, x, y, 0.0002, { height: 10 }));
    }
    buildings.push(square('twin', -87.63 + 5 * 0.0004, -41.88 + 7 * 0.0004, 0.0002));
    expect(findDuplicateOutlines(buildings, new Map())).toEqual(new Set(['twin']));
  });
});

describe('sparse parents', () => {
  it('keeps a floor-derived parent over a lower sparse roof only when enabled', () => {
    const parent = rectangle('parent', null, { has_parts: true, num_floors: 18 });
    const part = rectangle('part', [0, 0, 2, 2], { building_id: 'parent', height: 24 });
    expect(selectBuildingGeometry([parent], [part]).buildings).toEqual([]);
    const result = selectBuildingGeometry([parent], [part], true);
    expect(result.buildings).toEqual([parent]);
    expect(result.parts).toEqual([part]);
  });

  it('keeps the parent suppressed under complete or heightless coverage', () => {
    const parent = rectangle('parent', null, { has_parts: true, num_floors: 18 });
    const known = rectangle('known', [0, 0, 2, 2], { building_id: 'parent', height: 24 });
    for (const extra of [rectangle('extra', null, { building_id: 'parent' }), rectangle('extra', null, { building_id: 'parent', height: 54 })]) {
      expect(selectBuildingGeometry([parent], [known, extra], true).buildings).toEqual([]);
    }
  });

  it('keeps parent holes and opts out for part holes', () => {
    const parent = rectangle('parent', null, { has_parts: true, num_floors: 18 });
    (parent.geometry.coordinates as Coordinates).push([[4, 4], [4, 6], [6, 6], [6, 4], [4, 4]]);
    const part = rectangle('part', [0, 0, 2, 2], { building_id: 'parent', height: 24 });
    const original = structuredClone(parent);
    expect(selectBuildingGeometry([parent], [part], true).buildings).toEqual([original]);
    (part.geometry.coordinates as Coordinates).push([[0.5, 0.5], [0.5, 1], [1, 1], [1, 0.5], [0.5, 0.5]]);
    expect(selectBuildingGeometry([parent], [part], true).buildings).toEqual([]);
  });

  it('keeps a fallback height but skips an invalid or elevated parent', () => {
    const part = rectangle('part', [0, 0, 2, 2], { building_id: 'parent', height: 24 });
    const parent = rectangle('parent', null, { has_parts: true });
    expect(selectBuildingGeometry([parent], [part], true).buildings).toEqual([parent]);
    for (const props of [{ height: 10, min_height: 20 }, { height: 30, min_height: 20 }]) {
      const elevated = rectangle('parent', null, { has_parts: true, ...props });
      expect(selectBuildingGeometry([elevated], [part], true).buildings).toEqual([]);
    }
  });

  it('keeps all parts at the majority-missing threshold', () => {
    const parent = rectangle('parent', null, { has_parts: true, height: 25 });
    const part = rectangle('part', [0, 0, 3, 10], { building_id: 'parent', height: 15 });
    const original = structuredClone([parent, part]);
    const result = selectBuildingGeometry([parent], [part], true);
    expect(result.buildings).toEqual([parent]);
    expect(result.parts).toEqual([part]);
    expect([parent, part]).toEqual(original);
    part.geometry = rectangle('wide', [0, 0, 7, 10]).geometry;
    expect(selectBuildingGeometry([parent], [part], true).buildings).toEqual([]);
  });

  it('weights disconnected components by area', () => {
    const parent = rectangle('parent', null, { has_parts: true, height: 20 });
    parent.geometry = { type: 'MultiPolygon', coordinates: [box(0, 0, 10, 10), box(20, 0, 21, 1)] };
    const part = rectangle('part', [0, 0, 3, 10], { building_id: 'parent', height: 10 });
    expect(selectBuildingGeometry([parent], [part], true).buildings).toEqual([parent]);
    // A fully covered large component cannot be outweighed by an empty tiny wing.
    part.geometry = rectangle('covered', null).geometry;
    expect(selectBuildingGeometry([parent], [part], true).buildings).toEqual([]);
    // Nor can a covered tiny component suppress a mostly empty large body.
    part.geometry = { type: 'Polygon', coordinates: box(20, 0, 21, 1) };
    expect(selectBuildingGeometry([parent], [part], true).buildings).toEqual([parent]);
  });
});
