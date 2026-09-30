// Editing the model: the edits, undo and redo, the selection and the tool,
// and keeping the worker's copy of the edits in step. Every change to the
// edits goes through commitEdits, so each one can be undone.

import { CancelledError } from '../../core/engine/client';
import { kindOf, objectOf, shapeKey } from '../../core/edit/keys';
import { editCount, emptyEdits, MAX_LAYERS, type AddedShape, type EditLayer, type ModelEdits, type ObjectEdit } from '../../core/edit/types';
import { FILAMENTS } from '../../core/settings';
import { getEngine } from './engine';
import { describeCounts } from '../viewer/edit/describe';
import { applyEditUpdate, getEditData } from './model';
import { toast, useApp, type EditTool } from './store';

const HISTORY_LIMIT = 100;

const set = useApp.setState;
const get = useApp.getState;

/**
 * Replace the edits. Changes tagged with the same `coalesce` in a row (the
 * steps of a drag, keystrokes in a field) undo as one.
 */
export function commitEdits(next: ModelEdits, coalesce?: string): void {
  set((state) => {
    if (next === state.edits) return {};
    const history = state.editHistory;
    const merge = coalesce !== undefined && coalesce === history.coalesce;
    return {
      edits: next,
      editHistory: {
        past: merge ? history.past : [...history.past, state.edits].slice(-HISTORY_LIMIT),
        future: [],
        coalesce: coalesce ?? null,
      },
    };
  });
}

/** Ends a coalescing run, so the next change undoes on its own. */
export function settleEdits(): void {
  set((state) => (state.editHistory.coalesce ? { editHistory: { ...state.editHistory, coalesce: null } } : {}));
}

export function undoEdit(): void {
  set((state) => {
    const { past, future } = state.editHistory;
    if (!past.length) return {};
    return {
      edits: past[past.length - 1],
      editHistory: { past: past.slice(0, -1), future: [state.edits, ...future], coalesce: null },
      ui: { ...state.ui, selection: keep(state.ui.selection, past[past.length - 1]) },
    };
  });
}

export function redoEdit(): void {
  set((state) => {
    const { past, future } = state.editHistory;
    if (!future.length) return {};
    return {
      edits: future[0],
      editHistory: { past: [...past, state.edits], future: future.slice(1), coalesce: null },
      ui: { ...state.ui, selection: keep(state.ui.selection, future[0]) },
    };
  });
}

/** A selection without shapes the edits no longer have. */
function keep(selection: string[], edits: ModelEdits): string[] {
  const shapes = new Set(edits.shapes.map((s) => shapeKey(s.id)));
  return selection.filter((key) => kindOf(key) !== 'shape' || shapes.has(key));
}

export function clearEdits(): void {
  const edits = get().edits;
  if (!editCount(edits) && !edits.layers.length) return;
  commitEdits(emptyEdits());
  setSelection([]);
  toast('Every edit was undone.', 'info', { label: 'Undo', run: undoEdit });
}

// ------------------------------------------------------------- selection

export function setSelection(selection: string[]): void {
  set((state) => {
    const same = selection.length === state.ui.selection.length && selection.every((key, i) => key === state.ui.selection[i]);
    return same ? {} : { ui: { ...state.ui, selection, activePoint: null } };
  });
}

/** A point of a path or area to act on, or null for none. */
export function setActivePoint(activePoint: { shape: string; index: number } | null): void {
  set((state) => ({ ui: { ...state.ui, activePoint } }));
}

/** Deletes a point of a drawn path or area, if it has enough left. */
export function deletePoint(shape: string, index: number): void {
  const found = get().edits.shapes.find((s) => s.id === shape);
  if (!found) return;
  const minimum = found.kind === 'area' ? 3 : 2;
  if (found.points.length <= minimum) {
    toast(`A ${found.kind === 'area' ? 'drawn area' : 'drawn path'} needs at least ${minimum} points.`);
    return;
  }
  const points = found.points.filter((_, i) => i !== index);
  updateShape(shape, { points, at: points[0] });
  setActivePoint(null);
}

/** Drops edits for things this model doesn't have, from another area or other settings. */
export function clearEditsFor(keys: string[]): void {
  if (!keys.length) return;
  const edits = get().edits;
  const gone = new Set(keys);
  const objects = Object.fromEntries(Object.entries(edits.objects).filter(([key]) => !gone.has(key)));
  const shapes = edits.shapes.filter((shape) => !gone.has(shapeKey(shape.id)));
  commitEdits({ ...edits, objects, shapes });
  toast(`Cleared ${keys.length} ${keys.length === 1 ? 'change' : 'changes'}.`, 'info', { label: 'Undo', run: undoEdit });
}

export function toggleSelected(keys: string[]): void {
  const current = new Set(get().ui.selection);
  const allIn = keys.every((key) => current.has(key));
  for (const key of keys) {
    if (allIn) current.delete(key);
    else current.add(key);
  }
  setSelection([...current]);
}

export function setEditMode(editMode: boolean): void {
  set((state) => ({ ui: { ...state.ui, editMode, tool: editMode ? state.ui.tool : 'select', selection: editMode ? state.ui.selection : [] } }));
  settleEdits();
}

export function setTool(tool: EditTool): void {
  set((state) => ({ ui: { ...state.ui, tool, editMode: true, activePoint: null } }));
}

// --------------------------------------------------------------- objects

/** Keys the same edit applies to: a part's edit or its whole object's, as selected. */
export function patchObjects(keys: string[], patch: Partial<ObjectEdit>, coalesce?: string): void {
  const edits = get().edits;
  const objects = { ...edits.objects };
  for (const key of keys) {
    if (kindOf(key) === 'shape') continue;
    const next: ObjectEdit = { ...objects[key], ...patch };
    for (const field of Object.keys(next) as (keyof ObjectEdit)[]) if (next[field] === undefined) delete next[field];
    if (next.removed === false) delete next.removed;
    if (Object.keys(next).length) objects[key] = next;
    else delete objects[key];
  }
  commitEdits({ ...edits, objects }, coalesce);
}

/** Back as generated: every edit of these objects, and of their parts, dropped. */
export function resetObjects(keys: string[]): void {
  const edits = get().edits;
  const objects = { ...edits.objects };
  const targets = new Set(keys);
  for (const key of Object.keys(objects)) if (targets.has(key) || targets.has(objectOf(key))) delete objects[key];
  const shapes = edits.shapes.filter((s) => !targets.has(shapeKey(s.id)));
  commitEdits({ ...edits, objects, shapes });
}

/** Removes objects, and deletes added shapes, among the keys. */
export function removeObjects(keys: string[]): void {
  const shapes = new Set(keys.filter((key) => kindOf(key) === 'shape'));
  const others = keys.filter((key) => !shapes.has(key));
  const edits = get().edits;
  const objects = { ...edits.objects };
  for (const key of others) objects[key] = { ...objects[key], removed: true };
  commitEdits({ ...edits, objects, shapes: edits.shapes.filter((s) => !shapes.has(shapeKey(s.id))) });
  setSelection([]);
  if (keys.length) toast(`Removed ${describeCounts(keys)}`, 'info', { label: 'Undo', run: undoEdit });
}

export function restoreObjects(keys: string[]): void {
  patchObjects(keys, { removed: undefined });
}

// ---------------------------------------------------------------- layers

const LAYER_COLOURS: [string, 'PLA Basic' | 'PLA Matte'][] = [
  [FILAMENTS['PLA Basic'].Red, 'PLA Basic'],
  [FILAMENTS['PLA Basic']['Cobalt Blue'], 'PLA Basic'],
  [FILAMENTS['PLA Basic']['Sunflower Yellow'], 'PLA Basic'],
  [FILAMENTS['PLA Basic'].Orange, 'PLA Basic'],
  [FILAMENTS['PLA Basic'].Purple, 'PLA Basic'],
  [FILAMENTS['PLA Basic'].Turquoise, 'PLA Basic'],
  [FILAMENTS['PLA Basic']['Hot Pink'], 'PLA Basic'],
  [FILAMENTS['PLA Basic'].Gold, 'PLA Basic'],
];

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** A new custom layer, in a colour none of the others have. Returns its id, or null at the limit. */
export function addLayer(name?: string): string | null {
  const edits = get().edits;
  if (edits.layers.length >= MAX_LAYERS) {
    toast(`A model can have at most ${MAX_LAYERS} custom layers.`, 'error');
    return null;
  }
  const used = new Set(edits.layers.map((l) => l.hex));
  const [hex, line] = LAYER_COLOURS.find(([h]) => !used.has(h)) ?? LAYER_COLOURS[edits.layers.length % LAYER_COLOURS.length];
  const layer: EditLayer = { id: newId(), name: name?.trim() || `Layer ${edits.layers.length + 1}`, hex, line };
  commitEdits({ ...edits, layers: [...edits.layers, layer] });
  return layer.id;
}

export function updateLayer(id: string, patch: Partial<Omit<EditLayer, 'id'>>, coalesce?: string): void {
  const edits = get().edits;
  const layers = edits.layers.map((layer) => (layer.id === id ? { ...layer, ...patch, hex: (patch.hex ?? layer.hex).toUpperCase() } : layer));
  commitEdits({ ...edits, layers }, coalesce);
}

/** Deletes a layer. What was in it goes back to its own colour, and its shapes to the buildings'. */
export function deleteLayer(id: string): void {
  const edits = get().edits;
  const objects: Record<string, ObjectEdit> = {};
  for (const [key, edit] of Object.entries(edits.objects)) {
    if (edit.layer !== id) {
      objects[key] = edit;
      continue;
    }
    const rest = { ...edit };
    delete rest.layer;
    if (Object.keys(rest).length) objects[key] = rest;
  }
  const shapes = edits.shapes.map((shape) => (shape.layer === id ? { ...shape, layer: 'buildings' } : shape));
  commitEdits({ ...edits, layers: edits.layers.filter((layer) => layer.id !== id), objects, shapes });
}

// ---------------------------------------------------------------- shapes

let created: string | null = null;

export function addShape(shape: Omit<AddedShape, 'id'>): string {
  const edits = get().edits;
  const id = newId();
  created = id;
  commitEdits({ ...edits, shapes: [...edits.shapes, { ...shape, id }] });
  setSelection([shapeKey(id)]);
  return id;
}

/** Whether this shape was just added, once: a new text shape wants its text typed. */
export function takeCreatedShape(id: string): boolean {
  if (created !== id) return false;
  created = null;
  return true;
}

export function updateShape(id: string, patch: Partial<Omit<AddedShape, 'id'>>, coalesce?: string): void {
  const edits = get().edits;
  let changed = false;
  const shapes = edits.shapes.map((shape) => {
    if (shape.id !== id) return shape;
    changed = true;
    return { ...shape, ...patch };
  });
  if (changed) commitEdits({ ...edits, shapes }, coalesce);
}

export function updateShapes(ids: string[], patch: Partial<Omit<AddedShape, 'id'>>, coalesce?: string): void {
  const edits = get().edits;
  const wanted = new Set(ids);
  commitEdits({ ...edits, shapes: edits.shapes.map((shape) => (wanted.has(shape.id) ? { ...shape, ...patch } : shape)) }, coalesce);
}

export function duplicateShapes(ids: string[]): void {
  const edits = get().edits;
  const copies = edits.shapes
    .filter((shape) => ids.includes(shape.id))
    .map((shape) => ({ ...structuredClone(shape), id: newId() }));
  if (!copies.length) return;
  commitEdits({ ...edits, shapes: [...edits.shapes, ...copies] });
  setSelection(copies.map((shape) => shapeKey(shape.id)));
}

/**
 * Shape defaults. A drawn line starts out as a road, in the roads' colour and
 * at their height, and a drawn outline as a building with a flat roof.
 */
export function shapeDefaults(kind: AddedShape['kind']): Omit<AddedShape, 'id' | 'at' | 'points'> {
  const fallback = kind === 'path' ? 'roads' : 'buildings';
  const common = { kind, layer: firstLayer(fallback), rotationDeg: 0, liftMm: 0, text: '', font: 'montserrat' };
  switch (kind) {
    case 'text':
      return { ...common, sizeMm: 5, depthMm: 5, heightMm: 1.2, followGround: true, text: get().placeName || 'Label' };
    case 'box':
      return { ...common, sizeMm: 8, depthMm: 8, heightMm: 4, followGround: false };
    case 'cylinder':
      return { ...common, sizeMm: 6, depthMm: 6, heightMm: 6, followGround: false };
    case 'pin':
      return { ...common, sizeMm: 7, depthMm: 7, heightMm: 2.5, followGround: false };
    case 'path': {
      const roads = get().settings.roads;
      return { ...common, sizeMm: 0.7, depthMm: 0.7, heightMm: roads.thicknessMm, followGround: true };
    }
    case 'area':
      return { ...common, sizeMm: 10, depthMm: 10, heightMm: 4, followGround: false };
  }
}

/** A new shape goes in the first custom layer, or a colour of the model. */
function firstLayer(fallback: string): string {
  return get().edits.layers[0]?.id ?? fallback;
}

// ------------------------------------------------------------------ sync

let editVersion = 0;
let timer = 0;
let started = false;
let latestSent = 0;

function setPending(editsPending: boolean): void {
  set((state) => (state.ui.editsPending === editsPending ? {} : { ui: { ...state.ui, editsPending } }));
}

export function setNotes(editNotes: Record<string, string>): void {
  set((state) => ({ ui: { ...state.ui, editNotes } }));
}

/** The version the next request to the worker will carry. */
export function nextEditVersion(): number {
  return ++editVersion;
}

function send(): void {
  timer = 0;
  const state = get();
  const result = state.generation.result;
  if (!result?.exportable || !getEditData().editable) return;
  const version = nextEditVersion();
  latestSent = version;
  setPending(true);
  getEngine()
    .edit({ edits: structuredClone(state.edits), version, baseUrl: document.baseURI })
    .then((update) => {
      if (applyEditUpdate(update)) setNotes(update.notes);
      for (const warning of update.warnings) toast(warning, 'error');
    })
    .catch((error: unknown) => {
      if (error instanceof CancelledError) return;
      toast(error instanceof Error ? error.message : 'The edit could not be applied.', 'error');
    })
    .finally(() => {
      if (version === latestSent) setPending(false);
    });
}

/** Sends edits to the worker as they change, a frame at most apart. */
export function startEditSync(): void {
  if (started) return;
  started = true;
  useApp.subscribe((state, previous) => {
    if (state.edits === previous.edits) return;
    if (!timer) timer = window.setTimeout(send, 16);
  });
}

/** Sends a pending change now, before an export reads the edits. */
export function flushEdits(): void {
  if (!timer) return;
  clearTimeout(timer);
  send();
}
