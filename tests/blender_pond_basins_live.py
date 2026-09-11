"""Audit real cached pond/fountain floors and fills without building the city.

blender --background --factory-startup --python-exit-code 1 \
  --python tests/blender_pond_basins_live.py -- --cache <cache-root>
"""

import json
import sys
from pathlib import Path

import bpy
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from jarvizar_city_model.data.cache import Bounds, CacheBundle
from jarvizar_city_model.data.dem import DEMTerrain, ElevationGrid
from jarvizar_city_model.data.geojson import load_feature_collection, first_osm_id
from jarvizar_city_model.data.land import recessed_water_kind
from jarvizar_city_model.data.projection import create_fixed_scale_transform
from jarvizar_city_model.geometry.heightfield import ModelHeightField
from jarvizar_city_model.geometry.dem_terrain import generate_terrain_solid
from jarvizar_city_model.geometry.surfaces import (
    solve_water_bodies, flatten_terrain_under_water, cut_water_from_terrain, generate_water,
)
from jarvizar_city_model.geometry.basins import recess_terrain_basins, _caps, _closed


cache = Path(sys.argv[sys.argv.index('--cache') + 1])
fixtures = (
    ('clearwater', (-82.83485,27.96044,-82.79572,27.98152)),
    ('sf', (-122.44417,37.76678,-122.37834,37.81745)),
    ('chicago', (-87.64875,41.84962,-87.59743,41.89455)),
)
if '--bbox' in sys.argv:
    fixtures = (('custom', tuple(float(v) for v in sys.argv[sys.argv.index('--bbox') + 1].split(','))),)
for name, bounds in fixtures:
    bundle = CacheBundle(cache, Bounds(*bounds))
    transform = create_fixed_scale_transform(*bounds, .07)
    field = ModelHeightField.build(transform, DEMTerrain(ElevationGrid.load(bundle.path)), 192, smoothing=1)
    features = load_feature_collection(bundle.data_path('water'))
    known = {first_osm_id(f.get('properties') or {}) for f in features}
    features.extend(f for f in load_feature_collection(bundle.data_path('infrastructure'))
                    if recessed_water_kind(f) and first_osm_id(f.get('properties') or {}) not in known)
    bodies, counts = solve_water_bodies(features, transform, field)
    flatten_terrain_under_water(field, bodies)
    cut_water_from_terrain(field, bodies)
    terrain = bpy.data.collections.new(name + '_terrain')
    water = bpy.data.collections.new(name + '_water')
    bpy.context.scene.collection.children.link(terrain)
    bpy.context.scene.collection.children.link(water)
    counts.update(generate_terrain_solid(field, 1.3, terrain))
    counts.update(recess_terrain_basins(field, bodies, terrain, 1.3))
    counts.update(generate_water(bodies, water, None, terrain_bottom_mm=counts['terrain_bottom_z_mm']))
    terrain_obj = terrain.objects[0]
    water_obj = next(obj for obj in water.objects if obj.get('water_recessed'))
    assert _closed(terrain_obj.data) and _closed(water_obj.data)
    def tree(obj):
        return BVHTree.FromPolygons([v.co[:] for v in obj.data.vertices], [p.vertices[:] for p in obj.data.polygons])
    land_tree, water_tree = tree(terrain_obj), tree(water_obj)
    probes = 0
    for body in bodies:
        if not body.basin_kind:
            continue
        assert abs(body.top_mm - body.bed_mm - .8) < 1e-6
        for cap in _caps(body):
            x = sum(p[0] for p in cap) / len(cap)
            y = sum(p[1] for p in cap) / len(cap)
            land_hit = land_tree.ray_cast((x, y, field.maximum_mm + 5), (0,0,-1))[0]
            water_hit = water_tree.ray_cast((x, y, field.maximum_mm + 5), (0,0,-1))[0]
            assert land_hit is not None and abs(land_hit.z - body.bed_mm) < .0002, (name, 'floor', x,y)
            assert water_hit is not None and abs(water_hit.z - body.top_mm) < .0002, (name, 'water', x,y, body.bed_mm, body.top_mm, None if water_hit is None else water_hit.z, cap)
            probes += 1
    assert counts['water_basins'] > 0
    print('POND_BASINS_LIVE_OK', name, 'basins', counts['water_basins'], 'probes', probes, flush=True)
    (ROOT/'scratchpad'/f'pond-{name}-geometry.json').write_text(json.dumps(counts, indent=2))

