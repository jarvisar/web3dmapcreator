import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildingHeightRange, EDIT_LIMITS, emptyEdits, MAX_SHAPES, MAX_TEXT_LENGTH, sanitizeEdits, type AddedShape, type ModelEdits } from '../../core/edit/types';
import { Projection } from '../../core/geo/projection';
import { roadEditOf } from '../../core/edit/blocks';
import type { SvgRoute } from '../../core/svgmap/routes';
import { clearPicks, deleteRoute } from '../svgmap/routes';
import {
  addLayer,
  addShape,
  assignLayer,
  adoptEdits,
  clearEdits,
  clearEditsFor,
  commitEdits,
  deleteLayer,
  deletePoint,
  duplicateShapes,
  editMark,
  forgetBackup,
  patchObjects,
  redoEdit,
  removeObjects,
  restoreBackup,
  restoreObjects,
  revertEdits,
  setActivePoint,
  setEditMode,
  setSelection,
  settleEdits,
  shapeDefaults,
  takeInLink,
  undoEdit,
  updateShape,
} from './editActions';
import { setModelParts } from './model';
import { BACKUP_KEY, readBackup } from './persist';
import { bringIn, patchSvg, useApp, type ResultMeta } from './store';

function shape(id: string, patch: Partial<AddedShape> = {}): AddedShape {
  return {
    id,
    kind: 'path',
    layer: 'buildings',
    at: [0, 0],
    points: [
      [0, 0],
      [0.001, 0],
      [0.002, 0.001],
    ],
    rotationDeg: 0,
    sizeMm: 1.2,
    depthMm: 1.2,
    heightMm: 1,
    liftMm: 0,
    followGround: true,
    text: '',
    font: 'montserrat',
    ...patch,
  };
}

function reset(edits: ModelEdits = emptyEdits()) {
  useApp.setState((state) => ({
    edits,
    editHistory: { past: [], future: [], coalesce: null },
    toasts: [],
    backup: null,
    svg: { ...state.svg, routes: [], hiddenLines: [] },
    ui: { ...state.ui, selection: [], activePoint: null },
  }));
}

function storage() {
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  return stored;
}

const lastToast = () => useApp.getState().toasts.at(-1)!;
const picksNow = () => ({ routes: useApp.getState().svg.routes, hiddenLines: useApp.getState().svg.hiddenLines });
const road = (lat: number): [number, number][] => [[0, lat], [0.001, lat], [0.002, lat]];
const route = (id: string, lines: [number, number][][]): SvgRoute => ({ id, name: id, color: '#E4002B', width: 0.6, lines });

afterEach(() => vi.unstubAllGlobals());

const edits = () => useApp.getState().edits;

describe('edit history', () => {
  beforeEach(() => reset());

  it('undoes a run of changes with the same tag as one, and each other change on its own', () => {
    patchObjects(['b:1'], { heightM: 10 }, 'height:b:1');
    patchObjects(['b:1'], { heightM: 20 }, 'height:b:1');
    patchObjects(['b:1'], { heightM: 30 }, 'height:b:1');
    settleEdits();
    patchObjects(['b:1'], { heightM: 40 }, 'height:b:1');
    patchObjects(['r:2'], { widthMm: 2 });
    expect(useApp.getState().editHistory.past).toHaveLength(3);
    undoEdit();
    expect(edits().objects['r:2']).toBeUndefined();
    undoEdit();
    expect(edits().objects['b:1'].heightM).toBe(30);
    undoEdit();
    expect(edits().objects['b:1']).toBeUndefined();
    redoEdit();
    redoEdit();
    expect(edits().objects['b:1'].heightM).toBe(40);
  });

  it('drops a shape undo took away from the selection', () => {
    commitEdits({ ...emptyEdits(), shapes: [shape('a')] });
    setSelection(['s:a']);
    undoEdit();
    expect(useApp.getState().ui.selection).toEqual([]);
  });

  it('drops a field set to undefined, and an edit left with nothing', () => {
    patchObjects(['b:1'], { heightM: 10, layer: 'x' });
    patchObjects(['b:1'], { heightM: undefined });
    expect(edits().objects['b:1']).toEqual({ layer: 'x' });
    patchObjects(['b:1'], { layer: undefined });
    expect(edits().objects['b:1']).toBeUndefined();
  });
});

describe('mixed selections', () => {
  it('colours buildings, road blocks and shapes together, and undoes them together', () => {
    const original = {
      ...emptyEdits(),
      layers: [{ id: 'L', name: 'Layer', hex: '#E4002B', line: 'PLA Basic' as const }],
      objects: { 'r:main': { widthMm: 1.2 }, 'r:main@0-0.5': { heightMm: 2 } },
      shapes: [shape('a'), shape('unselected')],
    };
    reset(original);
    assignLayer(['b:1', 'r:main@0-0.5', 's:a'], 'L');
    expect(edits().objects['b:1']).toEqual({ layer: 'L' });
    expect(roadEditOf(edits().objects, 'r:main@0-0.5')).toEqual({ layer: 'L', widthMm: 1.2, heightMm: 2 });
    expect(roadEditOf(edits().objects, 'r:main@0.5-1')).toEqual({ widthMm: 1.2 });
    expect(edits().shapes.map((s) => s.layer)).toEqual(['L', 'buildings']);
    expect(useApp.getState().editHistory.past).toHaveLength(1);
    undoEdit();
    expect(edits()).toEqual(original);
    redoEdit();
    expect(edits().shapes[0].layer).toBe('L');
    expect(edits().objects['b:1'].layer).toBe('L');
  });

  it('gives each kind its own colour when a mixed selection leaves a layer', () => {
    reset({
      ...emptyEdits(),
      layers: [{ id: 'L', name: 'Layer', hex: '#E4002B', line: 'PLA Basic' }],
      objects: { 'b:1': { layer: 'L', heightM: 40 } },
      shapes: [shape('path', { layer: 'L' }), shape('box', { kind: 'box', layer: 'L' })],
    });
    assignLayer(['b:1', 's:path', 's:box'], undefined);
    expect(edits().objects['b:1']).toEqual({ heightM: 40 });
    expect(edits().shapes.map((s) => s.layer)).toEqual(['roads', 'buildings']);
  });
});

it('keeps a drawn road at the same height in the inspector, saved edits and exports', () => {
  const settings = useApp.getState().settings;
  useApp.setState({ settings: { ...settings, roads: { ...settings.roads, thicknessMm: 0.05 } } });
  try {
    const drawn = { ...shape('path'), ...shapeDefaults('path') };
    const saved = sanitizeEdits({ ...emptyEdits(), shapes: [drawn] }).shapes[0];
    expect(drawn.heightMm).toBe(EDIT_LIMITS.shapeHeightMm[0]);
    expect(saved.heightMm).toBe(drawn.heightMm);
  } finally {
    useApp.setState({ settings });
  }
});

describe('removing and clearing', () => {
  beforeEach(() => reset());

  it('removes objects and deletes shapes, with an Undo on the toast', () => {
    commitEdits({ ...emptyEdits(), shapes: [shape('a'), shape('b')] });
    setSelection(['b:1', 's:a']);
    removeObjects(['b:1', 's:a']);
    expect(edits().objects['b:1']).toEqual({ removed: true });
    expect(edits().shapes.map((s) => s.id)).toEqual(['b']);
    expect(useApp.getState().ui.selection).toEqual([]);
    const toast = useApp.getState().toasts.at(-1)!;
    expect(toast.text).toBe('Removed 1 building and 1 shape');
    toast.action!.run();
    expect(edits().objects['b:1']).toBeUndefined();
    expect(edits().shapes.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('clears only the edits it is given', () => {
    commitEdits({ ...emptyEdits(), objects: { 'b:1': { removed: true }, 'b:2': { heightM: 5 } }, shapes: [shape('a'), shape('b')] });
    clearEditsFor(['b:1', 's:b']);
    expect(Object.keys(edits().objects)).toEqual(['b:2']);
    expect(edits().shapes.map((s) => s.id)).toEqual(['a']);
    undoEdit();
    expect(Object.keys(edits().objects)).toEqual(['b:1', 'b:2']);
  });

  it('undoes everything at once, and brings it back', () => {
    commitEdits({ ...emptyEdits(), objects: { 'b:1': { removed: true } }, shapes: [shape('a')] });
    clearEdits();
    expect(edits()).toEqual(emptyEdits());
    useApp.getState().toasts.at(-1)!.action!.run();
    expect(edits().shapes).toHaveLength(1);
  });

  it('puts what was in a deleted layer back in its own colour', () => {
    const id = addLayer('Race')!;
    patchObjects(['r:1'], { layer: id, widthMm: 2 });
    patchObjects(['b:1'], { layer: id });
    commitEdits({ ...edits(), shapes: [shape('a', { layer: id }), shape('b', { kind: 'area', layer: id })] });
    deleteLayer(id);
    expect(edits().layers).toEqual([]);
    expect(edits().objects).toEqual({ 'r:1': { widthMm: 2 } });
    // A drawn route goes back to the roads' colour, an outline to the buildings'.
    expect(edits().shapes.map((s) => s.layer)).toEqual(['roads', 'buildings']);
    expect(edits().version).toBe(emptyEdits().version);
  });

  it('puts a deleted layer back, with what was in it, from the toast', () => {
    const id = addLayer('Race')!;
    patchObjects(['r:1'], { layer: id });
    commitEdits({ ...edits(), shapes: [shape('a', { layer: id })] });
    const before = edits();
    deleteLayer(id);
    expect(lastToast().text).toBe('Deleted Race.');
    lastToast().action!.run();
    expect(edits()).toBe(before);
  });

  it('has its toast Undo take back its own change, not whatever came after it', () => {
    commitEdits({ ...emptyEdits(), shapes: [shape('a'), shape('b')] });
    removeObjects(['b:1', 's:a']);
    const removed = lastToast();
    patchObjects(['b:2'], { heightM: 30 });
    removed.action!.run();
    expect(edits().objects['b:1']).toBeUndefined();
    expect(edits().shapes.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(edits().objects['b:2']).toEqual({ heightM: 30 });
    // Undone already, it does nothing more.
    const steps = useApp.getState().editHistory.past.length;
    removed.action!.run();
    expect(useApp.getState().editHistory.past).toHaveLength(steps);
  });

  it('brings a deleted layer back after other changes, and leaves what went in another layer since', () => {
    const id = addLayer('Race')!;
    const other = addLayer('Other')!;
    patchObjects(['r:1', 'r:2'], { layer: id });
    deleteLayer(id);
    const deleted = lastToast();
    patchObjects(['r:2'], { layer: other });
    deleted.action!.run();
    expect(edits().layers.map((l) => l.id)).toEqual([id, other]);
    expect(edits().objects['r:1']).toEqual({ layer: id });
    expect(edits().objects['r:2']).toEqual({ layer: other });
  });

  it('puts cleared changes back after other changes too', () => {
    commitEdits({ ...emptyEdits(), objects: { 'b:1': { removed: true } }, shapes: [shape('a')] });
    clearEditsFor(['b:1', 's:a']);
    const cleared = lastToast();
    patchObjects(['b:2'], { heightM: 30 });
    cleared.action!.run();
    expect(Object.keys(edits().objects).sort()).toEqual(['b:1', 'b:2']);
    expect(edits().shapes.map((s) => s.id)).toEqual(['a']);
  });

  it('keeps what came after Undo all when that is undone', () => {
    commitEdits({ ...emptyEdits(), objects: { 'b:1': { removed: true } } });
    clearEdits();
    const undo = lastToast();
    patchObjects(['b:2'], { heightM: 30 });
    undo.action!.run();
    expect(Object.keys(edits().objects).sort()).toEqual(['b:1', 'b:2']);
  });

  it('puts a shape back in its own colour when its layer went while it was deleted', () => {
    const id = addLayer('Race')!;
    commitEdits({ ...edits(), shapes: [shape('a', { layer: id })] });
    removeObjects(['s:a']);
    const removed = lastToast();
    deleteLayer(id);
    removed.action!.run();
    expect(edits().shapes[0].layer).toBe('roads');
  });
});

describe('drags', () => {
  beforeEach(() => reset());

  it('puts back what a drag called off changed, with nothing left to redo', () => {
    patchObjects(['b:1'], { heightM: 10 });
    const before = edits();
    const mark = editMark();
    patchObjects(['b:1'], { heightM: 20 }, 'drag-height:b:1');
    patchObjects(['b:1'], { heightM: 30 }, 'drag-height:b:1');
    revertEdits(mark);
    expect(edits()).toEqual(before);
    expect(useApp.getState().editHistory.future).toEqual([]);
    expect(useApp.getState().editHistory.past).toHaveLength(1);
  });

  it("won't put back a drag once something else changed the edits", () => {
    const mark = editMark();
    patchObjects(['b:1'], { heightM: 20 }, 'drag-height:b:1');
    settleEdits();
    patchObjects(['b:2'], { heightM: 5 });
    revertEdits(mark);
    expect(edits().objects['b:2']).toEqual({ heightM: 5 });
  });
});

describe('links, backups and other tabs', () => {
  beforeEach(() => reset());

  it("adds a link's edits to the ones here, and its Undo takes them back out", () => {
    commitEdits({ ...emptyEdits(), objects: { 'b:mine': { removed: true } } });
    const state = useApp.getState();
    const brought = bringIn(state.edits, picksNow(), { edits: { ...emptyEdits(), objects: { 'b:theirs': { heightM: 50 } } } })!;
    takeInLink(brought);
    expect(Object.keys(edits().objects).sort()).toEqual(['b:mine', 'b:theirs']);
    expect(lastToast().text).toBe('Added 1 edit from the link.');
    expect(useApp.getState().backup).toBeNull();
    lastToast().action!.run();
    expect(Object.keys(edits().objects)).toEqual(['b:mine']);
  });

  it('keeps ours aside where the link changed them, until the link is taken back out', () => {
    const stored = storage();
    commitEdits({ ...emptyEdits(), objects: { 'b:1': { heightM: 10 } } });
    const mine = edits();
    const brought = bringIn(mine, picksNow(), { edits: { ...emptyEdits(), objects: { 'b:1': { heightM: 99 } } } })!;
    takeInLink(brought);
    expect(edits().objects['b:1']).toEqual({ heightM: 99 });
    expect(lastToast().text).toMatch(/Yours that it changed are kept aside/);
    expect(useApp.getState().backup?.edits).toBe(mine);
    expect(readBackup()?.reason).toBe('link');
    lastToast().action!.run();
    expect(edits()).toBe(mine);
    expect(useApp.getState().backup).toBeNull();
    expect(stored.has(BACKUP_KEY)).toBe(false);
  });

  it("adds a link's picked roads, and never clears the ones here", () => {
    patchSvg({ routes: [route('mine', [road(0)])], hiddenLines: [] });
    const brought = bringIn(edits(), picksNow(), { picks: { routes: [], hiddenLines: [road(0.01)] } })!;
    takeInLink(brought);
    expect(picksNow().routes[0].lines).toHaveLength(1);
    expect(picksNow().hiddenLines).toHaveLength(1);
    expect(lastToast().text).toBe('Added 1 picked road from the link.');
    lastToast().action!.run();
    expect(picksNow().hiddenLines).toHaveLength(0);
    expect(bringIn(edits(), picksNow(), { edits: null, picks: null })).toBeNull();
  });

  it('keeps what Undo all cleared aside, to put back and swap again', () => {
    storage();
    commitEdits({ ...emptyEdits(), objects: { 'b:1': { removed: true } } });
    const before = edits();
    clearEdits();
    expect(edits().objects).toEqual({});
    expect(useApp.getState().backup).toMatchObject({ reason: 'clear', edits: before });
    commitEdits({ ...emptyEdits(), objects: { 'b:2': { removed: true } } });
    const after = edits();
    restoreBackup();
    expect(edits()).toBe(before);
    expect(useApp.getState().backup).toMatchObject({ reason: 'restore', edits: after });
    restoreBackup();
    expect(edits()).toBe(after);
    forgetBackup();
    expect(useApp.getState().backup).toBeNull();
    expect(readBackup()).toBeNull();
  });

  it("Undo on Undo all puts the edits back and drops the copy it kept", () => {
    storage();
    commitEdits({ ...emptyEdits(), objects: { 'b:1': { removed: true } } });
    const before = edits();
    clearEdits();
    lastToast().action!.run();
    expect(edits()).toBe(before);
    expect(useApp.getState().backup).toBeNull();
  });

  it("takes on another tab's edits, without undo steps that would write the old ones back", () => {
    commitEdits({ ...emptyEdits(), shapes: [shape('mine')] });
    setSelection(['s:mine', 'b:1']);
    const theirs: ModelEdits = { ...emptyEdits(), objects: { 'b:1': { removed: true } } };
    adoptEdits(theirs);
    expect(edits()).toBe(theirs);
    expect(useApp.getState().editHistory.past).toEqual([]);
    expect(useApp.getState().ui.selection).toEqual(['b:1']);
  });

  it('keeps a bridge put back while its road is removed, through later changes to it', () => {
    commitEdits({ ...emptyEdits(), objects: { 'r:x': { removed: true } } });
    restoreObjects(['br:x']);
    expect(edits().objects['br:x']).toEqual({ removed: false });
    patchObjects(['br:x'], { widthMm: 2 });
    expect(edits().objects['br:x']).toEqual({ removed: false, widthMm: 2 });
    // With the road back, the bridge needn't say so any more.
    restoreObjects(['r:x']);
    expect(edits().objects['br:x']).toEqual({ widthMm: 2 });
    patchObjects(['br:x'], { widthMm: 3 });
    expect(edits().objects['br:x']).toEqual({ widthMm: 3 });
  });

  it('keeps picked roads Undo all picks cleared aside, and puts them back with Undo', () => {
    storage();
    patchSvg({ routes: [route('mine', [road(0)])], hiddenLines: [road(0.01)] });
    const before = picksNow();
    clearPicks();
    expect(picksNow().routes[0].lines).toEqual([]);
    expect(picksNow().hiddenLines).toEqual([]);
    expect(useApp.getState().backup?.picks).toEqual(before);
    lastToast().action!.run();
    expect(picksNow()).toEqual(before);
    expect(useApp.getState().backup).toBeNull();
  });

  it('puts a deleted route back with Undo', () => {
    patchSvg({ routes: [route('a', [road(0)]), route('b', [])], hiddenLines: [] });
    const before = picksNow().routes;
    deleteRoute('a');
    expect(picksNow().routes.map((r) => r.id)).toEqual(['b']);
    lastToast().action!.run();
    expect(picksNow().routes).toBe(before);
  });
});

describe('limits', () => {
  beforeEach(() => reset());

  it("won't add or duplicate shapes past the limit, which saved edits and exports hold to", () => {
    commitEdits({ ...emptyEdits(), shapes: Array.from({ length: MAX_SHAPES - 1 }, (_, i) => shape(`s${i}`)) });
    expect(addShape(shape('x'))).not.toBeNull();
    expect(edits().shapes).toHaveLength(MAX_SHAPES);
    expect(addShape(shape('y'))).toBeNull();
    expect(edits().shapes).toHaveLength(MAX_SHAPES);
    expect(useApp.getState().toasts.at(-1)!.text).toMatch(/at most 500 added shapes/);
    duplicateShapes(['s0']);
    expect(edits().shapes).toHaveLength(MAX_SHAPES);
    // Everything the editor made survives saving and the worker.
    expect(sanitizeEdits(edits()).shapes).toHaveLength(MAX_SHAPES);
  });

  it('starts text no longer than the limit', () => {
    useApp.setState({ placeName: 'A'.repeat(200) });
    expect(shapeDefaults('text').text).toHaveLength(MAX_TEXT_LENGTH);
  });

  it('starts new shapes in a model colour, not the first custom layer', () => {
    addLayer('Route');
    expect(shapeDefaults('text').layer).toBe('buildings');
    expect(shapeDefaults('path').layer).toBe('roads');
  });

  it('puts a copy beside its original, and inside the model near its edge', () => {
    const frame = { center: [-87.63, 41.88] as [number, number], rotationDeg: 0, mmPerMetre: 0.07, buildingMmPerMetre: 0.07 };
    setModelParts([], { editable: true, roads: null, objects: {}, ground: null, frame });
    useApp.setState((state) => ({ generation: { ...state.generation, result: { bounds: [-100, -100, 0, 100, 100, 20] } as ResultMeta } }));
    const projection = new Projection(frame.center, 0, 0.07);
    const at = (x: number, y: number) => projection.modelToGeo(x, y);
    commitEdits({ ...emptyEdits(), shapes: [shape('mid', { kind: 'box', at: at(0, 0), points: [] }), shape('edge', { kind: 'box', at: at(98, -98), points: [] })] });
    duplicateShapes(['mid']);
    duplicateShapes(['edge']);
    const [, , mid, edge] = edits().shapes.map((s) => projection.toModel(...s.at));
    expect(mid[0]).toBeCloseTo(5, 3);
    expect(mid[1]).toBeCloseTo(-5, 3);
    expect(edge[0]).toBeCloseTo(93, 3);
    expect(edge[1]).toBeCloseTo(-93, 3);
    expect(useApp.getState().ui.selection).toEqual([`s:${edits().shapes[3].id}`]);
    useApp.setState((state) => ({ generation: { ...state.generation, result: null } }));
    setModelParts([]);
  });

  it('holds building heights to what both limits allow at the scale', () => {
    // At 0.07 mm/m the printed limit is the tighter one, at 0.01 the real one.
    expect(buildingHeightRange(0.07)).toEqual([EDIT_LIMITS.buildingHeightMm[0], EDIT_LIMITS.buildingHeightMm[1]]);
    const [low, high] = buildingHeightRange(0.01);
    expect(high).toBeCloseTo(EDIT_LIMITS.heightM[1] * 0.01, 9);
    expect(low).toBe(EDIT_LIMITS.buildingHeightMm[0]);
    expect(buildingHeightRange(2)[0]).toBe(EDIT_LIMITS.heightM[0] * 2);
  });
});

describe('points of drawn shapes', () => {
  beforeEach(() => reset());

  it('deletes a point, but keeps enough for the shape', () => {
    commitEdits({ ...emptyEdits(), shapes: [shape('p'), shape('q', { kind: 'area' })] });
    setSelection(['s:p']);
    setActivePoint({ shape: 'p', index: 1 });
    deletePoint('p', 1);
    expect(edits().shapes[0].points).toHaveLength(2);
    expect(useApp.getState().ui.activePoint).toBeNull();
    // A path needs two points and an area three.
    deletePoint('p', 0);
    expect(edits().shapes[0].points).toHaveLength(2);
    deletePoint('q', 0);
    expect(edits().shapes[1].points).toHaveLength(3);
    expect(useApp.getState().toasts.at(-1)!.text).toMatch(/at least 3 points/);
  });

  it('forgets the picked point when the selection changes', () => {
    commitEdits({ ...emptyEdits(), shapes: [shape('p')] });
    setSelection(['s:p']);
    setActivePoint({ shape: 'p', index: 0 });
    setSelection([]);
    expect(useApp.getState().ui.activePoint).toBeNull();
  });
  it('forgets a picked point that undo took away, or edit mode left behind', () => {
    commitEdits({ ...emptyEdits(), shapes: [shape('p', { points: [[0, 0], [0.001, 0]] })] });
    setSelection(['s:p']);
    // A point added from the dot between two, then picked, as a tap on the dot does.
    updateShape('p', { points: [[0, 0], [0.0005, 0], [0.001, 0]] });
    setActivePoint({ shape: 'p', index: 2 });
    undoEdit();
    expect(useApp.getState().ui.activePoint).toBeNull();
    const steps = useApp.getState().editHistory.past.length;
    // Nothing to delete, and no empty undo step either.
    deletePoint('p', 2);
    expect(useApp.getState().editHistory.past).toHaveLength(steps);
    setActivePoint({ shape: 'p', index: 0 });
    setEditMode(false);
    expect(useApp.getState().ui.activePoint).toBeNull();
  });
});
