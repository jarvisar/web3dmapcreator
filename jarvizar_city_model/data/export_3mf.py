"""Semantic part names for exported Bambu projects, and the archive's part paths."""

from collections import Counter

from .linework import MINOR_ROAD_CLASSES, RAIL_CLASS


MODEL = "3D/3dmodel.model"
SETTINGS = "Metadata/model_settings.config"
CORE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
NS = {"m": CORE}
FEATURE_NAMES = {
    "terrain": "Terrain", "border_rim": "Border Rim",
    "building": "Buildings", "buildings": "Buildings",
    "building_part": "Building Parts", "water_surface": "Water",
    "trees": "Trees", "tree": "Trees", "label": "Labels", "labels": "Labels",
    "terrain_support": "Terrain Supports", "bridge_support": "Bridge Supports",
}
SURFACE_NAMES = {
    "green": "Greenery", "forest": "Forest", "paved": "Paved",
    "sand": "Sand", "rock": "Rock",
}
ROLE_NAMES = {
    "terrain": "Terrain", "land_surfaces": "Land Surfaces",
    "terrain_supports": "Terrain Supports", "vegetation": "Trees",
    "water": "Water", "roads": "Roads", "surface_roads": "Roads",
    "bridges": "Bridges", "bridge_supports": "Bridge Supports",
    "buildings": "Buildings", "building_parts": "Building Parts",
    "labels": "Labels",
}
MATERIAL_NAMES = {
    "terrain": "Terrain", "building": "Buildings", "building_part": "Building Parts",
    "road": "Roads", "bridge": "Bridges", "bridge_support": "Bridge Supports",
    "water": "Water", "tree": "Trees", "rim": "Border Rim",
    **{f"surface_{category}": name for category, name in SURFACE_NAMES.items()},
}


def semantic_part_name(obj):
    """Use generator tags, then owned collection roles for older scenes."""
    kind = obj.get("feature_type", "")
    if kind == "land_surface":
        category = obj.get("surface_category", "")
        return SURFACE_NAMES.get(category, category.replace("_", " ").title() or "Land Surfaces")
    if kind in {"surface_road", "bridge_deck"}:
        road_class = obj.get("road_class", "")
        name = "Paths" if road_class in MINOR_ROAD_CLASSES or road_class == "pedestrian" else "Roads"
        if road_class == RAIL_CLASS:
            name = "Railways"
        if kind == "bridge_deck":
            name = {"Paths": "Footbridges", "Railways": "Rail Bridges"}.get(name, "Bridges")
        # These are already separate generator batches. Retain that distinction.
        return f"{name} ({road_class.replace('_', ' ').title()})" if road_class and road_class != RAIL_CLASS else name
    if kind:
        return FEATURE_NAMES.get(kind, kind.replace("_", " ").title())
    roles = {c.get("jarvizar_collection_role") for c in obj.users_collection}
    names = {ROLE_NAMES[role] for role in roles if role in ROLE_NAMES}
    if len(names) == 1:
        return names.pop()
    # Older unmerged trees lack feature tags. Export copies retain their
    # material roles even after leaving the source's owned collection.
    materials = [slot.material for slot in obj.material_slots if slot.material is not None]
    material_roles = {mat.get("jarvizar_material_role") for mat in materials}
    if len(material_roles) == 1:
        role = next(iter(material_roles))
        if role in MATERIAL_NAMES:
            return MATERIAL_NAMES[role]
    return obj.name


def part_name_map(parts):
    """Key by each export copy's exact Blender name, never by mesh position."""
    semantic_names = [semantic_part_name(obj) for obj in parts]
    totals = Counter(semantic_names)
    counts = Counter()
    result = {}
    for obj, name in zip(parts, semantic_names):
        counts[name] += 1
        result[obj.name] = f"{name} {counts[name]}" if totals[name] > 1 else name
    return result
