// Renders SVG maps. Separate from the 3D engine's worker so a preview can
// update while a model generates.
import { CancelledError, RenderService, type RenderProgress, type RenderRequest } from '../core/svgmap/service';
import type { RenderResult } from '../core/svgmap/result';

export type SvgWorkerRequest = { type: 'render'; id: number; baseUrl: string; request: RenderRequest } | { type: 'cancel'; id: number };

export type SvgWorkerResponse =
  | { type: 'progress'; id: number; progress: RenderProgress }
  | { type: 'result'; id: number; result: RenderResult }
  | { type: 'error'; id: number; message: string };

const scope = self as unknown as {
  postMessage(message: SvgWorkerResponse): void;
  onmessage: ((event: MessageEvent<SvgWorkerRequest>) => void) | null;
};
let baseUrl = '';
let latest = 0;

const service = new RenderService(async (path) => {
  const response = await fetch(new URL(path, baseUrl));
  if (!response.ok) throw new Error(`Could not load ${path} (${response.status}).`);
  return response.arrayBuffer();
});

const post = (message: SvgWorkerResponse) => scope.postMessage(message);

scope.onmessage = async (event: MessageEvent<SvgWorkerRequest>) => {
  const message = event.data;
  if (message.type === 'cancel') {
    if (message.id === latest) latest = 0;
    return;
  }
  const { id } = message;
  latest = id;
  baseUrl = message.baseUrl;
  // A newer request replaces this one, and the page only listens for the newest.
  const current = () => id === latest;
  try {
    const result = await service.render(
      message.request,
      (progress) => {
        if (current()) post({ type: 'progress', id, progress });
      },
      () => !current(),
    );
    if (current()) post({ type: 'result', id, result });
  } catch (error) {
    if (error instanceof CancelledError || !current()) return;
    post({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });
  }
};
