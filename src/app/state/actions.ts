// Generate and export: the calls into the engine and what they do to the state.

import { CancelledError } from '../../core/engine/client';
import type { GenerateResult, ProgressEvent } from '../../core/engine/protocol';
import { cloneSettings } from '../../core/settings';
import { downloadBlob, NARROW_QUERY } from '../lib/browser';
import { formatBytes } from '../lib/format';
import { kindOf, objectOf } from '../../core/edit/keys';
import type { ModelEdits } from '../../core/edit/types';
import { fileBase, generationProblem } from './derived';
import { flushEdits, nextEditVersion, setNotes } from './editActions';
import { getEngine, onWorkerReplaced } from './engine';
import { setModelParts, type EditData } from './model';
import {
  patchExporting,
  patchGeneration,
  snapshotKey,
  toast,
  useApp,
} from './store';
import type { ResultMeta } from './store';

let run = 0;
let version = 0;

// Progress can arrive faster than it is worth drawing, so at most one update
// per frame goes into the store for each target.
type Target = 'generation' | 'exporting';
const pendingProgress: Record<Target, ProgressEvent | null> = { generation: null, exporting: null };
const progressFrame: Record<Target, number> = { generation: 0, exporting: 0 };

function queueProgress(event: ProgressEvent, target: Target) {
  pendingProgress[target] = event;
  if (progressFrame[target]) return;
  const flush = () => {
    progressFrame[target] = 0;
    const next = pendingProgress[target];
    pendingProgress[target] = null;
    if (!next || useApp.getState()[target].status !== 'running') return;
    if (target === 'generation') patchGeneration({ progress: next });
    else patchExporting({ progress: next });
  };
  progressFrame[target] = document.hidden ? window.setTimeout(flush, 100) : requestAnimationFrame(flush);
}

function describe(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Something went wrong. Try again.';
}

/** Whether a key names something in this model, or one of its added shapes. */
function selectable(key: string, data: EditData, edits: ModelEdits): boolean {
  const kind = kindOf(key);
  if (kind === 'shape') return edits.shapes.some((shape) => `s:${shape.id}` === key);
  if (kind === 'road') return data.roads?.keys.includes(key) ?? false;
  return objectOf(key) in data.objects || kind === 'tree';
}

function toMeta(result: GenerateResult, key: string): ResultMeta {
  let triangles = 0;
  const parts = result.parts.map((part) => {
    const count = Math.floor(part.indices.length / 3);
    triangles += count;
    return { id: part.id, name: part.name, role: part.role, triangles: count };
  });
  version += 1;
  return {
    version,
    key,
    bounds: result.bounds,
    mmPerMetre: result.mmPerMetre,
    release: result.release,
    stats: result.stats ?? {},
    warnings: result.warnings ?? [],
    timings: result.timings ?? {},
    lidar: result.lidar,
    surface: result.surface,
    parts,
    triangles,
    exportable: true,
  };
}

export async function generateModel(): Promise<void> {
  const state = useApp.getState();
  // The worker would do both at once, and a cancel could take the export down with it.
  if (state.generation.status === 'running' || state.exporting.status === 'running') return;
  const problem = generationProblem(state.area, state.settings);
  if (problem) {
    patchGeneration({ status: 'error', error: problem });
    return;
  }
  const id = ++run;
  const area = structuredClone(state.area);
  const settings = cloneSettings(state.settings);
  const key = snapshotKey(area, settings);
  patchGeneration({ status: 'running', progress: null, startedAt: Date.now(), error: null, cancelling: false });
  try {
    const request = { area, settings, edits: structuredClone(state.edits), editsVersion: nextEditVersion(), baseUrl: document.baseURI };
    const result = await getEngine().generate(request, (event) => {
      if (id === run) queueProgress(event, 'generation');
    });
    if (id !== run) return;
    const data: EditData = {
      editable: result.editable === true,
      roads: result.roads ?? null,
      objects: result.objects ?? {},
      ground: result.ground ?? null,
      frame: { center: area.center, rotationDeg: area.rotationDeg, mmPerMetre: result.mmPerMetre, buildingMmPerMetre: result.buildingMmPerMetre ?? result.mmPerMetre },
    };
    setModelParts(result.parts, data, result.edit, result.modelId);
    setNotes(result.edit?.notes ?? {});
    const meta = toMeta(result, key);
    const narrow = window.matchMedia(NARROW_QUERY).matches;
    useApp.setState((current) => ({
      generation: {
        ...current.generation,
        status: 'done',
        progress: null,
        cancelling: false,
        error: null,
        result: meta,
        stale: key !== snapshotKey(current.area, current.settings),
      },
      ui: {
        ...current.ui,
        // Unless the SVG map was picked while the model generated.
        view: current.output === 'model' ? 'result' : current.ui.view,
        drawerOpen: narrow && current.output === 'model' ? false : current.ui.drawerOpen,
        // Custom layers aren't parts of the generated model, but can be hidden too.
        hiddenParts: current.ui.hiddenParts.filter((part) => meta.parts.some((item) => item.id === part) || part.startsWith('layer:') || part === 'shapes'),
        // What was selected may not be in this model.
        selection: current.ui.selection.filter((key) => selectable(key, data, current.edits)),
        editMode: current.ui.editMode && data.editable,
        // The new model came with the edits applied.
        editsPending: false,
        activePoint: null,
      },
    }));
  } catch (error) {
    if (id !== run) return;
    const hasResult = useApp.getState().generation.result !== null;
    if (error instanceof CancelledError) {
      patchGeneration({ status: hasResult ? 'done' : 'idle', progress: null, cancelling: false });
      return;
    }
    patchGeneration({ status: 'error', error: describe(error), progress: null, cancelling: false });
  }
}

export function cancelGeneration(): void {
  const generation = useApp.getState().generation;
  if (generation.status !== 'running' || generation.cancelling) return;
  patchGeneration({ cancelling: true });
  getEngine().cancel();
}

/** Stops a download being made. The worker stops at its next checkpoint, or is replaced. */
export function cancelExport(): void {
  if (useApp.getState().exporting.status === 'running') getEngine().cancelExport();
}

export async function exportModel(): Promise<void> {
  const state = useApp.getState();
  const result = state.generation.result;
  if (!result || state.exporting.status === 'running' || state.generation.status === 'running') return;
  const { format, printer, multiPlate, sectionWidthMm, sectionHeightMm } = state.exportSettings;
  const exclude = state.ui.hiddenParts.filter((id) => result.parts.some((part) => part.id === id) || id.startsWith('layer:') || id === 'shapes');
  flushEdits();
  patchExporting({ status: 'running', progress: null, error: null });
  try {
    const out = await getEngine().export(
      {
        format,
        printer,
        palette: structuredClone(state.palette),
        multiPlate,
        sectionWidthMm,
        sectionHeightMm,
        fileBase: fileBase(state.placeName, state.fileName),
        excludeParts: exclude,
        edits: structuredClone(state.edits),
      },
      (event) => queueProgress(event, 'exporting'),
    );
    downloadBlob(out.data, out.fileName);
    patchExporting({
      status: 'idle',
      progress: null,
      last: { fileName: out.fileName, format, plates: out.plates, warnings: out.warnings ?? [], bytes: out.data.size },
    });
    if (out.missing) toast(`Downloaded ${out.fileName}, but part of the model is missing from it. See Export for details.`, 'error');
    else toast(`Downloaded ${out.fileName} (${formatBytes(out.data.size)})`, 'success');
  } catch (error) {
    patchExporting({ status: 'idle', progress: null, error: error instanceof CancelledError ? null : describe(error) });
  }
}

onWorkerReplaced(() => {
  const result = useApp.getState().generation.result;
  if (result?.exportable) {
    useApp.setState((state) => ({
      generation: state.generation.result
        ? { ...state.generation, result: { ...state.generation.result, exportable: false } }
        : state.generation,
    }));
  }
});
