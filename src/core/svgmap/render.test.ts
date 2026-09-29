// Full render of one real tile (Canada Place, Vancouver) without the network.
import { readFileSync } from 'node:fs';
import type { Paths64 } from 'clipper2-ts';
import { describe, expect, it } from 'vitest';
import { type ComposeFonts, compose } from './compose';
import { defaultRenderSettings } from './defaults';
import { TILE_EXTENT, worldToLonLat } from './geo/mercator';
import { computeLayout } from './layout/layout';
import { insetShape, shapeContains } from './layout/shapes';
import { planTiles, prepareArea } from './prepare';
import type { OutputMode, RenderSettings } from './settings';
import { toSvg } from './svg/writer';
import { type HersheyFile, parseHershey } from './text/hershey';
import { parseOutlineFont } from './text/loadFont';
import { acceptPolygon } from './tiles/schema';
import { areaMm2, intersectWith, resolveSurfaces, unionAll } from './fills';

const tile = new Uint8Array(readFileSync(new URL('./fixtures/vancouver-14-2589-5606.pbf', import.meta.url)));
const centre = worldToLonLat(2589.5 * TILE_EXTENT, 5606.5 * TILE_EXTENT, 14);
const font = { kind: 'stroke' as const, font: parseHershey(JSON.parse(readFileSync('public/fonts/hershey/futural.json', 'utf8')) as HersheyFile) };

function render(mode: OutputMode, patch: Partial<RenderSettings> = {}, fonts: ComposeFonts = { title: font, subtitle: font }) {
  const settings: RenderSettings = {
    ...defaultRenderSettings(mode),
    area: { lon: centre.lon, lat: centre.lat, bearing: 0, widthM: 1200 },
    ...patch,
  };
  settings.label = { ...settings.label, text: 'VANCOUVER', font: 'hershey-sans' };
  const layout = computeLayout(settings.product, settings.border);
  const plan = planTiles(settings.area, layout, settings.source);
  const prepared = prepareArea(plan, layout, new Map([['14/2589/5606', tile.buffer.slice(0)]]));
  const result = compose(settings, layout, prepared, fonts, new Map<string, Paths64>());
  return { settings, plan, prepared, result };
}

describe('rendering a real tile', () => {
  const laser = render('laser');

  it('needs only the one tile', () => {
    expect(laser.plan.tiles).toEqual([{ z: 14, x: 2589, y: 5606 }]);
  });

  it('draws every layer the tile has', () => {
    const ids = laser.result.groups.map((g) => g.id);
    expect(ids).toEqual(expect.arrayContaining(['water', 'buildings', 'roads', 'paths', 'text', 'frame', 'band', 'border', 'cut']));
    expect(laser.result.warnings).toEqual([]);
  });

  it('cuts the piers and the buildings on them out of the ocean', () => {
    const { prepared, settings } = laser;
    const union = (layer: string) =>
      unionAll(prepared.polygons.filter((p) => p.layer === layer && acceptPolygon(p, settings.filters)).flatMap((p) => p.rings));
    const water = union('water');
    const decks = union('decks');
    const buildings = union('buildings');
    const out = resolveSurfaces(
      { buildings, decks, water, aeroways: [], rocks: [], sand: [], greens: union('greens'), waterGaps: [] },
      { waterHalo: settings.water.halo },
    );
    const piersOverWater = areaMm2(intersectWith(decks, water));
    expect(piersOverWater).toBeGreaterThan(1);
    expect(areaMm2(water) - areaMm2(out.water)).toBeGreaterThan(piersOverWater);
    expect(areaMm2(intersectWith(out.water, unionAll([...buildings, ...decks])))).toBeCloseTo(0, 6);
    const layers = [out.water, out.buildings, out.decks, out.greens];
    const sum = layers.reduce((a, l) => a + areaMm2(l), 0);
    // Only micron-grid rounding separates the two.
    expect(Math.abs(areaMm2(unionAll(layers.flat())) - sum)).toBeLessThan(sum * 1e-6);
  });

  it('writes a millimetre-sized SVG with one layer per group', () => {
    const svg = toSvg(laser.result);
    expect(svg).toContain('width="177.8mm" height="127mm" viewBox="0 0 177.8 127"');
    expect(svg.match(/inkscape:groupmode="layer"/g)?.length).toBe(laser.result.groups.length);
  });

  it('groups plotter output into numbered pen layers', () => {
    const { result } = render('plotter');
    expect(result.groups.every((g) => g.kind === 'stroke')).toBe(true);
    const svg = toSvg(result);
    const pens = new Set(result.groups.map((g) => g.color)).size;
    expect(svg.match(/inkscape:label="\d+ - pen /g)?.length).toBe(pens);
    expect(result.stats.plotter!.penUpMm).toBeLessThan(result.stats.plotter!.penUpUnorderedMm);
  });

  it('gives an outline title and a single-line subtitle their own groups', () => {
    const bytes = readFileSync('public/fonts/Montserrat-SemiBold.ttf');
    const montserrat = parseOutlineFont(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const defaults = defaultRenderSettings('laser');
    const { result } = render('laser', { label: { ...defaults.label, style: 'band', subtitle: '49.2826° N' } }, { title: montserrat, subtitle: font });
    const ids = result.groups.map((g) => g.id);
    expect(ids).toEqual(expect.arrayContaining(['text', 'text-lines']));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('finishes with a pen width of zero', () => {
    const { result } = render('plotter', { plotter: { penWidth: 0, optimize: true } });
    expect(result.groups.find((g) => g.id === 'band')!.strokeWidth).toBe(0.05);
  });

  it('copes with very fine hatching and zero cleanup tolerances', () => {
    const plotter = defaultRenderSettings('plotter');
    const hatch = { ...plotter.style.hatch, buildings: { spacing: 0, angle: 45, cross: true } };
    const fine = render('plotter', { style: { ...plotter.style, hatch } });
    expect(fine.result.groups.find((g) => g.id === 'buildings')!.subpaths).toBeGreaterThan(1000);
    const loose = render('laser', { cleanup: { ...plotter.cleanup, lineSpacing: -1, weldTolerance: 0, snapGap: 0 } });
    expect(loose.result.groups.some((g) => g.id === 'roads')).toBe(true);
  });

  it('refuses a map width of zero', () => {
    const settings = defaultRenderSettings('laser');
    const layout = computeLayout(settings.product, settings.border);
    expect(() => planTiles({ ...settings.area, widthM: 0 }, layout, settings.source)).toThrow(/more than zero/);
  });

  it('keeps both sides of a map that crosses the antimeridian', () => {
    const settings = defaultRenderSettings('laser');
    const layout = computeLayout(settings.product, settings.border);
    const plan = planTiles({ lon: 179.995, lat: 49.28, bearing: 0, widthM: 3000 }, layout, settings.source);
    expect(plan.tiles.some((t) => t.x === 0)).toBe(true);
    // Any real tile will do. Only where its lines end up matters.
    const data = new Map(plan.tiles.map((t) => [`${t.z}/${t.x}/${t.y}`, tile.buffer.slice(0)] as const));
    const prepared = prepareArea(plan, layout, data);
    const centreX = layout.window.x + layout.window.w / 2;
    const xs = prepared.lines.flatMap((l) => l.path.map(([x]) => x));
    expect(xs.some((x) => x > centreX + 20)).toBe(true);
    expect(xs.some((x) => x < centreX - 20)).toBe(true);
  });

  it('never plans more tiles than the hard limit', () => {
    const settings = defaultRenderSettings('laser');
    const layout = computeLayout(settings.product, settings.border);
    const plan = planTiles({ lon: 0, lat: 45, bearing: 0, widthM: 400_000 }, layout, { ...settings.source, maxTiles: 1e9 });
    expect(plan.tiles.length).toBeLessThanOrEqual(2000);
    expect(plan.zoom).toBeLessThan(14);
    expect(plan.warnings).toHaveLength(1);
  });

  it('keeps everything inside a hexagonal piece', () => {
    const piece = render('plotter', {
      product: { shape: 'hexagon', width: 120, height: 120, cornerRadius: 0, margins: { top: 2, right: 2, bottom: 2, left: 2 } },
    });
    const layout = computeLayout(piece.settings.product, piece.settings.border);
    const edge = insetShape(layout.canvas, -0.001);
    for (const group of piece.result.groups) {
      for (const p of group.paths) {
        for (const [, x, y] of p.d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)) expect(shapeContains(edge, [Number(x), Number(y)])).toBe(true);
      }
    }
    expect(piece.result.groups.map((g) => g.id)).toEqual(expect.arrayContaining(['buildings', 'roads', 'band', 'border']));
  });

  it('keeps everything inside a round piece', () => {
    const coaster = render('laser', {
      product: { shape: 'circle', width: 100, height: 100, cornerRadius: 0, margins: { top: 2, right: 2, bottom: 2, left: 2 } },
    });
    for (const group of coaster.result.groups) {
      for (const p of group.paths) {
        for (const [, x, y] of p.d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)) {
          expect(Math.hypot(Number(x) - 50, Number(y) - 50)).toBeLessThanOrEqual(50.001);
        }
      }
    }
  });
});
