// Renders SVG maps. Separate from the 3D engine's worker so a preview can
// update while a model generates.
import { CancelledError, RenderService, type RenderProgress, type RenderRequest } from '../core/svgmap/service';
import { download } from '../core/svgmap/download';
import type { RenderResult } from '../core/svgmap/result';

// seq counts every message sent, which ids don't: a cancel has its render's id.
export type SvgWorkerRequest =
  | { type: 'render'; id: number; seq: number; baseUrl: string; request: RenderRequest }
  | { type: 'cancel'; id: number; seq: number };

export type SvgWorkerResponse =
  // Sent as soon as a message arrives, so the page can tell a worker stuck in a long loop.
  | { type: 'ack'; seq: number }
  | { type: 'progress'; id: number; progress: RenderProgress }
  | { type: 'result'; id: number; result: RenderResult }
  | { type: 'error'; id: number; message: string };

const scope = self as unknown as {
  postMessage(message: SvgWorkerResponse): void;
  onmessage: ((event: MessageEvent<SvgWorkerRequest>) => void) | null;
};
let baseUrl = '';
let latest = 0;

// Fonts, cached by the service worker, so normally instant.
const ASSET_IDLE_MS = 30_000;

const service = new RenderService(async (path) => {
  const { status, bytes } = await download(new URL(path, baseUrl).href, ASSET_IDLE_MS);
  if (!bytes) throw new Error(`Could not load ${path} (${status}).`);
  return bytes;
});

const post = (message: SvgWorkerResponse) => scope.postMessage(message);

scope.onmessage = async (event: MessageEvent<SvgWorkerRequest>) => {
  const message = event.data;
  post({ type: 'ack', seq: message.seq });
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
