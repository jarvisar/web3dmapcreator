// Share links carry the area in the URL hash:
// #a=<lon>,<lat>,<widthM>,<heightM>,<rotationDeg>,<shape>
// A rounded area adds its corner radius as a seventh value. An SVG map adds
// o=svg, and a copied link s=<settings> (see svgmap/share.ts). Links from
// the old SVGmap site only have s=.

import type { AreaShape, AreaSpec } from '../../core/settings';
import { SHAPES } from '../lib/area';
import { type SharedSvg, decodeSvgSettings, encodeSvgSettings } from '../svgmap/share';
import type { SvgSettings } from '../svgmap/settings';

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
}

export function parseHash(hash: string): SharedLink {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const svg = params.get('s') ? decodeSvgSettings(params.get('s')!) : null;
  const o = params.get('o');
  return {
    area: parseAreaHash(hash),
    // An SVGmap link is always an SVG map.
    output: o === 'svg' || o === 'model' ? o : svg ? 'svg' : null,
    svg,
  };
}

export function readHash(): SharedLink {
  if (typeof location === 'undefined') return { area: null, output: null, svg: null };
  return parseHash(location.hash);
}

export function shareUrl(area: AreaSpec, output: Output, svg: SvgSettings): string {
  const url = new URL(location.href);
  let hash = formatAreaHash(area, output).slice(1);
  if (output === 'svg') hash += `&s=${encodeSvgSettings(svg)}`;
  url.hash = hash;
  return url.toString();
}
