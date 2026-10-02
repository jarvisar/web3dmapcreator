// Editing one block of a road: junctions where printed roads meet, pieces
// measured along their segment, edits by range in the export, flat ends where
// a coloured block meets the rest of its street, and the bridge in a block.

import { describe, expect, it } from 'vitest';
import { Projection } from '../geo/projection';
import { pointInMulti } from '../geometry/polygon';
import type { PrismSolid } from '../geometry/solid';
import { edgeReport } from '../geometry/validate';
import { generateModel, type ModelSpec } from '../pipeline/generate';
import { measurePoints, segmentJunctions, segmentLine } from '../pipeline/measure';
import { meshLayers } from '../pipeline/mesh';
import type { SourceData, SourceFeature } from '../pipeline/source';
import { cloneSettings, DEFAULT_PALETTE, type AreaSpec } from '../settings';
import type { MultiPolygon } from '../types';
import { appliedRoadEdit, blockLines } from '../../app/viewer/blocks';
import { RoadIndex } from '../../app/viewer/roads';
import { roadEdits, roadKey, writeRoads } from './blocks';
import { roadLines } from './lines';
import { editOf } from './keys';
import { styledPieces } from './roads';
import { EditSession } from './session';
import { emptyEdits, type ModelEdits } from './types';

const LAT = 45;
const LON = 0.01;
const M_LAT = 1 / 111320;
const M_LON = 1 / (111320 * Math.cos((LAT * Math.PI) / 180));
const at = (x: number, y: number): [number, number] => [LON + x * M_LON, LAT + y * M_LAT];
const rect = (x0: number, y0: number, x1: number, y1: number) => [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]];

function feature(id: string, geometry: SourceFeature['geometry'], props: Record<string, unknown>): SourceFeature {
  return { id, geometry, props };
}

/** Main Street and a cross street meeting at a shared vertex, the cross street bridging a river. */
function town(): SourceData {
  return {
    release: 'test',
    features: {
      water: [feature('river', { type: 'Polygon', coordinates: rect(-900, -60, 900, 40) }, { subtype: 'river', class: 'river' })],
      segment: [
        feature('main', { type: 'LineString', coordinates: [at(-600, 125), at(5, 125), at(600, 125)] }, {
          subtype: 'road',
          class: 'primary',
          names: { primary: 'Main Street' },
        }),
        feature('cross', { type: 'LineString', coordinates: [at(5, -400), at(5, 125), at(5, 400)] }, {
          subtype: 'road',
          class: 'residential',
        }),
        // A sidewalk junction nobody prints: no block ends there.
        feature('lane', { type: 'LineString', coordinates: [at(-300, 125), at(-300, 300)] }, { subtype: 'road', class: 'footway', subclass: 'sidewalk' }),
      ],
    },
  };
}

const area: AreaSpec = { center: [LON, LAT], widthM: 1300, heightM: 900, rotationDeg: 0, shape: 'rectangle', cornerRadius: 0.1 };
const hills = { sample: () => 30 };

async function setUp() {
  const settings = cloneSettings();
  settings.terrain.resolution = 64;
  settings.bridges.enabled = true;
  settings.bridges.maxGrade = 0.5;
  settings.bridges.clearanceMm = 1.5;
  // The lane meets Main Street at a vertex of both, as Overture maps a junction, but it's a sidewalk, which isn't printed.
  const data = town();
  (data.features.segment![0].geometry as { coordinates: [number, number][] }).coordinates.splice(1, 0, at(-300, 125));
  const spec = await generateModel({ area, settings, data, elevation: hills });
  const projection = new Projection(area.center, area.rotationDeg, spec.mmPerMetre);
  return { settings, spec, projection, session: new EditSession(spec, settings, projection) };
}

const edits = (objects: ModelEdits['objects'], layers = [{ id: 'L', name: 'Red', hex: '#FF0000', line: 'PLA Basic' as const }]): ModelEdits => ({ ...emptyEdits(), layers, objects });

function polygonsOf(spec: ModelSpec, id: string): MultiPolygon {
  return (spec.layers.find((l) => l.id === id)?.solids ?? []).filter((s): s is PrismSolid => s.kind === 'prism').map((s) => s.polygon);
}

describe('measuring along a segment', () => {
  it('measures points along a line, a loop closing on itself included', () => {
    const line = segmentLine(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    )!;
    expect(measurePoints([[5, 0], [10, 5]], line)).toEqual([0.125, 0.375]);
    // Starting where the loop closes and heading back along its last side.
    const back = measurePoints([[0, 0], [0, 5]], line);
    expect(back[0]).toBeCloseTo(1, 6);
    expect(back[1]).toBeCloseTo(0.875, 6);
  });

  it('keeps vertices another kept segment shares as junctions, and takes close ones as one', () => {
    const main = segmentLine([[0, 0], [10, 0], [10.2, 0], [20, 0], [40, 0]], )!;
    const a = segmentLine([[10, 0], [10, 10]])!;
    const b = segmentLine([[10.2, 0], [10.2, -10]])!;
    const junctions = segmentJunctions(new Map([['main', main], ['a', a], ['b', b]]));
    // 10 and 10.2 are 0.2 mm apart, under BLOCK_MIN_MM, so one at their middle. Nothing meets at 20.
    expect(junctions.get('main')).toEqual([0.2525]);
  });
});

describe('a block of a road', () => {
  it('ends at the junction a printed road meets, not at the sidewalk', async () => {
    const { spec } = await setUp();
    const junctions = spec.edit!.junctions!.get('r:main')!;
    expect(junctions).toHaveLength(1);
    expect(junctions[0]).toBeCloseTo(605 / 1200, 3);
    const main = spec.edit!.roads.filter((p) => p.sourceId === 'main');
    expect(main.every((p) => p.measure?.length === p.points.length)).toBe(true);
  });

  it('puts one block in a layer, cut flat at the junction, and leaves the rest', async () => {
    const { spec, session, projection } = await setUp();
    const junction = spec.edit!.junctions!.get('r:main')![0];
    const objects = writeRoads({}, [roadKey('r:main', junction, 1)], { layer: 'L' }).objects;
    const out = await session.edited(edits(objects), DEFAULT_PALETTE);
    const layer = polygonsOf(out, 'layer:L');
    const roads = polygonsOf(out, 'roads');
    const [jx, jy] = projection.toModel(...at(5, 125));
    const [wx, wy] = projection.toModel(...at(-450, 125));
    const [ex, ey] = projection.toModel(...at(450, 125));
    expect(pointInMulti(ex, ey, layer)).toBe(true);
    expect(pointInMulti(wx, wy, roads)).toBe(true);
    expect(pointInMulti(wx, wy, layer)).toBe(false);
    // Flat where it was cut: nothing of the layer west of the junction, even
    // within half the road's width, where a round cap would reach.
    let minX = Infinity;
    for (const polygon of layer) for (const [x] of polygon[0]) minX = Math.min(minX, x);
    expect(minX).toBeGreaterThan(jx - 0.02);
    void jy;
    const { parts, failed } = await meshLayers(out.layers, { zShift: -out.baseZ });
    expect(failed).toBe(0);
    for (const part of parts) expect(edgeReport(part.indices, part.positions.length / 3).open, part.name).toBe(0);
  });

  it('removes one block and puts it back on its own', async () => {
    const { session, projection } = await setUp();
    const [wx, wy] = projection.toModel(...at(-450, 125));
    const [ex, ey] = projection.toModel(...at(450, 125));
    const removed = writeRoads({}, ['r:main'], { removed: true }).objects;
    const back = writeRoads(removed, [roadKey('r:main', 0.6, 1)], { removed: undefined }).objects;
    const out = await session.edited(edits(back), DEFAULT_PALETTE);
    const roads = polygonsOf(out, 'roads');
    expect(pointInMulti(ex, ey, roads)).toBe(true);
    expect(pointInMulti(wx, wy, roads)).toBe(false);
  });

  it('takes the bridge with the block it is in, and only that block', async () => {
    const { spec, session } = await setUp();
    const deck = spec.edit!.decks.find((d) => d.key === 'br:cross');
    expect(deck?.at).toBeDefined();
    const facts = session.describe();
    expect(facts['br:cross'].at).toBeCloseTo(deck!.at!, 9);
    const junction = spec.edit!.junctions!.get('r:cross')![0];
    expect(deck!.at!).toBeLessThan(junction);
    const south = writeRoads({}, [roadKey('r:cross', 0, junction)], { removed: true }).objects;
    const north = writeRoads({}, [roadKey('r:cross', junction, 1)], { removed: true }).objects;
    expect(editOf(edits(south), 'br:cross', deck!.at)?.removed).toBe(true);
    expect(editOf(edits(north), 'br:cross', deck!.at)?.removed).toBeUndefined();
    const gone = await session.edited(edits(south), DEFAULT_PALETTE);
    const kept = await session.edited(edits(north), DEFAULT_PALETTE);
    expect(gone.layers.some((l) => l.solids.some((s) => s.key === 'br:cross'))).toBe(false);
    expect(kept.layers.some((l) => l.solids.some((s) => s.key === 'br:cross'))).toBe(true);
  });

  it('leaves a piece no range ends within as it is', async () => {
    const { spec } = await setUp();
    const piece = spec.edit!.roads.find((p) => p.sourceId === 'main')!;
    const ranges = [{ from: 0, to: 1, style: { layer: 'L' } }];
    const [only] = styledPieces(piece, ranges);
    expect(only.piece).toBe(piece);
    expect(only.cut).toEqual([false, false]);
    const cut = styledPieces(piece, [{ from: 0.5, to: 0.75, style: { widthMm: 2 } }]);
    expect(cut.length).toBeGreaterThanOrEqual(2);
    expect(cut.some((p) => p.style?.widthMm === 2 && p.cut[0] && p.cut[1])).toBe(true);
    const index = roadEdits(writeRoads({}, ['r:main@0.5-0.75'], { widthMm: 2 }).objects);
    expect(index.get('r:main')?.ranges).toHaveLength(1);
  });

  it('cuts at a vertex a range ends on', async () => {
    const { spec } = await setUp();
    const base = spec.edit!.roads.find((p) => p.sourceId === 'main')!;
    const piece = { ...base, points: [[0, 0], [10, 0], [20, 0]] as [number, number][], measure: [0, 0.5, 1], partnerMeasure: undefined };
    // Exactly on the vertex, and a hair either side of it, as a rounded junction is.
    for (const from of [0.5, 0.5 + 5e-8, 0.5 - 5e-8, 0.500004]) {
      const pieces = styledPieces(piece, [{ from, to: 1, style: { layer: 'L' } }]);
      expect(pieces).toHaveLength(2);
      const styled = pieces.find((p) => p.style?.layer === 'L')!;
      expect(styled.piece.points[0][0]).toBeCloseTo(10, 3);
      expect(styled.cut).toEqual([true, false]);
    }
  });
});

describe('a divided road merged onto one line', () => {
  // Grand Avenue: two-way at either end, two one-way carriageways 4 m apart in between.
  const oneway = { access_restrictions: [{ access_type: 'denied', when: { heading: 'backward' } }] };
  const grand = { subtype: 'road', class: 'primary', names: { primary: 'Grand Avenue' } };
  function divided(): SourceData {
    return {
      release: 'test',
      features: {
        segment: [
          feature('before', { type: 'LineString', coordinates: [at(-600, 0), at(-300, 0)] }, grand),
          feature('up', { type: 'LineString', coordinates: [at(-300, 0), at(-280, 2), at(280, 2), at(300, 0)] }, { ...grand, ...oneway }),
          feature('down', { type: 'LineString', coordinates: [at(300, 0), at(280, -2), at(-280, -2), at(-300, 0)] }, { ...grand, ...oneway }),
          feature('after', { type: 'LineString', coordinates: [at(300, 0), at(600, 0)] }, grand),
        ],
      },
    };
  }
  async function model() {
    const settings = cloneSettings();
    settings.terrain.resolution = 64;
    const spec = await generateModel({ area, settings, data: divided(), elevation: hills });
    const projection = new Projection(area.center, area.rotationDeg, spec.mmPerMetre);
    return { spec, projection, session: new EditSession(spec, settings, projection) };
  }

  it("carries the other carriageway's colour and width, but not its removal", async () => {
    const { spec, projection, session } = await model();
    const merged = spec.edit!.roads.find((p) => p.partner);
    expect(merged).toBeDefined();
    const other = `r:${merged!.partner}`;
    expect(merged!.partnerMeasure).toHaveLength(merged!.points.length);
    const [mx, my] = projection.toModel(...at(0, 0));

    const coloured = await session.edited(edits(writeRoads({}, [other], { layer: 'L' }).objects), DEFAULT_PALETTE);
    expect(pointInMulti(mx, my, polygonsOf(coloured, 'layer:L'))).toBe(true);
    // Its own edit wins where it has one.
    const own = writeRoads(writeRoads({}, [other], { layer: 'L' }).objects, [`r:${merged!.sourceId}`], { widthMm: 3 }).objects;
    const both = await session.edited(edits(own), DEFAULT_PALETTE);
    expect(pointInMulti(mx, my, polygonsOf(both, 'layer:L'))).toBe(true);

    const removed = await session.edited(edits(writeRoads({}, [other], { removed: true }).objects), DEFAULT_PALETTE);
    expect(pointInMulti(mx, my, polygonsOf(removed, 'roads'))).toBe(true);
  });

  it('is picked and shown the same way in the viewer', async () => {
    const { spec } = await model();
    const merged = spec.edit!.roads.find((p) => p.partner)!;
    const other = `r:${merged.partner}`;
    const lines = roadLines(spec.edit!, -spec.baseZ, 0.6);
    const piece = lines.keys.findIndex((key, i) => key === `r:${merged.sourceId}` && lines.partners![i] === other);
    expect(piece).toBeGreaterThanOrEqual(0);
    const objects = writeRoads({}, [other], { layer: 'L' }).objects;
    const index = new RoadIndex(blockLines(lines, edits(objects)));
    // Selecting the other carriageway lights up the merged line too.
    expect(index.piecesOf(other).some((p) => index.lines.partners![p] === other)).toBe(true);
    expect(appliedRoadEdit(edits(objects), `r:${merged.sourceId}`, lines)?.layer).toBe('L');
    expect(appliedRoadEdit(edits(writeRoads({}, [other], { removed: true }).objects), `r:${merged.sourceId}`, lines)?.removed).toBeUndefined();
  });
});
