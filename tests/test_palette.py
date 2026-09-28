"""Palette groups and presets, independent of Blender."""
import ast
import json
import os
from pathlib import Path
import struct
from types import SimpleNamespace
from typing import Dict, Tuple
import unittest

from jarvizar_city_model.data import palette
from jarvizar_city_model.data.export_plates import FILAMENT_LINES

PACKAGE = Path(palette.__file__).resolve().parents[1]
BAMBU_CODES = Path(os.environ.get(
    "BAMBU_FILAMENT_CODES",
    r"C:\Program Files\Bambu Studio\resources\profiles\BBL\filament\filaments_color_codes.json"))
FEATURES = ("generate_terrain", "generate_border_rim", "generate_buildings", "use_lidar_buildings",
            "lidar_rock_surfaces", "lidar_height_only", "generate_roads", "generate_bridges",
            "generate_water", "generate_land_surfaces", "generate_trees")


def material_constants():
    """materials.py's module constants and _bambu, evaluated without bpy."""
    tree = ast.parse((PACKAGE / "blender" / "materials.py").read_text(encoding="utf-8"))
    namespace = {"Dict": Dict, "Tuple": Tuple}
    for node in tree.body:
        if isinstance(node, (ast.Assign, ast.AnnAssign)) or (
                isinstance(node, ast.FunctionDef) and node.name == "_bambu"):
            try:
                exec(compile(ast.Module(body=[node], type_ignores=[]), "materials.py", "exec"), namespace)
            except NameError:
                pass  # A constant that needs bpy; the palette never does.
    return namespace


def feature_defaults():
    """Default feature toggles of the scene settings in config.py."""
    tree = ast.parse((PACKAGE / "config.py").read_text(encoding="utf-8"))
    settings = next(node for node in tree.body
                    if isinstance(node, ast.ClassDef) and node.name == "JARVIZAR_PG_city_model_settings")
    defaults = {}
    for node in settings.body:
        if isinstance(node, ast.AnnAssign) and node.target.id in FEATURES:
            default = next(k.value for k in node.annotation.keywords if k.arg == "default")
            defaults[node.target.id] = ast.literal_eval(default)
    return defaults


def float32(entries):
    return {key: (struct.unpack("<3f", struct.pack("<3f", *colour)), line)
            for key, (colour, line) in entries.items()}


class PaletteTests(unittest.TestCase):
    def test_groups_cover_every_material_role_once(self):
        constants = material_constants()
        roles = [role for group in palette.GROUPS for role in group.roles]
        self.assertEqual(sorted(roles), sorted(constants["PALETTE"]))
        self.assertEqual(len(roles), len(set(roles)))
        self.assertEqual(len(palette.GROUP_KEYS), len(set(palette.GROUP_KEYS)))
        for group in palette.GROUPS:
            self.assertTrue(group.key.isidentifier() and not group.key.endswith("_line"))
            self.assertNotEqual(group.key, "show_lines")
            # One word each: the label shares a row with the swatch at 180 px.
            self.assertLessEqual(len(group.label), 10, group.label)

    def test_default_preset_is_the_material_palette_bit_for_bit(self):
        constants = material_constants()
        entries = palette.role_palette(palette.DEFAULT_PRESET.entries)
        self.assertEqual(set(entries), set(constants["PALETTE"]))
        for role, color in constants["PALETTE"].items():
            colour, line = entries[role]
            self.assertEqual(struct.pack("<3d", *colour), struct.pack("<3d", *color[:3]), role)
            self.assertEqual(color[3], 1.0)
            self.assertEqual(line, "PLA Matte" if role in constants["MATTE_ROLES"] else "PLA Basic", role)
        self.assertIs(palette.PRESETS[0], palette.DEFAULT_PRESET)

    def test_conversion_matches_materials(self):
        bambu = material_constants()["_bambu"]
        for line, names in palette.FILAMENTS.items():
            self.assertIn(line, FILAMENT_LINES)
            for name, code in names.items():
                self.assertRegex(code, r"^#[0-9A-F]{6}$")
                self.assertEqual((*palette.rgb(code), 1.0), bambu(code))
                self.assertEqual(palette.filament(line, name), (palette.rgb(code), line))
                # Stored as float32 by Blender, exported as the same code.
                stored = struct.unpack("<3f", struct.pack("<3f", *palette.rgb(code)))
                self.assertEqual(palette.hex_code(stored), code)

    def test_catalogue_matches_installed_bambu_studio(self):
        if not BAMBU_CODES.is_file():
            self.skipTest(f"Bambu Studio colour codes not found: {BAMBU_CODES}")
        data = json.loads(BAMBU_CODES.read_text(encoding="utf-8"))["data"]
        codes = {(entry["fila_type"], entry["fila_color_name"]["en"]): entry["fila_color"][0][:7].upper()
                 for entry in data if entry["fila_type"] in FILAMENT_LINES and len(entry["fila_color"]) == 1}
        for line, names in palette.FILAMENTS.items():
            for name, code in names.items():
                self.assertEqual(codes.get((line, name)), code, f"{line} {name}")

    def test_presets_set_every_group_to_a_bambu_filament(self):
        legacy = {"water", "forest", "trees", "sand", "rock", "rim"}
        for preset in palette.PRESETS:
            self.assertEqual(tuple(preset.entries), palette.GROUP_KEYS)
            self.assertTrue(preset.name and preset.description)
            for key, (colour, line) in preset.entries.items():
                self.assertIn(line, FILAMENT_LINES)
                self.assertTrue(all(0.0 <= c <= 1.0 for c in colour) and len(colour) == 3)
                if preset is palette.DEFAULT_PRESET and key in legacy:
                    continue
                name = palette.filament_name((colour, line))
                self.assertTrue(name, f"{preset.name} {key}")
                self.assertEqual(colour, palette.rgb(palette.FILAMENTS[line][name[len(line) + 1:]]))
        self.assertEqual(len({preset.key for preset in palette.PRESETS}), len(palette.PRESETS))
        self.assertEqual(len({preset.name for preset in palette.PRESETS}), len(palette.PRESETS))

    def test_filament_counts(self):
        presets = {preset.key: preset.entries for preset in palette.PRESETS}
        everything = palette.GROUP_KEYS
        defaults = SimpleNamespace(**feature_defaults())
        used = palette.used_groups(defaults)
        self.assertEqual(used, ("terrain", "buildings", "roads", "paved", "water", "green",
                                "forest", "sand", "rock"))
        self.assertEqual(palette.filament_count(presets["SINGLE"], everything), 1)
        self.assertLessEqual(palette.filament_count(presets["AMS4"], everything), 4)
        self.assertEqual(palette.filament_count(presets["DEFAULT"], used), 7)
        self.assertEqual(palette.filament_count(presets["DEFAULT"], everything), 8)
        for key, entries in presets.items():
            self.assertLessEqual(palette.filament_count(entries, used), 7, key)

    def test_used_groups_follow_feature_toggles(self):
        settings = SimpleNamespace(**{name: False for name in FEATURES})
        self.assertEqual(palette.used_groups(settings), ())
        settings.generate_border_rim = True
        self.assertEqual(palette.used_groups(settings), ())
        settings.generate_terrain = True
        self.assertEqual(palette.used_groups(settings), ("terrain", "rim"))
        settings.generate_bridges = True
        settings.generate_trees = True
        self.assertEqual(palette.used_groups(settings), ("terrain", "roads", "trees", "rim"))
        settings = SimpleNamespace(**{name: False for name in FEATURES})
        settings.generate_buildings = settings.use_lidar_buildings = settings.lidar_rock_surfaces = True
        self.assertEqual(palette.used_groups(settings), ("buildings", "rock"))
        settings.lidar_height_only = True
        self.assertEqual(palette.used_groups(settings), ("buildings",))

    def test_settings_palette_and_matching_preset(self):
        for preset in palette.PRESETS:
            stored = float32(preset.entries)
            settings = SimpleNamespace(**{key: list(colour) for key, (colour, _) in stored.items()},
                                       **{key + "_line": line for key, (_, line) in stored.items()})
            entries = palette.settings_palette(settings)
            self.assertEqual(entries, stored)
            self.assertIs(palette.matching_preset(entries), preset)
            roles = palette.role_palette(entries)
            for group in palette.GROUPS:
                self.assertTrue(all(roles[role] == entries[group.key] for role in group.roles))
        entries = float32(palette.DEFAULT_PRESET.entries)
        entries["water"] = (entries["water"][0], "PLA Matte")
        self.assertIsNone(palette.matching_preset(entries))
        entries = float32(palette.DEFAULT_PRESET.entries)
        entries["rim"] = ((0.16, 0.16, 0.18), "PLA Basic")
        self.assertIsNone(palette.matching_preset(entries))

    def test_filament_names(self):
        self.assertEqual(palette.filament_name(palette.filament("PLA Matte", "Caramel")), "PLA Matte Caramel")
        # Jade White and Ivory White share #FFFFFF; the line tells them apart.
        self.assertEqual(palette.filament_name(((1.0, 1.0, 1.0), "PLA Basic")), "PLA Basic Jade White")
        self.assertEqual(palette.filament_name(((1.0, 1.0, 1.0), "PLA Matte")), "PLA Matte Ivory White")
        self.assertEqual(palette.filament_name(((0.36, 0.70, 0.82), "PLA Basic")), "")


if __name__ == "__main__":
    unittest.main()
