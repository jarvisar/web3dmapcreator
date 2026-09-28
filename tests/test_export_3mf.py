"""Archive contract tests for the native Bambu project writer, independent of Blender."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import xml.etree.ElementTree as ET
import zipfile

from jarvizar_city_model.data.export_3mf import MODEL, NS, SETTINGS, part_name_map, semantic_part_name
from jarvizar_city_model.data.export_plates import PRINTERS, PROJECT, PlateWriter


class Object(dict):
    name = 'User mesh & café'
    users_collection = ()
    material_slots = ()


def box(x, y, z, width, depth, height):
    """A closed, outward-wound box: (vertices, triangles)."""
    corners = [(x, y, z), (x + width, y, z), (x + width, y + depth, z), (x, y + depth, z),
               (x, y, z + height), (x + width, y, z + height),
               (x + width, y + depth, z + height), (x, y + depth, z + height)]
    triangles = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4),
                 (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    return corners, triangles


class ExportNamesTests(unittest.TestCase):
    def test_semantics_override_arbitrary_object_names(self):
        for tags, expected in [
            ({'feature_type': 'terrain'}, 'Terrain'),
            ({'feature_type': 'building'}, 'Buildings'),
            ({'feature_type': 'building_part'}, 'Building Parts'),
            ({'feature_type': 'land_surface', 'surface_category': 'green'}, 'Greenery'),
            ({'feature_type': 'land_surface', 'surface_category': 'forest'}, 'Forest'),
            ({'feature_type': 'surface_road', 'road_class': 'footway'}, 'Paths (Footway)'),
            ({'feature_type': 'surface_road', 'road_class': 'residential'}, 'Roads (Residential)'),
            ({'feature_type': 'surface_road', 'road_class': 'rail'}, 'Railways'),
            ({'feature_type': 'surface_road', 'road_class': 'airport'}, 'Roads (Airport)'),
            ({'feature_type': 'surface_road', 'road_class': 'pedestrian'}, 'Paths (Pedestrian)'),
            ({'feature_type': 'bridge_deck', 'road_class': 'footway'}, 'Footbridges (Footway)'),
            ({'feature_type': 'trees'}, 'Trees'),
            ({'feature_type': 'labels'}, 'Labels'),
            ({'feature_type': 'future_feature'}, 'Future Feature'),
            ({}, Object.name),
        ]:
            with self.subTest(tags=tags):
                self.assertEqual(semantic_part_name(Object(tags)), expected)
        legacy_tree = Object()
        legacy_tree.users_collection = [{'jarvizar_collection_role': 'vegetation'}]
        self.assertEqual(semantic_part_name(legacy_tree), 'Trees')
        legacy_tree.users_collection = ()  # The export copy is linked to the scene.
        legacy_tree.material_slots = [SimpleNamespace(material={'jarvizar_material_role': 'tree'})]
        self.assertEqual(semantic_part_name(legacy_tree), 'Trees')
        legacy_tree['feature_type'] = 'land_surface'
        legacy_tree['surface_category'] = 'forest'
        self.assertEqual(semantic_part_name(legacy_tree), 'Forest')

    def test_repeated_types_are_numbered_by_blender_name(self):
        parts = []
        for name, kind in [('c', 'buildings'), ('a', 'terrain'), ('b', 'buildings')]:
            obj = Object({'feature_type': kind})
            obj.name = name
            parts.append(obj)
        self.assertEqual(part_name_map(parts), {'c': 'Buildings 1', 'a': 'Terrain', 'b': 'Buildings 2'})


class PlateWriterTests(unittest.TestCase):
    def write(self, printer, plates):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / 'project.3mf'
            with PlateWriter(Path(folder) / 'model.xml', PRINTERS[printer]) as writer:
                for name, parts, bounds in plates:
                    writer.add_plate(name, parts, bounds)
                writer.close(output)
            with zipfile.ZipFile(output) as archive:
                return (ET.fromstring(archive.read(MODEL)), ET.fromstring(archive.read(SETTINGS)),
                        json.loads(archive.read(PROJECT)), sorted(archive.namelist()),
                        archive.read('[Content_Types].xml').decode(), archive.read('_rels/.rels').decode())

    def test_two_plates_filaments_paint_placement_and_package(self):
        terrain = box(-100, -50, -3, 200, 100, 3)
        building = box(-10, -10, 0, 20, 20, 30)
        plate_one = [('Terrain', *terrain, [0] * 12, ['#5C6161']),
                     ('Buildings', *building, [0] * 4 + [1] * 4 + [2] * 4, ['#FFFFFF', '#FF0000', '#5C6161'])]
        plate_two = [('Terrain', *box(0, 0, -1, 100, 100, 1), [0] * 12, ['#5C6161'])]
        model, config, project, names, types, rels = self.write(
            'P1S', [('Map', plate_one, None), ('Section R1 C2', plate_two, (0, 0, 100, 100))])

        objects = model.findall('m:resources/m:object', NS)
        self.assertEqual([(o.get('id'), o.get('name')) for o in objects],
                         [('1', 'Terrain'), ('2', 'Buildings'), ('3', 'Map'), ('4', 'Terrain'), ('5', 'Section R1 C2')])
        # Parts precede the assembly that references them, as 3MF requires.
        self.assertEqual([[c.get('objectid') for c in o.findall('m:components/m:component', NS)] for o in objects],
                         [[], [], ['1', '2'], [], ['4']])
        self.assertTrue(model.find("m:metadata[@name='Application']", NS).text.startswith('BambuStudio-'))
        self.assertIn('© OpenStreetMap contributors', model.find("m:metadata[@name='Copyright']", NS).text)
        first = objects[0].find('m:mesh/m:vertices/m:vertex', NS)
        self.assertEqual((first.get('x'), first.get('y'), first.get('z')), ('-100.000000', '-50.000000', '-3.000000'))
        self.assertEqual(len(objects[0].findall('m:mesh/m:triangles/m:triangle', NS)), 12)

        # Plate one is centred by its contents on the 256 mm bed and plate two
        # by its section on the second virtual plate; both share the datum of
        # the lowest point in the project.
        items = model.findall('m:build/m:item', NS)
        self.assertEqual([i.get('objectid') for i in items], ['3', '5'])
        transforms = [[float(v) for v in i.get('transform').split()] for i in items]
        self.assertEqual(transforms[0], [1, 0, 0, 0, 1, 0, 0, 0, 1, 128, 128, 3])
        self.assertEqual(transforms[1][9:], [307.2 + 128 - 50, 128 - 50, 3])

        # Filaments are one per colour in order of first use. A mixed part
        # takes the filament of its most common material, lowest slot on a
        # tie, and its other triangles carry Bambu's paint state.
        self.assertEqual(project['filament_colour'], ['#5C6161', '#FFFFFF', '#FF0000'])
        triangles = objects[1].findall('m:mesh/m:triangles/m:triangle', NS)
        self.assertEqual([t.get('paint_color') for t in triangles], [None] * 4 + ['0C'] * 4 + ['4'] * 4)
        self.assertFalse(objects[0].findall('m:mesh/m:triangles/m:triangle[@paint_color]', NS))
        settings = [(o.get('id'), o.find("metadata[@key='name']").get('value'),
                     o.find("metadata[@key='extruder']").get('value'),
                     [(p.get('id'), p.get('subtype'), p.find("metadata[@key='name']").get('value'),
                       p.find("metadata[@key='extruder']").get('value')) for p in o.findall('part')])
                    for o in config.findall('object')]
        self.assertEqual(settings, [
            ('3', 'Map', '1', [('1', 'normal_part', 'Terrain', '1'), ('2', 'normal_part', 'Buildings', '2')]),
            ('5', 'Section R1 C2', '1', [('4', 'normal_part', 'Terrain', '1')])])
        plates = [(p.find("metadata[@key='plater_id']").get('value'), p.find("metadata[@key='plater_name']").get('value'),
                   p.find("model_instance/metadata[@key='object_id']").get('value'))
                  for p in config.findall('plate')]
        self.assertEqual(plates, [('1', 'Map', '3'), ('2', 'Section R1 C2', '5')])

        self.assertEqual(project['printer_model'], 'Bambu Lab P1S')
        self.assertEqual(project['printer_settings_id'], 'Bambu Lab P1S 0.4 nozzle')
        self.assertEqual(project['printable_area'], ['0x0', '256x0', '256x256', '0x256'])
        self.assertEqual(project['filament_settings_id'], ['Bambu PLA Basic @BBL P1S 0.4 nozzle'] * 3)
        self.assertEqual(project['filament_type'], ['PLA'] * 3)
        self.assertEqual(len(project['flush_volumes_matrix']), 9)
        self.assertEqual(names, sorted([MODEL, SETTINGS, PROJECT, '[Content_Types].xml', '_rels/.rels']))
        self.assertIn(f'PartName="/{PROJECT}"', types)
        self.assertIn(f'Target="/{MODEL}"', rels)

    def test_bed_presets_change_layout_and_starting_profiles(self):
        part = [('Terrain', *box(0, 0, 0, 100, 100, 2), [0] * 12, ['#5C6161'])]
        model, config, project, *_ = self.write(
            'A1M', [('Section R1 C1', part, (0, 0, 100, 100)), ('Section R1 C2', part, (100, 0, 200, 100))])
        transforms = [[float(v) for v in i.get('transform').split()][9:] for i in model.findall('m:build/m:item', NS)]
        self.assertEqual(transforms, [[90 - 50, 90 - 50, 0], [216 + 90 - 150, 90 - 50, 0]])
        self.assertEqual(project['printable_area'], ['0x0', '180x0', '180x180', '0x180'])
        self.assertEqual(project['printable_height'], '180')
        self.assertEqual(project['printer_model'], 'Bambu Lab A1 mini')
        self.assertEqual(project['print_settings_id'], '0.20mm Standard @BBL A1M')
        self.assertEqual(project['filament_settings_id'], ['Bambu PLA Basic @BBL A1M'])
        model, config, project, *_ = self.write('H2D', [('Map', part, None)])
        self.assertEqual(project['printable_area'], ['0x0', '350x0', '350x320', '0x320'])
        self.assertEqual([float(v) for v in model.find('m:build/m:item', NS).get('transform').split()][9:],
                         [175 - 50, 160 - 50, 0])
        self.assertTrue(part_name_map)

    def test_filament_lines_select_matching_presets(self):
        vertices, triangles = box(0, 0, 0, 10, 10, 1)
        parts = [('Terrain', vertices, triangles, [0] * 12, [('#FFFFFF', 'PLA Matte')]),
                 ('Buildings', vertices, triangles, [0] * 12, [('#AE835B', 'PLA Matte')]),
                 ('Roads', vertices, triangles, [0] * 12, ['#545454']),
                 # The same colour in another line is another filament.
                 ('Paths', vertices, triangles, [0] * 12, [('#FFFFFF', 'PLA Basic')])]
        _model, config, project, *_ = self.write('P1S', [('Map', parts, None)])
        self.assertEqual(project['filament_colour'], ['#FFFFFF', '#AE835B', '#545454', '#FFFFFF'])
        self.assertEqual(project['filament_settings_id'], [
            'Bambu PLA Matte @BBL P1S 0.4 nozzle', 'Bambu PLA Matte @BBL P1S 0.4 nozzle',
            'Bambu PLA Basic @BBL P1S 0.4 nozzle', 'Bambu PLA Basic @BBL P1S 0.4 nozzle'])
        self.assertEqual(project['filament_ids'], ['GFA01', 'GFA01', 'GFA00', 'GFA00'])
        self.assertEqual(project['filament_type'], ['PLA'] * 4)
        self.assertEqual([p.find("metadata[@key='extruder']").get('value') for p in config.findall('object/part')],
                         ['1', '2', '3', '4'])
        _model, _config, project, *_ = self.write('A1M', [('Map', parts[:1], None)])
        self.assertEqual(project['filament_settings_id'], ['Bambu PLA Matte @BBL A1M'])
        with tempfile.TemporaryDirectory() as folder:
            with PlateWriter(Path(folder) / 'model.xml', PRINTERS['P1S']) as writer:
                with self.assertRaises(ValueError):
                    writer.add_plate('Map', [('Terrain', vertices, triangles, [0] * 12, [('#FFFFFF', 'PLA Silk')])])

    def test_rejects_invalid_parts_and_leaves_no_project(self):
        vertices, triangles = box(0, 0, 0, 1, 1, 1)
        good = ('Terrain', vertices, triangles, [0] * 12, ['#5C6161'])
        bad_parts = [
            ('Terrain', vertices[:-1] + [(0, 0, float('nan'))], triangles, [0] * 12, ['#5C6161']),
            ('Terrain', vertices, triangles, [0] * 11 + [1], ['#5C6161']),
            ('Terrain', vertices, triangles, [0] * 11, ['#5C6161']),
            ('Terrain', vertices, [], [], ['#5C6161']),
            ('Terrain', vertices, triangles + [(0, 1, 8)], [0] * 13, ['#5C6161']),
            ('Terrain', vertices, triangles, [0] * 12, ['#fff']),
            ('Terrain', vertices, triangles, [0] * 12, []),
        ]
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / 'project.3mf'
            for part in bad_parts:
                with self.subTest(part=part[1:] if part[1] is not vertices else part[2:]):
                    with PlateWriter(Path(folder) / 'model.xml', PRINTERS['P1S']) as writer:
                        with self.assertRaises(ValueError):
                            writer.add_plate('Map', [part])
            with PlateWriter(Path(folder) / 'model.xml', PRINTERS['P1S']) as writer:
                with self.assertRaises(ValueError):
                    writer.add_plate('Map', [])
                with self.assertRaises(ValueError):
                    writer.close(output)
                for index in range(36):
                    writer.add_plate(f'Section R1 C{index + 1}', [good])
                with self.assertRaises(ValueError):
                    writer.add_plate('Section R1 C37', [good])
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
