// Just enough of the Shapefile format for published tile indexes: polygon
// records from .shp, single attribute rows from .dbf by range reads (a
// national index's .dbf can run to hundreds of megabytes).

import type { Fetcher } from '../read/fetcher';

export interface IndexShape {
  /** Record number from 0, the row in the .dbf. */
  index: number;
  box: [number, number, number, number];
  rings: [number, number][][];
}

/** The file's bounding box from its 100-byte header. */
export function shpBounds(header: Uint8Array): [number, number, number, number] {
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getInt32(0, false) !== 9994) throw new Error('Not a shapefile');
  return [view.getFloat64(36, true), view.getFloat64(44, true), view.getFloat64(52, true), view.getFloat64(60, true)];
}

/** Polygon records whose bounds meet `box`, in the file's own coordinates. */
export function shpPolygons(bytes: Uint8Array, box: [number, number, number, number]): IndexShape[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  shpBounds(bytes);
  const out: IndexShape[] = [];
  let at = 100;
  let index = 0;
  while (at + 8 <= bytes.length) {
    const length = view.getInt32(at + 4, false) * 2;
    const content = at + 8;
    at = content + length;
    const record = index++;
    if (length < 4) continue;
    const type = view.getInt32(content, true);
    if (type !== 5 && type !== 15 && type !== 25) continue;
    const bb: [number, number, number, number] = [view.getFloat64(content + 4, true), view.getFloat64(content + 12, true), view.getFloat64(content + 20, true), view.getFloat64(content + 28, true)];
    if (bb[0] > box[2] || bb[2] < box[0] || bb[1] > box[3] || bb[3] < box[1]) continue;
    const parts = view.getInt32(content + 36, true);
    const points = view.getInt32(content + 40, true);
    const starts: number[] = [];
    for (let p = 0; p < parts; p++) starts.push(view.getInt32(content + 44 + 4 * p, true));
    const base = content + 44 + 4 * parts;
    const rings: [number, number][][] = [];
    for (let p = 0; p < parts; p++) {
      const end = p + 1 < parts ? starts[p + 1] : points;
      const ring: [number, number][] = [];
      for (let k = starts[p]; k < end; k++) ring.push([view.getFloat64(base + 16 * k, true), view.getFloat64(base + 16 * k + 8, true)]);
      rings.push(ring);
    }
    out.push({ index: record, box: bb, rings });
  }
  return out;
}

interface Field {
  name: string;
  type: string;
  offset: number;
  length: number;
}

/** Attribute rows of a remote .dbf, one range read each. */
export class RemoteDbf {
  private constructor(
    private readonly fetcher: Fetcher,
    private readonly url: string,
    readonly count: number,
    private readonly headerSize: number,
    private readonly rowSize: number,
    private readonly fields: Field[],
  ) {}

  static async open(fetcher: Fetcher, url: string): Promise<RemoteDbf> {
    const prefix = new DataView(await fetcher.range(url, 0, 32));
    const count = prefix.getUint32(4, true);
    const headerSize = prefix.getUint16(8, true);
    const rowSize = prefix.getUint16(10, true);
    if (headerSize < 33 || headerSize > 32768 || rowSize < 1 || rowSize > 32768) throw new Error('Invalid tile attribute index header');
    const header = new Uint8Array(await fetcher.range(url, 0, headerSize));
    const fields: Field[] = [];
    let offset = 1;
    for (let at = 32; at + 32 <= header.length && header[at] !== 0x0d; at += 32) {
      let name = '';
      for (let i = 0; i < 11 && header[at + i]; i++) name += String.fromCharCode(header[at + i]);
      const length = header[at + 16];
      fields.push({ name: name.toLowerCase(), type: String.fromCharCode(header[at + 11]), offset, length });
      offset += length;
    }
    return new RemoteDbf(fetcher, url, count, headerSize, rowSize, fields);
  }

  async row(index: number): Promise<Record<string, string | number>> {
    if (index < 0 || index >= this.count) throw new Error('Tile geometry and attribute index disagree');
    const start = this.headerSize + index * this.rowSize;
    const bytes = new Uint8Array(await this.fetcher.range(this.url, start, start + this.rowSize));
    const out: Record<string, string | number> = {};
    for (const field of this.fields) {
      const raw = new TextDecoder('latin1').decode(bytes.subarray(field.offset, field.offset + field.length)).trim();
      out[field.name] = field.type === 'N' || field.type === 'F' ? Number(raw) : raw;
    }
    return out;
  }
}
