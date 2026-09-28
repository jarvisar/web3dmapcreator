import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE, printerByKey, type Palette, type Printer } from '../settings';
import type { Plate } from '../types';
import { MODEL_PATH, preparePlates } from './common';
import { PRUSA_MODEL_CONFIG_PATH, prusaBedCell, prusaBedOrigin, writePrusaProject } from './prusa';
import { box, findAll, parseXml, part, plate, unzipText, type XmlNode } from './test-helpers';

async function write(plates: Plate[], palette: Palette, printer: Printer, title?: string) {
  const files = await unzipText(writePrusaProject(preparePlates(plates, palette), printer, title));
  return { files, model: parseXml(files[MODEL_PATH]), config: parseXml(files[PRUSA_MODEL_CONFIG_PATH]) };
}

function volumeMeta(volume: XmlNode, key: string): string | undefined {
  return volume.children.find((c) => c.tag === 'metadata' && c.attrs.key === key)?.attrs.value;
}

function translation(item: XmlNode): number[] {
  return item.attrs.transform.split(' ').slice(9).map((v) => Number(v) + 0);
}

describe('writePrusaProject', () => {
  const terrain = part('terrain', 'Terrain', 'terrain', box(-50, -40, -2, 100, 80, 2));
  const roads = part('roads', 'Roads', 'road', box(-50, -1, -0.15, 100, 2, 0.6));
  const buildings = part('buildings', 'Buildings', 'building', box(-10, -10, 0, 5, 5, 20), box(10, 10, 0, 4, 4, 8));
  const paved = part('paved', 'Paved', 'paved', box(0, 0, -0.15, 10, 10, 0.5));

  it('concatenates parts into one object and splits them into volumes by triangle range', async () => {
    const { files, model, config } = await write([plate('Map', [terrain, roads, buildings, paved], [-50, -40, 50, 40])], DEFAULT_PALETTE, printerByKey('MK4'), 'Loop');
    const objects = findAll(model, 'object');
    expect(objects.map((o) => [o.attrs.id, o.attrs.name, o.attrs.type])).toEqual([['1', 'Map', 'model']]);
    const vertices = findAll(objects[0], 'vertex');
    const triangles = findAll(objects[0], 'triangle');
    expect(vertices).toHaveLength(8 + 8 + 16 + 8);
    expect(triangles).toHaveLength(12 + 12 + 24 + 12);
    // Each part's indices point at its own vertices.
    const roadsFirst = triangles[12].attrs;
    expect([roadsFirst.v1, roadsFirst.v2, roadsFirst.v3]).toEqual(['8', '10', '9']);
    expect(triangles.at(-1)!.attrs.v3).toBe(String(8 + 8 + 16 + 7));

    const meta = Object.fromEntries(findAll(model, 'metadata').map((m) => [m.attrs.name, m.text]));
    expect(meta['slic3rpe:Version3mf']).toBe('1');
    expect(meta.Application).toBe('Jarvizar City Model');
    expect(meta.Title).toBe('Loop');
    expect(meta.Copyright).toContain('© OpenStreetMap contributors');
    expect(files[MODEL_PATH]).toContain('xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06"');

    const [object] = findAll(config, 'object');
    expect(object.attrs).toEqual({ id: '1', instances_count: '1' });
    const objectMeta = object.children.filter((c) => c.tag === 'metadata').map((m) => [m.attrs.type, m.attrs.key, m.attrs.value]);
    expect(objectMeta).toEqual([['object', 'name', 'Map'], ['object', 'extruder', '1']]);
    const volumes = findAll(object, 'volume').map((v) => [
      v.attrs.firstid, v.attrs.lastid, volumeMeta(v, 'name'), volumeMeta(v, 'volume_type'), volumeMeta(v, 'extruder'),
    ]);
    // Roads and paving share one colour, so one extruder.
    expect(volumes).toEqual([
      ['0', '11', 'Terrain', 'ModelPart', '1'],
      ['12', '23', 'Roads', 'ModelPart', '2'],
      ['24', '47', 'Buildings', 'ModelPart', '3'],
      ['48', '59', 'Paved', 'ModelPart', '2'],
    ]);
    expect(findAll(object, 'volume').every((v) => v.children.every((m) => m.attrs.type === 'volume'))).toBe(true);
    // No print config: it would replace the user's presets.
    expect(Object.keys(files).sort()).toEqual(['3D/3dmodel.model', 'Metadata/Slic3r_PE_model.config', '[Content_Types].xml', '_rels/.rels']);
    expect(files['_rels/.rels']).toContain('Target="/3D/3dmodel.model"');

    // Centred on the 250 x 210 bed with the lowest point on it.
    const items = findAll(model, 'item');
    expect(items.map((i) => [i.attrs.objectid, i.attrs.printable])).toEqual([['1', '1']]);
    expect(translation(items[0])).toEqual([125, 105, 2]);
  });

  it('puts sections on PrusaSlicer 2.9 beds', async () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(prusaBedCell)).toEqual([
      [0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [2, 1], [0, 2], [1, 2], [2, 2],
    ]);
    // MK4: the gap is 0.3 of the bed diagonal.
    const gap = Math.hypot(250, 210) * 0.3;
    expect(prusaBedOrigin(3, 250, 210)).toEqual([250 + gap, 210 + gap]);
    // XL: capped at 100 mm.
    expect(prusaBedOrigin(1, 360, 360)).toEqual([460, 0]);

    const cells: [number, number, number, number][] = [[-50, 0, 0, 40], [0, 0, 50, 40], [-50, -40, 0, 0], [0, -40, 50, 0]];
    const plates = cells.map((bounds, i) =>
      plate(`Section R${i < 2 ? 1 : 2} C${(i % 2) + 1}`, [part('terrain', 'Terrain', 'terrain', box(bounds[0], bounds[1], -2, 50, 40, 2))], bounds),
    );
    const { model, config } = await write(plates, DEFAULT_PALETTE, printerByKey('MK4'));
    expect(findAll(config, 'object').map((o) => o.attrs.id)).toEqual(['1', '2', '3', '4']);
    const items = findAll(model, 'item');
    items.forEach((item, i) => {
      const [bx, by] = prusaBedOrigin(i, 250, 210);
      const [tx, ty, tz] = translation(item);
      const [w, s, e, n] = cells[i];
      // Each section's centre lands on its bed's centre.
      expect(tx + (w + e) / 2).toBeCloseTo(bx + 125, 6);
      expect(ty + (s + n) / 2).toBeCloseTo(by + 105, 6);
      expect(tz).toBe(2);
    });
  });

  it('lays out more sections than PrusaSlicer has beds side by side', async () => {
    const plates = Array.from({ length: 10 }, (_, i) => {
      const bounds: [number, number, number, number] = [i * 20, 0, i * 20 + 20, 20];
      return plate(`Section R1 C${i + 1}`, [part('terrain', 'Terrain', 'terrain', box(i * 20, 0, 0, 20, 20, 1))], bounds);
    });
    const { model } = await write(plates, DEFAULT_PALETTE, printerByKey('MK4'));
    const xs = findAll(model, 'item').map((item, i) => translation(item)[0] + plates[i].bounds[0]);
    xs.slice(1).forEach((x, i) => expect(x - xs[i]).toBeCloseTo(30, 6));
  });
});
