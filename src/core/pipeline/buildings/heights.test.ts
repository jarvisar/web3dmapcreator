import { describe, expect, it } from 'vitest';
import { classDefaultHeight, estimatedHeight, lengthMetres, partHasUsefulVerticalData, resolveVerticalProfile } from './heights';

describe('resolveVerticalProfile', () => {
  it('prefers an explicit height', () => {
    const profile = resolveVerticalProfile({ height: 12, num_floors: 20 }, 3, 10);
    expect(profile.topM).toBe(12);
    expect(profile.heightSource).toBe('height');
  });

  it('uses the floor count, then the default, without randomness', () => {
    const floors = resolveVerticalProfile({ num_floors: 4 }, 3.2, 9);
    const a = resolveVerticalProfile({}, 3.2, 9);
    const b = resolveVerticalProfile({}, 3.2, 9);
    expect(floors.topM).toBe(12.8);
    expect(floors.heightSource).toBe('num_floors');
    expect(a).toEqual(b);
    expect(a.topM).toBe(9);
    expect(a.heightSource).toBe('default');
  });

  it('reads min_height, then min_floor', () => {
    const explicit = resolveVerticalProfile({ min_height: 4, min_floor: 3 }, 3, 10);
    const floors = resolveVerticalProfile({ min_floor: 2 }, 3, 10);
    expect([explicit.bottomM, explicit.minHeightSource]).toEqual([4, 'min_height']);
    expect([floors.bottomM, floors.minHeightSource]).toEqual([6, 'min_floor']);
  });
});

describe('absolute heights', () => {
  it('ends an elevated part at its stated height', () => {
    // Great American Tower is 202.7 m and its crown section is published as
    // min_height 140 / height 162.7. Adding those gives a 302.7 m spire.
    const crown = resolveVerticalProfile({ height: 162.7, min_height: 140 }, 3, 10);
    expect(crown.topM).toBeCloseTo(162.7, 10);
    expect(crown.bottomM).toBeCloseTo(140, 10);
    expect(crown.thicknessM).toBeCloseTo(22.7, 10);
  });

  it('makes a ground-founded mass as thick as it is tall', () => {
    const block = resolveVerticalProfile({ height: 40 }, 3, 10);
    expect([block.bottomM, block.topM, block.thicknessM]).toEqual([0, 40, 40]);
  });

  it('does not invent a taller top for an inverted interval', () => {
    const broken = resolveVerticalProfile({ height: 5, min_height: 9 }, 3, 10);
    expect(broken.bottomM).toBe(9);
    expect(broken.topM).toBe(5);
    expect(broken.thicknessM).toBeLessThan(0);
    expect(broken.heightSource).toContain('invalid_interval');
  });

  it('reads finite values and explicit units only', () => {
    for (const value of [Infinity, NaN, true, '20;40']) expect(resolveVerticalProfile({ height: value }, 3, 10).topM).toBe(10);
    expect(resolveVerticalProfile({ height: '100 ft' }, 3, 10).topM).toBeCloseTo(30.48, 10);
    expect(resolveVerticalProfile({ height: '7\'4"' }, 3, 10).topM).toBeCloseTo(2.2352, 10);
    expect(lengthMetres('12 m')).toBe(12);
    expect(lengthMetres(' 12.5metres ')).toBe(12.5);
    expect(lengthMetres('18')).toBe(18);
    expect(lengthMetres(-5)).toBeNull();
    expect(lengthMetres('5 furlongs')).toBeNull();
    expect(lengthMetres([20, 40])).toBeNull();
  });

  it('reads heights and floor counts past any real building as missing', () => {
    const typo = resolveVerticalProfile({ height: 3000, num_floors: 12 }, 3, 10);
    expect([typo.topM, typo.heightSource, typo.implausible]).toEqual([36, 'num_floors', true]);
    const floors = resolveVerticalProfile({ num_floors: 900, class: 'office' }, 3, 10);
    expect([floors.topM, floors.heightSource]).toEqual([20, 'class_default:office']);
    const base = resolveVerticalProfile({ height: 30, min_height: 2500 }, 3, 10);
    expect([base.bottomM, base.minHeightSource]).toEqual([0, 'ground']);
    expect(resolveVerticalProfile({ height: 828, num_floors: 163 }, 3, 10).implausible).toBe(false);
  });

  it('treats OSM levels as top levels, not added to the minimum', () => {
    const profile = resolveVerticalProfile({ 'building:levels': 10, 'building:min_level': 8 }, 3, 10);
    expect([profile.bottomM, profile.topM]).toEqual([24, 30]);
  });
});

describe('class default heights', () => {
  it('does not make a heightless stadium a single storey', () => {
    const stadium = resolveVerticalProfile({ class: 'stadium' }, 3, 10);
    expect(stadium.topM).toBe(30);
    expect(stadium.heightSource).toBe('class_default:stadium');
  });

  it('does not make a heightless shed a stadium', () => {
    expect(resolveVerticalProfile({ class: 'shed' }, 3, 10).topM).toBe(3);
  });

  it('lets an explicit height win over the class', () => {
    const profile = resolveVerticalProfile({ class: 'stadium', height: 21 }, 3, 10);
    expect([profile.topM, profile.heightSource]).toEqual([21, 'height']);
  });

  it('falls back to the configured default for an unknown class', () => {
    expect(classDefaultHeight({ class: 'spaceport' }, 9)).toEqual([9, 'default']);
    expect(classDefaultHeight({ class: 'constructor' }, 9)).toEqual([9, 'default']);
  });

  it('consults the subtype when the class says nothing', () => {
    expect(classDefaultHeight({ subtype: 'residential' }, 9)).toEqual([12, 'class_default:residential']);
  });
});

describe('useful vertical data', () => {
  it('needs a height or floor count with a real interval', () => {
    expect(partHasUsefulVerticalData({ height: 8 })).toBe(true);
    expect(partHasUsefulVerticalData({ num_floors: 2 })).toBe(true);
    expect(partHasUsefulVerticalData({ class: 'stadium' })).toBe(false);
    expect(partHasUsefulVerticalData({ min_height: 200 })).toBe(false);
    expect(partHasUsefulVerticalData({ height: 5, min_height: 9 })).toBe(false);
  });

  it('recognises derived height estimates by their source', () => {
    expect(estimatedHeight({ sources: [{ property: '/properties/height', dataset: 'Microsoft ML Buildings' }] })).toBe(true);
    expect(estimatedHeight({ sources: [{ property: '/properties/height', dataset: 'OpenStreetMap' }] })).toBe(false);
    expect(estimatedHeight({ sources: [{ property: '', dataset: 'USGS Lidar' }] })).toBe(false);
    expect(estimatedHeight({})).toBe(false);
  });
});
