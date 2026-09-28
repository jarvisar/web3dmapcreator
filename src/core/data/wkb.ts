// Well-known binary to GeoJSON. Handles ISO and EWKB flags and either byte
// order, and keeps only X and Y.

import type { Geometry, Position } from './features';

interface Reader {
  view: DataView;
  offset: number;
}

interface Header {
  little: boolean;
  type: number;
  dims: number;
}

export function parseWkb(bytes: Uint8Array): Geometry {
  const reader = { view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset: 0 };
  const geometry = readGeometry(reader);
  if (reader.offset !== bytes.byteLength) throw new Error('WKB has trailing bytes');
  return geometry;
}

function readHeader(reader: Reader): Header {
  const { view } = reader;
  const little = view.getUint8(reader.offset) === 1;
  let code = view.getUint32(reader.offset + 1, little);
  reader.offset += 5;
  let dims = 2;
  // EWKB keeps Z, M and SRID in the high bits.
  if (code & 0x80000000) dims++;
  if (code & 0x40000000) dims++;
  if (code & 0x20000000) reader.offset += 4;
  code &= 0x0fffffff;
  // ISO adds 1000 for Z, 2000 for M and 3000 for ZM.
  const iso = Math.floor(code / 1000);
  if (iso === 1 || iso === 2) dims++;
  else if (iso === 3) dims += 2;
  return { little, type: code % 1000, dims };
}

function readCount(reader: Reader, header: Header, minBytes: number): number {
  const count = reader.view.getUint32(reader.offset, header.little);
  reader.offset += 4;
  // A corrupt count would otherwise allocate a huge array before failing.
  if (count * minBytes > reader.view.byteLength - reader.offset) throw new Error('WKB count exceeds its data');
  return count;
}

function readPoints(reader: Reader, header: Header, count: number): Position[] {
  const { view } = reader;
  const { little, dims } = header;
  const stride = dims * 8;
  const points: Position[] = new Array(count);
  let offset = reader.offset;
  if (offset + count * stride > view.byteLength) throw new Error('WKB is truncated');
  for (let i = 0; i < count; i++) {
    points[i] = [view.getFloat64(offset, little), view.getFloat64(offset + 8, little)];
    offset += stride;
  }
  reader.offset = offset;
  return points;
}

function readRings(reader: Reader, header: Header): Position[][] {
  const rings = new Array<Position[]>(readCount(reader, header, 4));
  for (let r = 0; r < rings.length; r++) {
    rings[r] = readPoints(reader, header, readCount(reader, header, header.dims * 8));
  }
  return rings;
}

function readGeometry(reader: Reader): Geometry {
  const header = readHeader(reader);
  switch (header.type) {
    case 1:
      return { type: 'Point', coordinates: readPoints(reader, header, 1)[0] };
    case 2:
      return { type: 'LineString', coordinates: readPoints(reader, header, readCount(reader, header, header.dims * 8)) };
    case 3:
      return { type: 'Polygon', coordinates: readRings(reader, header) };
    case 4:
    case 5:
    case 6:
    case 7: {
      // Members of a multi geometry are complete WKB geometries of their own.
      const count = readCount(reader, header, 9);
      const members: Geometry[] = new Array(count);
      for (let i = 0; i < count; i++) members[i] = readGeometry(reader);
      if (header.type === 7) return { type: 'GeometryCollection', geometries: members };
      const expected = header.type === 4 ? 'Point' : header.type === 5 ? 'LineString' : 'Polygon';
      for (const member of members) {
        if (member.type !== expected) throw new Error(`WKB multi geometry holds a ${member.type}`);
      }
      if (header.type === 4) {
        return { type: 'MultiPoint', coordinates: members.map((m) => (m as { coordinates: Position }).coordinates) };
      }
      if (header.type === 5) {
        return { type: 'MultiLineString', coordinates: members.map((m) => (m as { coordinates: Position[] }).coordinates) };
      }
      return { type: 'MultiPolygon', coordinates: members.map((m) => (m as { coordinates: Position[][] }).coordinates) };
    }
    default:
      throw new Error(`Unsupported WKB geometry type ${header.type}`);
  }
}
