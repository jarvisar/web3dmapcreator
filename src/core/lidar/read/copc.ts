// Cloud Optimized Point Clouds through HTTP range reads, ported from the
// add-on's lidar_copc.py (which used laspy's CopcReader). One read of the
// file's start gives the header, the COPC info record and the CRS; hierarchy
// pages are read only where they intersect the query; each node is one
// standalone LAZ chunk. A server ignoring Range is an error, never a whole
// download.

import type { GeoBounds } from '../../types';
import { emptyPoints, type Points } from '../points';
import { crsFromEpsg, crsFromWkt, geoKeyEpsg, headerVerticalFactor, lonLatTransforms, regionalVerticalFactor, type CrsInfo } from './crs';
import { BudgetExceeded, type ReadInfo, type ReadOptions } from './ept';
import { ahead, type Fetcher } from './fetcher';
import { lazDecoder } from './laz';
import { classificationLookup, findVlr, geoKeys, readCopcInfo, readEvlrs, readHeader, readHierarchyPage, readVlrs, wktOf, type HierarchyEntry, type Vlr } from './las';
import { classTable, normalizeRecords, PointSink, queryBounds, surfaceClassTable } from './normalize';

const UNITS: Record<string, number> = { m: 1, metre: 1, meter: 1, ft: 0.3048, 'us-ft': 1200 / 3937 };

export interface CopcTile {
  url: string;
  /** West, south, east, north in lon/lat. */
  bbox: [number, number, number, number];
  horizontalCrs?: string;
}

// The header first, then exactly up to the point data. A fixed-size first read
// fails on tiles smaller than it, since range reads must come back whole.
async function openCopc(fetcher: Fetcher, url: string) {
  let bytes = new Uint8Array(await fetcher.range(url, 0, 375));
  const header = readHeader(bytes);
  if (header.pointDataOffset > 4 * 1024 * 1024) throw new Error('COPC header records are too large');
  if (header.pointDataOffset > bytes.length) bytes = new Uint8Array(await fetcher.range(url, 0, header.pointDataOffset));
  const { vlrs, complete } = readVlrs(bytes, header);
  if (!complete) throw new Error('COPC header records run past the point data');
  return { header, vlrs };
}

/** CRS records stored as EVLRs; never the (possibly huge) hierarchy EVLR's body. */
async function crsEvlrs(fetcher: Fetcher, url: string, offset: number, count: number): Promise<Vlr[]> {
  const out: Vlr[] = [];
  let at = offset;
  for (let k = 0; k < Math.min(count, 64); k++) {
    const head = readEvlrs(new Uint8Array(await fetcher.range(url, at, at + 60)), 1)[0];
    if (!head) break;
    if (head.userId === 'LASF_Projection' && (head.recordId === 2112 || head.recordId === 34735) && head.length <= 1024 * 1024) {
      out.push({ userId: head.userId, recordId: head.recordId, data: new Uint8Array(await fetcher.range(url, at + 60, at + 60 + head.length)) });
    }
    at += 60 + head.length;
  }
  return out;
}

function tileCrs(vlrs: Vlr[], declared?: string): CrsInfo {
  const wkt = wktOf(vlrs);
  if (wkt) return crsFromWkt(wkt);
  const code = geoKeyEpsg(geoKeys(vlrs));
  if (code) return crsFromEpsg(code);
  const match = /^EPSG:(\d+)$/i.exec(declared ?? '');
  if (match) return crsFromEpsg(Number(match[1]));
  throw new Error('LAS header lacks a supported horizontal coordinate system');
}

/** Cropped, normalized returns inside `bbox` from each intersecting tile. */
export async function readCopc(fetcher: Fetcher, tiles: CopcTile[], bbox: GeoBounds, options: ReadOptions): Promise<{ points: Points; info: ReadInfo & { tiles: number } }> {
  const sink = options.sink ?? new PointSink();
  const maxPoints = options.maxPoints ?? 8e6;
  const decoder = await lazDecoder();
  let nodesRead = 0;
  let crsKey = '';
  let zUsed = 1;
  const intersecting = tiles.filter((t) => t.bbox[0] <= bbox.east && t.bbox[2] >= bbox.west && t.bbox[1] <= bbox.north && t.bbox[3] >= bbox.south);
  for (let t = 0; t < intersecting.length; t++) {
    const tile = intersecting[t];
    const name = tile.url.slice(tile.url.lastIndexOf('/') + 1);
    await options.progress?.(`Opening COPC tile ${t + 1} of ${intersecting.length}: ${name}`);
    const { header, vlrs: headerVlrs } = await openCopc(fetcher, tile.url);
    let vlrs = headerVlrs;
    const infoVlr = findVlr(vlrs, 'copc', 1);
    const laszip = findVlr(vlrs, 'laszip encoded', 22204);
    if (!infoVlr || !laszip) throw new Error(`${name} is not a COPC file`);
    if (!wktOf(vlrs) && header.evlrCount) vlrs = [...vlrs, ...(await crsEvlrs(fetcher, tile.url, header.evlrOffset, header.evlrCount))];
    const crs = tileCrs(vlrs, tile.horizontalCrs);
    crsKey = crs.key;
    const { toLonLat, fromLonLat } = lonLatTransforms(crs);
    const fromHeader = headerVerticalFactor(wktOf(vlrs), geoKeys(vlrs));
    let zFactor = fromHeader?.factor ?? (options.verticalUnits ? UNITS[options.verticalUnits.toLowerCase()] : undefined) ?? null;
    if (zFactor === null) zFactor = regionalVerticalFactor(tile.bbox);
    if (zFactor === null) throw new Error('Unknown LAS vertical units; a vertical CRS or unit key is required');
    zUsed = zFactor;
    const query = queryBounds(bbox, fromLonLat);
    const info = readCopcInfo(infoVlr);
    // laspy's resolution rule: depths while the node spacing stays coarser than asked.
    let levels = Infinity;
    const resolution = options.resolutionM ?? 0.35;
    if (!crs.geographic && resolution > 0) {
      let cloudResolution = resolution / crs.horizontalFactor;
      if (crs.epsg === 3857) cloudResolution /= Math.cos((((bbox.south + bbox.north) / 2) * Math.PI) / 180);
      levels = Math.max(1, Math.ceil(Math.log2(info.spacing / cloudResolution)) + 1);
    }
    const nodes = await hierarchy(fetcher, tile.url, info, query, levels);
    const total = nodes.reduce((s, n) => s + n.pointCount, 0);
    if (nodes.length > 4096 || total > maxPoints * 4) throw new BudgetExceeded('COPC node or point budget reached');
    const mapping = classificationLookup(vlrs) ?? options.classification;
    const classes = options.surface ? surfaceClassTable(mapping, options.surfaceCodes) : classTable(mapping);
    const chunks = decoder.chunkDecoder(laszip.data);
    try {
      let n = 0;
      for await (const body of ahead(nodes, 12, (node) => fetcher.range(tile.url, node.offset, node.offset + node.byteSize))) {
        const node = nodes[n++];
        await options.progress?.(`Decoding COPC tile ${t + 1} of ${intersecting.length}, node ${n} of ${nodes.length}; ${sink.count.toLocaleString('en-US')} points kept`);
        const records = chunks.decode(new Uint8Array(body), node.pointCount);
        normalizeRecords(records, node.pointCount, header.pointSize, { header, query, bbox, toLonLat, frame: options.frame, zFactor, classes, years: !options.surface }, sink);
        if (sink.count > maxPoints) throw new BudgetExceeded('Cropped LiDAR point budget reached');
      }
      nodesRead += nodes.length;
    } finally {
      chunks.free();
    }
  }
  const points = sink instanceof PointSink ? sink.finish() : emptyPoints();
  return { points, info: { url: tiles[0]?.url ?? '', nodes: nodesRead, points: sink.count, horizontalCrs: crsKey, zToMetres: zUsed, tiles: intersecting.length } };
}

/** Data nodes intersecting the query above the depth limit, reading child pages only where needed. */
async function hierarchy(fetcher: Fetcher, url: string, info: ReturnType<typeof readCopcInfo>, query: [number, number, number, number], levels: number): Promise<HierarchyEntry[]> {
  const [cx, cy] = info.center;
  const size = info.halfsize * 2;
  const x0 = cx - info.halfsize;
  const y0 = cy - info.halfsize;
  const touches = ([depth, ix, iy]: HierarchyEntry['key']) => {
    const width = size / 2 ** depth;
    const lx = x0 + ix * width;
    const ly = y0 + iy * width;
    return !(lx > query[2] || lx + width < query[0] || ly > query[3] || ly + width < query[1]);
  };
  const out: HierarchyEntry[] = [];
  const pages: [number, number][] = [[info.rootHierarchyOffset, info.rootHierarchySize]];
  let read = 0;
  while (pages.length) {
    const [offset, length] = pages.pop()!;
    if (++read > 512 || length > 4 * 1024 * 1024) throw new BudgetExceeded('COPC hierarchy limit reached');
    for (const entry of readHierarchyPage(new Uint8Array(await fetcher.range(url, offset, offset + length)))) {
      if (entry.key[0] >= levels || !touches(entry.key)) continue;
      if (entry.pointCount === -1) pages.push([entry.offset, entry.byteSize]);
      else if (entry.pointCount > 0 && entry.byteSize > 0) out.push(entry);
    }
  }
  return out.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2] || a.key[3] - b.key[3]);
}
