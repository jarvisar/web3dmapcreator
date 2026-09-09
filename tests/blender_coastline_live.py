"""Full cached coastline regressions, with optional overhead model renders.

blender --background --factory-startup --python-exit-code 1 \
    --python tests/blender_coastline_live.py -- --cache <cache-root> \
    --area clearwater|sf [--render <image.png>] [--report <report.json>]
"""

import json
import sys
from collections import Counter
from pathlib import Path

import bpy
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from jarvizar_city_model import operators, register
from jarvizar_city_model.geometry.planar import faces_are_consistent, point_in_polygon

CASES = {
    'clearwater': {
        'bounds': (-82.83485, 27.96044, -82.79572, 27.98152),
        'land': [(-82.8300604, 27.9628527), (-82.8174866, 27.97407885),
                 (-82.8108568, 27.97735235), (-82.8124415, 27.97761315),
                 (-82.8142784, 27.9783692), (-82.8146359, 27.96609195)],
        'water': [(-82.821, 27.973), (-82.824, 27.965)],
    },
    'sf': {
        'bounds': (-122.44417, 37.76678, -122.37834, 37.81745),
        'land': [(-122.407, 37.794), (-122.425, 37.800)],
        'water': [(-122.388, 37.803), (-122.390, 37.813), (-122.382, 37.790)],
    },
}


def argument(name, default=''):
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    return args[args.index(name) + 1] if name in args else default


def tree(obj):
    return BVHTree.FromPolygons([v.co[:] for v in obj.data.vertices],
                               [p.vertices[:] for p in obj.data.polygons])


def main():
    case = CASES[argument('--area')]
    captured = {}
    original = operators.solve_water_bodies

    def capture(features, transform, heightfield, settings):
        bodies, counts = original(features, transform, heightfield, settings)
        captured.update(bodies=bodies, transform=transform, field=heightfield)
        return bodies, counts

    register()
    settings = bpy.context.scene.jarvizar_city_model
    settings.cache_directory = argument('--cache')
    settings.west, settings.south, settings.east, settings.north = map(str, case['bounds'])
    settings.terrain_source = 'DEM'
    settings.terrain_resolution = 256
    settings.generate_water = True
    operators.solve_water_bodies = capture
    try:
        assert 'FINISHED' in bpy.ops.jarvizar.generate_model(), settings.last_status
    finally:
        operators.solve_water_bodies = original

    counts = json.loads(bpy.data.collections['CITY_MODEL']['generation_counts_json'])
    assert counts['water_bodies'] == counts['water_surfaces_built'], counts
    assert counts['water_invalid_polygons'] == counts['water_meshes_rejected'] == 0, counts
    terrain, water = tree(bpy.data.objects['TERRAIN_SURFACE']), tree(bpy.data.objects['WATER_SURFACE'])
    probes = []
    for kind in ('land', 'water'):
        for lon, lat in case[kind]:
            x, y, _ = captured['transform'].geographic_to_model(lon, lat, 0)
            def hit(mesh):
                return mesh.ray_cast((x, y, 1000), (0, 0, -1))[0] is not None
            wet = any(point_in_polygon((x, y), b.rings) for b in captured['bodies'])
            land_hit, water_hit = hit(terrain), hit(water)
            assert wet == (kind == 'water'), (kind, lon, lat, 'source')
            assert land_hit == (kind == 'land'), (kind, lon, lat, 'terrain')
            assert water_hit == (kind == 'water'), (kind, lon, lat, 'water mesh')
            probes.append(dict(kind=kind, lon=lon, lat=lat, terrain=land_hit, water=water_hit))

    checked, faces = 0, 0
    for obj in bpy.data.objects:
        if obj.type != 'MESH' or not obj.get('jarvizar_generated'):
            continue
        usage = Counter(e for p in obj.data.polygons for e in p.edge_keys)
        assert usage and all(n == 2 for n in usage.values()), ('Open mesh', obj.name)
        assert faces_are_consistent([p.vertices[:] for p in obj.data.polygons]), ('Winding', obj.name)
        checked += 1
        faces += len(obj.data.polygons)
    report = dict(area=argument('--area'), counts=counts, probes=probes, meshes=checked, faces=faces)
    if argument('--report'):
        Path(argument('--report')).write_text(json.dumps(report, indent=2), encoding='utf-8')
    print('COASTLINE_LIVE_OK', json.dumps({k: v for k, v in report.items() if k != 'counts'}), flush=True)

    if argument('--render'):
        scene = bpy.context.scene
        bounds = captured['transform'].model_bounds
        width, height = bounds.width_mm, bounds.height_mm
        camera_data = bpy.data.cameras.new('CoastlineCamera')
        camera_data.type = 'ORTHO'
        camera_data.ortho_scale = max(width, height) * 1.04
        camera = bpy.data.objects.new('CoastlineCamera', camera_data)
        scene.collection.objects.link(camera)
        camera.location = ((bounds.min_x_mm + bounds.max_x_mm) / 2,
                           (bounds.min_y_mm + bounds.max_y_mm) / 2, 1000)
        camera.rotation_euler = (0, 0, 0)
        scene.camera = camera
        scene.render.engine = 'BLENDER_WORKBENCH'
        scene.display.shading.light = 'STUDIO'
        scene.display.shading.color_type = 'MATERIAL'
        scene.display.shading.show_shadows = True
        scene.display.shading.show_cavity = True
        scene.display.shading.background_type = 'WORLD'
        scene.world.color = (0.04, 0.04, 0.04)
        scene.render.resolution_x = 1600
        scene.render.resolution_y = int(1600 * height / width)
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = 'PNG'
        scene.render.filepath = str(Path(argument('--render')).resolve())
        # The factory-startup cube is unrelated to generated geometry.
        for obj in scene.objects:
            if obj.type == 'MESH' and not obj.get('jarvizar_generated'):
                obj.hide_render = True
        bpy.ops.render.render(write_still=True)


if __name__ == '__main__':
    main()
