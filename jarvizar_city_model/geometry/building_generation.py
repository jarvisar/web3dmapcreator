"""Blender-facing generation of building masses."""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any, Callable, Dict, List, Optional, Tuple

from ..blender.mesh_utils import MeshBuilder, projected_polygon_rings
from ..data.geojson import feature_id, feature_properties, first_osm_id, geometry_polygons, positive_number
from .buildings import (
    footprint_admits_minimum_height,
    is_above_ground,
    resolve_vertical_profile,
    select_building_geometry,
)
from .planar import EPSILON, clean_ring, densify_ring, effective_width
from .building_printability import source_part_widths
from .roofs import (
    RoofProfile,
    apex_levels,
    planar_roof_regions,
    resolve_roof,
    ridge_frame,
    skillion_heights,
)

# The thinnest a ground-founded mass may become where the hill rises above
# its top.  Such a mass is hidden inside the terrain either way; the sliver
# only keeps the solid from turning inside out.
MINIMUM_BURIED_THICKNESS_MM = 0.05

Floor = Callable[[float, float], float]


def _needs_ground(rings, heightfield, spacing_mm: float = 0.5) -> bool:
    """Whether any part of a footprint's outline stands over cut-out water."""
    if getattr(heightfield, "void_mask", None) is None or not hasattr(
        heightfield, "over_open_water"
    ):
        return False
    return any(
        heightfield.over_open_water(x, y) for x, y in densify_ring(rings[0], spacing_mm)
    )


def _safe_property(obj, key: str, value: Any) -> None:
    if value is None:
        return
    if isinstance(value, (str, bool, int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return
        obj[key] = value


def _attach_metadata(obj, feature, feature_type, profile, roof: Optional[RoofProfile], roof_geometry: str) -> None:
    properties = feature_properties(feature)
    _safe_property(obj, "overture_id", feature_id(feature))
    _safe_property(obj, "osm_id", first_osm_id(properties))
    _safe_property(obj, "feature_type", feature_type)
    _safe_property(obj, "height_source", profile.height_source)
    _safe_property(obj, "height_m", profile.top_m)
    _safe_property(obj, "mass_thickness_m", profile.thickness_m)
    _safe_property(obj, "min_height_source", profile.min_height_source)
    _safe_property(obj, "min_height_m", profile.bottom_m)
    for field in (
        "building_id",
        "num_floors",
        "min_floor",
        "level",
        "has_parts",
        "subtype",
        "class",
        "roof_height",
        "roof_shape",
        "roof_direction",
        "roof_orientation",
    ):
        _safe_property(obj, field, properties.get(field))
    obj["roof_geometry"] = roof_geometry
    if roof is not None:
        _safe_property(obj, "roof_height_source", roof.source)
        _safe_property(obj, "roof_wall_top_m", roof.wall_top_m)
        _safe_property(obj, "roof_top_m", roof.roof_top_m)


def _densified(ring, spacing: float):
    """A ring with no edge longer than *spacing*, cleaned at float32 tolerance.

    A long wall's underside can only follow the ground at its vertices, so a
    wall longer than a terrain cell gets vertices along it.  The original ring
    is returned when densifying would leave nothing usable.
    """
    dense = clean_ring(densify_ring(ring, spacing), EPSILON)
    return dense if len(dense) >= 3 else list(ring)


def _add_shaped_roof(
    builder: MeshBuilder,
    ring,
    floor: Floor,
    wall_top: float,
    roof_top: float,
    roof: RoofProfile,
    spacing: float,
    material_index: int = 0,
) -> bool:
    """Add one mass with a shaped top; ``False`` means the caller builds it flat.

    *floor* gives the underside height at any point, so a mass follows the
    ground it stands on at every outline vertex instead of being sunk to its
    lowest corner.  The planar roofs take a densified outline for that; an
    apex solid keeps its own outline, whose vertices its intermediate rings
    are scaled from.
    """
    if roof.kind == "skillion":
        dense = _densified(ring, spacing)
        frame = ridge_frame(dense, roof.orientation)
        heights = skillion_heights(dense, roof.direction_deg, wall_top, roof_top, frame)
        if heights is None:
            return False
        return builder.add_prism(
            [[(x, y, floor(x, y), z) for (x, y), z in zip(dense, heights)]],
            material_index=material_index,
        )
    if roof.kind in ("gabled", "hipped"):
        dense = _densified(ring, spacing)
        frame = ridge_frame(dense, roof.orientation)
        if frame is None:
            return False
        regions = planar_roof_regions(dense, roof.kind, frame, wall_top, roof_top)
        if not regions:
            return False
        return builder.add_prism_group(
            [[[(x, y, floor(x, y), z) for x, y, z in region]] for region in regions],
            material_index=material_index,
        )
    if roof.kind in ("pyramid", "dome"):
        levels, apex = apex_levels(ring, roof.kind, wall_top, roof_top)
        return builder.add_apex_solid(
            ring, floor, wall_top, levels, apex, material_index=material_index
        )
    return False


def generate_buildings(
    building_features,
    part_features,
    transform,
    heightfield,
    floor_height_m: float,
    default_height_m: float,
    building_collection,
    part_collection,
    building_material=None,
    part_material=None,
    embed_mm: float = 0.15,
    drape_spacing_mm: float = 1.5,
    minimum_width_mm: float = 0.08,
    maximum_slenderness: float = 30.0,
    progress_callback=None,
    ground_support=None,
    generate_roofs: bool = True,
    minimum_roof_mm: float = 0.15,
    slenderness_exempt_width_mm: float = 0.45,
    merge: bool = False,
    height_scale: float = 1.0,
    minimum_height_mm: float = 0.0,
    minimum_height_footprint_mm: float = 0.0,
    lidar_profiles=None,
    prefer_lidar=False,
    retain_sparse_parents=False,
) -> Dict[str, Any]:
    """Generate selected parent and part meshes, returning honest counts.

    With *merge* every mass goes into one ``BUILDINGS`` object (parts in their
    own material slot) and no per-building metadata is attached; otherwise
    each building and part is its own object carrying its source properties.

    Each building's *heights* are measured from the lowest terrain under its
    own footprint, not from a single representative point: on a slope the
    centroid height would leave the downhill corner of the building floating
    in the air.  Every part of one building shares that one base, taken over
    the parent's footprint and all of its parts: a building's floors are
    level, so two parts of the same height must end at the same height, which
    they did not while each was founded on its own patch of ground.

    A ground-founded mass's *underside* follows the terrain, *embed_mm* below
    it at every point, rather than being one flat plate at the lowest corner.
    The printed shape is identical -- everything below ground is inside the
    terrain either way -- but the colour a slicer has to lay down inside the
    hill shrinks from a wedge as deep as the slope to a skin one layer thick.
    An elevated part keeps its real flat underside.

    A ground-founded mass whose footprint reaches over cut-out water -- a
    boathouse, a floating restaurant, a warehouse on a quay the water polygon
    overlaps -- gets a pedestal of terrain built back under exactly its own
    footprint through *ground_support*, so it stands on ground instead of
    hanging over the opening.

    Roofs follow ``roof_shape`` where the shape is one the project can build
    and the result would be at least *minimum_roof_mm* tall; anything else is
    a flat extrusion, and the object records which it got.

    *height_scale* multiplies every vertical distance measured from a mass's
    terrain base -- its top, an elevated part's underside and its roof -- so
    the massing can be given a little lift over the road ribbons without the
    footprints or the shared print scale moving.  It applies to the whole
    building including its parts, so parts still sit inside their parent and
    equal-height masses still end level.  Recorded heights in metres stay the
    source values; the multiplier is reported once, in the counts.

    *minimum_height_mm* is a floor on how far a mass's top stands over the
    ground, applied after every other height rule: a mass shorter than that is
    stretched upwards until it clears the terrain by exactly the minimum, and
    a taller one is untouched.  The clearance is measured from the *highest*
    terrain under the mass's own footprint -- and, for a building with parts,
    under the whole building -- so the guarantee holds on the uphill side too
    and sibling parts are stretched by the same amount, which keeps their tops
    level.  Only footprints that pass *minimum_height_footprint_mm* are
    eligible: stretching a shed or a wall fragment to a printable height is
    what turns it into a needle.  A shaped roof rides up with its walls
    instead of being scaled, so the roof keeps its own pitch.
    """
    if ground_support is not None:
        heightfield = ground_support.structure_heightfield
    building_features = list(building_features)
    part_features = list(part_features)
    selection = select_building_geometry(building_features, part_features, retain_sparse_parents=retain_sparse_parents)
    parent_lookup = {feature_id(feature): feature for feature in building_features}
    parts_by_parent: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for part in selection.parts:
        parent_id = str(feature_properties(part).get("building_id") or "")
        if parent_id:
            parts_by_parent[parent_id].append(part)
    ground_cache: Dict[str, Optional[Tuple[float, float]]] = {}
    foundation_cache = {}
    embed = float(embed_mm)
    spacing = float(drape_spacing_mm)

    def family(parent_id):
        """A building's parent footprint, if loaded, followed by its parts."""
        parent = parent_lookup.get(parent_id)
        return ([parent] if parent is not None else []) + list(parts_by_parent.get(parent_id, ()))

    def foundation(minimum_ground):
        if ground_support is not None:
            return ground_support.foundation_field(minimum_ground)
        return heightfield

    def family_floor(parent_id):
        if ground_support is None:
            return None
        if parent_id not in foundation_cache:
            features = family(parent_id)
            levels = [ground_support.minimum_ground(rings, 'building')
                      for feature in features
                      for rings in projected_polygon_rings(feature.get('geometry') or {}, transform)]
            foundation_cache[parent_id] = max((z for z in levels if z is not None), default=None)
        return foundation_cache[parent_id]

    def shared_ground(parent_id: str) -> Optional[Tuple[float, float]]:
        """The lowest and highest terrain under a whole building.

        The lowest is what every part of the building is founded on, so that
        equal-height parts end level.  The highest is what a minimum height is
        measured from, for the same reason: sibling parts must be stretched by
        the same amount or the floors they share stop lining up.
        """
        if parent_id in ground_cache:
            return ground_cache[parent_id]
        bases: List[float] = []
        ceilings: List[float] = []
        ground_field = foundation(family_floor(parent_id))
        for feature in family(parent_id):
            for rings in projected_polygon_rings(feature.get("geometry") or {}, transform):
                bases.append(ground_field.minimum_over(rings[0]))
                ceilings.append(ground_field.maximum_over(rings[0]))
        ground_cache[parent_id] = (min(bases), max(ceilings)) if bases else None
        return ground_cache[parent_id]

    jobs = [
        (feature, "building", building_collection, building_material, "BLDG")
        for feature in selection.buildings
    ]
    jobs.extend(
        (feature, "building_part", part_collection, part_material, "PART")
        for feature in selection.parts
    )
    # Retry a suppressed parent only after every selected part has had its
    # chance. One successful part preserves the existing assembly/setbacks.
    jobs.extend(
        (feature, "building", building_collection, building_material, "BLDG")
        for feature in building_features if feature_id(feature) in selection.suppressed_parent_ids
        # Part courtyards may be absent from the parent's outline. Leave those
        # ambiguous assemblies alone rather than fill their mapped open space.
        and not any(len(polygon) > 1
                    for part in parts_by_parent.get(feature_id(feature), ())
                    for polygon in geometry_polygons(part.get('geometry') or {}))
    )
    built_part_parents = set()

    counts: Dict[str, Any] = {
        "buildings": 0,
        "building_parts": 0,
        "suppressed_parents": len(selection.suppressed_parent_ids),
        "building_parents_restored": 0,
        "duplicate_outlines_suppressed": len(selection.duplicate_ids),
        "buildings_rejected_geometry": 0,
        "buildings_invalid_vertical_interval": 0,
        "rejected_too_narrow": 0,
        "rejected_too_slender": 0,
        "buildings_grounded_over_water": 0,
        "buildings_raised_to_minimum": 0,
        "building_parts_raised_to_minimum": 0,
        "parts_founded_on_parent_base": 0,
        "roofs_built": {},
        "roofs_fallback_flat": 0,
        "roofs_unsupported_shape": 0,
        "roofs_below_minimum": 0,
    }
    # One multiplier on the shared vertical scale covers every height a mass
    # is built from -- top, elevated underside, wall top, roof apex -- so a
    # boosted building keeps its own proportions and its parts keep theirs.
    # Slenderness is judged on the printed thickness, so it reads it too.
    scale = float(height_scale)
    if scale <= 0.0 or not math.isfinite(scale):
        scale = 1.0
    counts["building_height_scale"] = round(scale, 6)
    minimum_height = max(0.0, float(minimum_height_mm))
    minimum_footprint = max(0.0, float(minimum_height_footprint_mm))
    counts["minimum_building_height_mm"] = round(minimum_height, 6)
    counts["minimum_height_footprint_mm"] = round(minimum_footprint, 6)
    base_vertical = transform.vertical_meters_to_model_mm
    vertical = (
        base_vertical
        if scale == 1.0
        else (lambda distance_m: base_vertical(distance_m) * scale)
    )
    horizontal_scale = max(transform.scale_x_mm_per_m, 1.0e-12)
    total = max(1, len(jobs))
    merged = MeshBuilder("BUILDINGS") if merge else None
    enhanced_ids = set()
    infilled_parent_ids = set()
    measured_parent_ids = set()
    part_height_updates = {}
    height_only_profiles = {key: {'height_m':height}
                            for parent_id,record in (lidar_profiles or {}).items() if record.get('method')=='height_only'
                            for key,height in record.get('source_heights', {}).items()
                            if positive_number(height) is not None and (key==parent_id
                                or any(feature_id(part)==key for part in parts_by_parent.get(parent_id, ())))}
    height_only_groups = defaultdict(list)
    counts["lidar_buildings"] = 0
    counts["lidar_tier_solids"] = 0
    counts["lidar_geometry_fallbacks"] = 0
    counts['lidar_roof_plane_buildings'] = 0
    counts['lidar_faceted_roof_buildings'] = 0
    counts['lidar_roof_plane_solids'] = 0
    counts['lidar_part_boundaries_used'] = 0
    counts['lidar_source_detail_preserved'] = 0
    counts['lidar_part_heights'] = 0
    counts['lidar_infill_buildings'] = 0
    counts['lidar_estimated_heights_corrected'] = 0
    counts['lidar_height_only_buildings'] = 0
    if lidar_profiles:
        from .lidar_buildings import measured_builder, prefer_source_detail
        for identifier, feature in parent_lookup.items():
            record = lidar_profiles.get(identifier)
            # Cached measurements must obey the same underground exclusion as
            # source selection, while separately mapped entrances remain usable.
            if not record or identifier in selection.duplicate_ids or not is_above_ground(feature):
                continue
            if record.get('method') == 'height_only':
                # Build exactly the ordinary source selection first. Scalar
                # correction never replaces an outline or restores an infill.
                continue
            supplement = record.get('method') == 'source_parts'
            if supplement and identifier not in selection.suppressed_parent_ids and not prefer_lidar:
                continue
            part_updates = {feature_id(part): record.get('part_heights', {})[feature_id(part)]
                            for part in parts_by_parent.get(identifier, ())
                            if feature_id(part) in record.get('part_heights', {})}
            if supplement and not record.get('infill_geometry'):
                part_height_updates.update(part_updates)
                continue
            source_assembly = list(parts_by_parent.get(identifier, ()))
            if identifier not in selection.suppressed_parent_ids:
                source_assembly.append(feature)
            if not supplement and not prefer_lidar and prefer_source_detail(source_assembly, feature, record,
                    transform, vertical, floor_height_m, default_height_m, minimum_width_mm,
                    maximum_slenderness, slenderness_exempt_width_mm, generate_roofs, minimum_roof_mm):
                counts['lidar_source_detail_preserved'] += 1
                continue
            ground = shared_ground(identifier)
            if ground is None:
                continue
            minimum_ground = family_floor(identifier)
            ground_field = foundation(minimum_ground)
            try:
                built = measured_builder(feature, record, transform, ground_field, ground, vertical,
                    embed, spacing, minimum_width_mm, maximum_slenderness,
                    slenderness_exempt_width_mm, minimum_height, minimum_footprint)
            except (ValueError, TypeError, KeyError, IndexError):
                built = None
            if built is None:
                counts["lidar_geometry_fallbacks"] += 1
                continue
            measured, metadata = built
            if merged is not None:
                merged.add_raw(measured.vertices, measured.faces)
            else:
                measured.name = "BLDG_LIDAR_" + identifier.replace("-", "")[:12]
                obj = measured.build(building_collection, building_material)
                obj["overture_id"] = identifier
                obj["feature_type"] = "building"
                obj["height_source"] = "lidar:" + record.get("method", "measured")
                obj["height_m"] = metadata['height_m']
                obj["roof_geometry"] = ('lidar_infill' if supplement else 'lidar_facets' if record.get('method') == 'faceted_roof' else 'lidar_planes' if record.get('roof_surfaces') else
                                        'lidar_tiers' if record['tiers'] else 'lidar_height')
                obj["lidar_source"] = record.get("source", "")
                obj["lidar_coverage"] = record.get("coverage", 0.0)
                obj["terrain_base_source"] = "parent_footprint"
                obj["underside"] = "draped_to_terrain"
                for key, value in metadata.items():
                    obj[key] = value
            if ground_support is not None:
                for rings in projected_polygon_rings(record.get('infill_geometry') or feature.get("geometry") or {}, transform):
                    if (_needs_ground(rings, heightfield) or ground_support.overlaps_basin(rings)
                            or minimum_ground is not None) and ground_support.footprint(
                                rings, "building", minimum_ground=minimum_ground):
                        counts["buildings_grounded_over_water"] += 1
            if not supplement:
                enhanced_ids.add(identifier)
            else:
                counts['lidar_infill_buildings'] += 1
                infilled_parent_ids.add(identifier)
                # Commit the source-part corrections only after the missing
                # main mass has passed every geometry check.
                part_height_updates.update(part_updates)
            counts["buildings"] += 1
            counts["lidar_buildings"] += 1
            measured_parent_ids.add(identifier)
            counts["lidar_tier_solids"] += metadata["lidar_tiers"]
            counts['lidar_roof_plane_buildings'] += bool(metadata['lidar_roof_planes']) and record.get('method') != 'faceted_roof'
            counts['lidar_faceted_roof_buildings'] += record.get('method') == 'faceted_roof'
            counts['lidar_roof_plane_solids'] += metadata['lidar_roof_planes']
            counts['lidar_part_boundaries_used'] += record.get('part_boundaries_used', 0)
            counts['lidar_estimated_heights_corrected'] += record.get('source_height_decision', record.get('height_decision')) == 'corrected_estimated_height'
            if metadata["minimum_height_lift_mm"] > 0:
                counts["buildings_raised_to_minimum"] += 1
    # Apply the same committed LiDAR height corrections when deciding which
    # source parts can support one another. Replaced assemblies do not qualify.
    filter_parts = [
        {**part, 'properties': {**feature_properties(part), 'height': part_height_updates[feature_id(part)]}}
        if feature_id(part) in part_height_updates else part
        for part in selection.parts
        if str(feature_properties(part).get('building_id') or '') not in enhanced_ids
    ]
    part_widths = source_part_widths(filter_parts,
        lambda geometry: projected_polygon_rings(geometry, transform), vertical,
        floor_height_m, default_height_m, minimum_width_mm, maximum_slenderness)
    counts['building_parts_kept_by_adjacency'] = 0
    for index, (feature, feature_type, collection, material, prefix) in enumerate(jobs):
        restoring_parent = (feature_type == 'building'
                            and feature_id(feature) in selection.suppressed_parent_ids)
        if restoring_parent and feature_id(feature) in built_part_parents:
            continue
        if feature_type == 'building' and feature_id(feature) in infilled_parent_ids:
            continue
        # Preserve identity, footprint, underside and roof shape. Copies leave
        # source caches untouched; a failed infill keeps the entire old assembly.
        if feature_type == 'building_part' and feature_id(feature) in part_height_updates:
            feature = {**feature, 'properties': {**feature_properties(feature),
                       'height': part_height_updates[feature_id(feature)]}}
        properties = feature_properties(feature)
        if feature_id(feature) in enhanced_ids or str(properties.get("building_id") or "") in enhanced_ids:
            continue
        profile = resolve_vertical_profile(
            properties, floor_height_m=floor_height_m, default_height_m=default_height_m
        )
        if profile.thickness_m <= 0.0:
            counts["buildings_invalid_vertical_interval"] += 1
            continue
        source_id = feature_id(feature)
        short_id = source_id.replace("-", "")[:12] or f"{index:08d}"
        builder = merged if merged is not None else MeshBuilder(f"{prefix}_{short_id}")
        solids_before = builder.solids
        is_part = feature_type == "building_part"
        material_index = 1 if is_part else 0
        parent_id = str(properties.get("building_id") or "") if is_part else ""
        parent = parent_lookup.get(parent_id) if parent_id else None
        parent_top_m = (
            positive_number(feature_properties(parent).get("height")) if parent is not None else None
        )
        height_group = source_id
        height_segments = []

        terrain_mm = 0.0
        terrain_top_mm = 0.0
        lift_mm = 0.0
        raised_key = (
            "building_parts_raised_to_minimum" if is_part else "buildings_raised_to_minimum"
        )
        base_source = "own_footprint"
        narrow = slender = False
        roof: Optional[RoofProfile] = None
        roof_geometry = "flat_extrusion"
        # Only a ground-founded mass is draped into the terrain.  An elevated
        # building part must keep its real underside.
        grounded = profile.bottom_m <= 0.0
        minimum_ground = family_floor(parent_id or source_id)
        ground_field = foundation(minimum_ground)
        # Slenderness is judged on the mass's own extent, not its height above
        # the street.  A tower's crown section is a squat block that happens to
        # start 140 m up, and measuring it from the ground would discard it.
        thickness_mm = vertical(profile.thickness_m)

        def too_thin(width: float, thickness_mm: float = thickness_mm) -> Optional[str]:
            """Why a mass this wide cannot print at this thickness, or ``None``."""
            if width < minimum_width_mm:
                return "narrow"
            if (
                maximum_slenderness > 0.0
                and width < slenderness_exempt_width_mm
                and thickness_mm > width * maximum_slenderness
            ):
                return "slender"
            return None

        polygons = projected_polygon_rings(feature.get("geometry") or {}, transform)
        for polygon_index, rings in enumerate(polygons):
            vertex_start = len(builder.vertices)
            # Overture publishes chimneys, spires, and wall fragments as their
            # own masses.  Extruded literally they become needles far below the
            # nozzle width -- the sub-millimetre shards that read as glitched
            # geometry -- so they are dropped and counted rather than printed.
            # A mass at least a nozzle line wide prints whatever its height, so
            # a tower's narrow shaft or wing is kept. Adjoining sections use
            # their assembly width for this filter, keeping their own width
            # for the unchanged roof and minimum-height rules below.
            width_mm = effective_width(rings[0])
            filter_width = part_widths.get((source_id, polygon_index), width_mm) if is_part else width_mm
            rejection = too_thin(filter_width)
            if rejection == "narrow":
                narrow = True
                continue
            if rejection == "slender":
                slender = True
                continue
            kept_by_adjacency = is_part and too_thin(width_mm) is not None
            ground = shared_ground(parent_id) if parent_id else None
            if ground is None:
                terrain_mm = ground_field.minimum_over(rings[0])
                terrain_top_mm = ground_field.maximum_over(rings[0])
            else:
                terrain_mm, terrain_top_mm = ground
                base_source = "parent_footprint"
            bottom = terrain_mm + vertical(profile.bottom_m)
            top = terrain_mm + vertical(profile.top_m)
            if grounded and ground_support is not None and (
                _needs_ground(rings, heightfield) or ground_support.overlaps_basin(rings)
                or minimum_ground is not None
            ):
                if ground_support.footprint(rings, "building", minimum_ground=minimum_ground):
                    counts["buildings_grounded_over_water"] += 1

            roof = resolve_roof(
                properties, profile, is_part, parent_top_m, width_mm / horizontal_scale
            )
            # The lowest point of the mass's top, which its draped underside
            # must stay below where the hill rises over the mass.
            ceiling = top
            wall_top = roof_top = top
            shaped = False
            if roof.kind == "unsupported":
                roof_geometry = f"unimplemented:{roof.shape}"
                counts["roofs_unsupported_shape"] += 1
            elif generate_roofs and roof.is_shaped:
                wall_top = terrain_mm + vertical(roof.wall_top_m)
                roof_top = terrain_mm + vertical(roof.roof_top_m)
                if roof_top - wall_top < minimum_roof_mm:
                    roof_geometry = f"flat:{roof.kind}_below_minimum"
                    counts["roofs_below_minimum"] += 1
                elif len(rings) > 1:
                    roof_geometry = f"flat:{roof.kind}_has_holes"
                    counts["roofs_fallback_flat"] += 1
                else:
                    shaped = True
                    ceiling = wall_top

            # A mass that would print flush with the streets around it is
            # stretched up -- walls only, so a shaped roof keeps its pitch --
            # until its highest point clears the ground by the minimum.  The
            # clearance is measured over the *highest* terrain the footprint
            # covers, so the roof stands proud on the uphill side as well.
            minimum_for_mass = 0.0
            polygon_lift = 0.0
            if minimum_height > 0.0 and footprint_admits_minimum_height(
                rings[0], minimum_footprint
            ):
                minimum_for_mass = minimum_height
                # The finished top, which is the apex only where the shaped
                # roof is actually built.  A roof that fell back to flat still
                # carries its apex in *roof_top*, and measuring the clearance
                # from that left 15 masses short of the minimum.
                finished_top = roof_top if shaped else top
                raise_by = minimum_height - (finished_top - terrain_top_mm)
                if raise_by > 0.0:
                    top += raise_by
                    wall_top += raise_by
                    roof_top += raise_by
                    ceiling += raise_by
                    lift_mm = max(lift_mm, raise_by)
                    polygon_lift = raise_by
                    counts[raised_key] += 1

            def floor(
                x: float,
                y: float,
                grounded: bool = grounded,
                bottom: float = bottom,
                ceiling: float = ceiling,
                ground_field=ground_field,
            ) -> float:
                if not grounded:
                    return bottom
                return min(
                    ground_field.height_mm(x, y) - embed,
                    ceiling - MINIMUM_BURIED_THICKNESS_MM,
                )

            built = False
            if shaped:
                built = _add_shaped_roof(
                    builder, rings[0], floor, wall_top, roof_top, roof, spacing, material_index
                )
                if built:
                    roof_geometry = roof.kind
                    counts["roofs_built"][roof.kind] = counts["roofs_built"].get(roof.kind, 0) + 1
                else:
                    roof_geometry = f"flat:{roof.kind}_rejected"
                    counts["roofs_fallback_flat"] += 1
            if not built:
                if grounded:
                    # The outline follows the ground at every vertex and the
                    # underside is refined across the footprint, so a wide
                    # mass on a hill neither hides a wedge in it nor leaves a
                    # hollow under it.
                    prism = [
                        [(x, y, floor(x, y), top) for x, y in _densified(ring, spacing)]
                        for ring in rings
                    ]
                    built = builder.add_prism(
                        prism,
                        refine=(spacing, lambda x, y, floor=floor, top=top: (floor(x, y), top)),
                        material_index=material_index,
                    )
                else:
                    built = builder.add_flat_prism(
                        rings[0], bottom, top, rings[1:], material_index=material_index
                    )
            if built and kept_by_adjacency:
                counts['building_parts_kept_by_adjacency'] += 1
            if built and height_group in height_only_profiles:
                # Capture this polygon's actual floor while its closure still
                # refers to this mass. Upper vertices alone move for grounded
                # masses; elevated undersides move with their roof.
                upper = [i for i in range(vertex_start, len(builder.vertices))
                         if not grounded or abs(builder.vertices[i][2]-floor(*builder.vertices[i][:2])) > 1e-7]
                if upper:
                    height_segments.append(dict(builder=builder, upper=upper,
                        base=terrain_mm, terrain_top=terrain_top_mm, grounded=grounded,
                        floor=floor, minimum=minimum_for_mass, lift=polygon_lift,
                        peak=max(builder.vertices[i][2]-terrain_mm-polygon_lift for i in upper)))

        if builder.solids == solids_before:
            if narrow:
                counts["rejected_too_narrow"] += 1
            elif slender:
                counts["rejected_too_slender"] += 1
            else:
                counts["buildings_rejected_geometry"] += 1
        else:
            if merged is None:
                obj = builder.build(collection, material)
                _attach_metadata(obj, feature, feature_type, profile, roof, roof_geometry)
                if source_id in part_height_updates:
                    obj['height_source'] = 'lidar:source_part'
                obj["terrain_base_mm"] = float(terrain_mm)
                obj["terrain_base_source"] = base_source
                obj["terrain_top_mm"] = float(terrain_top_mm)
                obj["minimum_height_lift_mm"] = float(lift_mm)
                obj["underside"] = "draped_to_terrain" if grounded else "elevated"
                for segment in height_segments:
                    segment['object'] = obj
            if height_segments:
                height_only_groups[height_group].extend(height_segments)
            if base_source == "parent_footprint":
                counts["parts_founded_on_parent_base"] += 1
            if feature_type == "building":
                counts["buildings"] += 1
                if restoring_parent:
                    counts["building_parents_restored"] += 1
                    counts["suppressed_parents"] -= 1
            else:
                counts["building_parts"] += 1
                built_part_parents.add(parent_id)
                if source_id in part_height_updates:
                    counts['lidar_part_heights'] += 1
                    if parent_id not in measured_parent_ids:
                        counts['lidar_buildings'] += 1
                        measured_parent_ids.add(parent_id)
        if progress_callback is not None and index % 64 == 0:
            progress_callback((index + 1) / total)
    if height_only_profiles:
        from .lidar_height import correct_assemblies
        corrected = correct_assemblies(height_only_groups, height_only_profiles, vertical,
                                       MINIMUM_BURIED_THICKNESS_MM)
        counts['lidar_height_only_buildings'] = corrected
        counts['lidar_buildings'] += corrected
    if merged is not None:
        slots = [
            slot
            for slot in (building_material, part_material or building_material)
            if slot is not None
        ]
        obj = merged.build(building_collection, materials=slots or None)
        if obj is not None:
            obj["feature_type"] = "buildings"
            obj["source"] = "Overture buildings/building and building_part; optional USGS LiDAR measurements"
            obj["buildings"] = counts["buildings"]
            obj["building_parts"] = counts["building_parts"]
    if progress_callback is not None:
        progress_callback(1.0)
    counts["roofs_built"] = dict(sorted(counts["roofs_built"].items()))
    return counts
