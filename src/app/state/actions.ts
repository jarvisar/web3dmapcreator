// Generate and export: the calls into the engine and what they do to the state.

import { CancelledError } from '../../core/engine/client';
import type { GenerateResult, ProgressEvent } from '../../core/engine/protocol';
import { cloneSettings } from '../../core/settings';
import { downloadBlob, NARROW_QUERY } from '../lib/browser';
import { formatBytes } from '../lib/format';
import { fileBase, generationProblem } from './derived';
import { getEngine, onWorkerReplaced } from './engine';
import { setModelParts } from './model';
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
    const result = await getEngine().generate({ area, settings }, (event) => {
      if (id === run) queueProgress(event, 'generation');
    });
    if (id !== run) return;
    setModelParts(result.parts);
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
        view: 'model',
        drawerOpen: narrow ? false : current.ui.drawerOpen,
        hiddenParts: current.ui.hiddenParts.filter((part) => meta.parts.some((item) => item.id === part)),
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

export async function exportModel(): Promise<void> {
  const state = useApp.getState();
  const result = state.generation.result;
  if (!result || state.exporting.status === 'running' || state.generation.status === 'running') return;
  const { format, printer, multiPlate, sectionWidthMm, sectionHeightMm } = state.exportSettings;
  const exclude = state.ui.hiddenParts.filter((id) => result.parts.some((part) => part.id === id));
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
      },
      (event) => queueProgress(event, 'exporting'),
    );
    downloadBlob(out.data, out.fileName);
    patchExporting({
      status: 'idle',
      progress: null,
      last: { fileName: out.fileName, format, plates: out.plates, warnings: out.warnings ?? [], bytes: out.data.size },
    });
    toast(`Downloaded ${out.fileName} (${formatBytes(out.data.size)})`, 'success');
  } catch (error) {
    patchExporting({ status: 'idle', progress: null, error: describe(error) });
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
