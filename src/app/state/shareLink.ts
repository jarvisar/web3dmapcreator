// Share links carry the area in the URL hash:
// #a=<lon>,<lat>,<widthM>,<heightM>,<rotationDeg>,<shape>
// A rounded area adds its corner radius as a seventh value. An SVG map adds
// o=svg, and a copied link s=<settings> (see svgmap/share.ts). Links from
// the old SVGmap site only have s=. A copied link also carries the model's
// edits (e=) and imported routes (t=), or the SVG map's picked roads (p=),
// deflated, unless that would make it too long to paste anywhere.

import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';
import { hasEdits, sanitizeEdits, type ModelEdits } from '../../core/edit/types';
import type { AreaShape, AreaSpec } from '../../core/settings';
import { sanitizeLines, sanitizeRoutes, type LonLatLine, type SvgRoute } from '../../core/svgmap/routes';
import { encodeTrack, decodeTrack, sanitizeTracks, type Track } from '../../core/tracks/track';
import { SHAPES } from '../lib/area';
import { type SharedSvg, decodeSvgSettings, encodeSvgSettings } from '../svgmap/share';
import type { SvgSettings } from '../svgmap/settings';

/** Longest e= or p= a link gets. Chat apps and mail cut longer links off. */
export const MAX_LINK_EXTRA = 6000;
// The longest read back, well past what a copied link carries, and the most
// it may inflate to. A crafted 117 KB link inflated to 700 MB, and since a
// link stays in the address bar until it's read, every reload crashed again.
const MAX_READ = 4 * MAX_LINK_EXTRA;
export const MAX_UNPACKED = 2_000_000;

export interface SharedPicks {
  routes: SvgRoute[];
  hiddenLines: LonLatLine[];
}

function pack(value: unknown): string {
  const bytes = deflateSync(strToU8(JSON.stringify(value)), { level: 9 });
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unpack(value: string): unknown {
  if (value.length > MAX_READ) return null;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    // Inflated into a buffer one byte past the limit, so filling it means too much.
    const bytes = inflateSync(Uint8Array.from(binary, (c) => c.charCodeAt(0)), { out: new Uint8Array(MAX_UNPACKED + 1) });
    if (bytes.length > MAX_UNPACKED) return null;
    return JSON.parse(strFromU8(bytes));
  } catch {
    return null;
  }
}

export type Output = 'model' | 'svg';

const size = (metres: number) => String(Math.round(metres * 100) / 100);

export function formatAreaHash(area: AreaSpec, output: Output = 'model'): string {
  const values = [
    area.center[0].toFixed(6),
    area.center[1].toFixed(6),
    size(area.widthM),
    size(area.heightM),
    String(Math.round(area.rotationDeg * 10) / 10),
    area.shape,
  ];
  if (area.shape === 'rounded') values.push(String(Math.round(area.cornerRadius * 1000) / 1000));
  return `#a=${values.join(',')}${output === 'svg' ? '&o=svg' : ''}`;
}

export function parseAreaHash(hash: string): AreaSpec | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const value = params.get('a');
  if (!value) return null;
  const parts = value.split(',');
  if (parts.length < 6) return null;
  const [lon, lat, width, height, rotation] = parts.slice(0, 5).map(Number);
  const shape = parts[5] as AreaShape;
  const radius = parts.length > 6 ? Number(parts[6]) : 0.1;
  if (![lon, lat, width, height, rotation].every(Number.isFinite)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || !SHAPES.includes(shape)) return null;
  return {
    center: [lon, lat],
    widthM: width,
    heightM: height,
    rotationDeg: rotation,
    shape,
    cornerRadius: Number.isFinite(radius) ? radius : 0.1,
  };
}

export interface SharedLink {
  area: AreaSpec | null;
  output: Output | null;
  svg: SharedSvg | null;
  edits: ModelEdits | null;
  picks: SharedPicks | null;
  tracks: Track[] | null;
  /** Parts the link has but that couldn't be read, usually because it was cut short. */
  unreadable: ('edits' | 'picks' | 'tracks')[];
}

export function parseHash(hash: string): SharedLink {
  // Every part ends in a letter, digit, - or _. Anything after came with the
  // link from a sentence it was pasted in, like a full stop or a bracket,
  // which some apps escape.
  const clean = hash.replace(/(?:[^A-Za-z0-9_-]|%[0-9A-Fa-f]{2})+$/, '');
  const params = new URLSearchParams(clean.replace(/^#/, ''));
  const svg = params.get('s') ? decodeSvgSettings(params.get('s')!) : null;
  const o = params.get('o');
  const edits = params.get('e') ? readEdits(unpack(params.get('e')!)) : null;
  const picks = params.get('p') ? readPicks(unpack(params.get('p')!)) : null;
  const tracks = params.get('t') ? readTracks(unpack(params.get('t')!)) : null;
  return {
    area: parseAreaHash(clean),
    // An SVGmap link is always an SVG map. An area without o= was written in
    // model mode, and the recipient's saved mode would change its size.
    output: o === 'svg' || o === 'model' ? o : svg ? 'svg' : params.get('a') ? 'model' : null,
    svg,
    edits,
    picks,
    tracks,
    unreadable: [
      ...(params.get('e') && !edits ? ['edits' as const] : []),
      ...(params.get('p') && !picks ? ['picks' as const] : []),
      ...(params.get('t') && !tracks ? ['tracks' as const] : []),
    ],
  };
}

/** What to tell the user about a link that came with edits or picked roads that couldn't be read. */
export function unreadableText(link: SharedLink): string | null {
  if (!link.unreadable.length) return null;
  const what = link.unreadable.map((part) => (part === 'edits' ? 'edits to the model' : part === 'tracks' ? 'routes' : 'picked roads')).join(' and ');
  return `The ${what} in this link couldn't be read, so they were left out. The link may have been cut short when it was copied.`;
}

function readEdits(value: unknown): ModelEdits | null {
  return value ? sanitizeEdits(value) : null;
}

function readTracks(value: unknown): Track[] | null {
  if (!Array.isArray(value)) return null;
  const tracks = sanitizeTracks(value);
  return tracks.length ? tracks : null;
}

// Coarser simplifying tried in turn until the routes fit in a link, in
// metres. A route planner's few hundred points fit as they are, and a
// recorded run usually does at 3 m, still under half a printed road's width.
const LINK_TOLERANCES_M = [0, 2, 3, 5, 8, 12];

/** Routes packed for a link, simplified until they fit, or null when they don't. */
export function packTracks(tracks: Track[]): string | null {
  for (const tolerance of LINK_TOLERANCES_M) {
    const simplified = tolerance ? tracks.map((track) => ({ ...track, lines: encodeTrack(decodeTrack(track), tolerance) })) : tracks;
    const packed = pack(simplified);
    if (packed.length <= MAX_LINK_EXTRA) return packed;
  }
  return null;
}

function readPicks(value: unknown): SharedPicks | null {
  if (typeof value !== 'object' || value === null) return null;
  const picks = value as Record<string, unknown>;
  return { routes: sanitizeRoutes(picks.routes), hiddenLines: sanitizeLines(picks.hiddenLines) };
}

export function readHash(): SharedLink {
  if (typeof location === 'undefined') return { area: null, output: null, svg: null, edits: null, picks: null, tracks: null, unreadable: [] };
  return parseHash(location.hash);
}

/**
 * The link to copy, and what it had to leave out for length: the model's
 * edits or routes, or the SVG map's picked roads.
 */
export function shareUrl(area: AreaSpec, output: Output, svg: SvgSettings, edits?: ModelEdits, tracks?: Track[]): { url: string; left: 'edits' | 'picks' | 'tracks' | null } {
  const url = new URL(location.href);
  let hash = formatAreaHash(area, output).slice(1);
  let left: 'edits' | 'picks' | 'tracks' | null = null;
  if (output === 'svg') {
    hash += `&s=${encodeSvgSettings(svg)}`;
    if (svg.routes.some((route) => route.lines.length) || svg.hiddenLines.length) {
      const packed = pack({ routes: svg.routes, hiddenLines: svg.hiddenLines });
      if (packed.length <= MAX_LINK_EXTRA) hash += `&p=${packed}`;
      else left = 'picks';
    }
  } else {
    if (edits && hasEdits(edits)) {
      const packed = pack(edits);
      if (packed.length <= MAX_LINK_EXTRA) hash += `&e=${packed}`;
      else left = 'edits';
    }
    if (tracks?.length) {
      const packed = packTracks(tracks);
      if (packed) hash += `&t=${packed}`;
      else left ??= 'tracks';
    }
  }
  url.hash = hash;
  return { url: url.toString(), left };
}
