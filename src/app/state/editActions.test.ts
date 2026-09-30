import { beforeEach, describe, expect, it } from 'vitest';
import { emptyEdits, type AddedShape, type ModelEdits } from '../../core/edit/types';
import {
  addLayer,
  clearEdits,
  clearEditsFor,
  commitEdits,
  deleteLayer,
  deletePoint,
  patchObjects,
  redoEdit,
  removeObjects,
  setActivePoint,
  setSelection,
  settleEdits,
  undoEdit,
} from './editActions';
import { useApp } from './store';

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
    ui: { ...state.ui, selection: [], activePoint: null },
  }));
}

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
    commitEdits({ ...edits(), shapes: [shape('a', { layer: id })] });
    deleteLayer(id);
    expect(edits().layers).toEqual([]);
    expect(edits().objects).toEqual({ 'r:1': { widthMm: 2 } });
    expect(edits().shapes[0].layer).toBe('buildings');
    expect(edits().version).toBe(emptyEdits().version);
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
});
