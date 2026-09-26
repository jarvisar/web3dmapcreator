"""Exercise sibling filtering, merged shells and LiDAR source preference."""
from pathlib import Path
import sys

import bmesh
import bpy

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import jarvizar_city_model as addon
from jarvizar_city_model.data.projection import create_fixed_scale_transform
from jarvizar_city_model.geometry.building_generation import generate_buildings
from jarvizar_city_model.geometry.lidar_buildings import prefer_source_detail

addon.register()
s = bpy.context.scene.jarvizar_city_model
# The scene filter is off by default; generate_buildings keeps its own 30.
assert s.maximum_building_slenderness == 0
t = create_fixed_scale_transform(-84.51, 39.09, -84.50, 39.10, mm_per_metre=s.mm_per_metre)


class Ground:
    void_mask = None
    def height_mm(self, x, y): return 0
    def minimum_over(self, ring): return 0
    def maximum_over(self, ring): return 0


def feature(identifier, x0, y0, x1, y1, **props):
    ring = [t.model_to_geographic(x, y)[:2] for x, y in
            [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]]
    return {'id': identifier, 'type': 'Feature', 'properties': props,
            'geometry': {'type': 'Polygon', 'coordinates': [ring]}}


parent = feature('parent', 0, 0, 2, 2, has_parts=True)
parts = [feature(str(i), i / 20, 0, (i + 1) / 20, 2, building_id='parent',
                 height=80, roof_shape='skillion', roof_height=3, roof_direction=90)
         for i in range(40)]
needle = feature('needle', 4, 0, 4.01, .02, building_id='parent', height=100)
moderate = feature('moderate', 5, 0, 5.2, 2, height=55)


def generate(label, merge=False, **kwargs):
    coll = bpy.data.collections.new(label)
    bpy.context.scene.collection.children.link(coll)
    counts = generate_buildings([parent, moderate], parts + [needle], t, Ground(),
        s.floor_height_m, s.default_building_height_m, coll, coll,
        height_scale=s.building_height_scale, merge=merge, **kwargs)
    for obj in coll.objects:
        mesh = bmesh.new()
        mesh.from_mesh(obj.data)
        assert all(e.is_manifold and e.is_contiguous for e in mesh.edges), obj.name
        assert mesh.calc_volume(signed=True) > 0, obj.name
        mesh.free()
    return coll, counts


filtered, counts = generate('filtered')
assert counts['building_parts'] == 40, counts
assert counts['building_parts_kept_by_adjacency'] == 40, counts
assert counts['rejected_too_narrow'] == 1, counts
assert counts['roofs_built']['skillion'] == 40, counts
assert counts['buildings'] == 1, counts  # The 23:1 standalone mass survives the new limit.
assert {o['overture_id'] for o in filtered.objects} == {str(i) for i in range(40)} | {'moderate'}
unfiltered, _ = generate('unfiltered', minimum_width_mm=0, maximum_slenderness=0)


def geometry(obj):
    return ([tuple(v.co) for v in obj.data.vertices], [tuple(f.vertices) for f in obj.data.polygons])


reference = {o['overture_id']: geometry(o) for o in unfiltered.objects}
assert all(geometry(o) == reference[o['overture_id']] for o in filtered.objects)
merged, merged_counts = generate('merged', merge=True)
assert merged_counts['building_parts'] == 40, merged_counts
assert sum(len(o.data.vertices) for o in filtered.objects) == sum(len(o.data.vertices) for o in merged.objects)

assert prefer_source_detail(parts, parent, {'tiers': [], 'roof_surfaces': []}, t,
    lambda z: t.vertical_meters_to_model_mm(z) * s.building_height_scale,
    3, 10, .08, 30, .45, True, .15)

# Committed part corrections must also inform adjacency, not stale source heights.
corrected, corrected_counts = generate('corrected', lidar_profiles={'parent': {
    'method': 'source_parts', 'part_heights': {'0': 200}, 'infill_geometry': None}})
assert corrected_counts['building_parts'] == 39, corrected_counts
assert '0' not in {o['overture_id'] for o in corrected.objects}
print('BUILDING_PRINTABILITY_OK', counts)
