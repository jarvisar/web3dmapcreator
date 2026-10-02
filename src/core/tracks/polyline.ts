// Google's encoded polyline format, with six decimals (about 10 cm). It keeps
// routes small enough for saved state and share links, about a fifth of the
// size of a JSON array of points.

import type { LonLat } from '../types';

const FACTOR = 1e6;

function encodeValue(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>>= 5;
  }
  return out + String.fromCharCode(v + 63);
}

// Latitude first, like every other encoder, so the strings can be checked
// with other tools.
export function encodePolyline(points: readonly LonLat[]): string {
  let out = '';
  let lastLat = 0;
  let lastLon = 0;
  for (const [lon, lat] of points) {
    const la = Math.round(lat * FACTOR);
    const lo = Math.round(lon * FACTOR);
    out += encodeValue(la - lastLat) + encodeValue(lo - lastLon);
    lastLat = la;
    lastLon = lo;
  }
  return out;
}

// Stops at the first thing that isn't valid, since the text can come from a
// hand-edited share link.
export function decodePolyline(text: string): LonLat[] {
  const points: LonLat[] = [];
  let index = 0;
  const next = (): number | null => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      // Six chunks hold any coordinate. More would overflow.
      if (index >= text.length || shift > 25) return null;
      byte = text.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) return null;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >>> 1) : result >>> 1;
  };
  let lat = 0;
  let lon = 0;
  while (index < text.length) {
    const dLat = next();
    const dLon = next();
    if (dLat === null || dLon === null) break;
    lat += dLat;
    lon += dLon;
    points.push([lon / FACTOR, lat / FACTOR]);
  }
  return points;
}
