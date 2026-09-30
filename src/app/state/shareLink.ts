// Share links carry the area in the URL hash:
// #a=<lon>,<lat>,<widthM>,<heightM>,<rotationDeg>,<shape>
// A rounded area adds its corner radius as a seventh value. An SVG map adds
// o=svg, and a copied link s=<settings> (see svgmap/share.ts). Links from
// the old SVGmap site only have s=. A copied link also carries the model's
// edits (e=) or the SVG map's picked roads (p=), deflated, unless that would
// make it too long to paste anywhere.

import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';
import { hasEdits, sanitizeEdits, type ModelEdits } from '../../core/edit/types';
import type { AreaShape, AreaSpec } from '../../core/settings';
import { sanitizeLines, sanitizeRoutes, type LonLatLine, type SvgRoute } from '../../core/svgmap/routes';
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
}

export function parseHash(hash: string): SharedLink {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const svg = params.get('s') ? decodeSvgSettings(params.get('s')!) : null;
  const o = params.get('o');
  return {
    area: parseAreaHash(hash),
    // An SVGmap link is always an SVG map. An area without o= was written in
    // model mode, and the recipient's saved mode would change its size.
    output: o === 'svg' || o === 'model' ? o : svg ? 'svg' : params.get('a') ? 'model' : null,
    svg,
    edits: params.get('e') ? readEdits(unpack(params.get('e')!)) : null,
    picks: params.get('p') ? readPicks(unpack(params.get('p')!)) : null,
  };
}

function readEdits(value: unknown): ModelEdits | null {
  return value ? sanitizeEdits(value) : null;
}

function readPicks(value: unknown): SharedPicks | null {
  if (typeof value !== 'object' || value === null) return null;
  const picks = value as Record<string, unknown>;
  return { routes: sanitizeRoutes(picks.routes), hiddenLines: sanitizeLines(picks.hiddenLines) };
}

export function readHash(): SharedLink {
  if (typeof location === 'undefined') return { area: null, output: null, svg: null, edits: null, picks: null };
  return parseHash(location.hash);
}

/**
 * The link to copy, and what it had to leave out for length: the model's
 * edits or the SVG map's picked roads.
 */
export function shareUrl(area: AreaSpec, output: Output, svg: SvgSettings, edits?: ModelEdits): { url: string; left: 'edits' | 'picks' | null } {
  const url = new URL(location.href);
  let hash = formatAreaHash(area, output).slice(1);
  let left: 'edits' | 'picks' | null = null;
  if (output === 'svg') {
    hash += `&s=${encodeSvgSettings(svg)}`;
    if (svg.routes.some((route) => route.lines.length) || svg.hiddenLines.length) {
      const packed = pack({ routes: svg.routes, hiddenLines: svg.hiddenLines });
      if (packed.length <= MAX_LINK_EXTRA) hash += `&p=${packed}`;
      else left = 'picks';
    }
  } else if (edits && hasEdits(edits)) {
    const packed = pack(edits);
    if (packed.length <= MAX_LINK_EXTRA) hash += `&e=${packed}`;
    else left = 'edits';
  }
  url.hash = hash;
  return { url: url.toString(), left };
}
