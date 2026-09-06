"""Blender-facing generation of building masses."""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any, Callable, Dict, List, Optional, Tuple

from ..blender.mesh_utils import MeshBuilder, projected_polygon_rings
from ..data.geojson import feature_id, feature_properties, first_osm_id
from .buildings import (
    footprint_admits_minimum_height,
    resolve_vertical_profile,
    select_building_geometry,
)
from .planar import EPSILON, clean_ring, densify_ring, effective_width
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


def _positive(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number > 0.0 else None


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
    maximum_slenderness: float = 15.0,
    progress_callback=None,
    ground_support=None,
    generate_roofs: bool = True,
    minimum_roof_mm: float = 0.15,
    slenderness_exempt_width_mm: float = 0.45,
    merge: bool = False,
    height_scale: float = 1.0,
    minimum_height_mm: float = 0.0,
    minimum_height_footprint_mm: float = 0.0,
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
    selection = select_building_geometry(building_features, part_features)
    building_features = list(building_features)
    parent_lookup = {feature_id(feature): feature for feature in building_features}
    parts_by_parent: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for part in selection.parts:
        parent_id = str(feature_properties(part).get("building_id") or "")
        if parent_id:
            parts_by_parent[parent_id].append(part)
    ground_cache: Dict[str, Optional[Tuple[float, float]]] = {}
    embed = float(embed_mm)
    spacing = float(drape_spacing_mm)

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
        parent = parent_lookup.get(parent_id)
        features = [parent] if parent is not None else []
        features.extend(parts_by_parent.get(parent_id, []))
        for feature in features:
            for rings in projected_polygon_rings(feature.get("geometry") or {}, transform):
                bases.append(heightfield.minimum_over(rings[0]))
                ceilings.append(heightfield.maximum_over(rings[0]))
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

    counts: Dict[str, Any] = {
        "buildings": 0,
        "building_parts": 0,
        "suppressed_parents": len(selection.suppressed_parent_ids),
        "duplicate_outlines_suppressed": len(selection.duplicate_ids),
        "buildings_rejected_geometry": 0,
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
    for index, (feature, feature_type, collection, material, prefix) in enumerate(jobs):
        properties = feature_properties(feature)
        profile = resolve_vertical_profile(
            properties, floor_height_m=floor_height_m, default_height_m=default_height_m
        )
        source_id = feature_id(feature)
        short_id = source_id.replace("-", "")[:12] or f"{index:08d}"
        builder = merged if merged is not None else MeshBuilder(f"{prefix}_{short_id}")
        solids_before = builder.solids
        is_part = feature_type == "building_part"
        material_index = 1 if is_part else 0
        parent_id = str(properties.get("building_id") or "") if is_part else ""
        parent = parent_lookup.get(parent_id) if parent_id else None
        parent_top_m = (
            _positive(feature_properties(parent).get("height")) if parent is not None else None
        )

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
        # Slenderness is judged on the mass's own extent, not its height above
        # the street.  A tower's crown section is a squat block that happens to
        # start 140 m up, and measuring it from the ground would discard it.
        thickness_mm = vertical(profile.thickness_m)
        polygons = projected_polygon_rings(feature.get("geometry") or {}, transform)
        for rings in polygons:
            # Overture publishes chimneys, spires, and wall fragments as their
            # own masses.  Extruded literally they become needles far below the
            # nozzle width -- the sub-millimetre shards that read as glitched
            # geometry -- so they are dropped and counted rather than printed.
            # A mass at least a nozzle line wide prints whatever its height, so
            # a tower's narrow shaft or wing is kept; only sub-line needles are
            # judged on slenderness.
            width_mm = effective_width(rings[0])
            if width_mm < minimum_width_mm:
                narrow = True
                continue
            if (
                maximum_slenderness > 0.0
                and width_mm < slenderness_exempt_width_mm
                and thickness_mm > width_mm * maximum_slenderness
            ):
                slender = True
                continue
            ground = shared_ground(parent_id) if parent_id else None
            if ground is None:
                terrain_mm = heightfield.minimum_over(rings[0])
                terrain_top_mm = heightfield.maximum_over(rings[0])
            else:
                terrain_mm, terrain_top_mm = ground
                base_source = "parent_footprint"
            bottom = terrain_mm + vertical(profile.bottom_m)
            top = terrain_mm + vertical(profile.top_m)
            if grounded and ground_support is not None and _needs_ground(rings, heightfield):
                if ground_support.footprint(rings, "building"):
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
            if minimum_height > 0.0 and footprint_admits_minimum_height(
                rings[0], minimum_footprint
            ):
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
                    counts[raised_key] += 1

            def floor(
                x: float,
                y: float,
                grounded: bool = grounded,
                bottom: float = bottom,
                ceiling: float = ceiling,
            ) -> float:
                if not grounded:
                    return bottom
                return min(
                    heightfield.height_mm(x, y) - embed,
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
                obj["terrain_base_mm"] = float(terrain_mm)
                obj["terrain_base_source"] = base_source
                obj["terrain_top_mm"] = float(terrain_top_mm)
                obj["minimum_height_lift_mm"] = float(lift_mm)
                obj["underside"] = "draped_to_terrain" if grounded else "elevated"
            if base_source == "parent_footprint":
                counts["parts_founded_on_parent_base"] += 1
            if feature_type == "building":
                counts["buildings"] += 1
            else:
                counts["building_parts"] += 1
        if progress_callback is not None and index % 64 == 0:
            progress_callback((index + 1) / total)
    if merged is not None:
        slots = [
            slot
            for slot in (building_material, part_material or building_material)
            if slot is not None
        ]
        obj = merged.build(building_collection, materials=slots or None)
        if obj is not None:
            obj["feature_type"] = "buildings"
            obj["source"] = "Overture buildings/building and building_part"
            obj["buildings"] = counts["buildings"]
            obj["building_parts"] = counts["building_parts"]
    if progress_callback is not None:
        progress_callback(1.0)
    counts["roofs_built"] = dict(sorted(counts["roofs_built"].items()))
    return counts
