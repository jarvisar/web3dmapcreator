// The SVG render worker and what it last made. Kept apart from the app store:
// a result holds every path of the map as text.
import { create } from 'zustand';
import type { RenderResult } from '../../core/svgmap/result';
import type { RenderSettings } from '../../core/svgmap/settings';
import { fontFingerprint } from '../../core/svgmap/text/fonts';
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
let latestRequest: SvgWorkerRequest | null = null;

// The worker answers a cancel or a newer render between the steps of the one
// it's on. One that doesn't within this long is stuck in a loop and can't be
// stopped any other way, so it's replaced, losing its downloaded tiles.
const STUCK_MS = 8000;
// A render may be running in the worker, so a message now may wait on it.
let busy = false;
let watchdog: ReturnType<typeof setTimeout> | undefined;
let seq = 0;
// The message the watchdog waits to hear back about. An ack for an earlier
// one, still on its way, says nothing about it.
let awaited = 0;

type Unsent<M = SvgWorkerRequest> = M extends unknown ? Omit<M, 'seq'> : never;

function send(message: Unsent) {
  const target = getWorker();
  const sent = { ...message, seq: ++seq } as SvgWorkerRequest;
  if (busy) {
    awaited = sent.seq;
    clearTimeout(watchdog);
    watchdog = setTimeout(replaceStuckWorker, STUCK_MS);
  }
  target.postMessage(sent);
  if (sent.type === 'render') {
    busy = true;
    latestRequest = sent;
  }
}

function replaceStuckWorker() {
  worker?.terminate();
  worker = null;
  busy = false;
  // The render still wanted starts over in a new worker.
  if (useSvgRender.getState().status === 'working' && latestRequest?.id === latestId) {
    getWorker().postMessage(latestRequest);
    busy = true;
  }
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../../worker/svg.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<SvgWorkerResponse>) => {
    const message = event.data;
    // Messages are read in order, so this one or a later one means it got it.
    if (message.type === 'ack') {
      if (message.seq >= awaited) clearTimeout(watchdog);
      return;
    }
    if (message.id !== latestId) return;
    if (message.type !== 'progress') busy = false;
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
    clearTimeout(watchdog);
    busy = false;
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export function settingsKey(settings: RenderSettings, customFont: CustomFont | null): string {
  return JSON.stringify([settings, customFont ? fontFingerprint(customFont.data) : null]);
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
  send({
    type: 'render',
    id,
    baseUrl: new URL(import.meta.env.BASE_URL, document.baseURI).href,
    request: { settings, customFont },
  });
}

export function cancelRender(): void {
  const state = useSvgRender.getState();
  if (state.status !== 'working') return;
  if (worker) send({ type: 'cancel', id: latestId });
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
