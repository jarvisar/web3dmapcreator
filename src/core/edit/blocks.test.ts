// Road edits by range: keys, what applies where, and writing them.

import { describe, expect, it } from 'vitest';
import { addSplit, blockAt, blockBounds, editAt, editOver, normalRoadKey, parseRoadKey, removeSplit, roadEditOf, roadEdits, roadKey, roadSegment, writeRoads } from './blocks';
import { sanitizeEdits, type ModelEdits } from './types';

const S = 'r:abc';
type Objects = ModelEdits['objects'];

describe('road range keys', () => {
  it('reads and writes ranges, with the whole segment as its own key', () => {
    expect(roadKey(S, 0, 1)).toBe(S);
    expect(roadKey(S, 0.25, 0.5)).toBe('r:abc@0.25-0.5');
    expect(roadKey(S, 0.123456789, 1)).toBe('r:abc@0.12346-1');
    expect(parseRoadKey('r:abc@0.25-0.5')).toEqual({ segment: S, from: 0.25, to: 0.5 });
    expect(parseRoadKey(S)).toEqual({ segment: S, from: 0, to: 1 });
    expect(parseRoadKey('br:abc')).toBeNull();
    expect(parseRoadKey('r:abc@0.5-0.25')).toBeNull();
    expect(parseRoadKey('r:abc@x-1')).toBeNull();
    expect(roadSegment('r:abc@0.25-0.5')).toBe(S);
    expect(roadSegment('b:x/y')).toBe('b:x/y');
    expect(normalRoadKey('r:abc@0.250000-0.50')).toBe('r:abc@0.25-0.5');
    expect(normalRoadKey('r:abc@0-1')).toBe(S);
  });

  it('keeps range keys and splits through sanitizing, written one way', () => {
    const edits = sanitizeEdits({
      layers: [{ id: 'L', name: 'Red', hex: '#ff0000' }],
      objects: {
        'r:abc@0.2500-0.5': { layer: 'L' },
        'r:abc@0.9-0.1': { layer: 'L' },
        'r:abc@0-1': { widthMm: 2 },
        'r:def': { splits: [0.5, 0.25, 0.25, 2, -1, 'x'] },
        'r:def@0.1-0.2': { splits: [0.15] },
      },
    });
    expect(Object.keys(edits.objects).sort()).toEqual(['r:abc', 'r:abc@0.25-0.5', 'r:def']);
    expect(edits.objects['r:def'].splits).toEqual([0.25, 0.5]);
    expect(edits.objects[S]).toEqual({ widthMm: 2 });
  });
});

describe('what applies where', () => {
  const objects: Objects = {
    [S]: { layer: 'A', widthMm: 1 },
    'r:abc@0.2-0.6': { layer: 'B' },
    'r:abc@0.3-0.4': { removed: true },
  };
  const entry = roadEdits(objects).get(S);

  it('lets the narrowest range win, a field at a time', () => {
    expect(editAt(entry, 0.1)).toEqual({ layer: 'A', widthMm: 1 });
    expect(editAt(entry, 0.25)).toEqual({ layer: 'B', widthMm: 1 });
    expect(editAt(entry, 0.35)).toEqual({ layer: 'B', widthMm: 1, removed: true });
    expect(editOver(entry, 0.2, 0.3)).toEqual({ layer: 'B', widthMm: 1 });
    expect(roadEditOf(objects, 'r:abc@0.3-0.4')).toEqual({ layer: 'B', widthMm: 1, removed: true });
    expect(roadEditOf(objects, 'r:other')).toBeUndefined();
  });

  it('ends blocks at junctions, splits and edits', () => {
    const bounds = blockBounds({ ...entry!, splits: [0.8] }, [0.5, 0.20000001]);
    expect(bounds).toEqual([0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1]);
    expect(blockAt(S, bounds, 0.35)).toBe('r:abc@0.3-0.4');
    expect(blockAt(S, bounds, 0.95)).toBe('r:abc@0.8-1');
    expect(blockAt(S, [0, 1], 0.5)).toBe(S);
  });
});

describe('writing road edits', () => {
  it('sets a block, and the whole segment over it clears the block', () => {
    let objects: Objects = writeRoads({}, ['r:abc@0.2-0.4'], { layer: 'B' }).objects;
    expect(objects).toEqual({ 'r:abc@0.2-0.4': { layer: 'B' } });
    objects = writeRoads(objects, [S], { layer: 'A' }).objects;
    expect(objects).toEqual({ [S]: { layer: 'A' } });
  });

  it('carves a block out of a wider edit when it is cleared there', () => {
    const start: Objects = { [S]: { layer: 'A', widthMm: 2 } };
    const { objects, touched } = writeRoads(start, ['r:abc@0.2-0.4'], { layer: undefined });
    expect(objects).toEqual({ [S]: { widthMm: 2 }, 'r:abc@0-0.2': { layer: 'A' }, 'r:abc@0.4-1': { layer: 'A' } });
    expect(touched.sort()).toEqual([S, 'r:abc@0-0.2', 'r:abc@0.4-1'].sort());
    const entry = roadEdits(objects).get(S);
    expect(editAt(entry, 0.3)).toEqual({ widthMm: 2 });
    expect(editAt(entry, 0.1)?.layer).toBe('A');
    expect(editAt(entry, 0.9)?.layer).toBe('A');
  });

  it('keeps what a narrower range set when carving around it', () => {
    const start: Objects = { [S]: { layer: 'A' }, 'r:abc@0-0.2': { layer: 'C' } };
    const { objects } = writeRoads(start, ['r:abc@0.2-0.4'], { layer: undefined });
    const entry = roadEdits(objects).get(S);
    expect(editAt(entry, 0.1)?.layer).toBe('C');
    expect(editAt(entry, 0.3)?.layer).toBeUndefined();
    expect(editAt(entry, 0.7)?.layer).toBe('A');
  });

  it('puts a removed block back on its own', () => {
    const removed = writeRoads({}, [S], { removed: true }).objects;
    const back = writeRoads(removed, ['r:abc@0.5-0.75'], { removed: undefined }).objects;
    const entry = roadEdits(back).get(S);
    expect(editAt(entry, 0.6)?.removed).toBeUndefined();
    expect(editAt(entry, 0.4)?.removed).toBe(true);
    expect(editAt(entry, 0.8)?.removed).toBe(true);
  });

  it('joins neighbours that end up the same, and drops what repeats a wider edit', () => {
    let objects = writeRoads({}, ['r:abc@0-0.5'], { layer: 'A' }).objects;
    objects = writeRoads(objects, ['r:abc@0.5-1'], { layer: 'A' }).objects;
    expect(objects).toEqual({ [S]: { layer: 'A' } });
    objects = writeRoads(objects, ['r:abc@0.2-0.3'], { layer: 'A' }).objects;
    expect(objects).toEqual({ [S]: { layer: 'A' } });
  });

  it('leaves other segments and other kinds alone', () => {
    const start: Objects = { 'r:other': { layer: 'A' }, 'b:x': { heightM: 9 } };
    const { objects } = writeRoads(start, ['r:abc@0.1-0.2', 'b:x'], { layer: 'B' });
    expect(objects['r:other']).toEqual({ layer: 'A' });
    expect(objects['b:x']).toEqual({ heightM: 9 });
    expect(objects['r:abc@0.1-0.2']).toEqual({ layer: 'B' });
  });

  it('keeps splits on the segment edit through writes', () => {
    const split = addSplit({}, S, 0.5)!;
    const { objects } = writeRoads(split, [S], { layer: 'A' });
    expect(objects[S]).toEqual({ splits: [0.5], layer: 'A' });
    const cleared = writeRoads(objects, [S], { layer: undefined }).objects;
    expect(cleared[S]).toEqual({ splits: [0.5] });
  });
});

describe('splits', () => {
  it('adds a split once, and never at an end', () => {
    const one = addSplit({}, S, 0.333333333)!;
    expect(one[S].splits).toEqual([0.33333]);
    expect(addSplit(one, S, 0.333331)).toBeNull();
    expect(addSplit(one, S, 0)).toBeNull();
    expect(addSplit(one, S, 1)).toBeNull();
    expect(addSplit(one, S, 0.1)![S].splits).toEqual([0.1, 0.33333]);
  });

  it('joins the blocks either side when one is taken out, with the longer side winning', () => {
    let objects = addSplit({}, S, 0.3)!;
    objects = writeRoads(objects, ['r:abc@0.3-1'], { layer: 'A' }).objects;
    const removed = removeSplit(objects, S, 0.3, [0, 0.3, 1])!;
    expect(removed.differed).toBe(true);
    // The longer side had the layer, so all of it has it now.
    expect(removed.objects).toEqual({ [S]: { layer: 'A' } });
    const plain = removeSplit(addSplit({}, S, 0.5)!, S, 0.5, [0, 0.5, 1])!;
    expect(plain.differed).toBe(false);
    expect(plain.objects).toEqual({});
    expect(removeSplit({}, S, 0.5, [0, 1])).toBeNull();
  });
});
