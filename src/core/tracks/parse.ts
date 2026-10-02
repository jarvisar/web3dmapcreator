// Reads route files: GPX, KML, KMZ, TCX, GeoJSON and FIT, gzipped or not, or
// a zip of them. Every track, route and line in one file becomes one route.
// Waypoints and other points are skipped. Mostly from SVGmap, which reads
// the same files apart from FIT.

import { gunzipSync, strFromU8, unzipSync } from 'fflate';
import type { LonLat } from '../types';
import { FitError, isFit, readFit } from './fitfile';
import { distanceM, tidyTrackName } from './track';
import { walkXml } from './xml';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_POINTS = 2_000_000;
const MAX_UNPACKED = 200 * 1024 * 1024;
// Route files in one zip, past which the rest are left out.
const MAX_IN_ZIP = 20;
// Pieces of one recorded track closer than this are joined. Watches start a
// new segment after a pause, and a gap in the line looks like a mistake.
const TRACK_JOIN_M = 500;
// Separate lines are only joined where they meet.
const LINE_JOIN_M = 1;

export const TRACK_FILE_TYPES = ['gpx', 'kml', 'kmz', 'tcx', 'fit', 'geojson', 'json'];
/** For a file input's accept. The .gz and .zip forms are taken too. */
export const TRACK_ACCEPT = [...TRACK_FILE_TYPES, 'gz', 'zip'].map((ext) => `.${ext}`).join(',');

const NOT_A_ROUTE = "This doesn't look like a GPX, KML, KMZ, TCX, FIT or GeoJSON file.";

export class TrackFileError extends Error {}

export interface ParsedTrack {
  name: string;
  lines: LonLat[][];
}

export interface TrackFile {
  tracks: ParsedTrack[];
  /** What in a zip was left out, worded to follow the zip's name. */
  skipped: string[];
}

export const TOO_BIG = `This file is over ${MAX_FILE_BYTES / 1024 / 1024} MB.`;

// The lines of one recorded track, or of one drawn line or shape.
interface Chunk {
  lines: LonLat[][];
  track: boolean;
}

interface FileContents {
  name: string;
  chunks: Chunk[];
  // Waypoints and other points, only counted to explain an empty result.
  points: number;
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

function readGpx(text: string): FileContents {
  const chunks: Chunk[] = [];
  const stack: string[] = [];
  let chunk: Chunk | null = null;
  let line: LonLat[] | null = null;
  let buffer = '';
  let fileName = '';
  let trackName = '';
  let points = 0;
  walkXml(text, {
    open(name, attrs) {
      stack.push(name);
      buffer = '';
      if (name === 'trk' || name === 'rte') {
        chunk = { lines: [], track: name === 'trk' };
        chunks.push(chunk);
        if (name === 'rte') {
          line = [];
          chunk.lines.push(line);
        }
      } else if (name === 'trkseg') {
        line = [];
        if (!chunk) {
          chunk = { lines: [], track: true };
          chunks.push(chunk);
        }
        chunk.lines.push(line);
      } else if (name === 'trkpt' || name === 'rtept') {
        line?.push([parseFloat(attrs.lon), parseFloat(attrs.lat)]);
      } else if (name === 'wpt') {
        points++;
      }
    },
    close(name) {
      const parent = stack[stack.length - 2];
      if (name === 'name') {
        // GPX 1.0 puts the file's name straight under gpx.
        if ((parent === 'metadata' || parent === 'gpx') && !fileName) fileName = collapse(buffer);
        if ((parent === 'trk' || parent === 'rte') && !trackName) trackName = collapse(buffer);
      } else if (name === 'trk' || name === 'rte') {
        chunk = null;
        line = null;
      } else if (name === 'trkseg') {
        line = null;
      }
      stack.pop();
    },
    text(t) {
      buffer += t;
    },
  });
  return { name: fileName || trackName, chunks, points };
}

function kmlCoordinates(text: string): LonLat[] {
  const tuples = text.replace(/\s*,\s*/g, ',').trim().split(/\s+/);
  return tuples.map((tuple) => {
    const [lon, lat] = tuple.split(',');
    return [parseFloat(lon), parseFloat(lat)];
  });
}

function readKml(text: string): FileContents {
  const chunks: Chunk[] = [];
  const stack: string[] = [];
  let buffer = '';
  let documentName = '';
  let placemarkName = '';
  let points = 0;
  // gx:MultiTrack and gx:Track, Google Earth's recorded tracks.
  let multi: Chunk | null = null;
  let track: LonLat[] | null = null;
  walkXml(text, {
    open(name) {
      stack.push(name);
      buffer = '';
      if (name === 'MultiTrack') {
        multi = { lines: [], track: true };
        chunks.push(multi);
      } else if (name === 'Track') {
        track = [];
        if (multi) multi.lines.push(track);
        else chunks.push({ lines: [track], track: true });
      }
    },
    close(name) {
      const parent = stack[stack.length - 2];
      if (name === 'coordinates') {
        if (parent === 'LineString' || parent === 'LinearRing') chunks.push({ lines: [kmlCoordinates(buffer)], track: false });
        else if (parent === 'Point') points++;
      } else if (name === 'coord' && track) {
        const [lon, lat] = buffer.trim().split(/\s+/);
        track.push([parseFloat(lon), parseFloat(lat)]);
      } else if (name === 'Track') {
        track = null;
      } else if (name === 'MultiTrack') {
        multi = null;
      } else if (name === 'name') {
        if ((parent === 'Document' || parent === 'Folder') && !documentName) documentName = collapse(buffer);
        if (parent === 'Placemark' && !placemarkName) placemarkName = collapse(buffer);
      }
      stack.pop();
    },
    text(t) {
      buffer += t;
    },
  });
  return { name: documentName || placemarkName, chunks, points };
}

function readTcx(text: string): FileContents {
  const chunks: Chunk[] = [];
  const stack: string[] = [];
  let chunk: Chunk | null = null;
  let line: LonLat[] | null = null;
  let buffer = '';
  let name = '';
  let lat = NaN;
  let lon = NaN;
  let points = 0;
  walkXml(text, {
    open(element) {
      stack.push(element);
      buffer = '';
      if (element === 'Activity' || element === 'Course') {
        chunk = { lines: [], track: true };
        chunks.push(chunk);
      } else if (element === 'Track') {
        line = [];
        if (!chunk) {
          chunk = { lines: [], track: true };
          chunks.push(chunk);
        }
        chunk.lines.push(line);
      } else if (element === 'Trackpoint') {
        lat = NaN;
        lon = NaN;
      } else if (element === 'CoursePoint') {
        points++;
      }
    },
    close(element) {
      const parent = stack[stack.length - 2];
      if (element === 'LatitudeDegrees') lat = parseFloat(buffer);
      else if (element === 'LongitudeDegrees') lon = parseFloat(buffer);
      // A trackpoint without a position, like heart rate on a treadmill, is skipped.
      else if (element === 'Trackpoint' && line && Number.isFinite(lat) && Number.isFinite(lon)) line.push([lon, lat]);
      else if (element === 'Track') line = null;
      else if (element === 'Activity' || element === 'Course') chunk = null;
      else if (element === 'Name' && parent === 'Course' && !name) name = collapse(buffer);
      stack.pop();
    },
    text(t) {
      buffer += t;
    },
  });
  return { name, chunks, points };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? collapse(value) : '');
const num = (value: unknown): number => (typeof value === 'number' ? value : NaN);

function readGeoJson(source: string): FileContents {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new TrackFileError("This GeoJSON file couldn't be read.");
  }
  const chunks: Chunk[] = [];
  let points = 0;
  // Not in the spec, but plenty of tools write it.
  let name = isObject(value) ? text(value.name) : '';
  const line = (coordinates: unknown): LonLat[] => list(coordinates).map((p) => (Array.isArray(p) ? [num(p[0]), num(p[1])] : [NaN, NaN]));
  const geometry = (g: unknown, track: boolean) => {
    if (!isObject(g)) return;
    switch (g.type) {
      case 'LineString':
        chunks.push({ lines: [line(g.coordinates)], track });
        break;
      case 'MultiLineString':
        chunks.push({ lines: list(g.coordinates).map(line), track });
        break;
      case 'Polygon':
        for (const ring of list(g.coordinates)) chunks.push({ lines: [line(ring)], track: false });
        break;
      case 'MultiPolygon':
        for (const polygon of list(g.coordinates)) for (const ring of list(polygon)) chunks.push({ lines: [line(ring)], track: false });
        break;
      case 'GeometryCollection':
        for (const child of list(g.geometries)) geometry(child, track);
        break;
      case 'Point':
        points++;
        break;
      case 'MultiPoint':
        points += list(g.coordinates).length;
        break;
    }
  };
  const visit = (node: unknown) => {
    if (!isObject(node)) return;
    if (node.type === 'FeatureCollection') {
      for (const feature of list(node.features)) visit(feature);
    } else if (node.type === 'Feature') {
      const props = isObject(node.properties) ? node.properties : {};
      if (!name) name = text(props.name) || text(props.title);
      // Converted GPS tracks (togeojson and the like) keep the point times.
      // Their pieces are joined like a GPX track's segments.
      geometry(node.geometry, 'coordTimes' in props || 'coordinateProperties' in props);
    } else {
      geometry(node, false);
    }
  };
  visit(value);
  return { name, chunks, points };
}

function readXml(source: string): FileContents {
  const root = /<(?![?!])([^\s/>]+)/.exec(source)?.[1] ?? '';
  switch (root.slice(root.indexOf(':') + 1)) {
    case 'gpx':
      return readGpx(source);
    case 'kml':
      return readKml(source);
    case 'TrainingCenterDatabase':
      return readTcx(source);
    default:
      throw new TrackFileError(NOT_A_ROUTE);
  }
}

// Drops points off the globe and repeats, and splits where the line jumps the
// 180th meridian so it doesn't cross the whole world.
function cleanLine(raw: readonly LonLat[]): LonLat[][] {
  const out: LonLat[][] = [];
  let line: LonLat[] = [];
  for (const [lon, lat] of raw) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) continue;
    const prev = line[line.length - 1];
    if (prev && prev[0] === lon && prev[1] === lat) continue;
    if (prev && Math.abs(lon - prev[0]) > 180) {
      if (line.length >= 2) out.push(line);
      line = [];
    }
    line.push([lon, lat]);
  }
  if (line.length >= 2) out.push(line);
  return out;
}

function assemble(chunks: readonly Chunk[]): LonLat[][] {
  let total = 0;
  for (const chunk of chunks) for (const line of chunk.lines) total += line.length;
  if (total > MAX_POINTS) throw new TrackFileError(`This file has over ${MAX_POINTS.toLocaleString('en')} points, which is more than a route can have.`);
  const out: LonLat[][] = [];
  for (const chunk of chunks) {
    let first = true;
    for (const raw of chunk.lines) {
      for (const line of cleanLine(raw)) {
        const last = out[out.length - 1];
        const end = last?.[last.length - 1];
        const limit = chunk.track && !first ? TRACK_JOIN_M : LINE_JOIN_M;
        if (end && Math.abs(end[0] - line[0][0]) <= 180 && distanceM(end, line[0]) <= limit) {
          const repeat = end[0] === line[0][0] && end[1] === line[0][1];
          for (let i = repeat ? 1 : 0; i < line.length; i++) last.push(line[i]);
        } else {
          out.push(line);
        }
        first = false;
      }
    }
  }
  return out;
}

const signature = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));

function contentsOf(data: Uint8Array): FileContents {
  const buffer = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? (data.buffer as ArrayBuffer) : data.slice().buffer;
  if (isFit(buffer)) {
    try {
      const { lines, name } = readFit(buffer);
      return { name, chunks: [{ lines, track: true }], points: 0 };
    } catch (error) {
      throw error instanceof FitError ? new TrackFileError(error.message) : error;
    }
  }
  const source = strFromU8(data).replace(/^﻿/, '');
  const start = /\S/.exec(source.slice(0, 4096))?.[0];
  if (start === '{' || start === '[') return readGeoJson(source);
  if (start === '<') return readXml(source);
  throw new TrackFileError(NOT_A_ROUTE);
}

function toTrack(contents: FileContents, fileName: string): ParsedTrack {
  const lines = assemble(contents.chunks);
  if (lines.length === 0) {
    throw new TrackFileError(
      contents.points > 0 ? 'This file only has points or waypoints in it. A route needs a track or a line.' : 'There are no tracks, routes or lines in this file.',
    );
  }
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.gz$/i, '');
  return { name: tidyTrackName(contents.name) || tidyTrackName(base) || 'Route', lines };
}

function gunzip(data: Uint8Array): Uint8Array {
  // The size gzip records at the end, checked before inflating a bomb.
  const size = data.length >= 4 ? new DataView(data.buffer, data.byteOffset + data.length - 4, 4).getUint32(0, true) : 0;
  if (size > MAX_UNPACKED) throw new TrackFileError('This compressed file is too big to read.');
  try {
    return gunzipSync(data);
  } catch {
    throw new TrackFileError("This compressed file couldn't be opened.");
  }
}

const ROUTE_NAME = new RegExp(`\\.(${TRACK_FILE_TYPES.join('|')})(\\.gz)?$`, 'i');

// A KMZ is a zip with the KML in it, doc.kml by name. Other zips can hold
// any number of route files, each of which becomes a route.
function fromZip(data: Uint8Array, fileName: string): TrackFile {
  let files: Record<string, Uint8Array>;
  let unpacked = 0;
  try {
    files = unzipSync(data, {
      filter: (file) => {
        if (file.name.startsWith('__MACOSX/') || !ROUTE_NAME.test(file.name)) return false;
        unpacked += file.originalSize;
        return unpacked <= MAX_UNPACKED;
      },
    });
  } catch {
    throw new TrackFileError(`This ${/\.kmz$/i.test(fileName) ? 'KMZ' : 'zip'} file couldn't be opened.`);
  }
  if (unpacked > MAX_UNPACKED) throw new TrackFileError('The files in this zip are too big to read.');
  const names = Object.keys(files).sort((a, b) => Number(/(^|\/)doc\.kml$/i.test(b)) - Number(/(^|\/)doc\.kml$/i.test(a)) || a.split('/').length - b.split('/').length || a.localeCompare(b));
  if (!names.length) throw new TrackFileError(/\.kmz$/i.test(fileName) ? 'This KMZ file has no KML in it.' : 'This zip has no route files in it.');
  // A KMZ's other KML files are usually overlays, not more routes.
  const chosen = /\.kmz$/i.test(fileName) ? names.slice(0, 1) : names.slice(0, MAX_IN_ZIP);
  const tracks: ParsedTrack[] = [];
  const skipped: string[] = [];
  let failure: unknown = null;
  for (const name of chosen) {
    try {
      const bytes = /\.gz$/i.test(name) ? gunzip(files[name]) : files[name];
      tracks.push(toTrack(contentsOf(bytes), chosen.length === 1 && /\.kmz$/i.test(fileName) ? fileName : name));
    } catch (error) {
      failure ??= error;
      const member = name.replace(/^.*\//, '');
      skipped.push(error instanceof TrackFileError ? `${member} in it was left out. ${error.message}` : `${member} in it couldn't be read.`);
    }
  }
  if (!tracks.length) throw failure;
  if (chosen.length < names.length && chosen.length > 1) skipped.push(`only the first ${MAX_IN_ZIP} route files in it were read.`);
  return { tracks, skipped };
}

/** The routes in a file, usually one, and what in a zip of them was left out. Throws TrackFileError with a message to show. */
export function readTrackFile(fileName: string, data: ArrayBuffer): TrackFile {
  if (data.byteLength > MAX_FILE_BYTES) throw new TrackFileError(TOO_BIG);
  let bytes: Uint8Array = new Uint8Array(data);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzip(bytes);
  if (signature(bytes, 0, 4) === 'PK\x03\x04') return fromZip(bytes, fileName);
  return { tracks: [toTrack(contentsOf(bytes), fileName)], skipped: [] };
}

/** Just the routes, for the scripts. */
export function parseTrackFile(fileName: string, data: ArrayBuffer): ParsedTrack[] {
  return readTrackFile(fileName, data).tracks;
}
