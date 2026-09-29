// Downloads for SVG maps (tiles, TileJSON, fonts) that give up once no bytes
// have come for a while. One that stops without failing would otherwise hold
// its render, and every later render that shares it, forever: a font that
// never finished loading stalled every retry behind the first request.

export interface Download {
  status: number;
  ok: boolean;
  /** Null when the status isn't ok: the body isn't read then. */
  bytes: ArrayBuffer | null;
}

/** GET `url`, failing when no bytes have come for `idleMs`. */
export async function download(url: string, idleMs: number, signal?: AbortSignal): Promise<Download> {
  const controller = new AbortController();
  const forward = () => controller.abort(signal?.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener('abort', forward, { once: true });
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, idleMs);
  };
  try {
    arm();
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      response.body?.cancel().catch(() => undefined);
      return { status: response.status, ok: false, bytes: null };
    }
    if (!response.body) return { status: response.status, ok: true, bytes: await response.arrayBuffer() };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      chunks.push(value);
      length += value.byteLength;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { status: response.status, ok: true, bytes: bytes.buffer };
  } catch (error) {
    if (stalled && !signal?.aborted) throw new Error(`No data from ${url} for ${idleMs / 1000} s.`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}
