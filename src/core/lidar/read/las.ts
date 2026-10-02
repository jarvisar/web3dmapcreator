// LAS 1.2-1.4 framing: the public header, variable length records, COPC's
// info record and hierarchy pages, and the few point record fields the
// measurements read. Decompression lives behind laz.ts.

export interface Vlr {
  userId: string;
  recordId: number;
  data: Uint8Array;
}

export interface LasHeader {
  versionMinor: number;
  /** Bit 0 set: GPS time is adjusted standard GPS time (an absolute date). */
  globalEncoding: number;
  headerSize: number;
  pointDataOffset: number;
  vlrCount: number;
  /** Point data format with the compression bits masked off: 0-10. */
  pointFormat: number;
  compressed: boolean;
  pointSize: number;
  pointCount: number;
  scale: [number, number, number];
  offset: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  evlrOffset: number;
  evlrCount: number;
}

const text = (bytes: Uint8Array) => {
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  let out = '';
  for (let i = 0; i < end; i++) out += String.fromCharCode(bytes[i]);
  return out;
};

export function readHeader(bytes: Uint8Array): LasHeader {
  if (bytes.length < 227 || text(bytes.subarray(0, 4)) !== 'LASF') throw new Error('Not a LAS file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minor = bytes[25];
  const format = bytes[104];
  const f64 = (at: number) => view.getFloat64(at, true);
  let pointCount = view.getUint32(107, true);
  let evlrOffset = 0;
  let evlrCount = 0;
  if (minor >= 4 && bytes.length >= 375) {
    evlrOffset = Number(view.getBigUint64(235, true));
    evlrCount = view.getUint32(243, true);
    const count = Number(view.getBigUint64(247, true));
    if (count) pointCount = count;
  }
  return {
    versionMinor: minor,
    globalEncoding: view.getUint16(6, true),
    headerSize: view.getUint16(94, true),
    pointDataOffset: view.getUint32(96, true),
    vlrCount: view.getUint32(100, true),
    pointFormat: format & 0x3f,
    compressed: (format & 0x80) !== 0 || (format & 0x40) !== 0,
    pointSize: view.getUint16(105, true),
    pointCount,
    scale: [f64(131), f64(139), f64(147)],
    offset: [f64(155), f64(163), f64(171)],
    max: [f64(179), f64(195), f64(211)],
    min: [f64(187), f64(203), f64(219)],
    evlrOffset,
    evlrCount,
  };
}

/** VLRs from a buffer holding the file's start. Stops at the buffer's end. */
export function readVlrs(bytes: Uint8Array, header: LasHeader): { vlrs: Vlr[]; complete: boolean } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vlrs: Vlr[] = [];
  let at = header.headerSize;
  for (let k = 0; k < header.vlrCount; k++) {
    if (at + 54 > bytes.length) return { vlrs, complete: false };
    const length = view.getUint16(at + 20, true);
    if (at + 54 + length > bytes.length) return { vlrs, complete: false };
    vlrs.push({ userId: text(bytes.subarray(at + 2, at + 18)), recordId: view.getUint16(at + 18, true), data: bytes.subarray(at + 54, at + 54 + length) });
    at += 54 + length;
  }
  return { vlrs, complete: true };
}

/** EVLR headers (60 bytes each) from a buffer starting at the first one; `data` is filled only when it fits. */
export function readEvlrs(bytes: Uint8Array, count: number): (Vlr & { offset: number; length: number })[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: (Vlr & { offset: number; length: number })[] = [];
  let at = 0;
  for (let k = 0; k < count && at + 60 <= bytes.length; k++) {
    const length = Number(view.getBigUint64(at + 20, true));
    const data = at + 60 + length <= bytes.length ? bytes.subarray(at + 60, at + 60 + length) : new Uint8Array(0);
    out.push({ userId: text(bytes.subarray(at + 2, at + 18)), recordId: view.getUint16(at + 18, true), data, offset: at + 60, length });
    at += 60 + length;
  }
  return out;
}

export function findVlr(vlrs: Vlr[], userId: string, recordId: number): Vlr | undefined {
  return vlrs.find((v) => v.userId === userId && v.recordId === recordId);
}

export interface CopcInfo {
  center: [number, number, number];
  halfsize: number;
  spacing: number;
  rootHierarchyOffset: number;
  rootHierarchySize: number;
}

export function readCopcInfo(vlr: Vlr): CopcInfo {
  const view = new DataView(vlr.data.buffer, vlr.data.byteOffset, vlr.data.byteLength);
  return {
    center: [view.getFloat64(0, true), view.getFloat64(8, true), view.getFloat64(16, true)],
    halfsize: view.getFloat64(24, true),
    spacing: view.getFloat64(32, true),
    rootHierarchyOffset: Number(view.getBigUint64(40, true)),
    rootHierarchySize: Number(view.getBigUint64(48, true)),
  };
}

export interface HierarchyEntry {
  key: [number, number, number, number];
  offset: number;
  byteSize: number;
  /** -1 for an entry pointing at a child hierarchy page. */
  pointCount: number;
}

export function readHierarchyPage(bytes: Uint8Array): HierarchyEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: HierarchyEntry[] = [];
  for (let at = 0; at + 32 <= bytes.length; at += 32) {
    out.push({
      key: [view.getInt32(at, true), view.getInt32(at + 4, true), view.getInt32(at + 8, true), view.getInt32(at + 12, true)],
      offset: Number(view.getBigUint64(at + 16, true)),
      byteSize: view.getInt32(at + 24, true),
      pointCount: view.getInt32(at + 28, true),
    });
  }
  return out;
}

/** What the measurements need from each raw point record. */
export interface RecordFields {
  x: number;
  y: number;
  z: number;
  classification: number;
  returnNumber: number;
  numberOfReturns: number;
  withheld: boolean;
  overlap: boolean;
  gpsTime: number;
}

export function hasGpsTime(format: number): boolean {
  return format === 1 || format === 3 || format === 4 || format === 5 || format >= 6;
}

/** Reads records of one point format; `into` is reused between calls. */
export function recordReader(header: Pick<LasHeader, 'pointFormat' | 'scale' | 'offset'>, records: Uint8Array, size: number) {
  const view = new DataView(records.buffer, records.byteOffset, records.byteLength);
  const format = header.pointFormat;
  const legacy = format < 6;
  const gps = hasGpsTime(format);
  const [sx, sy, sz] = header.scale;
  const [ox, oy, oz] = header.offset;
  return (index: number, into: RecordFields): RecordFields => {
    const at = index * size;
    into.x = view.getInt32(at, true) * sx + ox;
    into.y = view.getInt32(at + 4, true) * sy + oy;
    into.z = view.getInt32(at + 8, true) * sz + oz;
    const returns = records[at + 14];
    if (legacy) {
      into.returnNumber = returns & 7;
      into.numberOfReturns = (returns >> 3) & 7;
      const cls = records[at + 15];
      into.classification = cls & 31;
      into.withheld = (cls & 128) !== 0;
      // Before format 6 overlap points were a class of their own.
      into.overlap = into.classification === 12;
      into.gpsTime = gps ? view.getFloat64(at + 20, true) : 0;
    } else {
      into.returnNumber = returns & 15;
      into.numberOfReturns = returns >> 4;
      const flags = records[at + 15];
      into.withheld = (flags & 4) !== 0;
      into.overlap = (flags & 8) !== 0;
      into.classification = records[at + 16];
      into.gpsTime = view.getFloat64(at + 22, true);
    }
    return into;
  };
}

/** The OGC WKT of a header's CRS record, if it has one. */
export function wktOf(vlrs: Vlr[]): string | null {
  const vlr = findVlr(vlrs, 'LASF_Projection', 2112);
  if (!vlr) return null;
  let wkt = text(vlr.data).trim();
  // LAStools has written it as a JSON string (Estonia's 2024 tiles) and as
  // '' (GUGiK's sheets through las2las). Anything that isn't WKT leaves the
  // GeoKeys to say.
  if (wkt.startsWith('"')) {
    try {
      wkt = String(JSON.parse(wkt)).trim();
    } catch {
      return null;
    }
  }
  return /^[A-Z_]+\s*\[/i.test(wkt) ? wkt : null;
}

/** GeoTIFF keys from the GeoKeyDirectory record: key id to value (tag location 0 only). */
export function geoKeys(vlrs: Vlr[]): Map<number, number> {
  const out = new Map<number, number>();
  const vlr = findVlr(vlrs, 'LASF_Projection', 34735);
  if (!vlr || vlr.data.length < 8) return out;
  const view = new DataView(vlr.data.buffer, vlr.data.byteOffset, vlr.data.byteLength);
  const count = view.getUint16(6, true);
  for (let k = 0; k < count && 8 + 8 * k + 8 <= vlr.data.length; k++) {
    const at = 8 + 8 * k;
    const id = view.getUint16(at, true);
    const location = view.getUint16(at + 2, true);
    const value = view.getUint16(at + 6, true);
    if (location === 0) out.set(id, value);
  }
  return out;
}

/** A LAS classification lookup record (LASF_Spec 0): class code to its label. */
export function classificationLookup(vlrs: Vlr[]): Map<number, string> | null {
  const vlr = findVlr(vlrs, 'LASF_Spec', 0);
  if (!vlr) return null;
  const out = new Map<number, string>();
  for (let at = 0; at + 16 <= vlr.data.length; at += 16) {
    const label = text(vlr.data.subarray(at + 1, at + 16)).trim();
    if (label) out.set(vlr.data[at], label.toLowerCase());
  }
  return out.size ? out : null;
}
