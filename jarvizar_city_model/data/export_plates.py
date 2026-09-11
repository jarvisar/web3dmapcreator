"""Add Bambu project plates to archives produced by the existing 3MF writer.

No slicer dependency or copied project template. Plate records and build
transforms follow Bambu's PartPlateList; part extruders and unsplit triangle
paint follow bbs_3mf/FacetsAnnotation. The Bambu application marker selects its
native project loader (otherwise it discards project configuration). Creator
metadata identifies our exporter. Normal single-plate exports do not use this.
"""

import json
import math
import xml.etree.ElementTree as ET
import zipfile

from .export_3mf import CORE, MATERIALS, MODEL, NS, SETTINGS
from .export_sections import BAMBU_MAX_PLATES, BAMBU_PLATE_SIZE, plate_origin


PROJECT = "Metadata/project_settings.config"


def _metadata(parent, key, value):
    ET.SubElement(parent, "metadata", key=key, value=str(value))


def _paint(extruder):
    # An unsplit triangle: two zero split bits, then its extruder state.
    # States >= 3 extend the C nibble by base-15 continuation nibbles.
    if extruder < 3:
        return f"{extruder * 4:X}"
    value = extruder - 3
    return f"{value % 15:X}" + "F" * (value // 15) + "C"


def combine_plates(section_files, destination):
    """Combine named single-assembly exports into an unsliced multi-plate project.

    Input is [(Section, path), ...] in map order, with empty cells omitted.
    Geometry stays in original map coordinates; one translation per assembly
    places it on its plate, with a common Z datum for all layers and sections.
    """
    if not 1 <= len(section_files) <= BAMBU_MAX_PLATES:
        raise ValueError("A Bambu project must contain between 1 and 36 nonempty sections")
    config = ET.Element("config")
    root = None
    next_id = 1
    palette, color_ids = [], {}
    placements = []
    bottom = math.inf

    def filament(color):
        color = color.upper()
        if color not in color_ids:
            color_ids[color] = len(palette) + 1
            palette.append(color)
        return color_ids[color]

    for section, path in section_files:
        with zipfile.ZipFile(path) as archive:
            model = ET.fromstring(archive.read(MODEL))
            settings = ET.fromstring(archive.read(SETTINGS))
            source_resources = model.find("m:resources", NS)
            items = model.findall("m:build/m:item", NS)
            if root is None:
                root = model
                build = root.find("m:build", NS)
                root.remove(source_resources)
                root.remove(build)
                resources = ET.SubElement(root, f"{{{CORE}}}resources")
                build = ET.SubElement(root, f"{{{CORE}}}build")

            objects = source_resources.findall("m:object", NS)
            ids = {}
            for obj in objects:
                ids[obj.get("id")] = str(next_id)
                next_id += 1
            settings_object = settings.find("object")
            assembly_id = settings_object.get("id")
            assembly = next(obj for obj in objects if obj.get("id") == assembly_id)
            # export_section bakes world coordinates and the existing holder is
            # identity. Refuse changed writer transforms instead of losing them.
            transforms = items + assembly.findall("m:components/m:component", NS)
            identity = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
            if (len(items) != 1 or items[0].get("objectid") != assembly_id
                    or any([float(v) for v in e.get("transform", "1 0 0 0 1 0 0 0 1 0 0 0").split()]
                           != identity for e in transforms)):
                raise ValueError("Expected world-space section meshes with identity assembly transforms")
            groups = {g.get("id"): [c.get("color") for c in g]
                      for g in source_resources.findall(f"{{{MATERIALS}}}colorgroup")}
            for group in source_resources.findall("m:basematerials", NS):
                groups[group.get("id")] = [c.get("displaycolor") for c in group]

            def material_id(obj, triangle=None):
                pid = obj.get("pid") if triangle is None else triangle.get("pid", obj.get("pid"))
                index = obj.get("pindex", "0") if triangle is None else triangle.get("p1", obj.get("pindex", "0"))
                if pid is None:
                    return filament("#FFFFFF")
                if pid not in groups or not 0 <= int(index) < len(groups[pid]):
                    raise ValueError("Cannot resolve a section's 3MF material")
                if triangle is not None and any(triangle.get(p, index) != index for p in ("p2", "p3")):
                    raise ValueError("Section export requires uniform colors within each triangle")
                return filament(groups[pid][int(index)])

            parts = {p.get("id"): p for p in settings_object.findall("part")}
            for obj in objects:
                old_id = obj.get("id")
                if obj.find("m:mesh", NS) is not None:
                    default = material_id(obj)
                    _metadata(parts[old_id], "extruder", default)
                    for triangle in obj.findall("m:mesh/m:triangles/m:triangle", NS):
                        color = material_id(obj, triangle)
                        if color != default:
                            triangle.set("paint_color", _paint(color))
                        for key in ("pid", "p1", "p2", "p3"):
                            triangle.attrib.pop(key, None)
                    for vertex in obj.findall("m:mesh/m:vertices/m:vertex", NS):
                        xyz = [float(vertex.get(axis)) for axis in ("x", "y", "z")]
                        if not all(math.isfinite(v) for v in xyz):
                            raise ValueError("Section contains nonfinite mesh coordinates")
                        bottom = min(bottom, xyz[2])
                    obj.attrib.pop("pid", None)
                    obj.attrib.pop("pindex", None)
                obj.set("id", ids[old_id])
                for component in obj.findall("m:components/m:component", NS):
                    component.set("objectid", ids[component.get("objectid")])
                resources.append(obj)
            assembly.set("name", section.name)
            settings_object.set("id", ids[assembly_id])
            settings_object.find("metadata[@key='name']").set("value", section.name)
            _metadata(settings_object, "extruder",
                      next(iter(parts.values())).find("metadata[@key='extruder']").get("value"))
            for part in parts.values():
                part.set("id", ids[part.get("id")])
            config.append(settings_object)
            placements.append((section, ids[assembly_id]))

    if not math.isfinite(bottom):
        raise ValueError("No section geometry to export")
    for index, (section, assembly_id) in enumerate(placements):
        west, south, east, north = section.bounds
        ox, oy = plate_origin(index, len(placements))
        tx = ox + BAMBU_PLATE_SIZE / 2 - (west + east) / 2
        ty = oy + BAMBU_PLATE_SIZE / 2 - (south + north) / 2
        ET.SubElement(build, f"{{{CORE}}}item", objectid=assembly_id, printable="1",
                      transform=f"1 0 0 0 1 0 0 0 1 {tx:.9f} {ty:.9f} {-bottom:.9f}")
        plate = ET.SubElement(config, "plate")
        _metadata(plate, "plater_id", index + 1)
        _metadata(plate, "plater_name", section.name)
        _metadata(plate, "locked", "false")
        instance = ET.SubElement(plate, "model_instance")
        for key, value in (("object_id", assembly_id), ("instance_id", 0), ("identify_id", index + 1)):
            _metadata(instance, key, value)

    # This is a native, unsliced Bambu project, not just a named standard 3MF.
    # Bambu gates project loading on this Application prefix; version 2.0 also
    # avoids its pre-1.5.9 bed-offset and pre-2.0 prime-volume migrations.
    root.set("xmlns:BambuStudio", "http://schemas.bambulab.com/package/2021")
    for name, value in (("Application", "BambuStudio-02.00.00.00"),
                        ("BambuStudio:3mfVersion", "1"),
                        ("Description", "Generated by Jarvizar City Model: multi-plate miniature")):
        metadata = root.find(f"m:metadata[@name='{name}']", NS)
        if metadata is None:
            metadata = ET.Element(f"{{{CORE}}}metadata", name=name)
            root.insert(0, metadata)
        metadata.text = value
    project = {
        "name": "project_settings",
        "version": "02.00.00.00",
        "printer_model": "Bambu Lab P1S",
        "printer_settings_id": "Bambu Lab P1S 0.4 nozzle",
        "print_settings_id": "0.20mm Standard @BBL X1C",
        "printer_technology": "FFF",
        "nozzle_diameter": ["0.4"],
        "printable_area": ["0x0", "256x0", "256x256", "0x256"],
        "printable_height": "256",
        "filament_colour": palette,
        "filament_type": ["PLA"] * len(palette),
        "filament_settings_id": ["Generic PLA @BBL X1C"] * len(palette),
        # A square matrix is required by the native project loader. This is
        # the standard 140 mm^3 unload + 140 mm^3 load starting allowance;
        # Bambu's Flushing Volumes dialog can recalculate for actual filaments.
        "flush_volumes_matrix": ["0" if a == b else "280"
                                 for a in range(len(palette)) for b in range(len(palette))],
    }
    # This combined project contains no writer thumbnails or external models.
    # Declare precisely its parts rather than copying possibly dangling rels.
    content_ns = "http://schemas.openxmlformats.org/package/2006/content-types"
    types = ET.Element(f"{{{content_ns}}}Types")
    for extension, content_type in (("rels", "application/vnd.openxmlformats-package.relationships+xml"),
                                    ("model", "application/vnd.ms-package.3dmanufacturing-3dmodel+xml"),
                                    ("config", "application/xml")):
        ET.SubElement(types, f"{{{content_ns}}}Default", Extension=extension, ContentType=content_type)
    ET.SubElement(types, f"{{{content_ns}}}Override", PartName="/" + PROJECT, ContentType="application/json")
    rel_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    relationships = ET.Element(f"{{{rel_ns}}}Relationships")
    ET.SubElement(relationships, f"{{{rel_ns}}}Relationship", Id="rel0", Target="/" + MODEL,
                  Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel")
    # Bambu matches the literal OPC tag names, so each XML part needs its own
    # default namespace, rather than ElementTree's generated ns0: prefixes.
    def xml(tree, namespace):
        ET.register_namespace("", namespace)
        return ET.tostring(tree, encoding="utf-8", xml_declaration=True)

    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as output:
        output.writestr(MODEL, xml(root, CORE))
        output.writestr(SETTINGS, ET.tostring(config, encoding="utf-8", xml_declaration=True))
        output.writestr("[Content_Types].xml", xml(types, content_ns))
        output.writestr(PROJECT, json.dumps(project, indent=2))
        output.writestr("_rels/.rels", xml(relationships, rel_ns))
