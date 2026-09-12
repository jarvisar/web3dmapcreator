"""Headless Blender smoke test for registration and full model generation.

Everything here is synthetic, so the test needs no network access and no
cached download.  It covers each generator that produces geometry, the
interactions between them (bridges over water, buildings founded on a slope),
and the printability contract that every generated solid is watertight.
"""

from __future__ import annotations

import array
import json
import math
from pathlib import Path
import sys
import tempfile

import bmesh
import bpy


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import jarvizar_city_model
from jarvizar_city_model.data.cache import Bounds, CacheBundle
from jarvizar_city_model.data.dem import DEMTerrain, ElevationGrid
from jarvizar_city_model.data.projection import (
    create_fixed_scale_transform,
    create_miniature_transform,
)
from jarvizar_city_model.data.geojson import load_feature_collection, polygon_features
from jarvizar_city_model.geometry.heightfield import ModelHeightField
from jarvizar_city_model.geometry.planar import point_in_polygon
from jarvizar_city_model.geometry.surfaces import (
    SurfaceSettings,
    flatten_terrain_under_water,
    solve_water_bodies,
)


BOUNDS = Bounds(-84.51, 39.09, -84.50, 39.10)


def polygon(identifier, coordinates, **properties):
    return {
        "type": "Feature",
        "id": identifier,
        "properties": properties,
        "geometry": {"type": "Polygon", "coordinates": coordinates},
    }


def linestring(identifier, coordinates, **properties):
    return {
        "type": "Feature",
        "id": identifier,
        "properties": properties,
        "geometry": {"type": "LineString", "coordinates": coordinates},
    }


def point(identifier, coordinate, **properties):
    return {
        "type": "Feature",
        "id": identifier,
        "properties": properties,
        "geometry": {"type": "Point", "coordinates": coordinate},
    }


def write_collection(path, features):
    path.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}),
        encoding="utf-8",
    )


def write_synthetic_dem(bundle, columns=48, rows=48, relief_m=90.0):
    """Write a north-south V-shaped valley under the eastern half of the bbox.

    The valley sits directly beneath the bridge half of the test road.  A
    generator that draped the deck per-vertex would follow the valley floor
    down; a correctly anchored deck spans straight across it.
    """
    values = array.array("f")
    for row in range(rows):
        for column in range(columns):
            fraction = column / (columns - 1)
            depth = min(1.0, abs(fraction - 0.75) / 0.25)
            values.append(120.0 + relief_m * depth)
    with (bundle.path / "terrain.f32").open("wb") as handle:
        values.tofile(handle)
    (bundle.path / "terrain.json").write_text(
        json.dumps(
            {
                "format": "jcm_elevation_grid",
                "version": 1,
                "west": BOUNDS.west,
                "south": BOUNDS.south,
                "east": BOUNDS.east,
                "north": BOUNDS.north,
                "columns": columns,
                "rows": rows,
                "min_m": min(values),
                "max_m": max(values),
                "zoom": 13,
                "ground_resolution_m": 15.0,
                "source": "synthetic-test",
            }
        ),
        encoding="utf-8",
    )


def assert_manifold(obj):
    mesh = bmesh.new()
    mesh.from_mesh(obj.data)
    non_manifold = [edge.index for edge in mesh.edges if not edge.is_manifold]
    mesh.free()
    if non_manifold:
        raise AssertionError(
            f"{obj.name} has {len(non_manifold)} non-manifold edges: {non_manifold[:10]}"
        )


def object_z_range(obj):
    zs = [(obj.matrix_world @ vertex.co).z for vertex in obj.data.vertices]
    return min(zs), max(zs)


def _distance_to_ring(point, ring):
    """Distance from a point to the nearest edge of a closed ring."""
    best = float("inf")
    count = len(ring)
    for index in range(count):
        ax, ay = ring[index]
        bx, by = ring[(index + 1) % count]
        dx, dy = bx - ax, by - ay
        length = dx * dx + dy * dy
        t = 0.0 if length <= 0.0 else max(
            0.0, min(1.0, ((point[0] - ax) * dx + (point[1] - ay) * dy) / length)
        )
        best = min(best, math.hypot(point[0] - (ax + dx * t), point[1] - (ay + dy * t)))
    return best


def main():
    jarvizar_city_model.register()
    try:
        with tempfile.TemporaryDirectory(prefix="jcm_smoke_", dir=str(PROJECT_ROOT)) as tmp:
            cache_root = Path(tmp)
            settings = bpy.context.scene.jarvizar_city_model
            settings.west, settings.south, settings.east, settings.north = (
                str(value) for value in BOUNDS.as_tuple()
            )
            settings.cache_directory = str(cache_root)
            bundle = CacheBundle(cache_root, BOUNDS)
            bundle.ensure_directory()

            parent_ring = [[-84.508, 39.092], [-84.506, 39.092], [-84.506, 39.094], [-84.508, 39.094], [-84.508, 39.092]]
            part_one = [[-84.508, 39.092], [-84.507, 39.092], [-84.507, 39.094], [-84.508, 39.094], [-84.508, 39.092]]
            part_two = [[-84.507, 39.092], [-84.506, 39.092], [-84.506, 39.094], [-84.507, 39.094], [-84.507, 39.092]]
            outer = [[-84.505, 39.095], [-84.502, 39.095], [-84.502, 39.098], [-84.505, 39.098], [-84.505, 39.095]]
            hole = [[-84.5045, 39.0955], [-84.5045, 39.0965], [-84.5035, 39.0965], [-84.5035, 39.0955], [-84.5045, 39.0955]]

            write_collection(
                bundle.data_path("building"),
                [
                    polygon("parent-a", [parent_ring], has_parts=True, height=22.0),
                    polygon(
                        "parent-a-twin",
                        [parent_ring],
                        has_parts=False,
                        height=40.0,
                        names={"primary": "Twin Outline"},
                    ),
                    polygon("building-b", [outer, hole], has_parts=False),
                    # A house with a gabled roof taken out of its total height,
                    # and a tower whose pyramid is likewise inside its height.
                    polygon(
                        "house-gabled",
                        [
                            [
                                [-84.5060, 39.0960],
                                [-84.5056, 39.0960],
                                [-84.5056, 39.0963],
                                [-84.5060, 39.0963],
                                [-84.5060, 39.0960],
                            ]
                        ],
                        has_parts=False,
                        height=8.0,
                        roof_shape="gabled",
                        roof_height=3.0,
                    ),
                    polygon(
                        "pyramid-tower",
                        [
                            [
                                [-84.5050, 39.0970],
                                [-84.5046, 39.0970],
                                [-84.5046, 39.0974],
                                [-84.5050, 39.0974],
                                [-84.5050, 39.0970],
                            ]
                        ],
                        has_parts=False,
                        height=30.0,
                        roof_shape="pyramidal",
                        roof_height=10.0,
                    ),
                    # Two masses the minimum printed height must leave alone:
                    # a shed too small to stretch (0.30 x 0.39 mm) and a wall
                    # strip with plenty of area but only 0.23 mm across.
                    polygon(
                        "shed-small",
                        [
                            [
                                [-84.5040, 39.0930],
                                [-84.50395, 39.0930],
                                [-84.50395, 39.09305],
                                [-84.5040, 39.09305],
                                [-84.5040, 39.0930],
                            ]
                        ],
                        has_parts=False,
                        height=3.0,
                    ),
                    polygon(
                        "wall-strip",
                        [
                            [
                                [-84.5090, 39.0950],
                                [-84.5082, 39.0950],
                                [-84.5082, 39.09503],
                                [-84.5090, 39.09503],
                                [-84.5090, 39.0950],
                            ]
                        ],
                        has_parts=False,
                        height=4.0,
                    ),
                    # A boathouse mapped inside the river.  The cut takes the
                    # ground from under it; a pedestal must put it back.
                    polygon(
                        "boathouse",
                        [
                            [
                                [-84.5028, 39.0907],
                                [-84.5025, 39.0907],
                                [-84.5025, 39.0910],
                                [-84.5028, 39.0910],
                                [-84.5028, 39.0907],
                            ]
                        ],
                        has_parts=False,
                        height=4.0,
                    ),
                ],
            )
            write_collection(
                bundle.data_path("building_part"),
                [
                    polygon(
                        "part-a1",
                        [part_one],
                        building_id="parent-a",
                        height=10.0,
                        min_height=2.0,
                        roof_shape="gabled",
                    ),
                    polygon(
                        "part-a2",
                        [part_two],
                        building_id="parent-a",
                        num_floors=2,
                        min_floor=1,
                    ),
                    # An ambiguous crown: its roof is inside its stated total.
                    # The parent (22 m) does not corroborate 14 + 6 = 20 m.
                    polygon(
                        "part-dome",
                        [
                            [
                                [-84.5066, 39.0932],
                                [-84.5062, 39.0932],
                                [-84.5062, 39.0936],
                                [-84.5066, 39.0936],
                                [-84.5066, 39.0932],
                            ]
                        ],
                        building_id="parent-a",
                        min_height=10.0,
                        height=14.0,
                        roof_shape="dome",
                        roof_height=6.0,
                    ),
                    # A chimney-sized mass 40 m tall: unprintable as geometry
                    # and the source of the needle shards seen in the viewport.
                    polygon(
                        "part-needle",
                        [
                            [
                                [-84.5065, 39.0925],
                                [-84.50648, 39.0925],
                                [-84.50648, 39.09252],
                                [-84.5065, 39.09252],
                                [-84.5065, 39.0925],
                            ]
                        ],
                        building_id="parent-a",
                        height=40.0,
                    ),
                ],
            )

            # A road that is an ordinary surface for its first half and a
            # bridge for its second, exercising scoped rule splitting.
            write_collection(
                bundle.data_path("segment"),
                [
                    linestring(
                        "road-1",
                        [[-84.509, 39.0905], [-84.5045, 39.0905], [-84.5005, 39.0905]],
                        subtype="road",
                        **{"class": "primary"},
                        road_flags=[{"values": ["is_bridge"], "between": [0.5, 1.0]}],
                        width_rules=[{"value": 12.0, "between": None}],
                    ),
                    linestring(
                        "road-2",
                        [[-84.5075, 39.0915], [-84.5075, 39.0985]],
                        subtype="road",
                        **{"class": "residential"},
                    ),
                    linestring(
                        "tunnel-1",
                        [[-84.5065, 39.0915], [-84.5065, 39.0985]],
                        subtype="road",
                        **{"class": "residential"},
                        road_flags=[{"values": ["is_tunnel"], "between": None}],
                    ),
                    linestring(
                        "sidewalk-1",
                        [[-84.5076, 39.0920], [-84.5076, 39.0980]],
                        subtype="road",
                        **{"class": "footway"},
                        subclass="sidewalk",
                    ),
                    linestring(
                        "crossing-1",
                        [[-84.5077, 39.0950], [-84.5073, 39.0950]],
                        subtype="road",
                        **{"class": "footway"},
                        subclass_rules=[{"value": "crosswalk", "between": None}],
                    ),
                    linestring(
                        "path-1",
                        [[-84.5090, 39.0960], [-84.5070, 39.0960]],
                        subtype="road",
                        **{"class": "footway"},
                    ),
                    # A street that crosses the river with no bridge flag at
                    # all.  The crossing has to be recovered from the water.
                    linestring(
                        "road-3",
                        [[-84.5045, 39.0903], [-84.5005, 39.0903]],
                        subtype="road",
                        **{"class": "residential"},
                    ),
                    # A railway whose bridge is flagged in rail_flags, which a
                    # road-only reader would drape straight into the water.
                    linestring(
                        "rail-1",
                        [[-84.5050, 39.0901], [-84.5000, 39.0901]],
                        subtype="rail",
                        **{"class": "standard_gauge"},
                        rail_flags=[{"values": ["is_bridge"], "between": [0.28, 0.72]}],
                    ),
                ],
            )
            write_collection(bundle.data_path("connector"), [])

            write_collection(
                bundle.data_path("water"),
                [
                    polygon(
                        "water-1",
                        [
                            [
                                [-84.5035, 39.0895],
                                [-84.5015, 39.0895],
                                [-84.5015, 39.0915],
                                [-84.5035, 39.0915],
                                [-84.5035, 39.0895],
                            ]
                        ],
                        subtype="water",
                        **{"class": "river"},
                    ),
                    # A pool must be excluded as non-printable open water.
                    polygon(
                        "pool-1",
                        [
                            [
                                [-84.5010, 39.0990],
                                [-84.5008, 39.0990],
                                [-84.5008, 39.0992],
                                [-84.5010, 39.0992],
                                [-84.5010, 39.0990],
                            ]
                        ],
                        subtype="human_made",
                        **{"class": "swimming_pool"},
                    ),
                ],
            )

            forest_ring = [
                [-84.5095, 39.0955],
                [-84.5065, 39.0955],
                [-84.5065, 39.0985],
                [-84.5095, 39.0985],
                [-84.5095, 39.0955],
            ]
            write_collection(
                bundle.data_path("land"),
                [
                    polygon("forest-1", [forest_ring], subtype="forest", **{"class": "wood"}),
                    point("tree-1", [-84.5055, 39.0925], subtype="tree", **{"class": "tree"}),
                    point("tree-2", [-84.5050, 39.0930], subtype="tree", **{"class": "tree"}),
                    # A continental polygon that merely intersects the bbox must
                    # not be draped over the whole model.
                    polygon(
                        "regional-forest",
                        [
                            [
                                [-90.0, 35.0],
                                [-80.0, 35.0],
                                [-80.0, 42.0],
                                [-90.0, 42.0],
                                [-90.0, 35.0],
                            ]
                        ],
                        subtype="forest",
                        **{"class": "wood"},
                    ),
                ],
            )
            write_collection(
                bundle.data_path("land_use"),
                [
                    polygon(
                        "park-1",
                        [
                            [
                                [-84.5030, 39.0925],
                                [-84.5010, 39.0925],
                                [-84.5010, 39.0945],
                                [-84.5030, 39.0945],
                                [-84.5030, 39.0925],
                            ]
                        ],
                        subtype="park",
                        **{"class": "park"},
                    ),
                    # A riverside park whose polygon runs out over the water.
                    # It must be clipped to the land, not draped into the cut.
                    polygon(
                        "shore-park",
                        [
                            [
                                [-84.5045, 39.0908],
                                [-84.5030, 39.0908],
                                [-84.5030, 39.0925],
                                [-84.5045, 39.0925],
                                [-84.5045, 39.0908],
                            ]
                        ],
                        subtype="park",
                        **{"class": "park"},
                    ),
                ],
            )
            write_collection(bundle.data_path("land_cover"), [])
            write_synthetic_dem(bundle)
            bundle.write_manifest(
                {
                    "release": "synthetic-test",
                    "client_version": "test",
                    "feature_counts": {"building": 2, "building_part": 2},
                }
            )

            settings.target_width_mm = 100.0
            settings.target_height_mm = 80.0
            settings.default_building_height_m = 9.0
            settings.floor_height_m = 3.0
            settings.terrain_source = "DEM"
            settings.terrain_resolution = 64
            settings.generate_border_rim = True
            # The checks below read per-building metadata and per-tree
            # placement, so the first pass keeps every feature its own object;
            # the merged output is checked in a second pass at the end.
            settings.merge_buildings_and_trees = False
            # Roof semantics are asserted in real metres, so the first pass
            # runs unboosted and unraised; the height multiplier and the
            # minimum printed height each get their own pass.
            settings.building_height_scale = 1.0
            settings.minimum_building_height_mm = 0.0
            # Exercise detail rejection explicitly, independent of scene defaults.
            settings.minimum_building_width_mm = 0.08
            settings.maximum_building_slenderness = 30.0

            result = bpy.ops.jarvizar.generate_model()
            if result != {"FINISHED"}:
                raise AssertionError(f"Generation failed: {result}; {settings.last_status}")

            root = bpy.data.collections.get("CITY_MODEL")
            if root is None:
                raise AssertionError("CITY_MODEL collection was not created")
            expected_collections = {
                "TERRAIN",
                "LAND_SURFACES",
                "TERRAIN_SUPPORTS",
                "VEGETATION",
                "WATER",
                "ROADS",
                "SURFACE_ROADS",
                "BRIDGES",
                "BRIDGE_SUPPORTS",
                "BUILDINGS",
                "BUILDING_PARTS",
            }
            missing = expected_collections.difference(bpy.data.collections.keys())
            if missing:
                raise AssertionError(f"Missing collections: {sorted(missing)}")

            counts = json.loads(root["generation_counts_json"])
            print("SMOKE_COUNTS " + json.dumps(counts, sort_keys=True))
            generated = [
                obj
                for obj in bpy.data.objects
                if obj.type == "MESH" and obj.get("jarvizar_generated") is True
            ]
            for obj in generated:
                assert_manifold(obj)

            # --- terrain -------------------------------------------------
            if counts.get("terrain_mode") != "dem":
                raise AssertionError("DEM terrain was not used")
            if counts.get("terrain_relief_mm", 0.0) <= 0.0:
                raise AssertionError("DEM terrain produced no relief")
            if not counts.get("border_rim"):
                raise AssertionError("Border rim was not generated")

            # --- buildings -----------------------------------------------
            if [obj for obj in generated if obj.get("overture_id") == "parent-a"]:
                raise AssertionError("Parent with useful parts was not suppressed")
            if [obj for obj in generated if obj.get("overture_id") == "parent-a-twin"]:
                raise AssertionError("A plain box published over the parts was extruded")
            if counts.get("duplicate_outlines_suppressed", 0) != 1:
                raise AssertionError(
                    f"Expected one duplicate outline, got {counts.get('duplicate_outlines_suppressed')}"
                )
            fallback = next(
                obj for obj in generated if obj.get("overture_id") == "building-b"
            )
            if fallback.get("height_source") != "default":
                raise AssertionError("Missing height did not use deterministic default")
            gabled = next(obj for obj in generated if obj.get("overture_id") == "part-a1")
            if gabled.get("roof_geometry") != "gabled":
                raise AssertionError(
                    f"Gabled part was built as {gabled.get('roof_geometry')!r}, not gabled"
                )

            # --- roofs ----------------------------------------------------
            roofs = counts.get("roofs_built", {})
            for kind in ("gabled", "pyramid", "dome"):
                if roofs.get(kind, 0) < 1:
                    raise AssertionError(f"No {kind} roof was built: {roofs}")
            scale_z = counts.get("scale_mm_per_m", 0.0)

            def object_top_above_base(identifier):
                obj = next(o for o in generated if o.get("overture_id") == identifier)
                _low, high = object_z_range(obj)
                return obj, (high - float(obj["terrain_base_mm"])) / scale_z

            house, house_top = object_top_above_base("house-gabled")
            if house.get("roof_geometry") != "gabled" or abs(house_top - 8.0) > 0.05:
                raise AssertionError(
                    f"House roof: {house.get('roof_geometry')}, top {house_top:.2f} m; "
                    "a whole building keeps its roof inside its height"
                )
            tower, tower_top = object_top_above_base("pyramid-tower")
            if tower.get("roof_geometry") != "pyramid" or abs(tower_top - 30.0) > 0.05:
                raise AssertionError(
                    f"Pyramid tower: {tower.get('roof_geometry')}, top {tower_top:.2f} m"
                )
            dome, dome_top = object_top_above_base("part-dome")
            if dome.get("roof_geometry") != "dome" or abs(dome_top - 14.0) > 0.05:
                raise AssertionError(
                    f"Dome part: {dome.get('roof_geometry')}, top {dome_top:.2f} m; a "
                    "part's roof stays inside its stated total"
                )
            # Every part of parent-a stands on one shared base.
            bases = {
                float(o["terrain_base_mm"])
                for o in generated
                if o.get("building_id") == "parent-a"
            }
            if len(bases) != 1:
                raise AssertionError(f"Parts of one building have different bases: {bases}")
            if float(fallback["terrain_base_mm"]) <= 0.0:
                raise AssertionError("Building was not founded on the DEM surface")
            if [obj for obj in generated if obj.get("overture_id") == "part-needle"]:
                raise AssertionError("Unprintable needle mass was generated")
            if counts.get("rejected_too_narrow", 0) + counts.get(
                "rejected_too_slender", 0
            ) < 1:
                raise AssertionError("Needle mass was not reported as rejected")

            # --- print scale ---------------------------------------------
            if abs(counts.get("scale_mm_per_m", 0.0) - settings.mm_per_metre) > 1e-9:
                raise AssertionError(
                    f"Model was not built at the requested scale: {counts.get('scale_mm_per_m')}"
                )

            # --- roads and bridges ---------------------------------------
            if counts.get("skipped_tunnels", 0) < 1:
                raise AssertionError("Tunnel road was not excluded")
            if counts.get("skipped_sidepaths", 0) != 2:
                raise AssertionError(
                    f"Expected the sidewalk and the crossing to be skipped, got "
                    f"{counts.get('skipped_sidepaths')}"
                )
            if counts.get("classes", {}).get("footway", 0) < 1:
                raise AssertionError("The plain footpath was dropped with the sidewalks")
            if counts.get("surface_roads", 0) < 2:
                raise AssertionError("Surface roads were not generated")
            if counts.get("bridge_decks", 0) < 3:
                raise AssertionError(
                    "Expected the flagged bridge, the rail bridge, and the "
                    f"recovered crossing as decks; got {counts.get('bridge_decks')}"
                )
            evidence = counts.get("bridge_evidence", {})
            if evidence.get("road_flags.is_bridge", 0) < 1:
                raise AssertionError("Scoped is_bridge flag did not produce a deck")
            if evidence.get("rail_flags.is_bridge", 0) < 1:
                raise AssertionError("rail_flags is_bridge did not produce a deck")
            if counts.get("bridge_crossings_recovered", 0) < 1:
                raise AssertionError("Unflagged crossing of cut water was not recovered")
            bridges = bpy.data.collections["BRIDGES"].objects
            if not bridges:
                raise AssertionError("BRIDGES collection is empty")

            # Rebuild the very height field the generator aligned to, and check
            # the deck against the ground directly beneath each of its own
            # vertices.  This is the property the bridge design turns on: a
            # deck is anchored to its approaches and spans whatever it crosses,
            # instead of sagging into it the way per-vertex draping would.
            grid = ElevationGrid.load(bundle.path)
            sampler = DEMTerrain(grid, exaggeration=settings.terrain_exaggeration)
            transform = create_miniature_transform(
                *BOUNDS.as_tuple(),
                target_width_mm=settings.target_width_mm,
                target_height_mm=settings.target_height_mm,
                preserve_aspect=settings.preserve_aspect_ratio,
            )
            heightfield = ModelHeightField.build(
                transform,
                sampler,
                settings.terrain_resolution,
                smoothing=settings.terrain_smoothing,
            )
            # The generator carves terrain down under water before anything
            # reads it, and this bridge crosses the test water body.  Comparing
            # against an unflattened field would measure the carving, not the
            # deck.
            bodies, _ = solve_water_bodies(
                polygon_features(load_feature_collection(bundle.data_path("water"))),
                transform,
                heightfield,
                SurfaceSettings(
                    surface_rise_mm=settings.surface_rise_mm,
                    water_thickness_mm=settings.water_thickness_mm,
                ),
            )
            flatten_terrain_under_water(heightfield, bodies)
            # A deck is a rigid ribbon, so each of its corners is judged
            # against the lowest ground beneath the deck's own width rather
            # than the ground at that exact corner.  On a slope the two differ
            # by half a deck width of fall, which is the deck being flat, not
            # the deck sagging.
            half_width_mm = 12.0 * settings.mm_per_metre * 0.5
            clearances = []
            for obj in bridges:
                for vertex in obj.data.vertices:
                    world = obj.matrix_world @ vertex.co
                    ground = min(
                        heightfield.height_mm(
                            world.x + math.cos(angle) * half_width_mm,
                            world.y + math.sin(angle) * half_width_mm,
                        )
                        for angle in (
                            index * math.pi / 4.0 for index in range(8)
                        )
                    )
                    ground = min(ground, heightfield.height_mm(world.x, world.y))
                    clearances.append(world.z - ground)
            # A deck is anchored so its *top* meets the approach grade, which
            # puts its underside one deck thickness below ground at each end.
            # Anything deeper than that is a genuine sag.
            allowed = settings.bridge_deck_thickness_mm + 0.05
            if min(clearances) < -allowed:
                raise AssertionError(
                    f"Bridge deck sags {abs(min(clearances)):.3f} mm into the "
                    f"terrain, beyond the {allowed:.3f} mm explained by its thickness"
                )
            if max(clearances) < 1.0:
                raise AssertionError(
                    f"Bridge deck spans the valley only {max(clearances):.3f} mm "
                    "above the ground; it is draping rather than spanning"
                )

            # --- water ----------------------------------------------------
            if counts.get("water_bodies", 0) != 1:
                raise AssertionError(
                    f"Expected exactly one printable water body, got "
                    f"{counts.get('water_bodies')}"
                )
            water = bpy.data.collections["WATER"].objects[0]
            low, high = object_z_range(water)
            if high - low <= 0.0:
                raise AssertionError("Water body has no thickness")

            # --- the water is cut out of the terrain ----------------------
            if counts.get("water_cut_bodies", 0) != 1:
                raise AssertionError(
                    "The river was not cut out of the terrain, or the pool was "
                    f"cut too: {counts.get('water_cut_bodies')} bodies cut"
                )
            terrain = bpy.data.objects["TERRAIN_SURFACE"]
            if terrain["cells_removed_for_water"] < 1:
                raise AssertionError("The cut removed no terrain cells")
            if terrain["cells_clipped_at_shoreline"] < 1:
                raise AssertionError(
                    "No cell was clipped at the shoreline; the bank is following "
                    "the grid rather than the river"
                )

            # The base is measured against the land that survives, not against
            # the channel bed the cut took away.
            zs = [(terrain.matrix_world @ v.co).z for v in terrain.data.vertices]
            bottom = min(zs)
            lowest_land = min(z for z in zs if z > bottom + 1.0e-6)
            thickness = lowest_land - bottom
            if abs(thickness - settings.base_thickness_mm) > 1.0e-6:
                raise AssertionError(
                    f"Terrain base is {thickness:.4f} mm below the lowest land, "
                    f"not the requested {settings.base_thickness_mm:.4f} mm"
                )

            # --- ground kept under structures over the opening --------------
            # Every deck over the river gets a causeway, the boathouse a
            # pedestal, and piers may stand in the river only on that ground.
            body = bodies[0]
            ground = bpy.data.collections["TERRAIN_SUPPORTS"].objects
            if len(ground) != 1:
                raise AssertionError(
                    f"Expected one batched support object, found {len(ground)}"
                )
            if counts.get("bridge_causeways", 0) < 3:
                raise AssertionError(
                    f"Expected a causeway under each of the three decks over the "
                    f"river, got {counts.get('bridge_causeways')}"
                )
            if counts.get("buildings_grounded_over_water", 0) != 1:
                raise AssertionError(
                    "The boathouse in the river did not get a pedestal: "
                    f"{counts.get('buildings_grounded_over_water')}"
                )
            support_points = [
                (obj.matrix_world @ v.co) for obj in ground for v in obj.data.vertices
            ]
            in_river = [p for p in support_points if point_in_polygon((p.x, p.y), body.rings)]
            if not in_river:
                raise AssertionError("No support geometry was built inside the river")
            support_bottom = min(p.z for p in support_points)
            if abs(support_bottom - bottom) > 1.0e-4:
                raise AssertionError(
                    f"Supports start at {support_bottom:.4f} but the terrain's "
                    f"underside is at {bottom:.4f}; they must share one base"
                )
            # Away from the shore cells, where the surface still slopes from the
            # bank node down to the flattened bed, a support must stop at the
            # water level so the water stays open around it.
            interior = [
                p for p in in_river if _distance_to_ring((p.x, p.y), body.rings[0]) > 1.5
            ]
            if not interior:
                raise AssertionError("No support geometry reaches the middle of the river")
            from jarvizar_city_model.geometry.support import SUPPORT_WATER_CLEARANCE_MM
            water_top = object_z_range(water)[1]
            assert max(p.z for p in interior) >= water_top + SUPPORT_WATER_CLEARANCE_MM - 1e-4
            assert any(bottom + .05 < p.z < water_top for p in interior), \
                'Bridge causeways must still have submerged tops'
            supports = bpy.data.collections["BRIDGE_SUPPORTS"].objects
            piers_in_river = 0
            for obj in supports:
                for vertex in obj.data.vertices:
                    world = obj.matrix_world @ vertex.co
                    if world.z < bottom - 1.0e-6:
                        raise AssertionError("A pier reaches below the model's base")
                    if not point_in_polygon((world.x, world.y), body.rings):
                        continue
                    piers_in_river += 1
                    near = min(
                        math.hypot(world.x - p.x, world.y - p.y) for p in in_river
                    )
                    if near > 1.5:
                        raise AssertionError(
                            f"Bridge pier {obj.name} stands in the river {near:.2f} mm "
                            "from any ground kept under it"
                        )
            if piers_in_river == 0:
                raise AssertionError(
                    "No pier stands on the causeway; the decks over the river are "
                    "unsupported"
                )
            boathouse = next(obj for obj in generated if obj.get("overture_id") == "boathouse")
            house_low, _house_high = object_z_range(boathouse)
            if house_low < support_bottom:
                raise AssertionError("The boathouse hangs below the ground kept under it")

            # A park that ran out over the water was clipped to the land.
            if counts.get("land_surfaces_clipped_to_land", 0) < 1:
                raise AssertionError("The riverside park was not clipped to the land")
            for obj in bpy.data.collections["LAND_SURFACES"].objects:
                for vertex in obj.data.vertices:
                    world = obj.matrix_world @ vertex.co
                    if point_in_polygon((world.x, world.y), body.rings):
                        # A vertex exactly on the shoreline is the clip itself;
                        # one well inside the water is a floating sheet.
                        distance = _distance_to_ring((world.x, world.y), body.rings[0])
                        if distance > 0.3:
                            raise AssertionError(
                                f"{obj.name} has a vertex {distance:.2f} mm out over the "
                                "cut-out river"
                            )

            # --- every surface hugs the ground it is draped on -------------
            # Slabs and roads follow the terrain across their whole cap: one
            # embed below it, one rise or thickness above it, and nothing in
            # between.  A ground-founded building's underside does the same,
            # so on a slope it no longer hides a wedge as deep as the fall
            # across its footprint.  The generator's frame is rebuilt exactly
            # (fixed scale); the river's surroundings are left to the checks
            # above, because this field carries no cut and the generator's does.
            fixed = create_fixed_scale_transform(
                *BOUNDS.as_tuple(), mm_per_metre=settings.mm_per_metre
            )
            check_field = ModelHeightField.build(
                fixed, sampler, settings.terrain_resolution, smoothing=settings.terrain_smoothing
            )
            check_bodies, _ = solve_water_bodies(
                polygon_features(load_feature_collection(bundle.data_path("water"))),
                fixed,
                check_field,
            )
            flatten_terrain_under_water(check_field, check_bodies)
            check_body = check_bodies[0]
            embed = settings.surface_embed_mm

            def near_river(x, y):
                return (
                    point_in_polygon((x, y), check_body.rings)
                    or _distance_to_ring((x, y), check_body.rings[0]) < 3.0
                )

            for collection_name, above in (
                ("LAND_SURFACES", settings.surface_rise_mm),
                ("SURFACE_ROADS", settings.road_thickness_mm),
            ):
                for obj in bpy.data.collections[collection_name].objects:
                    for vertex in obj.data.vertices:
                        world = obj.matrix_world @ vertex.co
                        if near_river(world.x, world.y):
                            continue
                        offset = world.z - check_field.height_mm(world.x, world.y)
                        if abs(offset + embed) > 0.03 and abs(offset - above) > 0.03:
                            raise AssertionError(
                                f"{obj.name} has a vertex {offset:+.3f} mm from the "
                                f"terrain; expected -{embed:.2f} (underside) or "
                                f"+{above:.2f} (top)"
                            )
            draped_masses = 0
            for obj in generated:
                if obj.get("underside") != "draped_to_terrain":
                    continue
                points = [obj.matrix_world @ v.co for v in obj.data.vertices]
                if any(near_river(p.x, p.y) for p in points):
                    continue
                _low, high = object_z_range(obj)
                if any(high < check_field.height_mm(p.x, p.y) for p in points):
                    continue  # buried in the hill either way
                deepest = max(check_field.height_mm(p.x, p.y) - p.z for p in points)
                if deepest > embed + 0.06:
                    raise AssertionError(
                        f"{obj.name} reaches {deepest:.3f} mm below the terrain; its "
                        f"underside should be draped {embed:.2f} mm under it"
                    )
                draped_masses += 1
            if draped_masses < 1:
                raise AssertionError("No ground-founded mass was checked for draping")

            # --- land surfaces and trees ----------------------------------
            if counts.get("land_surfaces_regional_skipped", 0) < 1:
                raise AssertionError("Continental polygon was not rejected as regional")
            categories = counts.get("land_surface_categories", {})
            if "green" not in categories or "forest" not in categories:
                raise AssertionError(f"Expected park and forest surfaces, got {categories}")
            if counts.get("trees_mapped", 0) != 2:
                raise AssertionError(
                    f"Expected two mapped tree points, got {counts.get('trees_mapped')}"
                )
            if counts.get("trees_scattered", 0) < 1:
                raise AssertionError("Forest polygon produced no scattered trees")
            trees = bpy.data.collections["VEGETATION"].objects
            if len({obj.data.name for obj in trees}) != 1:
                raise AssertionError("Trees do not share one linked mesh datablock")
            if not counts['tree_avoid_roads'] or counts['trees_skipped_roads'] < 1:
                raise AssertionError("Default road avoidance did not skip conflicting trees")
            if any(obj.location.z <= 0.0 for obj in trees):
                raise AssertionError("A tree was not placed on the terrain surface")
            separate_building_objects = len(
                bpy.data.collections["BUILDINGS"].objects
            ) + len(bpy.data.collections["BUILDING_PARTS"].objects)
            separate_tree_objects = len(trees)
            separate_tree_polygons = sum(len(obj.data.polygons) for obj in trees)

            # --- merged output ---------------------------------------------
            # The default: one BUILDINGS object and one TREES object, each a
            # set of individually watertight shells, with the same counts.
            settings.merge_buildings_and_trees = True
            result = bpy.ops.jarvizar.generate_model()
            if result != {"FINISHED"}:
                raise AssertionError(f"Merged generation failed: {settings.last_status}")
            merged_counts = json.loads(
                bpy.data.collections["CITY_MODEL"]["generation_counts_json"]
            )
            for key in ("buildings", "building_parts", "trees", "roofs_built"):
                if merged_counts.get(key) != counts.get(key):
                    raise AssertionError(
                        f"Merged {key} differs: {merged_counts.get(key)} vs {counts.get(key)}"
                    )
            building_objects = list(bpy.data.collections["BUILDINGS"].objects)
            if [obj.name for obj in building_objects] != ["BUILDINGS"]:
                raise AssertionError(
                    f"Expected one BUILDINGS object, got {[o.name for o in building_objects]}"
                )
            if bpy.data.collections["BUILDING_PARTS"].objects:
                raise AssertionError("Merged parts should live in the BUILDINGS object")
            merged_buildings = building_objects[0]
            assert_manifold(merged_buildings)
            expected_solids = counts["buildings"] + counts["building_parts"]
            if separate_building_objects != expected_solids:
                raise AssertionError(
                    f"Separate pass made {separate_building_objects} building objects "
                    f"for {expected_solids} masses"
                )
            if merged_buildings.get("buildings") != counts["buildings"]:
                raise AssertionError("Merged BUILDINGS object does not record its count")
            if len(merged_buildings.data.materials) != 2:
                raise AssertionError("Merged buildings should carry both material slots")
            part_faces = sum(
                1 for polygon in merged_buildings.data.polygons if polygon.material_index == 1
            )
            if counts["building_parts"] > 0 and part_faces == 0:
                raise AssertionError("Building parts lost their material slot in the merge")
            tree_objects = list(bpy.data.collections["VEGETATION"].objects)
            if [obj.name for obj in tree_objects] != ["TREES"]:
                raise AssertionError(
                    f"Expected one TREES object, got {[o.name for o in tree_objects]}"
                )
            merged_trees = tree_objects[0]
            assert_manifold(merged_trees)
            if merged_trees["solid_count"] != separate_tree_objects:
                raise AssertionError(
                    f"Merged TREES holds {merged_trees['solid_count']} trees, "
                    f"expected {separate_tree_objects}"
                )
            if len(merged_trees.data.polygons) != separate_tree_polygons:
                raise AssertionError("Merged trees do not carry every tree's faces")
            if any(
                vertex.co.z <= 0.0 for vertex in merged_trees.data.vertices
            ):
                raise AssertionError("A merged tree reaches below the terrain base")

            # --- building height scale --------------------------------------
            # The multiplier lifts every mass above its own terrain base and
            # touches nothing else: footprints, roads and terrain are the
            # heights they were.
            road_extent = {
                obj.name: object_z_range(obj)
                for obj in bpy.data.collections["SURFACE_ROADS"].objects
            }
            settings.merge_buildings_and_trees = False
            settings.building_height_scale = 1.1
            result = bpy.ops.jarvizar.generate_model()
            if result != {"FINISHED"}:
                raise AssertionError(f"Boosted generation failed: {settings.last_status}")
            boosted_counts = json.loads(
                bpy.data.collections["CITY_MODEL"]["generation_counts_json"]
            )
            if abs(boosted_counts.get("building_height_scale", 0.0) - 1.1) > 1.0e-9:
                raise AssertionError(
                    f"Counts report scale {boosted_counts.get('building_height_scale')}"
                )
            for key in ("buildings", "building_parts", "roofs_built"):
                if boosted_counts.get(key) != counts.get(key):
                    raise AssertionError(
                        f"Boosted {key} differs: {boosted_counts.get(key)} vs "
                        f"{counts.get(key)}; the multiplier must not drop masses"
                    )
            boosted = [
                obj
                for collection in ("BUILDINGS", "BUILDING_PARTS")
                for obj in bpy.data.collections[collection].objects
            ]

            def boosted_top_above_base(identifier):
                obj = next(o for o in boosted if o.get("overture_id") == identifier)
                _low, high = object_z_range(obj)
                return obj, (high - float(obj["terrain_base_mm"])) / scale_z

            for identifier, unboosted in (
                ("house-gabled", 8.0),
                ("pyramid-tower", 30.0),
                ("part-dome", 14.0),
            ):
                obj, top = boosted_top_above_base(identifier)
                if abs(top - unboosted * 1.1) > 0.05:
                    raise AssertionError(
                        f"{identifier} tops out {top:.2f} m above its base, expected "
                        f"{unboosted * 1.1:.2f} m at a 1.1 scale"
                    )
                assert_manifold(obj)
            for obj in bpy.data.collections["SURFACE_ROADS"].objects:
                was = road_extent.get(obj.name)
                if was is None:
                    continue
                now = object_z_range(obj)
                if abs(now[0] - was[0]) > 1.0e-6 or abs(now[1] - was[1]) > 1.0e-6:
                    raise AssertionError(
                        f"{obj.name} moved from {was} to {now}; the building height "
                        "scale must not touch roads"
                    )

            # --- minimum printed height -------------------------------------
            # A qualifying mass is stretched until its top clears the highest
            # terrain under its footprint by exactly the minimum; a shed and a
            # wall strip are left at their own height.
            settings.building_height_scale = 1.0
            settings.minimum_building_height_mm = 0.8
            settings.minimum_height_footprint_mm = 0.6
            result = bpy.ops.jarvizar.generate_model()
            if result != {"FINISHED"}:
                raise AssertionError(f"Minimum-height generation failed: {settings.last_status}")
            raised_counts = json.loads(
                bpy.data.collections["CITY_MODEL"]["generation_counts_json"]
            )
            if raised_counts.get("buildings_raised_to_minimum", 0) < 1:
                raise AssertionError(f"Nothing was raised: {raised_counts}")
            for key in ("buildings", "building_parts"):
                if raised_counts.get(key) != counts.get(key):
                    raise AssertionError(
                        f"Raised {key} differs: {raised_counts.get(key)} vs "
                        f"{counts.get(key)}; the minimum must not drop masses"
                    )
            raised = [
                obj
                for collection in ("BUILDINGS", "BUILDING_PARTS")
                for obj in bpy.data.collections[collection].objects
            ]

            def raised_object(identifier):
                return next(o for o in raised if o.get("overture_id") == identifier)

            # 8 m at 0.07 mm/m is 0.56 mm, so the house is stretched; its top
            # must end 0.8 mm over the highest ground it covers, not its base.
            house = raised_object("house-gabled")
            _low, high = object_z_range(house)
            clearance = high - float(house["terrain_top_mm"])
            if abs(clearance - 0.8) > 0.01:
                raise AssertionError(
                    f"House tops out {clearance:.3f} mm over its terrain, expected 0.80"
                )
            if house.get("roof_geometry") != "gabled":
                raise AssertionError("Raising the house lost its gabled roof")
            if float(house.get("minimum_height_lift_mm", 0.0)) <= 0.0:
                raise AssertionError("The house does not record its lift")
            # The pyramid tower is 2.1 mm tall and must not move at all.
            tower = raised_object("pyramid-tower")
            if float(tower.get("minimum_height_lift_mm", 0.0)) != 0.0:
                raise AssertionError("A tall building was stretched by the minimum")
            for identifier in ("shed-small", "wall-strip"):
                small = raised_object(identifier)
                if float(small.get("minimum_height_lift_mm", 0.0)) != 0.0:
                    raise AssertionError(
                        f"{identifier} was stretched to the minimum; its footprint "
                        "is below the threshold"
                    )
                assert_manifold(small)
            assert_manifold(house)

            result = bpy.ops.jarvizar.clear_model()
            if result != {"FINISHED"} or bpy.data.collections.get("CITY_MODEL") is not None:
                raise AssertionError("Clear Generated Model failed")
            print("JARVIZAR_BLENDER_SMOKE_OK")
    finally:
        jarvizar_city_model.unregister()


if __name__ == "__main__":
    main()
