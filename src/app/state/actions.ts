// Generate and export: the calls into the engine and what they do to the state.

import { CancelledError, offeredTiles } from '../../core/engine/client';
import type { GenerateResult, LidarOffer, ProgressEvent } from '../../core/engine/protocol';
import { surveyQuery } from '../../core/lidar/query';
import { cloneSettings } from '../../core/settings';
import { downloadBlob, NARROW_QUERY } from '../lib/browser';
import { formatBytes } from '../lib/format';
import { kindOf, objectOf } from '../../core/edit/keys';
import type { ModelEdits } from '../../core/edit/types';
import { fileBase, generationProblem, lidarCellLimit } from './derived';
import { flushEdits, nextEditVersion, setNotes } from './editActions';
import { getEngine, onWorkerReplaced } from './engine';
import { setModelParts, type EditData } from './model';
import {
  patchExporting,
  patchGeneration,
  snapshotKey,
  surveySearchKey,
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

/** With `approveTiles`, offered LiDAR tiles the user agreed to download (LidarOffer.tiles). */
export async function generateModel(options: { approveTiles?: string[] } = {}): Promise<void> {
  const state = useApp.getState();
  // The worker would do both at once, and a cancel could take the export down with it.
  if (state.generation.status === 'running' || state.exporting.status === 'running') return;
  const problem = generationProblem(state.area, state.settings, state.ui.largeGrids);
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
    const request = { area, settings, edits: structuredClone(state.edits), editsVersion: nextEditVersion(), baseUrl: document.baseURI, maxCells: lidarCellLimit(state.ui.largeGrids), approveTiles: options.approveTiles };
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
    // What generating found is as good as a search, for picking a survey.
    const found = result.lidar?.found ?? result.surface?.found ?? [];
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
        offers: offersFor(key, result.lidar?.offers ?? result.surface?.offers),
        surveys: found.length ? { key: surveySearchKey(area, settings), status: 'done', list: found, failures: [] } : current.generation.surveys,
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
    patchGeneration({ status: 'error', error: describe(error), progress: null, cancelling: false, offers: offersFor(key, offeredTiles(error)) });
  }
}

function offersFor(key: string, list: LidarOffer[] | undefined) {
  return list?.length ? { key, list } : null;
}

/** Lists the LiDAR surveys under the area in the order they'd be read, for picking one by hand. Nothing is downloaded but catalogs and indexes. */
export async function findLidarSurveys(): Promise<void> {
  const state = useApp.getState();
  const area = structuredClone(state.area);
  const settings = cloneSettings(state.settings);
  const key = surveySearchKey(area, settings);
  patchGeneration({ surveys: { key, status: 'searching', list: [], failures: [] } });
  // Another search or a generate may have taken over, or the area moved on.
  const current = () => useApp.getState().generation.surveys?.key === key;
  try {
    const result = await getEngine().surveys(surveyQuery(area, settings));
    if (current()) patchGeneration({ surveys: { key, status: 'done', list: result.surveys, failures: result.failures } });
  } catch (error) {
    if (current() && !(error instanceof CancelledError)) patchGeneration({ surveys: { key, status: 'error', list: [], failures: [], error: describe(error) } });
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
