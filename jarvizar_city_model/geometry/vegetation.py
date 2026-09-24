"""Tree placement from mapped tree points and forest polygon scatter.

Overture's ``base/land`` type publishes individually mapped trees as Point
features, so most street and park trees are real data rather than decoration.
Forest and wood polygons have no per-tree data, so those are filled with a
deterministic jittered-grid scatter that is reproducible for a given bbox: the
same selection always produces the same model.

Trees are emitted as one merged ``TREES`` object by default: a dense selection
places thousands of them, and one object each makes the outliner unusable and
post-processing a chore. Each tree is an intact scaled, turned copy of one
solid, with its own vertices in merged output. Unmerged trees share a mesh.
Trees overlapping printed roads can be excluded during placement.
"""

from __future__ import annotations

import math
import zlib
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Sequence, Tuple

import bpy

from ..blender.mesh_utils import (
    MeshBuilder,
    projected_polygon_rings,
    tree_mesh_datablock,
    tree_solid_geometry,
)
from ..data.geojson import feature_id
from ..data.land import (
    MAXIMUM_EXTENT_RATIO,
    TREE_BEARING_CATEGORIES,
    classify_surface,
    is_regional_feature,
    is_tree_point,
    tree_point_coordinates,
)
from .planar import point_in_polygon, ring_bounds, signed_area
from .tree_geometry import TreeClearance
from .tree_road_overlap import tree_road_footprints, TREE_ROAD_CLEARANCE_MM


@dataclass
class TreeSettings:
    """Real-world tree dimensions plus the miniature legibility overrides."""

    canopy_diameter_m: float = 7.0
    height_m: float = 11.0
    # Defaults target the normal 0.4 mm nozzle / 0.2 mm layer profile.
    # Widths are the narrow dimension across polygon flats. These floors
    # apply to the finished tree, including its random size variation.
    minimum_height_mm: float = 1.6
    minimum_canopy_diameter_mm: float = 1.1
    embed_mm: float = 0.15
    size_variation: float = 0.18
    scatter_spacing_m: float = 26.0
    scatter_jitter: float = 0.30
    canopy_clearance_mm: float = 0.2
    maximum_trees: int = 24000
    include_mapped_points: bool = True
    include_forest_scatter: bool = True
    # base/land_cover is coarse satellite data.  Polygons far larger than the
    # selection are rejected as regional, and cut water is never planted, so
    # what remains is the wooded hillside the mapped land polygons miss.
    include_land_cover: bool = True
    maximum_extent_ratio: float = MAXIMUM_EXTENT_RATIO
    sides: int = 6
    avoid_roads: bool = True


def _stable_seed(*parts: Any) -> int:
    """Return a process-independent seed so generation is reproducible.

    Python randomizes ``hash()`` for strings between runs, which would make the
    scatter differ every time Blender restarted.
    """
    payload = "|".join(str(part) for part in parts).encode("utf-8")
    return zlib.crc32(payload)


def _jitter(seed: int) -> Tuple[float, float, float]:
    """Return three decorrelated values in ``[0, 1)`` from one seed."""
    a = zlib.crc32(b"x", seed) & 0xFFFFFFFF
    b = zlib.crc32(b"y", seed) & 0xFFFFFFFF
    c = zlib.crc32(b"s", seed) & 0xFFFFFFFF
    return a / 4294967296.0, b / 4294967296.0, c / 4294967296.0


def scatter_points_in_polygon(
    rings: Sequence[Sequence[Tuple[float, float]]],
    spacing: float,
    jitter: float,
    seed: int,
    limit: int,
) -> List[Tuple[float, float, float]]:
    """Return jittered grid points inside a polygon with a size factor each.

    A jittered grid is used rather than uniform random sampling because it
    avoids the clumps and bald patches that random placement produces, without
    the cost of a true Poisson-disc pass.
    """
    if not rings or spacing <= 0.0 or limit <= 0:
        return []
    min_x, min_y, max_x, max_y = ring_bounds(rings[0])
    if max_x - min_x <= 0.0 or max_y - min_y <= 0.0:
        return []

    results: List[Tuple[float, float, float]] = []
    columns = int((max_x - min_x) / spacing) + 1
    rows = int((max_y - min_y) / spacing) + 1
    if columns * rows > limit * 8:
        # Guard against a huge coarse-cover polygon requesting millions of
        # candidate positions before any of them are tested.
        return []
    for row in range(rows):
        for column in range(columns):
            offset_x, offset_y, size = _jitter(_stable_seed(seed, row, column))
            x = min_x + (column + 0.5 + (offset_x - 0.5) * jitter * 2.0) * spacing
            y = min_y + (row + 0.5 + (offset_y - 0.5) * jitter * 2.0) * spacing
            if x > max_x or y > max_y:
                continue
            if point_in_polygon((x, y), rings):
                results.append((x, y, size))
                if len(results) >= limit:
                    return results
    return results


def _tree_dimensions(transform, settings: TreeSettings) -> Tuple[float, float, float]:
    """Return crown radius, visible height, and largest dimension exaggeration.

    Enforce the print floors independently: a wider printable crown should
    not also stretch the tree above the surrounding buildings.
    """
    true_height_mm = transform.vertical_meters_to_model_mm(settings.height_m)
    true_diameter_mm = settings.canopy_diameter_m * transform.scale_x_mm_per_m
    flat_factor = math.cos(math.pi / max(3, settings.sides))
    height_scale = max(1.0, settings.minimum_height_mm / max(true_height_mm, 1.0e-9))
    diameter_scale = max(
        1.0, settings.minimum_canopy_diameter_mm / max(true_diameter_mm * flat_factor, 1.0e-9)
    )
    exaggeration = max(height_scale, diameter_scale)
    height_mm = true_height_mm * height_scale
    diameter_mm = true_diameter_mm * diameter_scale
    return diameter_mm * 0.5, height_mm, exaggeration


def _tree_scale(size, radius, height, settings):
    """Apply variation without shrinking below either finished dimension."""
    flat_factor = math.cos(math.pi / max(3, settings.sides))
    minimum = max(settings.minimum_height_mm / height,
                  settings.minimum_canopy_diameter_mm / (2*radius*flat_factor))
    return max(minimum, 1.0 + (size-0.5)*2.0*settings.size_variation)


def generate_trees(
    land_features: Iterable[Dict[str, Any]],
    land_cover_features: Iterable[Dict[str, Any]],
    transform,
    heightfield,
    collection,
    material,
    settings: TreeSettings | None = None,
    bounds: Tuple[float, float, float, float] | None = None,
    progress_callback=None,
    merge: bool = False,
    reuse_mesh: bool = True,
    road_collection=None,
) -> Dict[str, Any]:
    """Place mapped trees and scattered forest trees.

    With *merge* every tree goes into one ``TREES`` object; otherwise trees
    share one linked mesh. Road avoidance skips entire trees before placement.
    """
    settings = settings or TreeSettings()
    canopy_radius, tree_height, exaggeration = _tree_dimensions(
        transform, settings
    )

    model_bounds = transform.model_bounds
    placements: List[Tuple[float, float, float]] = []
    # A tree standing in a cut-out river would float at the level of a bed
    # that is no longer printed, and one in a recessed pond would stand in its
    # water, so neither is planted.
    in_basin = getattr(heightfield, "in_basin", None)
    skipped_over_water = 0
    skipped_crowded = 0
    skipped_roads = 0
    road_mask = tree_road_footprints(road_collection) if settings.avoid_roads else None
    maximum_factor = max(_tree_scale(0, canopy_radius, tree_height, settings),
                         _tree_scale(1, canopy_radius, tree_height, settings))
    clearance = TreeClearance(canopy_radius * maximum_factor, settings.canopy_clearance_mm)

    def place(x, y, size):
        nonlocal skipped_over_water, skipped_crowded, skipped_roads
        if len(placements) >= settings.maximum_trees:
            return False
        if heightfield.over_open_water(x, y) or (in_basin is not None and in_basin(x, y)):
            skipped_over_water += 1
            return False
        radius = canopy_radius * _tree_scale(size, canopy_radius, tree_height, settings)
        if road_mask is not None:
            sides = max(3, int(settings.sides))
            angle = size * math.tau
            footprint = [(x + radius*math.cos(angle + math.tau*i/sides),
                          y + radius*math.sin(angle + math.tau*i/sides)) for i in range(sides)]
            if road_mask.overlaps(footprint):
                skipped_roads += 1
                return False
        if not clearance.accept(x, y, radius):
            skipped_crowded += 1
            return False
        placements.append((x, y, size))
        return True

    land_features = list(land_features)
    if settings.include_mapped_points:
        for feature in land_features:
            if len(placements) >= settings.maximum_trees:
                break
            if not is_tree_point(feature):
                continue
            coordinates = tree_point_coordinates(feature)
            if coordinates is None:
                continue
            x, y, _z = transform.geographic_to_model(coordinates[0], coordinates[1], 0.0)
            if not (
                model_bounds.min_x_mm <= x <= model_bounds.max_x_mm
                and model_bounds.min_y_mm <= y <= model_bounds.max_y_mm
            ):
                continue
            _a, _b, size = _jitter(_stable_seed(feature_id(feature)))
            place(x, y, size)

    mapped_count = len(placements)

    if settings.include_forest_scatter:
        spacing_mm = max(settings.scatter_spacing_m * transform.scale_x_mm_per_m,
                         2 * canopy_radius + settings.canopy_clearance_mm)
        sources = [("land", land_features)]
        if settings.include_land_cover:
            sources.append(("land_cover", list(land_cover_features)))
        for feature_type, features in sources:
            for feature in features:
                if (
                    classify_surface(feature_type, feature)
                    not in TREE_BEARING_CATEGORIES
                ):
                    continue
                # A regional forest polygon would otherwise carpet the whole
                # selection with trees, including across the river.
                if bounds is not None and is_regional_feature(
                    feature.get("geometry") or {}, bounds, settings.maximum_extent_ratio
                ):
                    continue
                remaining = settings.maximum_trees - len(placements)
                if remaining <= 0:
                    break
                seed = _stable_seed(feature_type, feature_id(feature))
                for rings in projected_polygon_rings(
                    feature.get("geometry") or {}, transform
                ):
                    if abs(signed_area(rings[0])) <= 0.0:
                        continue
                    found = scatter_points_in_polygon(
                        rings, spacing_mm, settings.scatter_jitter, seed, remaining
                    )
                    for item in found:
                        place(*item)
                    remaining = settings.maximum_trees - len(placements)
                    if remaining <= 0:
                        break

    if len(placements) > settings.maximum_trees:
        placements = placements[: settings.maximum_trees]

    total = max(1, len(placements))
    # Trees grow directly from terrain, even beneath raised land/road slabs.
    ground_height = heightfield.height_mm
    shape_options = dict(sides=settings.sides, embed_mm=settings.embed_mm)
    vertices, faces = tree_solid_geometry(canopy_radius, tree_height, **shape_options)
    builder = MeshBuilder("TREES") if merge else None
    mesh = None
    for index, (x, y, size) in enumerate(placements):
        factor = _tree_scale(size, canopy_radius, tree_height, settings)
        angle = size * math.tau
        cos_a, sin_a = math.cos(angle), math.sin(angle)
        base = ground_height(x, y)
        world = [(x + (vx*cos_a-vy*sin_a)*factor,
                  y + (vx*sin_a+vy*cos_a)*factor, base+vz*factor)
                 for vx, vy, vz in vertices]
        if merge:
            builder.add_raw(world, faces)
        else:
            if mesh is None:
                mesh = tree_mesh_datablock("JCM_Tree", canopy_radius, tree_height,
                                          reuse=reuse_mesh, **shape_options)
                if material is not None and not mesh.materials:
                    mesh.materials.append(material)
            obj = bpy.data.objects.new(f"TREE_{index:06d}", mesh)
            collection.objects.link(obj)
            obj["jarvizar_generated"] = True
            obj["feature_type"] = "trees"
            obj.location = (x, y, base)
            obj.scale = (factor, factor, factor)
            obj.rotation_euler = (0.0, 0.0, angle)
        if progress_callback is not None and (index % 32 == 0 or index+1 == total):
            progress_callback((index + 1) / total)
    if merge:
        obj = builder.build(collection, material)
        if obj is not None:
            obj["feature_type"] = "trees"
            obj["source"] = "Overture base/land tree points and forest scatter"
            obj["tree_size_exaggeration"] = round(exaggeration, 3)

    if progress_callback is not None:
        progress_callback(1.0)
    return {
        "trees": len(placements),
        "trees_mapped": mapped_count,
        "trees_scattered": len(placements) - mapped_count,
        "tree_avoid_roads": settings.avoid_roads,
        "trees_skipped_roads": skipped_roads,
        "tree_road_clearance_mm": TREE_ROAD_CLEARANCE_MM,
        "tree_size_exaggeration": round(exaggeration, 3),
        "tree_minimum_height_mm": settings.minimum_height_mm,
        "tree_minimum_canopy_width_mm": settings.minimum_canopy_diameter_mm,
        "tree_capped": len(placements) >= settings.maximum_trees,
        "trees_skipped_over_water": skipped_over_water,
        "trees_skipped_crowded": skipped_crowded,
        "tree_canopy_clearance_mm": settings.canopy_clearance_mm,
    }
