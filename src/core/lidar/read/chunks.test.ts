// Chunk tables cut from two real files, checked against laz-rs's
// read_chunk_table_only: a Geobasis NRW tile (LAStools, fixed 50,000 point
// chunks) and a swisstopo COPC file (variable chunks, one per node).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chunkEntries, decodeChunkTable, laszipChunkSize } from './chunks';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../testdata/${name}`, import.meta.url)));

describe('LAZ chunk tables', () => {
  it('reads fixed-size chunks, the last one holding what is left', () => {
    const table = fixture('nrw-chunk-table.bin');
    const chunks = decodeChunkTable(table.subarray(0, 8), table.subarray(8), 437, 50000, 9471722);
    expect(chunks).toHaveLength(190);
    expect(chunks[0]).toEqual({ offset: 437, byteSize: 223287, pointCount: 50000 });
    expect(chunks.at(-1)).toEqual({ offset: 48401492 - 134740, byteSize: 134740, pointCount: 9471722 - 189 * 50000 });
  });

  it('reads variable chunks with their point counts', () => {
    const table = fixture('copc-chunk-table.bin');
    const chunks = decodeChunkTable(table.subarray(0, 8), table.subarray(8), 1455, 0, 25540245);
    expect(chunks).toHaveLength(2154);
    expect(chunks[0]).toEqual({ offset: 1455, byteSize: 15426, pointCount: 2203 });
    // The first correction coded as a single bit (a count one more than the last).
    expect(chunks[1061]).toMatchObject({ byteSize: 35656, pointCount: 5617 });
    expect(chunks.at(-1)).toMatchObject({ byteSize: 617582, pointCount: 56211 });
    expect(chunks.at(-1)!.offset + chunks.at(-1)!.byteSize).toBe(154597208);
  });

  it('refuses a table that does not add up', () => {
    const table = fixture('nrw-chunk-table.bin');
    expect(() => decodeChunkTable(table.subarray(0, 8), table.subarray(8), 437, 50000, 9000000)).toThrow();
    const broken = table.slice();
    broken[4] = 9;
    expect(() => decodeChunkTable(broken.subarray(0, 8), broken.subarray(8), 437, 50000, 9471722)).toThrow();
    expect(chunkEntries(new Uint8Array(4), 0, true)).toEqual({ counts: [], sizes: [] });
  });

  it('reads the chunk size from the laszip record', () => {
    const vlr = new Uint8Array(34);
    new DataView(vlr.buffer).setUint32(12, 50000, true);
    expect(laszipChunkSize(vlr)).toBe(50000);
    new DataView(vlr.buffer).setUint32(12, 0xffffffff, true);
    expect(laszipChunkSize(vlr)).toBe(0);
  });
});
