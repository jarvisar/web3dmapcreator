// Renders Chicago from live tiles. Needs the network, so it only runs with
// NETWORK=1. Set SVG_OUT to a folder to keep the SVGs.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RenderService } from './service';
import type { OutputMode, RenderSettings } from './settings';
import { toSvg } from './svg/writer';
import { defaultRenderSettings } from './defaults';

const network = Boolean(process.env.NETWORK);
const outDir = process.env.SVG_OUT;

const service = new RenderService(async (path) => {
  const bytes = readFileSync(join('public', path));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
});

async function renderTo(name: string, settings: RenderSettings) {
  const started = performance.now();
  const result = await service.render({ settings });
  const svg = toSvg(result);
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${name}.svg`), svg);
    writeFileSync(join(outDir, `${name}.json`), JSON.stringify({ stats: result.stats, warnings: result.warnings, meta: result.meta, groups: result.groups.map((g) => ({ id: g.id, subpaths: g.subpaths, lengthMm: Math.round(g.lengthMm), areaMm2: Math.round(g.areaMm2) })) }, null, 2));
  }
  return { result, svg, ms: Math.round(performance.now() - started) };
}

describe.skipIf(!network)('live render', () => {
  for (const mode of ['laser', 'plotter', 'print'] as OutputMode[]) {
    it(`renders the Chicago Loop for ${mode}`, { timeout: 120_000 }, async () => {
      const { result, svg, ms } = await renderTo(`chicago-${mode}`, defaultRenderSettings(mode));
      console.log(mode, `${ms} ms`, result.stats.timings, result.warnings);
      expect(svg).toContain('width="177.8mm"');
      const ids = result.groups.map((g) => g.id);
      expect(ids).toEqual(expect.arrayContaining(['water', 'buildings', 'roads']));
      expect(result.warnings.filter((w) => w.includes('could not be downloaded'))).toEqual([]);
    });
  }

  // OSM has a few hundred buildings here and Overture thousands of ML ones.
  it('adds the buildings OSM lacks from Overture', { timeout: 180_000 }, async () => {
    const settings = defaultRenderSettings('laser');
    settings.area = { lon: -99.063, lat: 19.357, bearing: 0, widthM: 1500 };
    const off = await renderTo('iztapalapa-osm', settings);
    settings.source = { ...settings.source, overtureBuildings: true };
    const on = await renderTo('iztapalapa-overture', settings);
    console.log('Overture buildings', on.ms, 'ms', on.result.stats.overtureBuildings, on.result.warnings);
    const area = (r: typeof on) => r.result.groups.find((g) => g.id === 'buildings')!.areaMm2;
    expect(on.result.warnings).toEqual([]);
    expect(on.result.stats.overtureBuildings).toBeGreaterThan(1000);
    expect(area(on)).toBeGreaterThan(2 * area(off));
    expect(on.svg).toContain('Overture Maps Foundation');
  });
});
