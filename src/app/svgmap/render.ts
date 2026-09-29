// The SVG render worker and what it last made. Kept apart from the app store:
// a result holds every path of the map as text.
import { create } from 'zustand';
import type { RenderResult } from '../../core/svgmap/result';
import type { RenderSettings } from '../../core/svgmap/settings';
import type { CustomFont, RenderProgress } from '../../core/svgmap/service';
import type { SvgWorkerRequest, SvgWorkerResponse } from '../../worker/svg.worker';

export interface SvgRenderState {
  status: 'idle' | 'working' | 'done' | 'error';
  progress: RenderProgress | null;
  startedAt: number;
  result: RenderResult | null;
  error: string | null;
  // Settings as a string to compare: the ones the result came from, and the
  // last ones tried. A failed or cancelled render isn't retried on its own.
  resultKey: string | null;
  triedKey: string | null;
}

export const useSvgRender = create<SvgRenderState>(() => ({
  status: 'idle',
  progress: null,
  startedAt: 0,
  result: null,
  error: null,
  resultKey: null,
  triedKey: null,
}));

let worker: Worker | null = null;
// Only the newest request matters. The worker drops older ones and anything
// they still send is ignored here.
let latestId = 0;
let latestKey: string | null = null;

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../../worker/svg.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<SvgWorkerResponse>) => {
    const message = event.data;
    if (message.id !== latestId) return;
    if (message.type === 'progress') {
      useSvgRender.setState({ progress: message.progress });
    } else if (message.type === 'result') {
      useSvgRender.setState({ status: 'done', result: message.result, error: null, progress: null, resultKey: latestKey, triedKey: latestKey });
    } else {
      useSvgRender.setState({ status: 'error', error: message.message, progress: null, triedKey: latestKey });
    }
  };
  worker.onerror = (event) => {
    useSvgRender.setState({
      status: 'error',
      error: event.message || 'The SVG renderer stopped unexpectedly.',
      progress: null,
      triedKey: latestKey,
    });
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export function settingsKey(settings: RenderSettings, customFont: CustomFont | null): string {
  return JSON.stringify([settings, customFont?.name ?? null, customFont?.data.byteLength ?? 0]);
}

export function requestRender(settings: RenderSettings, customFont: CustomFont | null): void {
  const key = settingsKey(settings, customFont);
  const state = useSvgRender.getState();
  if (key === latestKey && state.status === 'working') return;
  latestKey = key;
  const id = ++latestId;
  useSvgRender.setState({
    status: 'working',
    error: null,
    progress: { stage: 'tiles', message: 'Starting' },
    startedAt: state.status === 'working' ? state.startedAt : Date.now(),
  });
  const message: SvgWorkerRequest = {
    type: 'render',
    id,
    baseUrl: new URL(import.meta.env.BASE_URL, document.baseURI).href,
    request: { settings, customFont },
  };
  getWorker().postMessage(message);
}

export function cancelRender(): void {
  const state = useSvgRender.getState();
  if (state.status !== 'working') return;
  worker?.postMessage({ type: 'cancel', id: latestId } satisfies SvgWorkerRequest);
  latestId++;
  useSvgRender.setState({ status: state.result ? 'done' : 'idle', progress: null, triedKey: latestKey });
  latestKey = null;
}

// How far along a render is, 0 to 1.
export function renderFraction(progress: RenderProgress | null): number {
  if (!progress) return 0;
  if (progress.stage === 'tiles') return 0.1 + 0.55 * ((progress.done ?? 0) / Math.max(progress.total ?? 1, 1));
  return progress.stage === 'geometry' ? 0.75 : 0.9;
}
