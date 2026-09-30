// Editing the model: the edits, undo and redo, the selection and the tool,
// and keeping the worker's copy of the edits in step. Every change to the
// edits goes through commitEdits, so each one can be undone.

import { CancelledError } from '../../core/engine/client';
import { kindOf, objectOf, shapeKey, twinOf } from '../../core/edit/keys';
import { editCount, emptyEdits, hasEdits, MAX_LAYERS, MAX_SHAPES, MAX_TEXT_LENGTH, type AddedShape, type EditLayer, type ModelEdits, type ObjectEdit } from '../../core/edit/types';
import { FILAMENTS } from '../../core/settings';
import { getEngine } from './engine';
import { describeCounts } from '../viewer/edit/describe';
import { applyEditUpdate, getEditData } from './model';
import { hasPicks, writeBackup, type Backup } from './persist';
import { HISTORY_LIMIT, keepReplaced, patchSvg, toast, useApp, type Brought, type EditTool } from './store';

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

/** Every edit gone, for every area. A copy is kept aside in case that wasn't meant. */
export function clearEdits(): void {
  const edits = get().edits;
  if (!editCount(edits) && !edits.layers.length) return;
  const kept = keepBackup({ savedAt: Date.now(), reason: 'clear', edits });
  const cleared = emptyEdits();
  commitEdits(cleared);
  setSelection([]);
  toast('Every edit was undone.', 'info', {
    label: 'Undo',
    run: () => {
      if (get().edits !== cleared) return;
      undoEdit();
      if (kept && get().backup === kept) forgetBackup();
    },
  });
}

/**
 * Edits another tab saved, taken on here in place of this tab's. Its undo
 * steps were for the old ones, and undoing them would write the old ones
 * back over the other tab's, so they go.
 */
export function adoptEdits(edits: ModelEdits): void {
  set((state) => ({
    edits,
    editHistory: { past: [], future: [], coalesce: null },
    ui: { ...state.ui, selection: keep(state.ui.selection, edits), activePoint: null },
  }));
}

// ---------------------------------------------------------------- backup

/** Keeps a backup in place of the one before. Returns it, or null when the browser refused it. */
export function keepBackup(backup: Backup): Backup | null {
  if (!writeBackup(backup)) return null;
  set({ backup });
  return backup;
}

export function forgetBackup(): void {
  writeBackup(null);
  set({ backup: null });
}

/** Puts the backup back, and keeps what it replaces in its place, so doing it again swaps them back. */
export function restoreBackup(): void {
  const state = get();
  const backup = state.backup;
  if (!backup) return;
  const swapped: Backup = { savedAt: Date.now(), reason: 'restore' };
  if (backup.edits) {
    if (hasEdits(state.edits)) swapped.edits = state.edits;
    commitEdits(backup.edits);
    settleEdits();
    set((s) => ({ ui: { ...s.ui, selection: keep(s.ui.selection, backup.edits!), activePoint: null } }));
  }
  if (backup.picks) {
    const current = { routes: state.svg.routes, hiddenLines: state.svg.hiddenLines };
    if (hasPicks(current)) swapped.picks = current;
    patchSvg({ routes: backup.picks.routes, hiddenLines: backup.picks.hiddenLines });
  }
  const next = swapped.edits || swapped.picks ? swapped : null;
  writeBackup(next);
  set({ backup: next });
  const what = backup.edits && backup.picks ? 'edits and picked roads' : backup.edits ? 'edits' : 'picked roads';
  toast(`Put back your ${what}.`, 'info', next ? { label: 'Undo', run: restoreBackup } : undefined);
}

// ------------------------------------------------------------ links, files

/** What a link or file brought, as a sentence for a toast. */
export function broughtText(brought: Brought, from: string): string {
  const parts: string[] = [];
  if (brought.edits) parts.push(`${brought.edits} ${brought.edits === 1 ? 'edit' : 'edits'}`);
  if (brought.picks) parts.push(`${brought.picks} picked ${brought.picks === 1 ? 'road' : 'roads'}`);
  let text = parts.length ? `Added ${parts.join(' and ')} from ${from}.` : `Nothing new came from ${from}.`;
  if (brought.left) text += ` ${brought.left} didn't fit within the limits.`;
  if (brought.kept) {
    const where = [brought.kept.edits ? 'Edit the model' : '', brought.kept.picks ? 'Pick roads' : ''].filter(Boolean).join(' or ');
    text += ` Yours that it changed are kept aside, to put back from ${where}.`;
  }
  return text;
}

/** Takes what a link or file brought back out, if nothing changed since. */
export function undoBrought(brought: Brought): void {
  const state = get();
  if (brought.after.edits !== brought.before.edits && state.edits === brought.after.edits) undoEdit();
  const picks = brought.after.picks;
  if (picks !== brought.before.picks && state.svg.routes === picks.routes && state.svg.hiddenLines === picks.hiddenLines) {
    patchSvg({ routes: brought.before.picks.routes, hiddenLines: brought.before.picks.hiddenLines });
  }
  if (brought.kept && get().backup === brought.kept) forgetBackup();
}

/** Says what a link brought, with a way to take it back out. */
export function broughtToast(brought: Brought, from = 'the link'): void {
  toast(broughtText(brought, from), 'info', { label: 'Undo', run: () => undoBrought(brought) });
}

/** A link opened in a tab that's already running: its edits and picks go in with the others. */
export function takeInLink(brought: Brought): void {
  if (brought.after.edits !== get().edits) {
    commitEdits(brought.after.edits);
    settleEdits();
  }
  if (brought.after.picks !== brought.before.picks) patchSvg({ routes: brought.after.picks.routes, hiddenLines: brought.after.picks.hiddenLines });
  set({ backup: keepReplaced(brought, 'link', get().backup) });
  broughtToast(brought);
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
    // A bridge kept while its road is removed has to say so, or it goes with the road again.
    if (next.removed === false && !(key.startsWith('br:') && objects[twinOf(key)!]?.removed)) delete next.removed;
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
  // Water stays selected, for the choice of keeping its hollow.
  if (!others.length || others.some((key) => kindOf(key) !== 'water')) setSelection([]);
  if (keys.length) toast(`Removed ${describeCounts(keys)}`, 'info', { label: 'Undo', run: undoEdit });
}

export function restoreObjects(keys: string[]): void {
  const edits = get().edits;
  const objects = { ...edits.objects };
  const put = (key: string, edit: ObjectEdit) => {
    if (Object.keys(edit).length) objects[key] = edit;
    else delete objects[key];
  };
  for (const key of keys) {
    if (kindOf(key) === 'shape') continue;
    const { removed: _removed, hollow: _hollow, ...rest } = objects[key] ?? {};
    // A bridge goes with its road, so one put back on its own says so.
    const twin = twinOf(key);
    if (key.startsWith('br:') && twin && objects[twin]?.removed) put(key, { ...rest, removed: false });
    else put(key, rest);
    // A road put back takes its bridge back with it.
    if (key.startsWith('r:') && twin && objects[twin]?.removed === false) {
      const { removed: _kept, ...bridge } = objects[twin];
      put(twin, bridge);
    }
  }
  commitEdits({ ...edits, objects });
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

/** Whether `count` more shapes would go over the limit, which it says. */
function shapesFull(count: number): boolean {
  if (get().edits.shapes.length + count <= MAX_SHAPES) return false;
  toast(`A model can have at most ${MAX_SHAPES} added shapes.`, 'error');
  return true;
}

/** Adds a shape and selects it. Null at the limit, which saved edits and exports hold to. */
export function addShape(shape: Omit<AddedShape, 'id'>): string | null {
  if (shapesFull(1)) return null;
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
  if (!copies.length || shapesFull(copies.length)) return;
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
      return { ...common, sizeMm: 5, depthMm: 5, heightMm: 1.2, followGround: true, text: (get().placeName || 'Label').slice(0, MAX_TEXT_LENGTH) };
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
