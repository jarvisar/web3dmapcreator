"""Blender regression checks for the release-audit fixes.

Run in background Blender with --factory-startup --python-exit-code 1.
Prints JARVIZAR_RELEASE_FIXES_OK.
"""
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import bmesh
import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from blender_export_cutout import addon, mesh_object, rectangle
from jarvizar_city_model import operators
from jarvizar_city_model.blender.collections import GENERATED_KEY, create_city_hierarchy
from jarvizar_city_model.blender.export_cutout import material_color
from jarvizar_city_model.blender.materials import PALETTE, model_materials


def triangles_by_part(path):
    with zipfile.ZipFile(path) as archive:
        model = archive.read("3D/3dmodel.model").decode("utf-8")
    pattern = r'<object id="\d+" name="([^"]*)" type="model">\s*<mesh>(.*?)</mesh>'
    return {name: body.count("<triangle ") for name, body in re.findall(pattern, model, re.S)}


class ReleaseFixes(unittest.TestCase):
    def setUp(self):
        if bpy.context.object is not None and bpy.context.object.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
        for obj in list(bpy.data.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        for collection in list(bpy.data.collections):
            bpy.data.collections.remove(collection)
        self.settings = bpy.context.scene.jarvizar_city_model
        self.settings.multi_plate_export = False
        self.settings.bambu_printer = "P1S"
        self.folder = Path(tempfile.mkdtemp(prefix="jcm_release_fixes_"))

    def generated(self, spacing=50):
        collections = create_city_hierarchy(bpy.context.scene)
        objects = []
        for index, name in enumerate(("terrain", "surface_road")):
            obj = mesh_object(name, [rectangle(40, 30, x=index * spacing)],
                              collection=collections["buildings"])
            obj[GENERATED_KEY] = True
            obj["feature_type"] = name
            objects.append(obj)
        return objects

    def export(self, name):
        path = self.folder / f"{name}.3mf"
        self.assertEqual(bpy.ops.jarvizar.export_3mf(filepath=str(path)), {"FINISHED"})
        return triangles_by_part(path)

    def test_emptied_object_does_not_block_export(self):
        _, road = self.generated()
        road.data.clear_geometry()
        parts = self.export("emptied")
        self.assertEqual(len(parts), 1)
        self.assertTrue(self.settings.last_status.startswith("Exported 1 parts"), self.settings.last_status)

    def test_edit_mode_changes_are_exported(self):
        _, road = self.generated()
        before = sum(self.export("before").values())
        layer = bpy.context.view_layer
        layer.objects.active = road
        road.select_set(True)
        bpy.ops.object.mode_set(mode="EDIT")
        mesh = bmesh.from_edit_mesh(road.data)
        bmesh.ops.delete(mesh, geom=list(mesh.faces)[:2], context="FACES")
        bmesh.update_edit_mesh(road.data)
        after = sum(self.export("in_edit_mode").values())
        bpy.ops.object.mode_set(mode="OBJECT")
        self.assertLess(after, before)
        self.assertEqual(sum(self.export("object_mode").values()), after)

    def test_model_larger_than_the_bed_is_reported(self):
        self.generated(spacing=280)
        self.export("wide")
        self.assertIn("larger than the Bambu Lab P1S bed", self.settings.last_status)
        for obj in list(bpy.data.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        self.generated()
        self.export("narrow")
        self.assertNotIn("larger than", self.settings.last_status)

    def test_unwritable_destination_fails_at_once(self):
        self.generated()
        real_mkdir = Path.mkdir

        def refuse(path, *args, **kwargs):
            if path.name.startswith(".jcm-write-test-"):
                raise PermissionError(13, "Access is denied")
            return real_mkdir(path, *args, **kwargs)

        with patch.object(Path, "mkdir", refuse), self.assertRaises(RuntimeError):
            bpy.ops.jarvizar.export_3mf(filepath=str(self.folder / "out.3mf"))
        self.assertIn("Cannot write to", self.settings.last_status)
        missing = self.folder / "missing" / "out.3mf"
        with self.assertRaises(RuntimeError):
            bpy.ops.jarvizar.export_3mf(filepath=str(missing))
        self.assertIn("Folder not found", self.settings.last_status)
        self.assertFalse(missing.parent.exists())

    @unittest.skipUnless(os.name == "nt", "Windows file locking")
    def test_locked_destination_names_the_file(self):
        self.generated()
        path = self.folder / "locked.3mf"
        path.write_bytes(b"old")
        with path.open("rb"):
            with self.assertRaises(RuntimeError):
                bpy.ops.jarvizar.export_3mf(filepath=str(path))
        self.assertIn("Close locked.3mf in other programs", self.settings.last_status)

    def test_translated_node_names_keep_the_palette(self):
        view = bpy.context.preferences.view
        previous = (view.language, view.use_translate_new_dataname)
        try:
            view.language = "fr_FR"
            view.use_translate_new_dataname = True
            for material in list(bpy.data.materials):
                bpy.data.materials.remove(material)
            building = model_materials()["building"]
            nodes = [node for node in building.node_tree.nodes if node.type == "BSDF_PRINCIPLED"]
            self.assertEqual(len(nodes), 1)
            for got, expected in zip(nodes[0].inputs["Base Color"].default_value, PALETTE["building"]):
                self.assertAlmostEqual(got, expected, places=6)
            self.assertEqual(material_color(building), "#AE835B")
        finally:
            view.language, view.use_translate_new_dataname = previous
            for material in list(bpy.data.materials):
                bpy.data.materials.remove(material)

    def test_typographic_minus_and_decimal_commas_in_fields(self):
        self.settings.west, self.settings.south = "−84.5337", "39.08554"
        self.settings.east, self.settings.north = "−84.47422", "39.11094"
        self.assertAlmostEqual(operators._bounds_from_settings(self.settings).west, -84.5337)
        self.settings.west = "-84,5337"
        with self.assertRaisesRegex(ValueError, "West is not a number.*point for decimals"):
            operators._bounds_from_settings(self.settings)
        self.settings.west = "-84.5337"

    def test_missing_data_message(self):
        self.settings.cache_directory = str(self.folder / "empty-cache")
        with self.assertRaises(RuntimeError):
            bpy.ops.jarvizar.generate_model()
        self.assertTrue(self.settings.last_status.startswith(
            "Generation failed: No downloaded map data for this area"), self.settings.last_status)

    def test_cache_directory_rules_in_an_unsaved_file(self):
        self.assertFalse(bpy.data.filepath)
        self.settings.cache_directory = ""
        with self.assertRaisesRegex(ValueError, "Cache Directory is empty"):
            operators._cache_root(self.settings)
        self.settings.cache_directory = "//cache"
        self.assertEqual(self.settings.cache_directory, "//cache")
        with self.assertRaisesRegex(ValueError, "not saved"):
            operators._cache_root(self.settings)
        self.settings.cache_directory = str(self.folder / "cache")

    def test_z_relative_cache_directory_becomes_absolute_once_saved(self):
        # Runs last: saving gives the session a file path.
        blend = self.folder / "scene.blend"
        bpy.ops.wm.save_as_mainfile(filepath=str(blend))
        self.settings.cache_directory = "//cache"
        self.assertEqual(Path(self.settings.cache_directory), self.folder / "cache")


if __name__ == "__main__":
    addon.register()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ReleaseFixes)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful():
        raise SystemExit(1)
    print("JARVIZAR_RELEASE_FIXES_OK", result.testsRun)
