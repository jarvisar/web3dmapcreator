// Web Mercator in "world units": one tile at zoom z is TILE_EXTENT units wide.
// Every tile's integer coordinates land on the same grid, so pieces of a
// feature cut at a tile edge line up exactly.
export const TILE_EXTENT = 4096;
export const EARTH_RADIUS = 6378137;
const EARTH_CIRCUMFERENCE = 2 * Math.PI * EARTH_RADIUS;
export const MAX_LATITUDE = 85.05112878;

export interface LonLat {
  lon: number;
  lat: number;
}

export function worldSize(zoom: number): number {
  return 2 ** zoom * TILE_EXTENT;
}

export function lonLatToWorld(lon: number, lat: number, zoom: number): [number, number] {
  const size = worldSize(zoom);
  const clamped = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
  const phi = (clamped * Math.PI) / 180;
  const x = ((lon + 180) / 360) * size;
  const y = ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * size;
  return [x, y];
}

export function worldToLonLat(x: number, y: number, zoom: number): LonLat {
  const size = worldSize(zoom);
  const lon = (x / size) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / size;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lon, lat };
}

export function metresPerUnit(lat: number, zoom: number): number {
  return (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / worldSize(zoom);
}

// MapLibre uses 512 px tiles.
export function metresPerPixel(lat: number, zoom: number): number {
  return (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
}

export function zoomForMetres(lat: number, metres: number, pixels: number): number {
  return Math.log2((EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180) * pixels) / (512 * metres));
}
