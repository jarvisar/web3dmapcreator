import { describe, expect, it } from 'vitest';
import type { RoadLines } from '../../core/edit/lines';
import { RoadIndex } from './roads';

function lines(pieces: { key: string; name: string; points: [number, number][] }[], decks?: RoadLines['decks']): RoadLines {
  const starts = new Uint32Array(pieces.length + 1);
  const coords: number[] = [];
  pieces.forEach((piece, i) => {
    starts[i] = coords.length / 3;
    for (const [x, y] of piece.points) coords.push(x, y, 0);
  });
  starts[pieces.length] = coords.length / 3;
  return {
    keys: pieces.map((p) => p.key),
    names: pieces.map((p) => p.name),
    classes: pieces.map(() => 'primary'),
    groups: new Uint8Array(pieces.length),
    widths: new Float32Array(pieces.length).fill(0.6),
    starts,
    points: Float32Array.from(coords),
    thicknessMm: 0.6,
    decks,
  };
}

describe('RoadIndex.connected', () => {
  const pieces = [
    { key: 'r:a', name: 'Main Street', points: [[0, 0], [10, 0]] as [number, number][] },
    { key: 'r:b', name: 'Main Street', points: [[20, 0], [30, 0]] as [number, number][] },
    { key: 'r:c', name: 'Side Street', points: [[30, 0], [40, 5]] as [number, number][] },
  ];
  const bridge = { keys: ['br:x'], names: ['Main Street'], classes: ['primary'], ends: Float32Array.from([10, 0, 20, 0]) };

  it('follows a street across its bridge', () => {
    const index = new RoadIndex(lines(pieces, bridge));
    expect(index.connected('r:a').sort()).toEqual(['br:x', 'r:a', 'r:b']);
    expect(index.connected('br:x').sort()).toEqual(['br:x', 'r:a', 'r:b']);
  });

  it('stops where the street does without one', () => {
    const index = new RoadIndex(lines(pieces));
    expect(index.connected('r:a')).toEqual(['r:a']);
    expect(index.connected('br:x')).toEqual([]);
  });
});
