"""Collection hierarchy and safe cleanup of generated data."""

from __future__ import annotations

from typing import Dict, List

import bpy


ROOT_COLLECTION_NAME = "CITY_MODEL"
STAGING_ROOT_NAME = "_CITY_MODEL_STAGING"
GENERATED_KEY = "jarvizar_generated"
ROOT_KEY = "jarvizar_city_root"
STAGING_KEY = "jarvizar_staging"
ROLE_KEY = "jarvizar_collection_role"


def _new_child(name: str, parent: bpy.types.Collection) -> bpy.types.Collection:
    collection = bpy.data.collections.new(name)
    collection[GENERATED_KEY] = True
    parent.children.link(collection)
    return collection


def create_city_hierarchy(scene: bpy.types.Scene, *, staging=False) -> Dict[str, bpy.types.Collection]:
    root = bpy.data.collections.new(STAGING_ROOT_NAME if staging else ROOT_COLLECTION_NAME)
    root[GENERATED_KEY] = True
    root[ROOT_KEY] = True
    root[STAGING_KEY] = staging
    scene.collection.children.link(root)

    terrain = _new_child("TERRAIN", root)
    land_surfaces = _new_child("LAND_SURFACES", terrain)
    terrain_supports = _new_child("TERRAIN_SUPPORTS", terrain)
    vegetation = _new_child("VEGETATION", root)
    water = _new_child("WATER", root)
    roads = _new_child("ROADS", root)
    surface_roads = _new_child("SURFACE_ROADS", roads)
    bridges = _new_child("BRIDGES", roads)
    supports = _new_child("BRIDGE_SUPPORTS", roads)
    buildings = _new_child("BUILDINGS", root)
    building_parts = _new_child("BUILDING_PARTS", buildings)
    hierarchy = {
        "root": root,
        "terrain": terrain,
        "land_surfaces": land_surfaces,
        "terrain_supports": terrain_supports,
        "vegetation": vegetation,
        "water": water,
        "roads": roads,
        "surface_roads": surface_roads,
        "bridges": bridges,
        "bridge_supports": supports,
        "buildings": buildings,
        "building_parts": building_parts,
    }
    for role, collection in hierarchy.items():
        collection[ROLE_KEY] = role
    return hierarchy


def _walk_collections(root: bpy.types.Collection) -> List[bpy.types.Collection]:
    result = [root]
    for child in root.children:
        result.extend(_walk_collections(child))
    return result


def generated_objects(scene: bpy.types.Scene) -> List[bpy.types.Object]:
    """Every mesh this add-on generated, in a stable order."""
    found: List[bpy.types.Object] = []
    seen = set()
    for root in generated_roots(scene):
        for collection in _walk_collections(root):
            for obj in collection.objects:
                if obj.type != "MESH" or obj.get(GENERATED_KEY) is not True:
                    continue
                if obj.name in seen:
                    continue
                seen.add(obj.name)
                found.append(obj)
    found.sort(key=lambda item: item.name)
    return found


def generated_roots(scene: bpy.types.Scene) -> List[bpy.types.Collection]:
    """Find published roots, including legacy files and Blender name collisions."""
    return [
        collection
        for collection in scene.collection.children
        if (collection.get(ROOT_KEY) is True or collection.name == ROOT_COLLECTION_NAME)
        and collection.get(GENERATED_KEY) is True
        and not collection.get(STAGING_KEY)
    ]


def hierarchy_data(roots):
    """Return owned objects, their meshes, and tagged collections by reference."""
    owned_objects = set()
    owned_meshes = set()
    owned_collections = set()
    for root in roots:
        collections = _walk_collections(root)
        for collection in collections:
            if collection.get(GENERATED_KEY) is True:
                owned_collections.add(collection)
            for obj in list(collection.objects):
                if obj.get(GENERATED_KEY) is True:
                    owned_objects.add(obj)
                    if obj.type == "MESH" and obj.data is not None:
                        owned_meshes.add(obj.data)

    return owned_objects, owned_meshes, owned_collections


def preserve_user_links(scene, objects, collections, links=None):
    """Keep helpers reachable when deleting their generated parent collections.

    Return added links so a generation transaction can undo this preparation.
    """
    if links is None:
        links = []
    for collection in collections:
        for child in collection.children:
            if child not in collections and child.name not in scene.collection.children:
                scene.collection.children.link(child)
                links.append((scene.collection.children, child))
        for obj in collection.objects:
            if obj not in objects and obj.name not in scene.collection.objects:
                scene.collection.objects.link(obj)
                links.append((scene.collection.objects, obj))
    return links


def removable_meshes(objects, meshes):
    """Do not destroy mesh data reused by a surviving user object."""
    users = {}
    for obj in objects:
        if obj.type == "MESH" and obj.data is not None:
            users[obj.data] = users.get(obj.data, 0) + 1
    return {mesh for mesh in meshes if mesh.users == users.get(mesh, 0)}


def clear_generated(scene: bpy.types.Scene) -> int:
    """Remove generated output while preserving helpers and shared mesh data."""
    objects, meshes, collections = hierarchy_data(generated_roots(scene))
    preserve_user_links(scene, objects, collections)
    ids = objects | collections | removable_meshes(objects, meshes)
    if ids:
        bpy.data.batch_remove(ids=ids)
    return len(objects)
