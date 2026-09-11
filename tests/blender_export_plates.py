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
from blender_export_cutout import addon, mesh_object, rectangle, fingerprint, audit
from jarvizar_city_model.blender.collections import create_city_hierarchy, GENERATED_KEY
from jarvizar_city_model.blender.export_cutout import export_geometry, export_grid, export_section
from jarvizar_city_model.data.export_3mf import MODEL, NS, SETTINGS
from jarvizar_city_model.data.export_plates import PROJECT


FOLDER = Path(__file__).resolve().parents[1] / 'scratchpad' / 'multi-plate'


class PlateTests(unittest.TestCase):
    def setUp(self):
        for obj in list(bpy.data.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        for col in list(bpy.data.collections):
            bpy.data.collections.remove(col)
        self.collections = create_city_hierarchy(bpy.context.scene)
        self.settings = bpy.context.scene.jarvizar_city_model
        self.settings.multi_plate_export = True
        self.settings.section_width_mm = 210
        self.settings.section_height_mm = 210
        bpy.ops.preferences.addon_enable(module='io_mesh_3mf')
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

    def partition(self, sources, expected_cells):
        before = self.snapshot()
        with export_geometry(bpy.context, sources) as (parts, stats, opening):
            volumes = sum(audit(p.data) * abs(p.matrix_world.to_3x3().determinant()) for p in parts)
            grid = export_grid(bpy.context, parts, opening, self.settings.section_width_mm,
                               self.settings.section_height_mm)
            volume = 0
            occupied = 0
            for section in grid:
                with export_section(bpy.context, parts, section) as meshes:
                    occupied += bool(meshes)
                    for obj in meshes:
                        volume += audit(obj.data)
                        w, s, e, n = section.bounds
                        self.assertTrue(all(w - 2e-5 <= v.co.x <= e + 2e-5 and
                                            s - 2e-5 <= v.co.y <= n + 2e-5
                                            for v in obj.data.vertices))
                        self.assertEqual(obj.matrix_world, Matrix.Identity(4))
            self.assertEqual(occupied, expected_cells)
            self.assertAlmostEqual(volume, volumes, delta=volumes * 2e-6)
        self.check_snapshot(before)

    def export(self, name):
        before = self.snapshot()
        path = FOLDER / (name + '.3mf')
        self.assertEqual(bpy.ops.jarvizar.export_3mf(filepath=str(path)), {'FINISHED'})
        self.check_snapshot(before)
        with zipfile.ZipFile(path) as archive:
            return (ET.fromstring(archive.read(MODEL)), ET.fromstring(archive.read(SETTINGS)),
                    json.loads(archive.read(PROJECT)) if PROJECT in archive.namelist() else None)

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
            self.assertTrue(model.findall('.//m:triangle[@paint_color]', NS))
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
        self.settings.multi_plate_export = False
        model, config, project = self.export('disabled')
        self.assertIsNone(project)
        self.assertFalse(config.findall('plate'))
        self.assertEqual(config.find('object/metadata').get('value'), 'Map')

    def test_rotated_frame_transformed_layers_and_boundary_tangency(self):
        cutout = self.frame(rectangle(310, 240))
        cutout.matrix_world = Matrix.Translation((17, -31, 5)) @ Matrix.Rotation(.25, 4, 'Z')
        terrain = self.source('terrain', rectangle(600, 600))
        other = self.source('buildings', rectangle(350, 200), 2, 8)
        other.matrix_world = Matrix.Translation((9, -4, 0)) @ Matrix.Diagonal((-1.1, .8, 1, 1))
        bevel = other.modifiers.new('bevel', 'BEVEL')
        bevel.width = .15
        # Separate overlapping shells are deliberately retained by the cutter.
        self.partition([terrain, other], 4)

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
            for face in parts[0].data.polygons:
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

    def test_failure_preserves_destination_and_scene(self):
        self.frame(rectangle(400, 300))
        terrain = self.source('terrain', rectangle(600, 600))
        terrain.select_set(True)
        bpy.context.view_layer.objects.active = terrain
        path = FOLDER / 'failure.3mf'
        path.write_bytes(b'previous destination')
        for target in ('jarvizar_city_model.data.export_plates.combine_plates',
                       'jarvizar_city_model.blender.export_cutout.export_section'):
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
