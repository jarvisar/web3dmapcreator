import { describe, expect, it } from 'vitest';
import { ringArea } from '../geometry/polygon';
import { DEFAULT_AREA } from '../settings';
import {
  areaFromBounds,
  areaGeoBounds,
  areaGeoRing,
  areaModelRing,
  effectiveScale,
  modelSizeMm,
  parseBoundsText,
  parseLatLon,
  shapeRing,
  validateArea,
} from './area';
import { Projection } from './projection';

describe('Projection', () => {
  it('round-trips WGS84 through model millimetres', () => {
    const projection = new Projection([-87.63, 41.88], 23, 0.07);
    for (const [lon, lat] of [[-87.63, 41.88], [-87.61, 41.9], [-87.66, 41.86]]) {
      const [x, y] = projection.toModel(lon, lat);
      const [lon2, lat2] = projection.modelToGeo(x, y);
      // The inverse works on the tangent plane: well under a millimetre on the ground.
      expect(lon2).toBeCloseTo(lon, 7);
      expect(lat2).toBeCloseTo(lat, 7);
    }
  });

  it('measures real distances at the requested scale', () => {
    const projection = new Projection([0, 45], 0, 0.07);
    // One minute of latitude at 45 degrees is about 1852 m.
    const [, y] = projection.toModel(0, 45 + 1 / 60);
    expect(y / 0.07).toBeCloseTo(1852.3, 0);
  });

  it('points +Y along the area bearing', () => {
    const north = new Projection([10, 50], 0, 1);
    const east = new Projection([10, 50], 90, 1);
    const [nx, ny] = north.toLocal(10, 50.001);
    expect(nx).toBeCloseTo(0, 6);
    expect(ny).toBeGreaterThan(100);
    // With a bearing of 90 degrees, a point to the east is straight "up" in the model.
    const [ex, ey] = east.toLocal(10.001, 50);
    expect(ex).toBeCloseTo(0, 2);
    expect(ey).toBeGreaterThan(50);
  });
});

describe('area helpers', () => {
  it('builds counter-clockwise shapes that fit their box', () => {
    for (const shape of ['rectangle', 'rounded', 'circle', 'hexagon'] as const) {
      const ring = shapeRing(shape, 100, 80, 10);
      expect(ringArea(ring)).toBeGreaterThan(0);
      for (const [x, y] of ring) {
        expect(Math.abs(x)).toBeLessThanOrEqual(50 + 1e-9);
        expect(Math.abs(y)).toBeLessThanOrEqual(40 + 1e-9);
      }
    }
    // The hexagon has flat north and south sides.
    const hex = shapeRing('hexagon', 100, 100);
    expect(Math.max(...hex.map((p) => p[1]))).toBeCloseTo(50 * Math.sqrt(3) / 2, 9);
  });

  it('sizes the model from the scale mode', () => {
    const area = { ...DEFAULT_AREA, widthM: 2000, heightM: 1000 };
    expect(modelSizeMm(area, { mode: 'fixed', mmPerMetre: 0.07, fitMm: 180 })).toEqual({ width: 140, depth: 70 });
    expect(effectiveScale(area, { mode: 'fit', mmPerMetre: 0.07, fitMm: 180 })).toBeCloseTo(0.09);
    const ring = areaModelRing(area, 0.07);
    expect(Math.max(...ring.map((p) => p[0]))).toBeCloseTo(70);
  });

  it('turns a bounding box into an area of the same real size and back', () => {
    const bounds = { west: -87.64124, south: 41.87626, east: -87.61552, north: 41.89041 };
    const area = areaFromBounds(bounds);
    expect(area.widthM).toBeGreaterThan(2100);
    expect(area.widthM).toBeLessThan(2160);
    expect(area.heightM).toBeGreaterThan(1550);
    expect(area.heightM).toBeLessThan(1590);
    const back = areaGeoBounds(area);
    expect(back.west).toBeCloseTo(bounds.west, 3);
    expect(back.north).toBeCloseTo(bounds.north, 3);
    const ring = areaGeoRing(area);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('parses pasted bounds loosely but never guesses the order', () => {
    expect(parseBoundsText('bbox=-84.53576,39.08541,-84.48473,39.11475')).toEqual({
      west: -84.53576, south: 39.08541, east: -84.48473, north: 39.11475,
    });
    expect(parseBoundsText('[ -84.5 ; 39.0\t-84.4 39.1 ]').east).toBe(-84.4);
    expect(parseBoundsText('−84.5,39.0,−84.4,39.1').west).toBe(-84.5);
    expect(() => parseBoundsText('1,2,3')).toThrow(/found 3/);
    expect(() => parseBoundsText('1,5;2,5;3,5;4,5')).toThrow(/decimals/);
    expect(() => parseBoundsText('-84.4,39.1,-84.5,39.0')).toThrow(/East must be greater/);
    // A lat/lon swap can still be a legal box somewhere else, which is why the order is never guessed.
    expect(parseBoundsText('39.0,-84.5,39.1,-84.4').south).toBe(-84.5);
  });

  it('parses a typed latitude and longitude', () => {
    expect(parseLatLon('41.88, -87.63')).toEqual([-87.63, 41.88]);
    expect(parseLatLon('Chicago')).toBeNull();
    expect(parseLatLon('95, 10')).toBeNull();
  });

  it('rejects areas it cannot build', () => {
    expect(validateArea(DEFAULT_AREA)).toBeNull();
    expect(validateArea({ ...DEFAULT_AREA, widthM: 10 })).toMatch(/at least/);
    expect(validateArea({ ...DEFAULT_AREA, center: [179.99, 0], widthM: 5000 })).toMatch(/180th/);
    expect(validateArea({ ...DEFAULT_AREA, center: [0, 85] })).toMatch(/poles/);
  });
});
