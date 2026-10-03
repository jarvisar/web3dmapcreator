import { describe, expect, it } from 'vitest';
import type { SourceFeature } from '../pipeline/source';
import { flatFrame } from './edit';
import { nearestRoad, RoadGraph, routeBetween } from './network';
import { followLines, roadGraph } from './roads';

const frame = flatFrame([0, 0]);
// About 1 km east along the equator.
const east = { type: 'LineString', coordinates: [[0, 0], [0.009, 0]] };

const segment = (id: string, props: Record<string, unknown>): SourceFeature => ({ id, geometry: east, props });

describe('followLines', () => {
  it('keeps roads and paths, and leaves out rail, ferries and tunnels', () => {
    const lines = followLines(
      [
        segment('street', { subtype: 'road', class: 'residential' }),
        segment('path', { subtype: 'road', class: 'footway' }),
        segment('rail', { subtype: 'rail', class: 'standard_gauge' }),
        segment('ferry', { subtype: 'water', class: 'ferry' }),
        segment('tunnel', { subtype: 'road', class: 'primary', road_flags: [{ values: ['is_tunnel'], between: [0.4, 0.6] }] }),
        segment('skyway', { subtype: 'road', class: 'footway', road_flags: [{ values: ['is_indoor'] }] }),
      ],
      frame,
    );
    // The street, the path, and the tunnel's road either side of the tunnel.
    expect(lines).toHaveLength(4);
    const ends = lines.slice(2).map((line) => [line[0][0], line[line.length - 1][0]]);
    expect(ends[0][0]).toBeCloseTo(0, 3);
    const length = frame.toLocal([0.009, 0])[0];
    expect(ends[0][1]).toBeCloseTo(length * 0.4, 3);
    expect(ends[1][0]).toBeCloseTo(length * 0.6, 3);
  });

  it('gives a graph that works the same once posted', () => {
    const lines = followLines([segment('a', { subtype: 'road', class: 'residential' })], frame);
    const posted = new RoadGraph(roadGraph(lines).parts());
    const a = nearestRoad(posted, 100, 5, 10)!;
    const b = nearestRoad(posted, 900, -5, 10)!;
    expect(routeBetween(posted, a, b, 2000)).toEqual([
      [a.x, a.y],
      [b.x, b.y],
    ]);
  });
});
