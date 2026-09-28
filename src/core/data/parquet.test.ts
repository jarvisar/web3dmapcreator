import { readFileSync } from 'node:fs';
import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { describe, expect, it } from 'vitest';
import {
  chunkRange,
  columnDecoder,
  compressors,
  isFlat,
  planReads,
  readRows,
  readsBytes,
  walkPages,
  wholeChunk,
  type ChunkLayout,
} from './parquet';

// building-a.parquet has 4 row groups of 3 rows. Each geometry chunk is a
// dictionary page and one page per row, the first pages dictionary encoded.
const file = readFileSync(new URL('./testdata/building-a.parquet', import.meta.url));
const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
const metadata = parquetMetadata(buffer);
const slice = async (start: number, end: number) => buffer.slice(start, end);
const raw = { geometryFromBytes: (bytes: Uint8Array) => bytes };

function geometry(group: number) {
  return metadata.row_groups[group].columns.find((c) => c.meta_data?.path_in_schema[0] === 'geometry')!.meta_data!;
}

describe('walkPages', () => {
  it('finds the dictionary and every data page', async () => {
    const range = chunkRange(geometry(1));
    const layout = await walkPages(slice, range, 3);
    expect(layout?.dictionary?.offset).toBe(range[0]);
    expect(layout?.pages.map((p) => [p.firstRow, p.rows, p.usesDictionary])).toEqual([
      [0, 1, true],
      [1, 1, true],
      [2, 1, false],
    ]);
    // The pages follow each other to the end of the chunk.
    const pages = layout!.pages;
    expect(pages[0].offset).toBe(range[0] + layout!.dictionary!.size);
    for (let i = 1; i < pages.length; i++) expect(pages[i].offset).toBe(pages[i - 1].offset + pages[i - 1].size);
    expect(pages[2].offset + pages[2].size).toBe(range[1]);
  });

  it('grows a probe too short for a header', async () => {
    const range = chunkRange(geometry(3));
    const reads: number[] = [];
    const counting = async (start: number, end: number) => {
      reads.push(end - start);
      return slice(start, end);
    };
    expect(await walkPages(counting, range, 3, 4)).toEqual(await walkPages(slice, range, 3));
    expect(Math.min(...reads)).toBe(4);
  });

  it('gives up on a chunk that does not add up', async () => {
    const range = chunkRange(geometry(0));
    expect(await walkPages(slice, range, 4)).toBeUndefined();
    expect(await walkPages(slice, [range[0] + 1, range[1]], 3)).toBeUndefined();
  });
});

describe('planReads', () => {
  const layout: ChunkLayout = {
    dictionary: { offset: 0, size: 100 },
    pages: [
      { offset: 100, size: 50, firstRow: 0, rows: 10, usesDictionary: true },
      { offset: 150, size: 50, firstRow: 10, rows: 10, usesDictionary: false },
      { offset: 200, size: 50, firstRow: 20, rows: 10, usesDictionary: false },
      { offset: 250, size: 50, firstRow: 30, rows: 10, usesDictionary: false },
    ],
  };

  it('reads runs of neighbouring pages that hold wanted rows', () => {
    expect(planReads(layout, [12, 15, 35])).toEqual([
      { ranges: [[150, 200]], firstRow: 10, rows: [12, 15] },
      { ranges: [[250, 300]], firstRow: 30, rows: [35] },
    ]);
    expect(planReads(layout, [12, 21, 35])).toEqual([{ ranges: [[150, 300]], firstRow: 10, rows: [12, 21, 35] }]);
    expect(readsBytes(planReads(layout, [12, 35]))).toBe(100);
  });

  it('adds the dictionary only for runs that use it', () => {
    expect(planReads(layout, [5, 12])).toEqual([{ ranges: [[0, 200]], firstRow: 0, rows: [5, 12] }]);
    const allDictionary = { ...layout, pages: layout.pages.map((page) => ({ ...page, usesDictionary: true })) };
    const reads = planReads(allDictionary, [5, 35]);
    expect(reads).toEqual([
      { ranges: [[0, 150]], firstRow: 0, rows: [5] },
      { ranges: [[0, 100], [250, 300]], firstRow: 30, rows: [35] },
    ]);
    expect(readsBytes(reads)).toBe(300);
  });
});

describe('readRows', () => {
  it('returns what hyparquet reads, for any set of rows', async () => {
    const byteFile = { byteLength: buffer.byteLength, slice };
    for (let group = 0; group < 4; group++) {
      const chunk = geometry(group);
      const decoder = columnDecoder(metadata, chunk, raw);
      const reference = await parquetReadObjects({
        file: byteFile,
        columns: ['geometry'],
        rowStart: group * 3,
        rowEnd: group * 3 + 3,
        compressors,
        parsers: raw,
      });
      const expected = reference.map((row) => row.geometry);
      expect(await readRows(slice, decoder, wholeChunk(chunkRange(chunk), [0, 1, 2]))).toEqual(expected);
      const layout = (await walkPages(slice, chunkRange(chunk), 3))!;
      for (const rows of [[0], [1], [2], [0, 2], [1, 2], [0, 1, 2]]) {
        expect(await readRows(slice, decoder, planReads(layout, rows))).toEqual(rows.map((row) => expected[row]));
      }
    }
  });

  it('skips the dictionary for rows on plain pages', async () => {
    const chunk = geometry(1);
    const layout = (await walkPages(slice, chunkRange(chunk), 3))!;
    const fetched: [number, number][] = [];
    const logging = async (start: number, end: number) => {
      fetched.push([start, end]);
      return slice(start, end);
    };
    const [value] = await readRows(logging, columnDecoder(metadata, chunk, raw), planReads(layout, [2]));
    expect(value).toBeInstanceOf(Uint8Array);
    expect(fetched).toEqual([[layout.pages[2].offset, chunkRange(chunk)[1]]]);
  });

  it('knows flat columns from nested ones', () => {
    expect(isFlat(metadata, 'geometry')).toBe(true);
    expect(isFlat(metadata, 'bbox')).toBe(false);
  });
});
