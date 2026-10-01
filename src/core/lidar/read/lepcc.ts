// LEPCC point positions ('lepcc-xyz'), the geometry of Esri I3S point cloud
// scene layers. Only the decoder, ported from Esri/lepcc (Apache 2.0):
// LEPCC.cpp (Decode, Decode_CutInSegments), BitStuffer2.cpp (Decode,
// BitUnStuff) and Common.cpp (Fletcher-32).
//
// Points come out sorted by grid row, which is the order the layer's
// attributes are stored in too. Positions are snapped to cells of twice the
// blob's max error, which is up to 0.5 m in a layer's coarse nodes.

export interface LepccPoints {
  count: number;
  /** x, y, z per point, in the layer's coordinate system. */
  xyz: Float64Array;
  maxError: [number, number, number];
}

function fletcher32(bytes: Uint8Array, start: number, length: number): number {
  let sum1 = 0xffff;
  let sum2 = 0xffff;
  let words = Math.floor(length / 2);
  let p = start;
  while (words) {
    let run = Math.min(words, 359);
    words -= run;
    do {
      sum1 += bytes[p++] << 8;
      sum1 += bytes[p++];
      sum2 += sum1;
    } while (--run);
    sum1 = (sum1 & 0xffff) + (sum1 >>> 16);
    sum2 = (sum2 & 0xffff) + (sum2 >>> 16);
  }
  if (length & 1) {
    sum1 += bytes[p] << 8;
    sum2 += sum1;
  }
  sum1 = (sum1 & 0xffff) + (sum1 >>> 16);
  sum2 = (sum2 & 0xffff) + (sum2 >>> 16);
  return ((sum2 << 16) | sum1) >>> 0;
}

class Reader {
  at = 0;
  private readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8(): number {
    return this.bytes[this.at++];
  }
  uint(size: number): number {
    const value = size === 1 ? this.view.getUint8(this.at) : size === 2 ? this.view.getUint16(this.at, true) : this.view.getUint32(this.at, true);
    this.at += size;
    return value;
  }
}

/** `count` values of `bits` bits, packed into little-endian 32-bit words, the last one cut short. */
function unstuff(reader: Reader, count: number, bits: number): Uint32Array {
  const out = new Uint32Array(count);
  if (!count || !bits) return out;
  const words = Math.floor((count * bits + 31) / 32);
  const tailBytes = (((count * bits) & 31) + 7) >> 3;
  const used = words * 4 - (tailBytes > 0 ? 4 - tailBytes : 0);
  if (reader.at + used > reader.bytes.length) throw new Error('LEPCC blob ends early');
  const padded = new Uint8Array(words * 4);
  padded.set(reader.bytes.subarray(reader.at, reader.at + used));
  const view = new DataView(padded.buffer);
  const shift = 32 - bits;
  let word = 0;
  let bit = 0;
  for (let i = 0; i < count; i++) {
    const current = view.getUint32(word * 4, true);
    if (shift - bit >= 0) {
      out[i] = ((current << (shift - bit)) >>> 0) >>> shift;
      bit += bits;
      if (bit === 32) {
        word++;
        bit = 0;
      }
    } else {
      let value = current >>> bit;
      word++;
      value |= ((view.getUint32(word * 4, true) << (64 - bits - bit)) >>> 0) >>> shift;
      out[i] = value >>> 0;
      bit -= shift;
    }
  }
  reader.at += used;
  return out;
}

function bitStuffed(reader: Reader): Uint32Array {
  const head = reader.u8();
  const sizeCode = head >> 6;
  const count = reader.uint(sizeCode === 0 ? 4 : 3 - sizeCode);
  const bits = head & 31;
  if (!(head & 32)) return unstuff(reader, count, bits);
  // With a lookup table: indices into the distinct values, 0 meaning 0.
  const tableSize = reader.u8() - 1;
  const table = unstuff(reader, tableSize, bits);
  let indexBits = 0;
  while (tableSize >> indexBits) indexBits++;
  const indices = unstuff(reader, count, indexBits);
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) out[i] = indices[i] ? table[indices[i] - 1] : 0;
  return out;
}

/** One array cut into sections, each stored as offsets from its own minimum. */
function segmented(reader: Reader): Uint32Array {
  const minimums = bitStuffed(reader);
  const parts: Uint32Array[] = [];
  let total = 0;
  for (const minimum of minimums) {
    const part = bitStuffed(reader);
    for (let j = 0; j < part.length; j++) part[j] += minimum;
    parts.push(part);
    total += part.length;
  }
  const out = new Uint32Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function decodeLepccXyz(blob: Uint8Array): LepccPoints {
  if (blob.length < 104 || new TextDecoder().decode(blob.subarray(0, 10)) !== 'LEPCC     ') throw new Error('Not a LEPCC point blob');
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const checksum = view.getUint32(12, true);
  const size = Number(view.getBigInt64(16, true));
  if (size > blob.length) throw new Error('LEPCC blob ends early');
  if (fletcher32(blob, 16, size - 16) !== checksum) throw new Error('LEPCC blob fails its checksum');
  const f64 = (at: number) => view.getFloat64(at, true);
  const lower = [f64(24), f64(32), f64(40)];
  const upper = [f64(48), f64(56), f64(64)];
  const maxError: [number, number, number] = [f64(72), f64(80), f64(88)];
  const count = view.getUint32(96, true);
  const reader = new Reader(blob);
  reader.at = 104;
  const rowSteps = segmented(reader);
  const perRow = segmented(reader);
  const columnSteps = segmented(reader);
  const levels = segmented(reader);
  const xyz = new Float64Array(count * 3);
  const cell = maxError.map((e) => 2 * e);
  let n = 0;
  let row = 0;
  for (let i = 0; i < rowSteps.length; i++) {
    row += rowSteps[i];
    let column = 0;
    for (let j = 0; j < perRow[i]; j++) {
      if (n >= count) throw new Error('LEPCC blob holds more points than it says');
      column += columnSteps[n];
      xyz[n * 3] = Math.min(lower[0] + column * cell[0], upper[0]);
      xyz[n * 3 + 1] = Math.min(lower[1] + row * cell[1], upper[1]);
      xyz[n * 3 + 2] = Math.min(lower[2] + levels[n] * cell[2], upper[2]);
      n++;
    }
  }
  if (n !== count) throw new Error(`LEPCC blob decoded ${n} of ${count} points`);
  return { count, xyz, maxError };
}
