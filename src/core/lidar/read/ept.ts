// Entwine Point Tiles: ept.json, a JSON hierarchy of octree nodes, and one
// LAZ file per node. Ported from the add-on's lidar_ept.py. Nodes are
// additive, so every intersecting ancestor counts as well as the leaves, and
// the walk stops at the depth that gives the spacing the measurements need.

import type { Projection } from '../../geo/projection';
import type { GeoBounds } from '../../types';
import { emptyPoints, type Points } from '../points';
import { crsFromEpsg, crsFromWkt, lonLatTransforms, regionalVerticalFactor, type CrsInfo } from './crs';
import { lazDecoder } from './laz';
import { readHeader } from './las';
import { classTable, normalizeRecords, PointSink, queryBounds, surfaceClassTable, type PointReceiver } from './normalize';
import { ahead, type Fetcher } from './fetcher';

// Recognised by name, since it may come back from a worker as a plain Error.
export class BudgetExceeded extends Error {
  override name = 'BudgetExceeded';
}

export interface EptMetadata {
  bounds: number[];
  span: number;
  dataType: string;
  hierarchyType: string;
  srs?: { authority?: string; horizontal?: string; vertical?: string; wkt?: string };
}

export interface ReadOptions {
  frame: Projection;
  /** Sub-metre sampling is enough: nodes finer than this are skipped. */
  resolutionM?: number;
  maxPoints?: number;
  /** Declared units when the data has none, from the catalog. */
  verticalUnits?: string;
  classification?: Record<string, string>;
  /** Every surface class, for a LiDAR Only model (surfaceClassTable), and no capture years. */
  surface?: boolean;
  /** More class codes for a surface read, on top of the provider's mapping. */
  surfaceCodes?: Record<string, string>;
  /** Where kept returns go. By default they're collected and returned. */
  sink?: PointReceiver;
  progress?: (message: string) => void | Promise<void>;
}

export interface ReadInfo {
  url: string;
  nodes: number;
  points: number;
  horizontalCrs: string;
  zToMetres: number;
}

const UNITS: Record<string, number> = { m: 1, metre: 1, meter: 1, metres: 1, meters: 1, ft: 0.3048, foot: 0.3048, feet: 0.3048, 'us-ft': 1200 / 3937, 'us survey feet': 1200 / 3937 };

function knownMirror(url: string): boolean {
  try {
    const u = new URL(url);
    return ((u.host === 's3-us-west-2.amazonaws.com' || u.host === 's3.us-west-2.amazonaws.com') && u.pathname.startsWith('/usgs-lidar-public/')) || u.host === 'usgs-lidar-public.s3.amazonaws.com';
  } catch {
    return false;
  }
}

/**
 * The cloud's grid and Z unit. The USGS mirror is Web Mercator with metre Z
 * and declares no vertical CRS; elsewhere an undeclared Z unit is accepted
 * only where no foot-based height system exists.
 */
export function eptCoordinates(meta: EptMetadata, url: string, verticalUnits?: string): { crs: CrsInfo; zFactor: number; mirror: boolean } {
  if (meta.dataType !== 'laszip' || meta.hierarchyType !== 'json') throw new Error('Only laszip EPT with a JSON hierarchy is supported');
  const srs = meta.srs ?? {};
  const crs = srs.wkt ? crsFromWkt(srs.wkt) : srs.horizontal ? crsFromEpsg(Number(srs.horizontal)) : null;
  if (!crs) throw new Error('EPT lacks a horizontal coordinate system');
  const mirror = knownMirror(url);
  let zFactor: number | null = null;
  if (srs.vertical) zFactor = ({ 5703: 1, 5701: 1, 6360: 1200 / 3937, 8228: 0.3048 } as Record<string, number>)[srs.vertical] ?? null;
  if (zFactor === null && verticalUnits) zFactor = UNITS[verticalUnits.toLowerCase()] ?? null;
  if (zFactor === null && meta.bounds?.length === 6) {
    const { toLonLat } = lonLatTransforms(crs);
    const [w, s] = toLonLat(meta.bounds[0], meta.bounds[1]);
    const [e, n] = toLonLat(meta.bounds[3], meta.bounds[4]);
    zFactor = regionalVerticalFactor([Math.min(w, e), Math.min(s, n), Math.max(w, e), Math.max(s, n)]);
  }
  if (zFactor === null) {
    if (!mirror || crs.epsg !== 3857) throw new Error('Unknown LiDAR vertical units; a vertical CRS or declared units are needed');
    zFactor = 1;
  }
  return { crs, zFactor, mirror };
}

function intersects(key: string, root: number[], query: [number, number, number, number]): boolean {
  const [depth, ix, iy] = key.split('-').map(Number);
  for (const [axis, index] of [
    [0, ix],
    [1, iy],
  ]) {
    const width = (root[axis + 3] - root[axis]) / 2 ** depth;
    const low = root[axis] + index * width;
    if (low > query[axis + 2] || low + width < query[axis]) return false;
  }
  return true;
}

/** Nodes intersecting the query down to `maxDepth`, in (depth, x, y, z) order. */
export async function collectNodes(fetcher: Fetcher, base: string, meta: EptMetadata, query: [number, number, number, number], maxDepth: number, maxNodes = 4096, maxPoints = 40e6): Promise<string[]> {
  const pending = ['0-0-0-0'];
  const visited = new Set<string>();
  const nodes = new Map<string, number>();
  let total = 0;
  while (pending.length) {
    const key = pending.pop()!;
    if (visited.has(key)) continue;
    visited.add(key);
    if (visited.size > maxNodes) throw new BudgetExceeded('LiDAR hierarchy budget reached');
    const hierarchy = (await fetcher.json(`${base}ept-hierarchy/${key}.json`)) as Record<string, number>;
    for (const [node, count] of Object.entries(hierarchy)) {
      if (Number(node.split('-')[0]) > maxDepth || !intersects(node, meta.bounds, query)) continue;
      if (count === -1) pending.push(node);
      else if (Number.isInteger(count) && count > 0 && !nodes.has(node)) {
        nodes.set(node, count);
        total += count;
      }
    }
    if (nodes.size > maxNodes || total > maxPoints) throw new BudgetExceeded('LiDAR tile or point budget reached');
  }
  const order = (key: string) => key.split('-').map(Number);
  return [...nodes.keys()].sort((a, b) => {
    const [p, q] = [order(a), order(b)];
    return p[0] - q[0] || p[1] - q[1] || p[2] - q[2] || p[3] - q[3];
  });
}

/** Cropped, normalized returns inside `bbox`. */
export async function readEpt(fetcher: Fetcher, url: string, bbox: GeoBounds, options: ReadOptions): Promise<{ points: Points; info: ReadInfo }> {
  const decoder = await lazDecoder();
  const meta = (await fetcher.json(url)) as EptMetadata;
  const { crs, zFactor, mirror } = eptCoordinates(meta, url, options.verticalUnits);
  const { toLonLat, fromLonLat } = lonLatTransforms(crs);
  const query = queryBounds(bbox, fromLonLat);
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  // Web Mercator stretches distance by sec(latitude); keep every ancestor down
  // to the first depth at least as fine as the resolution asked for.
  let maxDepth = 32;
  const resolution = options.resolutionM ?? 0.35;
  if (crs.epsg === 3857 && resolution > 0) {
    const cloudResolution = resolution / Math.cos((((bbox.south + bbox.north) / 2) * Math.PI) / 180);
    const rootSpacing = (meta.bounds[3] - meta.bounds[0]) / meta.span;
    maxDepth = Math.max(0, Math.ceil(Math.log2(rootSpacing / cloudResolution)));
  }
  await options.progress?.('Reading the EPT hierarchy');
  const nodes = await collectNodes(fetcher, base, meta, query, maxDepth);
  const classes = options.surface ? surfaceClassTable(options.classification, options.surfaceCodes) : classTable(options.classification);
  const sink = options.sink ?? new PointSink();
  const maxPoints = options.maxPoints ?? 8e6;
  // A dozen downloads run ahead while earlier nodes decode, so memory holds
  // a few nodes rather than the whole batch.
  let i = 0;
  for await (const body of ahead(nodes, 12, (key) => fetcher.bytes(`${base}ept-data/${key}.laz`))) {
    await options.progress?.(`Decoding EPT node ${i + 1} of ${nodes.length}; ${sink.count.toLocaleString('en-US')} points kept`);
    const bytes = new Uint8Array(body);
    const header = readHeader(bytes);
    if (header.pointCount > 2e6) throw new BudgetExceeded('Unexpectedly large LiDAR node');
    let decoded: { records: Uint8Array; pointCount: number; pointSize: number };
    try {
      decoded = decoder.decodeFile(bytes);
    } catch (error) {
      throw new Error(`Unreadable LiDAR node ${nodes[i]}: ${(error as Error).message}`);
    }
    normalizeRecords(decoded.records, decoded.pointCount, decoded.pointSize, { header, query, bbox, toLonLat, frame: options.frame, zFactor, classes, knownEpt: mirror, years: !options.surface }, sink);
    if (sink.count > maxPoints) throw new BudgetExceeded('Cropped LiDAR point budget reached');
    i++;
  }
  const points = sink instanceof PointSink ? sink.finish() : emptyPoints();
  return { points, info: { url, nodes: nodes.length, points: sink.count, horizontalCrs: crs.key, zToMetres: zFactor } };
}
