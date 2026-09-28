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

/** A growable set of normalized points. */
export class PointSink {
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
  classes: Uint8Array;
  /** The USGS EPT mirror drops the GPS encoding bit; see gpsCaptureYears. */
  knownEpt?: boolean;
}

/** Append the kept records of one decoded node or chunk; returns how many were kept. */
export function normalizeRecords(records: Uint8Array, count: number, size: number, options: NormalizeOptions, sink: PointSink): number {
  const read = recordReader(options.header, records, size);
  const f: RecordFields = { x: 0, y: 0, z: 0, classification: 0, returnNumber: 0, numberOfReturns: 0, withheld: false, overlap: false, gpsTime: 0 };
  const [qx0, qy0, qx1, qy1] = options.query;
  const { west, south, east, north } = options.bbox;
  const keep: number[] = [];
  const gps: number[] = [];
  const lonlat: number[] = [];
  for (let i = 0; i < count; i++) {
    read(i, f);
    if (!(f.x >= qx0 && f.x <= qx1 && f.y >= qy0 && f.y <= qy1)) continue;
    const cls = options.classes[f.classification];
    if (!cls || f.withheld || f.overlap || !Number.isFinite(f.z)) continue;
    const [lon, lat] = options.toLonLat(f.x, f.y);
    if (!(lon >= west && lon <= east && lat >= south && lat <= north)) continue;
    keep.push(i, cls, f.numberOfReturns === 1 ? 1 : 0);
    gps.push(f.gpsTime);
    lonlat.push(lon, lat, f.z * options.zFactor);
  }
  const adjusted = (options.header.globalEncoding & 1) === 1;
  const { years, basis } = gpsCaptureYears(gps, adjusted, options.knownEpt ?? false);
  const confidence = basis === 'gps_declared' ? 1 : 0.5;
  for (let k = 0; k < gps.length; k++) {
    const [x, y] = options.frame.toLocal(lonlat[3 * k], lonlat[3 * k + 1]);
    sink.push(x, y, lonlat[3 * k + 2], keep[3 * k + 1], keep[3 * k + 2], years[k], years[k] ? confidence : 0);
  }
  return gps.length;
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
