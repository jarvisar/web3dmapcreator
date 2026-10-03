import { describe, expect, it } from 'vitest';
import { Projection } from '../geo/projection';
import { pointInPolygon } from '../geometry/polygon';
import type { PrismSolid } from '../geometry/solid';
import { cloneSettings, type AreaSpec, type ModelSettings } from '../settings';
import type { TrackLines } from '../tracks/track';
import type { LonLat, Polygon, Vec2 } from '../types';
import { generateModel } from './generate';
import type { RoadPiece } from './roads';
import type { SourceData, SourceFeature } from './source';
import { holdUnderTracks, type SnappedTrack } from './tracks';

function piece(points: Vec2[], flags: string[] = []): RoadPiece {
  return { sourceId: 's', points, roadClass: 'residential', subclass: '', widthM: 0, flags: new Set(flags), level: 0, oneway: 0, group: 'road', widthMm: 0.5 };
}

function along(lines: Vec2[][], via: number[][]): SnappedTrack {
  return { track: { id: 't', name: 't', lines: [] }, lines, via: via.map((v) => Int32Array.from(v)), snapped: 1 };
}

describe('holdUnderTracks', () => {
  // A street along y = 0 with cross streets meeting it at x = 5 and 10.
  const street = piece([[0, 0], [2, 0], [5, 0], [7, 0], [10, 0], [15, 0]]);
  const crosses = [piece([[5, -5], [5, 0]]), piece([[10, 0], [10, 5]])];

  it('holds the whole block a route runs along, cut at the junctions on its own vertices', () => {
    const { pieces, held } = holdUnderTracks([street, ...crosses], [along([[[6, 0], [7, 0], [8, 0]]], [[0, 0]])], 0.07);
    expect(pieces.length).toBe(5);
    expect([...held].map((p) => p.points)).toEqual([[[5, 0], [7, 0], [10, 0]]]);
    // Nothing lost or added along the street.
    const parts = pieces.filter((p) => p.points[0][1] === 0 && p.points[1][1] === 0).map((p) => p.points);
    expect(parts).toEqual([[[0, 0], [2, 0], [5, 0]], [[5, 0], [7, 0], [10, 0]], [[10, 0], [15, 0]]]);
  });

  it('holds nothing past a junction the route only turns at', () => {
    // Up the cross street at x 5 and east from the junction, a hair past it before the next block.
    const track = along([[[5, -5], [5, 0], [5.001, 0]]], [[1, 0]]);
    const { pieces, held } = holdUnderTracks([street, ...crosses], [track], 0.07);
    expect([...held].map((p) => p.points)).toEqual([crosses[0].points]);
    expect(pieces).toContain(street);
  });

  it('holds a bridge whole, and leaves stretches off the roads alone', () => {
    const bridge = piece([[0, 0], [5, 0], [10, 0]], ['is_bridge']);
    const cross = piece([[5, 0], [5, 5]]);
    const { held } = holdUnderTracks([bridge, cross], [along([[[6, 0], [8, 0]]], [[0]])], 0.07);
    expect([...held]).toEqual([bridge]);
    const none = holdUnderTracks([bridge, cross], [along([[[6, 0], [8, 0]]], [[-1]])], 0.07);
    expect(none.held.size).toBe(0);
    expect(none.pieces).toEqual([bridge, cross]);
  });
});

// A divided street along y = 0, its carriageways 6 m either side, crossed
// every 200 m. The tidy merges it onto the middle.
const LAT = 45;
const LON = 0.01;
const M_LAT = 1 / 111320;
const M_LON = 1 / (111320 * Math.cos((LAT * Math.PI) / 180));
const at = (x: number, y: number): LonLat => [LON + x * M_LON, LAT + y * M_LAT];
const area: AreaSpec = { center: [LON, LAT], widthM: 1500, heightM: 800, rotationDeg: 0, shape: 'rectangle', cornerRadius: 0.1 };
const XS = [-700, -400, -200, 0, 200, 400, 700];

function divided(): SourceData {
  let id = 1;
  const feature = (coordinates: LonLat[], props: Record<string, unknown>): SourceFeature => ({ id: `f${id++}`, geometry: { type: 'LineString', coordinates }, props });
  const oneway = { access_restrictions: [{ access_type: 'denied', when: { heading: 'backward' } }] };
  return {
    release: 'test',
    features: {
      segment: [
        feature(XS.map((x) => at(x, 6)), { subtype: 'road', class: 'secondary', ...oneway }),
        feature([...XS].reverse().map((x) => at(x, -6)), { subtype: 'road', class: 'secondary', ...oneway }),
        ...XS.slice(1, -1).map((x) => feature([at(x, -300), at(x, -6), at(x, 6), at(x, 300)], { subtype: 'road', class: 'residential' })),
      ],
    },
  };
}

// A run along the north carriageway from 50 m to 150 m east, a few metres off it.
const run: TrackLines = { id: 'run', name: 'Run', lines: [Array.from({ length: 21 }, (_v, k) => at(50 + 5 * k, 7 + (k % 2 ? 2 : -2)))] };

async function build(tracks: TrackLines[], patch?: (s: ModelSettings) => void) {
  const settings = cloneSettings();
  settings.terrain.resolution = 64;
  patch?.(settings);
  return generateModel({ area, settings, data: divided(), elevation: null, tracks });
}

const projection = new Projection(area.center, 0, 0.07);
const covers = (solids: PrismSolid[], x: number, y: number) => {
  const [mx, my] = projection.toModel(...at(x, y));
  return solids.some((solid) => pointInPolygon(mx, my, solid.polygon as Polygon));
};
const layer = (spec: Awaited<ReturnType<typeof build>>, id: string) => (spec.layers.find((l) => l.id === id)?.solids ?? []) as PrismSolid[];

describe('routes and the road tidy', () => {
  it('snaps a route to the carriageway it ran along, which stays where it is, while the rest of the street merges', async () => {
    const spec = await build([run]);
    expect(spec.stats.network_merged_pairs).toBeGreaterThan(0);
    const routes = layer(spec, 'routes');
    const roads = layer(spec, 'roads');
    // On the north carriageway, not the merged middle.
    for (const x of [70, 100, 130]) {
      expect(covers(routes, x, 6)).toBe(true);
      expect(covers(routes, x, -4)).toBe(false);
      // The other carriageway stays beside it.
      expect(covers(roads, x, -6)).toBe(true);
    }
    // Blocks the route doesn't reach are still merged onto the middle.
    expect(covers(roads, -300, 0)).toBe(true);
    expect(covers(roads, 300, 0)).toBe(true);
  });

  it('lays the route the same with the tidy off', async () => {
    const on = layer(await build([run]), 'routes');
    const off = layer(await build([run], (s) => (s.roads.tidy = false)), 'routes');
    for (const x of [60, 100, 140]) for (const y of [0, 2, 6, 10]) expect(covers(on, x, y)).toBe(covers(off, x, y));
  });

  it('builds the same roads as before without routes', async () => {
    const a = await build([]);
    const b = await build([], (s) => (s.tracks.snap = false));
    expect(JSON.stringify(layer(a, 'roads').map((s) => s.polygon))).toBe(JSON.stringify(layer(b, 'roads').map((s) => s.polygon)));
    expect(covers(layer(a, 'roads'), 100, 0)).toBe(true);
  });
});
