// SVG settings in share links: the ones that differ from the defaults, as
// base64url JSON. Links from the old SVGmap site hold the area in the same
// JSON, as { lon, lat, bearing, widthM }, and the shape under product.
import type { AreaShape, AreaSpec } from '../../core/settings';
import type { ShapeKind } from '../../core/svgmap/layout/shapes';
import { areaShapeOf } from './piece';
import { type SvgSettings, defaultSvgSettings, isObject, mergeSettings } from './settings';

function diff(current: unknown, base: unknown): unknown {
  if (isObject(current) && isObject(base)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(current)) {
      const d = diff(value, base[key]);
      if (d !== undefined) out[key] = d;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return JSON.stringify(current) === JSON.stringify(base) ? undefined : current;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

// Picked roads are lines of coordinates, which go in a p= of their own,
// deflated (state/shareLink.ts).
export function encodeSvgSettings(settings: SvgSettings): string {
  const { routes: _routes, hiddenLines: _hidden, ...rest } = settings;
  return toBase64Url(JSON.stringify(diff(rest, defaultSvgSettings()) ?? {}));
}

export interface SharedSvg {
  svg: SvgSettings;
  // Only in links from the old SVGmap site.
  area?: Partial<Pick<AreaSpec, 'center' | 'widthM' | 'rotationDeg'>>;
  shape?: AreaShape;
}

// null when the text isn't a share link at all.
export function decodeSvgSettings(encoded: string): SharedSvg | null {
  let json: unknown;
  try {
    json = JSON.parse(fromBase64Url(encoded));
  } catch {
    return null;
  }
  if (!isObject(json)) return null;
  const shared: SharedSvg = { svg: mergeSettings(defaultSvgSettings(), json) };
  const area = json.area;
  if (isObject(area)) {
    const { lon, lat, bearing, widthM } = area;
    const out: SharedSvg['area'] = {};
    if (typeof lon === 'number' && typeof lat === 'number' && Math.abs(lon) <= 180 && Math.abs(lat) <= 85) out.center = [lon, lat];
    if (typeof bearing === 'number' && Number.isFinite(bearing)) out.rotationDeg = bearing;
    if (typeof widthM === 'number' && widthM > 0 && Number.isFinite(widthM)) out.widthM = widthM;
    shared.area = out;
    // SVGmap kept its scale lock out of links, and it was off there. With the
    // lock on by default here, the link's width gave way to the default scale.
    if (out.widthM !== undefined && json.scaleLocked === undefined) shared.svg.scaleLocked = false;
  }
  const product = json.product;
  if (isObject(product) && typeof product.shape === 'string' && ['rect', 'rounded', 'circle', 'hexagon'].includes(product.shape)) {
    shared.shape = areaShapeOf(product.shape as ShapeKind);
  }
  return shared;
}
