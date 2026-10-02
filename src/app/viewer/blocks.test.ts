// Road lines cut into blocks for the viewer, and what the split tool does where.

import { describe, expect, it } from 'vitest';
import { addSplit } from '../../core/edit/blocks';
import type { RoadLines } from '../../core/edit/lines';
import { emptyEdits, type ModelEdits } from '../../core/edit/types';
import { blockLines, blocksSignature, chainLines, segmentBounds, splitTarget } from './blocks';
import { RoadIndex } from './roads';

/** One segment along y 0 from x 0 to 20, in two pieces, with a junction a quarter along. */
function lines(): RoadLines {
  return {
    keys: ['r:a', 'r:a'],
    names: ['A Street', 'A Street'],
    classes: ['residential', 'residential'],
    groups: Uint8Array.of(0, 0),
    widths: Float32Array.of(1, 1),
    starts: Uint32Array.of(0, 2, 4),
    points: Float32Array.of(0, 0, 0, 10, 0, 0, 10, 0, 0, 20, 0, 0),
    measures: Float32Array.of(0, 0.5, 0.5, 1),
    junctions: { 'r:a': [0.25] },
    thicknessMm: 0.6,
  };
}

const withSplit = (): ModelEdits => ({ ...emptyEdits(), objects: addSplit({}, 'r:a', 0.75)! });

describe('blocks in the viewer', () => {
  it('cuts the lines at junctions and splits, keyed by block', () => {
    const cut = blockLines(lines(), withSplit());
    expect(cut.keys).toEqual(['r:a@0-0.25', 'r:a@0.25-0.75', 'r:a@0.25-0.75', 'r:a@0.75-1']);
    expect(Array.from(cut.points.slice(0, 6))).toEqual([0, 0, 0, 5, 0, 0]);
    expect(Array.from(cut.measures!)).toEqual([0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1]);
    expect(segmentBounds(lines(), withSplit(), 'r:a')).toEqual([0, 0.25, 0.75, 1]);
  });

  it('only cuts again when a split or an edit range changes', () => {
    const plain = blocksSignature(emptyEdits());
    expect(blocksSignature({ ...emptyEdits(), objects: { 'r:a': { layer: 'L' } } })).toBe(plain);
    expect(blocksSignature(withSplit())).not.toBe(plain);
    expect(blocksSignature({ ...emptyEdits(), objects: { 'r:a@0-0.25': { layer: 'L' } } })).not.toBe(plain);
  });

  it('picks a block, and finds the pieces of a block, a segment or a range', () => {
    const index = new RoadIndex(blockLines(lines(), withSplit()));
    const pick = index.nearest(12, 0.1, () => true, () => 1)!;
    expect(pick.key).toBe('r:a@0.25-0.75');
    expect(pick.at).toBeCloseTo(0.6, 6);
    expect(pick.x).toBeCloseTo(12, 6);
    expect(index.piecesOf('r:a@0.25-0.75')).toEqual([1, 2]);
    expect(index.piecesOf('r:a')).toEqual([0, 1, 2, 3]);
    expect(index.piecesOf('r:a@0.5-1')).toEqual([2, 3]);
    expect(index.markAt('r:a', 0.75)).toMatchObject({ x: 15, y: 0, dx: 1, dy: 0 });
  });

  it('splits, joins a split, or leaves a junction alone', () => {
    const edits = withSplit();
    const index = new RoadIndex(blockLines(lines(), edits));
    const bounds = segmentBounds(lines(), edits, 'r:a');
    const target = (x: number) => splitTarget(index, bounds, [0.75], index.nearest(x, 0, () => true, () => 1)!);
    expect(target(12)).toEqual({ kind: 'split', segment: 'r:a', at: expect.closeTo(0.6, 6) });
    expect(target(15.2)?.kind).toBe('join');
    expect(target(4.9)?.kind).toBe('end');
  });

  it('chains a block in several pieces into one line', () => {
    expect(
      chainLines([
        [
          [10, 0],
          [20, 0],
        ],
        [
          [0, 0],
          [10, 0],
        ],
        [
          [30, 5],
          [20, 0],
        ],
      ]),
    ).toEqual([
      [
        [0, 0],
        [10, 0],
        [20, 0],
        [30, 5],
      ],
    ]);
  });
});
