// A zipped shapefile tile index for provider tests.

import { zipSync } from 'fflate';

/** A shapefile of rectangles and a dBase table beside it, zipped as a published index. */
export function zippedShapefile(boxes: [number, number, number, number][], columns: [string, number][], rows: (string | number)[][], prj?: string): Uint8Array {
  const recordSize = 8 + 44 + 4 + 5 * 16;
  const shp = new Uint8Array(100 + boxes.length * recordSize);
  const sv = new DataView(shp.buffer);
  sv.setInt32(0, 9994, false);
  sv.setInt32(24, shp.length / 2, false);
  sv.setInt32(28, 1000, true);
  sv.setInt32(32, 5, true);
  [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))].forEach((v, k) => sv.setFloat64(36 + 8 * k, v, true));
  boxes.forEach(([w, s, e, n], i) => {
    const at = 100 + i * recordSize;
    sv.setInt32(at, i + 1, false);
    sv.setInt32(at + 4, (recordSize - 8) / 2, false);
    const c = at + 8;
    sv.setInt32(c, 5, true);
    [w, s, e, n].forEach((v, k) => sv.setFloat64(c + 4 + 8 * k, v, true));
    sv.setInt32(c + 36, 1, true);
    sv.setInt32(c + 40, 5, true);
    [[w, s], [w, n], [e, n], [e, s], [w, s]].forEach(([x, y], k) => {
      sv.setFloat64(c + 48 + 16 * k, x, true);
      sv.setFloat64(c + 56 + 16 * k, y, true);
    });
  });
  const headerSize = 32 + 32 * columns.length + 1;
  const rowSize = 1 + columns.reduce((s, c) => s + c[1], 0);
  const dbf = new Uint8Array(headerSize + rows.length * rowSize + 1);
  const dv = new DataView(dbf.buffer);
  dbf[0] = 3;
  dv.setUint32(4, rows.length, true);
  dv.setUint16(8, headerSize, true);
  dv.setUint16(10, rowSize, true);
  columns.forEach(([name, width], i) => {
    name.split('').forEach((c, k) => (dbf[32 + 32 * i + k] = c.charCodeAt(0)));
    dbf[32 + 32 * i + 11] = 'C'.charCodeAt(0);
    dbf[32 + 32 * i + 16] = width;
  });
  dbf[headerSize - 1] = 0x0d;
  rows.forEach((row, r) => {
    let at = headerSize + r * rowSize;
    dbf.fill(0x20, at, at + rowSize);
    at++;
    row.forEach((value, i) => {
      String(value).split('').forEach((c, k) => (dbf[at + k] = c.charCodeAt(0)));
      at += columns[i][1];
    });
  });
  return zipSync({ 'index.shp': shp, 'index.dbf': dbf, ...(prj ? { 'index.prj': new TextEncoder().encode(prj) } : {}) });
}
