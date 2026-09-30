// Picked roads on the real Canada Place tile: routes and roads left out.
import { readFileSync } from 'node:fs';
import type { Paths64 } from 'clipper2-ts';
import { describe, expect, it } from 'vitest';
import { compose } from './compose';
import { defaultRenderSettings } from './defaults';
import { TILE_EXTENT, worldToLonLat } from './geo/mercator';
import { computeLayout } from './layout/layout';
import { planTiles, prepareArea } from './prepare';
import { PICK_LAYERS, pickToWorld, sameLine, sanitizeLines, sanitizeRoutes, type LonLatLine, type PickLines, type SvgRoute } from './routes';
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

  it('drops lines that are not lon/lat', () => {
    expect(sanitizeLines([[[1, 2], [3, 4]], [[1, 2], [200, 4]], [[1, 2], ['a', 4]], 7])).toEqual([[[1, 2], [3, 4]]]);
  });

  it('tells the same road picked twice', () => {
    const a: LonLatLine = [[0, 0], [0.001, 0], [0.002, 0]];
    const b: LonLatLine = [[0.0000001, 0.00001], [0.002, 0.00001]];
    const c: LonLatLine = [[0.001, -0.001], [0.001, 0.001]];
    expect(sameLine(a, b)).toBe(true);
    expect(sameLine(a, c)).toBe(false);
  });
});
