// Reading one column of a row group by pages. Overture's files have no page
// index, so the page headers are walked to learn where each page starts and
// which rows it holds, and then only the pages holding wanted rows are
// downloaded. A geometry chunk starts with a big dictionary page used by its
// first data page only, so the dictionary is fetched only when a wanted page
// refers to it (hyparquet's own page reader always fetches it).
//
// This leans on hyparquet's internal modules (hyparquet/src/*.js). After an
// upgrade, parquet.test.ts checks the results still match hyparquet's own.

import { flatten, type ColumnMetaData, type Compressors, type FileMetaData, type ParquetParsers } from 'hyparquet';
import { readColumn } from 'hyparquet/src/column.js';
import { DEFAULT_PARSERS } from 'hyparquet/src/convert.js';
import { getSchemaPath, isFlatColumn } from 'hyparquet/src/schema.js';
import { deserializeTCompactProtocol } from 'hyparquet/src/thrift.js';
import { decompress } from 'fzstd';

// Overture's files are zstd. hyparquet reads snappy and uncompressed pages itself.
export const compressors: Compressors = { ZSTD: (input) => decompress(input) };

export type Slice = (start: number, end: number) => Promise<ArrayBuffer>;
type ColumnDecoder = Parameters<typeof readColumn>[2];

// Page types and dictionary encodings from the Parquet format.
const DATA_PAGE = 0;
const DICTIONARY_PAGE = 2;
const DATA_PAGE_V2 = 3;
const PLAIN_DICTIONARY = 2;
const RLE_DICTIONARY = 8;

// Page headers carry statistics. parquet-cpp caps them at 4 KB a value, so
// a header rarely passes 8 KB. A short probe is grown until the header fits.
const PROBE_BYTES = 16384;
const MAX_HEADER_BYTES = 1 << 20;
// The page after a dictionary holds only dictionary indices and is small, so
// a longer probe there usually takes in the next header as well.
const AFTER_DICTIONARY_PROBE_BYTES = 65536;

export interface Page {
  /** File offset of the page header. */
  offset: number;
  /** Header and data. */
  size: number;
  /** First row of the page within the row group. */
  firstRow: number;
  rows: number;
  /** Holds dictionary indices, so decoding it needs the dictionary page. */
  usesDictionary: boolean;
}

export interface ChunkLayout {
  dictionary?: { offset: number; size: number };
  pages: Page[];
}

/** The byte range of a column chunk: [dictionary or first data page, end). */
export function chunkRange(chunk: ColumnMetaData): [number, number] {
  const start = Number(chunk.dictionary_page_offset || chunk.data_page_offset);
  return [start, start + Number(chunk.total_compressed_size)];
}

interface Header {
  type: number;
  /** Header bytes. */
  length: number;
  dataSize: number;
  rows: number;
  encoding: number;
}

function parseHeader(bytes: ArrayBuffer, at: number): Header | undefined {
  if (at < 0 || at >= bytes.byteLength) return undefined;
  const reader = { view: new DataView(bytes, at), offset: 0 };
  let raw: Record<string, unknown>;
  try {
    raw = deserializeTCompactProtocol(reader);
  } catch {
    return undefined;
  }
  // The parser stops quietly at the end of its buffer, so a header that
  // reaches the end of the probe may be cut short.
  if (reader.offset >= reader.view.byteLength) return undefined;
  const type = raw.field_1;
  const dataSize = raw.field_3;
  if (typeof type !== 'number' || typeof dataSize !== 'number' || dataSize < 0) return undefined;
  // For a flat column a V1 page holds one value per row, nulls included.
  const v1 = raw.field_5 as { field_1?: unknown; field_2?: unknown } | undefined;
  const v2 = raw.field_8 as { field_3?: unknown; field_4?: unknown } | undefined;
  const rows = type === DATA_PAGE ? v1?.field_1 : type === DATA_PAGE_V2 ? v2?.field_3 : 0;
  const encoding = type === DATA_PAGE ? v1?.field_2 : type === DATA_PAGE_V2 ? v2?.field_4 : -1;
  if (typeof rows !== 'number' || typeof encoding !== 'number') return undefined;
  return { type, length: reader.offset, dataSize, rows, encoding };
}

/**
 * Finds the pages of a flat column chunk from their headers, one small read
 * per page (or fewer, when a probe also covers the next header). Returns
 * undefined when the chunk does not look as expected, and the caller then
 * reads it whole.
 */
export async function walkPages(
  slice: Slice,
  [start, end]: [number, number],
  rows: number,
  probeBytes = PROBE_BYTES,
): Promise<ChunkLayout | undefined> {
  const pages: Page[] = [];
  let dictionary: ChunkLayout['dictionary'];
  let probe: { start: number; bytes: ArrayBuffer } | undefined;
  let offset = start;
  let row = 0;
  while (offset < end) {
    let header = probe && parseHeader(probe.bytes, offset - probe.start);
    const first = dictionary && !pages.length ? Math.max(probeBytes, AFTER_DICTIONARY_PROBE_BYTES) : probeBytes;
    for (let size = first; !header; size *= 8) {
      if (size > MAX_HEADER_BYTES) return undefined;
      probe = { start: offset, bytes: await slice(offset, Math.min(end, offset + size)) };
      header = parseHeader(probe.bytes, 0);
      if (!header && offset + size >= end) return undefined;
    }
    const size = header.length + header.dataSize;
    if (header.type === DICTIONARY_PAGE && !dictionary && !pages.length) {
      dictionary = { offset, size };
    } else if (header.type === DATA_PAGE || header.type === DATA_PAGE_V2) {
      const usesDictionary = header.encoding === PLAIN_DICTIONARY || header.encoding === RLE_DICTIONARY;
      pages.push({ offset, size, firstRow: row, rows: header.rows, usesDictionary });
      row += header.rows;
    } else {
      return undefined;
    }
    offset += size;
  }
  if (offset !== end || row !== rows || (pages.some((p) => p.usesDictionary) && !dictionary)) return undefined;
  return { dictionary, pages };
}

/** Bytes to fetch (concatenated, in order) and the wanted rows they hold. */
export interface ChunkRead {
  /** One per page, so each is cached on its own. */
  ranges: [number, number][];
  /** Row within the row group of the first data page in the bytes. */
  firstRow: number;
  /** Wanted rows, ascending. */
  rows: number[];
}

/** One read of the whole chunk, dictionary included. */
export function wholeChunk(range: [number, number], wanted: readonly number[]): ChunkRead[] {
  return [{ ranges: [range], firstRow: 0, rows: [...wanted] }];
}

/**
 * Reads for `wanted` (ascending rows): runs of neighbouring pages that hold
 * wanted rows, each with the dictionary page in front when it needs it.
 *
 * Each page is a range of its own, not one range per run, so the cache keeps
 * pages apart. Moving the area a little often adds or drops a page at the end
 * of a run, and then only that page is downloaded. It costs a few more
 * requests, 1 to 3% more on the Chicago and Rome presets.
 */
export function planReads(layout: ChunkLayout, wanted: readonly number[]): ChunkRead[] {
  const reads: ChunkRead[] = [];
  let run: { first: number; last: number; rows: number[] } | undefined;
  const finish = () => {
    if (!run) return;
    const pages = layout.pages.slice(run.first, run.last + 1);
    const ranges = pages.map((page): [number, number] => [page.offset, page.offset + page.size]);
    const dictionary = layout.dictionary;
    if (dictionary && pages.some((p) => p.usesDictionary)) {
      // The dictionary sits right before the first page, the only one that
      // normally uses it, so the two are read together.
      if (dictionary.offset + dictionary.size === ranges[0][0]) ranges[0][0] = dictionary.offset;
      else ranges.unshift([dictionary.offset, dictionary.offset + dictionary.size]);
    }
    reads.push({ ranges, firstRow: pages[0].firstRow, rows: run.rows });
  };
  let w = 0;
  layout.pages.forEach((page, p) => {
    const end = page.firstRow + page.rows;
    if (w >= wanted.length || wanted[w] >= end) return;
    const rows: number[] = [];
    while (w < wanted.length && wanted[w] < end) rows.push(wanted[w++]);
    if (run && run.last === p - 1) {
      run.last = p;
      run.rows.push(...rows);
    } else {
      finish();
      run = { first: p, last: p, rows };
    }
  });
  finish();
  return reads;
}

export function readsBytes(reads: readonly ChunkRead[]): number {
  const seen = new Set<string>();
  let total = 0;
  for (const read of reads) {
    for (const [start, end] of read.ranges) {
      if (seen.has(`${start}-${end}`)) continue;
      seen.add(`${start}-${end}`);
      total += end - start;
    }
  }
  return total;
}

/** A column's decoder, as hyparquet builds it for a row group read. */
export function columnDecoder(metadata: FileMetaData, chunk: ColumnMetaData, parsers: Partial<ParquetParsers> = {}): ColumnDecoder {
  const schemaPath = getSchemaPath(metadata.schema, chunk.path_in_schema);
  return {
    pathInSchema: chunk.path_in_schema,
    type: chunk.type,
    element: schemaPath[schemaPath.length - 1].element,
    schemaPath,
    codec: chunk.codec,
    parsers: { ...DEFAULT_PARSERS, ...parsers },
    compressors,
    utf8: true,
  };
}

export function isFlat(metadata: FileMetaData, column: string): boolean {
  return isFlatColumn(getSchemaPath(metadata.schema, [column]));
}

/** Values of the wanted rows, in the order of the reads. Each distinct byte range is fetched once. */
export async function readRows(slice: Slice, decoder: ColumnDecoder, reads: readonly ChunkRead[]): Promise<unknown[]> {
  const fetches = new Map<string, Promise<ArrayBuffer>>();
  const fetch = ([start, end]: [number, number]) => {
    const key = `${start}-${end}`;
    let bytes = fetches.get(key);
    if (!bytes) fetches.set(key, (bytes = slice(start, end)));
    return bytes;
  };
  const decoded = await Promise.all(
    reads.map(async (read) => {
      const parts = await Promise.all(read.ranges.map(fetch));
      const first = read.rows[0] - read.firstRow;
      const last = read.rows[read.rows.length - 1] - read.firstRow;
      const select = { groupStart: 0, selectStart: first, selectEnd: last + 1, groupRows: last + 1 };
      const { data, skipped } = readColumn({ view: new DataView(concat(parts)), offset: 0 }, select, decoder);
      const values = flatten(data);
      return read.rows.map((row) => values[row - read.firstRow - skipped]);
    }),
  );
  return decoded.flat();
}

function concat(parts: readonly ArrayBuffer[]): ArrayBuffer {
  if (parts.length === 1) return parts[0];
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(new Uint8Array(part), at);
    at += part.byteLength;
  }
  return bytes.buffer;
}
