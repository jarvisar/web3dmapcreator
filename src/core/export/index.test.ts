import { describe, expect, it } from 'vitest';
import type { ExportRequest } from '../engine/protocol';
import { DEFAULT_PALETTE } from '../settings';
import type { Plate } from '../types';
import { exportPlates, printablePlates } from './index';
import { box, part, plate, unzipText } from './test-helpers';

function request(format: ExportRequest['format'], extra: Partial<ExportRequest> = {}): ExportRequest {
  return {
    format,
    printer: 'P1S',
    palette: DEFAULT_PALETTE,
    multiPlate: false,
    sectionWidthMm: 210,
    sectionHeightMm: 210,
    fileBase: 'chicago',
    ...extra,
  };
}

function model(width = 150, depth = 110, height = 20): Plate[] {
  return [
    plate('Map', [
      part('terrain', 'Terrain', 'terrain', box(-width / 2, -depth / 2, 0, width, depth, 2)),
      part('roads', 'Roads', 'road', box(-width / 2, -1, 1.85, width, 2, 0.6)),
      part('buildings', 'Buildings', 'building', box(0, 0, 1.85, 5, 5, height - 1.85)),
    ], [-width / 2, -depth / 2, width / 2, depth / 2]),
  ];
}

describe('exportPlates', () => {
  it('names files and types by format', () => {
    const cases: [ExportRequest['format'], string, string][] = [
      ['bambu', 'chicago.3mf', 'model/3mf'],
      ['prusa', 'chicago.3mf', 'model/3mf'],
      ['3mf', 'chicago.3mf', 'model/3mf'],
      ['stl-zip', 'chicago-stl.zip', 'application/zip'],
      ['stl', 'chicago.stl', 'model/stl'],
    ];
    for (const [format, fileName, mime] of cases) {
      const result = exportPlates(model(), request(format));
      expect([result.fileName, result.mime, result.plates], format).toEqual([fileName, mime, 1]);
      expect(result.data.length).toBeGreaterThan(84);
    }
    const bambu = unzipText(exportPlates(model(), request('bambu')).data);
    expect(bambu['3D/3dmodel.model']).toContain('BambuStudio-02.00.00.00');
    expect(exportPlates(model(), request('bambu')).warnings).toEqual([]);
  });

  it('zips one STL per section for several plates', () => {
    const plates = [
      plate('Section R1 C1', [part('terrain', 'Terrain', 'terrain', box(0, 0, 0, 50, 50, 1))], [0, 0, 50, 50]),
      plate('Section R1 C2', [part('terrain', 'Terrain', 'terrain', box(50, 0, 0, 50, 50, 1))], [50, 0, 100, 50]),
    ];
    const result = exportPlates(plates, request('stl', { fileBase: 'a/b' }));
    expect([result.fileName, result.mime, result.plates]).toEqual(['a-b-stl.zip', 'application/zip', 2]);
    expect(Object.keys(unzipText(result.data))).toEqual(['a-b_R1C1.stl', 'a-b_R1C2.stl']);
  });

  it('leaves out hidden and empty parts and plates', () => {
    const plates = [...model(), plate('Empty', [{ ...part('water', 'Water', 'water', box(0, 0, 0, 1, 1, 1)), indices: new Uint32Array() }], [0, 0, 1, 1])];
    expect(printablePlates(plates, ['roads']).map((p) => [p.name, p.parts.map((q) => q.id)])).toEqual([['Map', ['terrain', 'buildings']]]);
    const result = exportPlates(plates, request('bambu', { excludeParts: ['roads'] }));
    expect(result.plates).toBe(1);
    const text = unzipText(result.data)['3D/3dmodel.model'];
    expect(text).not.toContain('name="Roads"');
    expect(text).toContain('name="Buildings"');
    expect(() => exportPlates(plates, request('stl', { excludeParts: ['terrain', 'roads', 'buildings'] }))).toThrow(/Nothing to export/);
  });

  it('warns when the model does not fit the bed', () => {
    expect(exportPlates(model(300, 200), request('3mf')).warnings).toEqual([
      'The model is 300 x 200 mm, larger than the Bambu Lab P1S bed (256 x 256 mm).',
    ]);
    expect(exportPlates(model(200, 170), request('3mf', { printer: 'MK4' })).warnings).toEqual([]);
    expect(exportPlates(model(200, 240), request('3mf', { printer: 'MK4' })).warnings).toEqual([
      'The model fits the Prusa MK4 / MK4S bed (250 x 210 mm) only when turned 90 degrees in the slicer.',
    ]);
    expect(exportPlates(model(150, 110, 300), request('stl')).warnings).toEqual([
      'The model is 300 mm tall, taller than the Bambu Lab P1S build height (250 mm).',
    ]);
  });

  it('starts a Bambu project for another printer from the P1S presets with its bed', () => {
    const result = exportPlates(model(), request('bambu', { printer: 'MK4' }));
    expect(result.warnings[0]).toBe(
      'Prusa MK4 / MK4S is not a Bambu Lab printer, so the project starts from the Bambu Lab P1S presets with a 250 x 210 mm bed.',
    );
    const project = JSON.parse(unzipText(result.data)['Metadata/project_settings.config']);
    expect(project.printer_model).toBe('Bambu Lab P1S');
    expect(project.printable_area).toEqual(['0x0', '250x0', '250x210', '0x210']);
    expect(project.printable_height).toBe('220');
  });

  it('tells PrusaSlicer users which extruder takes which colour', () => {
    const result = exportPlates(model(), request('prusa', { printer: 'MK4' }));
    expect(result.warnings).toEqual([
      'PrusaSlicer does not read colours from a 3MF. Set the extruder colours to match: ' +
        '1 Terrain (PLA Matte Ivory White, #FFFFFF), 2 Roads (PLA Basic Dark Gray, #545454), 3 Buildings (PLA Matte Caramel, #AE835B).',
    ]);
    const roles = ['terrain', 'building', 'road', 'water', 'green', 'forest', 'sand'] as const;
    const busy = [plate('Map', roles.map((role, i) => part(role, role, role, box(i, 0, 0, 1, 1, 1))), [0, 0, 7, 1])];
    const notes = exportPlates(busy, request('prusa', { printer: 'MK4' })).warnings;
    expect(notes[0]).toContain('4 Water (#5CB2D1)');
    expect(notes[1]).toBe('The model uses 7 filaments. An MMU3 or a Prusa XL holds at most 5, and parts on higher extruders print with the first one.');
  });
});
