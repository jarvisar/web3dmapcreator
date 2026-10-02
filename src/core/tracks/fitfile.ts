// Garmin's FIT format, as watches, bike computers and Strava's bulk export
// write activities and courses. Only the positions of record messages are
// read. A record without a position (lost signal, indoors) breaks the line,
// and the pieces are joined again like a GPX track's segments.

import type { LonLat } from '../types';

export class FitError extends Error {}

const RECORD = 20;
const COURSE = 31;
const LAT = 0;
const LON = 1;
const COURSE_NAME = 5;
const INVALID_SINT32 = 0x7fffffff;
const SEMICIRCLES = 180 / 2 ** 31;

interface Field {
  num: number;
  size: number;
}

interface Definition {
  global: number;
  little: boolean;
  fields: Field[];
  /** Developer fields, only skipped. */
  extra: number;
  size: number;
}

export function isFit(data: ArrayBuffer): boolean {
  if (data.byteLength < 12) return false;
  const bytes = new Uint8Array(data, 0, 12);
  return (bytes[0] === 12 || bytes[0] === 14) && String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === '.FIT';
}

/** Every stretch of positions in the file, and a course's name if it has one. */
export function readFit(data: ArrayBuffer): { lines: LonLat[][]; name: string } {
  const view = new DataView(data);
  const lines: LonLat[][] = [];
  let line: LonLat[] = [];
  let name = '';
  const breakLine = () => {
    if (line.length) lines.push(line);
    line = [];
  };
  let at = 0;
  // A file can hold several FIT files one after another.
  while (at + 12 <= data.byteLength) {
    const headerSize = view.getUint8(at);
    if ((headerSize !== 12 && headerSize !== 14) || String.fromCharCode(...new Uint8Array(data, at + 8, 4)) !== '.FIT') {
      if (at === 0) throw new FitError("This FIT file couldn't be read.");
      break;
    }
    const end = Math.min(data.byteLength, at + headerSize + view.getUint32(at + 4, true));
    at += headerSize;
    const definitions = new Map<number, Definition>();
    while (at < end) {
      const header = view.getUint8(at++);
      let local: number;
      if (header & 0x80) {
        // A compressed timestamp header is always a data message.
        local = (header >> 5) & 0x03;
      } else if (header & 0x40) {
        if (at + 5 > end) break;
        const little = view.getUint8(at + 1) === 0;
        const global = view.getUint16(at + 2, little);
        const count = view.getUint8(at + 4);
        at += 5;
        const fields: Field[] = [];
        let size = 0;
        for (let i = 0; i < count && at + 3 <= end; i++, at += 3) {
          const field = { num: view.getUint8(at), size: view.getUint8(at + 1) };
          fields.push(field);
          size += field.size;
        }
        let extra = 0;
        if (header & 0x20 && at < end) {
          const devCount = view.getUint8(at++);
          for (let i = 0; i < devCount && at + 3 <= end; i++, at += 3) extra += view.getUint8(at + 1);
        }
        definitions.set(header & 0x0f, { global, little, fields, extra, size: size + extra });
        continue;
      } else {
        local = header & 0x0f;
      }
      const definition = definitions.get(local);
      // Data with no definition before it: the file is damaged from here on.
      if (!definition || at + definition.size > end) break;
      if (definition.global === RECORD) {
        let lat = INVALID_SINT32;
        let lon = INVALID_SINT32;
        let offset = at;
        for (const field of definition.fields) {
          if (field.size === 4 && (field.num === LAT || field.num === LON)) {
            const value = view.getInt32(offset, definition.little);
            if (field.num === LAT) lat = value;
            else lon = value;
          }
          offset += field.size;
        }
        if (lat === INVALID_SINT32 || lon === INVALID_SINT32) breakLine();
        else line.push([lon * SEMICIRCLES, lat * SEMICIRCLES]);
      } else if (definition.global === COURSE && !name) {
        let offset = at;
        for (const field of definition.fields) {
          if (field.num === COURSE_NAME) {
            const bytes = new Uint8Array(data, offset, field.size);
            const stop = bytes.indexOf(0);
            name = new TextDecoder().decode(stop < 0 ? bytes : bytes.subarray(0, stop)).trim();
          }
          offset += field.size;
        }
      }
      at += definition.size;
    }
    breakLine();
    // The file's CRC.
    at = end + 2;
  }
  return { lines, name };
}
