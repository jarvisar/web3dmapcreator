"""Colour palettes: one colour and Bambu PLA line per group of material roles.

A colour is stored the way the materials store it and the 3MF export writes
it: each component is a byte over 255, so a Bambu filament's colour is its hex
code over 255. Presets use Bambu filaments except the Default preset's water,
forest, tree, sand, rock and rim colours, which are the add-on's original
values. No bpy dependency.
"""

from __future__ import annotations

from dataclasses import dataclass
import struct
from typing import Dict, Iterable, Mapping, Optional, Tuple

from .export_plates import FILAMENT_LINES

BASIC = "PLA Basic"
MATTE = "PLA Matte"

Colour = Tuple[float, float, float]
Entry = Tuple[Colour, str]


@dataclass(frozen=True)
class Group:
    key: str
    label: str
    description: str
    roles: Tuple[str, ...]


# Keys are property names of the scene palette; roles are the material roles
# of blender/materials.py, in its PALETTE order.
GROUPS = (
    Group("terrain", "Terrain", "Terrain and the ground supports kept under structures over water", ("terrain",)),
    Group("buildings", "Buildings", "Buildings and building parts", ("building", "building_part")),
    Group("roads", "Roads", "Roads, paths, railways, airport paving, bridge decks and piers",
          ("road", "bridge", "bridge_support")),
    Group("paved", "Paved", "Paved plazas and pedestrian areas", ("surface_paved",)),
    Group("water", "Water", "Water fills of rivers, lakes and basins", ("water",)),
    Group("green", "Parks", "Parks, grass and other green land cover", ("surface_green",)),
    Group("forest", "Forest", "Forest floor", ("surface_forest",)),
    Group("trees", "Trees", "Trees", ("tree",)),
    Group("sand", "Sand", "Sand and beaches", ("surface_sand",)),
    Group("rock", "Rock", "Bare rock, including LiDAR rock surfaces", ("surface_rock",)),
    Group("rim", "Rim", "Border rim", ("rim",)),
)
GROUP_KEYS = tuple(group.key for group in GROUPS)

# Single-colour PLA Basic and PLA Matte filaments, as named and coded in
# Bambu Studio 2.8's resources/profiles/BBL/filament/filaments_color_codes.json.
FILAMENTS: Dict[str, Dict[str, str]] = {
    BASIC: {
        "Bambu Green": "#00AE42", "Beige": "#F7E6DE", "Black": "#000000", "Blue": "#0A2989",
        "Blue Gray": "#5B6579", "Bright Green": "#BECF00", "Bronze": "#847D48",
        "Brown": "#9D432C", "Cobalt Blue": "#0056B8", "Cocoa Brown": "#6F5034",
        "Cyan": "#0086D6", "Dark Gray": "#545454", "Gold": "#E4BD68", "Gray": "#8E9089",
        "Hot Pink": "#F5547C", "Indigo Purple": "#482960", "Jade White": "#FFFFFF",
        "Light Gray": "#D1D3D5", "Magenta": "#EC008C", "Maroon Red": "#9D2235",
        "Mistletoe Green": "#3F8E43", "Orange": "#FF6A13", "Pink": "#F55A74",
        "Pumpkin Orange": "#FF9016", "Purple": "#5E43B7", "Red": "#C12E1F",
        "Silver": "#A6A9AA", "Sunflower Yellow": "#FEC600", "Turquoise": "#00B1B7",
        "Yellow": "#F4EE2A",
    },
    MATTE: {
        "Apple Green": "#C2E189", "Ash Gray": "#9B9EA0", "Bone White": "#CBC6B8",
        "Caramel": "#AE835B", "Charcoal": "#000000", "Dark Blue": "#042F56",
        "Dark Brown": "#7D6556", "Dark Chocolate": "#4D3324", "Dark Green": "#68724D",
        "Dark Red": "#BB3D43", "Desert Tan": "#E8DBB7", "Grass Green": "#61C680",
        "Ice Blue": "#A3D8E1", "Ivory White": "#FFFFFF", "Latte Brown": "#D3B7A7",
        "Lemon Yellow": "#F7D959", "Lilac Purple": "#AE96D4", "Mandarin Orange": "#F99963",
        "Marine Blue": "#0078BF", "Nardo Gray": "#757575", "Plum": "#950051",
        "Sakura Pink": "#E8AFCF", "Scarlet Red": "#DE4343", "Sky Blue": "#56B7E6",
        "Terracotta": "#B15533",
    },
}


def rgb(code: str) -> Colour:
    """A #RRGGBB code as stored colour components, as materials._bambu converts it."""
    return tuple(int(code[i:i + 2], 16) / 255 for i in (1, 3, 5))


def hex_code(colour: Iterable[float]) -> str:
    """The #RRGGBB the 3MF export writes for a colour."""
    return "#%02X%02X%02X" % tuple(min(255, max(0, round(c * 255))) for c in tuple(colour)[:3])


def filament(line: str, name: str) -> Entry:
    """A Bambu filament of FILAMENTS as a palette entry."""
    return rgb(FILAMENTS[line][name]), line


def filament_name(entry: Entry) -> str:
    """The Bambu filament an entry exports as, e.g. "PLA Matte Caramel", else ""."""
    colour, line = entry
    code = hex_code(colour)
    return next((f"{line} {name}" for name, value in FILAMENTS.get(line, {}).items() if value == code), "")


@dataclass(frozen=True)
class Preset:
    key: str
    name: str
    description: str
    entries: Mapping[str, Entry]


def _preset(key, name, description, **entries):
    if set(entries) != set(GROUP_KEYS) or any(line not in FILAMENT_LINES for _, line in entries.values()):
        raise ValueError(f"Preset {name} must set every group to an exported PLA line")
    return Preset(key, name, description, {group: entries[group] for group in GROUP_KEYS})


_IVORY = filament(MATTE, "Ivory White")
_CARAMEL = filament(MATTE, "Caramel")
_DARK_GRAY = filament(BASIC, "Dark Gray")
_BAMBU_GREEN = filament(BASIC, "Bambu Green")
# The original non-Bambu colours of the Default preset, unchanged.
_WATER = ((0.36, 0.70, 0.82), BASIC)
_FOREST = ((0.06, 0.18, 0.08), BASIC)
_SAND = ((0.55, 0.39, 0.22), BASIC)
_RIM = ((0.16, 0.16, 0.17), BASIC)

PRESETS = (
    _preset("DEFAULT", "Default",
            "Matte Caramel buildings, Matte Ivory White terrain, Basic Dark Gray roads and paving, "
            "Basic Bambu Green parks",
            terrain=_IVORY, buildings=_CARAMEL, roads=_DARK_GRAY, paved=_DARK_GRAY, water=_WATER,
            green=_BAMBU_GREEN, forest=_FOREST, trees=_FOREST, sand=_SAND, rock=_SAND, rim=_RIM),
    _preset("SINGLE", "Single Colour",
            "Everything in PLA Matte Ivory White: one filament, for printers without multi-material",
            **{key: _IVORY for key in GROUP_KEYS}),
    _preset("AMS4", "4-Colour AMS",
            "White terrain and buildings, dark gray roads, green parks and trees, blue water: "
            "at most four filaments",
            terrain=_IVORY, buildings=_IVORY, roads=_DARK_GRAY, paved=_DARK_GRAY,
            water=filament(MATTE, "Sky Blue"), green=_BAMBU_GREEN, forest=_BAMBU_GREEN,
            trees=_BAMBU_GREEN, sand=_IVORY, rock=_IVORY, rim=_DARK_GRAY),
    _preset("CLASSIC", "Classic Map",
            "Beige land, terracotta buildings, white roads, pale blue water and green parks",
            terrain=filament(BASIC, "Beige"), buildings=filament(MATTE, "Terracotta"),
            roads=filament(BASIC, "Jade White"), paved=filament(BASIC, "Jade White"),
            water=filament(MATTE, "Ice Blue"), green=filament(MATTE, "Apple Green"),
            forest=filament(MATTE, "Apple Green"), trees=filament(MATTE, "Grass Green"),
            sand=filament(MATTE, "Desert Tan"), rock=filament(MATTE, "Desert Tan"),
            rim=filament(MATTE, "Dark Brown")),
    _preset("NIGHT", "Night",
            "Black terrain, gray buildings, gold roads, dark blue water and dark green parks",
            terrain=filament(MATTE, "Charcoal"), buildings=filament(MATTE, "Ash Gray"),
            roads=filament(BASIC, "Gold"), paved=filament(BASIC, "Gold"),
            water=filament(MATTE, "Dark Blue"), green=filament(MATTE, "Dark Green"),
            forest=filament(MATTE, "Dark Green"), trees=filament(MATTE, "Dark Green"),
            sand=filament(MATTE, "Dark Brown"), rock=filament(MATTE, "Dark Brown"),
            rim=filament(MATTE, "Charcoal")),
)
DEFAULT_PRESET = PRESETS[0]


def settings_palette(palette) -> Dict[str, Entry]:
    """{group: (colour, line)} from an object with the scene palette's properties."""
    return {key: (tuple(getattr(palette, key))[:3], getattr(palette, key + "_line")) for key in GROUP_KEYS}


def role_palette(entries: Mapping[str, Entry]) -> Dict[str, Entry]:
    """Expand group entries to the material roles they colour."""
    return {role: entries[group.key] for group in GROUPS for role in group.roles}


def used_groups(settings) -> Tuple[str, ...]:
    """Groups the enabled features can generate.

    Land cover categories are included whenever land cover is enabled, though
    an area may have no sand or rock.
    """
    used = set()
    if settings.generate_terrain:
        used.add("terrain")
        if settings.generate_border_rim:
            used.add("rim")
    if settings.generate_buildings:
        used.add("buildings")
        if settings.use_lidar_buildings and settings.lidar_rock_surfaces and not settings.lidar_height_only:
            used.add("rock")
    if settings.generate_roads or settings.generate_bridges:
        used.add("roads")
    if settings.generate_water:
        used.add("water")
    if settings.generate_land_surfaces:
        used.update(("paved", "green", "forest", "sand", "rock"))
    if settings.generate_trees:
        used.add("trees")
    return tuple(key for key in GROUP_KEYS if key in used)


def filament_count(entries: Mapping[str, Entry], groups: Iterable[str]) -> int:
    """Distinct exported (colour, line) filaments among ``groups``."""
    return len({(hex_code(entries[key][0]), entries[key][1]) for key in groups})


def _float32(colour) -> bytes:
    return struct.pack("<3f", *tuple(colour)[:3])


def matching_preset(entries: Mapping[str, Entry]) -> Optional[Preset]:
    """The preset these entries hold, comparing colours as stored float32 values."""
    for preset in PRESETS:
        if all(entries[key][1] == line and _float32(entries[key][0]) == _float32(colour)
               for key, (colour, line) in preset.entries.items()):
            return preset
    return None
