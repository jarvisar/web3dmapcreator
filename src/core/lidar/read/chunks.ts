// The chunk table of a plain LAZ file, so its chunks can be read and decoded
// one at a time like COPC nodes. laszip writes the table after the points,
// arithmetic coded, and its offset in the 8 bytes where the points start.
// The decoder is a port of laszip's ArithmeticDecoder and IntegerCompressor,
// only as far as the table needs (32-bit integers, two contexts).

export interface LazChunk {
  /** Absolute byte offset in the file. */
  offset: number;
  byteSize: number;
  pointCount: number;
}

/** Points per chunk from the `laszip encoded` VLR, or 0 for variable-size chunks. */
export function laszipChunkSize(laszipVlr: Uint8Array): number {
  if (laszipVlr.length < 16) throw new Error('The laszip record is too short');
  const size = new DataView(laszipVlr.buffer, laszipVlr.byteOffset, laszipVlr.byteLength).getUint32(12, true);
  return size === 0xffffffff ? 0 : size;
}

const AC_MIN_LENGTH = 0x01000000;
const BM_LENGTH_SHIFT = 13;
const BM_MAX_COUNT = 1 << BM_LENGTH_SHIFT;
const DM_LENGTH_SHIFT = 15;
const DM_MAX_COUNT = 1 << DM_LENGTH_SHIFT;

class BitModel {
  bit0Count = 1;
  bitCount = 2;
  bit0Prob = 1 << (BM_LENGTH_SHIFT - 1);
  updateCycle = 4;
  bitsUntilUpdate = 4;

  update(): void {
    if ((this.bitCount += this.updateCycle) > BM_MAX_COUNT) {
      this.bitCount = (this.bitCount + 1) >>> 1;
      this.bit0Count = (this.bit0Count + 1) >>> 1;
      if (this.bit0Count === this.bitCount) ++this.bitCount;
    }
    const scale = Math.floor(0x80000000 / this.bitCount);
    this.bit0Prob = Math.floor((this.bit0Count * scale) / 2 ** (31 - BM_LENGTH_SHIFT));
    this.updateCycle = (5 * this.updateCycle) >>> 2;
    if (this.updateCycle > 64) this.updateCycle = 64;
    this.bitsUntilUpdate = this.updateCycle;
  }
}

class SymbolModel {
  readonly distribution: Uint32Array;
  readonly counts: Uint32Array;
  readonly table: Uint32Array | null;
  readonly tableShift: number;
  readonly tableSize: number;
  totalCount = 0;
  updateCycle: number;
  symbolsUntilUpdate: number;
  readonly lastSymbol: number;

  constructor(readonly symbols: number) {
    if (symbols < 2 || symbols > 1 << 11) throw new Error('Bad LAZ symbol model');
    this.lastSymbol = symbols - 1;
    if (symbols > 16) {
      let bits = 3;
      while (symbols > 1 << (bits + 2)) ++bits;
      this.tableSize = 1 << bits;
      this.tableShift = DM_LENGTH_SHIFT - bits;
      this.table = new Uint32Array(this.tableSize + 2);
    } else {
      this.tableSize = 0;
      this.tableShift = 0;
      this.table = null;
    }
    this.distribution = new Uint32Array(symbols);
    this.counts = new Uint32Array(symbols).fill(1);
    this.updateCycle = symbols;
    this.symbolsUntilUpdate = symbols;
    this.update();
    this.symbolsUntilUpdate = this.updateCycle = (symbols + 6) >>> 1;
  }

  update(): void {
    if ((this.totalCount += this.updateCycle) > DM_MAX_COUNT) {
      this.totalCount = 0;
      for (let n = 0; n < this.symbols; n++) this.totalCount += this.counts[n] = (this.counts[n] + 1) >>> 1;
    }
    const scale = Math.floor(0x80000000 / this.totalCount);
    let sum = 0;
    let s = 0;
    for (let k = 0; k < this.symbols; k++) {
      this.distribution[k] = Math.floor((scale * sum) / 2 ** (31 - DM_LENGTH_SHIFT));
      sum += this.counts[k];
      if (this.table) {
        const w = this.distribution[k] >>> this.tableShift;
        while (s < w) this.table[++s] = k - 1;
      }
    }
    if (this.table) {
      this.table[0] = 0;
      while (s <= this.tableSize) this.table[++s] = this.symbols - 1;
    }
    this.updateCycle = (5 * this.updateCycle) >>> 2;
    const maxCycle = (this.symbols + 6) << 3;
    if (this.updateCycle > maxCycle) this.updateCycle = maxCycle;
    this.symbolsUntilUpdate = this.updateCycle;
  }
}

class ArithmeticDecoder {
  private at: number;
  private value: number;
  private length = 0xffffffff;

  constructor(private readonly bytes: Uint8Array) {
    if (bytes.length < 4) throw new Error('The LAZ chunk table is truncated');
    this.value = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
    this.at = 4;
  }

  private byte(): number {
    // laszip reads a few bytes past the table's last symbol. Past the end of
    // what was read they can only be EVLRs or nothing, and don't matter.
    return this.at < this.bytes.length ? this.bytes[this.at++] : (this.at++, 0);
  }

  private renorm(): void {
    do {
      this.value = ((this.value << 8) | this.byte()) >>> 0;
      this.length = (this.length * 256) >>> 0;
    } while (this.length < AC_MIN_LENGTH);
  }

  bit(m: BitModel): number {
    // Unlike symbol(), the length is only scaled for the product.
    const x = m.bit0Prob * (this.length >>> BM_LENGTH_SHIFT);
    let sym: number;
    if (this.value < x) {
      sym = 0;
      this.length = x;
      ++m.bit0Count;
    } else {
      sym = 1;
      this.value -= x;
      this.length -= x;
    }
    if (this.length < AC_MIN_LENGTH) this.renorm();
    if (--m.bitsUntilUpdate === 0) m.update();
    return sym;
  }

  symbol(m: SymbolModel): number {
    let sym: number;
    let x: number;
    let y = this.length;
    if (m.table) {
      this.length = this.length >>> DM_LENGTH_SHIFT;
      const dv = Math.floor(this.value / this.length);
      const t = dv >>> m.tableShift;
      sym = m.table[t];
      let n = m.table[t + 1] + 1;
      while (n > sym + 1) {
        const k = (sym + n) >>> 1;
        if (m.distribution[k] > dv) n = k;
        else sym = k;
      }
      x = m.distribution[sym] * this.length;
      if (sym !== m.lastSymbol) y = m.distribution[sym + 1] * this.length;
    } else {
      x = sym = 0;
      this.length = this.length >>> DM_LENGTH_SHIFT;
      let n = m.symbols;
      let k = n >>> 1;
      do {
        const z = this.length * m.distribution[k];
        if (z > this.value) {
          n = k;
          y = z;
        } else {
          sym = k;
          x = z;
        }
      } while ((k = (sym + n) >>> 1) !== sym);
    }
    this.value -= x;
    this.length = y - x;
    if (this.length < AC_MIN_LENGTH) this.renorm();
    ++m.counts[sym];
    if (--m.symbolsUntilUpdate === 0) m.update();
    return sym;
  }

  bits(count: number): number {
    if (count > 19) {
      const lower = this.short();
      return (this.bits(count - 16) * 65536 + lower) >>> 0;
    }
    this.length = this.length >>> count;
    const sym = Math.floor(this.value / this.length);
    this.value -= this.length * sym;
    if (this.length < AC_MIN_LENGTH) this.renorm();
    return sym;
  }

  private short(): number {
    this.length = this.length >>> 16;
    const sym = Math.floor(this.value / this.length);
    this.value -= this.length * sym;
    if (this.length < AC_MIN_LENGTH) this.renorm();
    return sym;
  }
}

// laszip's IntegerCompressor with 32 bits, bits_high 8 and no range.
class IntegerDecoder {
  private readonly contexts: SymbolModel[];
  private readonly zero = new BitModel();
  private readonly corrector: SymbolModel[] = [];

  constructor(
    private readonly decoder: ArithmeticDecoder,
    contexts: number,
  ) {
    this.contexts = Array.from({ length: contexts }, () => new SymbolModel(33));
    for (let i = 1; i <= 32; i++) this.corrector[i] = new SymbolModel(1 << Math.min(i, 8));
  }

  decompress(prediction: number, context: number): number {
    return (prediction + this.corrector32(this.contexts[context])) | 0;
  }

  private corrector32(bits: SymbolModel): number {
    const k = this.decoder.symbol(bits);
    if (!k) return this.decoder.bit(this.zero);
    if (k >= 32) return -0x80000000;
    let c: number;
    if (k <= 8) c = this.decoder.symbol(this.corrector[k]);
    else {
      const extra = k - 8;
      c = this.decoder.symbol(this.corrector[k]) * 2 ** extra + this.decoder.bits(extra);
    }
    return c >= 2 ** (k - 1) ? c + 1 : c - (2 ** k - 1);
  }
}

/** Point and byte counts of each chunk from the coded part of the table. */
export function chunkEntries(body: Uint8Array, count: number, variable: boolean): { counts: number[]; sizes: number[] } {
  const counts = new Array<number>(count);
  const sizes = new Array<number>(count);
  if (count) {
    const ic = new IntegerDecoder(new ArithmeticDecoder(body), 2);
    for (let i = 0; i < count; i++) {
      if (variable) counts[i] = ic.decompress(i ? counts[i - 1] : 0, 0);
      sizes[i] = ic.decompress(i ? sizes[i - 1] : 0, 1);
    }
  }
  return { counts, sizes };
}

/**
 * The chunks of a LAZ file from its chunk table: `head` is the table's first
 * 8 bytes (version and chunk count) and `body` what follows. `start` is
 * where the first chunk begins, 8 bytes after the point data offset.
 */
export function decodeChunkTable(head: Uint8Array, body: Uint8Array, start: number, chunkSize: number, pointCount: number): LazChunk[] {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (view.getUint32(0, true) !== 0) throw new Error('Unknown LAZ chunk table version');
  const count = view.getUint32(4, true);
  if (count > 1e7) throw new Error('The LAZ chunk table is too large');
  const { counts, sizes } = chunkEntries(body, count, !chunkSize);
  const out: LazChunk[] = [];
  let offset = start;
  let left = pointCount;
  for (let i = 0; i < count; i++) {
    const points = chunkSize ? Math.min(chunkSize, left) : counts[i];
    if (!(sizes[i] > 0) || !(points > 0)) throw new Error('The LAZ chunk table is corrupt');
    out.push({ offset, byteSize: sizes[i], pointCount: points });
    offset += sizes[i];
    left -= points;
  }
  // Fixed-size chunks: the last one holds what's left, and nothing may be left over.
  if (count && left !== 0) throw new Error('The LAZ chunk table does not match the point count');
  return out;
}
