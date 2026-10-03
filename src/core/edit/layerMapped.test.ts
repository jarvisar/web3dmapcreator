import { describe, expect, it } from 'vitest';
import { Projection } from '../geo/projection';
import { pointInMulti } from '../geometry/polygon';
import { generateModel, type ModelSpec } from '../pipeline/generate';
import type { SourceData, SourceFeature } from '../pipeline/source';
import { cloneSettings, DEFAULT_PALETTE, type AreaSpec } from '../settings';
import type { LonLat, MultiPolygon } from '../types';
import { appliedRoadEdit, blockLines, shownLines } from '../../app/viewer/blocks';
import { RoadIndex } from '../../app/viewer/roads';
import { roadLines } from './lines';
import { EditSession } from './session';
import { emptyEdits, type ModelEdits } from './types';

const LAT = 45;
const LON = 0.01;
const M_LAT = 1 / 111320;
const M_LON = 1 / (111320 * Math.cos((LAT * Math.PI) / 180));
const at = (x: number, y: number): LonLat => [LON + x * M_LON, LAT + y * M_LAT];
const area: AreaSpec = { center: [LON, LAT], widthM: 1500, heightM: 800, rotationDeg: 0, shape: 'rectangle', cornerRadius: 0.1 };
const XS = [-700, -400, -200, 0, 200, 400, 700];
const oneway = { access_restrictions: [{ access_type: 'denied', when: { heading: 'backward' } }] };
const line = (id: string, coordinates: LonLat[], props: Record<string, unknown>): SourceFeature => ({ id, geometry: { type: 'LineString', coordinates }, props });

// A divided street along y = 0, its carriageways 6 m either side, crossed
// every 200 m, and a primary road along y = -300 with a footway beside it
// for 600 m that then turns away north.
function data(): SourceData {
  return {
    release: 'test',
    features: {
      segment: [
        line('north', XS.map((x) => at(x, 6)), { subtype: 'road', class: 'secondary', ...oneway }),
        line('south', [...XS].reverse().map((x) => at(x, -6)), { subtype: 'road', class: 'secondary', ...oneway }),
        ...XS.slice(1, -1).map((x) => line(`cross${x}`, [at(x, -200), at(x, -6), at(x, 6), at(x, 300)], { subtype: 'road', class: 'residential' })),
        line('main', [at(-700, -300), at(700, -300)], { subtype: 'road', class: 'primary' }),
        line('walk', [at(-300, -294), at(300, -294), at(300, -220)], { subtype: 'road', class: 'footway' }),
      ],
    },
  };
}

async function model() {
  const settings = cloneSettings();
  settings.terrain.resolution = 64;
  const spec = await generateModel({ area, settings, data: data(), elevation: null });
  const projection = new Projection(area.center, 0, spec.mmPerMetre);
  return { spec, projection, settings, session: new EditSession(spec, settings, projection) };
}

const layered = (objects: ModelEdits['objects']): ModelEdits => ({ ...emptyEdits(), layers: [{ id: 'L', name: 'Mine', hex: '#FF0000', line: 'PLA Basic' }], objects });
const polygonsOf = (spec: ModelSpec, id: string): MultiPolygon => (spec.layers.find((l) => l.id === id)?.solids ?? []).flatMap((s) => (s.kind === 'prism' ? [s.polygon] : []));

describe('roads in a custom layer', () => {
  it('prints a merged divided road as both its carriageways, as mapped, in the layer', async () => {
    const { spec, projection, session } = await model();
    const merged = spec.edit!.roads.find((p) => p.partner);
    expect(merged).toBeDefined();
    const mine = merged!.sourceId;
    const other = merged!.partner!;
    const y = (id: string) => (id === 'north' ? 6 : -6);
    const [mx, my] = projection.toModel(...at(100, y(mine)));
    const [ox, oy] = projection.toModel(...at(100, y(other)));
    // Generated, both are one line down the middle.
    expect(pointInMulti(mx, my, polygonsOf(spec, 'roads'))).toBe(false);

    const edits = layered({ [`r:${mine}`]: { layer: 'L' } });
    const update = await session.update(edits, 1);
    expect(update.parts.map((p) => p.id)).toContain('layer:L');
    const edited = await session.edited(edits, DEFAULT_PALETTE);
    // The merged line stood for both, so both take its layer.
    expect(pointInMulti(mx, my, polygonsOf(edited, 'layer:L'))).toBe(true);
    expect(pointInMulti(ox, oy, polygonsOf(edited, 'layer:L'))).toBe(true);

    // The other one taken out goes on its own, and this one stays.
    const own = layered({ [`r:${mine}`]: { layer: 'L' }, [`r:${other}`]: { removed: true } });
    const apart = await session.edited(own, DEFAULT_PALETTE);
    expect(pointInMulti(mx, my, polygonsOf(apart, 'layer:L'))).toBe(true);
    expect(pointInMulti(ox, oy, polygonsOf(apart, 'layer:L'))).toBe(false);
    expect(pointInMulti(ox, oy, polygonsOf(apart, 'roads'))).toBe(false);
  });

  it('gives a footway in a layer back the stretch the tidy dropped beside a main road', async () => {
    const { spec, projection, session } = await model();
    const [wx, wy] = projection.toModel(...at(0, -294));
    const [nx, ny] = projection.toModel(...at(300, -250));
    // Dropped beside the main road, kept where it turns away.
    expect(pointInMulti(wx, wy, polygonsOf(spec, 'paths'))).toBe(false);
    expect(pointInMulti(nx, ny, polygonsOf(spec, 'paths'))).toBe(true);

    const edits = layered({ 'r:walk': { layer: 'L' } });
    await session.update(edits, 1);
    const edited = await session.edited(edits, DEFAULT_PALETTE);
    expect(pointInMulti(wx, wy, polygonsOf(edited, 'layer:L'))).toBe(true);
    expect(pointInMulti(nx, ny, polygonsOf(edited, 'layer:L'))).toBe(true);

    // Taken out of the layer, it's tidied again.
    const back = await session.edited(emptyEdits(), DEFAULT_PALETTE);
    expect(pointInMulti(wx, wy, polygonsOf(back, 'paths'))).toBe(false);
  });

  it('leaves roads tidied for any other edit', async () => {
    const { spec, projection, session } = await model();
    const merged = spec.edit!.roads.find((p) => p.partner)!;
    const edits = { ...emptyEdits(), objects: { [`r:${merged.sourceId}`]: { widthMm: 1 } } };
    const edited = await session.edited(edits, DEFAULT_PALETTE);
    const [fx, fy] = projection.toModel(...at(100, 0));
    expect(pointInMulti(fx, fy, polygonsOf(edited, 'roads'))).toBe(true);
    const [wx, wy] = projection.toModel(...at(0, -294));
    expect(pointInMulti(wx, wy, polygonsOf(edited, 'paths'))).toBe(false);
  });

  it('picks what it prints in the viewer', async () => {
    const { spec } = await model();
    const lines = roadLines(spec.edit!, -spec.baseZ, 0.6);
    expect(lines.mapped?.keys).toEqual(expect.arrayContaining(['r:north', 'r:south', 'r:walk']));
    // Nothing in a layer, the lines are the generated ones.
    expect(shownLines(lines, emptyEdits())).toBe(lines);

    const merged = spec.edit!.roads.find((p) => p.partner)!;
    const mine = `r:${merged.sourceId}`;
    const other = `r:${merged.partner}`;
    const edits = layered({ [mine]: { layer: 'L' } });
    const index = new RoadIndex(blockLines(lines, edits));
    // The other carriageway has lines of its own again, tied to this one.
    const pieces = index.piecesOf(other).filter((p) => index.lines.keys[p] === other);
    expect(pieces.length).toBeGreaterThan(0);
    expect(pieces.every((p) => index.lines.partners![p] === mine)).toBe(true);
    expect(appliedRoadEdit(edits, other, lines)?.layer).toBe('L');
    // The footway's dropped stretch can be picked again once it's in a layer.
    const walk = new RoadIndex(blockLines(lines, layered({ 'r:walk': { layer: 'L' } })));
    const before = new RoadIndex(blockLines(lines, emptyEdits()));
    const length = (roads: RoadIndex) =>
      roads.piecesOf('r:walk').reduce((sum, p) => {
        const { starts, points } = roads.lines;
        let total = 0;
        for (let k = starts[p] + 1; k < starts[p + 1]; k++) total += Math.hypot(points[k * 3] - points[k * 3 - 3], points[k * 3 + 1] - points[k * 3 - 2]);
        return sum + total;
      }, 0);
    expect(length(walk)).toBeGreaterThan(length(before) + 30);
  });
});
