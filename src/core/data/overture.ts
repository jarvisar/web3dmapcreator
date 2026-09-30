// Overture Maps data read straight from the public GeoParquet files on S3.
// The release's STAC index says which files cover the area, and each file's
// footer says which of its row groups do. Those row groups are then read in
// two passes: first every wanted column except geometry, to pick the rows by
// their bbox and the caller's filter, then the geometry of only those rows,
// page by page. Features come back unclipped, as Overture stores them.

import { parquetMetadata, parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet';
import type { AsyncBuffer, ColumnChunk, ColumnMetaData, FileMetaData, ParquetParsers, RowGroup, SchemaElement } from 'hyparquet';
import type { GeoBounds } from '../types';
import { memo } from './cache';
import {
  OVERTURE_LABEL,
  OVERTURE_TYPES,
  type Geometry,
  type OvertureData,
  type OvertureFeature,
  type OvertureType,
  type OvertureTypeStats,
} from './features';
import { fetchByteLength, fetchBytes, HttpError, loadCached, NetworkError, remoteFile, storeCached, type RemoteFile } from './http';
import {
  chunkRange,
  columnDecoder,
  compressors,
  isFlat,
  planReads,
  readRows,
  readsBytes,
  walkPages,
  wholeChunk,
  type ChunkRead,
} from './parquet';
import { parseWkb } from './wkb';

const STAC_ROOT = 'https://stac.overturemaps.org';
// Overture's release folders, listed by S3 to anyone, with CORS. Stands in
// for the catalog on stac.overturemaps.org when that cannot be read.
const RELEASE_LISTING_URL = 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/?list-type=2&prefix=release/&delimiter=/';
const RELEASE_NAME = /^\d{4}-\d{2}-\d{2}\.\d+$/;
const LATEST_TTL_MS = 60 * 60 * 1000;
// Releases come out about once a month, so a saved answer holds for hours.
// Only a release named by the catalog whose index was read is saved.
const SAVED_RELEASE_KEY = 'overture-latest-release';
const SAVED_RELEASE_TTL_MS = 6 * 60 * 60 * 1000;
const PROGRESS_INTERVAL_MS = 100;
// Row groups in progress at a time. Enough to keep the request limit busy,
// while a large area does not pile up downloaded chunks waiting to be
// decoded.
const GROUPS_AT_ONCE = 8;

/** Compressed bytes one type may need before the area counts as too large. */
export const MAX_TYPE_BYTES = 250e6;
/** Compressed bytes all types together may need. */
export const MAX_TOTAL_BYTES = 300e6;

const BASE_COLUMNS: readonly string[] = ['id', 'geometry', 'bbox'];

// A model can't be built without these. When a release has no files for one
// of the other types, that layer is left out with a warning instead.
const ESSENTIAL_TYPES: readonly OvertureType[] = ['building', 'segment', 'water'];

// Read on top of id, geometry and bbox. A column a file does not have is
// skipped, so a schema change loses that property instead of failing.
export const OVERTURE_COLUMNS: Record<OvertureType, readonly string[]> = {
  building: [
    'height', 'min_height', 'num_floors', 'min_floor', 'roof_shape', 'roof_height', 'roof_direction',
    'roof_orientation', 'class', 'subtype', 'is_underground', 'has_parts', 'level', 'roof_color',
    'facade_color', 'names',
  ],
  building_part: [
    'building_id', 'height', 'min_height', 'num_floors', 'min_floor', 'roof_shape', 'roof_height',
    'roof_direction', 'roof_orientation', 'is_underground', 'level', 'roof_color', 'facade_color',
  ],
  // Names only label what the editor selects.
  segment: ['subtype', 'class', 'subclass', 'subclass_rules', 'road_flags', 'rail_flags', 'width_rules', 'level_rules', 'access_restrictions', 'names'],
  water: ['subtype', 'class', 'is_salt', 'is_intermittent', 'level', 'source_tags', 'names'],
  land: ['subtype', 'class', 'surface', 'elevation', 'source_tags'],
  land_use: ['subtype', 'class', 'surface', 'source_tags'],
  land_cover: ['subtype', 'class', 'cartography'],
  infrastructure: ['subtype', 'class', 'surface', 'height', 'width', 'source_tags'],
};

// Struct columns read only in part. names.common and names.rules hold the
// translations and can outweigh the primary name many times. Land cover's
// zoom range picks its detailed polygons (isDetailedCover).
const STRUCT_CHILDREN: Record<string, readonly string[]> = { names: ['primary'], cartography: ['min_zoom', 'max_zoom'] };

// Footer bytes per row group in release 2026-09-23.1, rounded up. hyparquet
// fetches the rest when a guess is short, which costs one more request.
const FOOTER_BYTES_PER_GROUP: Record<OvertureType, number> = {
  building: 6000,
  building_part: 7000,
  segment: 17000,
  water: 5500,
  land: 5500,
  land_use: 5500,
  land_cover: 2800,
  infrastructure: 5500,
};

// Geometry stays raw WKB until the rows it belongs to are known to be kept.
const RAW_GEOMETRY: Partial<ParquetParsers> = {
  geometryFromBytes: (bytes: Uint8Array) => bytes,
  geographyFromBytes: (bytes: Uint8Array) => bytes,
};

// When the geometry of a row group is read page by page.
const pageReading = {
  // Smaller chunks are read whole: finding their pages costs more requests than it saves.
  minChunkBytes: 256e3,
  // Pages are looked for only when the kept rows seem to need at most this
  // share of the chunk (see estimateShare).
  maxEstimatedShare: 0.75,
  // The pages found are read on their own only when they come to less than
  // this share of the chunk.
  maxPagedShare: 0.85,
};

/** Changes when geometry is read page by page. For tests. */
export function configurePageReading(options: Partial<typeof pageReading>): void {
  Object.assign(pageReading, options);
}

export interface IndexedFile {
  theme: string;
  type: string;
  /** HTTPS URL on S3. */
  href: string;
  /** File size in bytes, 0 when the index does not say. */
  size: number;
  /** west, south, east, north */
  bbox: [number, number, number, number];
  rows: number;
  rowGroups: number;
}

export interface ReleaseIndex {
  release: string;
  /** Sorted by URL. */
  files: IndexedFile[];
}

export interface OvertureProgress {
  /** The type being read, when there is one. */
  type?: OvertureType;
  message: string;
  /** Bytes read so far, from the network or the cache. */
  bytes: number;
  /**
   * Estimated total bytes: the footers first, then with every planned
   * attribute and geometry chunk, and once the kept rows are known with only
   * the geometry pages they need. Never below `bytes`.
   */
  bytesTotal: number;
  /** Rows kept so far, which become features unless their geometry is unreadable. */
  features: number;
}

export type OvertureFilter = (type: OvertureType, props: Record<string, unknown>, bbox: [number, number, number, number]) => boolean;

export interface FetchOvertureOptions {
  bounds: GeoBounds;
  /** Default all eight. */
  types?: readonly OvertureType[];
  /** Default the latest release. */
  release?: string;
  signal?: AbortSignal;
  onProgress?: (progress: OvertureProgress) => void;
  /**
   * Called for every row whose bbox meets the bounds, before its geometry is
   * downloaded. Rows it returns false for are dropped. `props` are the
   * feature's final props.
   */
  keep?: OvertureFilter;
  /** Default MAX_TYPE_BYTES. */
  maxTypeBytes?: number;
  /** Default MAX_TOTAL_BYTES. */
  maxTotalBytes?: number;
}

/** Overture's servers did not answer. The message can be shown as it is. */
export class OvertureUnavailableError extends Error {
  constructor(offline: boolean, options?: ErrorOptions) {
    super(
      offline
        ? "Could not reach Overture's servers. Check the internet connection and try again."
        : "Overture's servers are busy. Try again in a few minutes.",
      options,
    );
    this.name = 'OvertureUnavailableError';
  }
}

export class AreaTooLargeError extends Error {
  /** The type over its own limit, or undefined when all of them together are too much. */
  readonly type: OvertureType | undefined;
  readonly bytes: number;
  /** Bytes each requested type would need, including what was already read. */
  readonly planned: Partial<Record<OvertureType, number>>;

  /** `atLeast` when `bytes` is a lower bound, found before all the rows were read. */
  constructor(bytes: number, planned: Partial<Record<OvertureType, number>>, type?: OvertureType, atLeast = false) {
    const amount = `${atLeast ? 'over' : 'about'} ${Math.round(bytes / 1e6)} MB${type ? ` of ${OVERTURE_LABEL[type]}` : ''}`;
    super(`This area is too large to download in the browser (${amount}). Choose a smaller area.`);
    this.name = 'AreaTooLargeError';
    this.type = type;
    this.bytes = bytes;
    this.planned = planned;
  }
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

function compareReleases(a: string, b: string): number {
  const [dateA, minorA] = a.split('.');
  const [dateB, minorB] = b.split('.');
  if (dateA !== dateB) return dateA < dateB ? -1 : 1;
  return toNumber(minorA ?? 0) - toNumber(minorB ?? 0);
}

function checkRelease(release: string): void {
  if (!/^[\w.-]+$/.test(release)) throw new Error(`"${release}" is not an Overture release name`);
}

/** The latest release named by the STAC catalog. */
export function latestFromCatalog(catalog: unknown): string {
  const root = catalog as { latest?: unknown; links?: unknown } | null;
  if (typeof root?.latest === 'string' && root.latest.trim()) return root.latest.trim();
  const children: { release: string; latest: boolean }[] = [];
  for (const link of Array.isArray(root?.links) ? (root.links as Record<string, unknown>[]) : []) {
    if (link?.rel !== 'child' || typeof link.href !== 'string') continue;
    const match = /\/([^/]+)\/catalog\.json$/.exec(link.href);
    if (match) children.push({ release: match[1], latest: link.latest === true });
  }
  const flagged = children.find((child) => child.latest);
  if (flagged) return flagged.release;
  const sorted = children.map((child) => child.release).sort(compareReleases);
  if (sorted.length) return sorted[sorted.length - 1];
  throw new Error('The Overture catalog does not name a latest release');
}

/** The newest release folder in S3's listing of release/, e.g. release/2026-09-23.1/. */
export function latestFromListing(xml: string): string {
  const releases = [...xml.matchAll(/<Prefix>release\/([^</]+)\/<\/Prefix>/g)]
    .map((match) => match[1])
    .filter((name) => RELEASE_NAME.test(name));
  if (!releases.length) throw new Error('The Overture release listing names no releases');
  return releases.sort(compareReleases)[releases.length - 1];
}

function serverTrouble(error: unknown): boolean {
  return error instanceof NetworkError || (error instanceof HttpError && (error.status === 429 || error.status >= 500));
}

function unavailable(errors: unknown[]): OvertureUnavailableError {
  const offline = errors.length > 0 && errors.every((error) => error instanceof NetworkError);
  return new OvertureUnavailableError(offline, { cause: errors[errors.length - 1] });
}

interface SavedRelease {
  release: string;
  time: number;
}

async function loadSavedRelease(): Promise<SavedRelease | undefined> {
  const bytes = await loadCached(SAVED_RELEASE_KEY);
  if (!bytes) return undefined;
  try {
    const saved = JSON.parse(new TextDecoder().decode(bytes)) as Partial<SavedRelease>;
    if (typeof saved.release === 'string' && RELEASE_NAME.test(saved.release) && typeof saved.time === 'number') {
      return { release: saved.release, time: saved.time };
    }
  } catch {
    // A damaged entry is ignored.
  }
  return undefined;
}

function saveRelease(release: string): void {
  storeCached(SAVED_RELEASE_KEY, new TextEncoder().encode(JSON.stringify({ release, time: Date.now() })).buffer);
}

async function releaseFromCatalog(): Promise<string> {
  // One attempt only, never cached: the listing below is the fallback.
  const bytes = await fetchBytes(`${STAC_ROOT}/catalog.json`, undefined, { cache: false, retries: 0 });
  return latestFromCatalog(JSON.parse(new TextDecoder().decode(bytes)));
}

async function releaseFromListing(): Promise<string> {
  const bytes = await fetchBytes(RELEASE_LISTING_URL, undefined, { cache: false });
  return latestFromListing(new TextDecoder().decode(bytes));
}

async function findLatestIndex(): Promise<ReleaseIndex> {
  const saved = await loadSavedRelease();
  const now = Date.now();
  if (saved && saved.time <= now && now - saved.time < SAVED_RELEASE_TTL_MS) return getReleaseIndex(saved.release);
  const errors: unknown[] = [];
  for (const [find, fromCatalog] of [[releaseFromCatalog, true], [releaseFromListing, false]] as const) {
    let release: string;
    try {
      release = await find();
      checkRelease(release);
    } catch (error) {
      errors.push(error);
      continue;
    }
    try {
      const index = await getReleaseIndex(release);
      // The listing can show a release folder before its index is published,
      // so only the catalog's answer is saved.
      if (fromCatalog) saveRelease(release);
      return index;
    } catch (error) {
      if (!saved || saved.release === release) throw error;
      break;
    }
  }
  // An old answer beats none: a release's files stay up for 60 days.
  if (saved) return getReleaseIndex(saved.release);
  throw unavailable(errors);
}

/**
 * The index of the newest Overture release that has one. The answer is kept
 * for an hour in memory, and the release name for six hours in the byte
 * cache. When stac.overturemaps.org does not answer, S3's listing of release
 * folders is used. When the new release's index can't be read, the last
 * saved release is used instead.
 */
export function getLatestIndex(signal?: AbortSignal): Promise<ReleaseIndex> {
  return memo('overture-latest', LATEST_TTL_MS, findLatestIndex, signal);
}

function httpsHref(aws: Record<string, unknown> | undefined): string | undefined {
  if (typeof aws?.href === 'string' && aws.href.startsWith('https://')) return aws.href;
  const s3 = (aws?.alternate as { s3?: { href?: unknown } } | undefined)?.s3?.href;
  if (typeof s3 !== 'string') return undefined;
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(s3);
  // Overture's bucket names end in their region, e.g. overturemaps-us-west-2.
  const region = match && /([a-z]{2}-[a-z]+-\d)$/.exec(match[1]);
  return match && region ? `https://${match[1]}.s3.${region[1]}.amazonaws.com/${match[2]}` : undefined;
}

/** Index rows (columns assets, bbox, num_rows, num_row_groups) to file entries. Azure assets are ignored. */
export function parseIndexRows(rows: readonly Record<string, unknown>[]): IndexedFile[] {
  const files: IndexedFile[] = [];
  for (const row of rows) {
    const aws = (row.assets as { aws?: Record<string, unknown> } | undefined)?.aws;
    const href = httpsHref(aws);
    const match = href && /\/theme=([^/]+)\/type=([^/]+)\//.exec(href);
    const box = row.bbox as Record<string, unknown> | undefined;
    if (!href || !match || !box) continue;
    const bbox: [number, number, number, number] = [toNumber(box.xmin), toNumber(box.ymin), toNumber(box.xmax), toNumber(box.ymax)];
    if (!bbox.every(Number.isFinite)) continue;
    const size = toNumber(aws?.['file:size']);
    files.push({
      theme: match[1],
      type: match[2],
      href,
      size: size > 0 ? size : 0,
      bbox,
      rows: toNumber(row.num_rows) || 0,
      rowGroups: toNumber(row.num_row_groups) || 0,
    });
  }
  files.sort((a, b) => (a.href < b.href ? -1 : a.href > b.href ? 1 : 0));
  return files;
}

function memoryFile(buffer: ArrayBuffer): AsyncBuffer {
  return { byteLength: buffer.byteLength, slice: (start, end) => buffer.slice(start, end) };
}

async function readIndex(buffer: ArrayBuffer): Promise<IndexedFile[]> {
  const metadata = parquetMetadata(buffer);
  const names = new Set(parquetSchema(metadata).children.map((child) => child.element.name));
  if (!names.has('assets') || !names.has('bbox')) throw new Error('The Overture index has no assets or bbox column');
  // Only these columns: the index also has a datetime column with a time
  // zone that some readers choke on.
  const columns = ['assets', 'bbox', 'num_rows', 'num_row_groups'].filter((name) => names.has(name));
  const rows = await parquetReadObjects({ file: memoryFile(buffer), metadata, columns, compressors });
  return parseIndexRows(rows);
}

async function loadIndex(release: string): Promise<ReleaseIndex> {
  const url = `${STAC_ROOT}/${release}/collections.parquet`;
  let files: IndexedFile[];
  try {
    try {
      files = await readIndex(await fetchBytes(url));
    } catch (error) {
      if (isDownloadError(error)) throw error;
      // A cached copy that does not parse is replaced by a fresh download.
      files = await readIndex(await fetchBytes(url, undefined, { refresh: true }));
    }
  } catch (error) {
    if (error instanceof HttpError && (error.status === 403 || error.status === 404)) {
      throw new Error(
        `Could not find the file index for Overture release ${release}. The release may not be published yet, or may be too old.`,
        { cause: error },
      );
    }
    throw serverTrouble(error) ? unavailable([error]) : error;
  }
  if (!files.length) throw new Error(`The Overture index for release ${release} lists no files`);
  return { release, files };
}

/**
 * Every file of a release with its bbox, from the release's STAC index (about
 * 200 KB). It is kept in the byte cache, so a browser fetches it once per
 * release. There is no copy on S3 to fall back to.
 */
export function getReleaseIndex(release: string, signal?: AbortSignal): Promise<ReleaseIndex> {
  checkRelease(release);
  return memo(`overture-index-${release}`, Infinity, () => loadIndex(release), signal);
}

export interface RowGroupSpan {
  /** Row group number in the file. */
  index: number;
  rowStart: number;
  rowEnd: number;
  /** Compressed size of the selected columns. */
  bytes: number;
}

export interface PlannedGroup extends RowGroupSpan {
  /** Compressed size of the geometry chunk, which `bytes` leaves out. */
  geometryBytes: number;
}

export interface ReadPlan {
  /**
   * The file's metadata cut down to the row groups to read, with the unread
   * children of STRUCT_CHILDREN columns removed. A big footer parses to over
   * 10 MB of objects, and this lets the rest of it be freed.
   */
  metadata: FileMetaData;
  /** Every selected column, geometry included. */
  columns: string[];
  /** Selected columns stored as a Parquet MAP. */
  mapColumns: Set<string>;
  /** `index` is the row group's number in the file, the row range is within `metadata`. */
  groups: PlannedGroup[];
  /** The selected columns except geometry. */
  bytes: number;
  /** All the geometry chunks, the most the second pass can read. */
  geometryBytes: number;
}

function statistic(group: RowGroup, path: string, which: 'min' | 'max', hint: number): number | undefined {
  let chunk: ColumnChunk | undefined = group.columns[hint];
  if (chunk?.meta_data?.path_in_schema.join('.') !== path) {
    chunk = group.columns.find((c) => c.meta_data?.path_in_schema.join('.') === path);
  }
  const stats = chunk?.meta_data?.statistics;
  const value = which === 'min' ? (stats?.min_value ?? stats?.min) : (stats?.max_value ?? stats?.max);
  const number = typeof value === 'number' || typeof value === 'bigint' ? Number(value) : NaN;
  return Number.isNaN(number) ? undefined : number;
}

/**
 * Row groups whose bbox statistics meet the bounds. A row group without
 * statistics is kept, since only reading it can tell. `bytes` counts the
 * given top-level columns, or all of them.
 */
export function selectRowGroups(metadata: FileMetaData, bounds: GeoBounds, columns?: readonly string[]): RowGroupSpan[] {
  const first = metadata.row_groups[0]?.columns ?? [];
  const hints = ['bbox.xmin', 'bbox.xmax', 'bbox.ymin', 'bbox.ymax'].map((path) =>
    first.findIndex((c) => c.meta_data?.path_in_schema.join('.') === path),
  );
  const spans: RowGroupSpan[] = [];
  let rowStart = 0;
  metadata.row_groups.forEach((group, index) => {
    const rows = Number(group.num_rows);
    const rowEnd = rowStart + rows;
    const xmin = statistic(group, 'bbox.xmin', 'min', hints[0]);
    const xmax = statistic(group, 'bbox.xmax', 'max', hints[1]);
    const ymin = statistic(group, 'bbox.ymin', 'min', hints[2]);
    const ymax = statistic(group, 'bbox.ymax', 'max', hints[3]);
    const meets =
      xmin === undefined || xmax === undefined || ymin === undefined || ymax === undefined ||
      (xmin < bounds.east && xmax > bounds.west && ymin < bounds.north && ymax > bounds.south);
    if (rows > 0 && meets) {
      let bytes = 0;
      for (const chunk of group.columns) {
        const meta = chunk.meta_data;
        if (meta && (!columns || columns.includes(meta.path_in_schema[0]))) bytes += Number(meta.total_compressed_size);
      }
      spans.push({ index, rowStart, rowEnd, bytes });
    }
    rowStart = rowEnd;
  });
  return spans;
}

function subtreeEnd(schema: readonly SchemaElement[], index: number): number {
  let end = index + 1;
  for (let child = 0; child < (schema[index].num_children ?? 0); child++) end = subtreeEnd(schema, end);
  return end;
}

/**
 * Metadata that shows only the `keep` children of a top-level struct column.
 * hyparquet selects whole top-level columns, and this is how it reads, say,
 * names.primary without names.common and names.rules.
 */
export function pruneStruct(metadata: FileMetaData, column: string, keep: readonly string[]): FileMetaData {
  const { schema } = metadata;
  const out: SchemaElement[] = [schema[0]];
  for (let i = 1; i < schema.length; ) {
    const end = subtreeEnd(schema, i);
    if (schema[i].name === column && schema[i].num_children) {
      const kept: SchemaElement[] = [];
      let children = 0;
      for (let j = i + 1; j < end; ) {
        const childEnd = subtreeEnd(schema, j);
        if (keep.includes(schema[j].name)) {
          kept.push(...schema.slice(j, childEnd));
          children++;
        }
        j = childEnd;
      }
      out.push({ ...schema[i], num_children: children }, ...kept);
    } else {
      for (let j = i; j < end; j++) out.push(schema[j]);
    }
    i = end;
  }
  const row_groups = metadata.row_groups.map((group) => ({
    ...group,
    columns: group.columns.filter((chunk) => {
      const path = chunk.meta_data?.path_in_schema;
      return !path || path[0] !== column || keep.includes(path[1]);
    }),
  }));
  return { ...metadata, schema: out, row_groups };
}

function isMap(element: SchemaElement): boolean {
  return element.converted_type === 'MAP' || element.logical_type?.type === 'MAP';
}

function geometryChunk(group: RowGroup): ColumnMetaData | undefined {
  return group.columns.find((chunk) => chunk.meta_data?.path_in_schema[0] === 'geometry')?.meta_data;
}

/** Which columns and row groups of one file to read for `type` within `bounds`. */
export function planRead(metadata: FileMetaData, type: OvertureType, bounds: GeoBounds): ReadPlan {
  const top = new Map(parquetSchema(metadata).children.map((child) => [child.element.name, child]));
  for (const name of BASE_COLUMNS) {
    if (!top.has(name)) throw new Error(`the file has no ${name} column`);
  }
  let pruned = metadata;
  const columns: string[] = [];
  const mapColumns = new Set<string>();
  for (const name of [...BASE_COLUMNS, ...OVERTURE_COLUMNS[type]]) {
    const node = top.get(name);
    if (!node || columns.includes(name)) continue;
    const wanted = STRUCT_CHILDREN[name];
    if (wanted) {
      const present = node.children.map((child) => child.element.name).filter((child) => wanted.includes(child));
      if (!present.length) continue;
      pruned = pruneStruct(pruned, name, present);
    }
    columns.push(name);
    if (isMap(node.element)) mapColumns.add(name);
  }
  const selected = selectRowGroups(pruned, bounds, columns.filter((name) => name !== 'geometry'));
  let rows = 0;
  const groups = selected.map((span) => {
    const start = rows;
    rows += span.rowEnd - span.rowStart;
    const geometry = geometryChunk(pruned.row_groups[span.index]);
    return { ...span, rowStart: start, rowEnd: rows, geometryBytes: geometry ? Number(geometry.total_compressed_size) : 0 };
  });
  const trimmed = { ...pruned, num_rows: BigInt(rows), row_groups: selected.map((span) => pruned.row_groups[span.index]) };
  return {
    metadata: trimmed,
    columns,
    mapColumns,
    groups,
    bytes: groups.reduce((sum, group) => sum + group.bytes, 0),
    geometryBytes: groups.reduce((sum, group) => sum + group.geometryBytes, 0),
  };
}

/**
 * Rough share of a chunk the wanted rows need, before its pages are known:
 * the chunk is cut by row into equal parts of about 500 KB and the parts
 * holding a wanted row are counted. Overture's pages are a few hundred KB to
 * 3 MB.
 */
export function estimateShare(wanted: readonly number[], rows: number, bytes: number): number {
  const parts = Math.max(2, Math.round(bytes / 500e3));
  const hit = new Set<number>();
  for (const row of wanted) hit.add(Math.min(parts - 1, Math.floor((row / rows) * parts)));
  return hit.size / parts;
}

/** BigInt to number, typed arrays to plain arrays, all the way down. Other values are returned as they are. */
export function plainValue(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const item = plainValue(value[i]);
      if (item !== value[i]) (out ??= value.slice())[i] = item;
    }
    return out ?? value;
  }
  if (ArrayBuffer.isView(value)) {
    return value instanceof DataView ? value : Array.from(value as unknown as ArrayLike<number | bigint>, (n) => Number(n));
  }
  if (value instanceof Date) return value;
  let out: Record<string, unknown> | undefined;
  for (const [key, item] of Object.entries(value)) {
    const plain = plainValue(item);
    if (plain !== item) (out ??= { ...value })[key] = plain;
  }
  return out ?? value;
}

function isPairs(value: unknown[]): boolean {
  return value.every((item) => item !== null && typeof item === 'object' && 'key' in item);
}

/**
 * A Parquet MAP as a plain `{ key: value }` object. hyparquet already returns
 * one for a MAP annotated the usual way. This also accepts the key/value
 * pairs it returns for a MAP it did not recognise.
 */
export function plainMap(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const item of value) {
      if (Array.isArray(item) && item.length === 2) out[String(item[0])] = plainValue(item[1]);
      else if (item !== null && typeof item === 'object' && 'key' in item) {
        const pair = item as { key: unknown; value?: unknown };
        out[String(pair.key)] = plainValue(pair.value ?? null);
      }
    }
    return out;
  }
  const entries = Object.entries(value);
  if (entries.length === 1 && Array.isArray(entries[0][1]) && isPairs(entries[0][1])) return plainMap(entries[0][1]);
  return plainValue(value) as Record<string, unknown>;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'object' || Array.isArray(value) || ArrayBuffer.isView(value) || value instanceof Date) return false;
  return Object.values(value).every((item) => item === null || item === undefined);
}

function emptyStats(): OvertureTypeStats {
  return { files: 0, rowGroups: 0, rowsRead: 0, rowsKept: 0, features: 0, skipped: 0, bytes: 0, cachedBytes: 0, seconds: 0 };
}

function perType<T>(make: (type: OvertureType) => T): Record<OvertureType, T> {
  return Object.fromEntries(OVERTURE_TYPES.map((type) => [type, make(type)])) as Record<OvertureType, T>;
}

class Tracker {
  readonly stats = perType(emptyStats);
  private readonly pending = perType(() => 0);
  private readonly started = performance.now();
  private bytes = 0;
  private total = 0;
  private kept = 0;
  private verb = '';
  private message = '';
  private type: OvertureType | undefined;
  private last = -Infinity;

  constructor(
    private readonly types: readonly OvertureType[],
    private readonly listener?: (progress: OvertureProgress) => void,
  ) {}

  say(message: string, type?: OvertureType): void {
    this.message = message;
    this.type = type;
    this.emit(true);
  }

  /** Sets the estimate to `bytes` more than what has been read so far. */
  expectMore(bytes: number): void {
    this.total = this.bytes + bytes;
  }

  add(type: OvertureType, bytes: number, cached: boolean): void {
    this.bytes += bytes;
    this.stats[type].bytes += bytes;
    if (cached) this.stats[type].cachedBytes += bytes;
    this.emit(false);
  }

  /** Starts a pass over row groups, `counts` of them per type. */
  begin(verb: string, counts: Record<OvertureType, number>): void {
    this.verb = verb;
    for (const type of this.types) {
      this.pending[type] = counts[type];
      if (!counts[type] && !this.stats[type].seconds) this.stats[type].seconds = this.elapsed();
    }
    this.update(true);
  }

  groupRead(type: OvertureType, rows: number, kept: number, skipped: number): void {
    this.stats[type].rowsRead += rows;
    this.stats[type].rowsKept += kept;
    this.stats[type].skipped += skipped;
    this.kept += kept;
  }

  groupDone(type: OvertureType, skipped = 0): void {
    this.stats[type].skipped += skipped;
    this.kept -= skipped;
    if (--this.pending[type] === 0) this.stats[type].seconds = this.elapsed();
    this.update(false);
  }

  finish(features: number): void {
    this.kept = features;
    this.total = this.bytes;
    this.say(`Downloaded ${features.toLocaleString('en-US')} features`);
  }

  private update(force: boolean): void {
    const current = this.types.find((t) => this.pending[t] > 0);
    if (current && (force || current !== this.type)) this.say(`${this.verb} ${OVERTURE_LABEL[current]}`, current);
    else this.emit(false);
  }

  private elapsed(): number {
    return (performance.now() - this.started) / 1000;
  }

  private emit(force: boolean): void {
    if (!this.listener) return;
    const now = performance.now();
    if (!force && now - this.last < PROGRESS_INTERVAL_MS) return;
    this.last = now;
    this.listener({
      type: this.type,
      message: this.message,
      bytes: this.bytes,
      bytesTotal: Math.max(this.total, this.bytes),
      features: this.kept,
    });
  }
}

function checkBounds(bounds: GeoBounds): void {
  const { west, south, east, north } = bounds;
  if (![west, south, east, north].every(Number.isFinite)) throw new Error('The area bounds are not numbers');
  if (west > east) throw new Error('Areas that cross the antimeridian are not supported');
  if (west === east || south >= north) throw new Error('The area bounds are empty');
  if (west < -180 || east > 180 || south < -90 || north > 90) throw new Error('The area bounds are outside the world');
}

/**
 * Warnings for the requested types the release has no files for. Throws when
 * one of them is a type the model can't be built without.
 */
export function checkTypes(index: ReleaseIndex, types: readonly OvertureType[]): string[] {
  const listed = new Set(index.files.map((file) => file.type));
  const missing = types.filter((type) => !listed.has(type));
  const essential = missing.find((type) => ESSENTIAL_TYPES.includes(type));
  if (essential) throw new Error(`Overture release ${index.release} has no ${OVERTURE_LABEL[essential]} data, so the model can't be built.`);
  return missing.map((type) => `Overture release ${index.release} has no ${OVERTURE_LABEL[type]} data, so the model was built without it.`);
}

function boxMeets(box: readonly number[], bounds: GeoBounds): boolean {
  return box[0] < bounds.east && box[2] > bounds.west && box[1] < bounds.north && box[3] > bounds.south;
}

interface OpenFile {
  type: OvertureType;
  file: IndexedFile;
  buffer: RemoteFile;
  /** The same file read past the cache, which replaces what was cached. */
  fresh: RemoteFile;
  plan: ReadPlan;
  /** Geometry has one value per row, so its pages can be read on their own. */
  flatGeometry: boolean;
}

interface KeptRow {
  row: number;
  id: string;
  bbox: [number, number, number, number];
  props: Record<string, unknown>;
}

interface Job {
  open: OpenFile;
  group: PlannedGroup;
  rowGroup: RowGroup;
  kept: KeptRow[];
  /** Geometry reads for the kept rows. */
  reads: ChunkRead[];
}

function fileName(file: IndexedFile): string {
  return file.href.slice(file.href.lastIndexOf('/') + 1);
}

// hyparquet's own default.
const DEFAULT_FOOTER_GUESS = 1 << 19;

function footerGuess(type: OvertureType, file: IndexedFile, size: number): number {
  const guess = file.rowGroups > 0 ? 16384 + file.rowGroups * FOOTER_BYTES_PER_GROUP[type] : DEFAULT_FOOTER_GUESS;
  return Math.min(size, guess);
}

function isDownloadError(error: unknown): boolean {
  return error instanceof HttpError || error instanceof NetworkError;
}

function describe(error: unknown, signal: AbortSignal, what: string): unknown {
  if (signal.aborted || !(error instanceof Error) || isDownloadError(error) || error instanceof AreaTooLargeError) return error;
  return new Error(`Could not read ${what}: ${error.message}`, { cause: error });
}

/**
 * Runs `read` on the file, and once more past the cache when what it read
 * does not parse. Wrong cached bytes of the right length would otherwise
 * break the area for good.
 */
async function withFreshRetry<T>(
  files: { buffer: RemoteFile; fresh: RemoteFile },
  signal: AbortSignal,
  read: (buffer: RemoteFile) => Promise<T>,
): Promise<T> {
  try {
    return await read(files.buffer);
  } catch (error) {
    if (signal.aborted || isDownloadError(error) || error instanceof AreaTooLargeError) throw error;
    return read(files.fresh);
  }
}

async function openFile(
  type: OvertureType,
  file: IndexedFile,
  bounds: GeoBounds,
  signal: AbortSignal,
  tracker: Tracker,
): Promise<OpenFile> {
  try {
    const size = file.size > 0 ? file.size : await fetchByteLength(file.href, signal);
    const onBytes = (bytes: number, cached: boolean) => tracker.add(type, bytes, cached);
    const files = {
      buffer: remoteFile(file.href, size, { signal, onBytes }),
      fresh: remoteFile(file.href, size, { signal, onBytes, refresh: true }),
    };
    const plan = await withFreshRetry(files, signal, async (buffer) =>
      planRead(await parquetMetadataAsync(buffer, { initialFetchSize: footerGuess(type, file, size) }), type, bounds),
    );
    return { type, file, ...files, plan, flatGeometry: isFlat(plan.metadata, 'geometry') };
  } catch (error) {
    throw describe(error, signal, `the Overture ${type} file ${fileName(file)}`);
  }
}

/** First pass: every selected column but geometry, and from those the rows to keep. */
async function readAttributes(
  job: Job,
  buffer: RemoteFile,
  bounds: GeoBounds,
  keep: OvertureFilter | undefined,
  signal: AbortSignal,
  tracker: Tracker,
): Promise<void> {
  const { open, group } = job;
  const { type, plan } = open;
  job.kept = [];
  const rows = await parquetReadObjects({
    file: buffer,
    metadata: plan.metadata,
    columns: plan.columns.filter((column) => column !== 'geometry'),
    rowStart: group.rowStart,
    rowEnd: group.rowEnd,
    compressors,
  });
  signal.throwIfAborted();
  const propColumns = plan.columns.filter((column) => !BASE_COLUMNS.includes(column));
  let skipped = 0;
  rows.forEach((row, index) => {
    const box = row.bbox as Record<string, unknown> | null | undefined;
    if (!box) return;
    const bbox: [number, number, number, number] = [toNumber(box.xmin), toNumber(box.ymin), toNumber(box.xmax), toNumber(box.ymax)];
    if (!boxMeets(bbox, bounds)) return;
    if (typeof row.id !== 'string') {
      skipped++;
      return;
    }
    const values: Record<string, unknown> = {};
    for (const column of propColumns) {
      const value = row[column];
      if (isEmpty(value)) continue;
      values[column] = plan.mapColumns.has(column) ? plainMap(value) : plainValue(value);
    }
    if (keep && !keep(type, values, bbox)) return;
    job.kept.push({ row: index, id: row.id, bbox, props: values });
  });
  tracker.groupRead(type, rows.length, job.kept.length, skipped);
}

/** Which geometry the kept rows need: the whole chunk, or only the pages holding them. */
async function planGeometry(job: Job): Promise<void> {
  if (!job.kept.length) return;
  const chunk = geometryChunk(job.rowGroup);
  if (!chunk) throw new Error('a row group has no geometry chunk');
  const range = chunkRange(chunk);
  const size = range[1] - range[0];
  const wanted = job.kept.map((k) => k.row);
  job.reads = wholeChunk(range, wanted);
  const rows = job.group.rowEnd - job.group.rowStart;
  if (!job.open.flatGeometry || size < pageReading.minChunkBytes) return;
  if (estimateShare(wanted, rows, size) > pageReading.maxEstimatedShare) return;
  const layout = await walkPages((start, end) => job.open.buffer.slice(start, end), range, rows);
  const paged = layout && planReads(layout, wanted);
  if (paged && readsBytes(paged) < size * pageReading.maxPagedShare) job.reads = paged;
}

function tryParseWkb(bytes: Uint8Array): Geometry | undefined {
  try {
    return parseWkb(bytes);
  } catch {
    return undefined;
  }
}

/** Second pass: the geometry of the kept rows. */
async function readGeometry(job: Job, buffer: RemoteFile): Promise<{ features: OvertureFeature[]; skipped: number }> {
  const { open } = job;
  const chunk = geometryChunk(job.rowGroup);
  if (!chunk) throw new Error('a row group has no geometry chunk');
  const decoder = columnDecoder(open.plan.metadata, chunk, RAW_GEOMETRY);
  const values = await readRows((start, end) => buffer.slice(start, end), decoder, job.reads);
  const features: OvertureFeature[] = [];
  let skipped = 0;
  job.kept.forEach((kept, i) => {
    const wkb = values[i];
    const geometry = wkb instanceof Uint8Array ? tryParseWkb(wkb) : undefined;
    if (!geometry) {
      skipped++;
      return;
    }
    features.push({ id: kept.id, type: open.type, geometry, bbox: kept.bbox, props: kept.props });
  });
  return { features, skipped };
}

/** Runs `run` over `items` in `order`, at most `limit` at a time. Results keep the order of `items`. */
async function mapLimit<T, R>(
  items: readonly T[],
  order: readonly number[],
  limit: number,
  run: (item: T) => Promise<R>,
  signal: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < order.length) {
      signal.throwIfAborted();
      const i = order[next++];
      results[i] = await run(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Indices of `items`, biggest `weight` first. */
function biggestFirst<T>(items: readonly T[], weight: (item: T) => number): number[] {
  return items.map((_, i) => i).sort((a, b) => weight(items[b]) - weight(items[a]) || a - b);
}

interface Budget {
  types: readonly OvertureType[];
  maxType: number;
  maxTotal: number;
}

function checkBudget(bytes: Record<OvertureType, number>, budget: Budget, atLeast = false): void {
  const planned: Partial<Record<OvertureType, number>> = {};
  let total = 0;
  for (const type of budget.types) {
    planned[type] = bytes[type];
    total += bytes[type];
  }
  const over = budget.types.find((type) => bytes[type] > budget.maxType);
  if (over) throw new AreaTooLargeError(bytes[over], planned, over, atLeast);
  if (total > budget.maxTotal) throw new AreaTooLargeError(total, planned, undefined, atLeast);
}

function jobName(job: Job): string {
  return `row group ${job.group.index} of the Overture ${job.open.type} file ${fileName(job.open.file)}`;
}

/**
 * Downloads the Overture features of `types` whose bbox meets `bounds` and
 * that `keep` accepts. Files and row groups are read concurrently, within the
 * request limit. The result is in a fixed order (type, file URL, row)
 * whatever order the downloads finish in, and holds each id once per type.
 * A type the release has no files for comes back empty with a warning,
 * unless it is buildings, roads or water.
 *
 * Throws AreaTooLargeError before any geometry is downloaded when the plan
 * passes the limits, and OvertureUnavailableError when Overture's servers do
 * not answer. Both messages can be shown as they are.
 */
export async function fetchOverture(options: FetchOvertureOptions): Promise<OvertureData> {
  const { bounds, keep } = options;
  checkBounds(bounds);
  const requested = options.types ?? OVERTURE_TYPES;
  const types = OVERTURE_TYPES.filter((type) => requested.includes(type));
  const budget: Budget = { types, maxType: options.maxTypeBytes ?? MAX_TYPE_BYTES, maxTotal: options.maxTotalBytes ?? MAX_TOTAL_BYTES };
  const outer = options.signal;
  outer?.throwIfAborted();
  // Stops every other download as soon as one fails or the caller cancels.
  const controller = new AbortController();
  const forward = () => controller.abort(outer?.reason);
  outer?.addEventListener('abort', forward, { once: true });
  const signal = controller.signal;
  const tracker = new Tracker(types, options.onProgress);
  const readSoFar = (type: OvertureType) => tracker.stats[type].bytes;
  try {
    let index: ReleaseIndex;
    if (options.release === undefined) {
      tracker.say('Finding the latest Overture release');
      index = await getLatestIndex(signal);
    } else {
      tracker.say('Reading the Overture file index');
      index = await getReleaseIndex(options.release, signal);
    }
    const release = index.release;
    const warnings = checkTypes(index, types);

    const selected: { type: OvertureType; file: IndexedFile }[] = [];
    let footers = 0;
    for (const type of types) {
      for (const file of index.files) {
        if (file.type !== type || !boxMeets(file.bbox, bounds)) continue;
        selected.push({ type, file });
        tracker.stats[type].files++;
        footers += footerGuess(type, file, file.size || DEFAULT_FOOTER_GUESS);
      }
    }
    tracker.expectMore(footers);
    tracker.say('Finding the data for this area');
    const opened = await Promise.all(selected.map(({ type, file }) => openFile(type, file, bounds, signal, tracker)));

    // Footers, every first-pass chunk and the geometry planned so far never
    // exceed the final plan, so an area over budget on those alone is refused
    // at once, or part way through the first pass.
    const attributes = perType(() => 0);
    let geometryMost = 0;
    for (const open of opened) {
      attributes[open.type] += open.plan.bytes;
      geometryMost += open.plan.geometryBytes;
      tracker.stats[open.type].rowGroups += open.plan.groups.length;
    }
    const geometry = perType(() => 0);
    const floor = perType((type) => readSoFar(type) + attributes[type]);
    checkBudget(floor, budget, true);

    const jobs: Job[] = opened.flatMap((open) =>
      open.plan.groups.map((group, i) => ({ open, group, rowGroup: open.plan.metadata.row_groups[i], kept: [], reads: [] })),
    );
    tracker.expectMore(types.reduce((sum, type) => sum + attributes[type], 0) + geometryMost);
    tracker.begin('Reading', perType((type) => jobs.filter((job) => job.open.type === type).length));
    await mapLimit(
      jobs,
      biggestFirst(jobs, (job) => job.group.bytes + job.group.geometryBytes),
      GROUPS_AT_ONCE,
      async (job) => {
        try {
          await withFreshRetry(job.open, signal, (buffer) => readAttributes(job, buffer, bounds, keep, signal, tracker));
          await planGeometry(job);
        } catch (error) {
          throw describe(error, signal, jobName(job));
        }
        geometry[job.open.type] += readsBytes(job.reads);
        checkBudget(perType((type) => floor[type] + geometry[type]), budget, true);
        tracker.groupDone(job.open.type);
      },
      signal,
    );

    // All the geometry to download is known now, and none of it is read yet.
    checkBudget(perType((type) => readSoFar(type) + geometry[type]), budget);

    const withRows = jobs.filter((job) => job.kept.length);
    tracker.expectMore(types.reduce((sum, type) => sum + geometry[type], 0));
    tracker.begin('Downloading', perType((type) => withRows.filter((job) => job.open.type === type).length));
    const results = await mapLimit(
      withRows,
      biggestFirst(withRows, (job) => readsBytes(job.reads)),
      GROUPS_AT_ONCE,
      async (job) => {
        let result: { features: OvertureFeature[]; skipped: number };
        try {
          result = await withFreshRetry(job.open, signal, (buffer) => readGeometry(job, buffer));
        } catch (error) {
          throw describe(error, signal, jobName(job));
        }
        tracker.groupDone(job.open.type, result.skipped);
        return result;
      },
      signal,
    );

    const features = perType((): OvertureFeature[] => []);
    const seen = perType(() => new Set<string>());
    withRows.forEach((job, i) => {
      const type = job.open.type;
      for (const feature of results[i].features) {
        if (seen[type].has(feature.id)) continue;
        seen[type].add(feature.id);
        features[type].push(feature);
      }
    });
    let count = 0;
    let bytes = 0;
    for (const type of OVERTURE_TYPES) {
      tracker.stats[type].features = features[type].length;
      count += features[type].length;
      bytes += tracker.stats[type].bytes;
    }
    tracker.finish(count);
    return { release, bounds: { ...bounds }, features, bytes, stats: tracker.stats, warnings };
  } catch (error) {
    controller.abort(error);
    throw outer?.aborted ? outer.reason : error;
  } finally {
    outer?.removeEventListener('abort', forward);
  }
}
