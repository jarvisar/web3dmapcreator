"""Cutout frames and the STL export; run with Blender 3.6 --background --factory-startup.

Synthetic scenes only: every frame shape crops through the existing 3MF
pipeline, STL files per colour and combined match it, sections work with a
frame larger than the bed, and exports leave the scene as it was.
"""
from collections import defaultdict
from contextlib import contextmanager
import math
from pathlib import Path
import re
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
import zipfile

import bpy
from mathutils import Matrix, Vector
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
from blender_export_cutout import addon, mesh_object, rectangle, fingerprint, audit
from blender_smoke import linestring, polygon, write_collection, write_synthetic_dem
from jarvizar_city_model.blender import export_cutout
from jarvizar_city_model.blender.collections import GENERATED_KEY, create_city_hierarchy, generated_objects
from jarvizar_city_model.blender.export_cutout import Opening, material_color, part_arrays
from jarvizar_city_model.blender.materials import model_materials
from jarvizar_city_model.data import export_stl
from jarvizar_city_model.data.cache import ALL_TYPES, Bounds, CacheBundle
from jarvizar_city_model.data.export_3mf import MODEL, NS, SETTINGS
from jarvizar_city_model.data.export_frame import SHAPES, opening_ring


NAME = re.compile(r'^city(?:_(R\d+C\d+))?(?:_(\d+)_([a-z0-9-]+)_([0-9A-F]{6}))?\.stl$')


def read_stl(path):
    data = Path(path).read_bytes()
    count = struct.unpack_from('<I', data, 80)[0]
    assert len(data) == 84 + 50 * count, path
    assert not data[:5].lower().startswith(b'solid')
    return data[:80], np.frombuffer(data, dtype=export_stl._RECORD, count=count, offset=84)


def volume(records):
    corners = records['vertices'].astype(np.float64)
    a, b, c = corners[:, 0], corners[:, 1], corners[:, 2]
    return float(np.einsum('ij,ij->i', a, np.cross(b, c)).sum() / 6)


def closed(records):
    """Every directed edge, by coordinates, is matched by its reverse: closed, consistently wound shells."""
    edges = defaultdict(int)
    for triangle in records['vertices'].tolist():
        corners = [tuple(corner) for corner in triangle]
        for a, b in zip(corners, corners[1:] + corners[:1]):
            edges[a, b] += 1
    return all(edges.get((b, a), 0) == count for (a, b), count in edges.items())


def ring_area(ring):
    return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:] + ring[:1]))) / 2


def sorted_triangles(records):
    """Triangles as rows, each starting at its smallest vertex, in sorted order."""
    corners = records['vertices'].astype(np.float64)
    rows = []
    for triangle in corners.tolist():
        start = triangle.index(min(triangle))
        rows.append(sum(triangle[start:] + triangle[:start], []))
    rows = np.array(rows).reshape(-1, 9)
    return rows[np.lexsort(rows.T[::-1])]


class ExtrasTests(unittest.TestCase):
    def setUp(self):
        for obj in list(bpy.data.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        for col in list(bpy.data.collections):
            bpy.data.collections.remove(col)
        for mesh in list(bpy.data.meshes):
            bpy.data.meshes.remove(mesh)
        self.settings = bpy.context.scene.jarvizar_city_model
        self.settings.bambu_printer = 'P1S'
        self.settings.multi_plate_export = False
        self.settings.section_width_mm = 210
        self.settings.section_height_mm = 210
        self.temporary = tempfile.TemporaryDirectory(prefix='jcm_export_extras_')
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)

    # ------------------------------------------------------------ fixtures
    def city(self):
        """Terrain, a road, a park slab and merged buildings of two colours."""
        collections = create_city_hierarchy(bpy.context.scene)
        materials = model_materials()

        def source(name, rings, bottom, top, collection, material_roles, **tags):
            obj = mesh_object(name, rings, bottom, top, collections[collection])
            obj[GENERATED_KEY] = True
            for key, value in tags.items():
                obj[key] = value
            for role in material_roles:
                obj.data.materials.append(materials[role])
            return obj

        self.terrain = source('TERRAIN', [rectangle(600, 500)], -3, 0, 'terrain', ['terrain'],
                              feature_type='terrain')
        self.road = source('ROAD_residential', [rectangle(600, 6, 0, 20)], -0.15, 0.6, 'surface_roads',
                           ['road'], feature_type='surface_road', road_class='residential')
        self.park = source('SURFACE_green', [rectangle(90, 70, -60, -50)], -0.15, 0.4, 'land_surfaces',
                           ['surface_green'], feature_type='land_surface', surface_category='green')
        # Independent solids in one merged object, one material each; some
        # cross every frame's opening.
        buildings = source('BUILDINGS', [rectangle(12, 12, -30, 30)], -0.15, 20, 'buildings',
                           ['building', 'surface_rock'], feature_type='buildings')
        extra = mesh_object('extra', [rectangle(8, 8, 40, -10)], -0.15, 9)
        rock = mesh_object('rock', [rectangle(10, 40, 84, 0)], -0.15, 5)
        import bmesh
        bm = bmesh.new()
        bm.from_mesh(buildings.data)
        bm.from_mesh(extra.data)
        count = len(bm.faces)
        bm.from_mesh(rock.data)
        bm.faces.ensure_lookup_table()
        for face in bm.faces:
            face.material_index = int(face.index >= count)
        bm.to_mesh(buildings.data)
        bm.free()
        for obj in (extra, rock):
            mesh = obj.data
            bpy.data.objects.remove(obj, do_unlink=True)
            bpy.data.meshes.remove(mesh)
        self.buildings = buildings
        bpy.context.view_layer.update()
        return [self.terrain, self.road, self.park, self.buildings]

    def snapshot(self):
        bpy.context.view_layer.update()
        return ({o.name: fingerprint(o) for o in bpy.data.objects if o.type == 'MESH'},
                set(bpy.data.objects), set(bpy.data.meshes), set(bpy.data.materials),
                bpy.context.view_layer.objects.active,
                {o.name for o in bpy.context.selected_objects})

    def check_snapshot(self, before):
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(list(self.folder.glob('.jcm-*')))

    def add_frame(self, **kwargs):
        self.assertEqual(bpy.ops.jarvizar.add_cutout_frame(**kwargs), {'FINISHED'}, self.settings.last_status)
        frame = bpy.context.scene.objects['cutout']
        self.assertIn(frame.name, bpy.context.scene.collection.objects)
        self.assertEqual(len(frame.users_collection), 1)
        self.assertNotIn(GENERATED_KEY, frame.keys())
        self.assertNotIn(frame, generated_objects(bpy.context.scene))
        self.assertTrue(frame.hide_render)
        self.assertIs(bpy.context.view_layer.objects.active, frame)
        audit(frame.data)
        return frame

    @contextmanager
    def recording(self):
        """Triangles per colour of the parts an export writes, as part_arrays reports them.

        The crop's triangulation can differ between runs (its solids do not),
        so counts are taken from the export being checked.
        """
        original = export_cutout.export_geometry
        counts = defaultdict(int)

        @contextmanager
        def recorded(context, sources):
            with original(context, sources) as (parts, stats, opening):
                depsgraph = context.evaluated_depsgraph_get()
                for part in parts:
                    _, _, materials, colours = part_arrays(part, depsgraph)
                    for index in materials:
                        colour = colours[index]
                        counts[colour if isinstance(colour, str) else colour[0]] += 1
                yield parts, stats, opening

        with patch.object(export_cutout, 'export_geometry', recorded):
            yield counts

    def export_stl(self, name='city.stl', **kwargs):
        path = self.folder / name
        self.assertEqual(bpy.ops.jarvizar.export_stl(filepath=str(path), **kwargs), {'FINISHED'},
                         self.settings.last_status)
        self.assertIn('OpenStreetMap contributors', self.settings.last_status)
        files = {}
        for item in sorted(self.folder.glob('*.stl')):
            match = NAME.match(item.name)
            if match:
                header, records = read_stl(item)
                self.assertTrue(header.startswith(b'Jarvizar City Model'))
                files[item.name] = (match, records)
        return files

    def assert_inside(self, records, opening, centre, tolerance=1e-3):
        points = records['vertices'].reshape(-1, 3).astype(np.float64)
        points[:, 0] += centre[0]
        points[:, 1] += centre[1]
        inverse = np.array(opening.inverse)
        local = points @ inverse[:3, :3].T + inverse[:3, 3]
        for co, no in opening.planes:
            distances = (local[:, 0] - co.x) * no.x + (local[:, 1] - co.y) * no.y
            self.assertLessEqual(distances.max(), tolerance)

    # --------------------------------------------------------------- tests
    def test_frame_shapes_crop_stl_and_3mf(self):
        sources = self.city()
        colours = {material_color(slot.material) for obj in sources for slot in obj.material_slots}
        for shape in SHAPES:
            with self.subTest(shape=shape):
                frame = self.add_frame(shape=shape, size='CUSTOM', width_mm=170, height_mm=120,
                                       corner_radius_mm=15)
                self.assertAlmostEqual(frame.matrix_world.translation.xy.length, 0, places=4)
                self.assertAlmostEqual(frame.matrix_world.translation.z, 22)
                opening = Opening.from_object(frame, bpy.context.evaluated_depsgraph_get())
                self.assertTrue(opening.convex)
                ring = opening_ring(shape, 170, 120, 15)
                self.assertAlmostEqual(ring_area(opening.ring), ring_area(ring), delta=ring_area(ring) * 1e-6)
                before = self.snapshot()
                with self.recording() as expected:
                    files = self.export_stl()
                self.check_snapshot(before)
                self.assertEqual(len(files), len(expected))
                self.assertIn('named city*.stl', self.settings.last_status)
                by_colour = {}
                for name, (match, records) in files.items():
                    self.assertIsNone(match.group(1))
                    colour = '#' + match.group(4)
                    self.assertIn(colour, colours)
                    by_colour[colour] = records
                    self.assertEqual(len(records), expected[colour], name)
                    self.assert_inside(records, opening, frame.matrix_world.translation)
                    self.assertTrue(closed(records), name)
                self.assertEqual(min(float(r['vertices'][..., 2].min()) for r in by_colour.values()), 0.0)
                # Terrain alone is white: the crop keeps the opening's area, 3 mm deep.
                self.assertAlmostEqual(volume(by_colour['#FFFFFF']), ring_area(ring) * 3,
                                       delta=ring_area(ring) * 3 * 1e-5)
                for records in by_colour.values():
                    self.assertGreater(volume(records), 0)
                names = sorted(files)
                self.assertEqual([int(files[n][0].group(2)) for n in names], list(range(1, len(names) + 1)))
                labels = {files[n][0].group(3) for n in names}
                self.assertLessEqual(labels, {'terrain', 'roads', 'greenery', 'buildings', 'rock'})
                self.assertLessEqual({'terrain', 'roads', 'buildings'}, labels)
                with self.recording() as expected:
                    combined = self.export_stl(stl_files='COMBINED')
                self.assertEqual(list(combined), ['city.stl'])
                self.assertIn('removed', self.settings.last_status)
                records = combined['city.stl'][1]
                self.assertEqual(len(records), sum(expected.values()))
                # The same solids in the same frame as the colour files.
                together = np.concatenate([r for r in by_colour.values()])
                self.assertAlmostEqual(volume(records), volume(together), delta=volume(together) * 1e-6)
                for axis in range(3):
                    for bound in (np.min, np.max):
                        self.assertAlmostEqual(float(bound(records['vertices'][..., axis])),
                                               float(bound(together['vertices'][..., axis])), places=4)
                self.check_snapshot(before)
                path = self.folder / f'{shape}.3mf'
                self.assertEqual(bpy.ops.jarvizar.export_3mf(filepath=str(path)), {'FINISHED'})
                with zipfile.ZipFile(path) as archive:
                    root = ET.fromstring(archive.read(MODEL))
                points = [(float(v.get('x')), float(v.get('y'))) for v in root.findall('.//m:vertex', NS)]
                xs, ys = [p[0] for p in ring], [p[1] for p in ring]
                self.assertAlmostEqual(max(p[0] for p in points) - min(p[0] for p in points), max(xs) - min(xs), places=3)
                self.assertAlmostEqual(max(p[1] for p in points) - min(p[1] for p in points), max(ys) - min(ys), places=3)
                self.check_snapshot(before)
                for item in self.folder.glob('*.stl'):
                    item.unlink()

    def test_sections_with_a_frame_larger_than_the_bed(self):
        sources = self.city()
        self.settings.multi_plate_export = True
        for shape, cells in (('RECTANGLE', 4), ('CIRCLE', 4)):
            with self.subTest(shape=shape):
                frame = self.add_frame(shape=shape, size='CUSTOM', width_mm=400, height_mm=300)
                ring = opening_ring(shape, 400, 300)
                before = self.snapshot()
                files = self.export_stl()
                self.check_snapshot(before)
                sections = defaultdict(list)
                for name, (match, records) in files.items():
                    sections[match.group(1)].append(records)
                    self.assertTrue(closed(records), name)
                self.assertEqual(len(sections), cells)
                self.assertTrue(all(key and re.fullmatch(r'R[12]C[12]', key) for key in sections))
                white = 0
                for key, parts in sections.items():
                    points = np.concatenate([records['vertices'].reshape(-1, 3) for records in parts])
                    # Each section centred on its 200 x 150 cell; one Z datum for all.
                    self.assertLessEqual(np.abs(points[:, 0]).max(), 100 + 1e-3)
                    self.assertLessEqual(np.abs(points[:, 1]).max(), 75 + 1e-3)
                    self.assertEqual(float(points[:, 2].min()), 0.0)
                for name, (match, records) in files.items():
                    if match.group(4) == 'FFFFFF':
                        white += volume(records)
                self.assertAlmostEqual(white, ring_area(ring) * 3, delta=ring_area(ring) * 3 * 1e-5)
                self.assertIn('for each of 4 sections', self.settings.last_status)
                path = self.folder / f'{shape}-sections.3mf'
                self.assertEqual(bpy.ops.jarvizar.export_3mf(filepath=str(path)), {'FINISHED'})
                with zipfile.ZipFile(path) as archive:
                    self.assertEqual(len(ET.fromstring(archive.read(SETTINGS)).findall('plate')), cells)
                self.check_snapshot(before)
                bpy.data.objects.remove(frame, do_unlink=True)
                for item in self.folder.glob('*'):
                    item.unlink()
        # Without a frame, sections have no boundary: both exports refuse.
        before = self.snapshot()
        with self.assertRaisesRegex(RuntimeError, 'needs a cutout frame'):
            bpy.ops.jarvizar.export_stl(filepath=str(self.folder / 'city.stl'))
        self.check_snapshot(before)
        self.assertFalse(list(self.folder.iterdir()))

    def test_replacing_keeps_placement_and_sizes(self):
        self.city()
        frame = self.add_frame(shape='RECTANGLE', size='BED', margin_mm=20)
        opening = Opening.from_object(frame, bpy.context.evaluated_depsgraph_get())
        xs, ys = [p[0] for p in opening.ring], [p[1] for p in opening.ring]
        self.assertAlmostEqual(max(xs) - min(xs), 216, places=4)
        self.assertAlmostEqual(max(ys) - min(ys), 216, places=4)
        self.assertIn('216.0 x 216.0 mm', self.settings.last_status)
        frame.matrix_world = Matrix.Translation((30, -12, 40)) @ Matrix.Rotation(0.3, 4, 'Z')
        old_mesh = frame.data.as_pointer()
        old_rotation = frame.matrix_world.to_quaternion()
        frame = self.add_frame(shape='HEXAGON', size='MODEL')
        self.assertEqual(frame.data.name, 'cutout')
        self.assertNotIn(old_mesh, {mesh.as_pointer() for mesh in bpy.data.meshes})
        self.assertEqual([o.name for o in bpy.data.objects if o.name.startswith('cutout')], ['cutout'])
        self.assertAlmostEqual(frame.matrix_world.to_quaternion().rotation_difference(old_rotation).angle, 0, places=5)
        self.assertAlmostEqual((frame.matrix_world.translation.xy - Vector((30, -12))).length, 0, places=4)
        self.assertIn('Replaced cutout frame: Hexagon', self.settings.last_status)
        # Fit Model: the largest hexagon inside the 600 x 500 model.
        opening = Opening.from_object(frame, bpy.context.evaluated_depsgraph_get())
        xs = [p[0] for p in opening.ring]
        self.assertAlmostEqual(max(xs) - min(xs), 2 * min(300, 500 / math.sqrt(3)), places=3)
        self.assertEqual(len(frame.data.materials), 1)
        self.assertEqual(frame.data.materials[0].name, 'Cutout Frame')
        # Undo-free failures change nothing.
        before = self.snapshot()
        with self.assertRaisesRegex(RuntimeError, 'no room'):
            bpy.ops.jarvizar.add_cutout_frame(size='BED', margin_mm=200)
        self.assertEqual(self.snapshot(), before)

    def test_without_model_and_name_conflicts(self):
        bpy.context.scene.cursor.location = (30, -20, 5)
        frame = self.add_frame(shape='CIRCLE', size='BED', margin_mm=28)
        self.assertEqual(tuple(frame.matrix_world.translation), (30, -20, 5))
        opening = Opening.from_object(frame, bpy.context.evaluated_depsgraph_get())
        self.assertAlmostEqual(max(p[0] for p in opening.ring) - min(p[0] for p in opening.ring), 200, places=4)
        bpy.data.objects.remove(frame, do_unlink=True)
        with self.assertRaisesRegex(RuntimeError, 'No generated model'):
            bpy.ops.jarvizar.add_cutout_frame(size='MODEL')
        with self.assertRaisesRegex(RuntimeError, 'generate a model first'):
            bpy.ops.jarvizar.export_stl(filepath=str(self.folder / 'city.stl'))
        other = bpy.data.scenes.new('Other')
        self.addCleanup(bpy.data.scenes.remove, other)
        clash = bpy.data.objects.new('cutout', bpy.data.meshes.new('clash'))
        other.collection.objects.link(clash)
        with self.assertRaisesRegex(RuntimeError, 'Another scene'):
            bpy.ops.jarvizar.add_cutout_frame(size='CUSTOM')
        # A cutout that is not a mesh is replaced by one at its place.
        bpy.data.objects.remove(clash, do_unlink=True)
        empty = bpy.data.objects.new('cutout', None)
        bpy.context.scene.collection.objects.link(empty)
        empty.location = (7, 8, 9)
        frame = self.add_frame(shape='RECTANGLE', size='CUSTOM', width_mm=50, height_mm=40)
        self.assertEqual(frame.type, 'MESH')
        self.assertEqual(tuple(frame.matrix_world.translation), (7, 8, 9))

    def test_failures_keep_earlier_files_and_scene(self):
        self.city()
        self.add_frame(shape='ROUNDED', size='CUSTOM', width_mm=150, height_mm=100)
        files = self.export_stl()
        saved = {name: (self.folder / name).read_bytes() for name in files}
        before = self.snapshot()
        for target in ('jarvizar_city_model.data.export_stl.StlSet.close',
                       'jarvizar_city_model.data.export_stl.publish',
                       'jarvizar_city_model.blender.export_cutout.clip_mesh'):
            with self.subTest(target=target):
                with patch(target, side_effect=ValueError('injected STL failure')):
                    with self.assertRaisesRegex(RuntimeError, 'injected STL failure'):
                        bpy.ops.jarvizar.export_stl(filepath=str(self.folder / 'city.stl'),
                                                    stl_files='COMBINED')
                self.assertIn('STL export failed', self.settings.last_status)
                self.assertEqual({p.name: p.read_bytes() for p in self.folder.iterdir()}, saved)
                self.check_snapshot(before)
        with self.assertRaisesRegex(RuntimeError, 'Folder not found'):
            bpy.ops.jarvizar.export_stl(filepath=str(self.folder / 'missing' / 'city.stl'))
        self.check_snapshot(before)


class RoadCutTests(unittest.TestCase):
    """A generated map: STL slabs are cut by the roads at export, like the 3MF."""

    def setUp(self):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='jcm_export_extras_road_')
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        settings = self.settings = bpy.context.scene.jarvizar_city_model
        box = Bounds(-84.51, 39.09, -84.50, 39.10)
        settings.west, settings.south, settings.east, settings.north = map(str, box.as_tuple())
        settings.cache_directory = str(self.folder / 'cache')
        settings.terrain_source = 'DEM'
        settings.terrain_resolution = 16
        settings.generate_trees = False
        settings.generate_buildings = False
        bundle = CacheBundle(Path(settings.cache_directory), box)
        bundle.ensure_directory()
        for kind in ALL_TYPES:
            write_collection(bundle.data_path(kind), [])
        ring = [[-84.509, 39.091], [-84.501, 39.091], [-84.501, 39.099], [-84.509, 39.099], [-84.509, 39.091]]
        write_collection(bundle.data_path('land_use'), [polygon('park', [ring], subtype='park')])
        write_collection(bundle.data_path('segment'), [
            linestring('street', [[-84.51, 39.095], [-84.50, 39.095]], subtype='road', **{'class': 'residential'}),
            linestring('path', [[-84.505, 39.09], [-84.505, 39.10]], subtype='road', **{'class': 'footway'})])
        write_synthetic_dem(bundle, columns=16, rows=16)
        bundle.write_manifest({'release': 'export-extras-fixture'})

    def generate_and_export(self, at_export, name):
        self.settings.cut_roads_at_export = at_export
        self.assertEqual(bpy.ops.jarvizar.generate_model(), {'FINISHED'}, self.settings.last_status)
        output = self.folder / name
        output.mkdir()
        path = output / 'city.stl'
        self.assertEqual(bpy.ops.jarvizar.export_stl(filepath=str(path)), {'FINISHED'}, self.settings.last_status)
        return {item.name: read_stl(item)[1] for item in output.glob('*.stl')}

    def test_deferred_road_cut_and_model_sized_frames(self):
        at_generation = self.generate_and_export(False, 'generation')
        at_export = self.generate_and_export(True, 'export')
        self.assertEqual(sorted(at_generation), sorted(at_export))
        green = [name for name in at_export if 'greenery' in name]
        self.assertEqual(len(green), 1)
        # The slab file is the same set of triangles either way: roads cut it.
        for name in at_export:
            np.testing.assert_allclose(sorted_triangles(at_export[name]), sorted_triangles(at_generation[name]),
                                       atol=1e-4, err_msg=name)
            self.assertTrue(closed(at_export[name]), name)
        # Frames sized from this generated model and bed, placed above it.
        objects = generated_objects(bpy.context.scene)
        corners = [o.matrix_world @ Vector(c) for o in objects for c in o.bound_box]
        top = max(c.z for c in corners)
        width = max(c.x for c in corners) - min(c.x for c in corners)
        self.assertEqual(bpy.ops.jarvizar.add_cutout_frame(shape='RECTANGLE', size='MODEL'), {'FINISHED'})
        frame = bpy.context.scene.objects['cutout']
        self.assertAlmostEqual(frame.matrix_world.translation.z, top + 2, places=4)
        opening = Opening.from_object(frame, bpy.context.evaluated_depsgraph_get())
        self.assertAlmostEqual(max(p[0] for p in opening.ring) - min(p[0] for p in opening.ring), width, places=3)
        cropped = self.folder / 'cropped'
        cropped.mkdir()
        self.assertEqual(bpy.ops.jarvizar.export_stl(filepath=str(cropped / 'city.stl')), {'FINISHED'},
                         self.settings.last_status)
        self.assertEqual(sorted(item.name for item in cropped.glob('*.stl')), sorted(at_export))


if __name__ == '__main__':
    addon.register()
    suite = unittest.TestSuite()
    for case in (ExtrasTests, RoadCutTests):
        suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(case))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful():
        raise SystemExit(1)
    print('JARVIZAR_EXPORT_EXTRAS_OK', result.testsRun)
