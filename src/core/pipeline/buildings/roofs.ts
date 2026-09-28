// Roof shapes for buildings and parts, from the Simple 3D Buildings fields
// Overture carries (roof_shape, roof_height, roof_direction,
// roof_orientation). On a city they are what makes the landmarks read: a
// tower's crown is a dome part and a faceted top is a ring of skillions.
//
// Every roof is built as planar regions, one prism each: a skillion is one
// sloping plane, a gable two and a hip four, clipped from the footprint in
// its ridge frame. A pyramid or dome is a fan of planar pieces around the
// apex. Regions touch along shared edges, which slicers union.

import type { HeightFn } from '../../geometry/solid';
import type { Polygon, Ring, Vec2 } from '../../types';
import { num, positive } from '../source';
import { lengthMetres, MAXIMUM_HEIGHT_M, prop, text, type Props, type VerticalProfile } from './heights';
import { cleanPlanarRing, EPSILON, ringCentroid, signedArea } from './planar';

export type RoofKind = 'flat' | 'skillion' | 'gabled' | 'hipped' | 'pyramid' | 'dome' | 'unsupported';

// OpenStreetMap roof:shape values folded onto the constructions.
export const SHAPE_KINDS: Readonly<Record<string, RoofKind>> = {
  flat: 'flat',
  sawtooth: 'flat',
  skillion: 'skillion',
  lean_to: 'skillion',
  'lean-to': 'skillion',
  gabled: 'gabled',
  saltbox: 'gabled',
  // Approximated by a gable, not a barrel vault.
  round: 'gabled',
  hipped: 'hipped',
  'half-hipped': 'hipped',
  half_hipped: 'hipped',
  mansard: 'hipped',
  gambrel: 'hipped',
  pyramidal: 'pyramid',
  cone: 'pyramid',
  dome: 'dome',
  onion: 'dome',
};

// Scaled rings between the wall top and the apex of a dome. Three give a
// recognisable curve at miniature scale without a hundred faces per crown.
export const DOME_STEPS = 3;

// Walls keep at least this fraction of a building's height when the roof is
// taken out of it, so an over-large roof_height cannot reduce a house to a tent.
export const MINIMUM_WALL_FRACTION = 0.3;

export function roofKind(shape: unknown): RoofKind {
  const name = text(shape).trim().toLowerCase();
  if (!name) return 'flat';
  return Object.prototype.hasOwnProperty.call(SHAPE_KINDS, name) ? SHAPE_KINDS[name] : 'unsupported';
}

export interface RoofProfile {
  kind: RoofKind;
  shape: string;
  /** Real metres above the mass's ground. */
  wallTopM: number;
  roofTopM: number;
  /** Compass bearing the roof slopes down towards. */
  directionDeg: number | null;
  orientation: string | null;
  /** flat, default or roof_height, with +floors or +parent_corroborated_walls where the roof sits above the walls. */
  source: string;
  /** roof_height was skipped: taller than MAXIMUM_HEIGHT_M, or it would have lifted the top past it. */
  implausible?: boolean;
}

export function isShaped(roof: RoofProfile): boolean {
  return roof.kind !== 'flat' && roof.kind !== 'unsupported';
}

/**
 * The roof's vertical extent. An explicit height is the total including the
 * roof, for buildings and parts alike, so the roof is taken out of the top.
 * The old blanket additive rule for parts inflated a Chicago 177.4 m part with
 * a 73 m roof to 250.4 m. Only a roof too tall for its part's interval whose
 * added top matches the parent's total keeps the additive reading: Great
 * American Tower's crown is 162.7 + 40 = 202.7 m. Floor-derived walls get the
 * roof on top, once. A shaped roof without roof_height gets an ordinary pitch,
 * recorded as `default`.
 */
export function resolveRoof(
  props: Props,
  profile: VerticalProfile,
  isPart: boolean,
  parentTopM: number | null,
  footprintWidthM: number,
  defaultPitchM = 3,
): RoofProfile {
  const shape = text(prop(props, 'roof_shape', 'roof:shape'));
  const kind = roofKind(shape);
  const top = profile.topM;
  const flat = (source: string): RoofProfile => ({
    kind: 'flat',
    shape,
    wallTopM: top,
    roofTopM: top,
    directionDeg: null,
    orientation: null,
    source,
  });
  if (kind === 'flat') return flat('flat');
  if (kind === 'unsupported') return { ...flat(`unsupported:${shape}`), kind };

  let roofHeight = positive(lengthMetres(prop(props, 'roof_height', 'roof:height')));
  // Only a roof on top of floor-count walls can raise the building. Otherwise
  // it comes out of the mapped height, or matches a parent that was checked.
  const onTop = profile.heightSource === 'num_floors';
  const implausible = roofHeight !== null && (onTop ? top + roofHeight : roofHeight) > MAXIMUM_HEIGHT_M;
  if (implausible) roofHeight = null;
  const explicitRoof = roofHeight !== null;
  let source = 'roof_height';
  if (roofHeight === null) {
    roofHeight =
      kind === 'pyramid' || kind === 'dome'
        ? Math.max(0.5 * footprintWidthM, 0.5)
        : Math.max(Math.min(defaultPitchM, 0.6 * footprintWidthM), 0.5);
    source = 'default';
  }
  const direction = num(prop(props, 'roof_direction', 'roof:direction'));
  const orientationValue = prop(props, 'roof_orientation', 'roof:orientation');
  const orientation = orientationValue ? String(orientationValue).trim().toLowerCase() : null;

  const corroborated =
    isPart &&
    explicitRoof &&
    profile.heightSource === 'height' &&
    roofHeight > profile.thicknessM &&
    parentTopM !== null &&
    Number.isFinite(parentTopM) &&
    Math.abs(top + roofHeight - parentTopM) <= 0.5;
  let wallTop: number;
  let roofTop: number;
  if (profile.heightSource === 'num_floors' || corroborated) {
    wallTop = top;
    roofTop = top + roofHeight;
    source += corroborated ? '+parent_corroborated_walls' : '+floors';
  } else {
    const thickness = top - profile.bottomM;
    wallTop = Math.max(top - roofHeight, profile.bottomM + MINIMUM_WALL_FRACTION * thickness);
    roofTop = top;
  }
  if (roofTop - wallTop <= 1e-6) return { ...flat('flat:no_room'), implausible };
  return { kind, shape, wallTopM: wallTop, roofTopM: roofTop, directionDeg: direction, orientation, source, implausible };
}

// ------------------------------------------------------------------ geometry

/** Unit vector for a compass bearing: 0 is north (+y), 90 is east (+x). */
export function directionVector(bearingDeg: number): Vec2 {
  const angle = (bearingDeg * Math.PI) / 180;
  return [Math.sin(angle), Math.cos(angle)];
}

/**
 * The part of a ring where a linear function is non-negative. `values` is the
 * function at each vertex, interpolated along edges, so crossings are exact.
 * Sutherland-Hodgman against one half-plane.
 */
export function clipRingLinear(ring: readonly Vec2[], values: readonly number[]): Ring {
  const count = ring.length;
  if (count < 3) return [];
  const output: Ring = [];
  for (let i = 0; i < count; i++) {
    const p = ring[i];
    const fp = values[i];
    const q = ring[(i + 1) % count];
    const fq = values[(i + 1) % count];
    if (fp >= 0) output.push(p);
    if (fp >= 0 !== (fq >= 0)) {
      const t = fp / (fp - fq);
      output.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return cleanPlanarRing(output, EPSILON);
}

/** The ridge axis u, the across axis v, and the footprint's extents along them. */
export class RidgeFrame {
  constructor(
    readonly centre: Vec2,
    readonly u: Vec2,
    readonly v: Vec2,
    readonly halfLength: number,
    readonly halfWidth: number,
  ) {}

  local(x: number, y: number): Vec2 {
    const dx = x - this.centre[0];
    const dy = y - this.centre[1];
    return [dx * this.u[0] + dy * this.u[1], dx * this.v[0] + dy * this.v[1]];
  }
}

/**
 * The ridge runs along the longest edge, or across it with orientation
 * "across". It is centred on the footprint's bounding box in its own frame,
 * not on the centroid, which keeps an L-shaped house's ridge over the middle
 * of the long wing instead of pulled towards the notch.
 */
export function ridgeFrame(ring: readonly Vec2[], orientation?: string | null): RidgeFrame | null {
  const count = ring.length;
  if (count < 3) return null;
  let best = 0;
  let u: Vec2 = [1, 0];
  for (let i = 0; i < count; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % count];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length > best) {
      best = length;
      u = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    }
  }
  if (best <= EPSILON) return null;
  if (orientation === 'across') u = [-u[1], u[0]];
  const v: Vec2 = [-u[1], u[0]];
  let minAlong = Infinity;
  let maxAlong = -Infinity;
  let minAcross = Infinity;
  let maxAcross = -Infinity;
  for (const [x, y] of ring) {
    const along = x * u[0] + y * u[1];
    const across = x * v[0] + y * v[1];
    if (along < minAlong) minAlong = along;
    if (along > maxAlong) maxAlong = along;
    if (across < minAcross) minAcross = across;
    if (across > maxAcross) maxAcross = across;
  }
  const halfLength = (maxAlong - minAlong) * 0.5;
  const halfWidth = (maxAcross - minAcross) * 0.5;
  if (halfLength <= EPSILON || halfWidth <= EPSILON) return null;
  const midAlong = (maxAlong + minAlong) * 0.5;
  const midAcross = (maxAcross + minAcross) * 0.5;
  const centre: Vec2 = [u[0] * midAlong + v[0] * midAcross, u[1] * midAlong + v[1] * midAcross];
  return new RidgeFrame(centre, u, v, halfLength, halfWidth);
}

/**
 * The skillion's plane. roof_direction is the bearing the roof slopes down
 * towards, so the vertices furthest along it sit at the wall top (checked on
 * the eight facets of a tower crown, which all point away from its centre).
 * Without a direction the slope runs across the footprint's short axis.
 */
export function skillionPlane(
  ring: readonly Vec2[],
  directionDeg: number | null,
  wallTop: number,
  roofTop: number,
  frame?: RidgeFrame | null,
): HeightFn | null {
  if (ring.length < 3) return null;
  let d: Vec2;
  if (directionDeg !== null) d = directionVector(directionDeg);
  else if (frame) d = frame.v;
  else return null;
  let low = Infinity;
  let high = -Infinity;
  for (const [x, y] of ring) {
    const value = x * d[0] + y * d[1];
    if (value < low) low = value;
    if (value > high) high = value;
  }
  const span = high - low;
  if (span <= EPSILON) return null;
  const rise = roofTop - wallTop;
  const [dx, dy] = d;
  return (x, y) => wallTop + (rise * (high - (x * dx + y * dy))) / span;
}

export function skillionHeights(
  ring: readonly Vec2[],
  directionDeg: number | null,
  wallTop: number,
  roofTop: number,
  frame?: RidgeFrame | null,
): number[] | null {
  const plane = skillionPlane(ring, directionDeg, wallTop, roofTop, frame);
  return plane ? ring.map(([x, y]) => plane(x, y)) : null;
}

/** A planar piece of a roof: its outline and the plane of its top. */
export interface RoofRegion {
  polygon: Polygon;
  top: HeightFn | number;
}

type Linear = (a: number, b: number) => number;

/**
 * Split a footprint into the planar regions of a gabled or hipped roof. In
 * the ridge frame a gable is two half-planes either side of the ridge. A hip
 * adds the two end faces, bounded by 45 degree hip lines from the ends of the
 * ridge, whose length is the footprint's length minus its width. Null unless
 * the regions add back up to the footprint's area, which tells a clip that
 * degenerated on an awkward outline from a region the footprint has no area in.
 */
export function planarRoofRegions(
  ring: readonly Vec2[],
  kind: RoofKind,
  frame: RidgeFrame,
  wallTop: number,
  roofTop: number,
): RoofRegion[] | null {
  const height = roofTop - wallTop;
  const width = frame.halfWidth;
  if (width <= EPSILON || !(height > 0)) return null;
  const reach = Math.max(frame.halfLength - frame.halfWidth, 0);
  const clamp = (z: number) => Math.min(Math.max(z, wallTop), roofTop);

  let specs: [Linear[], Linear][];
  if (kind === 'gabled') {
    specs = [
      [[(_a, b) => b], (_a, b) => clamp(wallTop + height * (1 - b / width))],
      [[(_a, b) => -b], (_a, b) => clamp(wallTop + height * (1 + b / width))],
    ];
  } else if (kind === 'hipped') {
    specs = [
      [
        [(_a, b) => b, (a, b) => b - a + reach, (a, b) => b + a + reach],
        (_a, b) => clamp(wallTop + height * (1 - b / width)),
      ],
      [
        [(_a, b) => -b, (a, b) => -b - a + reach, (a, b) => -b + a + reach],
        (_a, b) => clamp(wallTop + height * (1 + b / width)),
      ],
      [
        [(a) => a - reach, (a, b) => a - reach - b, (a, b) => a - reach + b],
        (a) => clamp(wallTop + height * (1 - (a - reach) / width)),
      ],
      [
        [(a) => -a - reach, (a, b) => -a - reach - b, (a, b) => -a - reach + b],
        (a) => clamp(wallTop + height * (1 - (-a - reach) / width)),
      ],
    ];
  } else {
    return null;
  }

  const regions: RoofRegion[] = [];
  let covered = 0;
  for (const [tests, topOf] of specs) {
    let polygon: Ring = ring.slice();
    for (const test of tests) {
      const values = polygon.map(([x, y]) => {
        const [a, b] = frame.local(x, y);
        return test(a, b);
      });
      polygon = clipRingLinear(polygon, values);
      if (polygon.length < 3) break;
    }
    if (polygon.length < 3) continue;
    covered += Math.abs(signedArea(polygon));
    regions.push({
      polygon: [polygon],
      top: (x, y) => {
        const [a, b] = frame.local(x, y);
        return topOf(a, b);
      },
    });
  }
  const expected = Math.abs(signedArea(ring));
  if (!regions.length || !(expected > 0) || Math.abs(covered - expected) / expected > 0.01) return null;
  return regions;
}

export interface ApexLevel {
  ring: Ring;
  z: number;
  /** Size relative to the footprint, about the apex. */
  scale: number;
}

/**
 * The intermediate rings and apex of a pyramid or dome. A pyramid rises
 * straight from the footprint to one apex over its centroid. A dome scales
 * the footprint towards the apex by the cosine of the latitude at each step
 * and lifts it by the sine, a quarter circle in profile whatever the outline.
 */
export function apexLevels(
  ring: readonly Vec2[],
  kind: RoofKind,
  wallTop: number,
  roofTop: number,
  steps = DOME_STEPS,
): { levels: ApexLevel[]; apex: [number, number, number] } {
  const centre = ringCentroid(ring);
  const height = roofTop - wallTop;
  const levels: ApexLevel[] = [];
  if (kind === 'dome') {
    const count = Math.max(1, Math.trunc(steps));
    for (let step = 1; step <= count; step++) {
      const angle = (Math.PI * 0.5 * step) / (steps + 1);
      const scale = Math.cos(angle);
      levels.push({
        ring: ring.map(([x, y]) => [centre[0] + (x - centre[0]) * scale, centre[1] + (y - centre[1]) * scale]),
        z: wallTop + height * Math.sin(angle),
        scale,
      });
    }
  }
  return { levels, apex: [centre[0], centre[1], roofTop] };
}

/**
 * A pyramid or dome as planar pieces. Each outline edge and the apex bound a
 * sector. Across a sector the roof only depends on the distance from the
 * edge's line, so the band between two dome rings is a flat trapezoid (a
 * scaled edge is parallel to the edge) and the last band is a triangle to the
 * apex. That is the add-on's apex solid, face for face.
 *
 * The apex has to see the whole outline or the sectors overlap: a concave
 * footprint whose centroid lies outside its kernel gets null, and stays flat.
 */
export function apexRegions(ring: readonly Vec2[], kind: RoofKind, wallTop: number, roofTop: number): RoofRegion[] | null {
  const count = ring.length;
  if (count < 3 || !(roofTop > wallTop) || (kind !== 'pyramid' && kind !== 'dome')) return null;
  const { levels, apex } = apexLevels(ring, kind, wallTop, roofTop);
  const cx = apex[0];
  const cy = apex[1];
  const stations = [{ scale: 1, z: wallTop }, ...levels.map((level) => ({ scale: level.scale, z: level.z })), { scale: 0, z: roofTop }];
  const at = (s: number, p: Vec2): Vec2 => (s === 1 ? p : [cx + (p[0] - cx) * s, cy + (p[1] - cy) * s]);
  const regions: RoofRegion[] = [];
  let covered = 0;
  for (let i = 0; i < count; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % count];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length <= 1e-12) continue;
    // Inward normal of a counter-clockwise ring, and the apex's distance from the edge's line.
    const nx = -(b[1] - a[1]) / length;
    const ny = (b[0] - a[0]) / length;
    const reach = (cx - a[0]) * nx + (cy - a[1]) * ny;
    if (!(reach > EPSILON)) return null;
    covered += 0.5 * length * reach;
    const ax = a[0];
    const ay = a[1];
    for (let k = 0; k + 1 < stations.length; k++) {
      const outer = stations[k];
      const inner = stations[k + 1];
      const polygon: Ring =
        inner.scale > 0 ? [at(outer.scale, a), at(outer.scale, b), at(inner.scale, b), at(inner.scale, a)] : [at(outer.scale, a), at(outer.scale, b), [cx, cy]];
      // 0 on the edge's line and 1 at the apex. The band starts at 1 - scale.
      const start = 1 - outer.scale;
      const span = outer.scale - inner.scale;
      const z0 = outer.z;
      const rise = inner.z - outer.z;
      regions.push({
        polygon: [polygon],
        top: (x, y) => z0 + (rise * (((x - ax) * nx + (y - ay) * ny) / reach - start)) / span,
      });
    }
  }
  const expected = Math.abs(signedArea(ring));
  if (!regions.length || !(expected > 0) || Math.abs(covered - expected) / expected > 0.01) return null;
  return regions;
}

/** The planar regions of a shaped roof over a counter-clockwise ring, or null when it cannot be built. */
export function shapedRoofRegions(ring: readonly Vec2[], roof: RoofProfile, wallTop: number, roofTop: number): RoofRegion[] | null {
  if (roof.kind === 'skillion') {
    const plane = skillionPlane(ring, roof.directionDeg, wallTop, roofTop, ridgeFrame(ring, roof.orientation));
    return plane ? [{ polygon: [ring.slice()], top: plane }] : null;
  }
  if (roof.kind === 'gabled' || roof.kind === 'hipped') {
    const frame = ridgeFrame(ring, roof.orientation);
    return frame ? planarRoofRegions(ring, roof.kind, frame, wallTop, roofTop) : null;
  }
  if (roof.kind === 'pyramid' || roof.kind === 'dome') return apexRegions(ring, roof.kind, wallTop, roofTop);
  return null;
}
