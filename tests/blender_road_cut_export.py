"""Roads cut from land cover at export, after they are edited in Blender.

Run: blender --background --factory-startup --python-exit-code 1
             --python tests/blender_road_cut_export.py
"""

from collections import Counter
from contextlib import contextmanager
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
import zipfile

import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import jarvizar_city_model as addon
from jarvizar_city_model.blender import collections, export_cutout
from jarvizar_city_model.blender.mesh_utils import MeshBuilder
from jarvizar_city_model.data.cache import ALL_TYPES, Bounds, CacheBundle
from jarvizar_city_model.data.export_3mf import MODEL, NS
from jarvizar_city_model.geometry.surface_priority import ROAD_CUT_AT_EXPORT_KEY, _top_triangles
from blender_smoke import linestring, polygon, write_collection, write_synthetic_dem


def ring(x, y, size):
    return [[x, y], [x+size, y], [x+size, y+size], [x, y+size], [x, y]]


def world_tops(obj):
    matrix = obj.matrix_world
    return [[tuple(matrix @ Vector(p)) for p in triangle] for triangle in _top_triangles(obj.data)]


def slab_tree(slabs):
    vertices, faces = [], []
    for triangles in slabs:
        for triangle in triangles:
            faces.append(tuple(range(len(vertices), len(vertices)+3)))
            vertices.extend(triangle)
    return BVHTree.FromPolygons(vertices, faces, all_triangles=True)


def covered(tree, x, y):
    return tree.ray_cast(Vector((x, y, 1000)), Vector((0, 0, -1)))[0] is not None


def bounds(obj):
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    return (min(p.x for p in points), min(p.y for p in points),
            max(p.x for p in points), max(p.y for p in points))


class RoadCutAtExportTests(unittest.TestCase):
    def setUp(self):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        self.temp = tempfile.TemporaryDirectory(prefix="jcm_road_export_")
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        settings = self.settings = bpy.context.scene.jarvizar_city_model
        box = Bounds(-84.51, 39.09, -84.50, 39.10)
        settings.west, settings.south, settings.east, settings.north = map(str, box.as_tuple())
        settings.cache_directory = str(self.folder / "cache")
        settings.terrain_source = "DEM"
        settings.terrain_resolution = 16
        settings.generate_trees = False
        settings.generate_buildings = False
        bundle = CacheBundle(Path(settings.cache_directory), box)
        bundle.ensure_directory()
        for kind in ALL_TYPES:
            write_collection(bundle.data_path(kind), [])
        write_collection(bundle.data_path("land_use"), [
            polygon("park", [ring(-84.509, 39.091, .008)], subtype="park")])
        # A street east-west and a footway north-south, crossing in the park.
        write_collection(bundle.data_path("segment"), [
            linestring("street", [[-84.51, 39.095], [-84.50, 39.095]], subtype="road", **{"class": "residential"}),
            linestring("path", [[-84.505, 39.09], [-84.505, 39.10]], subtype="road", **{"class": "footway"})])
        write_synthetic_dem(bundle, columns=16, rows=16)
        bundle.write_manifest({"release": "road-cut-export-fixture"})
        self.captured = []
        original = export_cutout.export_geometry

        @contextmanager
        def recording(context, sources):
            with original(context, sources) as (parts, stats, opening):
                self.captured = [(dict(part.items()), world_tops(part)) for part in parts]
                yield parts, stats, opening

        patcher = patch.object(export_cutout, "export_geometry", recording)
        patcher.start()
        self.addCleanup(patcher.stop)

    def generate(self, at_export):
        self.settings.cut_roads_at_export = at_export
        self.assertEqual(bpy.ops.jarvizar.generate_model(), {"FINISHED"}, self.settings.last_status)
        objects = collections.generated_objects(bpy.context.scene)
        slabs = [o for o in objects if o.get("feature_type") == "land_surface"]
        roads = {o["road_class"]: o for o in objects if o.get("feature_type") == "surface_road"}
        self.assertTrue(slabs)
        self.assertEqual(set(roads), {"residential", "footway"})
        return slabs, roads

    def export(self, name):
        path = self.folder / name
        self.assertEqual(bpy.ops.jarvizar.export_3mf(filepath=str(path)), {"FINISHED"}, self.settings.last_status)
        with zipfile.ZipFile(path) as archive:
            model = archive.read(MODEL)
        slabs = [tops for items, tops in self.captured if items.get("feature_type") == "land_surface"]
        return model, slab_tree(slabs), sum(abs(area(t)) for tops in slabs for t in tops)

    def scene_state(self):
        return ({(o.as_pointer(), o.name) for o in bpy.data.objects},
                {(m.as_pointer(), m.name) for m in bpy.data.meshes},
                [[v.co[:] for v in o.data.vertices] for o in collections.generated_objects(bpy.context.scene)])

    def test_edited_roads_are_cut_at_export(self):
        slabs, _roads = self.generate(at_export=False)
        self.assertFalse(any(slab.get(ROAD_CUT_AT_EXPORT_KEY) for slab in slabs))
        self.assertTrue(any(slab.get("road_cut_area_mm2") for slab in slabs))
        cut_model, _tree, cut_area = self.export("cut_at_generation.3mf")

        slabs, roads = self.generate(at_export=True)
        self.assertTrue(all(slab.get(ROAD_CUT_AT_EXPORT_KEY) for slab in slabs))
        whole = slab_tree([world_tops(slab) for slab in slabs])
        street, path = bounds(roads["residential"]), bounds(roads["footway"])
        street_y, path_x = (street[1]+street[3]) / 2, (path[0]+path[2]) / 2
        # Whole in Blender: the slab lies under both roads.
        self.assertTrue(covered(whole, path_x - 10, street_y))
        self.assertTrue(covered(whole, path_x, street_y - 10))

        before = self.scene_state()
        model, tree, area_ = self.export("cut_at_export.3mf")
        self.assertEqual(self.scene_state(), before, "Export changed or leaked scene data")
        self.assertAlmostEqual(area_, cut_area, places=3)
        self.assertEqual(triangle_sets(model), triangle_sets(cut_model),
                         "Unedited export differs from cutting at generation")
        self.assertFalse(covered(tree, path_x - 10, street_y))
        self.assertFalse(covered(tree, path_x, street_y - 10))
        self.assertTrue(covered(tree, path_x - 10, street_y - 10))

        # Delete the footway and move the street 3 mm north as an object.
        bpy.data.objects.remove(roads["footway"], do_unlink=True)
        roads["residential"].matrix_world = Matrix.Translation((0, 3, 0))
        _model, tree, edited_area = self.export("edited.3mf")
        self.assertGreater(edited_area, area_)
        self.assertTrue(covered(tree, path_x, street_y - 10), "Deleted path left a hole")
        self.assertTrue(covered(tree, path_x - 10, street_y), "Moved street left a hole")
        self.assertFalse(covered(tree, path_x - 10, street_y + 3), "Moved street not cut")

    def test_crop_fully_covered_slab_and_failure_cleanup(self):
        slabs, roads = self.generate(at_export=True)
        street = bounds(roads["residential"])
        street_y = (street[1]+street[3]) / 2
        # A patch wholly under the street is deleted by the cut.
        builder = MeshBuilder("covered patch")
        self.assertTrue(builder.add_flat_prism([(-1, street_y-.1), (1, street_y-.1), (1, street_y+.1), (-1, street_y+.1)],
                                               -.15, .4))
        patch_obj = builder.build(slabs[0].users_collection[0])
        for key, value in slabs[0].items():
            patch_obj[key] = value
        # A frame whose opening crosses every slab, so they are cropped too.
        frame = MeshBuilder("cutout")
        self.assertTrue(frame.add_flat_prism([(-60, -60), (60, -60), (60, 60), (-60, 60)], -5, -4,
                                             holes=[[(-15, -15), (-15, 15), (15, 15), (15, -15)]]))
        frame.build(bpy.context.scene.collection)
        before = self.scene_state()
        _model, tree, _area = self.export("cropped.3mf")
        self.assertEqual(self.scene_state(), before)
        self.assertEqual(sum(items.get("feature_type") == "land_surface" for items, _tops in self.captured), len(slabs))
        self.assertFalse(covered(tree, 5, street_y))
        self.assertTrue(covered(tree, 5, street_y - 5))
        self.assertFalse(covered(tree, 20, street_y - 5), "Crop was not applied")

        original = export_cutout.cut_roads_at_export

        def failing(*args, **kwargs):
            original(*args, **kwargs)
            raise RuntimeError("injected after the road cut")

        with patch.object(export_cutout, "cut_roads_at_export", failing), \
                self.assertRaisesRegex(RuntimeError, "injected after the road cut"):
            bpy.ops.jarvizar.export_3mf(filepath=str(self.folder / "failed.3mf"))
        self.assertEqual(self.scene_state(), before)
        # Failing later, with the cut copies linked for the crop.
        with patch.object(export_cutout, "clip_mesh", side_effect=export_cutout.CutoutError("injected crop")), \
                self.assertRaisesRegex(RuntimeError, "injected crop"):
            bpy.ops.jarvizar.export_3mf(filepath=str(self.folder / "failed.3mf"))
        self.assertEqual(self.scene_state(), before)
        self.assertFalse((self.folder / "failed.3mf").exists())


def triangle_sets(model):
    """Each part's oriented triangles by coordinates and paint; vertex order aside."""
    result = {}
    for obj in ET.fromstring(model).findall("m:resources/m:object", NS):
        mesh = obj.find("m:mesh", NS)
        if mesh is None:
            continue
        vertices = [tuple(v.get(k) for k in "xyz") for v in mesh.findall("m:vertices/m:vertex", NS)]
        triangles = Counter()
        for t in mesh.findall("m:triangles/m:triangle", NS):
            a, b, c = (vertices[int(t.get(k))] for k in ("v1", "v2", "v3"))
            triangles[min((a, b, c), (b, c, a), (c, a, b)), t.get("paint_color")] += 1
        result[obj.get("name")] = triangles
    return result


def area(triangle):
    (ax, ay, _), (bx, by, _), (cx, cy, _) = triangle
    return ((bx-ax)*(cy-ay) - (cx-ax)*(by-ay)) / 2


if __name__ == "__main__":
    addon.register()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(RoadCutAtExportTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    addon.unregister()
    if not result.wasSuccessful():
        raise SystemExit(1)
    print("JARVIZAR_ROAD_CUT_EXPORT_OK")
