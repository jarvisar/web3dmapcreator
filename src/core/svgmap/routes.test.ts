// Picked roads on the real Canada Place tile: routes and roads left out.
import { readFileSync } from 'node:fs';
import type { Paths64 } from 'clipper2-ts';
import { describe, expect, it } from 'vitest';
import { compose } from './compose';
import { defaultRenderSettings } from './defaults';
import { TILE_EXTENT, worldToLonLat } from './geo/mercator';
import { computeLayout } from './layout/layout';
import { planTiles, prepareArea } from './prepare';
import {
  MAX_PICKED_POINTS,
  MAX_ROUTES,
  mergePicks,
  pickedPoints,
  PICK_LAYERS,
  pickToWorld,
  sameLine,
  sanitizeLines,
  sanitizeRoutes,
  withoutLines,
  type LonLatLine,
  type PickLines,
  type SvgRoute,
} from './routes';
import type { OutputMode, RenderSettings } from './settings';
import { toSvg } from './svg/writer';
import { type HersheyFile, parseHershey } from './text/hershey';

const tile = new Uint8Array(readFileSync(new URL('./fixtures/vancouver-14-2589-5606.pbf', import.meta.url)));
const centre = worldToLonLat(2589.5 * TILE_EXTENT, 5606.5 * TILE_EXTENT, 14);
const font = { kind: 'stroke' as const, font: parseHershey(JSON.parse(readFileSync('public/fonts/hershey/futural.json', 'utf8')) as HersheyFile) };

function render(mode: OutputMode, patch: Partial<RenderSettings> = {}) {
  const settings: RenderSettings = { ...defaultRenderSettings(mode), area: { lon: centre.lon, lat: centre.lat, bearing: 0, widthM: 1200 }, ...patch };
  settings.label = { ...settings.label, text: 'VANCOUVER', font: 'hershey-sans' };
  const layout = computeLayout(settings.product, settings.border);
  const plan = planTiles(settings.area, layout, settings.source);
  const prepared = prepareArea(plan, layout, new Map([['14/2589/5606', tile.buffer.slice(0)]]));
  return compose(settings, layout, prepared, { title: font, subtitle: font }, new Map<string, Paths64>());
}

/** The longest road the preview could pick, in lon/lat. */
function longestRoad(pick: PickLines): { line: number; lonLat: LonLatLine } {
  let best = -1;
  let bestLength = 0;
  for (let line = 0; line < pick.starts.length - 1; line++) {
    if (PICK_LAYERS[pick.layers[line]] !== 'roads') continue;
    let length = 0;
    for (let p = pick.starts[line] + 1; p < pick.starts[line + 1]; p++) {
      length += Math.hypot(pick.points[p * 2] - pick.points[p * 2 - 2], pick.points[p * 2 + 1] - pick.points[p * 2 - 1]);
    }
    if (length > bestLength) {
      bestLength = length;
      best = line;
    }
  }
  const lonLat: LonLatLine = [];
  for (let p = pick.starts[best]; p < pick.starts[best + 1]; p++) {
    const { lon, lat } = worldToLonLat(...pickToWorld(pick.transform, pick.points[p * 2], pick.points[p * 2 + 1]), pick.transform.zoom);
    lonLat.push([lon, lat]);
  }
  return { line: best, lonLat };
}

const route = (lines: LonLatLine[], patch: Partial<SvgRoute> = {}): SvgRoute => ({ id: 'r1', name: 'Race course', color: '#E4002B', width: 0.8, lines, ...patch });

describe('picked roads', () => {
  const plain = render('laser');
  const { line, lonLat } = longestRoad(plain.pick!);

  it('are offered to the preview with how to find them again', () => {
    const pick = plain.pick!;
    expect(pick.starts.length - 1).toBeGreaterThan(20);
    expect(pick.owners.every((owner) => owner === -2)).toBe(true);
    expect(line).toBeGreaterThanOrEqual(0);
    // Back to lon/lat and the same road.
    expect(sameLine(lonLat, lonLat)).toBe(true);
  });

  it('go into a group of their own, over the roads, in their colour', () => {
    const result = render('laser', { routes: [route([lonLat])] });
    const ids = result.groups.map((g) => g.id);
    expect(ids).toContain('route-1');
    expect(ids.indexOf('route-1')).toBeGreaterThan(ids.indexOf('roads'));
    const group = result.groups.find((g) => g.id === 'route-1')!;
    expect(group.color).toBe('#E4002B');
    expect(group.label).toBe('Race course');
    expect(result.pick!.owners[line]).toBe(0);
    // Taken out of the roads, not drawn twice.
    const roads = (r: typeof result) => r.groups.find((g) => g.id === 'roads')!.lengthMm;
    expect(roads(result)).toBeLessThan(roads(plain) - group.lengthMm * 0.5);
    expect(toSvg(result)).toContain('id="route-1"');
  });

  it('take the route width in print and the pen in the plotter', () => {
    expect(render('print', { routes: [route([lonLat], { width: 1.1 })] }).groups.find((g) => g.id === 'route-1')!.strokeWidth).toBe(1.1);
    const plotter = render('plotter', { routes: [route([lonLat])] });
    const group = plotter.groups.find((g) => g.id === 'route-1')!;
    expect(group.strokeWidth).toBe(plotter.groups.find((g) => g.id === 'roads')!.strokeWidth);
    // Its own pen.
    expect(toSvg(plotter)).toContain('#E4002B');
  });

  it('can be left out', () => {
    const result = render('laser', { hiddenLines: [lonLat] });
    expect(result.pick!.owners[line]).toBe(-1);
    const roads = (r: typeof result) => r.groups.find((g) => g.id === 'roads')!.lengthMm;
    expect(roads(result)).toBeLessThan(roads(plain));
    expect(result.groups.some((g) => g.id.startsWith('route-'))).toBe(false);
  });

  it("don't take in roads that only cross them", () => {
    const result = render('laser', { routes: [route([lonLat])] });
    const taken = [...result.pick!.owners].filter((owner) => owner === 0).length;
    // The road itself, and at most its continuation cut at a tile edge.
    expect(taken).toBeGreaterThanOrEqual(1);
    expect(taken).toBeLessThanOrEqual(3);
  });

  it('change nothing when there are none', () => {
    expect(toSvg(render('laser', { routes: [], hiddenLines: [] }))).toBe(toSvg(plain));
    expect(plain.missingPicks).toBeUndefined();
  });

  it('say which picks nothing on the map matched', () => {
    // A road across the harbour, well away from anything drawn.
    const away: LonLatLine = [
      [centre.lon + 0.03, centre.lat + 0.03],
      [centre.lon + 0.031, centre.lat + 0.03],
    ];
    const result = render('laser', { routes: [route([lonLat, away])] });
    expect(result.missingPicks).toEqual([away]);
    expect(result.pick!.owners[line]).toBe(0);
  });

  it('count a short pick lying along another as on the map', () => {
    // Picked first, so the whole road picked after wins every sample they share.
    const piece = lonLat.slice(0, 2);
    const result = render('laser', { routes: [route([piece, lonLat])] });
    expect(result.pick!.owners[line]).toBe(0);
    expect(result.missingPicks).toBeUndefined();
  });

  it('match a long pick at a large scale without filling its whole box', () => {
    // A road picked on a regional map: one segment tens of kilometres long,
    // here on a map 120 m across. Its box was millions of 2 mm cells.
    const regional: LonLatLine = [
      [centre.lon - 0.3, centre.lat - 0.2],
      [centre.lon + 0.3, centre.lat + 0.2],
    ];
    const big = render('laser', { area: { lon: centre.lon, lat: centre.lat, bearing: 0, widthM: 120 }, routes: [route([regional, lonLat])] });
    expect(big.groups.some((g) => g.id === 'route-1')).toBe(true);
  });
});

describe('sanitizing picks', () => {
  it('keeps good routes and drops the rest', () => {
    const routes = sanitizeRoutes([
      { id: 'a', name: ' Home ', color: '#ff0000', width: 99, lines: [[[1, 2], [1.001, 2.001]], [[1, 2]], 'x'] },
      { id: 'a', name: 'Duplicate', color: '#00ff00', lines: [] },
      { id: 'b', name: 'Bad colour', color: 'red', lines: [] },
      null,
    ]);
    expect(routes).toEqual([{ id: 'a', name: 'Home', color: '#FF0000', width: 5, lines: [[[1, 2], [1.001, 2.001]]] }]);
    expect(sanitizeRoutes('routes')).toEqual([]);
  });

  it('keeps the picks to a total number of points', () => {
    const line: LonLatLine = Array.from({ length: 1000 }, (_, i) => [i / 1e4, 0]);
    const lines = sanitizeLines(Array.from({ length: 80 }, () => line));
    expect(lines.length * 1000).toBeLessThanOrEqual(MAX_PICKED_POINTS);
    expect(lines.length).toBe(Math.floor(MAX_PICKED_POINTS / 1000));
    // Routes share one allowance.
    const routes = sanitizeRoutes([
      { id: 'a', color: '#FF0000', lines: Array.from({ length: 30 }, () => line) },
      { id: 'b', color: '#00FF00', lines: Array.from({ length: 30 }, () => line) },
    ]);
    expect(routes.reduce((n, r) => n + r.lines.length, 0) * 1000).toBeLessThanOrEqual(MAX_PICKED_POINTS);
  });

  it('drops lines that are not lon/lat', () => {
    expect(sanitizeLines([[[1, 2], [3, 4]], [[1, 2], [400, 4]], [[1, 2], [3, 95]], [[1, 2], ['a', 4]], 7])).toEqual([[[1, 2], [3, 4]]]);
  });

  it('keeps picks made past the antimeridian in their own frame', () => {
    // On a map centred at 179.999, the roads east of the line are at 180 and a bit.
    const across: LonLatLine = [
      [179.998, -16.79],
      [180.002, -16.79],
    ];
    expect(sanitizeLines([across])).toEqual([across]);
  });

  it('tells the same road picked twice', () => {
    const a: LonLatLine = [[0, 0], [0.001, 0], [0.002, 0]];
    const b: LonLatLine = [[0.0000001, 0.00001], [0.002, 0.00001]];
    const c: LonLatLine = [[0.001, -0.001], [0.001, 0.001]];
    expect(sameLine(a, b)).toBe(true);
    expect(sameLine(a, c)).toBe(false);
  });
});

describe('merging picks', () => {
  const road = (lat: number): LonLatLine => [[0, lat], [0.001, lat], [0.002, lat]];
  const route = (id: string, lines: LonLatLine[], color = '#E4002B'): SvgRoute => ({ id, name: id, color, width: 0.6, lines });

  it('adds theirs to ours', () => {
    const merged = mergePicks({ routes: [route('mine', [road(0)])], hiddenLines: [road(0.01)] }, { routes: [route('theirs', [road(0.02)], '#0057B8')], hiddenLines: [road(0.03)] });
    expect(merged.routes.map((r) => [r.id, r.lines.length])).toEqual([['mine', 1], ['theirs', 1]]);
    expect(merged.hiddenLines).toHaveLength(2);
    expect([merged.added, merged.replaced, merged.left]).toEqual([2, 0, 0]);
  });

  it('moves a road they put somewhere else out of ours, which counts as replaced', () => {
    const merged = mergePicks({ routes: [route('mine', [road(0)])], hiddenLines: [] }, { routes: [], hiddenLines: [[[0.0000001, 0.00001], [0.002, 0.00001]]] });
    expect(merged.routes[0].lines).toEqual([]);
    expect(merged.hiddenLines).toHaveLength(1);
    expect([merged.added, merged.replaced]).toEqual([1, 1]);
  });

  it('changes nothing for the same picks again', () => {
    const picks = { routes: [route('mine', [road(0), road(0.01)])], hiddenLines: [road(0.02)] };
    const merged = mergePicks(picks, structuredClone(picks));
    expect([merged.added, merged.replaced, merged.left]).toEqual([0, 0, 0]);
    expect(merged.routes[0].lines).toHaveLength(2);
    expect(merged.hiddenLines).toHaveLength(1);
    // Ours are left as they were.
    expect(picks.routes[0].lines).toHaveLength(2);
  });

  it('takes the name and colour of a route both have, and keeps its lines', () => {
    const merged = mergePicks({ routes: [route('r', [road(0)])], hiddenLines: [] }, { routes: [{ ...route('r', [road(0.01)], '#0057B8'), name: 'Race' }], hiddenLines: [] });
    expect(merged.routes).toHaveLength(1);
    expect(merged.routes[0]).toMatchObject({ name: 'Race', color: '#0057B8' });
    expect(merged.routes[0].lines).toHaveLength(2);
    expect(merged.replaced).toBe(1);
  });

  it('leaves out what of theirs goes over the limits', () => {
    const many = Array.from({ length: MAX_ROUTES }, (_, i) => route(`r${i}`, []));
    expect(mergePicks({ routes: many, hiddenLines: [] }, { routes: [route('more', [road(0)])], hiddenLines: [] }).left).toBe(1);
    const long: LonLatLine = Array.from({ length: 2000 }, (_, i) => [i * 1e-6, 0] as [number, number]);
    const full = Array.from({ length: MAX_PICKED_POINTS / 2000 }, (_, i) => long.map(([lon]) => [lon, i * 0.01] as [number, number]));
    const merged = mergePicks({ routes: [], hiddenLines: full }, { routes: [], hiddenLines: [road(5)] });
    expect([merged.added, merged.left]).toEqual([0, 1]);
    expect(pickedPoints(merged.routes, merged.hiddenLines)).toBe(MAX_PICKED_POINTS);
  });
});

describe('withoutLines', () => {
  it('takes out the same roads as comparing every pair, and a line too long to index', () => {
    let seed = 9;
    const random = () => {
      seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0;
      return ((seed >>> 0) % 1e6) / 1e6;
    };
    const m = 1 / 111_320;
    const street = (): LonLatLine => {
      const x = random() * 3000;
      const y = random() * 3000;
      const across = random() < 0.5;
      const out: LonLatLine = [];
      for (let d = 0; d <= 200; d += 20) out.push([-87.6 + (across ? x + d : x) * m * 1.35, 41.88 + (across ? y : y + d) * m]);
      return out;
    };
    const stored = Array.from({ length: 300 }, street);
    // A road across the whole city, whose box covers too many cells to index.
    const long: LonLatLine = Array.from({ length: 200 }, (_, i) => [-87.6 + i * 100 * m * 1.35, 41.88 + 1500 * m]);
    stored.push(long);
    const picked = [...Array.from({ length: 300 }, (_, i) => (i % 3 ? street() : stored[i].map(([lon, lat]) => [lon + m, lat] as [number, number]))), long];
    const expected = stored.filter((line) => !picked.some((p) => sameLine(line, p)));
    const kept = withoutLines(stored, picked);
    expect(kept).toEqual(expected);
    expect(kept).not.toContain(long);
    expect(stored.length - kept.length).toBeGreaterThan(100);
  });
});
