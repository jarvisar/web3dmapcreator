"""Chicago water regression using the actual cached full-model pipeline.

    blender --background --factory-startup --python-exit-code 1 \
        --python tests/blender_water_cut_live.py -- --cache <cache-root>

Runs the full mesh/manifold audit, then independently ray-tests open harbor
locations against terrain, supports and land surfaces. No network is needed.
"""

import sys
from pathlib import Path

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import blender_live_full
from jarvizar_city_model import operators
from jarvizar_city_model.geometry.planar import point_in_polygon


BBOX = "-87.64875,41.84962,-87.59743,41.89455"
PROBES = (
    ("Monroe Harbor north", -87.613, 41.880),
    ("Monroe Harbor middle", -87.612, 41.876),
    ("Chicago Harbor south", -87.610, 41.872),
    ("Chicago Harbor east", -87.604, 41.885),
)


def main():
    if "--" not in sys.argv:
        sys.argv.append("--")
    sys.argv.extend(("--bbox", BBOX))
    captured = {}
    original = operators.solve_water_bodies

    def capture(features, transform, heightfield, settings):
        bodies, counts = original(features, transform, heightfield, settings)
        captured.update(transform=transform, bodies=bodies, field=heightfield)
        return bodies, counts

    operators.solve_water_bodies = capture
    try:
        result = blender_live_full.main()
    finally:
        operators.solve_water_bodies = original
    assert result == 0, "Full Chicago mesh audit failed"

    field = captured["field"]
    trees = []
    for collection_name in ("TERRAIN", "TERRAIN_SUPPORTS", "LAND_SURFACES"):
        collection = bpy.data.collections.get(collection_name)
        for obj in collection.objects if collection else ():
            if obj.type == "MESH":
                trees.append((obj.name, obj.matrix_world.inverted(), BVHTree.FromPolygons(
                    [v.co for v in obj.data.vertices],
                    [p.vertices[:] for p in obj.data.polygons],
                )))
    assert trees, "No ground meshes to audit"
    for name, lon, lat in PROBES:
        x, y, _ = captured["transform"].geographic_to_model(lon, lat, 0)
        assert any(body.cut and point_in_polygon((x, y), body.rings)
                   for body in captured["bodies"]), f"{name}: source water is missing"
        assert field.over_open_water(x, y), f"{name}: water was restored as ground"
        for obj_name, inverse, tree in trees:
            hit = tree.ray_cast(inverse @ Vector((x, y, 1000)), Vector((0, 0, -1)))[0]
            assert hit is None, f"{name}: {obj_name} still fills open water"
        print(f"WATER_CUT_LIVE: {name} open in terrain, supports and surfaces")
    print("JARVIZAR_WATER_CUT_LIVE_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
