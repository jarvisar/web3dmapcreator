"""Collection hierarchy and safe cleanup of generated data."""

from __future__ import annotations

from typing import Dict, List

import bpy


ROOT_COLLECTION_NAME = "CITY_MODEL"
GENERATED_KEY = "jarvizar_generated"


def _new_child(name: str, parent: bpy.types.Collection) -> bpy.types.Collection:
    collection = bpy.data.collections.new(name)
    collection[GENERATED_KEY] = True
    parent.children.link(collection)
    return collection


def create_city_hierarchy(scene: bpy.types.Scene) -> Dict[str, bpy.types.Collection]:
    root = bpy.data.collections.new(ROOT_COLLECTION_NAME)
    root[GENERATED_KEY] = True
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
    return {
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


def _walk_collections(root: bpy.types.Collection) -> List[bpy.types.Collection]:
    result = [root]
    for child in root.children:
        result.extend(_walk_collections(child))
    return result


def generated_objects(scene: bpy.types.Scene) -> List[bpy.types.Object]:
    """Every mesh this add-on generated, in a stable order."""
    found: List[bpy.types.Object] = []
    seen = set()
    for root in scene.collection.children:
        if root.name != ROOT_COLLECTION_NAME or root.get(GENERATED_KEY) is not True:
            continue
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


def clear_generated(scene: bpy.types.Scene) -> int:
    """Remove only objects and collections tagged as add-on generated."""
    roots = [
        collection
        for collection in scene.collection.children
        if collection.name == ROOT_COLLECTION_NAME
        and collection.get(GENERATED_KEY) is True
    ]
    generated_objects = set()
    generated_meshes = set()
    generated_collections = set()
    for root in roots:
        collections = _walk_collections(root)
        for collection in collections:
            if collection.get(GENERATED_KEY) is True:
                generated_collections.add(collection)
            for obj in list(collection.objects):
                if obj.get(GENERATED_KEY) is True:
                    generated_objects.add(obj)
                    if obj.type == "MESH" and obj.data is not None:
                        generated_meshes.add(obj.data)

    removed_count = len(generated_objects)
    if hasattr(bpy.data, "batch_remove"):
        if generated_objects or generated_meshes:
            bpy.data.batch_remove(ids=generated_objects | generated_meshes)
        if generated_collections:
            bpy.data.batch_remove(ids=generated_collections)
    else:
        # Compatibility path for Blender versions older than batch_remove.
        for obj in generated_objects:
            bpy.data.objects.remove(obj, do_unlink=True)
        for mesh in generated_meshes:
            if mesh.users == 0:
                bpy.data.meshes.remove(mesh)
        for collection in sorted(
            generated_collections, key=lambda item: len(_walk_collections(item))
        ):
            if collection.name in bpy.data.collections:
                bpy.data.collections.remove(collection)
    return removed_count
