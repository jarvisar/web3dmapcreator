"""Tree placement from mapped tree points and forest polygon scatter.

Overture's ``base/land`` type publishes individually mapped trees as Point
features, so most street and park trees are real data rather than decoration.
Forest and wood polygons have no per-tree data, so those are filled with a
deterministic jittered-grid scatter that is reproducible for a given bbox: the
same selection always produces the same model.

Trees are emitted as one merged ``TREES`` object by default: a dense selection
places thousands of them, and one object each makes the outliner unusable and
post-processing a chore.  Every tree is a scaled, turned copy of one solid
with its own vertices, so the merged mesh stays a set of individually
watertight shells.  The alternative, linked duplicates of one shared mesh
datablock, is kept for inspecting single trees.
"""

from __future__ import annotations

import math
import zlib
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Sequence, Tuple

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

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


@dataclass
class TreeSettings:
    """Real-world tree dimensions plus the miniature legibility overrides."""

    canopy_diameter_m: float = 7.0
    height_m: float = 11.0
    # Defaults target the normal 0.4 mm nozzle / 0.2 mm layer profile.
    # Widths are the narrow dimension across polygon flats. These floors
    # apply to the finished tree, including its random size variation.
    minimum_height_mm: float = 2.0
    minimum_canopy_diameter_mm: float = 1.2
    embed_mm: float = 0.15
    size_variation: float = 0.28
    scatter_spacing_m: float = 22.0
    scatter_jitter: float = 0.42
    maximum_trees: int = 24000
    include_mapped_points: bool = True
    include_forest_scatter: bool = True
    # base/land_cover is coarse satellite data.  Polygons far larger than the
    # selection are rejected as regional, and cut water is never planted, so
    # what remains is the wooded hillside the mapped land polygons miss.
    include_land_cover: bool = True
    maximum_extent_ratio: float = MAXIMUM_EXTENT_RATIO
    sides: int = 6


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
    if not rings or spacing <= 0.0:
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
    """Return cone radius, visible height, and exaggeration."""
    true_height_mm = transform.vertical_meters_to_model_mm(settings.height_m)
    true_diameter_mm = settings.canopy_diameter_m * transform.scale_x_mm_per_m
    flat_factor = math.cos(math.pi / max(3, settings.sides))
    height_scale = max(1.0, settings.minimum_height_mm / max(true_height_mm, 1.0e-9))
    diameter_scale = max(
        1.0, settings.minimum_canopy_diameter_mm / max(true_diameter_mm * flat_factor, 1.0e-9)
    )
    exaggeration = max(height_scale, diameter_scale)
    height_mm = true_height_mm * exaggeration
    diameter_mm = true_diameter_mm * exaggeration
    return diameter_mm * 0.5, height_mm, exaggeration


def _tree_scale(size, radius, height, settings):
    """Apply variation without shrinking below either finished dimension."""
    flat_factor = math.cos(math.pi / max(3, settings.sides))
    minimum = max(settings.minimum_height_mm / height,
                  settings.minimum_canopy_diameter_mm / (2*radius*flat_factor))
    return max(minimum, 1.0 + (size-0.5)*2.0*settings.size_variation)


def _ground_sampler(heightfield, ground_objects):
    """Stand on the actual generated slabs/roads, including their cutouts."""
    surfaces = []
    for obj in ground_objects:
        if obj.type != 'MESH' or not obj.data.polygons:
            continue
        corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
        bounds = (min(p.x for p in corners), min(p.y for p in corners),
                  max(p.x for p in corners), max(p.y for p in corners), max(p.z for p in corners))
        tree = BVHTree.FromPolygons([obj.matrix_world @ v.co for v in obj.data.vertices],
                                   [tuple(p.vertices) for p in obj.data.polygons])
        surfaces.append((bounds, tree))

    def height(x, y):
        z = heightfield.height_mm(x, y)
        for (x0, y0, x1, y1, top), tree in surfaces:
            if x0 <= x <= x1 and y0 <= y <= y1 and top >= z:
                hit = tree.ray_cast(Vector((x, y, top+1)), Vector((0, 0, -1)))[0]
                if hit is not None:
                    z = max(z, hit.z)
        return z
    return height


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
    ground_objects: Iterable = (),
    reuse_mesh: bool = True,
) -> Dict[str, Any]:
    """Place mapped trees and scattered forest trees.

    With *merge* every tree goes into one ``TREES`` object; otherwise each is
    its own object, a linked duplicate of one shared mesh.
    """
    settings = settings or TreeSettings()
    canopy_radius, tree_height, exaggeration = _tree_dimensions(
        transform, settings
    )

    model_bounds = transform.model_bounds
    placements: List[Tuple[float, float, float]] = []
    # A tree standing in a cut-out river would float at the level of a bed
    # that is no longer printed, so the water is simply not planted.
    skipped_over_water = 0

    land_features = list(land_features)
    if settings.include_mapped_points:
        for feature in land_features:
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
            if heightfield.over_open_water(x, y):
                skipped_over_water += 1
                continue
            _a, _b, size = _jitter(_stable_seed(feature_id(feature)))
            placements.append((x, y, size))

    mapped_count = len(placements)
    scattered_count = 0

    if settings.include_forest_scatter:
        spacing_mm = settings.scatter_spacing_m * transform.scale_x_mm_per_m
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
                    kept = [
                        item
                        for item in found
                        if not heightfield.over_open_water(item[0], item[1])
                    ]
                    skipped_over_water += len(found) - len(kept)
                    placements.extend(kept)
                    scattered_count += len(kept)
                    remaining -= len(kept)
                    if remaining <= 0:
                        break

    if len(placements) > settings.maximum_trees:
        placements = placements[: settings.maximum_trees]

    total = max(1, len(placements))
    ground_height = _ground_sampler(heightfield, ground_objects) if placements else heightfield.height_mm
    shape_options = dict(sides=settings.sides, embed_mm=settings.embed_mm)
    if merge:
        # Every tree is the one solid scaled, turned about Z, and moved onto
        # the ground: the same transform the linked duplicates carry as
        # object properties, baked into the vertices instead.
        vertices, faces = tree_solid_geometry(
            canopy_radius, tree_height, **shape_options
        )
        builder = MeshBuilder("TREES")
        for index, (x, y, size) in enumerate(placements):
            factor = _tree_scale(size, canopy_radius, tree_height, settings)
            angle = size * math.tau
            cos_a, sin_a = math.cos(angle), math.sin(angle)
            base = ground_height(x, y)
            builder.add_raw(
                [
                    (
                        x + (vx * cos_a - vy * sin_a) * factor,
                        y + (vx * sin_a + vy * cos_a) * factor,
                        base + vz * factor,
                    )
                    for vx, vy, vz in vertices
                ],
                faces,
            )
            if progress_callback is not None and index % 256 == 0:
                progress_callback((index + 1) / total)
        obj = builder.build(collection, material)
        if obj is not None:
            obj["feature_type"] = "trees"
            obj["source"] = "Overture base/land tree points and forest scatter"
            obj["tree_size_exaggeration"] = round(exaggeration, 3)
    else:
        mesh = tree_mesh_datablock(
            "JCM_Tree",
            canopy_radius,
            tree_height,
            reuse=reuse_mesh,
            **shape_options,
        )
        if material is not None and not mesh.materials:
            mesh.materials.append(material)
        for index, (x, y, size) in enumerate(placements):
            obj = bpy.data.objects.new(f"TREE_{index:06d}", mesh)
            collection.objects.link(obj)
            obj["jarvizar_generated"] = True
            obj.location = (x, y, ground_height(x, y))
            factor = _tree_scale(size, canopy_radius, tree_height, settings)
            obj.scale = (factor, factor, factor)
            obj.rotation_euler = (0.0, 0.0, size * math.tau)
            if progress_callback is not None and index % 256 == 0:
                progress_callback((index + 1) / total)

    if progress_callback is not None:
        progress_callback(1.0)
    return {
        "trees": len(placements),
        "trees_mapped": min(mapped_count, len(placements)),
        "trees_scattered": max(0, len(placements) - mapped_count),
        "tree_size_exaggeration": round(exaggeration, 3),
        "tree_minimum_height_mm": settings.minimum_height_mm,
        "tree_minimum_canopy_width_mm": settings.minimum_canopy_diameter_mm,
        "tree_capped": len(placements) >= settings.maximum_trees,
        "trees_skipped_over_water": skipped_over_water,
    }
