import { describe, expect, it } from 'vitest';
import { validateArea } from '../../core/geo/area';
import { DEFAULT_AREA } from '../../core/settings';
import { LATITUDE_LIMIT, normalizeArea } from './area';

describe('normalizeArea', () => {
  it('clamps a latitude to one validateArea takes', () => {
    for (const lat of [95, 85, LATITUDE_LIMIT + 1e-9, -89.9]) {
      const area = normalizeArea({ ...DEFAULT_AREA, center: [10, lat] });
      expect(Math.abs(area.center[1])).toBe(LATITUDE_LIMIT);
      expect(validateArea(area)).toBeNull();
    }
  });

  it('still rounds an ordinary centre to 1e-7 degrees', () => {
    expect(normalizeArea({ ...DEFAULT_AREA, center: [-87.628380123, 41.883335456] }).center).toEqual([-87.6283801, 41.8833355]);
  });
});
