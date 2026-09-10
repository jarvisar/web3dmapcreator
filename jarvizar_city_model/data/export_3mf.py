"""Semantic names and Bambu-compatible colors for the existing 3MF writer.

Keep the standard material import path: claiming to be a BambuStudio project
would bypass its conversion of 3MF color groups and triangle colors.
"""

from collections import Counter
import shutil
import xml.etree.ElementTree as ET
import zipfile

from .linework import MINOR_ROAD_CLASSES, RAIL_CLASS


MODEL = "3D/3dmodel.model"
SETTINGS = "Metadata/model_settings.config"
CORE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
MATERIALS = "http://schemas.microsoft.com/3dmanufacturing/material/2015/02"
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
    """Key by each export copy's exact writer Title, never by mesh position."""
    semantic_names = [semantic_part_name(obj) for obj in parts]
    totals = Counter(semantic_names)
    counts = Counter()
    result = {}
    for obj, name in zip(parts, semantic_names):
        counts[name] += 1
        result[obj.name] = f"{name} {counts[name]}" if totals[name] > 1 else name
    return result


def _add_color_groups(root):
    """Expose the writer's base colors in the representation Bambu imports.

    Bambu reads m:colorgroup/m:color, not core basematerials/displaycolor.
    Keep the original named base-material resources, mirror their exact palette
    indices in fresh color resources, and retarget property references. This
    preserves both uniform parts and per-triangle material overrides.
    """
    resources = root.find("m:resources", NS)
    next_id = max(int(resource.get("id")) for resource in resources) + 1
    color_ids = {}
    for base_group in list(resources.findall("m:basematerials", NS)):
        colors = [base.get("displaycolor") for base in base_group.findall("m:base", NS)]
        if not colors or not all(colors):
            continue
        color_id = str(next_id)
        next_id += 1
        color_ids[base_group.get("id")] = color_id
        group = ET.Element(f"{{{MATERIALS}}}colorgroup", id=color_id)
        for color in colors:
            ET.SubElement(group, f"{{{MATERIALS}}}color", color=color)
        resources.insert(list(resources).index(base_group) + 1, group)
    for element in root.iter():
        if element.tag in {f"{{{CORE}}}object", f"{{{CORE}}}triangle"}:
            pid = element.get("pid")
            if pid in color_ids:
                element.set("pid", color_ids[pid])


def name_3mf(source, destination, names):
    """Add names and compatible color references without changing geometry.

    Bambu's _generate_volumes_new matches <part id> to component object IDs;
    its GUI displays ModelVolume::name from that part's metadata. Core object
    names alone do not populate the multipart Objects tree. Fail on an unknown
    writer layout rather than silently associating names with the wrong mesh.
    The caller stages both files before publishing the completed archive.
    """
    with zipfile.ZipFile(source) as archive:
        root = ET.fromstring(archive.read(MODEL))
        objects = {obj.attrib["id"]: obj for obj in root.findall("m:resources/m:object", NS)}
        items = root.findall("m:build/m:item", NS)
        if len(items) != 1 or items[0].get("objectid") not in objects:
            raise ValueError("Expected one 3MF map assembly")
        assembly = objects[items[0].get("objectid")]
        components = assembly.findall("m:components/m:component", NS)
        config = ET.Element("config")
        settings_object = ET.SubElement(config, "object", id=assembly.get("id"))
        ET.SubElement(settings_object, "metadata", key="name", value="Map")
        assembly.set("name", "Map")
        matched = set()
        for component in components:
            obj = objects.get(component.get("objectid"))
            if obj is None or obj.find("m:mesh", NS) is None:
                raise ValueError("Expected a mesh for every 3MF map part")
            title = obj.find("m:metadatagroup/m:metadata[@name='Title']", NS)
            if title is None or title.text not in names or title.text in matched:
                raise ValueError("Cannot match 3MF part to its source semantic name")
            matched.add(title.text)
            name = names[title.text]
            obj.set("name", name)
            title.text = name
            part = ET.SubElement(settings_object, "part", id=obj.get("id"), subtype="normal_part")
            ET.SubElement(part, "metadata", key="name", value=name)
        if matched != set(names) or len(objects) != len(components) + 1:
            raise ValueError("3MF writer did not preserve the expected map parts")
        _add_color_groups(root)

        # A config is an additional OPC part, so declare its content type too.
        types = ET.fromstring(archive.read("[Content_Types].xml"))
        content_ns = "http://schemas.openxmlformats.org/package/2006/content-types"
        if not any(e.get("Extension") == "config" for e in types):
            ET.SubElement(types, f"{{{content_ns}}}Default", Extension="config", ContentType="application/xml")
        ET.register_namespace("", CORE)
        # Bambu's Expat reader matches the literal m: prefix for color groups.
        ET.register_namespace("m", MATERIALS)
        replacements = {
            MODEL: ET.tostring(root, encoding="utf-8", xml_declaration=True),
            SETTINGS: ET.tostring(config, encoding="utf-8", xml_declaration=True),
            "[Content_Types].xml": ET.tostring(types, encoding="utf-8", xml_declaration=True),
        }
        with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as output:
            output.comment = archive.comment
            for info in archive.infolist():
                if info.filename in replacements:
                    continue
                with archive.open(info) as original, output.open(info, "w") as copied:
                    shutil.copyfileobj(original, copied)
            for path, data in replacements.items():
                output.writestr(path, data)
