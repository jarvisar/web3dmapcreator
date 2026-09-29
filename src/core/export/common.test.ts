import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE } from '../settings';
import { modelFilaments, preparePlates, writeOrder } from './common';
import { box, part, plate } from './test-helpers';

describe('writeOrder', () => {
  it('lists the terrain after the parts reaching into it and water after the terrain', () => {
    const mesh = box(0, 0, 0, 1, 1, 1);
    const model = preparePlates(
      [
        plate('Map', [
          part('terrain', 'Terrain', 'terrain', mesh),
          part('water', 'Water', 'water', mesh),
          part('land-green', 'Parks', 'green', mesh),
          part('roads', 'Roads', 'road', mesh),
          part('buildings', 'Buildings', 'building', mesh),
          part('trees', 'Trees', 'tree', mesh),
        ], [0, 0, 1, 1]),
      ],
      DEFAULT_PALETTE,
    );
    expect(writeOrder(model.plates[0].parts).map((p) => p.name)).toEqual(['Parks', 'Roads', 'Buildings', 'Trees', 'Terrain', 'Water']);
    // Filaments keep the model's order.
    expect(modelFilaments(model).filaments.map((f) => f.hex).slice(0, 2)).toEqual([DEFAULT_PALETTE.terrain.hex, DEFAULT_PALETTE.water.hex]);
  });
});
