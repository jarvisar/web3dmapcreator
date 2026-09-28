// Binary STL: an 80-byte header, a little-endian uint32 triangle count and 50
// bytes per triangle (normal and three vertices as float32, then a zero
// uint16). Files share one frame: XY centred on their plate's bounds and the
// lowest point of the whole export at z = 0, so a slicer that loads a
// section's files together as one multipart object keeps them aligned.

import { COLOUR_GROUPS, type Palette } from '../settings';
import type { ColourGroup, MeshPart, Plate } from '../types';
import { FilamentTable, checkPart, emptyExtents, mergeExtents, partGroup, preparePlates, triangleCount } from './common';
import { asciiBytes } from './format';
import { ZipWriter, type ZipEntry } from './zip';

export const STL_HEADER = 'Jarvizar City Model - (c) OpenStreetMap contributors, Overture Maps Foundation';
const RECORD = 50;
const MAX_TRIANGLES = 0xffffffff;
// Records per chunk streamed into a ZIP entry, about 1 MB.
const CHUNK_RECORDS = 20000;

/** The 80-byte header: ASCII, NUL padded, never starting with "solid". */
export function stlHeader(text = STL_HEADER): Uint8Array {
  if (/^solid/i.test(text)) throw new Error('A binary STL header must not start with "solid"');
  const bytes = asciiBytes(text);
  if (bytes.length > 80) throw new Error('An STL header holds at most 80 bytes');
  const out = new Uint8Array(80);
  out.set(bytes);
  return out;
}

type Offset = [number, number, number];

// Writes triangles [first, last) of a part as records from byte `at`.
function fillRecords(view: DataView, at: number, part: MeshPart, first: number, last: number, [dx, dy, dz]: Offset): void {
  const p = part.positions;
  const idx = part.indices;
  for (let t = first; t < last; t++, at += RECORD) {
    const a = idx[3 * t] * 3;
    const b = idx[3 * t + 1] * 3;
    const c = idx[3 * t + 2] * 3;
    const ax = p[a] + dx, ay = p[a + 1] + dy, az = p[a + 2] + dz;
    const bx = p[b] + dx, by = p[b + 1] + dy, bz = p[b + 2] + dz;
    const cx = p[c] + dx, cy = p[c + 1] + dy, cz = p[c + 2] + dz;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    // Zero-area triangles get a zero normal. Slicers recompute it.
    if (length > 0) {
      nx /= length;
      ny /= length;
      nz /= length;
    } else {
      nx = ny = nz = 0;
    }
    view.setFloat32(at, nx, true);
    view.setFloat32(at + 4, ny, true);
    view.setFloat32(at + 8, nz, true);
    view.setFloat32(at + 12, ax, true);
    view.setFloat32(at + 16, ay, true);
    view.setFloat32(at + 20, az, true);
    view.setFloat32(at + 24, bx, true);
    view.setFloat32(at + 28, by, true);
    view.setFloat32(at + 32, bz, true);
    view.setFloat32(at + 36, cx, true);
    view.setFloat32(at + 40, cy, true);
    view.setFloat32(at + 44, cz, true);
    view.setUint16(at + 48, 0, true);
  }
}

function checkCount(total: number): void {
  if (total > MAX_TRIANGLES) throw new Error('A binary STL holds at most 4,294,967,295 triangles');
}

function plateOffset(bounds: [number, number, number, number], bottom: number): Offset {
  const [west, south, east, north] = bounds;
  return [-(west + east) / 2, -(south + north) / 2, -bottom];
}

/** Every part of one plate in one file: XY centred on the plate bounds, lowest point at z = 0. */
export function writeStl(plate: Plate): Uint8Array {
  if (!plate.parts.length) throw new Error(`${plate.name}: a plate needs at least one part`);
  const extents = emptyExtents();
  for (const part of plate.parts) mergeExtents(extents, checkPart(part));
  const total = plate.parts.reduce((sum, part) => sum + triangleCount(part), 0);
  checkCount(total);
  const out = new Uint8Array(84 + RECORD * total);
  out.set(stlHeader());
  const view = new DataView(out.buffer);
  view.setUint32(80, total, true);
  const offset = plateOffset(plate.bounds, extents.minZ);
  let at = 84;
  for (const part of plate.parts) {
    const n = triangleCount(part);
    fillRecords(view, at, part, 0, n, offset);
    at += n * RECORD;
  }
  return out;
}

function streamFile(entry: ZipEntry, parts: MeshPart[], offset: Offset, scratch: Uint8Array): void {
  const total = parts.reduce((sum, part) => sum + triangleCount(part), 0);
  checkCount(total);
  const head = new Uint8Array(84);
  head.set(stlHeader());
  new DataView(head.buffer).setUint32(80, total, true);
  entry.bytes(head);
  const view = new DataView(scratch.buffer, scratch.byteOffset, scratch.byteLength);
  const capacity = Math.floor(scratch.length / RECORD);
  let used = 0;
  for (const part of parts) {
    const n = triangleCount(part);
    for (let t = 0; t < n; ) {
      const take = Math.min(n - t, capacity - used);
      fillRecords(view, used * RECORD, part, t, t + take, offset);
      used += take;
      t += take;
      if (used === capacity) {
        entry.bytes(scratch.subarray(0, used * RECORD));
        used = 0;
      }
    }
  }
  if (used) entry.bytes(scratch.subarray(0, used * RECORD));
  entry.close();
}

/** "R1C1" from a section named "Section R1 C1", else the plate's number. */
export function sectionTag(name: string, index: number): string {
  const match = /R(\d+)\s*C(\d+)/.exec(name);
  return match ? `R${match[1]}C${match[2]}` : `P${index + 1}`;
}

/** A safe file-name fragment: no path separators or characters Windows refuses. */
export function fileStem(base: string): string {
  const stem = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim().replace(/^\.+/, '');
  return stem || 'city-model';
}

export interface StlZipOptions {
  /** One file per plate instead of one per colour. */
  combined?: boolean;
}

/**
 * STL files of every plate, zipped. Per colour they are named
 * `<base>[_R1C1]_<n>_<label>_<RRGGBB>.stl`: n numbers the colours in order of
 * first use across all plates, so a colour keeps its number in every
 * section, and the label names the colour groups printed in it.
 * Combined, each plate is one `<base>[_R1C1].stl`.
 */
export function writeStlZip(plates: Plate[], palette: Palette, base: string, options: StlZipOptions = {}): Uint8Array {
  const model = preparePlates(plates, palette);
  const bottom = model.extents.minZ;
  const stem = fileStem(base);
  const filaments = new FilamentTable();
  const groups = new Map<number, Set<ColourGroup>>();
  const slots = model.plates.map((plate) =>
    plate.parts.map((p) => {
      const slot = filaments.slot(p.colour);
      if (!groups.has(slot)) groups.set(slot, new Set());
      groups.get(slot)!.add(partGroup(p.part));
      return slot;
    }),
  );
  const digits = String(filaments.filaments.length).length;
  const labels = new Map<number, string>();
  for (const [slot, used] of groups) {
    labels.set(slot, COLOUR_GROUPS.filter((g) => used.has(g.key)).map((g) => g.label.replace(/\s+/g, '-')).join('+'));
  }
  const tags = model.plates.length > 1 ? uniqueTags(model.plates.map((p, i) => sectionTag(p.name, i))) : null;

  const zip = new ZipWriter();
  const scratch = new Uint8Array(CHUNK_RECORDS * RECORD);
  model.plates.forEach((plate, i) => {
    const name = tags ? `${stem}_${tags[i]}` : stem;
    const offset = plateOffset(plate.bounds, bottom);
    const parts = plate.parts.map((p) => p.part);
    if (options.combined) {
      streamFile(zip.entry(`${name}.stl`), parts, offset, scratch);
      return;
    }
    for (const slot of [...new Set(slots[i])].sort((a, b) => a - b)) {
      const { hex } = filaments.filaments[slot - 1];
      const file = `${name}_${String(slot).padStart(digits, '0')}_${labels.get(slot)}_${hex.slice(1)}.stl`;
      streamFile(zip.entry(file), parts.filter((_, k) => slots[i][k] === slot), offset, scratch);
    }
  });
  return zip.finish();
}

function uniqueTags(tags: string[]): string[] {
  const seen = new Set<string>();
  return tags.map((tag, i) => {
    const unique = seen.has(tag) ? `${tag}-${i + 1}` : tag;
    seen.add(unique);
    return unique;
  });
}
