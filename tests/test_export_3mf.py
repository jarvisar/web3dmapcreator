"""Archive contract tests, independent of Blender and the external writer."""
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import xml.etree.ElementTree as ET
import zipfile

from jarvizar_city_model.data.export_3mf import CORE, MATERIALS, MODEL, NS, SETTINGS, name_3mf, semantic_part_name


class Object(dict):
    name = 'User mesh & café'
    users_collection = ()
    material_slots = ()


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

    def archive(self, path):
        # IDs, resource order, component order, and the name-map order differ.
        root = ET.Element(f'{{{CORE}}}model', unit='millimeter')
        ET.SubElement(root, f'{{{CORE}}}metadata', name='Application').text = 'Blender'
        resources = ET.SubElement(root, f'{{{CORE}}}resources')
        mats = ET.SubElement(resources, f'{{{CORE}}}basematerials', id='9')
        ET.SubElement(mats, f'{{{CORE}}}base', name='White', displaycolor='#FFFFFF')
        ET.SubElement(mats, f'{{{CORE}}}base', name='Black', displaycolor='#000000')
        for object_id, title in [('42', 'copy B'), ('7', 'copy A')]:
            obj = ET.SubElement(resources, f'{{{CORE}}}object', id=object_id, pid='9', pindex='0')
            mesh = ET.SubElement(obj, f'{{{CORE}}}mesh')
            vertices = ET.SubElement(mesh, f'{{{CORE}}}vertices')
            for x, y, z in [('0', '0', '0'), ('1', '0', '0'), ('0', '1', '0')]:
                ET.SubElement(vertices, f'{{{CORE}}}vertex', x=x, y=y, z=z)
            triangles = ET.SubElement(mesh, f'{{{CORE}}}triangles')
            ET.SubElement(triangles, f'{{{CORE}}}triangle', v1='0', v2='1', v3='2', pid='9', p1='1')
            group = ET.SubElement(obj, f'{{{CORE}}}metadatagroup')
            ET.SubElement(group, f'{{{CORE}}}metadata', name='Title').text = title
        assembly = ET.SubElement(resources, f'{{{CORE}}}object', id='21')
        components = ET.SubElement(assembly, f'{{{CORE}}}components')
        for object_id in ['7', '42']:
            ET.SubElement(components, f'{{{CORE}}}component', objectid=object_id,
                          transform='0 1 0 -1 0 0 0 0 1 17 23 4')
        build = ET.SubElement(root, f'{{{CORE}}}build')
        ET.SubElement(build, f'{{{CORE}}}item', objectid='21', transform='1 0 0 0 1 0 0 0 1 2 3 0')
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr(MODEL, ET.tostring(root))
            archive.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
            archive.writestr('_rels/.rels', b'unchanged relationships')
            archive.writestr('Metadata/thumbnail.png', b'unchanged thumbnail')
        return root

    def test_resource_ids_names_and_preserved_geometry_materials_transforms(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder)/'raw.3mf', Path(folder)/'named.3mf'
            before = self.archive(source)
            name_3mf(source, output, {'copy B': 'Labels & café "West"', 'copy A': 'Terrain'})
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(len(archive.namelist()), len(set(archive.namelist())))
                self.assertEqual(archive.read('Metadata/thumbnail.png'), b'unchanged thumbnail')
                self.assertEqual(archive.read('_rels/.rels'), b'unchanged relationships')
                root = ET.fromstring(archive.read(MODEL))
                config = ET.fromstring(archive.read(SETTINGS))
            self.assertEqual(config.find('object').get('id'), '21')
            self.assertEqual(config.find('object/metadata').attrib, {'key': 'name', 'value': 'Map'})
            parts = config.findall('object/part')
            self.assertEqual([(p.get('id'), p.get('subtype'), p.find('metadata').get('value')) for p in parts],
                             [('7', 'normal_part', 'Terrain'), ('42', 'normal_part', 'Labels & café "West"')])
            for part in parts:
                obj = root.find(f"m:resources/m:object[@id='{part.get('id')}']", NS)
                self.assertEqual(obj.get('name'), part.find('metadata').get('value'))
            resources = root.find('m:resources', NS)
            groups = resources.findall(f'{{{MATERIALS}}}colorgroup')
            self.assertEqual(len(groups), 1)
            palette = [c.get('color') for c in groups[0]]
            self.assertEqual(palette, ['#FFFFFF', '#000000'])
            self.assertIn(b'<m:colorgroup', ET.tostring(root))
            for obj in root.findall('m:resources/m:object', NS):
                if obj.find('m:mesh', NS) is None:
                    continue
                self.assertEqual(obj.get('pid'), groups[0].get('id'))
                self.assertEqual(palette[int(obj.get('pindex'))], '#FFFFFF')
                triangle = obj.find('.//m:triangle', NS)
                self.assertEqual(triangle.get('pid'), groups[0].get('id'))
                self.assertEqual(palette[int(triangle.get('p1'))], '#000000')
            # Undo only the intended property-resource retargeting.
            for element in root.iter():
                if element.get('pid') == groups[0].get('id'):
                    element.set('pid', '9')
            resources.remove(groups[0])
            # Removing exactly the intended name edits restores the entire model.
            for old, new in zip(before.findall('m:resources/m:object', NS), root.findall('m:resources/m:object', NS)):
                new.attrib.pop('name')
                old_title = old.find("m:metadatagroup/m:metadata[@name='Title']", NS)
                if old_title is not None:
                    new.find("m:metadatagroup/m:metadata[@name='Title']", NS).text = old_title.text
            self.assertEqual(ET.tostring(before), ET.tostring(root))

    def test_missing_identity_fails_without_writing_destination(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder)/'raw.3mf', Path(folder)/'named.3mf'
            self.archive(source)
            with self.assertRaisesRegex(ValueError, 'source semantic name'):
                name_3mf(source, output, {'wrong': 'Terrain'})
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
