// The generated mesh arrays live outside the store: they can be hundreds of
// megabytes and nothing should re-render because of them. The viewer reads
// them when the result version in the store changes. So does what the editor
// needs (road lines, object facts, the ground) and the geometry the worker
// sent for edits since, which the viewer picks up as it arrives.

import type { EditUpdate, GroundGrid, ObjectFacts, RoadLines } from '../../core/engine/protocol';
import type { LonLat, MeshPart } from '../../core/types';
import type { ObjectMesh } from '../../core/edit/session';
import type { AreaSpec } from '../../core/settings';

export interface EditData {
  editable: boolean;
  roads: RoadLines | null;
  objects: Record<string, ObjectFacts>;
  ground: GroundGrid | null;
  /** How the model was projected, to put shapes where a click lands, and the area it was made for. */
  frame: { center: LonLat; rotationDeg: number; mmPerMetre: number; buildingMmPerMetre: number; area: AreaSpec } | null;
}

const EMPTY: EditData = { editable: false, roads: null, objects: {}, ground: null, frame: null };

let parts: MeshPart[] = [];
let data: EditData = EMPTY;
/** By part and key: a bridge has its deck and its piers in two parts. */
const objectMeshes = new Map<string, ObjectMesh>();
const replacedParts = new Map<string, MeshPart | null>();
let hidden: string[] = [];
let notes: Record<string, string> = {};
let version = 0;
let model = -1;
const listeners = new Set<(update: EditUpdate) => void>();

export function setModelParts(next: MeshPart[], nextData: EditData = EMPTY, initial?: EditUpdate, modelId = -1): void {
  parts = next;
  data = nextData;
  objectMeshes.clear();
  replacedParts.clear();
  hidden = [];
  notes = {};
  version = 0;
  model = modelId;
  if (initial) record(initial);
}

export function getModelParts(): MeshPart[] {
  return parts;
}

export function getEditData(): EditData {
  return data;
}

/** The edits version the model shows. */
export function editVersion(): number {
  return version;
}

function record(update: EditUpdate) {
  if (update.reset) {
    objectMeshes.clear();
    replacedParts.clear();
  }
  for (const object of update.objects) {
    const id = `${object.part}|${object.key}`;
    if (object.mesh) objectMeshes.set(id, object);
    else objectMeshes.delete(id);
  }
  for (const { id, part } of update.parts) {
    if (part) replacedParts.set(id, part);
    else replacedParts.delete(id);
  }
  hidden = update.hidden;
  notes = update.notes;
  version = update.version;
}

/** Geometry for edits from the worker. Older versions, and other models' updates, are ignored. */
export function applyEditUpdate(update: EditUpdate): boolean {
  if (update.model !== model || update.version < version) return false;
  record(update);
  for (const listener of listeners) listener(update);
  return true;
}

/** Everything the worker sent since the model was generated, as one update in place of any before. */
export function currentEditState(): EditUpdate {
  return {
    model,
    version,
    reset: true,
    objects: [...objectMeshes.values()],
    parts: [...replacedParts].map(([id, part]) => ({ id, part })),
    hidden,
    notes,
    warnings: [],
  };
}

export function onEditUpdate(listener: (update: EditUpdate) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
