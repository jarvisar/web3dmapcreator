import { describe, expect, it } from 'vitest';
import {
  classifySurface,
  isBridgeArea,
  isPrintableWater,
  isTreePoint,
  isUntypedWater,
  isWaterDeck,
  recessedWaterKind,
} from './classify';
import { splitSegment, slicePolyline } from './linework';
import type { SourceFeature } from './source';

function polygon(props: Record<string, unknown>): SourceFeature {
  return {
    id: 'p',
    props,
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
  };
}

describe('surface classification', () => {
  it('maps land use, land and land cover through their own vocabularies', () => {
    expect(classifySurface('land_use', polygon({ class: 'park' }))).toBe('green');
    expect(classifySurface('land_use', polygon({ class: 'grass' }))).toBe('green');
    expect(classifySurface('land', polygon({ subtype: 'forest', class: 'wood' }))).toBe('forest');
    expect(classifySurface('land_cover', polygon({ subtype: 'forest' }))).toBe('forest');
    expect(classifySurface('land_use', polygon({ class: 'pedestrian' }))).toBe('paved');
    expect(classifySurface('land', polygon({ class: 'beach' }))).toBe('sand');
  });

  it('never guesses', () => {
    // Urban land cover would blanket the whole selection in one slab.
    expect(classifySurface('land_cover', polygon({ subtype: 'urban' }))).toBeNull();
    expect(classifySurface('land_use', polygon({ class: 'wat' }))).toBeNull();
    expect(classifySurface('land', polygon({ subtype: 'land', class: 'land' }))).toBeNull();
    expect(classifySurface('water', polygon({ class: 'park' }))).toBeNull();
  });

  it('recognises bridge areas in every tag representation', () => {
    expect(isBridgeArea(polygon({ source_tags: [['area', 'yes'], ['bridge', 'yes']] }))).toBe(true);
    expect(isBridgeArea(polygon({ source_tags: { bridge: 'viaduct' } }))).toBe(true);
    expect(isBridgeArea(polygon({ source_tags: [['man_made', 'bridge']] }))).toBe(true);
    expect(isBridgeArea(polygon({ source_tags: [['bridge', 'no']] }))).toBe(false);
    expect(isBridgeArea(polygon({ class: 'pedestrian' }))).toBe(false);
  });

  it('finds tree points and water decks', () => {
    expect(isTreePoint({ id: 't', props: { class: 'tree' }, geometry: { type: 'Point', coordinates: [0, 0] } })).toBe(true);
    expect(isTreePoint(polygon({ subtype: 'forest' }))).toBe(false);
    expect(isWaterDeck('infrastructure', polygon({ subtype: 'pier', class: 'pier' }))).toBe(true);
    expect(isWaterDeck('infrastructure', polygon({ class: 'marina' }))).toBe(false);
    expect(isWaterDeck('building', polygon({ class: 'pier' }))).toBe(false);
  });
});

describe('water classification', () => {
  it('prints rivers, not pools or centerlines', () => {
    expect(isPrintableWater(polygon({ subtype: 'river', class: 'river' }))).toBe(true);
    expect(isPrintableWater(polygon({ class: 'swimming_pool' }))).toBe(false);
    expect(isPrintableWater({ id: 'l', props: { class: 'river' }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } })).toBe(false);
  });

  it('needs generic water evidence for the untyped fallback', () => {
    for (const props of [{ class: 'water', subtype: 'water' }, { source_tags: [['natural', 'water']] }, { tags: { natural: 'water' } }, { natural: 'water' }]) {
      expect(isUntypedWater(polygon(props))).toBe(true);
    }
    for (const props of [
      {},
      { class: 'lake' },
      { class: 'water', subtype: 'river' },
      { class: 'water', water: 'reservoir' },
      { class: 'water', tags: { waterway: 'stream' } },
      { class: 'water', source_tags: [['water', 'swimming_pool']] },
      { class: 'water', amenity: 'fountain' },
    ]) {
      expect(isUntypedWater(polygon(props))).toBe(false);
    }
  });

  it('identifies ponds, fountains and basins by tags and classes, never by size', () => {
    for (const [tags, kind] of [
      [{ natural: 'water', water: 'pond' }, 'pond'],
      [{ amenity: 'fountain' }, 'fountain'],
      [{ natural: 'water', water: 'basin' }, 'basin'],
    ] as const) {
      for (const representation of [tags, Object.entries(tags), Object.entries(tags).map(([key, value]) => ({ key, value }))]) {
        expect(recessedWaterKind(polygon({ source_tags: representation }))).toBe(kind);
      }
    }
    for (const kind of ['pond', 'fountain', 'basin']) {
      expect(recessedWaterKind(polygon({ class: kind }))).toBe(kind);
      expect(recessedWaterKind(polygon({ class: 'water', subtype: kind }))).toBe(kind);
    }
    // A mapped basin may carry the broader subtype "reservoir".
    expect(recessedWaterKind(polygon({ class: 'basin', subtype: 'reservoir' }))).toBe('basin');
    expect(recessedWaterKind(polygon({ class: 'reservoir' }))).toBeNull();
    expect(recessedWaterKind(polygon({ class: 'pond', source_tags: { waterway: 'river' } }))).toBeNull();
  });
});

describe('linear referencing', () => {
  it('splits a partial bridge into two pieces covering the whole line', () => {
    const pieces = splitSegment('s', [[0, 0], [100, 0]], { class: 'primary', road_flags: [{ values: ['is_bridge'], between: [0.5, 1] }] });
    expect(pieces).toHaveLength(2);
    expect(pieces[0].flags.has('is_bridge')).toBe(false);
    expect(pieces[1].flags.has('is_bridge')).toBe(true);
    expect(pieces[1].points[0][0]).toBeCloseTo(50);
  });

  it('prefers an explicit width rule and falls back to the class default', () => {
    const explicit = splitSegment('s', [[0, 0], [10, 0]], { class: 'service', width_rules: [{ value: 7.5 }] });
    expect(explicit[0].widthM).toBe(7.5);
    const fallback = splitSegment('s', [[0, 0], [10, 0]], { class: 'motorway' });
    expect(fallback[0].widthM).toBe(14);
    const junk = splitSegment('s', [[0, 0], [10, 0]], { class: 'service', width_rules: [{ value: null }] });
    expect(junk[0].widthM).toBe(4.5);
  });

  it('reads levels, subclasses and tunnels per piece', () => {
    const pieces = splitSegment('s', [[0, 0], [100, 0]], {
      class: 'footway',
      level_rules: [{ value: -1, between: [0, 0.3] }],
      subclass_rules: [{ value: 'sidewalk', between: [0.3, 1] }],
      road_flags: [{ values: ['is_tunnel'], between: [0, 0.3] }],
    });
    expect(pieces).toHaveLength(2);
    expect(pieces[0].level).toBe(-1);
    expect(pieces[0].flags.has('is_tunnel')).toBe(true);
    expect(pieces[1].subclass).toBe('sidewalk');
  });

  it('reads one-way streets from their access restrictions', () => {
    const oneway = (rules: unknown[]) => splitSegment('s', [[0, 0], [100, 0]], { class: 'primary', access_restrictions: rules }).map((p) => p.oneway);
    expect(oneway([{ access_type: 'denied', when: { heading: 'backward' } }])).toEqual([1]);
    expect(oneway([{ access_type: 'denied', when: { heading: 'forward', mode: ['motor_vehicle'] } }])).toEqual([-1]);
    // Two-way for cars: only bicycles, only at rush hour, or a one-way stretch.
    expect(oneway([{ access_type: 'denied', when: { heading: 'backward', mode: ['bicycle'] } }])).toEqual([0]);
    expect(oneway([{ access_type: 'denied', when: { heading: 'backward', during: 'Mo-Fr 07:00-09:00' } }])).toEqual([0]);
    expect(oneway([{ access_type: 'denied', when: { heading: 'backward' }, between: [0.5, 1] }])).toEqual([0, 1]);
    expect(oneway([])).toEqual([0]);
  });

  it('ignores degenerate input and slices with interpolated ends', () => {
    expect(splitSegment('x', [[1, 1]], {})).toEqual([]);
    expect(splitSegment('x', [[1, 1], [1, 1]], {})).toEqual([]);
    const piece = slicePolyline([[0, 0], [50, 0], [100, 0]], 0.25, 0.75);
    expect(piece[0]).toEqual([25, 0]);
    expect(piece[piece.length - 1]).toEqual([75, 0]);
    expect(piece).toHaveLength(3);
  });
});
