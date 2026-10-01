// Finding a LAS/LAZ member inside a ZIP by range reads, for publishers that
// wrap each tile in one. A stored member is a run of bytes in the ZIP, so it
// reads in place. A deflated one has to be fetched whole and inflated.
// ZIP64 sizes and offsets are read too: tiles past 4 GB exist.

export interface ZipMember {
  name: string;
  /** 0 stored, 8 deflated. */
  method: number;
  /** Where the member's data starts in the ZIP. */
  offset: number;
  compressedSize: number;
  size: number;
}

type Read = (start: number, end: number) => Promise<Uint8Array>;

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const END64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;

export const isZip = (bytes: Uint8Array) => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

const pointFile = (name: string) => /\.(laz|las)$/i.test(name) && !name.endsWith('/');

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** The ZIP64 extra field's values that the fixed fields left at 0xFFFFFFFF, in their order. */
function zip64(extra: Uint8Array, wanted: ('size' | 'compressed' | 'offset')[]): Record<string, number> {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  const out: Record<string, number> = {};
  for (let at = 0; at + 4 <= extra.length; ) {
    const id = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    if (id === 1) {
      let k = at + 4;
      for (const name of wanted) {
        if (k + 8 > at + 4 + length) break;
        out[name] = Number(view.getBigUint64(k, true));
        k += 8;
      }
      return out;
    }
    at += 4 + length;
  }
  return out;
}

/** Where a member's data starts, from its local header. */
async function dataOffset(read: Read, header: number): Promise<number> {
  const local = await read(header, header + 30);
  const view = new DataView(local.buffer, local.byteOffset, local.byteLength);
  if (view.getUint32(0, true) !== LOCAL) throw new Error('A ZIP member header is missing');
  return header + 30 + view.getUint16(26, true) + view.getUint16(28, true);
}

/** Members from the central directory, which needs the file size. Their offsets are their local headers'. */
export async function centralMembers(read: Read, size: number): Promise<ZipMember[]> {
  const tailStart = Math.max(0, size - 65557);
  const tail = await read(tailStart, size);
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let end = -1;
  for (let at = tail.length - 22; at >= 0; at--) {
    if (tv.getUint32(at, true) === END) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('The ZIP has no central directory');
  let count = tv.getUint16(end + 10, true);
  let cdSize = tv.getUint32(end + 12, true);
  let cdOffset = tv.getUint32(end + 16, true);
  if ((cdOffset === 0xffffffff || count === 0xffff) && end >= 20 && tv.getUint32(end - 20, true) === LOCATOR64) {
    const at = Number(tv.getBigUint64(end - 12, true));
    const record = await read(at, at + 56);
    const rv = new DataView(record.buffer, record.byteOffset, record.byteLength);
    if (rv.getUint32(0, true) !== END64) throw new Error('The ZIP64 directory is missing');
    count = Number(rv.getBigUint64(32, true));
    cdSize = Number(rv.getBigUint64(40, true));
    cdOffset = Number(rv.getBigUint64(48, true));
  }
  if (cdSize > 64 * 1024 * 1024) throw new Error('The ZIP directory is too large');
  const cd = await read(cdOffset, cdOffset + cdSize);
  const view = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const out: ZipMember[] = [];
  for (let at = 0, k = 0; k < count && at + 46 <= cd.length; k++) {
    if (view.getUint32(at, true) !== CENTRAL) throw new Error('The ZIP directory is damaged');
    const method = view.getUint16(at + 10, true);
    let compressedSize = view.getUint32(at + 20, true);
    let memberSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    let header = view.getUint32(at + 42, true);
    const name = text(cd.subarray(at + 46, at + 46 + nameLength));
    const wanted: ('size' | 'compressed' | 'offset')[] = [];
    if (memberSize === 0xffffffff) wanted.push('size');
    if (compressedSize === 0xffffffff) wanted.push('compressed');
    if (header === 0xffffffff) wanted.push('offset');
    if (wanted.length) {
      const big = zip64(cd.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength), wanted);
      memberSize = big.size ?? memberSize;
      compressedSize = big.compressed ?? compressedSize;
      header = big.offset ?? header;
    }
    out.push({ name, method, offset: header, compressedSize, size: memberSize });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

/** Members from local headers alone, up to the one wanted, when the size isn't known. Needs sizes in the local headers. */
async function firstMembers(read: Read, first: Uint8Array, member?: string): Promise<ZipMember[]> {
  const out: ZipMember[] = [];
  let at = 0;
  let head = first;
  for (let k = 0; k < 16; k++) {
    if (head.length < 30) head = await read(at, at + 30);
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (view.getUint32(0, true) !== LOCAL) break;
    const flags = view.getUint16(6, true);
    const method = view.getUint16(8, true);
    let compressedSize = view.getUint32(18, true);
    let size = view.getUint32(22, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const names = await read(at + 30, at + 30 + nameLength + extraLength);
    const name = text(names.subarray(0, nameLength));
    if (compressedSize === 0xffffffff || size === 0xffffffff) {
      const big = zip64(names.subarray(nameLength), ['size', 'compressed']);
      size = big.size ?? size;
      compressedSize = big.compressed ?? compressedSize;
    }
    if (flags & 8 && !compressedSize) throw new Error('The ZIP member sizes are only in its directory, which needs the file size');
    const data = at + 30 + nameLength + extraLength;
    out.push({ name, method, offset: data, compressedSize, size });
    if (member ? name === member : pointFile(name)) break;
    at = data + compressedSize;
    head = new Uint8Array(0);
  }
  return out;
}

/**
 * The point file in a ZIP: the member named `member`, or the first .laz or
 * .las. `first` is the start of the file, already read. A named member that
 * isn't there is null.
 */
export async function zipMember(read: Read, first: Uint8Array, size: number | undefined, member?: string): Promise<ZipMember | null> {
  const members = size ? await centralMembers(read, size) : await firstMembers(read, first, member);
  const found = members.find((m) => (member ? m.name === member : pointFile(m.name)));
  if (!found && member) return null;
  if (!found) throw new Error('The ZIP holds no LAS or LAZ file');
  if (found.method !== 0 && found.method !== 8) throw new Error(`The ZIP member is compressed with method ${found.method}`);
  // The central directory points at the local header, and the data follows it.
  return size ? { ...found, offset: await dataOffset(read, found.offset) } : found;
}
