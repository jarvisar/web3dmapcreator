// Point tiles read straight from their files with range reads: COPC through
// its octree (ported from the add-on's lidar_copc.py), plain LAZ through its
// chunk table, and uncompressed LAS in slabs. What a tile is comes from its
// header, not the catalog. A server ignoring Range is an error, never a whole
// download. A tile can also be a member of a ZIP (zip.ts): read in place when
// it's stored, fetched whole and inflated when it's deflated.
//
// Plain tiles have no spatial index, so the first read of one decodes every
// chunk. The box each chunk covers is noted then, and later reads (the next
// batch or block in the same tile) only fetch and decode the chunks they need.

import { Inflate, inflateSync } from 'fflate';
import { Projection } from '../../geo/projection';
import type { GeoBounds } from '../../types';
import { emptyPoints, type Points } from '../points';
import { decodeChunkTable, laszipChunkSize, type LazChunk } from './chunks';
import { crsFromEpsg, crsFromWkt, geoKeyEpsg, headerVerticalFactor, lonLatTransforms, regionalVerticalFactor, type CrsInfo } from './crs';
import { BudgetExceeded, type ReadInfo, type ReadOptions } from './ept';
import { ahead, type Fetcher } from './fetcher';
import { lazDecoder, type LazChunkDecoder } from './laz';
import { classificationLookup, findVlr, geoKeys, readCopcInfo, readEvlrs, readHeader, readHierarchyPage, readVlrs, wktOf, type HierarchyEntry, type LasHeader, type Vlr } from './las';
import { classTable, normalizeRecords, PointSink, queryBounds, surfaceClassTable, type NormalizeOptions } from './normalize';
import { isZip, zipMember } from './zip';

const UNITS: Record<string, number> = { m: 1, metre: 1, meter: 1, ft: 0.3048, 'us-ft': 1200 / 3937 };

export interface PointTile {
  url: string;
  /** West, south, east, north in lon/lat. */
  bbox: [number, number, number, number];
  horizontalCrs?: string;
  /** File size in bytes, when the catalog gives it. */
  size?: number;
  /** For a ZIP, the member to read; by default its first .laz or .las. */
  member?: string;
  /** The server ignores Range: read the file whole. */
  whole?: boolean;
  /** Class codes for this tile alone, where one survey mixes schemes. */
  classification?: Record<string, string>;
  /** Metres added to every height, where a copy moved them to another datum. */
  zOffset?: number;
}

// Chunks of a plain tile are fetched in runs of about this many bytes: few
// enough requests, and the same runs every time so they come from the cache.
// A file under six runs is cut into six instead, so it still comes over six
// connections at once: rockyweb gives each about 48 KB/s.
const RUN_BYTES = 8 * 1024 * 1024;
const PARALLEL_RUNS = 6;
// Uncompressed LAS is read in slabs of this many records.
const SLAB_POINTS = 65536;
// A chunk table past this is not a LAZ file we can use.
const MAX_TABLE_BYTES = 64 * 1024 * 1024;
// A deflated ZIP member is held whole, inflated.
const MAX_INFLATED = 768 * 1024 * 1024;
// A deflated member is fetched in pieces of this many bytes.
const PIECE_BYTES = 4 * 1024 * 1024;

/** Where a tile's bytes come from: the file, or a member of a ZIP around it. */
interface Source {
  /** Names the bytes, for notes. */
  key: string;
  size?: number;
  range(start: number, end: number): Promise<ArrayBuffer>;
  /** From `start` to the end. */
  tail(start: number): Promise<ArrayBuffer>;
}

/** Bytes held in memory as a source. */
function memorySource(key: string, bytes: Uint8Array): Source {
  const slice = (start: number, end: number) => {
    if (end > bytes.length) return Promise.reject(new Error(`Bytes ${start}-${end} are past the end of ${key}`));
    return Promise.resolve(bytes.slice(start, end).buffer);
  };
  return { key, size: bytes.length, range: slice, tail: (start) => slice(start, bytes.length) };
}

/**
 * Where to read a tile from, with its first 375 bytes when they're the
 * tile's own, or null for a ZIP that lacks the member asked for (a border
 * block holds fewer than its full set).
 */
async function tileSource(fetcher: Fetcher, tile: PointTile, progress?: ReadOptions['progress'], peek = false): Promise<{ source: Source; first: Uint8Array | null } | { stream: Uint8Array; name: string } | null> {
  const { url } = tile;
  let file: Source;
  // Only a look at the header, so nothing that would download the file.
  if (peek && tile.whole) return null;
  if (tile.whole) {
    // The server ignores Range, so the file comes whole (and is cached whole).
    file = memorySource(url, new Uint8Array(await fetcher.bytes(url)));
  } else {
    file = { key: url, size: tile.size, range: (start, end) => fetcher.range(url, start, end), tail: (start) => fetcher.tail(url, start) };
  }
  const first = new Uint8Array(await file.range(0, file.size ? Math.min(375, file.size) : 375));
  if (!isZip(first)) return { source: file, first };
  const read = async (start: number, end: number) => new Uint8Array(await file.range(start, end));
  const member = await zipMember(read, first, file.size, tile.member);
  if (!member) return null;
  const key = `${url}#${member.name}`;
  const base = member.offset;
  if (member.method === 0) {
    return { source: { key, size: member.size, range: (start, end) => file.range(base + start, base + end), tail: (start) => file.range(base + start, base + member.size) }, first: null };
  }
  if (peek) return null;
  // In pieces, several at once: some servers are slow per connection
  // (Brandenburg's gives about 80 KB/s each), and pieces cache better.
  const compressed = new Uint8Array(member.compressedSize);
  const pieces: number[] = [];
  for (let at = 0; at < member.compressedSize; at += PIECE_BYTES) pieces.push(at);
  let done = 0;
  for await (const body of ahead(pieces, 6, (at) => file.range(base + at, base + Math.min(at + PIECE_BYTES, member.compressedSize)))) {
    compressed.set(new Uint8Array(body), pieces[done++]);
    await progress?.(`Downloading ${member.name}: ${Math.round((done * PIECE_BYTES) / 1e6)} of ${Math.round(member.compressedSize / 1e6)} MB`);
  }
  // Uncompressed LAS is read as it inflates, so it's never held whole:
  // Berlin's and Tokyo's tiles inflate to 200-500 MB each.
  if (/\.las$/i.test(member.name)) return { stream: compressed, name: member.name };
  if (member.size > MAX_INFLATED) throw new Error(`${member.name} is too large to inflate (${Math.round(member.size / 1e6)} MB)`);
  return { source: memorySource(key, inflateSync(compressed, { out: new Uint8Array(member.size) })), first: null };
}

/**
 * Throws what reading the tile would, about its coordinate system or height
 * units, from its header alone. Tiles only read whole, or deflated in a ZIP,
 * aren't looked at, since that takes the download this is meant to spare.
 */
export async function checkTile(fetcher: Fetcher, tile: PointTile, options: Pick<ReadOptions, 'verticalUnits' | 'classification'>): Promise<void> {
  const found = await tileSource(fetcher, tile, undefined, true);
  if (!found || 'stream' in found) return;
  const opened = await openTile(found.source, found.first);
  if (!opened.header.pointCount) return;
  if (!wktOf(opened.vlrs) && opened.header.evlrCount) opened.vlrs = [...opened.vlrs, ...(await crsEvlrs(found.source, opened.header.evlrOffset, opened.header.evlrCount))];
  const [w, s, e, n] = tile.bbox;
  tileSetup(opened, tile, { west: w, south: s, east: e, north: n }, { ...options, frame: new Projection([(w + e) / 2, (s + n) / 2], 0, 1) });
}

/**
 * A tile's points over the ground its header's box covers, per m², from the
 * header alone. Null for tiles only read whole or deflated in a ZIP, and for
 * any header that can't say. Edge tiles and tiles with water come out low.
 */
export async function tileDensity(fetcher: Fetcher, tile: PointTile): Promise<number | null> {
  try {
    const found = await tileSource(fetcher, tile, undefined, true);
    if (!found || 'stream' in found) return null;
    const opened = await openTile(found.source, found.first);
    const { header } = opened;
    if (!header.pointCount) return null;
    if (!wktOf(opened.vlrs) && header.evlrCount) opened.vlrs = [...opened.vlrs, ...(await crsEvlrs(found.source, header.evlrOffset, header.evlrCount))];
    const crs = tileCrs(opened.vlrs, tile.horizontalCrs);
    let [w, h] = [header.max[0] - header.min[0], header.max[1] - header.min[1]];
    if (crs.geographic) {
      const lat = ((header.min[1] + header.max[1]) / 2) * (Math.PI / 180);
      [w, h] = [w * 111_320 * Math.cos(lat), h * 110_574];
    } else {
      // Web Mercator stretches distance by sec(latitude).
      const stretch = crs.epsg === 3857 ? Math.cos(lonLatTransforms(crs).toLonLat(header.min[0], (header.min[1] + header.max[1]) / 2)[1] * (Math.PI / 180)) : 1;
      [w, h] = [w * crs.horizontalFactor * stretch, h * crs.horizontalFactor * stretch];
    }
    return w > 0 && h > 0 ? header.pointCount / (w * h) : null;
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    return null;
  }
}

// Deflate input fed to the inflater at a time.
const STREAM_STEP = 1 << 20;

/** Points from a deflated member of uncompressed LAS, inflated a piece at a time. */
async function readStream(compressed: Uint8Array, name: string, tile: PointTile, bbox: GeoBounds, options: ReadOptions, sink: NonNullable<ReadOptions['sink']>, maxPoints: number, label: string): Promise<{ crs: string; zFactor: number; slabs: number } | null> {
  let out: Uint8Array[] = [];
  let length = 0;
  const inflater = new Inflate((data) => {
    out.push(data);
    length += data.length;
  });
  let pushed = 0;
  const more = () => {
    if (pushed >= compressed.length) return false;
    const end = Math.min(pushed + STREAM_STEP, compressed.length);
    inflater.push(compressed.subarray(pushed, end), end === compressed.length);
    pushed = end;
    return true;
  };
  const joined = () => {
    if (out.length > 1) out = [concat(out, length)];
    return out[0] ?? new Uint8Array(0);
  };
  while (length < 375 && more());
  let start = joined();
  const header = readHeader(start);
  if (!header.pointCount) return null;
  if (header.pointDataOffset > 4 * 1024 * 1024) throw new Error('LAS header records are too large');
  while (length < header.pointDataOffset && more());
  start = joined();
  const { vlrs, complete } = readVlrs(start, header);
  if (!complete) throw new Error(`${name} header records run past the point data`);
  const { crs, normalize } = tileSetup({ header, vlrs, tableAt: -1 }, tile, bbox, options);
  // Records as they come, whole ones only. What's left of a record waits for the next piece.
  let carry = start.subarray(header.pointDataOffset);
  out = [];
  length = 0;
  let left = header.pointCount;
  let slabs = 0;
  for (;;) {
    const records = Math.min(left, Math.floor(carry.length / header.pointSize));
    if (records > 0) {
      normalizeRecords(carry, records, header.pointSize, normalize, sink);
      if (sink.count > maxPoints) throw new BudgetExceeded('Cropped LiDAR point budget reached');
      left -= records;
      carry = carry.subarray(records * header.pointSize);
      if (++slabs % 16 === 0) await options.progress?.(`Inflating LAS ${label}, ${(header.pointCount - left).toLocaleString('en-US')} of ${header.pointCount.toLocaleString('en-US')} points`);
    }
    if (!left) break;
    if (!more()) throw new Error(`${name} ends before its last point`);
    if (!length) continue;
    carry = concat([carry, ...out], carry.length + length);
    out = [];
    length = 0;
  }
  return { crs: crs.key, zFactor: normalize.zFactor, slabs };
}

function concat(parts: Uint8Array[], length: number): Uint8Array {
  const joined = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

interface Opened {
  header: LasHeader;
  vlrs: Vlr[];
  /** The 8 bytes where the points start: a LAZ file's chunk table offset. */
  tableAt: number;
}

// The header first, then exactly up to the point data and the 8 bytes after
// it. A fixed-size first read fails on tiles smaller than it, since range
// reads must come back whole.
async function openTile(source: Source, first: Uint8Array | null): Promise<Opened> {
  let bytes = first ?? new Uint8Array(await source.range(0, 375));
  const header = readHeader(bytes);
  if (header.pointDataOffset > 4 * 1024 * 1024) throw new Error('LAS header records are too large');
  // An empty file may end where its points would start.
  const end = header.pointCount ? header.pointDataOffset + 8 : header.pointDataOffset;
  if (end > bytes.length) bytes = new Uint8Array(await source.range(0, end));
  const { vlrs, complete } = readVlrs(bytes, header);
  if (!complete) throw new Error('LAS header records run past the point data');
  const tableAt = header.pointCount && header.compressed ? Number(new DataView(bytes.buffer, bytes.byteOffset).getBigInt64(header.pointDataOffset, true)) : -1;
  return { header, vlrs, tableAt };
}

/** CRS records stored as EVLRs; never the (possibly huge) hierarchy EVLR's body. */
async function crsEvlrs(source: Source, offset: number, count: number): Promise<Vlr[]> {
  const out: Vlr[] = [];
  let at = offset;
  for (let k = 0; k < Math.min(count, 64); k++) {
    const head = readEvlrs(new Uint8Array(await source.range(at, at + 60)), 1)[0];
    if (!head) break;
    if (head.userId === 'LASF_Projection' && (head.recordId === 2112 || head.recordId === 34735) && head.length <= 1024 * 1024) {
      out.push({ userId: head.userId, recordId: head.recordId, data: new Uint8Array(await source.range(at + 60, at + 60 + head.length)) });
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

/** How a tile's records become points: its grid, Z unit, crop box and classes. */
function tileSetup(opened: Opened, tile: PointTile, bbox: GeoBounds, options: ReadOptions): { crs: CrsInfo; query: [number, number, number, number]; normalize: NormalizeOptions } {
  const { header, vlrs } = opened;
  const crs = tileCrs(vlrs, tile.horizontalCrs);
  const { toLonLat, fromLonLat } = lonLatTransforms(crs);
  const fromHeader = headerVerticalFactor(wktOf(vlrs), geoKeys(vlrs));
  let zFactor = fromHeader?.factor ?? (options.verticalUnits ? UNITS[options.verticalUnits.toLowerCase()] : undefined) ?? null;
  if (zFactor === null) zFactor = regionalVerticalFactor(tile.bbox);
  if (zFactor === null) throw new Error('Unknown LAS vertical units; a vertical CRS or unit key is required');
  const query = queryBounds(bbox, fromLonLat);
  const mapping = tile.classification ?? classificationLookup(vlrs) ?? options.classification;
  const classes = options.surface ? surfaceClassTable(mapping, options.surfaceCodes) : classTable(mapping);
  return { crs, query, normalize: { header, query, bbox, toLonLat, frame: options.frame, zFactor, zOffset: tile.zOffset, classes, years: !options.surface } };
}

interface TileContext {
  fetcher: Fetcher;
  source: Source;
  name: string;
  label: string;
  opened: Opened;
  query: [number, number, number, number];
  normalize: NormalizeOptions;
  sink: NonNullable<ReadOptions['sink']>;
  maxPoints: number;
  options: ReadOptions;
}

/** Cropped, normalized returns inside `bbox` from each intersecting tile. */
export async function readTiles(fetcher: Fetcher, tiles: PointTile[], bbox: GeoBounds, options: ReadOptions): Promise<{ points: Points; info: ReadInfo & { tiles: number } }> {
  const sink = options.sink ?? new PointSink();
  const maxPoints = options.maxPoints ?? 8e6;
  let nodesRead = 0;
  let crsKey = '';
  let zUsed = 1;
  const intersecting = tiles.filter((t) => t.bbox[0] <= bbox.east && t.bbox[2] >= bbox.west && t.bbox[1] <= bbox.north && t.bbox[3] >= bbox.south);
  for (let t = 0; t < intersecting.length; t++) {
    const tile = intersecting[t];
    const name = tile.url.slice(tile.url.lastIndexOf('/') + 1);
    const label = `tile ${t + 1} of ${intersecting.length}`;
    await options.progress?.(`Opening ${label}: ${name}`);
    const found = await tileSource(fetcher, tile, options.progress);
    if (!found) continue;
    if ('stream' in found) {
      const read = await readStream(found.stream, found.name, tile, bbox, options, sink, maxPoints, label);
      if (read) [crsKey, zUsed] = [read.crs, read.zFactor];
      nodesRead += read?.slabs ?? 0;
      continue;
    }
    const { source } = found;
    const opened = await openTile(source, found.first);
    const { header } = opened;
    if (!header.pointCount) continue;
    if (!wktOf(opened.vlrs) && header.evlrCount) opened.vlrs = [...opened.vlrs, ...(await crsEvlrs(source, header.evlrOffset, header.evlrCount))];
    const { crs, query, normalize } = tileSetup(opened, tile, bbox, options);
    crsKey = crs.key;
    zUsed = normalize.zFactor;
    const context: TileContext = { fetcher, source, name, label, opened, query, normalize, sink, maxPoints, options };
    const copc = findVlr(opened.vlrs, 'copc', 1);
    if (copc) nodesRead += await readOctree(context, copc, crs);
    else nodesRead += await readChunks(context);
  }
  const points = sink instanceof PointSink ? sink.finish() : emptyPoints();
  return { points, info: { url: tiles[0]?.url ?? '', nodes: nodesRead, points: sink.count, horizontalCrs: crsKey, zToMetres: zUsed, tiles: intersecting.length } };
}

// ------------------------------------------------------------------ COPC

async function readOctree(ctx: TileContext, copc: Vlr, crs: CrsInfo): Promise<number> {
  const { source, opened, options, sink } = ctx;
  const laszip = findVlr(opened.vlrs, 'laszip encoded', 22204);
  if (!laszip) throw new Error(`${ctx.name} is not a COPC file`);
  const info = readCopcInfo(copc);
  // laspy's resolution rule: depths while the node spacing stays coarser than asked.
  let levels = Infinity;
  const resolution = options.resolutionM ?? 0.35;
  if (!crs.geographic && resolution > 0) {
    let cloudResolution = resolution / crs.horizontalFactor;
    if (crs.epsg === 3857) cloudResolution /= Math.cos((((ctx.normalize.bbox.south + ctx.normalize.bbox.north) / 2) * Math.PI) / 180);
    levels = Math.max(1, Math.ceil(Math.log2(info.spacing / cloudResolution)) + 1);
  }
  const nodes = await hierarchy(source, info, ctx.query, levels);
  const total = nodes.reduce((s, n) => s + n.pointCount, 0);
  if (nodes.length > 4096 || total > ctx.maxPoints * 4) throw new BudgetExceeded('COPC node or point budget reached');
  const chunks = (await lazDecoder()).chunkDecoder(laszip.data);
  try {
    let n = 0;
    for await (const body of ahead(nodes, 12, (node) => source.range(node.offset, node.offset + node.byteSize))) {
      const node = nodes[n++];
      await options.progress?.(`Decoding COPC ${ctx.label}, node ${n} of ${nodes.length}; ${sink.count.toLocaleString('en-US')} points kept`);
      const records = chunks.decode(new Uint8Array(body), node.pointCount);
      normalizeRecords(records, node.pointCount, opened.header.pointSize, ctx.normalize, sink);
      if (sink.count > ctx.maxPoints) throw new BudgetExceeded('Cropped LiDAR point budget reached');
    }
  } finally {
    chunks.free();
  }
  return nodes.length;
}

/** Data nodes intersecting the query above the depth limit, reading child pages only where needed. */
async function hierarchy(source: Source, info: ReturnType<typeof readCopcInfo>, query: [number, number, number, number], levels: number): Promise<HierarchyEntry[]> {
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
    for (const entry of readHierarchyPage(new Uint8Array(await source.range(offset, offset + length)))) {
      if (entry.key[0] >= levels || !touches(entry.key)) continue;
      if (entry.pointCount === -1) pages.push([entry.offset, entry.byteSize]);
      else if (entry.pointCount > 0 && entry.byteSize > 0) out.push(entry);
    }
  }
  return out.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2] || a.key[3] - b.key[3]);
}

// ------------------------------------------------------- plain LAZ and LAS

/** Where a plain tile's points are: LAZ chunks from the chunk table, or slabs of LAS records. */
async function plainChunks(ctx: TileContext): Promise<LazChunk[]> {
  const { source, opened } = ctx;
  const { header, vlrs, tableAt } = opened;
  if (!header.compressed) {
    const out: LazChunk[] = [];
    for (let first = 0; first < header.pointCount; first += SLAB_POINTS) {
      const count = Math.min(SLAB_POINTS, header.pointCount - first);
      out.push({ offset: header.pointDataOffset + first * header.pointSize, byteSize: count * header.pointSize, pointCount: count });
    }
    return out;
  }
  const laszip = findVlr(vlrs, 'laszip encoded', 22204);
  if (!laszip) throw new Error(`${ctx.name} is compressed without a laszip record`);
  const start = header.pointDataOffset + 8;
  // -1 means the writer couldn't go back to fill it in: the table is at the
  // end, found through the file's last 8 bytes. That needs the file size.
  let at = tableAt;
  if (at === -1 && source.size) at = Number(new DataView(await source.range(source.size - 8, source.size)).getBigInt64(0, true));
  if (!(at >= start)) throw new Error(`${ctx.name} has no LAZ chunk table`);
  // The table runs up to the EVLRs, or to the end of the file.
  const end = header.evlrOffset > at + 8 ? header.evlrOffset : source.size && source.size > at + 8 ? source.size : undefined;
  if (end !== undefined && end - at > MAX_TABLE_BYTES) throw new Error(`${ctx.name} has a LAZ chunk table that is too large`);
  const table = new Uint8Array(end !== undefined ? await source.range(at, end) : await source.tail(at));
  if (table.length > MAX_TABLE_BYTES) throw new Error(`${ctx.name} has a LAZ chunk table that is too large`);
  const chunks = decodeChunkTable(table.subarray(0, 8), table.subarray(8), start, laszipChunkSize(laszip.data), header.pointCount);
  const last = chunks.at(-1);
  if (last && last.offset + last.byteSize > at) throw new Error(`${ctx.name} has a LAZ chunk table that runs into itself`);
  return chunks;
}

/** Consecutive chunks in runs of up to RUN_BYTES, at least PARALLEL_RUNS of them where they're big enough; a chunk larger than that is a run of its own. */
function runs(chunks: LazChunk[]): { start: number; end: number; chunks: number[] }[] {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteSize, 0);
  const limit = Math.min(RUN_BYTES, Math.max(1024 * 1024, Math.ceil(total / PARALLEL_RUNS)));
  const out: { start: number; end: number; chunks: number[] }[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const run = out.at(-1);
    if (run && run.end === chunk.offset && chunk.offset + chunk.byteSize - run.start <= limit) {
      run.end = chunk.offset + chunk.byteSize;
      run.chunks.push(i);
    } else out.push({ start: chunk.offset, end: chunk.offset + chunk.byteSize, chunks: [i] });
  }
  return out;
}

/** The box of each chunk, in the file's grid, from a note saved by an earlier read. */
function savedBoxes(note: string, count: number): Float64Array | null {
  if (!note) return null;
  try {
    const values = JSON.parse(note) as number[];
    return Array.isArray(values) && values.length === 4 * count && values.every(Number.isFinite) ? Float64Array.from(values) : null;
  } catch {
    return null;
  }
}

/** Grows `boxes` at `index` by the XY of each record. */
function boxRecords(records: Uint8Array, count: number, size: number, header: LasHeader, boxes: Float64Array, index: number): void {
  const view = new DataView(records.buffer, records.byteOffset, records.byteLength);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = view.getInt32(i * size, true);
    const y = view.getInt32(i * size + 4, true);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const [sx, sy] = header.scale;
  const [ox, oy] = header.offset;
  // Rounded outwards to a centimetre, to keep the note short.
  boxes[4 * index] = Math.floor((x0 * sx + ox) * 100) / 100;
  boxes[4 * index + 1] = Math.floor((y0 * sy + oy) * 100) / 100;
  boxes[4 * index + 2] = Math.ceil((x1 * sx + ox) * 100) / 100;
  boxes[4 * index + 3] = Math.ceil((y1 * sy + oy) * 100) / 100;
}

async function readChunks(ctx: TileContext): Promise<number> {
  const { fetcher, source, opened, options, sink, query } = ctx;
  const { header } = opened;
  const chunks = await plainChunks(ctx);
  const key = `chunks:1:${source.key}:${opened.tableAt}:${header.pointCount}:${chunks.length}`;
  const known = savedBoxes(await fetcher.note(key), chunks.length);
  const wanted = chunks.map((_, i) => !known || !(known[4 * i] > query[2] || known[4 * i + 2] < query[0] || known[4 * i + 1] > query[3] || known[4 * i + 3] < query[1]));
  const needed = runs(chunks).filter((run) => run.chunks.some((i) => wanted[i]));
  const boxes = known ? null : new Float64Array(4 * chunks.length);
  let decoder: LazChunkDecoder | null = null;
  if (header.compressed) decoder = (await lazDecoder()).chunkDecoder(findVlr(opened.vlrs, 'laszip encoded', 22204)!.data);
  const kind = header.compressed ? 'LAZ' : 'LAS';
  let decoded = 0;
  let r = 0;
  const total = wanted.filter(Boolean).length;
  try {
    for await (const body of ahead(needed, PARALLEL_RUNS, (run) => source.range(run.start, run.end))) {
      const run = needed[r++];
      const bytes = new Uint8Array(body);
      for (const i of run.chunks) {
        if (!wanted[i]) continue;
        const chunk = chunks[i];
        const raw = bytes.subarray(chunk.offset - run.start, chunk.offset - run.start + chunk.byteSize);
        const records = decoder ? decoder.decode(raw, chunk.pointCount) : raw;
        if (boxes) boxRecords(records, chunk.pointCount, header.pointSize, header, boxes, i);
        normalizeRecords(records, chunk.pointCount, header.pointSize, ctx.normalize, sink);
        if (sink.count > ctx.maxPoints) throw new BudgetExceeded('Cropped LiDAR point budget reached');
        decoded++;
      }
      await options.progress?.(`Decoding ${kind} ${ctx.label}, chunk ${decoded} of ${total}; ${sink.count.toLocaleString('en-US')} points kept`);
    }
  } finally {
    decoder?.free();
  }
  // Only a read that went through every chunk knows where they all are.
  if (boxes) await fetcher.note(key, JSON.stringify(Array.from(boxes)));
  return decoded;
}
