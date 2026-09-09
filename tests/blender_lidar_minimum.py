"""Minimum-height parity for prepared LiDAR, run with headless Blender."""
import copy
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

import bpy
import bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jarvizar_city_model.geometry.building_generation import generate_buildings


class Transform:
    """Keep fixture XY in printed millimetres and use the default Z scale."""
    scale_x_mm_per_m = .07
    model_bounds = SimpleNamespace(min_x_mm=-100, min_y_mm=-100,
                                   max_x_mm=100, max_y_mm=100)

    def geographic_to_model(self, x, y, z=0):
        return x*100000, y*100000, z

    forward = geographic_to_model

    def vertical_meters_to_model_mm(self, z):
        return z * .07


class Ground:
    void_mask = None

    def height_mm(self, x, y):
        return 5 + .02*x + .01*y

    def minimum_over(self, ring):
        return min(self.height_mm(x, y) for x, y in ring)

    def maximum_over(self, ring):
        return max(self.height_mm(x, y) for x, y in ring)


def rectangle(x0=-2, y0=-2, x1=2, y1=2):
    return {'type': 'Polygon', 'coordinates': [
        [[x/100000, y/100000] for x, y in
         ((x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0))]]}


def build(record, geometry=None, minimum=.8, gate=.6, slenderness=15, transform=None):
    geometry = geometry or rectangle()
    feature = {'id': 'minimum', 'properties': {'height': record['height_m']},
               'geometry': geometry}
    coll = bpy.data.collections.new('MINIMUM_TEST')
    bpy.context.scene.collection.children.link(coll)
    counts = generate_buildings([feature], [], transform or Transform(), Ground(),
        3, 10, coll, coll, height_scale=1.1, minimum_height_mm=minimum,
        minimum_height_footprint_mm=gate, maximum_slenderness=slenderness,
        lidar_profiles={'minimum': record} if record.get('measured', True) else {})
    assert len(coll.objects) == 1, counts
    obj = coll.objects[0]
    mesh = bmesh.new()
    mesh.from_mesh(obj.data)
    assert all(e.is_manifold and e.is_contiguous for e in mesh.edges), counts
    assert mesh.calc_volume(signed=True) > 0, counts
    mesh.free()
    bpy.context.view_layer.update()
    return obj, counts


def roof_z(obj, x, y):
    tree = BVHTree.FromObject(obj, bpy.context.evaluated_depsgraph_get())
    hit = tree.ray_cast(Vector((x, y, 100)), Vector((0, 0, -1)))[0]
    assert hit is not None, (x, y)
    return hit.z


class MinimumHeightTests(unittest.TestCase):
    def test_zero_disables_minimum_even_on_a_steep_slope(self):
        obj, counts = build({'height_m': 2, 'tiers': []}, minimum=0,
                            geometry=rectangle(-20, -20, 20, 20))
        self.assertEqual(counts['buildings_raised_to_minimum'], 0)
        self.assertEqual(obj['minimum_height_lift_mm'], 0)
        self.assertAlmostEqual(max(v.co.z for v in obj.data.vertices),
                               obj['terrain_base_mm'] + 2*.077, places=5)

    def test_flat_matches_source_on_slope(self):
        record = {'height_m': 2, 'tiers': []}
        measured, counts = build(record)
        source, _ = build({**record, 'measured': False})
        self.assertEqual(counts['lidar_buildings'], 1)
        self.assertEqual(counts['buildings_raised_to_minimum'], 1)
        self.assertAlmostEqual(roof_z(measured, 0, 0), roof_z(source, 0, 0), places=5)
        self.assertAlmostEqual(roof_z(measured, 0, 0)-measured['terrain_top_mm'], .8, places=5)

    def test_tower_does_not_hide_low_podium(self):
        record = {'height_m': 2, 'tiers': [
            {'bottom_m': 2, 'top_m': 30, 'geometry': rectangle(-1, -1, 1, 1)},
            {'bottom_m': 30, 'top_m': 40, 'geometry': rectangle(-.5, -.5, .5, .5)}]}
        original = copy.deepcopy(record)
        unraised, _ = build(record, minimum=0)
        raised, counts = build(record)
        self.assertEqual(counts['lidar_buildings'], 1)
        self.assertEqual(counts['lidar_tier_solids'], 2)
        lift = roof_z(raised, 1.5, 0)-roof_z(unraised, 1.5, 0)
        self.assertGreater(lift, .5)
        self.assertAlmostEqual(roof_z(raised, 1.5, 0)-raised['terrain_top_mm'], .8, places=5)
        for x in (0, .75):
            self.assertAlmostEqual(roof_z(raised, x, 0)-roof_z(unraised, x, 0), lift, delta=2e-5)
        self.assertEqual(record, original)

    def test_small_footprints_keep_the_source_gate(self):
        for geometry in (rectangle(-.2, -.2, .2, .2), rectangle(-2, -.1, 2, .1)):
            measured, counts = build({'height_m': 2, 'tiers': []}, geometry=geometry)
            source, _ = build({'height_m': 2, 'tiers': [], 'measured': False}, geometry=geometry)
            self.assertEqual(counts['lidar_buildings'], 1)
            self.assertEqual(counts['buildings_raised_to_minimum'], 0)
            self.assertAlmostEqual(roof_z(measured, 0, 0), roof_z(source, 0, 0), places=5)

    def test_minimum_lift_does_not_create_slenderness_rejection(self):
        geometry = rectangle(-.2, -.2, .2, .2)
        measured, counts = build({'height_m': 2, 'tiers': []}, geometry=geometry,
                                 gate=0, slenderness=1)
        self.assertEqual(counts['lidar_buildings'], 1, counts)
        self.assertEqual(counts['lidar_geometry_fallbacks'], 0, counts)
        self.assertAlmostEqual(roof_z(measured, 0, 0)-measured['terrain_top_mm'], .8, places=5)

    def test_cropped_plane_uses_its_printed_apex_and_keeps_pitch(self):
        transform = Transform()
        transform.model_bounds = SimpleNamespace(min_x_mm=-100, min_y_mm=-100,
                                                 max_x_mm=-1.5, max_y_mm=100)
        surface = rectangle()
        for point in surface['coordinates'][0]:
            point.append(2 + (point[0]*100000+2)*3.5)
        record = {'height_m': 2, 'tiers': [], 'roof_surfaces': [
            {'bottom_m': 2, 'geometry': surface}]}
        obj, counts = build(record, transform=transform)
        self.assertEqual(counts['lidar_roof_plane_solids'], 1, counts)
        self.assertEqual(counts['buildings_raised_to_minimum'], 1, counts)
        self.assertAlmostEqual(max(v.co.z for v in obj.data.vertices)-obj['terrain_top_mm'], .8, places=5)
        self.assertAlmostEqual(roof_z(obj, -1.6, 0)-roof_z(obj, -1.9, 0), .3*3.5*.077, places=5)


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(MinimumHeightTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful():
        raise AssertionError('LiDAR minimum-height regression failed')
    print('LIDAR_MINIMUM_HEIGHT_OK')
