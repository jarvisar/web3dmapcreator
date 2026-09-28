// Which masses to build: a parent footprint, its parts, or both, without
// building anything twice.
//
// This runs on the source lon/lat rings, before projection, so the choice
// does not depend on the area's rotation or scale. Coverage is measured with
// a dozen-across grid of samples, as the add-on did.

import type { Vec2 } from '../../types';
import type { GeoGeometry, SourceFeature } from '../source';
import { positive } from '../source';
import {
  estimatedHeight,
  partHasUsefulVerticalData,
  resolveVerticalProfile,
  SELECTION_DEFAULT_HEIGHT_M,
  SELECTION_FLOOR_HEIGHT_M,
  text,
  type Props,
} from './heights';
import { interiorGridPoints, pointInRings, planarArea, planarBounds, signedArea, type Bounds } from './planar';

// A partless building at least this much inside another building's parts is
// that building's outline published twice. The margin only absorbs vertices
// that differ by a survey's width.
export const DUPLICATE_COVERAGE = 0.9;
// Two partless footprints that each cover this much of the other are one
// building mapped twice.
export const MUTUAL_COVERAGE = 0.85;
// Spatial hash cell for the twin check, in degrees.
const TWIN_CELL = 0.0005;
// A footprint spanning more cells than this (a mapping error kilometres
// across) is left out of the twin check rather than hashed cell by cell.
const MAX_HASHED_CELLS = 65536;

type LonLatRing = Vec2[];
type LonLatPolygon = LonLatRing[];

export interface BuildingSelection {
  buildings: SourceFeature[];
  parts: SourceFeature[];
  /** Parents whose parts replace them. */
  suppressedParentIds: Set<string>;
  /** Partless outlines already modelled by another building. */
  duplicateIds: Set<string>;
}

export function isAboveGround(feature: SourceFeature): boolean {
  return feature.props.is_underground !== true;
}

function geometryPolygons(geometry: GeoGeometry | null | undefined): unknown[] {
  if (!geometry || !Array.isArray(geometry.coordinates)) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function readRing(ring: unknown): LonLatRing {
  const out: LonLatRing = [];
  if (!Array.isArray(ring)) return out;
  for (const p of ring) if (Array.isArray(p) && p.length >= 2) out.push([Number(p[0]), Number(p[1])]);
  return out;
}

/** Whether any polygon of the source geometry has a hole ring. */
export function hasHoles(feature: SourceFeature): boolean {
  return geometryPolygons(feature.geometry).some((polygon) => Array.isArray(polygon) && polygon.length > 1);
}

/** Lon/lat rings per feature, read once per selection. */
class LonLat {
  private outer = new Map<SourceFeature, LonLatRing[]>();
  private polygons = new Map<SourceFeature, LonLatPolygon[]>();

  /** Every outer ring. */
  outerRings(feature: SourceFeature): LonLatRing[] {
    let rings = this.outer.get(feature);
    if (!rings) {
      rings = [];
      for (const polygon of geometryPolygons(feature.geometry)) {
        if (!Array.isArray(polygon) || !polygon.length) continue;
        const ring = readRing(polygon[0]);
        if (ring.length >= 3) rings.push(ring);
      }
      this.outer.set(feature, rings);
    }
    return rings;
  }

  /** Polygons with their courtyard rings. */
  footprintPolygons(feature: SourceFeature): LonLatPolygon[] {
    let polygons = this.polygons.get(feature);
    if (!polygons) {
      polygons = [];
      for (const polygon of geometryPolygons(feature.geometry)) {
        if (!Array.isArray(polygon)) continue;
        const rings = polygon.map(readRing);
        if (rings.length && rings[0].length >= 3) polygons.push(rings.filter((ring) => ring.length >= 3));
      }
      this.polygons.set(feature, polygons);
    }
    return polygons;
  }
}

function boundsOf(rings: readonly LonLatRing[]): Bounds {
  const box: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ring of rings) {
    const b = planarBounds(ring);
    if (b[0] < box[0]) box[0] = b[0];
    if (b[1] < box[1]) box[1] = b[1];
    if (b[2] > box[2]) box[2] = b[2];
    if (b[3] > box[3]) box[3] = b[3];
  }
  return box;
}

/** Interior samples of the largest ring, a dozen across. */
function samples(rings: readonly LonLatRing[]): Vec2[] {
  if (!rings.length) return [];
  let ring = rings[0];
  let largest = Math.abs(signedArea(ring));
  for (let i = 1; i < rings.length; i++) {
    const area = Math.abs(signedArea(rings[i]));
    if (area > largest) {
      largest = area;
      ring = rings[i];
    }
  }
  const [minX, minY, maxX, maxY] = planarBounds(ring);
  const spacing = Math.max(maxX - minX, maxY - minY) / 12;
  if (!(spacing > 0)) return [];
  return interiorGridPoints([ring], spacing, 200);
}

// Outer ring bounds per polygon list, so a parent with hundreds of parts
// only runs the containment test on the few whose box holds the point.
const polygonBoxes = new WeakMap<readonly LonLatPolygon[], Bounds[]>();

function insideAny(x: number, y: number, polygons: readonly LonLatPolygon[]): boolean {
  let boxes = polygonBoxes.get(polygons);
  if (!boxes) polygonBoxes.set(polygons, (boxes = polygons.map((polygon) => planarBounds(polygon[0]))));
  for (let i = 0; i < polygons.length; i++) {
    const b = boxes[i];
    if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
    if (pointInRings(x, y, polygons[i])) return true;
  }
  return false;
}

// Same density and largest-component policy as `samples`, but a courtyard
// never votes as building material.
function footprintSamples(polygons: readonly LonLatPolygon[]): Vec2[] {
  return samples(polygons.map((polygon) => polygon[0])).filter(([x, y]) => insideAny(x, y, polygons));
}

function coverage(points: readonly Vec2[], polygons: readonly LonLatPolygon[]): number {
  if (!points.length) return 0;
  let inside = 0;
  for (const [x, y] of points) if (insideAny(x, y, polygons)) inside++;
  return inside / points.length;
}

/** How much of box a lies inside box b. */
function overlapFraction(a: Bounds, b: Bounds): number {
  const ix0 = Math.max(a[0], b[0]);
  const iy0 = Math.max(a[1], b[1]);
  const ix1 = Math.min(a[2], b[2]);
  const iy1 = Math.min(a[3], b[3]);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;
  const area = (a[2] - a[0]) * (a[3] - a[1]);
  return area > 0 ? ((ix1 - ix0) * (iy1 - iy0)) / area : 0;
}

/** Which of two duplicate outlines to keep: the one that says more. */
function informationRank(props: Props): [number, number, number] {
  const names = props.names;
  const primary = names && typeof names === 'object' && !Array.isArray(names) ? (names as Props).primary : undefined;
  return [positive(props.height) !== null ? 1 : 0, positive(props.num_floors) !== null ? 1 : 0, primary ? 1 : 0];
}

function compareRank(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Boxes on a uniform grid, for finding the ones that meet a query box. */
class BoxIndex {
  readonly boxes: Bounds[] = [];
  readonly keys: string[] = [];
  private cells = new Map<string, number[]>();
  private large: number[] = [];

  constructor(private readonly cell: number) {}

  insert(key: string, box: Bounds): void {
    const index = this.boxes.length;
    this.boxes.push(box);
    this.keys.push(key);
    const c0 = Math.floor(box[0] / this.cell);
    const c1 = Math.floor(box[2] / this.cell);
    const r0 = Math.floor(box[1] / this.cell);
    const r1 = Math.floor(box[3] / this.cell);
    if (!((c1 - c0 + 1) * (r1 - r0 + 1) <= MAX_HASHED_CELLS)) {
      this.large.push(index);
      return;
    }
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const cellKey = `${c},${r}`;
        const list = this.cells.get(cellKey);
        if (list) list.push(index);
        else this.cells.set(cellKey, [index]);
      }
    }
  }

  query(box: Bounds): number[] {
    const found = new Set<number>(this.large);
    const c0 = Math.floor(box[0] / this.cell);
    const c1 = Math.floor(box[2] / this.cell);
    const r0 = Math.floor(box[1] / this.cell);
    const r1 = Math.floor(box[3] / this.cell);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) <= MAX_HASHED_CELLS) {
      for (let c = c0; c <= c1; c++) {
        for (let r = r0; r <= r1; r++) for (const index of this.cells.get(`${c},${r}`) ?? []) found.add(index);
      }
    } else {
      for (let i = 0; i < this.boxes.length; i++) found.add(i);
    }
    return [...found];
  }
}

/**
 * Ids of building footprints already modelled elsewhere.
 *
 * The source publishes some buildings twice: once as a plain footprint with a
 * name and a height, and once as an outline that owns the parts. The Scripps
 * Center is one: a 143 m named box standing exactly over the eleven tiered
 * parts of an unnamed outline, hiding the tiers and the crown inside it. A
 * partless building whose footprint lies inside another building's parts is
 * that building over again and is dropped. Of two partless footprints that
 * each cover the other, the one carrying less information goes.
 */
export function findDuplicateOutlines(
  buildings: readonly SourceFeature[],
  partsByParent: ReadonlyMap<string, readonly SourceFeature[]>,
): Set<string> {
  return duplicateOutlines(buildings, partsByParent, new LonLat());
}

function duplicateOutlines(
  buildings: readonly SourceFeature[],
  partsByParent: ReadonlyMap<string, readonly SourceFeature[]>,
  lonLat: LonLat,
): Set<string> {
  const ids = buildings.map((b) => b.id);
  const polygons = new Map<string, LonLatPolygon[]>();
  const boxes = new Map<string, Bounds>();
  const byId = new Map<string, SourceFeature>();
  buildings.forEach((building, i) => {
    byId.set(ids[i], building);
    const outer = lonLat.outerRings(building);
    if (outer.length) {
      polygons.set(ids[i], lonLat.footprintPolygons(building));
      boxes.set(ids[i], boundsOf(outer));
    }
  });

  // Parts of each loaded parent, holes included, indexed by their bounds.
  const partPolygons = new Map<string, LonLatPolygon[]>();
  const partIndex = new BoxIndex(TWIN_CELL);
  for (const [parentId, associated] of partsByParent) {
    if (!boxes.has(parentId)) continue;
    const collected: LonLatPolygon[] = [];
    for (const part of associated) collected.push(...lonLat.footprintPolygons(part));
    if (collected.length) {
      partPolygons.set(parentId, collected);
      partIndex.insert(parentId, boundsOf(collected.map((polygon) => polygon[0])));
    }
  }

  const sampleCache = new Map<string, Vec2[]>();
  const samplesOf = (id: string): Vec2[] => {
    let points = sampleCache.get(id);
    if (!points) sampleCache.set(id, (points = footprintSamples(polygons.get(id)!)));
    return points;
  };

  const duplicates = new Set<string>();
  const partless = ids.filter((id) => boxes.has(id) && !partsByParent.has(id));
  for (const id of partless) {
    const box = boxes.get(id)!;
    let points: Vec2[] | null = null;
    for (const index of partIndex.query(box)) {
      const parentId = partIndex.keys[index];
      if (parentId === id || overlapFraction(box, partIndex.boxes[index]) < 0.5) continue;
      points ??= samplesOf(id);
      if (coverage(points, partPolygons.get(parentId)!) >= DUPLICATE_COVERAGE) {
        duplicates.add(id);
        break;
      }
    }
  }

  // Near-identical partless footprints, through a coarse spatial hash. The
  // bucket and pair order is the add-on's, so chains of twins resolve the
  // same way.
  const buckets = new Map<string, string[]>();
  for (const id of partless) {
    if (duplicates.has(id)) continue;
    const [x0, y0, x1, y1] = boxes.get(id)!;
    const gx0 = Math.trunc(x0 / TWIN_CELL);
    const gx1 = Math.trunc(x1 / TWIN_CELL);
    const gy0 = Math.trunc(y0 / TWIN_CELL);
    const gy1 = Math.trunc(y1 / TWIN_CELL);
    if (!((gx1 - gx0 + 1) * (gy1 - gy0 + 1) <= MAX_HASHED_CELLS)) continue;
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const key = `${gx},${gy}`;
        const members = buckets.get(key);
        if (members) members.push(id);
        else buckets.set(key, [id]);
      }
    }
  }
  const checked = new Set<string>();
  for (const members of buckets.values()) {
    for (let i = 0; i < members.length; i++) {
      const first = members[i];
      for (let j = i + 1; j < members.length; j++) {
        const second = members[j];
        const pair = first < second ? `${first}\u0000${second}` : `${second}\u0000${first}`;
        if (checked.has(pair) || duplicates.has(first) || duplicates.has(second)) continue;
        checked.add(pair);
        const a = boxes.get(first)!;
        const b = boxes.get(second)!;
        if (Math.min(overlapFraction(a, b), overlapFraction(b, a)) < 0.7) continue;
        if (
          coverage(samplesOf(first), polygons.get(second)!) >= MUTUAL_COVERAGE &&
          coverage(samplesOf(second), polygons.get(first)!) >= MUTUAL_COVERAGE
        ) {
          // On a tie the later id goes, so a rerun makes the same choice.
          const later = first > second ? first : second;
          const earlier = first > second ? second : first;
          const poorer =
            compareRank(informationRank(byId.get(later)!.props), informationRank(byId.get(earlier)!.props)) <= 0 ? later : earlier;
          duplicates.add(poorer);
        }
      }
    }
  }
  return duplicates;
}

/**
 * Whether a parent with an explicit height still supplies a main mass its
 * parts do not. A small upper roof section does not replace it, but an
 * explicitly lower part is a real setback and a derived parent height is not
 * evidence enough to fill the footprint. Heightless parts neither veto the
 * parent nor count toward coverage.
 */
function parentSuppliesMainMass(building: SourceFeature, parts: readonly SourceFeature[], lonLat: LonLat): boolean {
  const props = building.props;
  const profile = resolveVerticalProfile(props, SELECTION_FLOOR_HEIGHT_M, SELECTION_DEFAULT_HEIGHT_M);
  if (profile.heightSource !== 'height' || profile.thicknessM <= 0 || estimatedHeight(props)) return false;
  const outlines = lonLat.outerRings(building);
  if (!outlines.length) return false;
  const partRings: LonLatRing[] = [];
  for (const part of parts) {
    const top = resolveVerticalProfile(part.props, SELECTION_FLOOR_HEIGHT_M, SELECTION_DEFAULT_HEIGHT_M);
    const source = top.heightSource.split('+', 1)[0];
    if (source !== 'height' && source !== 'num_floors') continue;
    if (top.thicknessM <= 0) return false;
    // Floor heights vary, particularly in halls and other large rooms. A
    // lower floor estimate alone is not evidence of a mapped setback.
    if (top.topM < profile.topM && top.heightSource === 'height') return false;
    const rings = lonLat.outerRings(part);
    if (!rings.length) return false;
    partRings.push(...rings);
  }
  const points = samples(outlines);
  return points.length > 0 && coverage(points, partRings.map((ring) => [ring])) < MUTUAL_COVERAGE;
}

/**
 * Whether a grounded parent should stay because most of its footprint has no
 * mapped parts. Small setbacks get filled on purpose. Part-only courtyards are
 * ambiguous, so any part hole opts out. Each component is weighted by its
 * area, so a small disconnected wing cannot decide a whole complex.
 */
function sparsePartsLeaveMainMass(building: SourceFeature, parts: readonly SourceFeature[], lonLat: LonLat): boolean {
  const profile = resolveVerticalProfile(building.props, SELECTION_FLOOR_HEIGHT_M, SELECTION_DEFAULT_HEIGHT_M);
  if (profile.thicknessM <= 0 || profile.bottomM > 0) return false;
  const parentPolygons = lonLat.footprintPolygons(building);
  const partPolygons = parts.flatMap((part) => lonLat.footprintPolygons(part));
  if (!parentPolygons.length || !partPolygons.length || partPolygons.some((polygon) => polygon.length > 1)) return false;
  let total = 0;
  let covered = 0;
  for (const polygon of parentPolygons) {
    const area = planarArea(polygon);
    const points = footprintSamples([polygon]);
    if (area <= 0 || !points.length) return false;
    total += area;
    covered += area * coverage(points, partPolygons);
  }
  return total > 0 && covered / total < 0.5;
}

/**
 * Choose parent masses versus parts. A parent is replaced only when it says
 * `has_parts` and at least one part carries a usable height or floor count.
 * Then every above-ground part of it is kept, so a heightless part still gets
 * the fallback height. The parent itself stays when it supplies a main mass
 * its parts leave uncovered, or with `retainSparseParents` when its parts
 * cover less than half of it.
 */
export function selectBuildingGeometry(
  buildings: readonly SourceFeature[],
  parts: readonly SourceFeature[],
  retainSparseParents = false,
): BuildingSelection {
  const lonLat = new LonLat();
  const partsByParent = new Map<string, SourceFeature[]>();
  for (const part of parts) {
    if (!isAboveGround(part)) continue;
    const parentId = text(part.props.building_id);
    if (!parentId) continue;
    const list = partsByParent.get(parentId);
    if (list) list.push(part);
    else partsByParent.set(parentId, [part]);
  }

  const aboveGround = buildings.filter(isAboveGround);
  const duplicateIds = duplicateOutlines(aboveGround, partsByParent, lonLat);
  const selected: SourceFeature[] = [];
  const selectedParts: SourceFeature[] = [];
  const selectedPartIds = new Set<string>();
  const suppressedParentIds = new Set<string>();
  const loaded = new Set<string>();

  for (const building of aboveGround) {
    const id = building.id;
    loaded.add(id);
    if (duplicateIds.has(id)) continue;
    const associated = partsByParent.get(id) ?? [];
    const useful = associated.some((part) => partHasUsefulVerticalData(part.props));
    if (building.props.has_parts === true && useful) {
      if (
        parentSuppliesMainMass(building, associated, lonLat) ||
        (retainSparseParents && sparsePartsLeaveMainMass(building, associated, lonLat))
      ) {
        selected.push(building);
      } else {
        suppressedParentIds.add(id);
      }
      for (const part of associated) {
        if (selectedPartIds.has(part.id)) continue;
        selectedParts.push(part);
        selectedPartIds.add(part.id);
      }
    } else {
      selected.push(building);
    }
  }

  // A part can meet the area while its parent footprint does not. Keep only
  // useful orphan parts: a default-height sliver would be less truthful than
  // leaving it out.
  for (const [parentId, associated] of partsByParent) {
    if (loaded.has(parentId)) continue;
    for (const part of associated) {
      if (partHasUsefulVerticalData(part.props) && !selectedPartIds.has(part.id)) {
        selectedParts.push(part);
        selectedPartIds.add(part.id);
      }
    }
  }
  return { buildings: selected, parts: selectedParts, suppressedParentIds, duplicateIds };
}
