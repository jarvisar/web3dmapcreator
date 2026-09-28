"""Scene palette, presets, material recolouring and 3MF filaments.

Run with Blender --background --factory-startup --python-exit-code 1. The
modal case launches one real generation worker.
"""

import json
from pathlib import Path
import re
import struct
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import zipfile
import xml.etree.ElementTree as ET

import bpy

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
import jarvizar_city_model as addon
from jarvizar_city_model import operators_palette
from jarvizar_city_model.blender import generation_modal as modal
from jarvizar_city_model.blender import materials
from jarvizar_city_model.blender.collections import GENERATED_KEY
from jarvizar_city_model.blender.export_cutout import material_color
from jarvizar_city_model.data import palette
from jarvizar_city_model.data.export_3mf import SETTINGS
from jarvizar_city_model.data.export_plates import PROJECT
from blender_generation_modal import ModalTests
from blender_generation_transaction import TransactionTests
from blender_smoke import point, polygon, write_collection

# Semantic part names (data/export_3mf.py) and the group colouring them.
PART_GROUPS = {
    "Terrain": "terrain", "Terrain Supports": "terrain", "Border Rim": "rim", "Buildings": "buildings",
    "Building Parts": "buildings", "Water": "water", "Trees": "trees", "Greenery": "green",
    "Forest": "forest", "Sand": "sand", "Rock": "rock", "Paved": "paved",
}


def f32(values):
    return struct.unpack(f"<{len(values)}f", struct.pack(f"<{len(values)}f", *values))


def part_group(name):
    name = re.sub(r" \d+$", "", name)
    if name.startswith(("Roads", "Paths", "Railways", "Bridges", "Footbridges", "Rail Bridges", "Bridge Supports")):
        return "roads"
    return PART_GROUPS[name]


class PaletteTests(unittest.TestCase):
    run_generation = TransactionTests.run_generation
    start = ModalTests.start
    drive = ModalTests.drive

    def setUp(self):
        TransactionTests.setUp(self)
        self.context.window = bpy.context.window
        self.context.window_manager.windows = []
        self.addCleanup(modal.shutdown_generation)
        self.settings.generate_trees = True
        self.settings.use_lidar_buildings = False

        def ring(x, y, size=.001):
            return [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]

        # Every land cover category, so each group has a part to export.
        write_collection(self.bundle.data_path("land"), [
            point("tree", [-84.508, 39.094], subtype="tree"),
            polygon("wood", [ring(-84.5065, 39.0915, .002)], subtype="forest"),
            polygon("beach", [ring(-84.5025, 39.0915, .0012)], subtype="sand"),
            polygon("outcrop", [ring(-84.5025, 39.0985, .0008)], subtype="rock")])
        write_collection(self.bundle.data_path("land_use"), [
            polygon("park", [ring(-84.509, 39.091, .004)], subtype="park"),
            polygon("square", [ring(-84.5045, 39.0985, .0008)], subtype="plaza")])
        self.palette = self.settings.palette
        self.folder = tempfile.TemporaryDirectory(prefix="jcm_palette_")
        self.addCleanup(self.folder.cleanup)

    def entries(self):
        return palette.settings_palette(self.palette)

    def assert_materials(self, entries=None):
        """Every JCM_* material holds its group's colour in both places, and its line."""
        entries = palette.role_palette(entries or self.entries())
        for role in materials.PALETTE:
            material = bpy.data.materials[materials._material_name(role)]
            colour, line = entries[role]
            expected = f32((*colour, 1.0))
            self.assertEqual(tuple(material.diffuse_color), expected, role)
            base = material.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value
            self.assertEqual(tuple(base), expected, role)
            self.assertEqual(material[materials.FILAMENT_KEY], line, role)

    def export(self, name):
        path = Path(self.folder.name) / f"{name}.3mf"
        self.assertEqual(bpy.ops.jarvizar.export_3mf(filepath=str(path)), {"FINISHED"})
        with zipfile.ZipFile(path) as archive:
            config = ET.fromstring(archive.read(SETTINGS))
            project = json.loads(archive.read(PROJECT))
        parts = {}
        for part in config.findall("object/part"):
            index = int(part.find("metadata[@key='extruder']").get("value")) - 1
            line = "PLA Matte" if "PLA Matte" in project["filament_settings_id"][index] else "PLA Basic"
            parts[part.find("metadata[@key='name']").get("value")] = project["filament_colour"][index], line
        return parts, project

    def assert_export(self, name):
        """Each exported part's filament is its group's palette colour and line."""
        parts, project = self.export(name)
        entries = self.entries()
        groups = set()
        for part, (colour, line) in parts.items():
            group = part_group(part)
            groups.add(group)
            self.assertEqual((colour, line), (palette.hex_code(entries[group][0]), entries[group][1]), part)
        self.assertEqual(len(project["filament_colour"]), palette.filament_count(entries, groups))
        return parts, project, groups

    def test_defaults_are_the_built_in_palette(self):
        constants = {role: (f32(colour[:3]), "PLA Matte" if role in materials.MATTE_ROLES else "PLA Basic")
                     for role, colour in materials.PALETTE.items()}
        self.assertEqual(palette.role_palette(self.entries()), constants)
        self.assertIs(palette.matching_preset(self.entries()), palette.DEFAULT_PRESET)
        self.assertEqual(self.run_generation(), {"FINISHED"})
        for role, colour in materials.PALETTE.items():
            material = bpy.data.materials[materials._material_name(role)]
            self.assertEqual(tuple(material.diffuse_color), f32(colour))
            roughness = materials._ROUGHNESS.get(role, materials._DEFAULT_ROUGHNESS)
            self.assertEqual(material.roughness, f32((roughness,))[0])
            self.assertEqual(dict(material.items()), {GENERATED_KEY: True, materials.MATERIAL_ROLE_KEY: role,
                                                      materials.FILAMENT_KEY: constants[role][1]})
        self.assert_materials()
        _, _, groups = self.assert_export("default")
        self.assertEqual(groups, set(palette.GROUP_KEYS))

    def test_snapshot_excludes_the_palette(self):
        snapshot = modal.settings_snapshot(self.settings)
        json.dumps(snapshot)
        self.assertFalse([key for key in snapshot if "palette" in key or key in palette.GROUP_KEYS])
        self.palette.water = (.1, .2, .3)
        self.palette.water_line = "PLA Matte"
        self.palette.show_lines = True
        self.assertEqual(modal.settings_snapshot(self.settings), snapshot)

    def test_presets_recolour_the_model_and_export(self):
        self.assertEqual(self.run_generation(), {"FINISHED"})
        for preset in palette.PRESETS:
            with self.subTest(preset=preset.name):
                self.assertEqual(bpy.ops.jarvizar.palette_preset(preset=preset.key), {"FINISHED"})
                self.assertIs(palette.matching_preset(self.entries()), preset)
                self.assert_materials(preset.entries)
                _, project, groups = self.assert_export(preset.key)
                if preset.key == "SINGLE":
                    self.assertEqual(project["filament_colour"], ["#FFFFFF"])
                    self.assertEqual(len(project["filament_settings_id"]), 1)
                    self.assertIn("PLA Matte", project["filament_settings_id"][0])
                if preset.key == "AMS4":
                    self.assertLessEqual(len(project["filament_colour"]), 4)
        # Regenerating keeps the chosen colours rather than the built-in ones.
        self.assertEqual(self.run_generation(), {"FINISHED"})
        self.assert_materials(palette.PRESETS[-1].entries)

    def test_custom_colours_apply_live_and_to_generation(self):
        self.assertEqual(self.run_generation(), {"FINISHED"})
        self.palette.buildings = (.5, .25, .125)
        self.palette.roads_line = "PLA Matte"
        self.assertIsNone(palette.matching_preset(self.entries()))
        self.assert_materials()
        self.assertEqual(bpy.ops.jarvizar.palette_filament(group="water", filament="PLA Basic:Cyan"), {"FINISHED"})
        self.assertEqual(palette.filament_name(self.entries()["water"]), "PLA Basic Cyan")
        self.assert_materials()
        parts, _, _ = self.assert_export("custom")
        filaments = {group: {value for name, value in parts.items() if part_group(name) == group}
                     for group in ("water", "buildings")}
        self.assertEqual(filaments, {"water": {("#0086D6", "PLA Basic")}, "buildings": {("#804020", "PLA Matte")}})
        # Manual material edits last until a palette change or Generate.
        material = bpy.data.materials["JCM_Terrain"]
        material.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (.2, .4, .6, 1)
        self.assertEqual(self.run_generation(), {"FINISHED"})
        self.assert_materials()
        # No recolouring while a generation owns the scene; it stages its own.
        with patch.object(operators_palette, "is_generating", return_value=True):
            self.palette.terrain = (.3, .3, .3)
        self.assertEqual(tuple(bpy.data.materials["JCM_Terrain"].diffuse_color), (1.0, 1.0, 1.0, 1.0))
        self.assertEqual(bpy.ops.jarvizar.apply_palette(), {"FINISHED"})
        self.assert_materials()

    def test_read_colours_from_the_model(self):
        self.assertEqual(bpy.ops.jarvizar.palette_from_model(), {"CANCELLED"})
        self.assertEqual(self.run_generation(), {"FINISHED"})
        building = bpy.data.materials["JCM_Building"]
        building.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (.7, .1, .2, 1)
        building[materials.FILAMENT_KEY] = "PLA Basic"
        water = bpy.data.materials["JCM_Water"]
        if bpy.app.version < (5, 0, 0):
            # Blender 5 always uses nodes; the export then reads the shader.
            water.use_nodes = False
        water.diffuse_color = (.05, .1, .6, 1)
        exported = material_color(water)
        self.assertEqual(bpy.ops.jarvizar.palette_from_model(), {"FINISHED"})
        entries = self.entries()
        self.assertEqual(entries["buildings"], (f32((.7, .1, .2)), "PLA Basic"))
        self.assertEqual(palette.hex_code(entries["water"][0]), exported)
        # Unedited colours read back unrounded.
        self.assertEqual(entries["forest"], (f32(materials.PALETTE["surface_forest"][:3]), "PLA Basic"))
        # Building parts follow their group; the viewport colour follows the shader.
        self.assert_materials()
        self.assert_export("read")

    def test_colour_change_during_modal_generation(self):
        self.assertEqual(self.run_generation(), {"FINISHED"})
        session = self.start()
        self.palette.water = (.1, .2, .3)
        self.palette.buildings_line = "PLA Basic"
        # Skipped while generating: the previous model keeps its colours.
        self.assertEqual(tuple(bpy.data.materials["JCM_Water"].diffuse_color), f32(materials.PALETTE["water"]))
        self.assertEqual(self.drive(session), {"FINISHED"}, session.message)
        self.assertFalse(session.cancel_requested)
        self.assert_materials()

    def test_undoable_operators(self):
        for operator in (operators_palette.JARVIZAR_OT_palette_preset, operators_palette.JARVIZAR_OT_palette_filament,
                         operators_palette.JARVIZAR_OT_apply_palette,
                         operators_palette.JARVIZAR_OT_palette_from_model):
            self.assertIn("UNDO", operator.bl_options)
        with patch.object(operators_palette, "is_generating", return_value=True):
            for name in ("palette_preset", "palette_filament", "apply_palette", "palette_from_model"):
                self.assertFalse(getattr(bpy.ops.jarvizar, name).poll(), name)


if __name__ == "__main__":
    addon.register()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(PaletteTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    addon.unregister()
    if not result.wasSuccessful():
        raise SystemExit(1)
    print("JARVIZAR_PALETTE_OK")
