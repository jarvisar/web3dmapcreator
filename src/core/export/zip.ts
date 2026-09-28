// Streaming ZIP writer over fflate. Each entry is deflated as its chunks
// arrive, so a large model never exists as one string or one uncompressed
// buffer. The compressed chunks go into a Blob and are never joined.

import { Zip, ZipDeflate } from 'fflate';

export type DeflateLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

// Text is encoded in pieces of about this many characters.
const TEXT_CHUNK = 1 << 20;
// fflate writes no ZIP64 records: sizes and offsets are 32-bit.
const ZIP32_LIMIT = 0xffffffff;
const TOO_LARGE = 'The export is too large for a ZIP archive (4 GB)';
// Chunks are handed to a Blob about this often.
const BLOB_BATCH = 1 << 24;

const encoder = new TextEncoder();

/**
 * Output collected as a Blob. The browser keeps blob bytes out of the JS heap
 * (Chrome can page large ones to disk), and a Blob posts from the worker
 * without a copy, so an export only ever holds one batch of chunks itself.
 */
export class BlobBuilder {
  private blobs: Blob[] = [];
  private chunks: Uint8Array[] = [];
  private pending = 0;
  private total = 0;

  get size(): number {
    return this.total;
  }

  /** The chunk is kept until the next batch, so the caller must not reuse it. */
  push(chunk: Uint8Array): void {
    if (!chunk.length) return;
    this.chunks.push(chunk);
    this.pending += chunk.length;
    this.total += chunk.length;
    if (this.pending >= BLOB_BATCH) this.flush();
  }

  finish(type: string): Blob {
    this.flush();
    const blob = new Blob(this.blobs, { type });
    this.blobs = [];
    return blob;
  }

  private flush(): void {
    if (!this.chunks.length) return;
    this.blobs.push(new Blob(this.chunks as BlobPart[]));
    this.chunks = [];
    this.pending = 0;
  }
}

export class ZipEntry {
  private parts: string[] = [];
  private pending = 0;
  private size = 0;
  private closed = false;

  constructor(
    readonly name: string,
    private readonly stream: ZipDeflate,
    private readonly writer: ZipWriter,
  ) {}

  text(value: string): void {
    this.check();
    if (!value) return;
    this.parts.push(value);
    this.pending += value.length;
    if (this.pending >= TEXT_CHUNK) this.flushText();
  }

  /** The chunk is compressed before this returns, so the caller may reuse it. */
  bytes(data: Uint8Array): void {
    this.check();
    this.flushText();
    this.push(data);
  }

  close(): void {
    this.check();
    this.flushText();
    this.closed = true;
    this.stream.push(new Uint8Array(0), true);
    this.writer.entryClosed(this);
  }

  private flushText(): void {
    if (!this.pending) return;
    const text = this.parts.length === 1 ? this.parts[0] : this.parts.join('');
    this.parts = [];
    this.pending = 0;
    this.push(encoder.encode(text));
  }

  private push(data: Uint8Array): void {
    if (!data.length) return;
    this.size += data.length;
    if (this.size > ZIP32_LIMIT) throw new Error(TOO_LARGE);
    this.stream.push(data);
    this.writer.checkError();
  }

  private check(): void {
    if (this.closed) throw new Error(`${this.name} is already closed`);
  }
}

export class ZipWriter {
  private readonly zip: Zip;
  private readonly out = new BlobBuilder();
  private error: Error | null = null;
  private ended = false;
  private open: ZipEntry | null = null;
  private readonly names = new Set<string>();

  // Deflate dominates export time. On a 5 million triangle city, level 3 was
  // a quarter faster than level 5 for files 1% larger.
  constructor(private readonly level: DeflateLevel = 3) {
    this.zip = new Zip((error, data, final) => {
      if (error) {
        this.error ??= error;
        return;
      }
      // fflate hands over a new array each time, so it can be kept as is.
      this.out.push(data);
      if (final) this.ended = true;
    });
  }

  /** Start an entry. Entries are written one at a time. */
  entry(name: string): ZipEntry {
    if (this.open) throw new Error(`${this.open.name} is still being written`);
    if (this.names.has(name)) throw new Error(`Duplicate ZIP entry ${name}`);
    this.names.add(name);
    const stream = new ZipDeflate(name, { level: this.level });
    this.zip.add(stream);
    this.checkError();
    this.open = new ZipEntry(name, stream, this);
    return this.open;
  }

  /** A whole small entry at once. */
  file(name: string, content: string | Uint8Array): void {
    const entry = this.entry(name);
    if (typeof content === 'string') entry.text(content);
    else entry.bytes(content);
    entry.close();
  }

  finish(type = 'application/zip'): Blob {
    if (this.open) throw new Error(`${this.open.name} is still being written`);
    this.zip.end();
    this.checkError();
    if (!this.ended) throw new Error('The ZIP archive did not finish');
    return this.out.finish(type);
  }

  /** @internal */
  entryClosed(entry: ZipEntry): void {
    if (this.open === entry) this.open = null;
    this.checkError();
  }

  /** @internal */
  checkError(): void {
    if (this.error) throw new Error(`ZIP compression failed: ${this.error.message}`);
    if (this.out.size > ZIP32_LIMIT) throw new Error(TOO_LARGE);
  }
}
