"""Synchronous generation transaction; all Blender work stays on the main thread."""

from array import array
from math import isfinite

import bpy

from .collections import (
    GENERATED_KEY, ROOT_COLLECTION_NAME, STAGING_KEY, STAGING_ROOT_NAME, ROLE_KEY, _walk_collections,
    create_city_hierarchy, generated_roots, hierarchy_data, preserve_user_links, removable_meshes,
)
from ..data.palette import role_palette, settings_palette
from .materials import MATERIAL_ROLE_KEY, _material_name, model_materials


# Previous output keeps its data under these names until the final removal.
_PREVIOUS_PREFIX = "_JCM_PREVIOUS_"


class GenerationTransaction:
    """Retain published output until its replacement is ready to publish.

    The ID snapshots delimit allocations made by this synchronous operation,
    including unlinked/untagged meshes left by a failed builder. Cleanup uses
    these references, never global generated tags or staging name patterns.
    Imported worker results seal that allocation scope before returning to the
    event loop. Subsequent cleanup uses only the explicitly captured IDs.
    """

    _DATA = ("objects", "meshes", "collections", "materials", "libraries")

    def __init__(self, context):
        context.view_layer.update()
        self.context = context
        self.scene = context.scene
        self.settings = self.scene.jarvizar_city_model
        self.before = {key: set(getattr(bpy.data, key)) for key in self._DATA}
        self.roots = generated_roots(self.scene)
        self.previous_objects, self.previous_meshes, self.previous_collections = hierarchy_data(self.roots)
        self.selected = [obj for obj in context.view_layer.objects if obj.select_get()]
        self.active = context.view_layer.objects.active
        self.active_collection = context.view_layer.active_layer_collection.collection
        self.units = tuple(getattr(self.scene.unit_settings, key)
                           for key in ("system", "scale_length", "length_unit"))
        self.status = self.settings.last_status, self.settings.lidar_generation_status
        self.renamed = []
        self.remapped = []
        self.links = []
        self.hierarchy = None
        self.materials = None
        self.committed = False
        self.rolled_back = False
        self.owned = None

    def _rename(self, datablock, name):
        self.renamed.append((datablock, datablock.name))
        datablock.name = name

    def _reserve_names(self):
        # Reserve the usual generator names without copying the previous meshes.
        # The published root keeps its name; every other rename is reversible.
        reserved = (self.previous_objects | self.previous_collections
                    | removable_meshes(self.previous_objects, self.previous_meshes)) - set(self.roots)
        for datablock in sorted(reserved, key=lambda item: item.name):
            self._rename(datablock, _PREVIOUS_PREFIX + datablock.name)

    def _materials(self):
        # The scene palette's colours, read when the materials are staged.
        return model_materials(staging=True, palette=role_palette(settings_palette(self.settings.palette)))

    def begin(self):
        self._reserve_names()
        self.hierarchy = create_city_hierarchy(self.scene, staging=True)
        self.materials = self._materials()
        return self.hierarchy, self.materials

    def _new_data(self):
        if self.owned is not None:
            return {key: ids & set(getattr(bpy.data, key)) for key, ids in self.owned.items()}
        return {key: set(getattr(bpy.data, key)) - self.before[key] for key in self._DATA}

    def import_model(self, path, root_name):
        """Append one private worker result in a single synchronous allocation scope.

        Preserve the foreground palette's custom shaders by assigning local
        staged copies to imported meshes. Worker materials only identify roles;
        the colours are the foreground scene palette's.
        """
        try:
            self._reserve_names()
            self.materials = self._materials()
            before_materials = set(bpy.data.materials)
            with bpy.data.libraries.load(str(path), link=False) as (source, target):
                if root_name not in source.collections:
                    raise ValueError("The worker model has no generated root")
                target.collections = [root_name]
            root = target.collections[0]
            root.name = STAGING_ROOT_NAME
            root[STAGING_KEY] = True
            root.hide_viewport = root.hide_render = True
            self.scene.collection.children.link(root)
            imported = _walk_collections(root)
            self.hierarchy = {collection[ROLE_KEY]: collection for collection in imported}
            if len(self.hierarchy) != len(imported) or self.hierarchy.get("root") != root:
                raise ValueError("Invalid worker collection roles")
            for material in set(bpy.data.materials) - before_materials:
                role = material.get(MATERIAL_ROLE_KEY)
                if role not in self.materials:
                    raise ValueError("Invalid worker material role")
                material.user_remap(self.materials[role])
                bpy.data.materials.remove(material)
        finally:
            # Do this even when appending/assigning materials fails. Never treat
            # objects created by users between modal ticks as our allocations.
            self.owned = self._new_data()

    def validate(self):
        """Check ownership, attachment, and usable finite meshes before publication.

        Geometry-specific closure/coverage checks remain in the generators. This
        gate does not repair meshes or claim a complete printability preflight.
        """
        owned = self._new_data()
        root = self.hierarchy["root"]
        if root not in owned["collections"] or root.name not in self.scene.collection.children:
            raise ValueError("The staged model is not attached to the scene")
        collections = set(self.hierarchy.values())
        if collections != owned["collections"] or not all(c.get(GENERATED_KEY) is True for c in collections):
            raise ValueError("Unexpected collection ownership in the staged model")
        attached = {root}
        for collection in collections:
            attached.update(collection.children)
        if attached != collections:
            raise ValueError("The staged collection hierarchy is incomplete")
        objects = set(root.all_objects)
        if objects != owned["objects"]:
            raise ValueError("The staged model contains unattached or unowned objects")
        if any(item.library is not None for key in ("objects", "meshes", "collections", "materials")
               for item in owned[key]):
            raise ValueError("The staged model contains linked worker data")
        checked = set()
        for obj in objects:
            if obj.get(GENERATED_KEY) is not True or obj.type != "MESH" or obj.data not in owned["meshes"]:
                raise ValueError("The staged model contains unowned mesh data")
            if not all(isfinite(value) for row in obj.matrix_world for value in row):
                raise ValueError(f"Non-finite generated placement: {obj.name}")
            mesh = obj.data
            if mesh in checked:
                continue
            checked.add(mesh)
            if not mesh.vertices or not mesh.polygons:
                raise ValueError(f"Empty generated mesh: {obj.name}")
            coordinates = array("f", [0.0]) * (3 * len(mesh.vertices))
            mesh.vertices.foreach_get("co", coordinates)
            if not all(map(isfinite, coordinates)):
                raise ValueError(f"Non-finite generated coordinates: {obj.name}")
        return owned

    def _restore_selection(self):
        layer = self.context.view_layer
        layer.update()
        available = set(layer.objects)
        selected = set(self.selected) & available
        for obj in layer.objects:
            if obj.select_get() != (obj in selected):
                obj.select_set(obj in selected)
        layer.objects.active = self.active if self.active in available else None

        def restore_collection(current):
            if current.collection == self.active_collection:
                layer.active_layer_collection = current
                return True
            return any(restore_collection(child) for child in current.children)

        restore_collection(layer.layer_collection)

    def commit(self, *, message, lidar_status, set_scene_units):
        owned = self.validate()
        # Everything above the final batch removal is reversible, including
        # remapping shared material users and making user helpers reachable.
        retired_materials = set()
        for key, material in self.materials.items():
            name = _material_name(key)
            previous = bpy.data.materials.get((name, None))
            if previous is not None:
                self._rename(previous, _PREVIOUS_PREFIX + name)
                self.remapped.append((previous, material))
                previous.user_remap(material)
                retired_materials.add(previous)
            material.name = name
        for root in self.roots:
            self._rename(root, _PREVIOUS_PREFIX + ROOT_COLLECTION_NAME)
        root = self.hierarchy["root"]
        root.name = ROOT_COLLECTION_NAME
        root[STAGING_KEY] = False
        root.hide_viewport = root.hide_render = False
        preserve_user_links(self.scene, self.previous_objects, self.previous_collections, self.links)
        if set_scene_units:
            units = self.scene.unit_settings
            units.system, units.scale_length, units.length_unit = "METRIC", 0.001, "MILLIMETERS"
        self.settings.lidar_generation_status = lidar_status
        self.settings.last_status = message
        self._restore_selection()
        retired = (self.previous_objects | self.previous_collections | retired_materials
                   | removable_meshes(self.previous_objects, self.previous_meshes))
        # Builders can replace their working mesh. Dispose of owned leftovers,
        # but never purge unrelated orphan data from the user's file.
        retired.update(mesh for mesh in owned["meshes"] if mesh.users == 0)
        # Appending may retain an internal library user after making every ID
        # local. Validation above forbids linked worker data, so these private
        # source records can always be removed with the transaction's old IDs.
        retired.update(owned["libraries"])
        if retired:
            bpy.data.batch_remove(ids=retired)
        self.committed = True

    def rollback(self):
        if self.committed or self.rolled_back:
            return
        for previous, material in reversed(self.remapped):
            material.user_remap(previous)
        for collection, item in reversed(self.links):
            collection.unlink(item)
        owned = self._new_data()
        ids = set().union(*owned.values())
        if ids:
            bpy.data.batch_remove(ids=ids)
        for datablock, name in reversed(self.renamed):
            if datablock.name != name:
                datablock.name = name
        units = self.scene.unit_settings
        units.system, units.scale_length, units.length_unit = self.units
        self.settings.last_status, self.settings.lidar_generation_status = self.status
        self._restore_selection()
        self.rolled_back = True
