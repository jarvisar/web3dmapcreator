// Streaming ZIP writer over fflate. Each entry is deflated as its chunks
// arrive, so a large model never exists as one string or one uncompressed
// buffer. Only the compressed archive is kept, and it is joined once at the
// end.

import { Zip, ZipDeflate } from 'fflate';

export type DeflateLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

// Text is encoded in pieces of about this many characters.
const TEXT_CHUNK = 1 << 20;
// fflate writes no ZIP64 records: sizes and offsets are 32-bit.
const ZIP32_LIMIT = 0xffffffff;
const TOO_LARGE = 'The export is too large for a ZIP archive (4 GB)';

const encoder = new TextEncoder();

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
  private chunks: Uint8Array[] = [];
  private length = 0;
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
      this.chunks.push(data);
      this.length += data.length;
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

  finish(): Uint8Array {
    if (this.open) throw new Error(`${this.open.name} is still being written`);
    this.zip.end();
    this.checkError();
    if (!this.ended) throw new Error('The ZIP archive did not finish');
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];
    return out;
  }

  /** @internal */
  entryClosed(entry: ZipEntry): void {
    if (this.open === entry) this.open = null;
    this.checkError();
  }

  /** @internal */
  checkError(): void {
    if (this.error) throw new Error(`ZIP compression failed: ${this.error.message}`);
    if (this.length > ZIP32_LIMIT) throw new Error(TOO_LARGE);
  }
}
