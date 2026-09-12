"""Restore wholly failed assemblies without changing successful parts or LiDAR."""
import copy
from pathlib import Path
import sys
from unittest.mock import patch

import bpy
sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parent)]
from blender_lidar import build
from jarvizar_city_model.blender.mesh_utils import MeshBuilder
from jarvizar_city_model.data.projection import create_fixed_scale_transform

t = create_fixed_scale_transform(-84.51, 39.09, -84.50, 39.10, .07)
def feature(identifier, size, **properties):
    ring = [t.local_to_geographic(x, y)[:2] for x, y in
            [(-size, -size), (size, -size), (size, size), (-size, size), (-size, -size)]]
    return {'id': identifier, 'properties': properties,
            'geometry': {'type': 'Polygon', 'coordinates': [ring]}}

parent = feature('parent', 30, height=20, has_parts=True)
tiny = feature('tiny', .3, height=10, building_id='parent')
good = feature('good', 10, height=10, building_id='parent')
def meshes(coll):
    return [([tuple(v.co) for v in o.data.vertices],
             [tuple(f.vertices) for f in o.data.polygons]) for o in coll.objects]

for merge in (False, True):
    reference, _ = build([parent], [], t, {}, 'ParentOnly', merge=merge)
    restored, counts = build([parent], [tiny], t, {}, 'FilteredParts', merge=merge)
    assert counts['building_parents_restored'] == 1 and counts['suppressed_parents'] == 0, counts
    assert counts['buildings'] == 1 and counts['building_parts'] == 0, counts
    assert counts['rejected_too_narrow'] == 1, counts
    assert meshes(reference) == meshes(restored)

    successful, _ = build([parent], [good], t, {}, 'SuccessfulParts', merge=merge)
    partial, counts = build([parent], [tiny, good], t, {}, 'PartlyFailed', merge=merge)
    assert counts['building_parents_restored'] == 0 and counts['buildings'] == 0, counts
    assert meshes(successful) == meshes(partial)

    original = MeshBuilder.add_prism
    attempts = []
    def reject_first(self, *args, **kwargs):
        attempts.append(self.name)
        return False if len(attempts) == 1 else original(self, *args, **kwargs)
    with patch.object(MeshBuilder, 'add_prism', reject_first):
        restored, counts = build([parent], [good], t, {}, 'MeshingFailure', merge=merge)
    assert counts['building_parents_restored'] == 1 and counts['buildings_rejected_geometry'] == 1, counts
    assert meshes(reference) == meshes(restored)

    record = {'height_m': 25, 'tiers': []}
    _, counts = build([parent], [tiny], t, {'parent': record}, 'Measured', merge=merge, prefer_lidar=True)
    assert counts['lidar_buildings'] == 1 and counts['building_parents_restored'] == 0, counts
    broken = copy.deepcopy(record)
    broken['tiers'] = [{'bottom_m': 25, 'top_m': 30, 'geometry': {'type': 'Point', 'coordinates': [0, 0]}}]
    restored, counts = build([parent], [tiny], t, {'parent': broken}, 'FailedMeasured', merge=merge, prefer_lidar=True)
    assert counts['lidar_geometry_fallbacks'] == 1 and counts['building_parents_restored'] == 1, counts
    assert meshes(reference) == meshes(restored)

# The fallback itself must still pass ordinary printability checks.
small_parent = feature('parent', .4, height=20, has_parts=True)
_, counts = build([small_parent], [tiny], t, {}, 'UnprintableParent')
assert counts['buildings'] == 0 and counts['building_parents_restored'] == 0, counts
print('BUILDING_PRESERVATION_OK')

# The fallback keeps holes in the source parent instead of filling courtyards.
from mathutils import Vector
from mathutils.bvhtree import BVHTree
hollow_parent = copy.deepcopy(parent)
hollow_parent['geometry']['coordinates'].append(list(reversed(feature('hole', 5)['geometry']['coordinates'][0])))
offset_tiny = copy.deepcopy(tiny)
offset_tiny['geometry']['coordinates'] = [[t.local_to_geographic(x, y)[:2]
    for x, y in ((15, 15), (15.6, 15), (15.6, 15.6), (15, 15.6), (15, 15))]]
restored, counts = build([hollow_parent], [offset_tiny], t, {}, 'OpenCourtyard')
assert counts['building_parents_restored'] == 1, counts
bpy.context.view_layer.update()
tree = BVHTree.FromObject(restored.objects[0], bpy.context.evaluated_depsgraph_get())
for x, y in ((0, 0), (-3, 2), (3, -2)):
    px, py = t.forward(*t.local_to_geographic(x, y)[:2])[:2]
    assert tree.ray_cast(Vector((px, py, 100)), Vector((0, 0, -1)))[0] is None
px, py = t.forward(*t.local_to_geographic(15, 0)[:2])[:2]
assert tree.ray_cast(Vector((px, py, 100)), Vector((0, 0, -1)))[0] is not None

# Do not restore a solid parent over courtyards described only by failed parts.
part_with_hole = copy.deepcopy(good)
part_with_hole['geometry']['coordinates'].append(list(reversed(feature('hole', 5)['geometry']['coordinates'][0])))
attempts = []
with patch.object(MeshBuilder, 'add_prism', reject_first):
    _, counts = build([parent], [part_with_hole], t, {}, 'AmbiguousCourtyard')
assert counts['buildings'] == 0 and counts['building_parents_restored'] == 0, counts
print('BUILDING_PRESERVATION_COURTYARDS_OK')
