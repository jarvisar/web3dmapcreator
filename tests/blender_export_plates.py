"""Offline multi-plate geometry, archive, and scene rollback regression.

Run in background Blender with --factory-startup --python-exit-code 1.
Produces fixtures for tests/bambu_export_plates.py in scratchpad/multi-plate.
"""
import json
import math
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
import zipfile

import bpy
from mathutils import Matrix

sys.path.insert(0, str(Path(__file__).resolve().parent))
from blender_export_cutout import addon, mesh_object, rectangle, fingerprint, audit, oriented
from jarvizar_city_model.blender.collections import create_city_hierarchy, GENERATED_KEY
from jarvizar_city_model.blender.export_cutout import export_geometry, export_grid, export_sections
from jarvizar_city_model.data.export_3mf import MODEL, NS, SETTINGS
from jarvizar_city_model.data.export_plates import PRINTERS, PROJECT
from jarvizar_city_model.data.export_sections import plate_origin


FOLDER = Path(__file__).resolve().parents[1] / 'scratchpad' / 'multi-plate'


def transform(point, text):
    m = [float(v) for v in text.split()]
    return tuple(sum(m[i + j * 3] * point[j] for j in range(3)) + m[9 + i] for i in range(3))


class PlateTests(unittest.TestCase):
    def setUp(self):
        for obj in list(bpy.data.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        for col in list(bpy.data.collections):
            bpy.data.collections.remove(col)
        self.collections = create_city_hierarchy(bpy.context.scene)
        self.settings = bpy.context.scene.jarvizar_city_model
        self.settings.bambu_printer = 'P1S'
        self.settings.multi_plate_export = True
        self.settings.section_width_mm = 210
        self.settings.section_height_mm = 210
        FOLDER.mkdir(parents=True, exist_ok=True)

    def source(self, name, ring, bottom=-1, top=2):
        obj = mesh_object(name, [ring], bottom, top, self.collections['buildings'])
        obj[GENERATED_KEY] = True
        obj['feature_type'] = name
        return obj

    def frame(self, ring):
        obj = mesh_object('cutout', [rectangle(1200, 1200), list(reversed(ring))])
        obj[GENERATED_KEY] = True  # Even if tagged, it must never enter a section.
        return obj

    def snapshot(self):
        bpy.context.view_layer.update()
        return ({o: fingerprint(o) for o in bpy.data.objects if o.type == 'MESH'},
                set(bpy.data.objects), set(bpy.data.meshes), bpy.context.view_layer.objects.active)

    def check_snapshot(self, before):
        fingerprints, objects, meshes, active = before
        self.assertEqual(set(bpy.data.objects), objects)
        self.assertEqual(set(bpy.data.meshes), meshes)
        self.assertEqual(bpy.context.view_layer.objects.active, active)
        self.assertEqual({o: fingerprint(o) for o in fingerprints}, fingerprints)

    def partition(self, sources, expected_cells, angle=0.0):
        before = self.snapshot()
        with export_geometry(bpy.context, sources) as (parts, stats, opening):
            volumes = sum(audit(p.data) * abs(p.matrix_world.to_3x3().determinant()) for p in parts)
            grid = export_grid(bpy.context, parts, opening, self.settings.section_width_mm,
                               self.settings.section_height_mm, PRINTERS[self.settings.bambu_printer])
            self.assertAlmostEqual(grid[0].angle, angle, places=6)
            with export_sections(bpy.context, parts, grid) as sections:
                self.assertEqual(len(sections), expected_cells)
                volume = 0
                for section, objects in sections:
                    self.assertTrue(objects)
                    w, s, e, n = section.bounds
                    for obj in objects:
                        volume += audit(obj.data)
                        self.assertTrue(all(w - 2e-5 <= v.co.x <= e + 2e-5 and
                                            s - 2e-5 <= v.co.y <= n + 2e-5
                                            for v in obj.data.vertices))
                        self.assertEqual(obj.matrix_world, Matrix.Identity(4))
                self.assertAlmostEqual(volume, volumes, delta=volumes * 2e-6)
        self.check_snapshot(before)
        return grid

    def export(self, name):
        before = self.snapshot()
        path = FOLDER / (name + '.3mf')
        self.assertEqual(bpy.ops.jarvizar.export_3mf(filepath=str(path)), {'FINISHED'})
        self.check_snapshot(before)
        with zipfile.ZipFile(path) as archive:
            return (ET.fromstring(archive.read(MODEL)), ET.fromstring(archive.read(SETTINGS)),
                    json.loads(archive.read(PROJECT)))

    def plate_points(self, model, config, project):
        """Placed points of every plate, relative to its own virtual bed origin."""
        width, depth = (float(v) for v in project['printable_area'][2].split('x'))
        plates = config.findall('plate')
        result = {}
        for index, plate in enumerate(plates):
            object_id = plate.find("model_instance/metadata[@key='object_id']").get('value')
            item = model.find(f"m:build/m:item[@objectid='{object_id}']", NS)
            assembly = model.find(f"m:resources/m:object[@id='{object_id}']", NS)
            ox, oy = plate_origin(index, len(plates), width, depth)
            points = []
            for component in assembly.findall('m:components/m:component', NS):
                mesh = model.find(f"m:resources/m:object[@id='{component.get('objectid')}']/m:mesh", NS)
                for vertex in mesh.findall('m:vertices/m:vertex', NS):
                    x, y, z = transform(tuple(float(vertex.get(a)) for a in 'xyz'), item.get('transform'))
                    points.append((x - ox, y - oy, z))
            result[plate.find("metadata[@key='plater_name']").get('value')] = points
        return result, width, depth

    def assert_on_beds(self, model, config, project):
        points, width, depth = self.plate_points(model, config, project)
        for name, plate in points.items():
            self.assertTrue(all(-1e-4 <= x <= width + 1e-4 and -1e-4 <= y <= depth + 1e-4 and z >= -1e-4
                                for x, y, z in plate), name)
        self.assertAlmostEqual(min(z for plate in points.values() for _, _, z in plate), 0, places=4)
        return points

    def test_six_plates_materials_layers_units_and_exact_seams(self):
        self.frame(rectangle(450, 260))
        terrain = self.source('terrain', rectangle(600, 400))
        road = self.source('surface_road', rectangle(600, 7), 1.8, 2.4)
        building = self.source('buildings', rectangle(320, 130), 1.8, 12)
        building.rotation_euler.z = 0.17
        # Multiple painted colors in a single part, including color IDs > 2.
        for obj, color in [(terrain, (0.2, 0.4, 0.6, 1)), (road, (0.05, 0.05, 0.05, 1)),
                           (building, (0.8, 0.7, 0.6, 1))]:
            mat = bpy.data.materials.new(obj.name)
            mat.diffuse_color = color
            obj.data.materials.append(mat)
        for color in [(1, 0, 0, 1), (0, 1, 0, 1), (0, 0, 1, 1)]:
            mat = bpy.data.materials.new('facade')
            mat.diffuse_color = color
            building.data.materials.append(mat)
        for face in building.data.polygons:
            face.material_index = face.index % 4
        terrain.select_set(True)
        bpy.context.view_layer.objects.active = terrain
        self.partition([terrain, road, building], 6)
        for units, length, display in [('NONE', 1, 'ADAPTIVE'), ('METRIC', .001, 'MILLIMETERS')]:
            scene_units = bpy.context.scene.unit_settings
            scene_units.system, scene_units.scale_length, scene_units.length_unit = units, length, display
            model, config, project = self.export('six-' + units)
            self.assertEqual(len(model.findall('m:build/m:item', NS)), 6)
            self.assertEqual([p.find("metadata[@key='plater_name']").get('value') for p in config.findall('plate')],
                             [f'Section R{r} C{c}' for r in (1, 2) for c in (1, 2, 3)])
            self.assertEqual(len(project['filament_colour']), 6)
            self.assertEqual(project['printer_model'], 'Bambu Lab P1S')
            self.assertTrue(model.findall('.//m:triangle[@paint_color]', NS))
            # Every part carries its filament; the assembly takes its first part's.
            for obj in config.findall('object'):
                extruders = [p.find("metadata[@key='extruder']").get('value') for p in obj.findall('part')]
                self.assertTrue(extruders and all(1 <= int(e) <= 6 for e in extruders))
                self.assertEqual(obj.find("metadata[@key='extruder']").get('value'), extruders[0])
            terrain_parts = [p for p in config.findall('object/part')
                             if p.find("metadata[@key='name']").get('value') == 'Terrain']
            xs = []
            for part in terrain_parts:
                obj = model.find(f"m:resources/m:object[@id='{part.get('id')}']", NS)
                points = [float(v.get('x')) for v in obj.findall('.//m:vertex', NS)]
                xs.append((min(points), max(points)))
            self.assertEqual(xs[:3], [(-225, -75), (-75, 75), (75, 225)])
            self.assertEqual(xs[:3], xs[3:])
            self.assertFalse(any('cutout' in str(e.attrib) for e in model.iter()))
            self.assert_on_beds(model, config, project)

    def test_concave_empty_cell_and_small_single_plate(self):
        cutout = self.frame([(-200, -200), (200, -200), (200, 0), (0, 0), (0, 200), (-200, 200)])
        terrain = self.source('terrain', rectangle(600, 600))
        self.partition([terrain], 3)
        model, config, _ = self.export('concave')
        self.assertEqual(len(config.findall('plate')), 3)
        self.assertEqual([p.find("metadata[@key='plater_name']").get('value') for p in config.findall('plate')],
                         ['Section R1 C1', 'Section R2 C1', 'Section R2 C2'])
        bpy.data.objects.remove(cutout, do_unlink=True)
        self.frame(rectangle(170, 120))
        model, config, _ = self.export('fits')
        self.assertEqual(len(config.findall('plate')), 1)
        self.assertEqual(len(model.findall('m:build/m:item', NS)), 1)
        # Without sections the whole map is one plate, still a native project
        # with a filament per part.
        self.settings.multi_plate_export = False
        model, config, project = self.export('disabled')
        self.assertEqual([p.find("metadata[@key='plater_name']").get('value') for p in config.findall('plate')], ['Map'])
        self.assertEqual(config.find('object/metadata').get('value'), 'Map')
        self.assertEqual([p.find("metadata[@key='extruder']").get('value') for p in config.findall('object/part')], ['1'])
        self.assertEqual(project['printer_settings_id'], 'Bambu Lab P1S 0.4 nozzle')
        self.assert_on_beds(model, config, project)

    def test_rotated_frame_transformed_layers_and_boundary_tangency(self):
        cutout = self.frame(rectangle(310, 240))
        cutout.matrix_world = Matrix.Translation((17, -31, 5)) @ Matrix.Rotation(.25, 4, 'Z')
        terrain = self.source('terrain', rectangle(600, 600))
        other = self.source('buildings', rectangle(350, 200), 2, 8)
        other.matrix_world = Matrix.Translation((9, -4, 0)) @ Matrix.Diagonal((-1.1, .8, 1, 1))
        bevel = other.modifiers.new('bevel', 'BEVEL')
        bevel.width = .15
        # Separate overlapping shells are deliberately retained by the cutter.
        # The grid follows the rotated frame: its cells are rectangles aligned
        # with the frame that together span exactly the 310 x 240 opening.
        grid = self.partition([terrain, other], 4, angle=.25)
        self.assertAlmostEqual(max(c.bounds[2] for c in grid) - min(c.bounds[0] for c in grid), 310, places=3)
        self.assertAlmostEqual(max(c.bounds[3] for c in grid) - min(c.bounds[1] for c in grid), 240, places=3)
        self.assertTrue(all(c.bounds[2] - c.bounds[0] <= 210 and c.bounds[3] - c.bounds[1] <= 210 for c in grid))
        model, config, project = self.export('rotated')
        self.assertEqual(len(config.findall('plate')), 4)
        self.assert_on_beds(model, config, project)

    def test_curved_opening_holes_and_solids_exactly_on_a_seam(self):
        ring=[(180*math.cos(i*math.tau/24), 140*math.sin(i*math.tau/24)) for i in range(24)]
        cutout=self.frame(ring)
        terrain=self.source('terrain',rectangle(600,600))
        self.partition([terrain],4)
        # Edge cleanup must keep the large top/bottom faces flat, even where
        # successive oblique cuts leave many almost coincident wall vertices.
        with export_geometry(bpy.context, [terrain]) as (parts, stats, opening):
            expected = abs(sum(a[0]*b[1]-b[0]*a[1]
                               for a,b in zip(ring,ring[1:]+ring[:1]))) * 1.5
            self.assertAlmostEqual(audit(parts[0].data), expected, delta=expected*2e-6)
            for face in oriented(parts[0].data):
                if abs(face.normal.z) > .9:
                    zs = [parts[0].data.vertices[i].co.z for i in face.vertices]
                    self.assertLess(max(zs)-min(zs), 1e-6)
        bpy.data.objects.remove(cutout,do_unlink=True)
        self.frame(rectangle(400,100))
        left=self.source('left',rectangle(100,20,-50))
        right=self.source('right',rectangle(100,20,50))
        tube=mesh_object('tube',[rectangle(20,20),list(reversed(rectangle(10,10)))],-300,300)
        tube.data.transform(Matrix.Rotation(math.pi/2,4,'Y'))
        self.partition([left,right,tube],2)

    def test_printer_presets_clamp_sections_and_lay_out_their_beds(self):
        self.frame(rectangle(450, 260))
        terrain = self.source('terrain', rectangle(600, 400))
        self.settings.bambu_printer = 'A1M'
        self.assertEqual((self.settings.section_width_mm, self.settings.section_height_mm), (180, 180))
        self.partition([terrain], 6)
        model, config, project = self.export('mini')
        self.assertEqual(project['printable_area'], ['0x0', '180x0', '180x180', '0x180'])
        self.assertEqual(project['printer_settings_id'], 'Bambu Lab A1 mini 0.4 nozzle')
        self.assertEqual(project['print_settings_id'], '0.20mm Standard @BBL A1M')
        self.assertEqual(project['filament_settings_id'], ['Bambu PLA Basic @BBL A1M'])
        points = self.assert_on_beds(model, config, project)
        self.assertEqual(len(points), 6)
        # A larger bed admits larger sections; two H2D plates hold the same map.
        self.settings.bambu_printer = 'H2D'
        self.settings.section_width_mm = 350
        self.settings.section_height_mm = 320
        model, config, project = self.export('h2d')
        self.assertEqual(len(config.findall('plate')), 2)
        self.assertEqual(project['printer_model'], 'Bambu Lab H2D')
        self.assert_on_beds(model, config, project)
        self.settings.bambu_printer = 'P1S'
        self.assertEqual((self.settings.section_width_mm, self.settings.section_height_mm), (256, 256))

    def test_failure_preserves_destination_and_scene(self):
        self.frame(rectangle(400, 300))
        terrain = self.source('terrain', rectangle(600, 600))
        terrain.select_set(True)
        bpy.context.view_layer.objects.active = terrain
        path = FOLDER / 'failure.3mf'
        path.write_bytes(b'previous destination')
        for target in ('jarvizar_city_model.data.export_plates.PlateWriter.close',
                       'jarvizar_city_model.blender.export_cutout.export_sections'):
            before = self.snapshot()
            with patch(target, side_effect=ValueError('injected section failure')):
                with self.assertRaisesRegex(RuntimeError, 'injected section failure'):
                    bpy.ops.jarvizar.export_3mf(filepath=str(path))
            self.assertEqual(path.read_bytes(), b'previous destination')
            self.assertFalse(list(FOLDER.glob('.jcm-3mf-*')))
            self.check_snapshot(before)

    def test_missing_cutout_fails_without_uncropped_export(self):
        self.source('terrain', rectangle(600, 600))
        before = self.snapshot()
        with self.assertRaisesRegex(RuntimeError, 'needs a cutout frame'):
            bpy.ops.jarvizar.export_3mf(filepath=str(FOLDER / 'no-frame.3mf'))
        self.check_snapshot(before)


if __name__ == '__main__':
    addon.register()
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(PlateTests))
    if not result.wasSuccessful():
        raise SystemExit(1)
    print('EXPORT_PLATES_OK', result.testsRun)
