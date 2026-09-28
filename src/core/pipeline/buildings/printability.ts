// Which masses print: the size gate on the minimum-height lift, and the
// filter width of source parts that adjoin their siblings.

import type { Polygon, Vec2 } from '../../types';
import type { SourceFeature } from '../source';
import { resolveVerticalProfile, text } from './heights';
import { EPSILON, polygonArea, ringBounds, ringWidth, signedArea } from './planar';

/**
 * Whether a footprint is big enough to be stretched to the minimum height.
 * It has to cover a `minimumSizeMm` square, and it must not be a ribbon of
 * that area: a square of side S has an effective width of S/2, so anything
 * thinner is a wall fragment, a covered walkway or a row of garages mapped as
 * one strip, and stretching it makes the skinny fin the threshold is there to
 * prevent. A non-positive size admits every footprint.
 */
export function footprintAdmitsMinimumHeight(ring: readonly Vec2[], minimumSizeMm: number): boolean {
  if (minimumSizeMm <= 0) return true;
  if (ring.length < 3) return false;
  if (Math.abs(signedArea(ring)) < minimumSizeMm * minimumSizeMm) return false;
  return ringWidth(ring) >= 0.5 * minimumSizeMm;
}

type Edge = [Vec2, Vec2];

// Solid on the left, including around courtyard boundaries.
function edgesOf(polygon: Polygon): Edge[] {
  const edges: Edge[] = [];
  polygon.forEach((ring, index) => {
    const points = ring.slice();
    if (signedArea(points) > 0 !== (index === 0)) points.reverse();
    for (let i = 0; i < points.length; i++) edges.push([points[i], points[(i + 1) % points.length]]);
  });
  return edges;
}

/** Length of opposing collinear edges. Point contacts give no support. */
function sharedWall(first: readonly Edge[], second: readonly Edge[]): number {
  let total = 0;
  for (const [a, b] of first) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length <= EPSILON) continue;
    const ux = dx / length;
    const uy = dy / length;
    for (const [c, d] of second) {
      if (dx * (d[0] - c[0]) + dy * (d[1] - c[1]) >= 0) continue;
      if (Math.abs(ux * (c[1] - a[1]) - uy * (c[0] - a[0])) > EPSILON) continue;
      if (Math.abs(ux * (d[1] - a[1]) - uy * (d[0] - a[0])) > EPSILON) continue;
      const s = ux * (c[0] - a[0]) + uy * (c[1] - a[1]);
      const e = ux * (d[0] - a[0]) + uy * (d[1] - a[1]);
      total += Math.max(0, Math.min(length, Math.max(s, e)) - Math.max(0, Math.min(s, e)));
    }
  }
  return total;
}

export interface PartMass {
  polygon: Polygon;
  /** Printed mm above the shared base. */
  bottom: number;
  top: number;
}

/**
 * Filter widths for the masses of one building. Adjacent partitions with a
 * common base and modest height steps count as one mass: its area over a
 * perimeter without the internal walls, holes included. Only shared walls
 * count, so gaps, point contacts and overlapping duplicate outlines cannot
 * inflate it. An elevated facade cannot borrow width from a grounded
 * sibling, and a thin section rising far above its neighbour still has to
 * pass the slenderness rule on that extension. Only the filter changes:
 * footprints, roofs and shells stay as they are.
 */
export function adjoiningPartWidths(masses: readonly PartMass[], minimumWidth = 0.08, maximumSlenderness = 30): number[] {
  const widths = masses.map((mass) => ringWidth(mass.polygon[0]));
  const edges = masses.map((mass) => edgesOf(mass.polygon));
  const boxes = masses.map((mass) => ringBounds(mass.polygon[0]));
  const groups = masses.map((_, i) => i);
  const contacts: [number, number, number][] = [];
  const root = (i: number): number => {
    while (groups[i] !== i) {
      groups[i] = groups[groups[i]];
      i = groups[i];
    }
    return i;
  };

  for (let i = 0; i < masses.length; i++) {
    const { bottom, top } = masses[i];
    for (let j = 0; j < i; j++) {
      const other = masses[j];
      if (Math.abs(bottom - other.bottom) > EPSILON) continue;
      const a = boxes[i];
      const b = boxes[j];
      if (a[0] > b[2] + EPSILON || b[0] > a[2] + EPSILON || a[1] > b[3] + EPSILON || b[1] > a[3] + EPSILON) continue;
      const contact = sharedWall(edges[i], edges[j]);
      if (contact <= Math.max(EPSILON, minimumWidth)) continue;
      contacts.push([i, j, contact]);
      const tallerWidth = widths[top >= other.top ? i : j];
      const step = Math.abs(top - other.top);
      // Tiny seams may keep a small roof step, never a long thin tip.
      if (tallerWidth < minimumWidth && step > minimumWidth + EPSILON) continue;
      if (maximumSlenderness > 0 && step > tallerWidth * maximumSlenderness + EPSILON) continue;
      const target = root(j);
      groups[root(i)] = target;
    }
  }

  const members = new Map<number, number[]>();
  for (let i = 0; i < masses.length; i++) {
    const r = root(i);
    const list = members.get(r);
    if (list) list.push(i);
    else members.set(r, [i]);
  }
  const internal = new Map<number, number>();
  for (const [i, j, length] of contacts) {
    const r = root(i);
    if (r === root(j)) internal.set(r, (internal.get(r) ?? 0) + 2 * length);
  }
  const result = widths.slice();
  for (const [group, indices] of members) {
    if (indices.length < 2) continue;
    let area = 0;
    let perimeter = 0;
    for (const i of indices) {
      area += polygonArea(masses[i].polygon);
      for (const [a, b] of edges[i]) perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    perimeter -= internal.get(group) ?? 0;
    if (area <= 0 || perimeter <= EPSILON) continue;
    const width = (2 * area) / perimeter;
    for (const i of indices) result[i] = Math.max(widths[i], width);
  }
  return result;
}

/**
 * Sibling-aware filter widths of selected parts, per part id and polygon
 * index. Parts group by parent. Invalid intervals and underground parts
 * supply no support.
 */
export function sourcePartWidths(
  parts: readonly SourceFeature[],
  project: (part: SourceFeature) => Polygon[],
  vertical: (metres: number) => number,
  floorHeightM: number,
  defaultHeightM: number,
  minimumWidth: number,
  maximumSlenderness: number,
): Map<string, number[]> {
  const groups = new Map<string, { id: string; index: number; mass: PartMass }[]>();
  for (const part of parts) {
    const parent = text(part.props.building_id);
    const profile = resolveVerticalProfile(part.props, floorHeightM, defaultHeightM);
    if (!parent || profile.thicknessM <= 0 || part.props.is_underground === true) continue;
    const members = groups.get(parent) ?? [];
    groups.set(parent, members);
    const bottom = vertical(profile.bottomM);
    const top = vertical(profile.topM);
    project(part).forEach((polygon, index) => members.push({ id: part.id, index, mass: { polygon, bottom, top } }));
  }
  const result = new Map<string, number[]>();
  for (const members of groups.values()) {
    const widths = adjoiningPartWidths(
      members.map((member) => member.mass),
      minimumWidth,
      maximumSlenderness,
    );
    members.forEach((member, k) => {
      let list = result.get(member.id);
      if (!list) result.set(member.id, (list = []));
      list[member.index] = widths[k];
    });
  }
  return result;
}
