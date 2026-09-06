"""End-to-end generation against a real cached Overture + DEM bundle.

This is an integration check, not a unit test.  It needs a populated cache
directory and runs the actual operators inside Blender:

    blender --background --factory-startup --python tests/blender_live_full.py \
        -- --cache <cache-root>

It reports feature counts, mesh statistics, and a manifold check across every
generated solid, then exits non-zero on failure.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import bpy


def _repository_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _argument(name: str, default: str = "") -> str:
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    if name in argv:
        index = argv.index(name)
        if index + 1 < len(argv):
            return argv[index + 1]
    return default


def _non_manifold_edges(mesh) -> int:
    """Count edges not shared by exactly two faces."""
    usage = {}
    for polygon in mesh.polygons:
        keys = polygon.edge_keys
        for key in keys:
            usage[key] = usage.get(key, 0) + 1
    return sum(1 for count in usage.values() if count != 2)


def main() -> int:
    root = _repository_root()
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    cache_root = _argument("--cache")
    if not cache_root:
        print("LIVE_FULL_FAIL: --cache <directory> is required")
        return 2

    import jarvizar_city_model

    jarvizar_city_model.register()

    scene = bpy.context.scene
    settings = scene.jarvizar_city_model
    settings.cache_directory = cache_root
    settings.west, settings.south, settings.east, settings.north = _argument(
        "--bbox", "-84.53370,39.08554,-84.47422,39.11094"
    ).split(",")
    settings.terrain_source = "DEM"
    settings.terrain_resolution = 192
    settings.generate_border_rim = True
    settings.scale_mode = "FIXED"
    settings.mm_per_metre = 0.07

    started = time.perf_counter()
    result = bpy.ops.jarvizar.generate_model()
    elapsed = time.perf_counter() - started
    if "FINISHED" not in result:
        print(f"LIVE_FULL_FAIL: generation returned {result}: {settings.last_status}")
        return 1

    root_collection = bpy.data.collections.get("CITY_MODEL")
    if root_collection is None:
        print("LIVE_FULL_FAIL: CITY_MODEL collection missing")
        return 1

    counts = json.loads(root_collection["generation_counts_json"])
    print("--- generation counts ---")
    for key in sorted(counts):
        print(f"  {key}: {counts[key]}")

    def collection_objects(name):
        collection = bpy.data.collections.get(name)
        return list(collection.objects) if collection else []

    print("--- collections ---")
    total_objects = 0
    total_polygons = 0
    for name in (
        "TERRAIN",
        "LAND_SURFACES",
        "TERRAIN_SUPPORTS",
        "VEGETATION",
        "WATER",
        "SURFACE_ROADS",
        "BRIDGES",
        "BRIDGE_SUPPORTS",
        "BUILDINGS",
        "BUILDING_PARTS",
    ):
        objects = collection_objects(name)
        polygons = sum(
            len(obj.data.polygons) for obj in objects if obj.type == "MESH"
        )
        total_objects += len(objects)
        total_polygons += polygons
        print(f"  {name}: {len(objects)} objects, {polygons} polygons")

    print(f"--- totals: {total_objects} objects, {total_polygons} polygons ---")
    print(f"--- generation time: {elapsed:.1f} s ---")

    # Manifold check across every distinct generated mesh datablock.
    checked = 0
    open_meshes = []
    seen = set()
    for collection in bpy.data.collections:
        if collection.get("jarvizar_generated") is not True:
            continue
        for obj in collection.objects:
            if obj.type != "MESH" or obj.data.name in seen:
                continue
            seen.add(obj.data.name)
            checked += 1
            bad = _non_manifold_edges(obj.data)
            if bad:
                open_meshes.append((obj.name, bad, len(obj.data.polygons)))
    print(f"--- manifold: checked {checked} meshes, {len(open_meshes)} not closed ---")
    for name, bad, polygons in open_meshes[:15]:
        print(f"    {name}: {bad} bad edges of {polygons} polygons")

    failures = []
    if counts.get("buildings", 0) < 1000:
        failures.append("too few buildings")
    if counts.get("surface_roads", 0) < 1000:
        failures.append("too few surface roads")
    if counts.get("bridge_decks", 0) < 1:
        failures.append("no bridge decks")
    if counts.get("water_bodies", 0) < 1:
        failures.append("no water bodies")
    if counts.get("trees", 0) < 100:
        failures.append("too few trees")
    if counts.get("land_surfaces", 0) < 100:
        failures.append("too few land surfaces")
    if counts.get("terrain_mode") != "dem":
        failures.append("terrain is not DEM backed")
    if open_meshes:
        failures.append(f"{len(open_meshes)} non-manifold meshes")

    if failures:
        print("LIVE_FULL_FAIL: " + "; ".join(failures))
        return 1
    print("JARVIZAR_LIVE_FULL_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
