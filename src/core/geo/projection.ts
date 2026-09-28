// WGS84 to model millimetres through a local East/North/Up frame centred on
// the area, then rotated so the area's own "up" is +Y. Every layer goes
// through one Projection. Nothing scales or recentres a layer on its own.

import type { LonLat, Vec2 } from '../types';

const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const DEG = Math.PI / 180;

function ecef(lon: number, lat: number): [number, number, number] {
  const sinLat = Math.sin(lat * DEG);
  const cosLat = Math.cos(lat * DEG);
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  return [n * cosLat * Math.cos(lon * DEG), n * cosLat * Math.sin(lon * DEG), n * (1 - E2) * sinLat];
}

export class Projection {
  readonly center: LonLat;
  readonly rotationDeg: number;
  readonly mmPerMetre: number;
  private readonly origin: [number, number, number];
  private readonly sinLon: number;
  private readonly cosLon: number;
  private readonly sinLat: number;
  private readonly cosLat: number;
  private readonly sinRot: number;
  private readonly cosRot: number;

  constructor(center: LonLat, rotationDeg: number, mmPerMetre: number) {
    if (!(mmPerMetre > 0) || !Number.isFinite(mmPerMetre)) throw new Error('Scale must be a positive number');
    this.center = center;
    this.rotationDeg = rotationDeg;
    this.mmPerMetre = mmPerMetre;
    this.origin = ecef(center[0], center[1]);
    this.sinLon = Math.sin(center[0] * DEG);
    this.cosLon = Math.cos(center[0] * DEG);
    this.sinLat = Math.sin(center[1] * DEG);
    this.cosLat = Math.cos(center[1] * DEG);
    this.sinRot = Math.sin(rotationDeg * DEG);
    this.cosRot = Math.cos(rotationDeg * DEG);
  }

  /** Local east/north metres, unrotated. */
  toEnu(lon: number, lat: number): Vec2 {
    const [x, y, z] = ecef(lon, lat);
    const dx = x - this.origin[0];
    const dy = y - this.origin[1];
    const dz = z - this.origin[2];
    const east = -this.sinLon * dx + this.cosLon * dy;
    const north = -this.sinLat * this.cosLon * dx - this.sinLat * this.sinLon * dy + this.cosLat * dz;
    return [east, north];
  }

  /** Metres in the rotated frame: +Y along the area's bearing. */
  toLocal(lon: number, lat: number): Vec2 {
    const [e, n] = this.toEnu(lon, lat);
    return [e * this.cosRot - n * this.sinRot, e * this.sinRot + n * this.cosRot];
  }

  toModel(lon: number, lat: number): Vec2 {
    const [x, y] = this.toLocal(lon, lat);
    return [x * this.mmPerMetre, y * this.mmPerMetre];
  }

  /** Rotated-frame metres back to WGS84, ignoring height (exact on the ellipsoid surface to well under a millimetre). */
  localToGeo(x: number, y: number): LonLat {
    const e = x * this.cosRot + y * this.sinRot;
    const n = -x * this.sinRot + y * this.cosRot;
    // Rotate back to ECEF, then geodetic by Bowring's method.
    const dx = -this.sinLon * e - this.sinLat * this.cosLon * n;
    const dy = this.cosLon * e - this.sinLat * this.sinLon * n;
    const dz = this.cosLat * n;
    const X = dx + this.origin[0];
    const Y = dy + this.origin[1];
    const Z = dz + this.origin[2];
    const b = A * (1 - F);
    const ep2 = (A * A - b * b) / (b * b);
    const p = Math.hypot(X, Y);
    const lon = Math.atan2(Y, X) / DEG;
    const theta = Math.atan2(Z * A, p * b);
    const st = Math.sin(theta);
    const ct = Math.cos(theta);
    const lat = Math.atan2(Z + ep2 * b * st * st * st, p - E2 * A * ct * ct * ct) / DEG;
    return [lon, lat];
  }

  modelToGeo(x: number, y: number): LonLat {
    return this.localToGeo(x / this.mmPerMetre, y / this.mmPerMetre);
  }

  /** A real distance in metres as printed millimetres. Vertical uses the same scale. */
  mm(metres: number): number {
    return metres * this.mmPerMetre;
  }

  /** Printed millimetres back to real metres. */
  metres(mm: number): number {
    return mm / this.mmPerMetre;
  }
}
