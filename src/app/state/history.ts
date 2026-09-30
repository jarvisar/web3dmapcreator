// Undo steps for the edits, each as what it changed rather than a copy of
// the edits before it. With one edit reaching every building in San
// Francisco, a copy per step held 630 MB after a hundred more small edits.
// Layers and shapes are few and kept whole, object edits by the keys that
// changed.

import type { AddedShape, EditLayer, ModelEdits, ObjectEdit } from '../../core/edit/types';

export interface EditStep {
  version: number;
  layers: EditLayer[];
  shapes: AddedShape[];
  /** Object edits as they were, by the keys the step changed. Undefined for none. */
  objects: Map<string, ObjectEdit | undefined>;
  /** The edits it goes back to, while something else keeps them: the same object, keys in the same order. */
  exact?: WeakRef<ModelEdits>;
}

/**
 * The step back from `after` to `before`. `touched`, when given, is every
 * object key the change wrote, so the rest needn't be compared: with a
 * hundred thousand edits that took longer than the change itself.
 */
export function stepBetween(before: ModelEdits, after: ModelEdits, touched?: Iterable<string>): EditStep {
  return { version: before.version, layers: before.layers, shapes: before.shapes, objects: changedObjects(before.objects, after.objects, touched), exact: new WeakRef(before) };
}

/** A step carried on by another change undone with it: keys it hadn't changed yet go back to before that change. */
export function extendStep(step: EditStep, before: ModelEdits, after: ModelEdits, touched?: Iterable<string>): EditStep {
  if (before.objects === after.objects) return step;
  let objects: Map<string, ObjectEdit | undefined> | null = null;
  for (const [key, value] of changedObjects(before.objects, after.objects, touched)) {
    if (step.objects.has(key)) continue;
    objects ??= new Map(step.objects);
    objects.set(key, value);
  }
  return objects ? { ...step, objects } : step;
}

/** The edits a step goes back to from `edits`, and the step that comes forward again. */
export function applyStep(edits: ModelEdits, step: EditStep): { edits: ModelEdits; back: EditStep } {
  const back = new Map<string, ObjectEdit | undefined>();
  for (const key of step.objects.keys()) back.set(key, edits.objects[key]);
  const forward: EditStep = { version: edits.version, layers: edits.layers, shapes: edits.shapes, objects: back, exact: new WeakRef(edits) };
  const exact = step.exact?.deref();
  if (exact) return { edits: exact, back: forward };
  let objects = edits.objects;
  if (step.objects.size) {
    // Keys put back go at the end, which only the order of saved edits shows.
    objects = { ...edits.objects };
    for (const [key, value] of step.objects) {
      if (value === undefined) delete objects[key];
      else objects[key] = value;
    }
  }
  return { edits: { version: step.version, layers: step.layers, objects, shapes: step.shapes }, back: forward };
}

function changedObjects(before: Record<string, ObjectEdit>, after: Record<string, ObjectEdit>, touched?: Iterable<string>): Map<string, ObjectEdit | undefined> {
  const out = new Map<string, ObjectEdit | undefined>();
  if (before === after) return out;
  if (touched) {
    for (const key of touched) if (before[key] !== after[key]) out.set(key, before[key]);
    return out;
  }
  for (const key in before) if (before[key] !== after[key]) out.set(key, before[key]);
  for (const key in after) if (!(key in before)) out.set(key, undefined);
  return out;
}
