// LAZ decompression behind a small interface, so the readers don't depend on
// one decoder. The worker and Node scripts install one with setLazDecoder.

export interface LazChunkDecoder {
  /** Raw point records for one compressed chunk (a COPC node). */
  decode(chunk: Uint8Array, pointCount: number): Uint8Array;
  free(): void;
}

export interface LazDecoder {
  /** Raw point records of a whole LAZ (or LAS) file, such as an EPT node. */
  decodeFile(bytes: Uint8Array): { records: Uint8Array; pointCount: number; pointSize: number };
  /** A decoder for standalone chunks, built from the `laszip encoded` VLR payload. */
  chunkDecoder(laszipVlr: Uint8Array): LazChunkDecoder;
}

let decoder: LazDecoder | null = null;
let loader: (() => Promise<LazDecoder>) | null = null;

/** Install a decoder, or a loader that creates one on first use. */
export function setLazDecoder(value: LazDecoder | (() => Promise<LazDecoder>) | null): void {
  if (typeof value === 'function') {
    loader = value;
    decoder = null;
  } else {
    decoder = value;
    loader = null;
  }
}

export async function lazDecoder(): Promise<LazDecoder> {
  if (decoder) return decoder;
  if (loader) {
    decoder = await loader();
    return decoder;
  }
  throw new Error('No LAZ decoder is installed');
}
