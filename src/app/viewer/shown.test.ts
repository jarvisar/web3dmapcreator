import { describe, expect, it } from 'vitest';
import { emptyEdits, type AddedShape, type ModelEdits } from '../../core/edit/types';
import { entryColour, SHAPES_PART } from './shown';

const layer = (id: string) => ({ id, name: id, hex: '#FF0000', line: 'PLA Basic' as const });
const shape = { id: 's', kind: 'box', layer: 'roads', at: [0, 0], points: [], rotationDeg: 0, sizeMm: 5, depthMm: 5, heightMm: 2, liftMm: 0, followGround: true, text: '', font: '' } as AddedShape;
const edits: ModelEdits = { ...emptyEdits(), layers: [layer('A')], objects: { 'b:2': { layer: 'A' } }, shapes: [shape] };

const shown = (key: string, hidden: string[], part?: string) => entryColour({ key, sub: '' }, { edits, hiddenParts: new Set(hidden), implicitHidden: new Set() }, false, part);

describe('hiding a part', () => {
  it('hides what is still in its colour', () => {
    expect(shown('b:1', [], 'buildings')).toBe('');
    expect(shown('b:1', ['buildings'], 'buildings')).toBeNull();
    expect(shown('b:1', ['terrain'], 'buildings')).toBe('');
  });

  it('leaves what was moved into a custom layer to that layer, as the export does', () => {
    expect(shown('b:2', ['buildings'], 'buildings')).toBe('layer:A');
    expect(shown('b:2', ['layer:A'], 'buildings')).toBeNull();
  });

  it('hides added shapes in a model colour with their own entry', () => {
    expect(shown('s:s', ['roads'], SHAPES_PART)).toBe('group:roads');
    expect(shown('s:s', [SHAPES_PART], SHAPES_PART)).toBeNull();
  });
});
