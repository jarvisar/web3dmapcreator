// Editing the model: the edits, undo and redo, the selection and the tool,
// and keeping the worker's copy of the edits in step. Every change to the
// edits goes through commitEdits, so each one can be undone.

import { CancelledError } from '../../core/engine/client';
import { addSplit, parseRoadKey, removeSplit, segmentKeys, writeRoads } from '../../core/edit/blocks';
import { editOf, kindOf, objectOf, shapeKey, twinOf } from '../../core/edit/keys';
import {
  editCount,
  EDIT_LIMITS,
  emptyEdits,
  hasEdits,
  MAX_LAYERS,
  MAX_SHAPES,
  MAX_TEXT_LENGTH,
  mergeEdits,
  shapeGroup,
  shapeLayerIn,
  type AddedShape,
  type EditLayer,
  type ModelEdits,
  type ObjectEdit,
} from '../../core/edit/types';
import { Projection } from '../../core/geo/projection';
import { FILAMENTS } from '../../core/settings';
import { getEngine } from './engine';
import { describeCounts } from '../viewer/edit/describe';
import { applyStep, extendStep, stepBetween, type EditStep } from './history';
import { applyEditUpdate, getEditData } from './model';
import { hasPicks, writeBackup, type Backup } from './persist';
import { mergeTracks } from '../../core/tracks/track';
import { HISTORY_LIMIT, keepReplaced, patchSvg, setTracks, toast, useApp, type Brought, type EditTool, type Toast } from './store';

const set = useApp.setState;
const get = useApp.getState;

/**
 * The Undo on a toast, which takes back the change it's about and nothing
 * else: a plain undo while the edits are still as that change left them,
 * otherwise `inverse` applied to them as they are by then.
 */
function undoAction(after: ModelEdits, inverse: (edits: ModelEdits) => ModelEdits): NonNullable<Toast['action']> {
  return {
    label: 'Undo',
    run: () => {
      const edits = get().edits;
      if (edits === after) {
        undoEdit();
        return;
      }
      const next = inverse(edits);
      if (next === edits) return;
      commitEdits(next);
      settleEdits();
    },
  };
}

/** Edits with these objects' edits as `from` had them. The same edits when nothing changes. */
function putObjects(edits: ModelEdits, keys: string[], from: ModelEdits): ModelEdits {
  const objects = { ...edits.objects };
  let changed = false;
  for (const key of keys) {
    if (objects[key] === from.objects[key]) continue;
    changed = true;
    if (from.objects[key]) objects[key] = from.objects[key];
    else delete objects[key];
  }
  return changed ? { ...edits, objects } : edits;
}

/** Edits with these shapes added again where they're missing, as many as the limit allows. */
function putShapes(edits: ModelEdits, shapes: AddedShape[]): ModelEdits {
  const present = new Set(edits.shapes.map((s) => s.id));
  const back = shapes
    .filter((s) => !present.has(s.id))
    .slice(0, Math.max(0, MAX_SHAPES - edits.shapes.length))
    .map((s) => ({ ...s, layer: shapeLayerIn(s, edits.layers) }));
  return back.length ? { ...edits, shapes: [...edits.shapes, ...back] } : edits;
}

/**
 * Replace the edits. Changes tagged with the same `coalesce` in a row (the
 * steps of a drag, keystrokes in a field) undo as one.
 */
export function commitEdits(next: ModelEdits, coalesce?: string, touched?: Iterable<string>): void {
  set((state) => {
    if (next === state.edits) return {};
    const history = state.editHistory;
    const merge = coalesce !== undefined && coalesce === history.coalesce && history.past.length > 0;
    const past = merge
      ? [...history.past.slice(0, -1), extendStep(history.past[history.past.length - 1], state.edits, next, touched)]
      : [...history.past, stepBetween(state.edits, next, touched)].slice(-HISTORY_LIMIT);
    return { edits: next, editHistory: { past, future: [], coalesce: coalesce ?? null } };
  });
}

/** Ends a coalescing run, so the next change undoes on its own. */
export function settleEdits(): void {
  set((state) => (state.editHistory.coalesce ? { editHistory: { ...state.editHistory, coalesce: null } } : {}));
}

/** Where the edits and their history stand, for revertEdits. */
export interface EditMark {
  edits: ModelEdits;
  top: EditStep | null;
}

export function editMark(): EditMark {
  const { edits, editHistory } = get();
  return { edits, top: editHistory.past[editHistory.past.length - 1] ?? null };
}

/**
 * Puts the edits back to where they were at `mark` when everything since is
 * one undo step, as a drag's changes are, and leaves nothing to redo: a drag
 * called off never happened. Anything else in between and it does nothing.
 */
export function revertEdits(mark: EditMark): void {
  set((state) => {
    const past = state.editHistory.past;
    if (state.edits === mark.edits || !past.length || (past[past.length - 2] ?? null) !== mark.top) return {};
    const { edits } = applyStep(state.edits, past[past.length - 1]);
    return { edits, editHistory: { past: past.slice(0, -1), future: [], coalesce: null } };
  });
}

export function undoEdit(): void {
  set((state) => {
    const { past, future } = state.editHistory;
    if (!past.length) return {};
    const { edits, back } = applyStep(state.edits, past[past.length - 1]);
    return {
      edits,
      editHistory: { past: past.slice(0, -1), future: [back, ...future], coalesce: null },
      ui: { ...state.ui, selection: keep(state.ui.selection, edits), activePoint: keepPoint(state.ui.activePoint, edits) },
    };
  });
}

export function redoEdit(): void {
  set((state) => {
    const { past, future } = state.editHistory;
    if (!future.length) return {};
    const { edits, back } = applyStep(state.edits, future[0]);
    return {
      edits,
      editHistory: { past: [...past, back], future: future.slice(1), coalesce: null },
      ui: { ...state.ui, selection: keep(state.ui.selection, edits), activePoint: keepPoint(state.ui.activePoint, edits) },
    };
  });
}

/** A selection without shapes the edits no longer have. */
function keep(selection: string[], edits: ModelEdits): string[] {
  const shapes = new Set(edits.shapes.map((s) => shapeKey(s.id)));
  return selection.filter((key) => kindOf(key) !== 'shape' || shapes.has(key));
}

/** The picked point, unless undo took away its shape or the point itself. */
function keepPoint(point: { shape: string; index: number } | null, edits: ModelEdits): { shape: string; index: number } | null {
  if (!point) return null;
  const shape = edits.shapes.find((s) => s.id === point.shape);
  return shape && point.index < shape.points.length ? point : null;
}

/** Every edit gone, for every area. A copy is kept aside in case that wasn't meant. */
export function clearEdits(): void {
  const edits = get().edits;
  if (!editCount(edits) && !edits.layers.length) return;
  const kept = keepBackup({ savedAt: Date.now(), reason: 'clear', edits });
  const cleared = emptyEdits();
  commitEdits(cleared);
  setSelection([]);
  // Edits made since stay, and win where they changed the same thing.
  const undo = undoAction(cleared, (now) => mergeEdits(edits, now).edits);
  toast('Every edit was undone.', 'info', {
    ...undo,
    run: () => {
      undo.run();
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

/** What a backup holds, as words: "edits and picked roads". */
export function backupText(backup: Backup): string {
  const parts = [backup.edits ? 'edits' : '', backup.picks ? 'picked roads' : '', backup.tracks ? 'routes' : ''].filter(Boolean);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '');
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
  // Routes are only ever added to, never swapped out.
  if (backup.tracks) setTracks(mergeTracks(get().tracks, backup.tracks).tracks);
  const next = swapped.edits || swapped.picks ? swapped : null;
  writeBackup(next);
  set({ backup: next });
  const what = backupText(backup);
  toast(`Put back your ${what}.`, 'info', next ? { label: 'Undo', run: restoreBackup } : undefined);
}

// ------------------------------------------------------------ links, files

/** What a link or file brought, as a sentence for a toast. */
export function broughtText(brought: Brought, from: string): string {
  const parts: string[] = [];
  if (brought.edits) parts.push(`${brought.edits} ${brought.edits === 1 ? 'edit' : 'edits'}`);
  if (brought.picks) parts.push(`${brought.picks} picked ${brought.picks === 1 ? 'road' : 'roads'}`);
  if (brought.tracks) parts.push(`${brought.tracks} ${brought.tracks === 1 ? 'route' : 'routes'}`);
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
  if (brought.after.tracks !== brought.before.tracks && state.tracks === brought.after.tracks) setTracks(brought.before.tracks);
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
  if (brought.after.tracks !== brought.before.tracks) setTracks(brought.after.tracks);
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
  if (!found || index < 0 || index >= found.points.length) return;
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
  commitEdits({ ...edits, objects, shapes }, undefined, keys);
  const cleared = edits.shapes.filter((shape) => gone.has(shapeKey(shape.id)));
  toast(
    `Cleared ${keys.length} ${keys.length === 1 ? 'change' : 'changes'}.`,
    'info',
    undoAction(get().edits, (now) => putShapes(putObjects(now, keys, edits), cleared)),
  );
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
  set((state) => ({
    ui: { ...state.ui, editMode, tool: editMode ? state.ui.tool : 'select', selection: editMode ? state.ui.selection : [], activePoint: editMode ? state.ui.activePoint : null },
  }));
  settleEdits();
}

export function setTool(tool: EditTool): void {
  set((state) => ({ ui: { ...state.ui, tool, editMode: true, activePoint: null } }));
}

// --------------------------------------------------------------- objects

/**
 * Whether the road a bridge is on is removed where the bridge is, whatever
 * the bridge's own edit says. A copy, since `objects` is being written and
 * edits are indexed per object.
 */
function roadGoneAt(objects: ModelEdits['objects'], bridge: string): boolean {
  const own = { ...objects };
  delete own[bridge];
  return Boolean(editOf({ ...emptyEdits(), objects: own }, bridge, getEditData().objects[bridge]?.at)?.removed);
}

/**
 * Keys the same edit applies to: a part's edit or its whole object's, as
 * selected. Roads are written by range (blocks.ts): a block of a street
 * changes on its own, and the whole street over its blocks.
 */
function patchedObjects(edits: ModelEdits, keys: string[], patch: Partial<ObjectEdit>) {
  const roads = new Set(keys.filter((key) => parseRoadKey(key)));
  const written = writeRoads(edits.objects, [...roads], patch);
  const objects = written.objects;
  for (const key of keys) {
    if (kindOf(key) === 'shape' || roads.has(key)) continue;
    const next: ObjectEdit = { ...objects[key], ...patch };
    for (const field of Object.keys(next) as (keyof ObjectEdit)[]) if (next[field] === undefined) delete next[field];
    // A bridge kept while its road is removed has to say so, or it goes with the road again.
    if (next.removed === false && !(key.startsWith('br:') && roadGoneAt(objects, key))) delete next.removed;
    if (Object.keys(next).length) objects[key] = next;
    else delete objects[key];
  }
  return { objects, touched: [...keys, ...written.touched] };
}

export function patchObjects(keys: string[], patch: Partial<ObjectEdit>, coalesce?: string): void {
  const edits = get().edits;
  const { objects, touched } = patchedObjects(edits, keys, patch);
  commitEdits({ ...edits, objects }, coalesce, touched);
}

/** Generated objects and added shapes in one layer, as one undo step. Undefined gives each its own colour. */
export function assignLayer(keys: string[], layer: string | undefined): void {
  const edits = get().edits;
  const { objects, touched } = patchedObjects(edits, keys, { layer });
  const selected = new Set(keys);
  const shapes = edits.shapes.map((shape) => selected.has(shapeKey(shape.id)) ? { ...shape, layer: layer ?? shapeGroup(shape.kind) } : shape);
  commitEdits({ ...edits, objects, shapes }, undefined, touched);
}

/**
 * Back as generated: every edit of these objects, and of their parts,
 * dropped. A whole road goes back with every block and split of it. A block
 * goes back on its own, carved out of any edit of the road around it.
 */
export function resetObjects(keys: string[]): void {
  const edits = get().edits;
  const blocks = keys.filter((key) => key.startsWith('r:') && key.includes('@'));
  const written = writeRoads(edits.objects, blocks, { removed: undefined, layer: undefined, heightMm: undefined, widthMm: undefined });
  const targets = new Set(keys.filter((key) => !blocks.includes(key)));
  for (const key of keys) if (key.startsWith('r:') && !key.includes('@')) for (const range of segmentKeys(written.objects, key)) targets.add(range);
  // A copy to delete from: segmentKeys indexed the written object, and the index is kept by identity.
  const objects = { ...written.objects };
  const dropped: string[] = [...written.touched];
  for (const key of Object.keys(objects)) {
    if (!targets.has(key) && !targets.has(objectOf(key))) continue;
    delete objects[key];
    dropped.push(key);
  }
  const shapes = edits.shapes.filter((s) => !targets.has(shapeKey(s.id)));
  commitEdits({ ...edits, objects, shapes }, undefined, dropped);
}

/** Removes objects, and deletes added shapes, among the keys. */
export function removeObjects(keys: string[]): void {
  const shapes = new Set(keys.filter((key) => kindOf(key) === 'shape'));
  const others = keys.filter((key) => !shapes.has(key));
  const edits = get().edits;
  const roads = others.filter((key) => parseRoadKey(key));
  const written = writeRoads(edits.objects, roads, { removed: true });
  const objects = written.objects;
  for (const key of others) if (!roads.includes(key)) objects[key] = { ...objects[key], removed: true };
  const touched = [...others, ...written.touched];
  commitEdits({ ...edits, objects, shapes: edits.shapes.filter((s) => !shapes.has(shapeKey(s.id))) }, undefined, touched);
  // Water stays selected, for the choice of keeping its hollow.
  if (!others.length || others.some((key) => kindOf(key) !== 'water')) setSelection([]);
  const deleted = edits.shapes.filter((s) => shapes.has(shapeKey(s.id)));
  if (keys.length) {
    toast(`Removed ${describeCounts(keys)}`, 'info', undoAction(get().edits, (now) => putShapes(putObjects(now, touched, edits), deleted)));
  }
}

export function restoreObjects(keys: string[]): void {
  const edits = get().edits;
  const roads = keys.filter((key) => parseRoadKey(key));
  const written = writeRoads(edits.objects, roads, { removed: undefined });
  const objects = written.objects;
  const touched: string[] = [...written.touched];
  const put = (key: string, edit: ObjectEdit) => {
    touched.push(key);
    if (Object.keys(edit).length) objects[key] = edit;
    else delete objects[key];
  };
  for (const key of keys) {
    if (kindOf(key) === 'shape') continue;
    const twin = twinOf(key);
    if (roads.includes(key)) {
      // A road put back takes its bridge back with it, once nothing of the road there is removed.
      if (twin && objects[twin]?.removed === false && !roadGoneAt(objects, twin)) {
        const { removed: _kept, ...bridge } = objects[twin];
        put(twin, bridge);
      }
      continue;
    }
    const { removed: _removed, hollow: _hollow, ...rest } = objects[key] ?? {};
    // A bridge goes with its road, so one put back on its own says so.
    if (key.startsWith('br:') && roadGoneAt({ ...objects, [key]: rest }, key)) put(key, { ...rest, removed: false });
    else put(key, rest);
  }
  commitEdits({ ...edits, objects }, undefined, touched);
}

// ----------------------------------------------------------------- roads

/**
 * Splits a road where it was clicked, so a block of it can be edited apart
 * from the rest. A selected block that was split stays selected as its two
 * halves.
 */
export function splitRoad(segment: string, at: number, halves: (objects: ModelEdits['objects']) => string[] | null): boolean {
  const edits = get().edits;
  const objects = addSplit(edits.objects, segment, at);
  if (!objects) return false;
  commitEdits({ ...edits, objects }, undefined, [segment]);
  const replaced = halves(objects);
  if (replaced) setSelection(replaced);
  return true;
}

/**
 * Takes a split back out. The blocks either side become one, with the
 * longer one's edits where they differed, which a toast says.
 */
export function joinRoad(segment: string, at: number, bounds: readonly number[]): boolean {
  const edits = get().edits;
  const joined = removeSplit(edits.objects, segment, at, bounds);
  if (!joined) return false;
  commitEdits({ ...edits, objects: joined.objects }, undefined, joined.touched);
  const selection = get().ui.selection.filter((key) => !(key.startsWith(`${segment}@`) && key !== segment));
  if (selection.length !== get().ui.selection.length) setSelection(selection);
  if (joined.differed) toast('Joined. The two blocks were edited differently, so it now has the longer one\'s edits.', 'info', undoAction(get().edits, (now) => putObjects(now, joined.touched, edits)));
  return true;
}

/**
 * Generated roads put in place of drawn ones that follow the same lines:
 * the blocks are removed, a bridge on them stays, and the drawn roads are
 * added and selected, as one step.
 */
export function replaceWithDrawnRoads(keys: string[], shapes: Omit<AddedShape, 'id'>[], bridges: string[]): void {
  if (!shapes.length || shapesFull(shapes.length)) return;
  const edits = get().edits;
  const written = writeRoads(edits.objects, keys, { removed: true });
  const objects = written.objects;
  const touched = [...written.touched];
  // The deck stays a bridge: the drawn road runs up to it.
  for (const bridge of bridges) {
    if (!roadGoneAt(objects, bridge)) continue;
    objects[bridge] = { ...objects[bridge], removed: false };
    touched.push(bridge);
  }
  const added = shapes.map((shape) => ({ ...shape, id: newId() }));
  commitEdits({ ...edits, objects, shapes: [...edits.shapes, ...added] }, undefined, touched);
  setSelection(added.map((shape) => shapeKey(shape.id)));
  const what = added.length === 1 ? 'a drawn road' : `${added.length} drawn roads`;
  toast(`Made it ${what}. Drag its points to reshape it.`, 'info', undoAction(get().edits, (now) => {
    const back = putObjects(now, touched, edits);
    const ids = new Set(added.map((shape) => shape.id));
    return { ...back, shapes: back.shapes.filter((shape) => !ids.has(shape.id)) };
  }));
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

/** Deletes a layer. What was in it goes back to its own colour, and its shapes to their kind's (shapeGroup). */
export function deleteLayer(id: string): void {
  const edits = get().edits;
  const layer = edits.layers.find((l) => l.id === id);
  if (!layer) return;
  const objects: Record<string, ObjectEdit> = {};
  const members: string[] = [];
  for (const [key, edit] of Object.entries(edits.objects)) {
    if (edit.layer !== id) {
      objects[key] = edit;
      continue;
    }
    members.push(key);
    const rest = { ...edit };
    delete rest.layer;
    if (Object.keys(rest).length) objects[key] = rest;
  }
  const moved = new Set(edits.shapes.filter((shape) => shape.layer === id).map((shape) => shape.id));
  const shapes = edits.shapes.map((shape) => (moved.has(shape.id) ? { ...shape, layer: shapeGroup(shape.kind) } : shape));
  commitEdits({ ...edits, layers: edits.layers.filter((l) => l.id !== id), objects, shapes }, undefined, members);
  toast(
    `Deleted ${layer.name}.`,
    'info',
    undoAction(get().edits, (now) => {
      if (now.layers.some((l) => l.id === id) || now.layers.length >= MAX_LAYERS) return now;
      const layers = [...now.layers];
      layers.splice(Math.min(edits.layers.indexOf(layer), layers.length), 0, layer);
      const back = { ...now.objects };
      // Unless they were put in another layer since.
      for (const key of members) if (!back[key]?.layer) back[key] = { ...back[key], layer: id };
      const restored = now.shapes.map((shape) => (moved.has(shape.id) && shape.layer === shapeGroup(shape.kind) ? { ...shape, layer: id } : shape));
      return { ...now, layers, objects: back, shapes: restored };
    }),
  );
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

/** A shape moved by model mm, every point of a path or area with it. */
export function shiftShape(shape: AddedShape, dx: number, dy: number, projection: Projection): Pick<AddedShape, 'at' | 'points'> {
  const move = ([lon, lat]: [number, number]): [number, number] => {
    const [x, y] = projection.toModel(lon, lat);
    return projection.modelToGeo(x + dx, y + dy);
  };
  return { at: move(shape.at), points: shape.points.map(move) };
}

/** How far a copy lands from its original, so it's seen to be there. */
const DUPLICATE_OFFSET_MM = 5;

/** Copies of shapes, a little down and to the right of them, or up and left near the model's edge. */
export function duplicateShapes(ids: string[]): void {
  const edits = get().edits;
  const originals = edits.shapes.filter((shape) => ids.includes(shape.id));
  if (!originals.length || shapesFull(originals.length)) return;
  const frame = getEditData().frame;
  const projection = frame ? new Projection(frame.center, frame.rotationDeg, frame.mmPerMetre) : null;
  let dx = DUPLICATE_OFFSET_MM;
  let dy = -DUPLICATE_OFFSET_MM;
  const bounds = get().generation.result?.bounds;
  if (projection && bounds) {
    const anchors = originals.map((shape) => projection.toModel(...shape.at));
    if (anchors.some(([x]) => x + dx > bounds[3])) dx = -dx;
    if (anchors.some(([, y]) => y + dy < bounds[1])) dy = -dy;
  }
  const copies = originals.map((shape) => ({ ...structuredClone(shape), id: newId(), ...(projection ? shiftShape(shape, dx, dy, projection) : {}) }));
  commitEdits({ ...edits, shapes: [...edits.shapes, ...copies] });
  setSelection(copies.map((shape) => shapeKey(shape.id)));
}

/**
 * Shape defaults. A drawn line starts out as a road, in the roads' colour and
 * at their height, and a drawn outline as a building with a flat roof. None
 * start in a custom layer: that's picked for each one.
 */
export function shapeDefaults(kind: AddedShape['kind']): Omit<AddedShape, 'id' | 'at' | 'points'> {
  const common = { kind, layer: shapeGroup(kind), rotationDeg: 0, liftMm: 0, text: '', font: 'montserrat' };
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
      const heightMm = Math.min(EDIT_LIMITS.shapeHeightMm[1], Math.max(EDIT_LIMITS.shapeHeightMm[0], roads.thicknessMm));
      return { ...common, sizeMm: 0.7, depthMm: 0.7, heightMm, followGround: true };
    }
    case 'area':
      return { ...common, sizeMm: 10, depthMm: 10, heightMm: 4, followGround: false };
  }
}

// ------------------------------------------------------------------ sync

let editVersion = 0;
let timer = 0;
let started = false;
let latestSent = 0;

function setPending(editsPending: boolean): void {
  set((state) => (state.ui.editsPending === editsPending ? {} : { ui: { ...state.ui, editsPending, editsSince: Date.now() } }));
}

/** The worker answered, so a wait that goes on counts from now. */
function heard(): void {
  set((state) => (state.ui.editsPending ? { ui: { ...state.ui, editsSince: Date.now() } } : {}));
}

/**
 * Stops an edit update taking far too long, stuck in a loop, say. It can't
 * stop part way, so the worker goes, and the model has to be generated again.
 */
export function stopEditUpdates(): void {
  getEngine().stopEdits();
  toast('Stopped updating the model. Generate it again to see your latest edits.', 'info');
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
      heard();
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
