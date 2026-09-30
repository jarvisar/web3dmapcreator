import { beforeEach, describe, expect, it } from 'vitest';
import { emptyEdits, type ModelEdits } from '../../core/edit/types';
import { addLayer, commitEdits, deleteLayer, patchObjects, redoEdit, removeObjects, resetObjects, restoreObjects, settleEdits, undoEdit } from './editActions';
import type { EditStep } from './history';
import { useApp } from './store';

const edits = () => useApp.getState().edits;
// Content only: an undo rebuilt from its step can list keys in another order.
const snapshot = (e: ModelEdits) => JSON.stringify({ ...e, objects: Object.fromEntries(Object.entries(e.objects).sort(([a], [b]) => a.localeCompare(b))) });

beforeEach(() => {
  useApp.setState((state) => ({ edits: emptyEdits(), editHistory: { past: [], future: [], coalesce: null }, toasts: [], ui: { ...state.ui, selection: [] } }));
});

describe('undo steps', () => {
  it('undo and redo go through the same states as the edits did', () => {
    let seed = 4;
    const random = () => {
      seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0;
      return ((seed >>> 0) % 1e6) / 1e6;
    };
    const keys = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? `r:${i}` : i % 7 === 0 ? `b:${i}/p` : `b:${i}`));
    const some = () => keys.filter(() => random() < 0.2);
    const states = [snapshot(edits())];
    const layer = addLayer('A')!;
    states.push(snapshot(edits()));
    for (let step = 0; step < 60; step++) {
      const r = random();
      if (r < 0.3) patchObjects(some(), { heightM: Math.round(random() * 100) });
      else if (r < 0.45) removeObjects(some());
      else if (r < 0.55) restoreObjects(some());
      else if (r < 0.62) resetObjects(some());
      else if (r < 0.72) patchObjects(some(), { layer });
      else if (r < 0.8) {
        // A run of changes that undoes as one, like a drag.
        const run = some();
        for (let k = 0; k < 4; k++) patchObjects(run, { widthMm: 1 + k }, 'drag');
        settleEdits();
      } else commitEdits({ ...edits(), shapes: random() < 0.5 ? [] : [{ ...shapeBase, id: `s${step}` }] });
      settleEdits();
      // A change that changed nothing still makes a step, as it always has.
      while (states.length <= useApp.getState().editHistory.past.length) states.push(snapshot(edits()));
    }
    deleteLayer(layer);
    states.push(snapshot(edits()));
    expect(useApp.getState().editHistory.past).toHaveLength(states.length - 1);
    // As if the edits each step came from were long gone, so undo works them out from its step.
    const forget = (steps: EditStep[]) => steps.forEach((s) => delete s.exact);
    forget(useApp.getState().editHistory.past);
    for (let i = states.length - 2; i >= 0; i--) {
      undoEdit();
      expect(snapshot(edits())).toBe(states[i]);
    }
    forget(useApp.getState().editHistory.future);
    for (let i = 1; i < states.length; i++) {
      redoEdit();
      expect(snapshot(edits())).toBe(states[i]);
    }
  });

  it('keeps only what a small edit changed, after a big one', () => {
    const keys = Array.from({ length: 5000 }, (_, i) => `b:${i}`);
    patchObjects(keys, { heightM: 50 });
    patchObjects(['b:7'], { heightM: 60 });
    const [big, small] = useApp.getState().editHistory.past;
    expect(big.objects.size).toBe(5000);
    expect(small.objects.size).toBe(1);
    expect(small.objects.get('b:7')).toEqual({ heightM: 50 });
  });
});

const shapeBase = {
  kind: 'box' as const,
  layer: 'buildings',
  at: [0, 0] as [number, number],
  points: [],
  rotationDeg: 0,
  sizeMm: 5,
  depthMm: 5,
  heightMm: 2,
  liftMm: 0,
  followGround: false,
  text: '',
  font: 'montserrat',
};
