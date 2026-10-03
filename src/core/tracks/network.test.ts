import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../types';
import { nearestRoad, RoadGraph, routeBetween } from './network';

// Streets 100 m apart, each a line from one end to the other with a vertex at every junction.
function grid(blocks = 4, size = 100): Vec2[][] {
  const lines: Vec2[][] = [];
  for (let i = 0; i <= blocks; i++) {
    lines.push(Array.from({ length: blocks + 1 }, (_, j): Vec2 => [i * size, j * size]));
    lines.push(Array.from({ length: blocks + 1 }, (_, j): Vec2 => [j * size, i * size]));
  }
  return lines;
}

const graphOf = (lines: Vec2[][]) => RoadGraph.build(lines, lines.map((_, i) => i), 0.5, 40);

function length(path: Vec2[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  return total;
}

describe('nearestRoad', () => {
  it('finds the closest spot within reach', () => {
    const graph = graphOf(grid());
    const spot = nearestRoad(graph, 150, 8, 20)!;
    expect(spot.x).toBeCloseTo(150);
    expect(spot.y).toBeCloseTo(0);
    expect(spot.distance).toBeCloseTo(8);
    expect(nearestRoad(graph, 150, 50, 20)).toBeNull();
  });
});

describe('routeBetween', () => {
  it('goes round the block along the streets', () => {
    const graph = graphOf(grid());
    const a = nearestRoad(graph, 50, 0, 5)!;
    const b = nearestRoad(graph, 200, 150, 5)!;
    const way = routeBetween(graph, a, b, 1000)!;
    expect(way[0]).toEqual([50, 0]);
    expect(way[way.length - 1]).toEqual([200, 150]);
    // 150 east then 150 north.
    expect(length(way)).toBeCloseTo(300);
  });

  it('stays on one street between two spots on it', () => {
    const graph = graphOf(grid());
    const way = routeBetween(graph, nearestRoad(graph, 110, 0, 5)!, nearestRoad(graph, 190, 0, 5)!, 1000)!;
    expect(way).toEqual([
      [110, 0],
      [190, 0],
    ]);
  });

  it('gives up past the limit', () => {
    const graph = graphOf(grid());
    expect(routeBetween(graph, nearestRoad(graph, 0, 0, 5)!, nearestRoad(graph, 400, 400, 5)!, 500)).toBeNull();
  });

  it('never drops off a bridge onto the road under it', () => {
    // A street along y = 0 and a bridge crossing it with no vertex where they cross.
    const street: Vec2[] = [
      [0, 0],
      [200, 0],
    ];
    const bridge: Vec2[] = [
      [100, -100],
      [100, 100],
    ];
    const graph = graphOf([street, bridge]);
    expect(routeBetween(graph, nearestRoad(graph, 10, 0, 5)!, nearestRoad(graph, 100, 90, 5)!, 10_000)).toBeNull();
  });

  it('joins a side street that ends on a road without a shared vertex', () => {
    const street: Vec2[] = [
      [0, 0],
      [200, 0],
    ];
    const side: Vec2[] = [
      [100, 0],
      [100, 100],
    ];
    const graph = graphOf([street, side]);
    const way = routeBetween(graph, nearestRoad(graph, 10, 0, 5)!, nearestRoad(graph, 100, 90, 5)!, 10_000)!;
    expect(length(way)).toBeCloseTo(180);
  });
});
