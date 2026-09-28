// Share links carry the area in the URL hash:
// #a=<lon>,<lat>,<widthM>,<heightM>,<rotationDeg>,<shape>
// A rounded area adds its corner radius as a seventh value.

import type { AreaShape, AreaSpec } from '../../core/settings';
import { SHAPES } from '../lib/area';

export function formatAreaHash(area: AreaSpec): string {
  const values = [
    area.center[0].toFixed(6),
    area.center[1].toFixed(6),
    String(Math.round(area.widthM)),
    String(Math.round(area.heightM)),
    String(Math.round(area.rotationDeg * 10) / 10),
    area.shape,
  ];
  if (area.shape === 'rounded') values.push(String(Math.round(area.cornerRadius * 1000) / 1000));
  return `#a=${values.join(',')}`;
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

export function readHashArea(): AreaSpec | null {
  if (typeof location === 'undefined') return null;
  return parseAreaHash(location.hash);
}

export function shareUrl(area: AreaSpec): string {
  const url = new URL(location.href);
  url.hash = formatAreaHash(area).slice(1);
  return url.toString();
}
