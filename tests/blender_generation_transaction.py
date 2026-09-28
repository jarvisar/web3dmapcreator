"""Offline transaction regressions. Run with Blender --background --factory-startup."""

from array import array
import hashlib
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import bpy

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import jarvizar_city_model as addon
from jarvizar_city_model import operators
from jarvizar_city_model.blender import collections, generation, materials
from jarvizar_city_model.data.cache import ALL_TYPES, Bounds, CacheBundle
from blender_smoke import polygon, linestring, point, write_collection, write_synthetic_dem

# Material.use_nodes is deprecated in Blender 5, where every material uses nodes.
USE_NODES = bpy.app.version < (5, 0, 0)


def geometry_digest(objects):
    result = []
    for obj in sorted(objects, key=lambda item: item.name):
        mesh = obj.data
        digest = hashlib.sha256()
        for items, key, width, kind in ((mesh.vertices, "co", 3, "f"),
                                       (mesh.loops, "vertex_index", 1, "i"),
                                       (mesh.polygons, "loop_total", 1, "i"),
                                       (mesh.polygons, "material_index", 1, "i")):
            values = array(kind, [0]) * (len(items) * width)
            items.foreach_get(key, values)
            digest.update(values.tobytes())
        result.append((obj.name, digest.hexdigest(), [list(row) for row in obj.matrix_world],
                       [mat.name if mat else None for mat in mesh.materials]))
    return result


def scene_snapshot():
    """Include identities, links, mesh edits, palette/node state, and UI state."""
    scene = bpy.context.scene
    data = {kind: {(item.as_pointer(), item.name) for item in getattr(bpy.data, kind)}
            for kind in generation.GenerationTransaction._DATA}
    data["auxiliary_ids"] = {kind: {(item.as_pointer(), item.name) for item in getattr(bpy.data, kind)}
                             for kind in ("libraries", "node_groups", "images")}
    data["geometry"] = geometry_digest([obj for obj in bpy.data.objects if obj.type == "MESH"])
    data["objects"] = [(obj.as_pointer(), obj.name, obj.data.as_pointer() if obj.data else None,
                        sorted(c.as_pointer() for c in obj.users_collection),
                        obj.select_get(), obj.hide_get(), repr(dict(obj.items())))
                       for obj in bpy.data.objects]
    data["collections_state"] = [(c.as_pointer(), sorted(child.as_pointer() for child in c.children),
                                  repr(dict(c.items()))) for c in bpy.data.collections]
    data["scene_links"] = sorted(c.as_pointer() for c in scene.collection.children)
    data["palette"] = [(m.as_pointer(), m.name, tuple(m.diffuse_color), m.roughness,
                        m.use_nodes if USE_NODES else None, repr(dict(m.items())),
                        [(n.name, n.type, [(s.name, repr(s.default_value[:]) if hasattr(s.default_value, "__len__")
                                          else repr(s.default_value)) for s in n.inputs
                                         if hasattr(s, "default_value")])
                         for n in m.node_tree.nodes] if m.node_tree else None)
                       for m in bpy.data.materials]
    data["units"] = tuple(getattr(scene.unit_settings, key)
                          for key in ("system", "scale_length", "length_unit"))
    data["lidar_status"] = scene.jarvizar_city_model.lidar_generation_status
    data["active"] = bpy.context.view_layer.objects.active
    data["active_collection"] = bpy.context.view_layer.active_layer_collection.collection
    return data


class TransactionTests(unittest.TestCase):
    def setUp(self):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        self.temp = tempfile.TemporaryDirectory(prefix="jcm_transaction_", dir=ROOT)
        self.addCleanup(self.temp.cleanup)
        self.settings = bpy.context.scene.jarvizar_city_model
        settings = self.settings
        bounds = Bounds(-84.51, 39.09, -84.50, 39.10)
        settings.west, settings.south, settings.east, settings.north = map(str, bounds.as_tuple())
        settings.cache_directory = self.temp.name
        settings.terrain_source = "DEM"
        settings.terrain_resolution = 16
        settings.generate_border_rim = True
        settings.use_lidar_buildings = True  # Exercise missing optional data fallback.
        settings.generate_trees = True  # Off by default; the tree phase is tested here.
        settings.maximum_trees = 4
        settings.cut_roads_at_export = False  # Cut roads during generation, as a phase.
        self.bundle = CacheBundle(Path(self.temp.name), bounds)
        self.bundle.ensure_directory()
        for kind in ALL_TYPES:
            write_collection(self.bundle.data_path(kind), [])

        def ring(x, y, size=.001):
            return [[x,y], [x+size,y], [x+size,y+size], [x,y+size], [x,y]]

        write_collection(self.bundle.data_path("building"), [
            polygon("building", [ring(-84.508, 39.092)], height=12)])
        write_collection(self.bundle.data_path("water"), [
            polygon("river", [ring(-84.503, 39.096)], subtype="river"),
            polygon("pond", [ring(-84.509, 39.098, .0004)], subtype="pond")])
        write_collection(self.bundle.data_path("land_use"), [
            polygon("park", [ring(-84.509, 39.091, .004)], subtype="park")])
        write_collection(self.bundle.data_path("land"), [point("tree", [-84.508,39.094], subtype="tree")])
        write_collection(self.bundle.data_path("segment"), [
            linestring("road", [[-84.509,39.093],[-84.501,39.093]], subtype="road", **{"class":"residential"})])
        write_synthetic_dem(self.bundle, columns=16, rows=16)
        self.bundle.write_manifest({"release": "transaction-fixture"})
        self.driver = SimpleNamespace(report=Mock())
        self.context = SimpleNamespace(scene=bpy.context.scene, view_layer=bpy.context.view_layer,
                                       selected_objects=bpy.context.selected_objects, window_manager=Mock())

    def run_generation(self):
        self.context.selected_objects = bpy.context.selected_objects
        return operators.JARVIZAR_OT_generate_model.execute(self.driver, self.context)

    def previous_model(self):
        self.assertEqual(self.run_generation(), {"FINISHED"})
        root = collections.generated_roots(bpy.context.scene)[0]
        # A manually edited model and metadata must survive failure exactly.
        root["manual_note"] = "keep this until success"
        terrain = next(obj for obj in root.all_objects if obj.get("feature_type") == "terrain")
        terrain.data.vertices[0].co.z -= .25
        helper = bpy.data.objects.new("user helper", terrain.data)
        bpy.context.scene.collection.objects.link(helper)
        nested = bpy.data.objects.new("nested helper", None)
        root.children[0].objects.link(nested)
        child = bpy.data.collections.new("user collection")
        root.children.link(child)
        child.objects.link(bpy.data.objects.new("child helper", None))
        # An unrelated tagged orphan must never be swept by transaction cleanup.
        orphan = bpy.data.meshes.new("unrelated orphan")
        orphan[collections.GENERATED_KEY] = True
        material = bpy.data.materials["JCM_Terrain"]
        material.diffuse_color = (.7, .1, .2, 1)
        material.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (.2,.3,.4,1)
        material.node_tree.nodes.new("ShaderNodeValue").outputs[0].default_value = .37
        if USE_NODES:
            material.use_nodes = False
        material["user_note"] = "preserve custom nodes"
        self.settings.lidar_generation_status = "previous LiDAR result"
        units = bpy.context.scene.unit_settings
        units.system, units.scale_length, units.length_unit = "IMPERIAL", .0254, "INCHES"
        helper.select_set(True)
        terrain.select_set(True)
        bpy.context.view_layer.objects.active = terrain
        bpy.context.view_layer.active_layer_collection = bpy.context.view_layer.layer_collection.children[root.name]
        return root, helper, nested, child

    def assert_failed_unchanged(self, before):
        self.assertEqual(self.run_generation(), {"CANCELLED"})
        self.assertEqual(scene_snapshot(), before)
        self.assertTrue(self.settings.last_status.startswith("Generation failed:"))
        self.context.window_manager.progress_end.assert_called()

    def test_failures_after_each_phase_and_retry(self):
        phases = [
            (operators.ModelHeightField, "build"), (collections, "_new_child"),
            (materials, "get_or_create_material"),
            *[(operators, name) for name in (
                "solve_water_bodies", "flatten_terrain_under_water", "cut_water_from_terrain",
                "generate_terrain_solid", "recess_terrain_basins", "generate_border_rim",
                "generate_land_surfaces", "cut_water_land_surfaces", "generate_water",
                "generate_roads", "cut_road_footprints", "generate_trees", "load_measurements",
                "generate_buildings")],
            (operators.SupportBuilder, "build"), (generation.GenerationTransaction, "validate"),
            (generation, "preserve_user_links"),
        ]
        self.previous_model()
        for owner, name in phases:
            with self.subTest(phase=name):
                before = scene_snapshot()
                original = getattr(owner, name)

                def fail_after(*args, **kwargs):
                    original(*args, **kwargs)
                    raise RuntimeError("injected after " + name)

                with patch.object(owner, name, fail_after):
                    self.assert_failed_unchanged(before)
                # A retry has to succeed without a global cleanup or undo.
                self.assertEqual(self.run_generation(), {"FINISHED"})
                self.assertEqual(len(collections.generated_roots(bpy.context.scene)), 1)
                self.assertFalse(any(c.get(collections.STAGING_KEY) for c in bpy.data.collections))

    def test_commit_failure_restores_material_users_units_and_selection(self):
        self.previous_model()
        before = scene_snapshot()
        original = bpy.data.batch_remove
        calls = 0

        def fail_publication(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("injected before destructive publication")
            return original(*args, **kwargs)

        proxy = SimpleNamespace(data=SimpleNamespace(
            **{key: getattr(bpy.data, key) for key in generation.GenerationTransaction._DATA},
            batch_remove=fail_publication))
        with patch.object(generation, "bpy", proxy):
            self.assert_failed_unchanged(before)
        self.assertEqual(self.run_generation(), {"FINISHED"})

    def test_first_generation_failure_cleans_untagged_unlinked_allocations(self):
        before = scene_snapshot()

        def broken_builder(*args, **kwargs):
            mesh = bpy.data.meshes.new("unfinished mesh")
            bpy.data.objects.new("unfinished object", mesh)
            bpy.data.materials.new("unfinished material")
            raise RuntimeError("failed before linking/tagging")

        with patch.object(operators, "generate_terrain_solid", broken_builder):
            self.assert_failed_unchanged(before)
        self.assertEqual(self.run_generation(), {"FINISHED"})

    def test_validation_rejects_nonfinite_geometry(self):
        self.previous_model()
        before = scene_snapshot()
        original = operators.generate_buildings

        def corrupt(*args, **kwargs):
            counts = original(*args, **kwargs)
            kwargs["building_collection"].objects[0].data.vertices[0].co.x = float("nan")
            return counts

        with patch.object(operators, "generate_buildings", corrupt):
            self.assert_failed_unchanged(before)

    def test_success_preserves_helpers_and_shared_meshes(self):
        root, helper, nested, child = self.previous_model()
        old_pointer = root.as_pointer()
        shared = helper.data
        shared_coords = [v.co[:] for v in shared.vertices]
        bpy.context.view_layer.objects.active = helper
        self.assertEqual(self.run_generation(), {"FINISHED"})
        self.assertNotEqual(collections.generated_roots(bpy.context.scene)[0].as_pointer(), old_pointer)
        self.assertEqual(helper.data, shared)
        self.assertEqual([v.co[:] for v in shared.vertices], shared_coords)
        self.assertIn(nested.name, bpy.context.scene.objects)
        self.assertIn(child.name, bpy.context.scene.collection.children)
        self.assertEqual(bpy.context.view_layer.objects.active, helper)
        self.assertTrue(helper.select_get())
        terrain_material = bpy.data.materials["JCM_Terrain"]
        self.assertEqual(shared.materials[0], terrain_material)
        self.assertEqual(terrain_material["user_note"], "preserve custom nodes")
        self.assertAlmostEqual(terrain_material.node_tree.nodes["Value"].outputs[0].default_value, .37)
        if USE_NODES:
            self.assertTrue(terrain_material.use_nodes)
        self.assertAlmostEqual(terrain_material.diffuse_color[0], materials.PALETTE["terrain"][0])
        self.assertGreater(collections.clear_generated(bpy.context.scene), 0)
        self.assertIn(helper.name, bpy.context.scene.objects)
        self.assertIn(nested.name, bpy.context.scene.objects)
        self.assertEqual(helper.data, shared)

    def test_name_collisions_other_scene_and_staging_are_not_published(self):
        user_root = bpy.data.collections.new("CITY_MODEL")
        bpy.context.scene.collection.children.link(user_root)
        other_scene = bpy.data.scenes.new("other scene")
        other_root = collections.create_city_hierarchy(other_scene)["root"]
        for _ in range(2):
            self.assertEqual(self.run_generation(), {"FINISHED"})
            self.assertEqual(len(collections.generated_roots(bpy.context.scene)), 1)
            self.assertIn(user_root.name, bpy.context.scene.collection.children)
            self.assertIn(other_root.name, other_scene.collection.children)
        previous = set(collections.generated_objects(bpy.context.scene))
        transaction = generation.GenerationTransaction(bpy.context)
        transaction.begin()
        self.assertEqual(set(collections.generated_objects(bpy.context.scene)), previous)
        transaction.rollback()
        self.assertGreater(collections.clear_generated(bpy.context.scene), 0)
        self.assertIn(user_root.name, bpy.data.collections)
        self.assertIn(other_root.name, bpy.data.collections)

    def test_successful_rebuild_has_identical_geometry(self):
        for merged in (False, True):
            self.settings.merge_buildings_and_trees = merged
            self.assertEqual(self.run_generation(), {"FINISHED"})
            expected = geometry_digest(collections.generated_objects(bpy.context.scene))
            counts = collections.generated_roots(bpy.context.scene)[0]["generation_counts_json"]
            self.assertEqual(self.run_generation(), {"FINISHED"})
            self.assertEqual(geometry_digest(collections.generated_objects(bpy.context.scene)), expected)
            self.assertEqual(collections.generated_roots(bpy.context.scene)[0]["generation_counts_json"], counts)

    def test_reused_tree_mesh_and_context_changes_are_isolated(self):
        self.settings.merge_buildings_and_trees = False
        self.previous_model()
        tree = next(obj for obj in collections.generated_objects(bpy.context.scene) if obj.name.startswith("TREE_"))
        tree.data.vertices[0].co.x += .2
        helper = bpy.data.objects.new("saved tree", tree.data)
        bpy.context.scene.collection.objects.link(helper)
        bpy.context.view_layer.update()
        before = scene_snapshot()
        original = operators.generate_trees

        def fail_with_context_changes(*args, **kwargs):
            original(*args, **kwargs)
            for obj in bpy.context.view_layer.objects:
                obj.select_set(False)
            bpy.context.view_layer.objects.active = helper
            bpy.context.view_layer.active_layer_collection = bpy.context.view_layer.layer_collection
            bpy.context.scene.unit_settings.scale_length = 1
            self.settings.lidar_generation_status = "partial result"
            raise RuntimeError("injected context changes")

        with patch.object(operators, "generate_trees", fail_with_context_changes):
            self.assert_failed_unchanged(before)
        saved = helper.data
        coordinates = [v.co[:] for v in saved.vertices]
        self.assertEqual(self.run_generation(), {"FINISHED"})
        self.assertEqual(helper.data, saved)
        self.assertEqual([v.co[:] for v in saved.vertices], coordinates)
        new_tree = next(obj for obj in collections.generated_objects(bpy.context.scene) if obj.name.startswith("TREE_"))
        self.assertNotEqual(new_tree.data, saved)


if __name__ == "__main__":
    addon.register()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(TransactionTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    addon.unregister()
    if not result.wasSuccessful():
        raise SystemExit(1)
    print("JARVIZAR_GENERATION_TRANSACTION_OK")
