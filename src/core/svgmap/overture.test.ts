import type { Paths64 } from 'clipper2-ts';
import { describe, expect, it } from 'vitest';
import type { OvertureFeature } from '../data/features';
import { defaultRenderSettings } from './defaults';
import { SCALE } from './fills';
import { lonLatToWorld, worldToLonLat } from './geo/mercator';
import { makeTransform } from './geo/transform';
import { computeLayout } from './layout/layout';
import { shapeCentre, shapePolygon } from './layout/shapes';
import { geometryDataset, isMissingFromOsm, missingBuildings, notInTiles, projectFootprints, windowBounds } from './overture';
import type { PreparedPolygon } from './prepare';
import { windowClipRect } from './prepare';

// Squares in Clipper units (microns), x/y and side in mm.
const square = (x: number, y: number, side: number, clockwise = false): Paths64[number] => {
  const ring = [
    { x: x * SCALE, y: y * SCALE },
    { x: (x + side) * SCALE, y: y * SCALE },
    { x: (x + side) * SCALE, y: (y + side) * SCALE },
    { x: x * SCALE, y: (y + side) * SCALE },
  ];
  return clockwise ? ring.reverse() : ring;
};
const tilePolygon = (rings: Paths64): PreparedPolygon => ({ layer: 'buildings', cls: 'building', flags: 0, rings });

describe('which Overture buildings are read', () => {
  it('goes by the source of the geometry', () => {
    expect(geometryDataset([{ property: '', dataset: 'Microsoft ML Buildings' }])).toBe('Microsoft ML Buildings');
    expect(geometryDataset([{ property: '/properties/height', dataset: 'OpenStreetMap' }, { property: null, dataset: 'Google Open Buildings' }])).toBe(
      'Google Open Buildings',
    );
    // No whole-feature source: the first.
    expect(geometryDataset([{ property: '/properties/height', dataset: 'Esri Community Maps' }])).toBe('Esri Community Maps');
    expect(geometryDataset([{ dataset: 'OpenStreetMap' }])).toBe('OpenStreetMap');
    expect(geometryDataset(undefined)).toBeUndefined();
    expect(geometryDataset([])).toBeUndefined();
    expect(geometryDataset([null])).toBeUndefined();
  });

  it('skips OSM and underground buildings', () => {
    expect(isMissingFromOsm({ sources: [{ dataset: 'OpenStreetMap' }] })).toBe(false);
    expect(isMissingFromOsm({ sources: [{ property: '', dataset: 'Microsoft ML Buildings' }] })).toBe(true);
    expect(isMissingFromOsm({ sources: [{ dataset: 'Microsoft ML Buildings' }], is_underground: true })).toBe(false);
    expect(isMissingFromOsm({ sources: [{ dataset: 'Microsoft ML Buildings' }], is_underground: false })).toBe(true);
    expect(isMissingFromOsm({})).toBe(true);
  });
});

describe('the map window in lon/lat', () => {
  const settings = defaultRenderSettings('laser');
  const layout = computeLayout(settings.product, settings.border);

  it('holds every corner of a turned window', () => {
    const area = { lon: -87.63, lat: 41.88, bearing: 33, widthM: 3000 };
    const transform = makeTransform(area, 14, shapeCentre(layout.window), layout.window.w);
    const bounds = windowBounds(transform, layout)!;
    for (const [x, y] of shapePolygon(layout.window)) {
      const [wx, wy] = transform.toWorld(x, y);
      const { lon, lat } = worldToLonLat(wx, wy, 14);
      expect(lon).toBeGreaterThanOrEqual(bounds.west - 1e-9);
      expect(lon).toBeLessThanOrEqual(bounds.east + 1e-9);
      expect(lat).toBeGreaterThanOrEqual(bounds.south - 1e-9);
      expect(lat).toBeLessThanOrEqual(bounds.north + 1e-9);
    }
    expect(bounds.west).toBeLessThan(area.lon);
    expect(bounds.east).toBeGreaterThan(area.lon);
  });

  it('gives up across the antimeridian', () => {
    const transform = makeTransform({ lon: 179.99, lat: -17, bearing: 0, widthM: 5000 }, 14, shapeCentre(layout.window), layout.window.w);
    expect(windowBounds(transform, layout)).toBeNull();
  });
});

describe('projecting footprints', () => {
  const settings = defaultRenderSettings('laser');
  const layout = computeLayout(settings.product, settings.border);
  const area = { lon: 2.35, lat: 48.85, bearing: 20, widthM: 2000 };
  const transform = makeTransform(area, 14, shapeCentre(layout.window), layout.window.w);
  const rect = windowClipRect(layout);
  const metres = (dx: number, dy: number): [number, number] => [area.lon + dx / (111320 * Math.cos((area.lat * Math.PI) / 180)), area.lat + dy / 110574];
  const box = (id: string, x: number, y: number, side: number): OvertureFeature => {
    const ring = [metres(x, y), metres(x + side, y), metres(x + side, y + side), metres(x, y + side), metres(x, y)];
    return { id, type: 'building', geometry: { type: 'Polygon', coordinates: [ring] }, bbox: [0, 0, 0, 0], props: {} };
  };

  it('puts a footprint where the tiles would', () => {
    const [footprint] = projectFootprints([box('a', 0, 0, 10)], transform, rect);
    const [wx, wy] = lonLatToWorld(area.lon, area.lat, 14);
    const [cx, cy] = transform.toCanvas(wx, wy);
    expect(footprint).toHaveLength(1);
    expect(footprint[0][0].x).toBeCloseTo(cx * SCALE, -1);
    expect(footprint[0][0].y).toBeCloseTo(cy * SCALE, -1);
    // 10 m at 2000 m over the window's width.
    const side = Math.hypot(footprint[0][1].x - footprint[0][0].x, footprint[0][1].y - footprint[0][0].y) / SCALE;
    expect(side).toBeCloseTo((10 / area.widthM) * layout.window.w, 2);
  });

  it('keeps every part of a multipolygon and leaves out what misses the window', () => {
    const a = box('a', 0, 0, 10);
    const b = box('b', 50, 50, 10);
    const multi: OvertureFeature = {
      ...a,
      id: 'multi',
      geometry: { type: 'MultiPolygon', coordinates: [(a.geometry as { coordinates: [number, number][][] }).coordinates, (b.geometry as { coordinates: [number, number][][] }).coordinates] },
    };
    const far = box('far', 50_000, 0, 10);
    const line: OvertureFeature = { ...a, id: 'line', geometry: { type: 'LineString', coordinates: [metres(0, 0), metres(10, 10)] } };
    const out = projectFootprints([multi, far, line], transform, rect);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(2);
  });
});

describe('leaving out what the tiles already have', () => {
  it('keeps footprints clear of tile buildings and drops ones mostly over them', () => {
    const tiles = [tilePolygon([square(0, 0, 10)])];
    const test = notInTiles(tiles);
    expect(test([square(20, 20, 2)])).toBe(true);
    // A tenth over a tile building: still added.
    expect(test([square(9.8, 0, 2)])).toBe(true);
    // Half over it: taken for the same building.
    expect(test([square(9, 0, 2)])).toBe(false);
    expect(test([square(2, 2, 2)])).toBe(false);
    // Nothing there to add.
    expect(test([[{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 2000, y: 0 }]])).toBe(false);
  });

  it('sees courtyards as open ground', () => {
    // A tile feature holding two buildings, one with a courtyard.
    const tiles = [tilePolygon([square(0, 0, 10), square(3, 3, 4, true), square(30, 0, 5)])];
    const test = notInTiles(tiles);
    expect(test([square(4, 4, 2)])).toBe(true);
    expect(test([square(31, 1, 2)])).toBe(false);
    expect(test([square(1, 1, 1)])).toBe(false);
  });

  it('works with no tile buildings at all', () => {
    expect(notInTiles([])([square(0, 0, 1)])).toBe(true);
    const added = missingBuildings([[square(0, 0, 1)], [square(5, 5, 1)]], []);
    expect(added).toHaveLength(2);
    expect(added[0]).toMatchObject({ layer: 'buildings', cls: 'building', flags: 0 });
  });

  it('copes with tile buildings spread over a large window', () => {
    const tiles: PreparedPolygon[] = [];
    for (let i = 0; i < 50; i++) tiles.push(tilePolygon([square(i * 20, i * 20, 5)]));
    tiles.push(tilePolygon([square(-500, -500, 1)]));
    const test = notInTiles(tiles);
    expect(test([square(400, 400, 2)])).toBe(false);
    expect(test([square(410, 400, 2)])).toBe(true);
    expect(test([square(-500, -500, 1)])).toBe(false);
    // Outside everything indexed.
    expect(test([square(5000, 5000, 1)])).toBe(true);
  });
});
