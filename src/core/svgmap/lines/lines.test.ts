// Ported from test_lines.py in the original Python pipeline.
import { describe, expect, it } from 'vitest';
import {
  type LineItem,
  type Path,
  type Point,
  collapseFilledLoops,
  cullRanked,
  lineCoverage,
  pathLength,
  pointSegmentDistanceSq,
  pruneCompactTangles,
  pruneDanglingStubs,
  relieveDenseClusters,
  roundHalfEven,
  snapDanglingEnds,
  weldPaths,
} from './index';

const item = <K = string>(rank: number, key: K, path: Path): LineItem<K> => ({ rank, key, path });
const totalLength = (paths: Path[]) => paths.reduce((sum, p) => sum + pathLength(p), 0);
const keysOf = <K>(items: LineItem<K>[]) => new Set(items.map((i) => i.key));

describe('roundHalfEven matches Python round()', () => {
  it('rounds halves to even', () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 2.4, 2.6].map(roundHalfEven)).toEqual([0, 2, 2, -0, -2, -2, 2, 3]);
  });
});

describe('overlap culling', () => {
  const road: Path = [
    [0, 0],
    [100, 0],
  ];
  // A footpath tested segment by segment against a road that is already kept.
  const cullPath = (path: Path) => {
    const { kept, stats } = cullRanked([item(0, 'road', road), item(11, 'path', path)], 0.5, { wholePaths: false });
    return { kept: kept.filter((i) => i.key === 'path').map((i) => i.path), removedLength: stats.removedLength };
  };

  it('culls a parallel sidewalk', () => {
    expect(cullPath([[0, 0.3], [100, 0.3]]).kept).toHaveLength(0);
  });

  it('keeps a well-separated path', () => {
    const { kept, removedLength } = cullPath([[0, 2], [100, 2]]);
    expect(kept).toHaveLength(1);
    expect(removedLength).toBe(0);
  });

  it('keeps a perpendicular approach intact', () => {
    const { kept } = cullPath([[50, 30], [50, 0]]);
    expect(kept).toHaveLength(1);
    expect(totalLength(kept)).toBeCloseTo(30, 6);
  });

  it('keeps both halves of a path crossing a road', () => {
    expect(totalLength(cullPath([[50, -20], [50, 20]]).kept)).toBeCloseTo(40, 6);
  });

  it('culls only the parallel leg of an elbow', () => {
    const { kept, removedLength } = cullPath([[0, 0.3], [60, 0.3], [60, 40]]);
    expect(Math.abs(totalLength(kept) - 40)).toBeLessThan(0.5);
    expect(Math.abs(removedLength - 60)).toBeLessThan(0.5);
  });

  it('does not cull a steeply angled line', () => {
    expect(cullPath([[40, 0.2], [60, 0.2 + 34.6]]).kept).toHaveLength(1);
  });

  it('collapses duplicate geometry within one group', () => {
    const { kept } = cullRanked([item(6, 'a', [[0, 0], [50, 0]]), item(6, 'b', [[0, 0.01], [50, 0.01]])], 0.2);
    expect(kept).toHaveLength(1);
  });

  it('keeps distinct parallel roads', () => {
    const { kept } = cullRanked([item(6, 'a', [[0, 0], [50, 0]]), item(6, 'b', [[0, 10], [50, 10]])], 0.2);
    expect(kept).toHaveLength(2);
  });
});

describe('ranked culling', () => {
  const road: Path = [
    [0, 0],
    [100, 0],
  ];

  it('keeps a short motorway over a longer nearby residential road', () => {
    const { kept } = cullRanked(
      [item(6, 'res', [[0, 0.05], [100, 0.05]]), item(0, 'mot', [[0, 0], [40, 0]])],
      0.5,
    );
    expect(keysOf(kept).has('mot')).toBe(true);
  });

  it('always keeps a lone road', () => {
    expect(cullRanked([item(6, 'res', [[0, 0.05], [100, 0.05]])], 0.5).kept).toHaveLength(1);
  });

  it('never fragments a path in whole-path mode', () => {
    const elbow: Path = [
      [0, 0.05],
      [60, 0.05],
      [60, 40],
    ];
    const { kept } = cullRanked([item(0, 'road', road), item(11, 'elbow', elbow)], 0.5, { wholePaths: true });
    const elbows = kept.filter((i) => i.key === 'elbow');
    expect(elbows.length).toBeLessThanOrEqual(1);
    if (elbows.length) expect(elbows[0].path).toEqual(elbow);
  });

  it('trims footpaths segment by segment when the group asks for it', () => {
    const elbow: Path = [
      [0, 0.05],
      [60, 0.05],
      [60, 40],
    ];
    const { kept } = cullRanked([item(0, 'road', road), item(11, 'path', elbow)], 0.5, {
      wholePaths: (key) => key !== 'path',
    });
    const pieces = kept.filter((i) => i.key === 'path').map((i) => i.path);
    expect(pieces).toHaveLength(1);
    expect(Math.abs(totalLength(pieces) - 40)).toBeLessThan(0.5);
  });

  it('drops a fully shadowed sidewalk whole', () => {
    const { kept } = cullRanked([item(0, 'road', road), item(11, 'sw', [[0, 0.05], [100, 0.05]])], 0.5, {
      wholePaths: true,
    });
    expect(keysOf(kept).has('sw')).toBe(false);
  });

  it('never culls anything in favour of a LESS important line (randomised)', () => {
    // mulberry32, so the scenario is reproducible
    let seed = 7;
    const random = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const ranks = [0, 1, 2, 3, 6, 8, 11];
    const pool: LineItem[] = [];
    for (let i = 0; i < 120; i++) {
      const rank = ranks[Math.floor(random() * ranks.length)];
      const y = random() * 30;
      const x = random() * 30;
      const horizontal = random() < 0.5;
      const length = 2 + random() * 13;
      const path: Path = horizontal
        ? [
            [x, y],
            [x + length, y],
          ]
        : [
            [x, y],
            [x, y + length],
          ];
      pool.push(item(rank, `p${i}`, path));
    }
    const { kept } = cullRanked(pool, 0.4, { wholePaths: true });
    const keptKeys = keysOf(kept);
    const dropped = pool.filter((p) => !keptKeys.has(p.key));
    expect(dropped.length).toBeGreaterThan(0);
    for (const { rank, path } of dropped) {
      const mid: Point = [(path[0][0] + path[1][0]) / 2, (path[0][1] + path[1][1]) / 2];
      let best: number | null = null;
      for (const other of kept) {
        for (let s = 1; s < other.path.length; s++) {
          if (pointSegmentDistanceSq(mid, other.path[s - 1], other.path[s]) <= 0.4 ** 2) {
            best = best === null ? other.rank : Math.min(best, other.rank);
          }
        }
      }
      expect(best).not.toBeNull();
      expect(best!).toBeLessThanOrEqual(rank);
    }
    // A top-rank line can still be culled, but only by an overlapping line of
    // the same rank (two motorways drawn on top of each other), never by less.
    for (const p of dropped.filter((d) => d.rank === 0)) {
      const mid: Point = [(p.path[0][0] + p.path[1][0]) / 2, (p.path[0][1] + p.path[1][1]) / 2];
      const coveredByTopRank = kept.some(
        (k) => k.rank === 0 && k.path.some((_, s) => s > 0 && pointSegmentDistanceSq(mid, k.path[s - 1], k.path[s]) <= 0.4 ** 2),
      );
      expect(coveredByTopRank).toBe(true);
    }
  });
});

describe('stub pruning', () => {
  const mainRoad: Path = [
    [0, 0],
    [100, 0],
  ];

  it('prunes a dangling stub but keeps branches and the main road', () => {
    const { items } = pruneDanglingStubs(
      [item(0, 'main', mainRoad), item(11, 'stub', [[50, 0], [50, 0.3]]), item(6, 'branch', [[20, 0], [20, 40]])],
      1.0,
      0.01,
    );
    const names = keysOf(items);
    expect(names.has('stub')).toBe(false);
    expect(names.has('branch')).toBe(true);
    expect(names.has('main')).toBe(true);
  });

  it('keeps a short fragment connected at both ends', () => {
    const link: Path = [
      [0, 0],
      [0, 0.3],
      [100, 0.3],
      [100, 0],
    ];
    const { items } = pruneDanglingStubs([item(0, 'main', mainRoad), item(0, 'link', link)], 1000, 0.01);
    expect(keysOf(items)).toEqual(new Set(['main', 'link']));
  });

  it('cascades: removing one stub exposes the next', () => {
    const { removed } = pruneDanglingStubs(
      [item(0, 'main', mainRoad), item(11, 'a', [[50, 0], [50, 0.3]]), item(11, 'b', [[50, 0.3], [50, 0.6]])],
      0.5,
      0.01,
    );
    expect(removed).toBe(2);
  });

  it('keeps a connector that meets the MIDDLE of two roads', () => {
    const { items } = pruneDanglingStubs(
      [item(0, 'through', mainRoad), item(6, 'side', [[50, 0], [50, 0.4]]), item(0, 'far', [[0, 0.4], [100, 0.4]])],
      1.0,
      0.01,
    );
    expect(keysOf(items).has('side')).toBe(true);
  });

  it('still prunes a genuine mid-span spur', () => {
    const { items } = pruneDanglingStubs([item(0, 'through', mainRoad), item(11, 'spur', [[50, 0], [50, 0.2]])], 1.0, 0.01);
    expect(keysOf(items).has('spur')).toBe(false);
  });

  it('does not prune a road clipped at the crop edge', () => {
    const items = [item(0, 'main', mainRoad), item(6, 'clipped', [[0, 0], [0, -0.3]] as Path)];
    const atEdge = pruneDanglingStubs(items, 1.0, 0.01, (q) => Math.abs(q[1] + 0.3) < 1e-9);
    expect(keysOf(atEdge.items).has('clipped')).toBe(true);
    const inland = pruneDanglingStubs(items, 1.0, 0.01);
    expect(keysOf(inland.items).has('clipped')).toBe(false);
  });

  it('prunes footpaths more strongly than roads with a per-group limit', () => {
    const { items } = pruneDanglingStubs(
      [
        item(0, 'roads/main', mainRoad),
        item(6, 'roads/stub', [[30, 0], [30, 1.5]]),
        item(11, 'paths/stub', [[40, 0], [40, 1.5]]),
      ],
      (key) => (key.startsWith('paths') ? 2.0 : 1.0),
      0.01,
    );
    const keys = keysOf(items);
    expect(keys.has('roads/stub')).toBe(true);
    expect(keys.has('paths/stub')).toBe(false);
  });
});

describe('welding', () => {
  const group = (key: string) => key.split('/')[0];
  const segA: Path = [
    [0, 0],
    [10, 0],
  ];
  const segB: Path = [
    [10, 0],
    [20, 0],
  ];
  const segC: Path = [
    [20, 0],
    [30, 0],
  ];

  it('welds three fragments into one route', () => {
    const { items } = weldPaths([item(6, 'roads/a', segA), item(6, 'roads/b', segB), item(6, 'roads/c', segC)], 0.01, {
      groupFn: group,
    });
    expect(items).toHaveLength(1);
    expect(pathLength(items[0].path)).toBe(30);
  });

  it('welds a reversed fragment', () => {
    const { items } = weldPaths([item(6, 'roads/a', segA), item(6, 'roads/b', [...segB].reverse())], 0.01, {
      groupFn: group,
    });
    expect(items).toHaveLength(1);
  });

  it('never welds a road and a footpath together', () => {
    const { items } = weldPaths([item(6, 'roads/a', segA), item(11, 'paths/b', segB)], 0.01, { groupFn: group });
    expect(items).toHaveLength(2);
  });

  it('does not weld through a T junction by default', () => {
    const { items } = weldPaths(
      [item(6, 'roads/a', segA), item(6, 'roads/b', segB), item(6, 'roads/s', [[10, 0], [10, 10]])],
      0.01,
      { groupFn: group },
    );
    expect(items).toHaveLength(3);
  });

  it('lets a welded route survive pruning that would eat its pieces', () => {
    const pieces = Array.from({ length: 20 }, (_, i) =>
      item(11, `paths/p${i}`, [
        [i, 0],
        [i + 1, 0],
      ]),
    );
    const welded = weldPaths(pieces, 0.01, { groupFn: group }).items;
    expect(pruneDanglingStubs(welded, 2.0, 0.01).items).toHaveLength(1);
    expect(pruneDanglingStubs(pieces, 2.0, 0.01).items).toHaveLength(0);
  });

  const crossroads = () => [
    item(6, 'roads/ew1', [[0, 10], [10, 10]] as Path),
    item(6, 'roads/ew2', [[10, 10], [20, 10]] as Path),
    item(6, 'roads/ns1', [[10, 0], [10, 10]] as Path),
    item(6, 'roads/ns2', [[10, 10], [10, 20]] as Path),
  ];

  it('leaves a crossroads alone by default', () => {
    const { items, joins } = weldPaths(crossroads(), 0.01, { groupFn: group });
    expect(items).toHaveLength(4);
    expect(joins).toBe(0);
  });

  it('welds both streets straight through a crossroads when junctions are allowed', () => {
    const { items } = weldPaths(crossroads(), 0.01, { groupFn: group, junctionTurnDeg: 45 });
    expect(items).toHaveLength(2);
    for (const i of items) expect(pathLength(i.path)).toBe(20);
  });

  it('welds the straight continuation, not the turn', () => {
    const { items } = weldPaths(
      [
        item(6, 'roads/straight_in', [[0, 10], [10, 10]] as Path),
        item(6, 'roads/straight_on', [[10, 10], [20, 10]] as Path),
        item(6, 'roads/corner', [[10, 10], [10, 20]] as Path),
      ],
      0.01,
      { groupFn: group, junctionTurnDeg: 45 },
    );
    const through = items.filter((i) => pathLength(i.path) === 20);
    expect(items).toHaveLength(2);
    expect(through).toHaveLength(1);
    expect(through[0].path.some((p) => p[0] === 20 && p[1] === 10)).toBe(true);
  });

  it('leaves a junction with no straight continuation alone', () => {
    const { items, joins } = weldPaths(
      [
        item(6, 'roads/a', [[0, 0], [10, 0]] as Path),
        item(6, 'roads/b', [[0, 0], [-5, 8.66]] as Path),
        item(6, 'roads/c', [[0, 0], [-5, -8.66]] as Path),
      ],
      0.01,
      { groupFn: group, junctionTurnDeg: 45 },
    );
    expect(items).toHaveLength(3);
    expect(joins).toBe(0);
  });

  it('leaves an ambiguous fork alone', () => {
    const { items, joins } = weldPaths(
      [
        item(6, 'roads/in', [[0, 0], [10, 0]] as Path),
        item(6, 'roads/up', [[10, 0], [20, 1]] as Path),
        item(6, 'roads/down', [[10, 0], [20, -1]] as Path),
      ],
      0.01,
      { groupFn: group, junctionTurnDeg: 45 },
    );
    expect(items).toHaveLength(3);
    expect(joins).toBe(0);
  });

  it('never welds a motorway into a service road that lines up with it', () => {
    const { items, joins } = weldPaths(
      [
        item(0, 'roads/motorway', [[0, 0], [10, 0]] as Path),
        item(8, 'roads/service', [[10, 0], [20, 0]] as Path),
        item(8, 'roads/spur', [[10, 0], [10, 10]] as Path),
      ],
      0.01,
      { groupFn: group, junctionTurnDeg: 45 },
    );
    expect(items).toHaveLength(3);
    expect(joins).toBe(0);
  });

  it('respects the turn limit', () => {
    const bend = [
      item(6, 'roads/a', [[0, 0], [10, 0]] as Path),
      item(6, 'roads/b', [[10, 0], [17, 7]] as Path),
      item(6, 'roads/c', [[10, 0], [10, -10]] as Path),
    ];
    expect(weldPaths(bend, 0.01, { groupFn: group, junctionTurnDeg: 30 }).items).toHaveLength(3);
    expect(weldPaths(bend, 0.01, { groupFn: group, junctionTurnDeg: 60 }).items).toHaveLength(2);
  });

  it('reassembles a street split at every block once junctions are allowed', () => {
    const blocks: LineItem[] = [];
    for (let i = 0; i < 10; i++) blocks.push(item(6, `roads/blk${i}`, [[i * 10, 0], [(i + 1) * 10, 0]]));
    for (let i = 0; i <= 10; i++) {
      blocks.push(item(6, `roads/up${i}`, [[i * 10, 0], [i * 10, 10]]));
      blocks.push(item(6, `roads/down${i}`, [[i * 10, 0], [i * 10, -10]]));
    }
    const plain = weldPaths(blocks, 0.01, { groupFn: group }).items;
    expect(Math.max(...plain.map((i) => pathLength(i.path)))).toBe(10);
    const through = weldPaths(blocks, 0.01, { groupFn: group, junctionTurnDeg: 45 }).items;
    const lengths = through.map((i) => Math.round(pathLength(i.path))).sort((a, b) => a - b);
    expect(lengths).toEqual([...Array(11).fill(20), 100]);
  });
});

describe('compact tangles', () => {
  const centre: Point = [20, 20];
  const ring: Path = [];
  for (let i = 0; i < 24; i++) {
    ring.push([centre[0] + 2 * Math.cos((2 * Math.PI * i) / 24), centre[1] + 2 * Math.sin((2 * Math.PI * i) / 24)]);
  }
  ring.push(ring[0]);
  const isPath = (key: string) => key.startsWith('paths');

  it('prunes a compact dense footpath tangle', () => {
    const tangle = [item(11, 'paths/ring', ring)];
    for (let i = 0; i < 24; i += 3) tangle.push(item(11, `paths/spoke-${i}`, [centre, ring[i]]));
    const { items, removed } = pruneCompactTangles(tangle, 6, 24, 4, 0.01, isPath);
    expect(items).toHaveLength(0);
    expect(removed).toBe(tangle.length);
  });

  it('keeps a simple compact footpath loop', () => {
    const { items, removed } = pruneCompactTangles([item(11, 'paths/loop', ring)], 6, 24, 4, 0.01, isPath);
    expect(items).toHaveLength(1);
    expect(removed).toBe(0);
  });
});

describe('snapping near-miss gaps', () => {
  const main: Path = [
    [0, 0],
    [100, 0],
  ];

  it('snaps a near-miss end onto the road', () => {
    const { items, snapped } = snapDanglingEnds([item(0, 'main', main), item(6, 'gap', [[50, 0.25], [50, 30]])], 0.5, 0.02);
    const gap = items.find((i) => i.key === 'gap')!.path;
    expect(Math.abs(gap[0][1])).toBeLessThan(1e-9);
    expect(snapped).toBe(1);
  });

  it('leaves a genuinely separate end alone', () => {
    expect(snapDanglingEnds([item(0, 'main', main), item(6, 'far', [[50, 5], [50, 30]])], 0.5, 0.02).snapped).toBe(0);
  });

  it('leaves an end that already touches alone', () => {
    expect(snapDanglingEnds([item(0, 'main', main), item(6, 'join', [[50, 0], [50, 30]])], 0.5, 0.02).snapped).toBe(0);
  });

  it('never moves an end further than the tolerance', () => {
    const { items } = snapDanglingEnds([item(0, 'main', main), item(6, 'gap', [[50, 0.4], [50, 30]])], 0.5, 0.02);
    const moved = 0.4 - items.find((i) => i.key === 'gap')!.path[0][1];
    expect(moved).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it('does not snap an end cut by the crop', () => {
    const { snapped } = snapDanglingEnds(
      [item(0, 'main', main), item(6, 'clipped', [[50, 0.25], [50, 30]])],
      0.5,
      0.02,
      (q) => Math.abs(q[1] - 0.25) < 1e-9,
    );
    expect(snapped).toBe(0);
  });

  it('does not collapse a nub shorter than the gap', () => {
    const { items, snapped } = snapDanglingEnds([item(0, 'main', main), item(11, 'nub', [[50, 0], [50, 0.2]])], 0.5, 0.02);
    expect(snapped).toBe(0);
    expect(pathLength(items.find((i) => i.key === 'nub')!.path)).toBeGreaterThan(0);
    for (const i of items) expect(pathLength(i.path)).toBeGreaterThan(0);
  });
});

describe('collapsing filled loops', () => {
  const ringAt = (cx: number, cy: number, r: number, n = 16): Path => {
    const pts: Path = [];
    for (let i = 0; i < n; i++) pts.push([cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
    return [...pts, pts[0]];
  };

  it('contracts a tiny turning circle into a junction, keeping every arm whole', () => {
    const arms = [
      item(0, 'n', [[10, 10.15], [10, 14]] as Path),
      item(0, 's', [[10, 9.85], [10, 6]] as Path),
      item(0, 'e', [[10.15, 10], [14, 10]] as Path),
      item(0, 'w', [[9.85, 10], [6, 10]] as Path),
    ];
    const { items, collapsed } = collapseFilledLoops([item(0, 'ring', ringAt(10, 10, 0.15)), ...arms], 0.25, 0.03);
    expect(collapsed).toBe(1);
    expect(items).toHaveLength(4);
    const starts = new Set(items.map((i) => `${i.path[0][0].toFixed(6)},${i.path[0][1].toFixed(6)}`));
    expect(starts.size).toBe(1);
    for (const i of items) expect(Math.abs(pathLength(i.path) - 4)).toBeLessThan(0.2);
  });

  it('leaves a readable roundabout alone', () => {
    const { items, collapsed } = collapseFilledLoops([item(0, 'big', ringAt(30, 30, 1.5))], 0.25, 0.03);
    expect(collapsed).toBe(0);
    expect(items).toHaveLength(1);
  });

  it('never collapses a network cycle made of open paths', () => {
    const cross = [
      item(0, 'a', [[0, 50], [1, 50]] as Path),
      item(0, 'b', [[1, 50], [1, 51]] as Path),
      item(0, 'c', [[1, 51], [0, 51]] as Path),
      item(0, 'd', [[0, 51], [0, 50]] as Path),
    ];
    const { items, collapsed } = collapseFilledLoops(cross, 0.25, 0.03);
    expect(collapsed).toBe(0);
    expect(items).toHaveLength(4);
  });
});

describe('dense-patch relief', () => {
  const bundle = (n: number, spacing: number, y0 = 0, x0 = 0, lengthMm = 6, rank = 5) =>
    Array.from({ length: n }, (_, i) =>
      item(rank, `b${i}`, [
        [x0, y0 + i * spacing],
        [x0 + lengthMm, y0 + i * spacing],
      ]),
    );
  const base = { maxAngleDeg: 28, hotFraction: 0.6, shadowFraction: 0.88 };

  it('thins a dark bundle without emptying it', () => {
    const dense = bundle(8, 0.25);
    const { items, stats } = relieveDenseClusters(dense, 2.7, 2, 0.5, base);
    expect(stats.dropped).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(dense.length);
    expect(items.length).toBeGreaterThanOrEqual(2);
  });

  it('leaves readable spacing alone', () => {
    const sparse = bundle(8, 1.2);
    const { items, stats } = relieveDenseClusters(sparse, 2.7, 2, 0.5, base);
    expect(stats.dropped).toBe(0);
    expect(items).toHaveLength(sparse.length);
  });

  it('keeps a perpendicular feeder running into the patch', () => {
    const { items } = relieveDenseClusters([...bundle(8, 0.25), item(5, 'feeder', [[3, -4], [3, 0.9]])], 2.7, 2, 0.5, base);
    expect(keysOf(items).has('feeder')).toBe(true);
  });

  it('keeps the arterial over its unimportant neighbours', () => {
    const mixed = [item(0, 'arterial', [[0, 0], [6, 0]] as Path)];
    for (let i = 0; i < 7; i++) mixed.push(item(9, `svc${i}`, [[0, 0.25 * (i + 1)], [6, 0.25 * (i + 1)]]));
    const { items } = relieveDenseClusters(mixed, 2.7, 2, 0.5, base);
    expect(keysOf(items).has('arterial')).toBe(true);
  });

  it('does not touch a doubled pair below the density limit', () => {
    const doubled = [item(9, 'x', [[80, 80], [86, 80]] as Path), item(9, 'y', [[80, 80.1], [86, 80.1]] as Path)];
    expect(relieveDenseClusters(doubled, 2.7, 2, 0.5, base).stats.dropped).toBe(0);
  });

  it('is a no-op when the limit is zero', () => {
    expect(relieveDenseClusters(bundle(8, 0.25), 0, 2, 0.5).stats.dropped).toBe(0);
  });

  it('never removes a through-street for being in a dark patch, but still takes its cycle tracks', () => {
    const street = item(3, 'street', [[0, 20], [12, 20]] as Path);
    const alongside = Array.from({ length: 6 }, (_, i) =>
      item(10, `track${i}`, [
        [0, 20 + 0.35 * (i + 1)],
        [12, 20 + 0.35 * (i + 1)],
      ]),
    );
    const { items, stats } = relieveDenseClusters([street, ...alongside], 2.7, 2, 0.5, { ...base, protectRank: 6 });
    expect(keysOf(items).has('street')).toBe(true);
    expect(stats.dropped).toBeGreaterThan(0);
  });

  it('protects real carriageways with the rank floor (and would lose them without it)', () => {
    const divided = [item(2, 'primary_side', [[0, 30], [12, 30]] as Path)];
    for (let i = 0; i < 6; i++) divided.push(item(3, `secondary_side${i}`, [[0, 30 + 0.35 * (i + 1)], [12, 30 + 0.35 * (i + 1)]]));
    const unprotected = relieveDenseClusters(divided, 2.7, 2, 0.5, { ...base, protectRank: -1 }).items;
    expect(unprotected.filter((i) => i.key.startsWith('secondary')).length).toBeLessThan(6);
    const protectedItems = relieveDenseClusters(divided, 2.7, 2, 0.5, { ...base, protectRank: 6 }).items;
    expect(protectedItems.filter((i) => i.key.includes('side'))).toHaveLength(7);
  });

  const gridMesh = (x0: number, y0: number, cells: number, pitch: number, rank = 11) => {
    const out: LineItem[] = [];
    for (let i = 0; i <= cells; i++) {
      for (let j = 0; j < cells; j++) {
        out.push(item(rank, `h${i}_${j}`, [[x0 + j * pitch, y0 + i * pitch], [x0 + (j + 1) * pitch, y0 + i * pitch]]));
        out.push(item(rank, `v${j}_${i}`, [[x0 + i * pitch, y0 + j * pitch], [x0 + i * pitch, y0 + (j + 1) * pitch]]));
      }
    }
    return out;
  };
  const meshOptions = { ...base, protectRank: 6, meshMaxLength: 2.5, meshDetour: 4, weldTolerance: 0.03 };

  const components = (items: LineItem[], tol = 0.03) => {
    const parent = new Map<string, string>();
    const root = (n: string): string => {
      while (parent.get(n) !== n) {
        parent.set(n, parent.get(parent.get(n)!)!);
        n = parent.get(n)!;
      }
      return n;
    };
    const keyOf = (p: Point) => `${roundHalfEven(p[0] / tol)},${roundHalfEven(p[1] / tol)}`;
    for (const { path } of items) for (const p of path) if (!parent.has(keyOf(p))) parent.set(keyOf(p), keyOf(p));
    for (const { path } of items) {
      for (let s = 1; s < path.length; s++) {
        const ra = root(keyOf(path[s - 1]));
        const rb = root(keyOf(path[s]));
        if (ra !== rb) parent.set(rb, ra);
      }
    }
    return new Set([...parent.keys()].map(root)).size;
  };

  it('thins a fine mesh without splitting it into pieces', () => {
    const mesh = gridMesh(60, 60, 6, 0.6);
    const { items, stats } = relieveDenseClusters(mesh, 2.7, 2, 0.5, meshOptions);
    expect(stats.meshDropped).toBeGreaterThan(0);
    expect(items.length).toBeGreaterThan(mesh.length * 0.5);
    expect(components(items)).toBe(components(mesh));
  });

  it('never takes a link whose ends do not rejoin', () => {
    const mesh = gridMesh(60, 60, 6, 0.6);
    const spur = item(11, 'spur', [[60 + 3 * 0.8, 60 + 3 * 0.8], [60 + 3 * 0.8, 57.5]] as Path);
    const { items } = relieveDenseClusters([...mesh, spur], 2.7, 2, 0.5, { ...meshOptions, meshMaxLength: 4 });
    expect(keysOf(items).has('spur')).toBe(true);
  });

  it('treats ground a fill already burns solid as darker, proportionately', () => {
    const pair = [item(11, 'a', [[100, 100], [106, 100]] as Path), item(11, 'b', [[100, 101], [106, 101]] as Path)];
    const covered = { coveredFn: () => true, coveredLimitScale: 0.6 };
    expect(relieveDenseClusters(pair, 2.7, 2, 0.5, { ...base, protectRank: 6, ...covered }).stats.dropped).toBe(0);

    const loose = gridMesh(60, 60, 6, 1.3);
    const open = relieveDenseClusters(loose, 2.7, 2, 0.5, meshOptions).stats;
    const burnt = relieveDenseClusters(loose, 2.7, 2, 0.5, { ...meshOptions, ...covered }).stats;
    expect(open.dropped).toBe(0);
    expect(burnt.dropped).toBeGreaterThan(0);
  });
});

describe('coverage', () => {
  it('reports duplicates as covered and missing streets as lost', () => {
    const a: Path = [
      [0, 0],
      [10, 0],
    ];
    const b: Path = [
      [0, 0.1],
      [10, 0.1],
    ];
    const c: Path = [
      [0, 5],
      [10, 5],
    ];
    expect(lineCoverage([a, b], [a], 0.2)).toBeCloseTo(1, 9);
    expect(lineCoverage([a, c], [a], 0.2)).toBeCloseTo(0.5, 9);
  });
});
