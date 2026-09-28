// Buildings and building parts as prisms on the shared terrain.
//
// Which masses to build is decided on the source lon/lat rings (see
// buildings/selection.ts). Every mass of one building, the parent and its
// parts, is founded on the lowest terrain under the whole building, so parts
// of equal height end level. A ground-founded underside follows the terrain
// just below its surface. An elevated part keeps its flat underside. Roofs
// are planar regions, one prism each.
//
// Roofs, filters and the minimum-height gate work on the whole source
// footprint, and only the finished pieces are clipped to the model area (and
// away from water with no ground kept). A building on the edge is cut through
// like a section instead of getting a new roof over what is left of it.

import {
  boxesOverlap,
  cleanRing,
  densifyRing,
  difference,
  dropSmall,
  intersection,
  normalize,
  pointInMulti,
  polygonArea,
  ringArea,
  ringBounds,
  ringPerimeter,
  union,
  type Box,
} from '../geometry/polygon';
import type { HeightFn, PrismSolid } from '../geometry/solid';
import type { MultiPolygon, Polygon } from '../types';
import { resolveVerticalProfile, text } from './buildings/heights';
import { isConvex, ringWidth } from './buildings/planar';
import { footprintAdmitsMinimumHeight, sourcePartWidths } from './buildings/printability';
import { isShaped, resolveRoof, shapedRoofRegions, type RoofRegion } from './buildings/roofs';
import { hasHoles, selectBuildingGeometry } from './buildings/selection';
import { count, type Context } from './context';
import { isPolygonal, positive, projectPolygons, type SourceFeature } from './source';

export interface BuildingResult {
  solids: PrismSolid[];
  /** Ground-founded footprints, for ground kept over water and tree clearance. */
  footprint: MultiPolygon;
}

export interface BuildingOptions {
  /** Where there is no ground (cut water, basins) and none will be kept: footprints are clipped away from it. */
  clipAway: MultiPolygon;
}

// A shaped roof lower than this is built flat: it would print as a lid anyway.
const MINIMUM_ROOF_MM = 0.15;
// The thinnest a ground-founded mass may get where the hill rises above its
// top. It is hidden in the terrain either way. This only keeps the solid
// from turning inside out.
const MINIMUM_BURIED_THICKNESS_MM = 0.05;
// Smaller source footprints are float noise, as the add-on's ring cleaning had it.
const MINIMUM_FOOTPRINT_MM2 = 1e-4;
// Slivers the model outline or clipped water leave of a footprint.
const MINIMUM_FRAGMENT_MM2 = 0.01;
// Below this a piece cannot be meshed reliably.
const MINIMUM_PIECE_MM2 = 1e-6;

const STAT_KEYS = [
  'buildings',
  'building_parts',
  'suppressed_parents',
  'building_parents_restored',
  'duplicate_outlines_suppressed',
  'buildings_rejected_geometry',
  'buildings_invalid_vertical_interval',
  'rejected_too_narrow',
  'rejected_too_slender',
  'buildings_raised_to_minimum',
  'building_parts_raised_to_minimum',
  'parts_founded_on_parent_base',
  'building_parts_kept_by_adjacency',
  'roofs_shaped',
  'roofs_fallback_flat',
  'roofs_unsupported_shape',
  'roofs_below_minimum',
];

interface Mass {
  /** The whole source footprint polygon in model mm. */
  polygon: Polygon;
  /** What of it lies in the model area and is not clipped away. */
  pieces: MultiPolygon;
  /** The pieces are the whole polygon, nothing to clip. */
  whole: boolean;
}

interface Footprint {
  masses: Mass[];
  /** Whether the source geometry reaches the model area at all. */
  near: boolean;
}

/** Clips footprints to the model area and away from `clipAway`, skipping the boolean where a footprint is plainly inside. */
class Visibility {
  private readonly convexCrop: boolean;
  private readonly away: { polygon: Polygon; box: Box }[];

  constructor(
    private readonly crop: MultiPolygon,
    private readonly cropBox: Box,
    clipAway: MultiPolygon,
  ) {
    const ring = crop.length === 1 && crop[0].length === 1 ? crop[0][0] : null;
    this.convexCrop = !!ring && isConvex(ringArea(ring) >= 0 ? ring : ring.slice().reverse());
    this.away = clipAway.filter((p) => p.length && p[0].length >= 3).map((polygon) => ({ polygon, box: ringBounds(polygon[0]) }));
  }

  of(polygon: Polygon): { pieces: MultiPolygon; whole: boolean } {
    const box = ringBounds(polygon[0]);
    if (!boxesOverlap(box, this.cropBox)) return { pieces: [], whole: false };
    const crop = this.crop;
    const inside =
      this.convexCrop &&
      pointInMulti(box[0], box[1], crop) &&
      pointInMulti(box[2], box[1], crop) &&
      pointInMulti(box[2], box[3], crop) &&
      pointInMulti(box[0], box[3], crop);
    const away: MultiPolygon = [];
    for (const a of this.away) if (boxesOverlap(a.box, box)) away.push(a.polygon);
    if (inside && !away.length) return { pieces: [polygon], whole: true };
    let pieces = inside ? [polygon] : intersection([polygon], crop);
    if (away.length && pieces.length) pieces = difference(pieces, away);
    if (!pieces.length) return { pieces, whole: false };
    // A footprint the boolean only rounded is still whole.
    const full = polygonArea(polygon);
    let area = 0;
    for (const piece of pieces) area += polygonArea(piece);
    let perimeter = 0;
    for (const ring of polygon) perimeter += ringPerimeter(ring);
    if (Math.abs(area - full) <= Math.min(1e-4 * perimeter, 1e-3 * full)) return { pieces: [polygon], whole: true };
    return { pieces: dropSmall(pieces, MINIMUM_FRAGMENT_MM2), whole: false };
  }
}

/** The polygon with its rings cleaned the way the mesher cleans them, or null when too small to mesh. */
function healthy(polygon: Polygon): Polygon | null {
  const outer = cleanRing(polygon[0]);
  if (outer.length < 3 || Math.abs(ringArea(outer)) < MINIMUM_PIECE_MM2) return null;
  const rings: Polygon = [outer];
  for (let i = 1; i < polygon.length; i++) {
    const hole = cleanRing(polygon[i]);
    if (hole.length >= 3 && Math.abs(ringArea(hole)) >= MINIMUM_PIECE_MM2) rings.push(hole);
  }
  return polygonArea(rings) >= MINIMUM_PIECE_MM2 ? rings : null;
}

function raised(region: RoofRegion, by: number): RoofRegion {
  const top = region.top;
  return { polygon: region.polygon, top: typeof top === 'number' ? top + by : (x, y) => top(x, y) + by };
}

/** Polygonal features, the first of each id. */
function usable(features: readonly SourceFeature[]): SourceFeature[] {
  const seen = new Set<string>();
  const out: SourceFeature[] = [];
  for (const feature of features) {
    if (!isPolygonal(feature.geometry) || seen.has(feature.id)) continue;
    seen.add(feature.id);
    out.push(feature);
  }
  return out;
}

export async function buildBuildings(
  buildings: SourceFeature[],
  parts: SourceFeature[],
  ctx: Context,
  options: BuildingOptions,
): Promise<BuildingResult> {
  const settings = ctx.settings.buildings;
  const hf = ctx.heightfield;
  const projection = ctx.projection;
  const embed = ctx.settings.land.embedMm;
  // One multiplier on every height measured from a mass's base (top, elevated
  // underside, wall top, apex), so a building keeps its proportions and its
  // parts keep theirs. Slenderness is judged on the printed thickness, so the
  // multiplier counts there as well.
  const scale = settings.heightScale > 0 && Number.isFinite(settings.heightScale) ? settings.heightScale : 1;
  const vertical = (metres: number) => projection.mm(metres) * scale;
  const minimumHeight = Math.max(0, settings.minHeightMm || 0);
  const minimumFootprint = Math.max(0, settings.minHeightFootprintMm || 0);
  const minimumWidth = settings.minWidthMm;
  const maximumSlenderness = settings.maxSlenderness;
  const { floorHeightM, defaultHeightM } = settings;
  const lattice = { x0: hf.minX, y0: hf.minY, step: hf.step };
  const stat = (key: string, by = 1) => count(ctx, key, by);

  const buildingFeatures = usable(buildings);
  const partFeatures = usable(parts);
  await ctx.progress.checkpoint(0);
  const selection = selectBuildingGeometry(buildingFeatures, partFeatures, settings.restoreMainBodies);
  await ctx.progress.checkpoint(0.1);

  for (const key of STAT_KEYS) stat(key, 0);
  ctx.stats.building_height_scale = Math.round(scale * 1e6) / 1e6;
  ctx.stats.minimum_building_height_mm = Math.round(minimumHeight * 1e6) / 1e6;
  ctx.stats.minimum_height_footprint_mm = Math.round(minimumFootprint * 1e6) / 1e6;
  stat('suppressed_parents', selection.suppressedParentIds.size);
  stat('duplicate_outlines_suppressed', selection.duplicateIds.size);

  const parentLookup = new Map<string, SourceFeature>();
  for (const feature of buildingFeatures) parentLookup.set(feature.id, feature);
  const partsByParent = new Map<string, SourceFeature[]>();
  for (const part of selection.parts) {
    const parentId = text(part.props.building_id);
    if (!parentId) continue;
    const list = partsByParent.get(parentId);
    if (list) list.push(part);
    else partsByParent.set(parentId, [part]);
  }

  const visibility = new Visibility(ctx.cropSet, ctx.cropBox, options.clipAway);
  const footprints = new Map<SourceFeature, Footprint>();
  const footprintOf = (feature: SourceFeature): Footprint => {
    let footprint = footprints.get(feature);
    if (!footprint) {
      const raw = projectPolygons(feature.geometry, projection);
      const near = raw.some((polygon) => boxesOverlap(ringBounds(polygon[0]), ctx.cropBox));
      const masses: Mass[] = [];
      if (near) {
        for (const polygon of normalize(raw)) {
          if (polygonArea(polygon) >= MINIMUM_FOOTPRINT_MM2) masses.push({ polygon, ...visibility.of(polygon) });
        }
      }
      footprints.set(feature, (footprint = { masses, near }));
    }
    return footprint;
  };

  // The lowest and highest terrain under a whole building: its parent
  // footprint, if loaded, and all its selected parts. The lowest is what every
  // mass stands on. The highest is what the minimum height is measured from,
  // so sibling parts are stretched by the same amount and stay level.
  const grounds = new Map<string, [number, number] | null>();
  const groundOf = (familyId: string): [number, number] | null => {
    const cached = grounds.get(familyId);
    if (cached !== undefined) return cached;
    const members: SourceFeature[] = [];
    const parent = parentLookup.get(familyId);
    if (parent) members.push(parent);
    members.push(...(partsByParent.get(familyId) ?? []));
    let low = Infinity;
    let high = -Infinity;
    for (const member of members) {
      for (const mass of footprintOf(member).masses) {
        for (const piece of mass.pieces) {
          for (const ring of piece) {
            for (const [x, y] of densifyRing(ring, hf.step)) {
              const z = hf.heightAt(x, y);
              if (z < low) low = z;
              if (z > high) high = z;
            }
          }
          for (const node of hf.nodesInside(piece)) {
            const z = hf.values[node];
            if (z < low) low = z;
            if (z > high) high = z;
          }
        }
      }
    }
    const ground: [number, number] | null = Number.isFinite(low) ? [low, high] : null;
    grounds.set(familyId, ground);
    return ground;
  };

  // Overture publishes chimneys, spires and wall fragments as masses of their
  // own, which extrude into needles far below the nozzle width. A mass at least
  // a nozzle line wide prints whatever its height, so a tower's narrow shaft is
  // kept. Slenderness is judged on the mass's own printed thickness, not its
  // height above the street: a tower's crown is a squat block that starts 140 m up.
  const tooThin = (width: number, thicknessMm: number): 'narrow' | 'slender' | null => {
    if (width < minimumWidth) return 'narrow';
    if (maximumSlenderness > 0 && width < settings.slendernessExemptMm && thicknessMm > width * maximumSlenderness) return 'slender';
    return null;
  };
  // Adjoining parts use their assembly's width for the filter. With both
  // filters off there is nothing to measure.
  const partWidths =
    minimumWidth > 0 || maximumSlenderness > 0
      ? sourcePartWidths(
          selection.parts,
          (part) => footprintOf(part).masses.map((mass) => mass.polygon),
          vertical,
          floorHeightM,
          defaultHeightM,
          minimumWidth,
          maximumSlenderness,
        )
      : null;
  await ctx.progress.checkpoint(0.15);

  const solids: PrismSolid[] = [];
  const groundPieces: MultiPolygon = [];
  const emit = (surfaces: RoofRegion[], mass: Mass, bottom: HeightFn | number, grounded: boolean, tidy: boolean): number => {
    let added = 0;
    for (const surface of surfaces) {
      let shapes: MultiPolygon;
      if (surface.polygon === mass.polygon) shapes = mass.pieces;
      else if (!mass.whole) shapes = intersection([surface.polygon], mass.pieces);
      else shapes = tidy ? normalize([surface.polygon]) : [surface.polygon];
      for (const shape of shapes) {
        const polygon = healthy(shape);
        if (!polygon) continue;
        const [x0, y0, x1, y1] = ringBounds(polygon[0]);
        // A piece within one terrain cell drapes well enough from its outline.
        if (grounded && Math.max(x1 - x0, y1 - y0) > hf.step) {
          solids.push({ kind: 'prism', role: 'building', polygon, top: surface.top, bottom, drape: hf.step, lattice });
        } else {
          solids.push({ kind: 'prism', role: 'building', polygon, top: surface.top, bottom, drape: 0 });
        }
        added++;
      }
    }
    return added;
  };

  const jobs: { feature: SourceFeature; isPart: boolean }[] = [
    ...selection.buildings.map((feature) => ({ feature, isPart: false })),
    ...selection.parts.map((feature) => ({ feature, isPart: true })),
  ];
  // A suppressed parent is retried only after every selected part has had its
  // chance, and one part built keeps the assembly. Part courtyards may be
  // missing from the parent's outline, so those assemblies are left alone
  // rather than filling their mapped open space.
  for (const feature of buildingFeatures) {
    if (!selection.suppressedParentIds.has(feature.id)) continue;
    if ((partsByParent.get(feature.id) ?? []).some(hasHoles)) continue;
    jobs.push({ feature, isPart: false });
  }
  const builtPartParents = new Set<string>();

  for (let index = 0; index < jobs.length; index++) {
    if (index % 100 === 0) await ctx.progress.checkpoint(0.15 + (0.8 * index) / jobs.length);
    const { feature, isPart } = jobs[index];
    const id = feature.id;
    const restoring = !isPart && selection.suppressedParentIds.has(id);
    if (restoring && builtPartParents.has(id)) continue;
    const footprint = footprintOf(feature);
    if (!footprint.masses.some((mass) => mass.pieces.length)) {
      if (footprint.near && !footprint.masses.length) stat('buildings_rejected_geometry');
      continue;
    }
    const props = feature.props;
    const profile = resolveVerticalProfile(props, floorHeightM, defaultHeightM);
    if (profile.thicknessM <= 0) {
      stat('buildings_invalid_vertical_interval');
      continue;
    }
    const parentId = isPart ? text(props.building_id) : '';
    const parent = parentId ? parentLookup.get(parentId) : undefined;
    const parentTopM = parent ? positive(parent.props.height) : null;
    const ground = groundOf(isPart ? parentId : id);
    if (!ground) continue;
    const [terrain, terrainTop] = ground;
    // Only a ground-founded mass is draped into the terrain.
    const grounded = profile.bottomM <= 0;
    const thicknessMm = vertical(profile.thicknessM);
    const widths = isPart ? partWidths?.get(id) : undefined;
    let narrow = false;
    let slender = false;
    let emitted = false;

    for (let m = 0; m < footprint.masses.length; m++) {
      const mass = footprint.masses[m];
      if (!mass.pieces.length) continue;
      const outer = mass.polygon[0];
      const widthMm = ringWidth(outer);
      const rejection = tooThin(widths?.[m] ?? widthMm, thicknessMm);
      if (rejection === 'narrow') {
        narrow = true;
        continue;
      }
      if (rejection === 'slender') {
        slender = true;
        continue;
      }
      const keptByAdjacency = isPart && tooThin(widthMm, thicknessMm) !== null;

      let top = terrain + vertical(profile.topM);
      const bottom = terrain + vertical(profile.bottomM);
      const roof = resolveRoof(props, profile, isPart, parentTopM, projection.metres(widthMm));
      // The ceiling is the lowest point of the finished top, which a draped
      // underside must stay below where the hill rises over the mass. The
      // peak is its highest point.
      let ceiling = top;
      let peak = top;
      let regions: RoofRegion[] | null = null;
      if (roof.kind === 'unsupported') {
        stat('roofs_unsupported_shape');
      } else if (settings.roofShapes && isShaped(roof)) {
        const wallTop = terrain + vertical(roof.wallTopM);
        const roofTop = terrain + vertical(roof.roofTopM);
        if (roofTop - wallTop < MINIMUM_ROOF_MM) stat('roofs_below_minimum');
        else if (mass.polygon.length > 1) stat('roofs_fallback_flat');
        else {
          regions = shapedRoofRegions(outer, roof, wallTop, roofTop);
          if (regions) {
            ceiling = wallTop;
            peak = roofTop;
          } else {
            stat('roofs_fallback_flat');
          }
        }
      }

      // A mass that would print flush with the streets is stretched up, walls
      // only so a shaped roof keeps its pitch, until its finished top clears
      // the highest terrain under the building by the minimum.
      let lift = 0;
      if (minimumHeight > 0 && footprintAdmitsMinimumHeight(outer, minimumFootprint)) {
        lift = Math.max(0, minimumHeight - (peak - terrainTop));
      }
      top += lift;
      const underside = ceiling + lift - MINIMUM_BURIED_THICKNESS_MM;
      const floor: HeightFn | number = grounded ? (x, y) => Math.min(hf.heightAt(x, y) - embed, underside) : bottom;
      const surfaces: RoofRegion[] = regions
        ? lift > 0
          ? regions.map((region) => raised(region, lift))
          : regions
        : [{ polygon: mass.polygon, top }];
      // Clipping a concave outline against a half-plane can leave zero-width
      // bridges along the ridge. Normalizing splits them.
      const tidy = !!regions && (roof.kind === 'gabled' || roof.kind === 'hipped') && !isConvex(outer);
      if (!emit(surfaces, mass, floor, grounded, tidy)) continue;

      emitted = true;
      if (lift > 0) stat(isPart ? 'building_parts_raised_to_minimum' : 'buildings_raised_to_minimum');
      if (regions) {
        stat('roofs_shaped');
        stat(`roofs_built_${roof.kind}`);
      }
      if (keptByAdjacency) stat('building_parts_kept_by_adjacency');
      if (grounded) groundPieces.push(...mass.pieces);
    }

    if (!emitted) {
      stat(narrow ? 'rejected_too_narrow' : slender ? 'rejected_too_slender' : 'buildings_rejected_geometry');
      continue;
    }
    if (isPart) {
      builtPartParents.add(parentId);
      stat('building_parts');
      stat('parts_founded_on_parent_base');
    } else {
      stat('buildings');
      if (restoring) {
        stat('building_parents_restored');
        stat('suppressed_parents', -1);
      }
    }
  }

  await ctx.progress.checkpoint(0.95);
  return { solids, footprint: groundPieces.length ? union(groundPieces) : [] };
}
