"""Optional live-data Blender smoke test.

Usage:
  blender --background --factory-startup --python tests/blender_live_smoke.py -- PATH_TO_GEOJSON_DIR

The directory must contain ``building.geojson`` and ``building_part.geojson``.
Only buildings on a flat base are generated; see ``blender_live_full.py`` for
the full-feature integration check. No network access is performed.
"""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import sys
import tempfile
import time

import bmesh
import bpy


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import jarvizar_city_model
from jarvizar_city_model.data.cache import Bounds, CacheBundle


BOUNDS = Bounds(-84.53370, 39.08554, -84.47422, 39.11094)


def blender_arguments():
    return sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


def main():
    arguments = blender_arguments()
    if len(arguments) != 1:
        raise SystemExit("Pass one GeoJSON directory after --")
    source_dir = Path(arguments[0]).resolve()
    for name in ("building.geojson", "building_part.geojson"):
        if not (source_dir / name).is_file():
            raise SystemExit(f"Missing {source_dir / name}")

    jarvizar_city_model.register()
    try:
        with tempfile.TemporaryDirectory(prefix="jcm_live_", dir=str(PROJECT_ROOT)) as tmp:
            bundle = CacheBundle(Path(tmp), BOUNDS)
            bundle.ensure_directory()
            for feature_type in ("building", "building_part"):
                shutil.copy2(
                    source_dir / f"{feature_type}.geojson",
                    bundle.data_path(feature_type),
                )
            bundle.write_manifest(
                {"release": "live-smoke", "client_version": "1.0.2"}
            )

            settings = bpy.context.scene.jarvizar_city_model
            settings.west = f"{BOUNDS.west:.5f}"
            settings.south = f"{BOUNDS.south:.5f}"
            settings.east = f"{BOUNDS.east:.5f}"
            settings.north = f"{BOUNDS.north:.5f}"
            settings.cache_directory = str(Path(tmp))
            # This check supplies building GeoJSON only, so every other feature
            # is switched off; otherwise generation correctly refuses to run
            # against a cache that has no road, water, or land data in it.
            settings.generate_terrain = True
            settings.generate_buildings = True
            settings.terrain_source = "FLAT"
            settings.generate_roads = False
            settings.generate_bridges = False
            settings.generate_water = False
            # The cut reads the water layer whether or not the blue slab is
            # built, so it has to go too or generation refuses the cache.
            settings.cut_water_from_terrain = False
            settings.generate_land_surfaces = False
            settings.generate_trees = False
            settings.generate_border_rim = False
            # This check counts one mesh per building, so it wants them apart.
            settings.merge_buildings_and_trees = False

            started = time.perf_counter()
            result = bpy.ops.jarvizar.generate_model()
            elapsed = time.perf_counter() - started
            if result != {"FINISHED"}:
                raise AssertionError(f"Generation failed: {settings.last_status}")

            root = bpy.data.collections["CITY_MODEL"]
            counts = json.loads(root["generation_counts_json"])
            objects = [
                obj
                for obj in bpy.data.objects
                if obj.type == "MESH" and obj.get("jarvizar_generated") is True
            ]
            failures = []
            failure_details = []
            for obj in objects:
                mesh = bmesh.new()
                mesh.from_mesh(obj.data)
                bad_edges = [edge for edge in mesh.edges if not edge.is_manifold]
                if bad_edges:
                    failures.append(obj.name)
                    failure_details.append(
                        {
                            "name": obj.name,
                            "vertices": len(mesh.verts),
                            "faces": len(mesh.faces),
                            "bad_edges": [
                                [tuple(vertex.co) for vertex in edge.verts]
                                for edge in bad_edges[:10]
                            ],
                        }
                    )
                mesh.free()
            if failures:
                raise AssertionError(
                    f"Non-manifold generated objects ({len(failures)}): "
                    f"{json.dumps(failure_details[:5], default=list)}"
                )
            expected = counts["buildings"] + counts["building_parts"] + 1
            if len(objects) != expected:
                raise AssertionError(f"Expected {expected} generated meshes, got {len(objects)}")
            print(
                "JARVIZAR_LIVE_SMOKE_OK "
                + json.dumps(
                    {"elapsed_seconds": round(elapsed, 3), "mesh_objects": len(objects), **counts},
                    sort_keys=True,
                )
            )

            bpy.ops.jarvizar.clear_model()
            leftovers = [
                mesh for mesh in bpy.data.meshes if mesh.get("jarvizar_generated") is True
            ]
            if leftovers:
                raise AssertionError(f"Generated mesh datablocks survived clear: {len(leftovers)}")
    finally:
        jarvizar_city_model.unregister()


if __name__ == "__main__":
    main()
