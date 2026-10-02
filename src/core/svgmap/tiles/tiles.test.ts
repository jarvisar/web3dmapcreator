import { readFileSync } from 'node:fs';
import { area } from 'clipper2-ts';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS } from '../settings';
import { clipPolylineToBox, decodeTile } from './decode';
import { FLAG, acceptLine, acceptPolygon, classifyLine, classifyPolygon } from './schema';
import { stitchSeams } from './stitch';
import { encodeTile } from './test-helpers';

describe('clipping to a tile', () => {
  it('puts cut ends exactly on the tile edge', () => {
    const [piece] = clipPolylineToBox([[4000, 1000.3], [4200, 1100.7]], 0, 0, 4096, 4096);
    expect(piece[1][0]).toBe(4096);
  });

  it('drops lines outside the tile', () => {
    expect(clipPolylineToBox([[5000, 10], [6000, 10]], 0, 0, 4096, 4096)).toEqual([]);
  });
});

describe('clipping polygons to a tile', () => {
  it('gives each piece left inside the tile its own ring', () => {
    // A U whose bar is past the right edge, so the clip leaves two prongs.
    // Joined by edges along the tile edge, they left hairline cracks once a
    // rotated map rounded the points.
    const u: [number, number][] = [[3900, 1000], [4200, 1000], [4200, 1400], [3900, 1400], [3900, 1300], [4150, 1300], [4150, 1100], [3900, 1100]];
    const [polygon] = decodeTile(encodeTile('building', u), 0, 0).polygons;
    expect(polygon.rings).toHaveLength(2);
    for (const ring of polygon.rings) {
      expect(ring).toHaveLength(4);
      expect(Math.abs(area(ring))).toBe(197 * 100);
    }
  });
});

describe('stitching tile seams', () => {
  it('rejoins the two halves of a road cut at a tile edge', () => {
    const lines = [
      { key: 'roads|secondary', path: [[4000, 100] as [number, number], [4096, 100.4] as [number, number]] },
      { key: 'roads|secondary', path: [[4096, 100.9] as [number, number], [4200, 102] as [number, number]] },
    ];
    expect(stitchSeams(lines)).toBe(1);
    expect(lines[0].path[1]).toEqual(lines[1].path[0]);
  });

  it('never joins different kinds of line', () => {
    const lines = [
      { key: 'roads|secondary', path: [[4000, 100] as [number, number], [4096, 100] as [number, number]] },
      { key: 'paths|footway', path: [[4096, 100.5] as [number, number], [4200, 102] as [number, number]] },
    ];
    expect(stitchSeams(lines)).toBe(0);
  });

  it('only joins ends from opposite sides of the seam', () => {
    const lines = [
      { key: 'roads|minor', path: [[4000, 100] as [number, number], [4096, 100] as [number, number]] },
      { key: 'roads|minor', path: [[4010, 300] as [number, number], [4096, 100.5] as [number, number]] },
    ];
    expect(stitchSeams(lines)).toBe(0);
  });
});

describe('schema', () => {
  it('ranks roads like the reference pipeline', () => {
    expect(classifyLine('transportation', { class: 'motorway' })?.rank).toBe(0);
    expect(classifyLine('transportation', { class: 'minor' })?.rank).toBe(6);
    expect(classifyLine('transportation', { class: 'path', subclass: 'footway' })).toMatchObject({ layer: 'paths', rank: 11 });
    expect(classifyLine('transportation', { class: 'path', subclass: 'pedestrian' })).toMatchObject({ layer: 'roads', rank: 7 });
  });

  it('skips what should never be drawn', () => {
    expect(classifyLine('transportation', { class: 'ferry' })).toBeNull();
    expect(classifyLine('transportation', { class: 'primary_construction' })).toBeNull();
    expect(classifyLine('transportation', { class: 'path', subclass: 'corridor' })).toBeNull();
    expect(classifyLine('transportation', { class: 'minor', indoor: 1 })).toBeNull();
  });

  it('filters by the user settings', () => {
    const tunnel = classifyLine('transportation', { class: 'secondary', brunnel: 'tunnel' })!;
    expect(tunnel.flags & FLAG.tunnel).toBeTruthy();
    expect(acceptLine(tunnel, DEFAULT_FILTERS)).toBe(false);
    expect(acceptLine(tunnel, { ...DEFAULT_FILTERS, skipTunnels: false })).toBe(true);
    const aisle = classifyLine('transportation', { class: 'service', service: 'parking_aisle' })!;
    expect(acceptLine(aisle, DEFAULT_FILTERS)).toBe(false);
    const pool = classifyPolygon('water', { class: 'swimming_pool' })!;
    expect(acceptPolygon(pool, DEFAULT_FILTERS)).toBe(false);
  });

  it('treats piers and plazas as decks and culverts as not water', () => {
    expect(classifyPolygon('transportation', { class: 'pier' })?.layer).toBe('decks');
    expect(classifyPolygon('transportation', { class: 'path', subclass: 'pedestrian' })?.layer).toBe('decks');
    expect(classifyPolygon('water', { class: 'river', brunnel: 'tunnel' })).toBeNull();
  });
});

describe('decoding a real tile', () => {
  const buffer = readFileSync(new URL('../fixtures/vancouver-14-2589-5606.pbf', import.meta.url));
  const tile = decodeTile(new Uint8Array(buffer), 2589, 5606);

  it('reads lines inside the tile only', () => {
    expect(tile.lines.length).toBeGreaterThan(100);
    const x0 = 2589 * 4096;
    const y0 = 5606 * 4096;
    for (const line of tile.lines) {
      for (const [x, y] of line.path) {
        expect(x).toBeGreaterThanOrEqual(x0);
        expect(x).toBeLessThanOrEqual(x0 + 4096);
        expect(y).toBeGreaterThanOrEqual(y0);
        expect(y).toBeLessThanOrEqual(y0 + 4096);
      }
    }
  });

  it('finds the ocean, the piers and the buildings', () => {
    const classes = tile.polygons.map((p) => classifyPolygon(p.layer, p.props)).filter(Boolean);
    expect(classes.some((c) => c!.layer === 'water' && c!.cls === 'ocean')).toBe(true);
    expect(classes.some((c) => c!.layer === 'decks' && c!.cls === 'pier')).toBe(true);
    expect(classes.filter((c) => c!.layer === 'buildings').length).toBeGreaterThan(100);
  });
});
