import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../types';
import { snapToNetwork } from './snap';

// A street grid in metres: 100 m blocks, 10 by 10, every street a line from
// one end to the other with a vertex at each junction.
function grid(blocks = 10, size = 100): Vec2[][] {
  const lines: Vec2[][] = [];
  for (let i = 0; i <= blocks; i++) {
    lines.push(Array.from({ length: blocks + 1 }, (_, j): Vec2 => [i * size, j * size]));
    lines.push(Array.from({ length: blocks + 1 }, (_, j): Vec2 => [j * size, i * size]));
  }
  return lines;
}

function seeded(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
}

/** A recorded version of a path: a point every 3 m with wandering error up to about `noise` metres. */
function recorded(path: Vec2[], noise: number, seed = 7): Vec2[] {
  const random = seeded(seed);
  const out: Vec2[] = [];
  let ex = 0;
  let ey = 0;
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1];
    const [bx, by] = path[i];
    const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 3));
    for (let k = i === 1 ? 0 : 1; k <= steps; k++) {
      // Error that drifts rather than jumps, as GPS does.
      ex = 0.9 * ex + 0.1 * random() * noise * 2;
      ey = 0.9 * ey + 0.1 * random() * noise * 2;
      out.push([ax + ((bx - ax) * k) / steps + ex, ay + ((by - ay) * k) / steps + ey]);
    }
  }
  return out;
}

function distanceToPath([x, y]: Vec2, path: Vec2[]): number {
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1];
    const [bx, by] = path[i];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(ax + dx * t - x, ay + dy * t - y));
  }
  return best;
}

/** The points not within `reach` of either end of a path, where along-track error moves a snapped end. */
function awayFromEnds(points: Vec2[], path: Vec2[], reach: number): Vec2[] {
  const [a, b] = [path[0], path[path.length - 1]];
  return points.filter(([x, y]) => Math.hypot(x - a[0], y - a[1]) > reach && Math.hypot(x - b[0], y - b[1]) > reach);
}

/** Points every metre along the lines. */
function dense(lines: Vec2[][]): Vec2[] {
  const out: Vec2[] = [];
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = line[i - 1];
      const [bx, by] = line[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
      for (let k = 0; k <= steps; k++) out.push([ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps]);
    }
  }
  return out;
}

describe('snapping a track to the roads', () => {
  const network = grid();
  // East along one street, north up another, then east again.
  const truth: Vec2[] = [
    [50, 200],
    [400, 200],
    [400, 600],
    [850, 600],
  ];

  it('puts a noisy recording back on the streets it took', () => {
    const track = recorded(truth, 10);
    expect(Math.max(...track.map((p) => distanceToPath(p, truth)))).toBeGreaterThan(5);
    const { lines, snapped } = snapToNetwork([track], network, { unitsPerMetre: 1 });
    expect(snapped).toBeGreaterThan(0.95);
    expect(lines).toHaveLength(1);
    // Every point on the result is on the route taken, the corners included.
    expect(Math.max(...awayFromEnds(dense(lines), truth, 15).map((p) => distanceToPath(p, truth)))).toBeLessThan(0.01);
    // And the result covers the whole route, not a shortcut.
    expect(Math.max(...dense([truth]).map((p) => distanceToPath(p, lines[0])))).toBeLessThan(15);
  });

  it('works in model units', () => {
    const mm = 0.07;
    const scaled = (line: Vec2[]) => line.map(([x, y]): Vec2 => [x * mm, y * mm]);
    const { lines } = snapToNetwork([scaled(recorded(truth, 8))], network.map(scaled), { unitsPerMetre: mm });
    expect(Math.max(...awayFromEnds(dense(lines), scaled(truth), 15 * mm).map((p) => distanceToPath(p, scaled(truth))))).toBeLessThan(0.01 * mm);
  });

  it('keeps a stretch off the roads as recorded', () => {
    // Diagonally across a block with no road in it, like a path through a park.
    const park: Vec2[] = [
      [50, 300],
      [300, 300],
      [400, 400],
      [700, 400],
    ];
    const track = recorded(park, 4, 3);
    const { lines, snapped } = snapToNetwork([track], network, { unitsPerMetre: 1 });
    expect(snapped).toBeLessThan(0.9);
    expect(snapped).toBeGreaterThan(0.5);
    // The diagonal is still there, not swapped for two sides of the block.
    const middle: Vec2 = [350, 350];
    expect(Math.min(...dense(lines).map(([x, y]) => Math.hypot(x - middle[0], y - middle[1])))).toBeLessThan(8);
  });

  it('follows an out and back on the same street', () => {
    const outAndBack: Vec2[] = [
      [100, 500],
      [700, 500],
      [300, 500],
    ];
    const { lines } = snapToNetwork([recorded(outAndBack, 8, 11)], network, { unitsPerMetre: 1 });
    const points = dense(lines);
    expect(Math.max(...points.map(([, y]) => Math.abs(y - 500)))).toBeLessThan(1);
    // It reaches the far end before turning.
    expect(Math.max(...points.map(([x]) => x))).toBeGreaterThan(680);
    expect(points[points.length - 1][0]).toBeLessThan(320);
  });

  it('joins lines that end part way along another', () => {
    // A side street that stops on the main street without a shared vertex.
    const roads: Vec2[][] = [
      [
        [0, 0],
        [1000, 0],
      ],
      [
        [500, 0],
        [500, 600],
      ],
    ];
    const path: Vec2[] = [
      [100, 0],
      [500, 0],
      [500, 500],
    ];
    const { lines } = snapToNetwork([recorded(path, 6, 5)], roads, { unitsPerMetre: 1 });
    expect(Math.max(...awayFromEnds(dense(lines), path, 15).map((p) => distanceToPath(p, path)))).toBeLessThan(0.01);
  });

  it('leaves the track alone with no roads near it', () => {
    const far: Vec2[] = [
      [5000, 5000],
      [5300, 5050],
    ];
    const result = snapToNetwork([far], network, { unitsPerMetre: 1 });
    expect(result.snapped).toBe(0);
    expect(result.lines[0]).toEqual(far);
  });
});
