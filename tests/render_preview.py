"""Render a presentation preview of a generated model.

This is a visual check, not a test.  It generates the model from a cache and
renders a three-quarter aerial view with neutral studio lighting, which is the
view an architectural miniature is normally judged in.

    blender --background --factory-startup --python tests/render_preview.py -- \
        --cache <cache-root> --output preview.png
        [--bbox west,south,east,north] [--exaggeration 1.0]
        [--target x,y --span mm] [--azimuth deg] [--elevation deg]
        [--water 0|1]

``--target`` aims the camera at a model-space point (millimetres) and
``--span`` sets how much of the model is in frame, for close-ups of one
bridge or one riverbank.  ``--water 0`` leaves the cut river open, which is
the reference look for the printed model.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def _argument(name: str, default: str = "") -> str:
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    if name in argv:
        index = argv.index(name)
        if index + 1 < len(argv):
            return argv[index + 1]
    return default


def _scene_bounds():
    minimum = Vector((1e18, 1e18, 1e18))
    maximum = Vector((-1e18, -1e18, -1e18))
    for obj in bpy.data.objects:
        if obj.type != "MESH" or obj.get("jarvizar_generated") is not True:
            continue
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            for axis in range(3):
                minimum[axis] = min(minimum[axis], world[axis])
                maximum[axis] = max(maximum[axis], world[axis])
    return minimum, maximum


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    cache_root = _argument("--cache")
    output = _argument("--output", str(root / "preview.png"))
    exaggeration = float(_argument("--exaggeration", "1.0"))
    resolution = int(_argument("--resolution", "1400"))
    if not cache_root:
        print("RENDER_FAIL: --cache <directory> is required")
        return 2

    import jarvizar_city_model

    jarvizar_city_model.register()

    settings = bpy.context.scene.jarvizar_city_model
    settings.cache_directory = cache_root
    bbox = _argument("--bbox")
    if bbox:
        west, south, east, north = bbox.split(",")
        settings.west, settings.south = west.strip(), south.strip()
        settings.east, settings.north = east.strip(), north.strip()
    settings.terrain_source = "DEM"
    settings.terrain_exaggeration = exaggeration
    settings.terrain_resolution = int(_argument("--terrain-resolution", "256"))
    settings.generate_border_rim = True
    settings.generate_water = _argument("--water", "1") not in ("0", "false", "no")

    result = bpy.ops.jarvizar.generate_model()
    if "FINISHED" not in result:
        print(f"RENDER_FAIL: {settings.last_status}")
        return 1

    scene = bpy.context.scene
    minimum, maximum = _scene_bounds()
    centre = (minimum + maximum) * 0.5
    span = max(maximum.x - minimum.x, maximum.y - minimum.y)
    target = _argument("--target")
    if target:
        x, y = (float(value) for value in target.split(","))
        # Aim a little above the base so the ground, not the underside of the
        # model, sits at the centre of the frame.
        centre = Vector((x, y, minimum.z + 1.5))
        span = float(_argument("--span", "40"))

    # Three-quarter aerial view: azimuth from the south-west, elevated enough
    # to read building heights without flattening the street grid.
    azimuth = math.radians(float(_argument("--azimuth", "-125")))
    elevation = math.radians(float(_argument("--elevation", "38")))
    distance = span * 1.55
    camera_data = bpy.data.cameras.new("PreviewCamera")
    camera_data.lens = 62.0
    camera = bpy.data.objects.new("PreviewCamera", camera_data)
    scene.collection.objects.link(camera)
    camera.location = (
        centre.x + math.cos(azimuth) * math.cos(elevation) * distance,
        centre.y + math.sin(azimuth) * math.cos(elevation) * distance,
        centre.z + math.sin(elevation) * distance,
    )
    direction = centre - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.camera = camera

    sun_data = bpy.data.lights.new("PreviewSun", type="SUN")
    sun_data.energy = 2.4
    sun_data.angle = math.radians(9.0)
    sun = bpy.data.objects.new("PreviewSun", sun_data)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(48.0), 0.0, math.radians(35.0))

    world = scene.world or bpy.data.worlds.new("PreviewWorld")
    scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    if background is not None:
        background.inputs[0].default_value = (0.86, 0.88, 0.92, 1.0)
        background.inputs[1].default_value = 0.75

    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.use_soft_shadows = True
    scene.eevee.use_gtao = True
    scene.eevee.gtao_distance = span * 0.02
    scene.eevee.taa_render_samples = 48
    scene.render.resolution_x = resolution
    scene.render.resolution_y = int(resolution * 0.66)
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = output
    scene.view_settings.look = "None"

    bpy.ops.render.render(write_still=True)
    print(f"RENDER_OK {output}")
    print(f"model bounds mm: {tuple(round(v, 2) for v in minimum)} .. "
          f"{tuple(round(v, 2) for v in maximum)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
