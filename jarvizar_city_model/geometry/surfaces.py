"""Draped ground-surface slabs: water, parks, forest floor, and plazas.

Surfaces are thin solids that follow the terrain rather than flat decals, so
the model stays printable as one fused object.  Each slab sinks slightly below
the terrain surface and rises slightly above it: the embedded part guarantees
the slab fuses with the terrain mesh in a slicer, and the raised part makes the
surface unambiguously visible instead of z-fighting with the ground.

Water is the deliberate exception.  A river or lake is level, so its surface is
solved once per feature from a low-order statistic of the terrain inside it
rather than draped over the channel bed.  Water large enough to read as
landscape is also cut clean out of the terrain solid, and the slab that
optionally fills the opening is a full-depth plug rather than a floating sheet.
"""

from __future__ import annotations

from dataclasses import dataclass
from copy import copy
import math
from typing import Any, Dict, Iterable, List, Sequence, Tuple

from ..blender.mesh_utils import MeshBuilder, _prism_geometry, projected_polygon_rings
from ..data.land import (
    DEFAULT_SURFACE_PRIORITY,
    MAXIMUM_EXTENT_RATIO,
    MINIMUM_WATER_CUT_AREA_M2,
    SURFACE_CATEGORIES,
    classify_surface,
    is_printable_water,
    is_regional_feature,
    is_water_deck,
    is_untyped_water,
    recessed_water_kind,
    surface_priority,
)
from .planar import EPSILON, clean_ring, densify_ring, interior_grid_points, ring_bounds, signed_area
from .surface_priority import _lattice, _solid, _triangulate, cut_surface_overlaps
from .water_geometry import projected_water_polygons, valid_water_polygon


@dataclass
class SurfaceSettings:
    """Vertical placement of ground surfaces, in model millimetres."""

    priority_order: Tuple[str, ...] = DEFAULT_SURFACE_PRIORITY

    # Two 0.2 mm layers above the ground: enough to read as a colour region
    # of its own in a multi-material print, still below a 0.6 mm road.
    surface_rise_mm: float = 0.4
    # How far the slab reaches below the ground.  Its underside follows the
    # terrain across the whole slab, so this only has to guarantee that the
    # two solids overlap in a slicer; anything more is colour buried where
    # it is never seen, costing a filament change on every layer it spans.
    surface_embed_mm: float = 0.15
    water_thickness_mm: float = 1.2
    # Open water reads as a flat plateau in the elevation data, so the median
    # of interior samples is the surface itself rather than a bank height.
    water_level_percentile: float = 0.5
    water_sample_spacing_mm: float = 1.0
    # Water must sit slightly *above* the solved level, exactly like a land
    # slab. The terrain mesh is a closed solid, so a surface placed below
    # the ground is simply hidden inside it rather than looking sunken.
    water_surface_offset_mm: float = 0.18
    minimum_area_mm2: float = 0.25
    drape_spacing_mm: float = 1.5
    maximum_extent_ratio: float = MAXIMUM_EXTENT_RATIO
    # Cut open water out of the terrain rather than covering it over.
    cut_from_terrain: bool = True
    minimum_cut_area_m2: float = MINIMUM_WATER_CUT_AREA_M2
    recess_ponds_and_fountains: bool = True
    pond_recess_depth_mm: float = 1.0
    pond_water_thickness_mm: float = 0.8

    def __post_init__(self):
        if self.recess_ponds_and_fountains and not (
            math.isfinite(self.pond_recess_depth_mm)
            and math.isfinite(self.pond_water_thickness_mm)
            and 0 < self.pond_water_thickness_mm <= self.pond_recess_depth_mm
        ):
            raise ValueError("Pond/fountain water thickness must be positive and not exceed recess depth")


def _densified(ring: Sequence[Tuple[float, float]], spacing: float):
    """Densify a ring for draping, then re-clean it at float32 tolerance.

    Densifying can place inserted vertices closer together than Blender's
    float32 mesh coordinates can distinguish, and any such pair degenerates a
    cap triangle.  A dropped triangle leaves a hole, and the "watertight" solid
    silently stops being watertight -- so the ring is cleaned in the frame it
    will actually be built in.
    """
    cleaned = clean_ring(densify_ring(ring, spacing), EPSILON)
    return cleaned if len(cleaned) >= 3 else None


def _draped_slab(rings, draped, thickness: float, spacing: float):
    """Build one slab over a polygon, draped at its outline and a fixed lattice.

    The outline and holes are densified to the drape spacing and triangulated
    together with the surface-priority lattice, so the cap follows the ground
    across its interior with evenly sized triangles. Refining an outline fan
    instead split its long slivers into hundreds of thousands of faces on a
    large park. Later cuts find the same lattice points already on the surface.
    Returns ``(vertices, faces)`` or ``None``.
    """
    points, loops = [], []
    for index, ring in enumerate(rings):
        dense = _densified(ring, spacing)
        if dense is None:
            if index == 0:
                return None
            continue
        if (signed_area(dense) < 0) != (index > 0):
            dense.reverse()
        loops.append((0, list(range(len(points), len(points) + len(dense)))))
        points.extend(dense)
    points.extend(_lattice(points, ring_bounds(points[:len(loops[0][1])]), spacing))
    out_points, out_faces, _origins, winding = _triangulate(points, loops, 1)
    kept = [tuple(face) for face, (inside,) in zip(out_faces, winding) if inside > 0]
    if not kept:
        return None
    vertices, faces, _shells = _solid(
        out_points, kept, lambda index: draped(*out_points[index])[1], thickness)
    return vertices, faces


def _ring_area(ring: Sequence[Tuple[float, float]]) -> float:
    from .planar import signed_area

    return abs(signed_area(ring))


def generate_land_surfaces(
    typed_features: Sequence[Tuple[str, Iterable[Dict[str, Any]]]],
    transform,
    heightfield,
    collection,
    materials: Dict[str, Any],
    settings: SurfaceSettings | None = None,
    bounds: Tuple[float, float, float, float] | None = None,
    progress_callback=None,
    ground_support=None,
) -> Dict[str, Any]:
    """Generate one batched slab object per surface category.

    *typed_features* pairs each Overture type name with its features, because
    the same class string means different things in ``land``, ``land_use``, and
    ``land_cover``.
    """
    settings = settings or SurfaceSettings()
    builders: Dict[str, MeshBuilder] = {}
    if getattr(heightfield, "basins", None):
        # Build the surrounding park/paving at its original surface. Drape
        # refinement through a basin would otherwise slope adjacent dry slabs
        # into it. The exact basin footprint is removed from these slabs later.
        heightfield = copy(heightfield)
        heightfield.basins = []
    counts: Dict[str, int] = {}
    rejected = 0
    regional = 0

    classified: List[Tuple[int, str, Dict[str, Any], str]] = []
    for feature_type, features in typed_features:
        for feature in features:
            geometry = feature.get("geometry") or {}
            if geometry.get("type") not in {"Polygon", "MultiPolygon"}:
                continue
            category = classify_surface(feature_type, feature)
            if category is None:
                continue
            if bounds is not None and is_regional_feature(
                geometry, bounds, settings.maximum_extent_ratio
            ):
                regional += 1
                continue
            classified.append((surface_priority(category), category, feature, feature_type))

    # Stable category ordering; actual overlaps are cut from the finished slabs.
    classified.sort(key=lambda item: item[0])
    total = max(1, len(classified))

    rise = settings.surface_rise_mm
    embed = settings.surface_embed_mm
    spacing = settings.drape_spacing_mm

    def draped(x: float, y: float):
        """Bottom and top of the slab at any point, for the cap's interior."""
        height = surface_field.height_mm(x, y)
        return height - embed, height + rise

    for index, (_priority, category, feature, feature_type) in enumerate(classified):
        builder = builders.setdefault(category, MeshBuilder(f"SURFACE_{category.upper()}"))
        added = False
        for rings in projected_polygon_rings(feature.get("geometry") or {}, transform):
            if _ring_area(rings[0]) < settings.minimum_area_mm2:
                continue
            keep_paving = category == 'paved' and ground_support is not None
            # Slabs are draped whole; cut_water_land_surfaces later removes
            # the exact water footprints, including any over a cut river.
            surface_field = (ground_support.foundation_field(ground_support.minimum_ground(rings,'paved'))
                             if keep_paving else heightfield)
            built = _draped_slab(rings, draped, rise + embed, spacing)
            if built is not None and builder.add_raw(*built):
                added = True
        if added:
            counts[category] = counts.get(category, 0) + 1
        else:
            rejected += 1
        if progress_callback is not None and index % 32 == 0:
            progress_callback(.75 * (index + 1) / total)

    for category in SURFACE_CATEGORIES:
        builder = builders.get(category)
        if builder is None:
            continue
        obj = builder.build(collection, materials.get(f"surface_{category}"))
        if obj is not None:
            obj["feature_type"] = "land_surface"
            obj["surface_category"] = category
            obj["source"] = "Overture base land / land_use / land_cover"

    overlap_counts = cut_surface_overlaps(
        collection, rise + embed, settings.priority_order,
        progress_callback=(lambda f: progress_callback(.75 + .25*f)) if progress_callback else None,
    )
    return {
        "land_surfaces": sum(counts.values()),
        "land_surface_categories": dict(sorted(counts.items())),
        "land_surfaces_rejected": rejected,
        "land_surfaces_regional_skipped": regional,
        **overlap_counts,
    }


@dataclass
class WaterBody:
    """One validated water polygon, including its ready-to-place unit prism."""

    rings: List[List[Tuple[float, float]]]
    bed_mm: float
    top_mm: float
    geometry: Tuple[List[Tuple[float, float, float]], List[Tuple[int, ...]]]
    area_m2: float = 0.0
    cut: bool = False
    basin_kind: str = ""


def _source_water_area(geometry, transform):
    """Uncropped feature area; a tiny viewport must not reclassify a large river."""
    try:
        polygons = geometry.get('coordinates') or []
        if geometry.get('type') == 'Polygon':
            polygons = [polygons]
        area = 0.0
        for polygon in polygons:
            rings = [[transform.geographic_to_model(p[0], p[1], 0)[:2] for p in ring]
                     for ring in polygon]
            if not rings or any(len(ring) < 3 for ring in rings):
                return math.inf
            part_area = _ring_area(rings[0]) - sum(_ring_area(ring) for ring in rings[1:])
            if not math.isfinite(part_area) or part_area <= 0:
                return math.inf
            area += part_area
        return area if area > 0 else math.inf
    except (ValueError, TypeError, IndexError, OverflowError):
        return math.inf


def solve_water_bodies(
    features: Iterable[Dict[str, Any]],
    transform,
    heightfield,
    settings: SurfaceSettings | None = None,
) -> Tuple[List[WaterBody], Dict[str, int]]:
    """Clip water polygons and solve a level surface for each one.

    A lake or river is level, and the elevation dataset already reports open
    water as a flat plateau.  The median of samples taken *inside* the polygon
    therefore recovers the true water surface, and is robust to the noisy cells
    near the banks.  The outline is only used for a channel too narrow to
    contain any interior sample point, since ring vertices sit on the shore.
    """
    settings = settings or SurfaceSettings()
    bodies: List[WaterBody] = []
    skipped_non_polygon = 0
    rejected = 0
    invalid_polygons = 0
    failed_meshes = 0
    basin_duplicates = 0
    seen_basins = set()
    # Model millimetres square per real square metre, so a clipped ring can be
    # judged against a real-world threshold without reprojecting it.
    area_scale = max(
        transform.scale_x_mm_per_m * transform.scale_y_mm_per_m, 1.0e-12
    )

    for feature in features:
        basin_kind = recessed_water_kind(feature) if settings.recess_ponds_and_fountains else None
        if (settings.recess_ponds_and_fountains and not basin_kind and is_untyped_water(feature)
                and _source_water_area(feature.get('geometry') or {}, transform)
                < MINIMUM_WATER_CUT_AREA_M2 * area_scale):
            basin_kind = 'untyped_water'
        if not basin_kind and not is_printable_water(feature):
            skipped_non_polygon += 1
            continue
        added = False
        polygons, invalid = projected_water_polygons(feature.get("geometry") or {}, transform)
        invalid_polygons += invalid
        for polygon in polygons:
            # Never discard a failed hole: doing so turns an island into water.
            rings = [clean_ring(ring, EPSILON) for ring in polygon]
            if not all(rings) or not valid_water_polygon(rings):
                invalid_polygons += 1
                continue
            model_area = _ring_area(rings[0]) - sum(_ring_area(hole) for hole in rings[1:])
            if model_area < settings.minimum_area_mm2:
                continue
            if basin_kind:
                def canonical(ring):
                    start = min(range(len(ring)), key=ring.__getitem__)
                    return tuple(ring[start:] + ring[:start])
                key = (canonical(rings[0]), tuple(sorted(canonical(ring) for ring in rings[1:])))
                if key in seen_basins:
                    basin_duplicates += 1
                    added = True
                    continue
            # Water is flat, so densification adds no shape and can make the
            # triangulator fail on long, almost-collinear coastlines. Build the
            # exact prism once, before either flattening or cutting terrain.
            geometry = _prism_geometry([[(x, y, 0.0, 1.0) for x, y in ring] for ring in rings])
            if not geometry[0] or not geometry[1]:
                failed_meshes += 1
                continue
            interior = interior_grid_points(rings, settings.water_sample_spacing_mm)
            samples = (
                interior
                if len(interior) >= 8
                else densify_ring(rings[0], settings.drape_spacing_mm)
            )
            bed = heightfield.percentile_over(samples, settings.water_level_percentile)
            if basin_kind:
                bank = heightfield.minimum_over(
                    point for ring in rings for point in densify_ring(ring, settings.drape_spacing_mm)
                )
                bed = bank - settings.pond_recess_depth_mm
                seen_basins.add(key)
            area_m2 = model_area / area_scale
            bodies.append(
                WaterBody(
                    rings=[list(ring) for ring in rings],
                    bed_mm=bed,
                    top_mm=bed + (settings.pond_water_thickness_mm if basin_kind
                                  else settings.water_surface_offset_mm),
                    geometry=geometry,
                    area_m2=area_m2,
                    cut=(
                        not basin_kind and settings.cut_from_terrain
                        and area_m2 >= settings.minimum_cut_area_m2
                    ),
                    basin_kind=basin_kind or "",
                )
            )
            added = True
        if not added:
            rejected += 1

    return bodies, {
        "water_bodies": len(bodies),
        "water_rejected": rejected,
        "water_skipped_non_polygon": skipped_non_polygon,
        "water_invalid_polygons": invalid_polygons,
        "water_meshes_rejected": failed_meshes,
        "water_basins": sum(bool(body.basin_kind) for body in bodies),
        "water_basin_duplicates": basin_duplicates,
    }


def flatten_terrain_under_water(heightfield, bodies: Sequence[WaterBody]) -> int:
    """Carve the terrain down to each solved water surface. Returns node count."""
    lowered = 0
    for body in bodies:
        if not body.basin_kind:
            lowered += heightfield.lower_inside(body.rings, body.bed_mm)
    return lowered


def cut_water_from_terrain(
    heightfield,
    bodies: Sequence[WaterBody],
    deck_features: Sequence[Tuple[str, Iterable[Dict[str, Any]]]] = (),
    transform=None,
    footprints: Iterable[Dict[str, Any]] = (),
) -> Dict[str, Any]:
    """Mark the terrain grid so open water is removed from the printed solid.

    Structures are subtracted afterwards rather than being excluded from the
    water up front, because a pier is mapped as lying across the bank and only
    its overlap with the water needs to survive as land.  *footprints* does the
    same for anything else that must keep its ground -- a boathouse or a
    floating restaurant is mapped inside the river, and cutting the river from
    under it would leave it hanging over the opening.

    The mask keeps the exact outlines, so the terrain is cut along them and
    ground is kept under a footprint of any width, even a dock narrower than a
    terrain cell.  Every mapped deck that touches the water is remembered so a
    raised pedestal can be built under it afterwards.
    """
    cuttable = [body for body in bodies if body.cut]
    if not cuttable:
        heightfield.restored_footprints = []
        return {"water_cut_bodies": 0}

    mask = heightfield.new_void_mask()
    for body in cuttable:
        mask.add_polygon(body.rings)
    heightfield.restored_footprints = []

    decks = 0
    if transform is not None:
        for feature_type, features in deck_features:
            for feature in features:
                if not is_water_deck(feature_type, feature):
                    continue
                for rings in projected_polygon_rings(
                    feature.get("geometry") or {}, transform
                ):
                    if not mask.touches_water(rings):
                        continue
                    heightfield.restored_footprints.append(rings)
                    if mask.remove_polygon(rings):
                        decks += 1

    grounded = 0
    if transform is not None:
        for feature in footprints:
            for rings in projected_polygon_rings(
                feature.get("geometry") or {}, transform
            ):
                if mask.remove_polygon(rings):
                    grounded += 1

    if not mask.water_polygons:
        heightfield.void_mask = None
        heightfield.restored_footprints = []
        return {"water_cut_bodies": 0}

    return {
        "water_cut_bodies": len(cuttable),
        "water_cut_nodes": mask.wet_nodes,
        "water_cut_decks_restored": decks,
        "water_cut_decks_over_water": len(heightfield.restored_footprints),
        "water_cut_structures_grounded": grounded,
    }


def generate_water(
    bodies: Sequence[WaterBody],
    collection,
    material,
    settings: SurfaceSettings | None = None,
    terrain_bottom_mm: float | None = None,
    progress_callback=None,
) -> Dict[str, Any]:
    """Batch recessed and ordinary water into separate objects.

    A body that was cut out of the terrain becomes a full-depth plug reaching
    the model's own underside, so it drops into the opening as a separate
    printable part.  A thin sheet floating at water level over an open void
    would be neither.
    """
    settings = settings or SurfaceSettings()
    builders = {False: MeshBuilder("WATER_SURFACE"), True: MeshBuilder("WATER_RECESSED")}
    built = 0
    plugs = 0
    total = max(1, len(bodies))
    for index, body in enumerate(bodies):
        builder = builders[bool(body.basin_kind)]
        if body.basin_kind:
            bottom = body.bed_mm
        elif body.cut and terrain_bottom_mm is not None:
            bottom = terrain_bottom_mm
        else:
            bottom = body.top_mm - settings.water_thickness_mm
        vertices, faces = body.geometry
        # Reuse the topology accepted by the solver; only the two Z levels
        # change now that terrain generation has established the model base.
        placed = [(x, y, body.top_mm if z else bottom) for x, y, z in vertices]
        if builder.add_raw(placed, faces):
            built += 1
            if body.cut and terrain_bottom_mm is not None:
                plugs += 1
        if progress_callback is not None and index % 8 == 0:
            progress_callback((index + 1) / total)

    for recessed, builder in builders.items():
        obj = builder.build(collection, material)
        if obj is None:
            continue
        obj["feature_type"] = "water_surface"
        obj["source"] = "Overture base/water"
        obj["water_recessed"] = recessed
        obj["water_model"] = (
            "recessed_basin_fill" if recessed else
            "full_depth_plug_in_cut_terrain" if plugs else
            "flat_surface_per_feature_with_hydro_flattened_bed"
        )

    if progress_callback is not None:
        progress_callback(1.0)
    return {"water_surfaces_built": built, "water_full_depth_plugs": plugs,
            "water_basin_surfaces": sum(bool(body.basin_kind) for body in bodies)}
