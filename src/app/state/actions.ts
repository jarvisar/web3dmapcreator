// Generate and export: the calls into the engine and what they do to the state.

import { CancelledError } from '../../core/engine/client';
import type { GenerateResult, ProgressEvent } from '../../core/engine/protocol';
import { validateArea } from '../../core/geo/area';
import { cloneSettings } from '../../core/settings';
import type { AreaSpec } from '../../core/settings';
import { cleanFileName, downloadBlob, NARROW_QUERY } from '../lib/browser';
import { formatBytes } from '../lib/format';
import { fileBase, settingsProblem } from './derived';
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

// Progress can arrive faster than it is worth drawing.
let pendingProgress: ProgressEvent | null = null;
let progressFrame = 0;

function queueProgress(event: ProgressEvent, target: 'generation' | 'exporting') {
  pendingProgress = event;
  if (progressFrame) return;
  const flush = () => {
    progressFrame = 0;
    const next = pendingProgress;
    pendingProgress = null;
    if (!next) return;
    if (target === 'generation' && useApp.getState().generation.status === 'running') patchGeneration({ progress: next });
    if (target === 'exporting' && useApp.getState().exporting.status === 'running') patchExporting({ progress: next });
  };
  progressFrame = document.hidden ? window.setTimeout(flush, 100) : requestAnimationFrame(flush);
}

function describe(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Something went wrong. Try again.';
}

function toMeta(result: GenerateResult, key: string, area: AreaSpec): ResultMeta {
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
    area,
    bounds: result.bounds,
    mmPerMetre: result.mmPerMetre,
    release: result.release,
    stats: result.stats ?? {},
    warnings: result.warnings ?? [],
    timings: result.timings ?? {},
    parts,
    triangles,
    exportable: true,
  };
}

export function generationProblem(): string | null {
  const { area, settings } = useApp.getState();
  return validateArea(area) ?? settingsProblem(settings);
}

export async function generateModel(): Promise<void> {
  const state = useApp.getState();
  if (state.generation.status === 'running') return;
  const problem = generationProblem();
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
    const meta = toMeta(result, key, area);
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
        fileBase: cleanFileName(fileBase(state.placeName, state.fileName)) || 'city-model',
        excludeParts: exclude,
      },
      (event) => queueProgress(event, 'exporting'),
    );
    downloadBlob(new Blob([out.data as BlobPart], { type: out.mime || 'application/octet-stream' }), out.fileName);
    patchExporting({
      status: 'idle',
      progress: null,
      last: { fileName: out.fileName, format, plates: out.plates, warnings: out.warnings ?? [], bytes: out.data.byteLength },
    });
    toast(`Downloaded ${out.fileName} (${formatBytes(out.data.byteLength)})`, 'success');
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
