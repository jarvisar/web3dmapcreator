import { describe, expect, it } from 'vitest';
import { rectangle } from './polygon';
import { RasterMask } from './raster';

describe('RasterMask', () => {
  it('keeps the asked cell on a normal model and coarsens a huge one', () => {
    expect(new RasterMask(rectangle(-200, -200, 200, 200), 0.1).cell).toBe(0.1);
    const huge = new RasterMask(rectangle(-1000, -1000, 1000, 1000), 0.1);
    expect(huge.cell).toBeGreaterThan(0.3);
    expect(huge.has(0, 0)).toBe(true);
    expect(huge.has(999, -999)).toBe(true);
    expect(huge.has(1001, 0)).toBe(false);
  });
});
