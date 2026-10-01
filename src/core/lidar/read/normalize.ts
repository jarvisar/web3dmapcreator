// Turning decoded point records into the normalized columns every reader
// produces: cropped to the query, classes mapped to ASPRS meaning, Z in
// metres, and capture years from GPS time. Ported from the add-on's
// lidar_normalize.py and the readers' normalized_chunk.

import type { Projection } from '../../geo/projection';
import type { GeoBounds } from '../../types';
import { emptyPoints, type Points } from '../points';
import { gpsCaptureYears } from '../selection';
import type { Transform } from './crs';
import { recordReader, type LasHeader, type RecordFields } from './las';

const SEMANTICS: Record<string, number> = {
  ground: 2,
  building: 6,
  buildings: 6,
  unclassified: 1,
  unassigned: 1,
  'low vegetation': 3,
  'medium vegetation': 4,
  'high vegetation': 5,
  vegetation: 5,
};

/**
 * Class codes to keep and what they mean. Ground, building and unclassified
 * returns establish every measurement; vegetation classes are kept too,
 * because classifiers file much of a glazed facade under them, and the
 * envelope only admits them where the roof already reaches. Noise and
 * withheld returns never are. A declared mapping (a catalog's, or a LAS
 * classification lookup record) replaces the ASPRS meaning; codes it does
 * not name are dropped.
 */
export function classTable(mapping: Record<string, string> | Map<number, string> | null | undefined): Uint8Array {
  const table = new Uint8Array(256);
  if (mapping) {
    const entries = mapping instanceof Map ? [...mapping].map(([k, v]) => [String(k), v] as [string, string]) : Object.entries(mapping);
    for (const [code, label] of entries) {
      const target = SEMANTICS[label.trim().toLowerCase()];
      const n = Number(code);
      if (target !== undefined && n >= 0 && n < 256) table[n] = target;
    }
    return table;
  }
  for (let c = 1; c <= 6; c++) table[c] = c;
  return table;
}

// A LiDAR Only model keeps every surface seen from above. Noise (7, 18),
// overlap (12), wires and towers (13-16) and anything without an ASPRS
// meaning are left out. Never classified (0) is kept as unclassified: whole
// surveys are delivered that way.
const SURFACE_CLASSES = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 17, 19, 20, 21];
const SURFACE_SEMANTICS: Record<string, number> = { ...SEMANTICS, water: 9, bridge: 17, 'bridge deck': 17 };
// Codes a mapping written for buildings leaves out but that mean the same in
// every ASPRS-numbered survey.
const SURFACE_STANDARD = [9, 17];

/**
 * Class codes for a LiDAR Only model, from the same mappings as classTable.
 * A mapping only names ground, buildings and vegetation, so water and
 * bridges keep their standard codes and whatever else it leaves out (IGN's
 * artefacts and synthetic points) is dropped. `extra` names more codes,
 * kept apart from the provider mappings since those shape building
 * measurement too.
 */
export function surfaceClassTable(mapping: Record<string, string> | Map<number, string> | null | undefined, extra: Record<string, string> = {}): Uint8Array {
  const table = new Uint8Array(256);
  const entries = mapping ? (mapping instanceof Map ? [...mapping].map(([k, v]) => [String(k), v] as [string, string]) : Object.entries(mapping)) : null;
  if (entries) for (const code of SURFACE_STANDARD) table[code] = code;
  else {
    table[0] = 1;
    for (const code of SURFACE_CLASSES) table[code] = code;
  }
  for (const [code, label] of [...(entries ?? []), ...Object.entries(extra)]) {
    const target = SURFACE_SEMANTICS[label.trim().toLowerCase()];
    const n = Number(code);
    if (n >= 0 && n < 256) table[n] = target ?? 0;
  }
  return table;
}

/** Where normalized points go: kept (PointSink) or counted into a grid as they come. */
export interface PointReceiver {
  count: number;
  push(x: number, y: number, z: number, cls: number, single: number, year: number, confidence: number): void;
}

/** A growable set of normalized points. */
export class PointSink implements PointReceiver {
  points: Points = emptyPoints(1024);
  count = 0;

  private grow(extra: number) {
    if (this.count + extra <= this.points.x.length) return;
    let size = this.points.x.length;
    while (size < this.count + extra) size *= 2;
    const next = emptyPoints(size);
    for (const key of ['x', 'y', 'z', 'cls', 'single', 'year', 'confidence'] as const) {
      (next[key] as Float64Array).set((this.points[key] as Float64Array).subarray(0, this.count));
    }
    this.points = next;
  }

  push(x: number, y: number, z: number, cls: number, single: number, year: number, confidence: number): void {
    this.grow(1);
    const p = this.points;
    const i = this.count++;
    p.x[i] = x;
    p.y[i] = y;
    p.z[i] = z;
    p.cls[i] = cls;
    p.single[i] = single;
    p.year[i] = year;
    p.confidence[i] = confidence;
  }

  finish(): Points {
    const out = emptyPoints(this.count);
    for (const key of ['x', 'y', 'z', 'cls', 'single', 'year', 'confidence'] as const) {
      (out[key] as Float64Array).set((this.points[key] as Float64Array).subarray(0, this.count));
    }
    return out;
  }
}

export interface NormalizeOptions {
  header: Pick<LasHeader, 'pointFormat' | 'scale' | 'offset' | 'globalEncoding'>;
  /** Query box in the cloud's own grid. */
  query: [number, number, number, number];
  bbox: GeoBounds;
  toLonLat: Transform;
  frame: Projection;
  zFactor: number;
  /** Metres added after zFactor, where a copy moved the heights to another datum. */
  zOffset?: number;
  classes: Uint8Array;
  /** The USGS EPT mirror drops the GPS encoding bit; see gpsCaptureYears. */
  knownEpt?: boolean;
  /** False skips capture years, which cost a date per point. */
  years?: boolean;
}

// Returns of the chunk being normalized, reused from chunk to chunk.
let held = { classes: new Uint8Array(0), single: new Uint8Array(0), gps: new Float64Array(0), lonlat: new Float64Array(0) };

/** Append the kept records of one decoded node or chunk; returns how many were kept. */
export function normalizeRecords(records: Uint8Array, count: number, size: number, options: NormalizeOptions, sink: PointReceiver): number {
  const read = recordReader(options.header, records, size);
  const f: RecordFields = { x: 0, y: 0, z: 0, classification: 0, returnNumber: 0, numberOfReturns: 0, withheld: false, overlap: false, gpsTime: 0 };
  const [qx0, qy0, qx1, qy1] = options.query;
  const { west, south, east, north } = options.bbox;
  const zOffset = options.zOffset ?? 0;
  if (options.years === false) {
    let kept = 0;
    for (let i = 0; i < count; i++) {
      read(i, f);
      if (!(f.x >= qx0 && f.x <= qx1 && f.y >= qy0 && f.y <= qy1)) continue;
      const cls = options.classes[f.classification];
      if (!cls || f.withheld || f.overlap || !Number.isFinite(f.z)) continue;
      const [lon, lat] = options.toLonLat(f.x, f.y);
      if (!(lon >= west && lon <= east && lat >= south && lat <= north)) continue;
      const [x, y] = options.frame.toLocal(lon, lat);
      sink.push(x, y, f.z * options.zFactor + zOffset, cls, f.numberOfReturns === 1 ? 1 : 0, 0, 0);
      kept++;
    }
    return kept;
  }
  // Years are decided for the chunk as a whole, so the kept returns wait here.
  if (held.gps.length < count) held = { classes: new Uint8Array(count), single: new Uint8Array(count), gps: new Float64Array(count), lonlat: new Float64Array(3 * count) };
  const { classes, single, gps, lonlat } = held;
  let kept = 0;
  for (let i = 0; i < count; i++) {
    read(i, f);
    if (!(f.x >= qx0 && f.x <= qx1 && f.y >= qy0 && f.y <= qy1)) continue;
    const cls = options.classes[f.classification];
    if (!cls || f.withheld || f.overlap || !Number.isFinite(f.z)) continue;
    const [lon, lat] = options.toLonLat(f.x, f.y);
    if (!(lon >= west && lon <= east && lat >= south && lat <= north)) continue;
    classes[kept] = cls;
    single[kept] = f.numberOfReturns === 1 ? 1 : 0;
    gps[kept] = f.gpsTime;
    lonlat[3 * kept] = lon;
    lonlat[3 * kept + 1] = lat;
    lonlat[3 * kept + 2] = f.z * options.zFactor + zOffset;
    kept++;
  }
  const adjusted = (options.header.globalEncoding & 1) === 1;
  const { years, basis } = gpsCaptureYears(gps.subarray(0, kept), adjusted, options.knownEpt ?? false);
  const confidence = basis === 'gps_declared' ? 1 : 0.5;
  for (let k = 0; k < kept; k++) {
    const [x, y] = options.frame.toLocal(lonlat[3 * k], lonlat[3 * k + 1]);
    sink.push(x, y, lonlat[3 * k + 2], classes[k], single[k], years[k], years[k] ? confidence : 0);
  }
  return kept;
}

/** Bounds of a lon/lat box in a cloud's grid, densified along each edge. */
export function queryBounds(bbox: GeoBounds, fromLonLat: Transform): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const steps = 21;
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    for (const [lon, lat] of [
      [bbox.west + t * (bbox.east - bbox.west), bbox.south],
      [bbox.west + t * (bbox.east - bbox.west), bbox.north],
      [bbox.west, bbox.south + t * (bbox.north - bbox.south)],
      [bbox.east, bbox.south + t * (bbox.north - bbox.south)],
    ]) {
      const [x, y] = fromLonLat(lon, lat);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  return [x0, y0, x1, y1];
}
