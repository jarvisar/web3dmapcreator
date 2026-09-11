"""Blender property definitions for the add-on UI and operators."""

from __future__ import annotations

import os

import bpy
from bpy.props import (
    BoolProperty,
    EnumProperty,
    FloatProperty,
    IntProperty,
    PointerProperty,
    StringProperty,
)
from bpy.types import AddonPreferences, PropertyGroup

from .data.land import DEFAULT_SURFACE_PRIORITY
from .external.lidar_downloads import DEFAULT_DOWNLOAD_WORKERS, MAX_DOWNLOAD_WORKERS


def _default_cache_directory() -> str:
    override = os.environ.get("JARVIZAR_CITY_CACHE")
    if override:
        return override
    return bpy.utils.user_resource(
        "DATAFILES", path="jarvizar_city_model/cache", create=False
    )


class JARVIZAR_AP_preferences(AddonPreferences):
    """Machine-level settings, kept out of the .blend file.

    Where the downloader's Python lives is a property of this computer, not of
    a particular model, so storing it per-scene means re-entering it in every
    new file.  Blender saves add-on preferences with the user preferences, so
    this is filled in once and then found by every scene.
    """

    bl_idname = __package__

    overture_python_path: StringProperty(
        name="Overture Python",
        description=(
            "Python executable in the separate environment containing "
            "overturemaps. Used by every scene that does not override it"
        ),
        default="",
        subtype="FILE_PATH",
    )

    def draw(self, context):
        layout = self.layout
        layout.prop(self, "overture_python_path")
        layout.label(
            text="Scenes leave their own field blank to use this.",
            icon="INFO",
        )


def preferred_python_path() -> str:
    """Return the add-on preference's downloader path, or an empty string."""
    try:
        addon = bpy.context.preferences.addons.get(__package__)
    except AttributeError:
        return ""
    if addon is None or not hasattr(addon.preferences, "overture_python_path"):
        return ""
    return str(addon.preferences.overture_python_path or "")


class JARVIZAR_PG_city_model_settings(PropertyGroup):
    west: StringProperty(
        name="West",
        description="Western longitude in WGS84 decimal degrees",
        default="-84.53370",
    )
    south: StringProperty(
        name="South",
        description="Southern latitude in WGS84 decimal degrees",
        default="39.08554",
    )
    east: StringProperty(
        name="East",
        description="Eastern longitude in WGS84 decimal degrees",
        default="-84.47422",
    )
    north: StringProperty(
        name="North",
        description="Northern latitude in WGS84 decimal degrees",
        default="39.11094",
    )

    scale_mode: EnumProperty(
        name="Scale Mode",
        description="How the real world is scaled into printable millimetres",
        items=(
            (
                "FIXED",
                "Fixed Print Scale",
                "Build at an exact millimetres-per-metre scale. Real feature "
                "sizes then land at predictable printed sizes, and the finished "
                "model is whatever size that implies",
            ),
            (
                "FIT",
                "Fit to Size",
                "Fit the bounding box inside a target width and height. The "
                "scale is then whatever the bbox happens to require",
            ),
        ),
        default="FIXED",
    )
    mm_per_metre: FloatProperty(
        name="Scale (mm per metre)",
        description=(
            "Printed millimetres per real-world metre. 0.07 is 1:14286, at which "
            "a 6.5 m residential street prints 0.455 mm wide"
        ),
        default=0.07,
        min=0.0005,
        soft_max=1.0,
        precision=4,
        step=1,
    )

    target_width_mm: FloatProperty(
        name="Target Width (mm)",
        description="Maximum finished model width in millimetres",
        default=170.5,
        min=1.0,
        soft_max=1000.0,
        precision=2,
    )
    target_height_mm: FloatProperty(
        name="Target Height (mm)",
        description="Maximum finished model height in millimetres",
        default=119.5,
        min=1.0,
        soft_max=1000.0,
        precision=2,
    )
    preserve_aspect_ratio: BoolProperty(
        name="Preserve Geographic Aspect",
        description="Use one horizontal scale and fit inside the target dimensions",
        default=True,
    )
    set_scene_units: BoolProperty(
        name="Set Scene Units to Millimetres",
        description=(
            "Set Metric scale 0.001 so one Blender unit is displayed/exported as one millimetre"
        ),
        default=True,
    )

    # ---------------------------------------------------------------- terrain
    terrain_source: EnumProperty(
        name="Terrain",
        description="Source of the terrain surface",
        items=(
            (
                "FLAT",
                "Flat Base",
                "A single flat printable base at Z=0; needs no elevation download",
            ),
            (
                "DEM",
                "Elevation (DEM)",
                "Displaced terrain from cached public elevation tiles",
            ),
        ),
        default="DEM",
    )
    terrain_resolution: IntProperty(
        name="Terrain Resolution",
        description=(
            "Terrain grid cells across the longer axis. Every feature is aligned "
            "to this same grid, so it also controls how closely roads and water "
            "follow the ground"
        ),
        default=192,
        min=8,
        soft_max=512,
        max=1024,
    )
    terrain_smoothing: IntProperty(
        name="Terrain Smoothing (cells)",
        description=(
            "Radius of a mean filter over the terrain grid. The elevation "
            "tiles carry a metre or two of pixel noise, which prints as "
            "one-layer coins along roads; one cell halves those and barely "
            "moves the hills. Zero uses the tiles as they are"
        ),
        default=1,
        min=0,
        max=4,
    )
    terrain_exaggeration: FloatProperty(
        name="Terrain Exaggeration",
        description="Multiplier applied to real elevation differences",
        default=1.0,
        min=0.0,
        soft_max=10.0,
        precision=2,
    )
    base_thickness_mm: FloatProperty(
        name="Base Thickness (mm)",
        description="Printable thickness below the lowest terrain point",
        default=1.3,
        min=0.1,
        soft_max=20.0,
        precision=2,
    )
    generate_border_rim: BoolProperty(
        name="Border Rim",
        description="Add a raised display frame around the selection edge",
        default=False,
    )
    border_rim_height_mm: FloatProperty(
        name="Rim Height (mm)",
        description="Height of the border rim above the highest terrain point",
        default=1.5,
        min=0.1,
        soft_max=30.0,
        precision=2,
    )
    border_rim_width_mm: FloatProperty(
        name="Rim Width (mm)",
        description="Wall thickness of the border rim",
        default=2.0,
        min=0.1,
        soft_max=20.0,
        precision=2,
    )

    # -------------------------------------------------------------- buildings
    lidar_preparation_status: StringProperty(name='Last LiDAR Preparation', default='')
    lidar_generation_status: StringProperty(name='Last LiDAR Generation', default='')
    lidar_preparing: BoolProperty(default=False, options={'SKIP_SAVE'})
    lidar_laz_offer_token: StringProperty(default='', options={'HIDDEN'})
    lidar_laz_offer_details: StringProperty(default='', options={'HIDDEN'})
    use_lidar_buildings: BoolProperty(
        name="Use Prepared LiDAR", default=False,
        description="Use prepared LiDAR heights, roof tiers and supported roof planes; other buildings retain source geometry",
    )
    lidar_prefer_measured: BoolProperty(
        name="Prefer LiDAR on Conflicts", default=True,
        description="Prefer a usable measured building over conflicting source heights, dates or roof detail; disable for conservative source checks. Prepare again after changing",
    )
    lidar_roof_mode: EnumProperty(
        name="LiDAR Roof Reconstruction",
        items=(('FACETED', 'Detailed Surfaces', 'Infer coherent roof surfaces and setbacks from measured support at the current print scale'),
               ('TERRACES', 'Terraces', 'Use the established horizontal tiers and simple measured roof planes')),
        default='FACETED',
        description="Detailed Surfaces adapts to print scale; Terraces uses the width and step controls. Prepare LiDAR again after changing",
    )
    lidar_minimum_width_mm: FloatProperty(
        name="Minimum LiDAR Detail Width (mm)", default=0.1, min=0.01, soft_max=2.0,
        description="Terraces only: remove roof islands and narrow strips below this printed width",
    )
    lidar_minimum_step_mm: FloatProperty(
        name="Minimum Roof Step (mm)", default=0.05, min=0.02, soft_max=1.0,
        description="Terraces only: smallest measured height difference retained as a separate roof tier",
    )
    lidar_download_workers: IntProperty(
        name="LAZ Parallel Downloads", default=DEFAULT_DOWNLOAD_WORKERS,
        min=1, max=MAX_DOWNLOAD_WORKERS,
        description="Simultaneous LAZ tile downloads for the next preparation. More may help on fast connections; reduce if transfers stall or the server throttles. Does not invalidate prepared LiDAR",
    )
    lidar_source_url: StringProperty(
        name="EPT / COPC URL (optional)", default="",
        description="Leave empty for automatic discovery; set an ept.json or COPC HTTPS URL to override provider discovery",
    )
    lidar_international: BoolProperty(
        name="International LiDAR Discovery", default=True,
        description="Discover official national/regional LiDAR alongside USGS, Flai and OpenTopography; aggregators fill gaps and unavailable sources are skipped",
    )
    lidar_stac_urls: StringProperty(
        name="STAC Catalog URLs (optional)", default="",
        description="Additional public HTTPS STAC API or static catalog URLs, separated by spaces",
    )
    lidar_vertical_units: EnumProperty(
        name="Missing Z Units",
        items=(('AUTO', 'Require Metadata', 'Skip data without declared vertical units'),
               ('m', 'Metres', 'Use metres only when vertical units are missing; verify source documentation'),
               ('ft', 'International Feet', 'Use international feet only when vertical units are missing'),
               ('us-ft', 'US Survey Feet', 'Use US survey feet only when vertical units are missing')),
        default='AUTO', description="Fallback for incomplete source metadata; explicit source units always take precedence",
    )
    lidar_manifest_url: StringProperty(
        name="LAZ Manifest URL (advanced)", default="",
        description="Optional USGS 0_file_download_links.txt HTTPS URL; match tiles to catalog bounds and offer useful gap coverage. Tiles absent from the catalog cannot be located without LAZ reads and are skipped",
    )
    minimum_building_width_mm: FloatProperty(
        name="Minimum Building Width (mm)",
        description=(
            "Drop building masses whose footprint is narrower than this. "
            "Adjoining supported sections use their combined footprint width; "
            "isolated tiny details are still filtered"
        ),
        default=0.08,
        min=0.0,
        soft_max=1.0,
        precision=3,
    )
    maximum_building_slenderness: FloatProperty(
        name="Maximum Building Slenderness",
        description=(
            "Drop masses taller than this multiple of their footprint width; "
            "adjoining sections with compatible heights use their combined width. "
            "Higher values keep more detail. Set to 0 to disable"
        ),
        default=30.0,
        min=0.0,
        soft_max=60.0,
        precision=1,
    )
    generate_roof_shapes: BoolProperty(
        name="Shaped Roofs",
        description=(
            "Build gabled, hipped, skillion, pyramidal, and dome roofs from the "
            "source roof_shape; anything else stays a flat extrusion"
        ),
        default=True,
    )
    slenderness_exempt_width_mm: FloatProperty(
        name="Always Keep Wider Than (mm)",
        description=(
            "A mass at least this wide is never dropped for slenderness. One "
            "nozzle line prints whatever its height; a tower's narrow shaft or "
            "wing is real data"
        ),
        default=0.45,
        min=0.0,
        soft_max=2.0,
        precision=2,
    )
    default_building_height_m: FloatProperty(
        name="Default Building Height (m)",
        description="Fallback real-world height when Overture has no height or floor count",
        default=10.0,
        min=0.1,
        soft_max=100.0,
        precision=2,
    )
    building_height_scale: FloatProperty(
        name="Building Height Scale",
        description=(
            "Multiply every building's height above its own terrain base. 1.1 "
            "gives the massing a little lift over the 0.6 mm roads without "
            "touching the horizontal scale; footprints are unchanged"
        ),
        default=1.1,
        min=0.1,
        soft_max=3.0,
        precision=2,
    )
    minimum_building_height_mm: FloatProperty(
        name="Minimum Building Height (mm)",
        description=(
            "Shortest a building may print above the ground. A mass under this "
            "is stretched upwards until its top clears the highest terrain "
            "under its footprint by exactly this much; taller ones are left "
            "alone. Zero switches the floor off"
        ),
        default=0.8,
        min=0.0,
        soft_max=5.0,
        precision=2,
    )
    minimum_height_footprint_mm: FloatProperty(
        name="Raise Only Footprints Over (mm)",
        description=(
            "A mass is only stretched to the minimum height when its footprint "
            "covers at least this square and is not a ribbon of that area. "
            "Sheds, garages and wall fragments stay their real height instead "
            "of becoming needles"
        ),
        default=0.6,
        min=0.0,
        soft_max=10.0,
        precision=2,
    )
    floor_height_m: FloatProperty(
        name="Floor Height (m)",
        description="Real-world metres per floor for height fallback and min_floor",
        default=3.0,
        min=0.1,
        soft_max=10.0,
        precision=2,
    )

    # ------------------------------------------------------------------ roads
    road_thickness_mm: FloatProperty(
        name="Road Thickness (mm)",
        description="Printable height of road surfaces above the terrain",
        default=0.6,
        min=0.05,
        soft_max=5.0,
        precision=2,
    )
    minimum_road_width_mm: FloatProperty(
        name="Minimum Road Width (mm)",
        description="Smallest printable road width; narrower classes are widened to it",
        default=0.45,
        min=0.05,
        soft_max=5.0,
        precision=2,
    )
    maximum_road_width_mm: FloatProperty(
        name="Maximum Road Width (mm)",
        description=(
            "Widest printed road or deck; wider classes are narrowed to it. A "
            "motorway at true scale is nearly a millimetre and reads as a runway"
        ),
        default=0.7,
        min=0.1,
        soft_max=5.0,
        precision=2,
    )
    include_minor_roads: BoolProperty(
        name="Include Paths and Footways",
        description=(
            "Generate pedestrian-scale classes. These dominate the feature count "
            "in a dense selection"
        ),
        default=True,
    )
    skip_sidepaths: BoolProperty(
        name="Skip Sidewalks and Crossings",
        description=(
            "Leave out footways and cycleways mapped as the pavement beside a "
            "street or the crossing at a corner. Park paths, trails, and "
            "footbridges stay. Without this every downtown street prints as "
            "three ribbons"
        ),
        default=True,
    )
    include_rail: BoolProperty(
        name="Include Railways",
        description="Generate transportation segments with subtype rail",
        default=True,
    )

    # ---------------------------------------------------------------- bridges
    bridge_deck_thickness_mm: FloatProperty(
        name="Bridge Deck Thickness (mm)",
        description=(
            "Printable thickness of elevated bridge decks. The same as the road "
            "thickness makes a bridge continue its road with the same layers"
        ),
        default=0.6,
        min=0.05,
        soft_max=10.0,
        precision=2,
    )
    bridge_clearance_mm: FloatProperty(
        name="Bridge Clearance (mm)",
        description=(
            "Printed gap between a deck's underside and what it crosses: the "
            "terrain, a road's top, or a lower deck. Two 0.2 mm layers of "
            "daylight is what makes a bridge read as one"
        ),
        default=0.4,
        min=0.0,
        soft_max=3.0,
        precision=2,
    )
    bridge_maximum_grade: FloatProperty(
        name="Maximum Deck Grade",
        description=(
            "Steepest rise over run a deck may climb or fall. A deck too short "
            "to reach its clearance at this grade humps as high as it can"
        ),
        default=0.08,
        min=0.01,
        soft_max=0.5,
        precision=3,
    )
    bridge_minimum_lift_mm: FloatProperty(
        name="Minimum Bridge Lift (mm)",
        description=(
            "A flagged bridge whose whole network never rises this far above "
            "the road surface is built as an ordinary road instead of a bump"
        ),
        default=0.2,
        min=0.0,
        soft_max=2.0,
        precision=2,
    )
    bridge_support_spacing_m: FloatProperty(
        name="Bridge Support Spacing (m)",
        description="Approximate real-world spacing between generated piers",
        default=30.0,
        min=1.0,
        soft_max=200.0,
        precision=1,
    )
    bridge_support_minimum_size_mm: FloatProperty(
        name="Minimum Pier Size (mm)",
        description=(
            "Smallest printed plan dimension of a pier. A pier is a free-standing "
            "column, so it is held wider than the minimum road width"
        ),
        default=0.6,
        min=0.1,
        soft_max=3.0,
        precision=2,
    )
    bridge_causeway_margin_mm: FloatProperty(
        name="Causeway Margin (mm)",
        description=(
            "How far the strip of terrain kept under a bridge over cut water "
            "extends beyond each edge of the deck"
        ),
        default=0.3,
        min=0.0,
        soft_max=3.0,
        precision=2,
    )

    # ------------------------------------------------------------------ water
    cut_water_from_terrain: BoolProperty(
        name="Cut Water From Terrain",
        description=(
            "Remove rivers and lakes from the terrain solid instead of covering "
            "them over, so the water reads as an opening. Bridge piers standing "
            "in the opening are dropped with it"
        ),
        default=True,
    )
    support_structures_over_water: BoolProperty(
        name="Keep Ground Under Structures",
        description=(
            "Where the cut removes the ground under a bridge, a building, or a "
            "mapped pier, build that ground back as terrain under the structure's "
            "own footprint only. The rest of the water stays open"
        ),
        default=True,
    )
    minimum_water_cut_area_m2: FloatProperty(
        name="Minimum Cut Area (m2)",
        description=(
            "Smallest real-world water area cut out of the terrain. Below this "
            "a body is left as a surface slab, which keeps ponds and fountains "
            "from punching holes through the base"
        ),
        default=5000.0,
        min=0.0,
        soft_max=200000.0,
        precision=0,
    )
    water_thickness_mm: FloatProperty(
        name="Water Thickness (mm)",
        description="Printable thickness of the water slab below its surface",
        default=1.2,
        min=0.05,
        soft_max=10.0,
        precision=2,
    )
    recess_ponds_and_fountains: BoolProperty(
        name="Recess Ponds and Fountains",
        description=(
            "Keep a solid basin beneath mapped ponds and fountains instead of a "
            "through-cut. Disable to restore their previous water behavior"
        ),
        default=True,
    )
    pond_recess_depth_mm: FloatProperty(
        name="Recess Depth (mm)",
        description="Depth of pond and fountain basins below the local bank",
        default=1.0, min=0.01, soft_max=5.0, precision=2,
    )
    pond_water_thickness_mm: FloatProperty(
        name="Basin Water Thickness (mm)",
        description="Water thickness from the basin floor; must not exceed recess depth",
        default=0.8, min=0.01, soft_max=5.0, precision=2,
    )

    # ----------------------------------------------------------- land surface
    surface_priority_order: StringProperty(
        name="Surface Priority",
        description="Surface overlap order, highest priority first",
        default=",".join(DEFAULT_SURFACE_PRIORITY),
        options={"HIDDEN"},
    )

    def surface_order(self):
        order = tuple(self.surface_priority_order.split(","))
        return order if (len(order) == len(DEFAULT_SURFACE_PRIORITY)
                         and set(order) == set(DEFAULT_SURFACE_PRIORITY)) else DEFAULT_SURFACE_PRIORITY

    surface_rise_mm: FloatProperty(
        name="Land Surface Rise (mm)",
        description=(
            "Height of parks, forest floor, and plazas above the terrain. Two "
            "0.2 mm layers reads as a colour region of its own"
        ),
        default=0.4,
        min=0.02,
        soft_max=3.0,
        precision=2,
    )
    surface_embed_mm: FloatProperty(
        name="Embed Into Terrain (mm)",
        description=(
            "How far roads, land surfaces, buildings, and piers reach below the "
            "terrain surface. Their undersides follow the ground, so this only "
            "has to make the solids overlap in the slicer; anything more is "
            "colour buried inside the terrain"
        ),
        default=0.15,
        min=0.02,
        soft_max=1.0,
        precision=2,
    )

    # ------------------------------------------------------------- vegetation
    tree_spacing_m: FloatProperty(
        name="Tree Spacing (m)",
        description="Forest scatter spacing; finished crowns also keep a small print-space gap",
        default=26.0,
        min=2.0,
        soft_max=200.0,
        precision=1,
    )
    tree_minimum_height_mm: FloatProperty(
        name="Minimum Tree Height (mm)",
        description=(
            "Minimum finished tree height after variation, independent of crown width"
        ),
        default=1.6,
        min=0.05,
        soft_max=10.0,
        precision=2,
    )
    tree_minimum_width_mm: FloatProperty(
        name="Minimum Tree Width (mm)",
        description="Minimum foliage base width across flats after variation",
        default=1.1, min=0.1, soft_max=5.0, precision=2,
    )
    tree_size_variation: FloatProperty(
        name="Size Variation",
        description="Random tree scaling, always clamped to the minimum printable dimensions",
        default=0.18, min=0.0, max=0.8, subtype="FACTOR",
    )
    maximum_trees: IntProperty(
        name="Maximum Trees",
        description="Hard cap on generated tree objects",
        default=24000,
        min=0,
        soft_max=100000,
        max=500000,
    )
    include_mapped_trees: BoolProperty(
        name="Mapped Trees",
        description="Place individually mapped Overture tree points",
        default=True,
    )
    include_forest_scatter: BoolProperty(
        name="Scatter in Forests",
        description="Fill forest and wood polygons with a deterministic tree scatter",
        default=True,
    )
    include_land_cover_scatter: BoolProperty(
        name="Scatter in Satellite Forest",
        description=(
            "Also scatter trees in coarse land_cover forest polygons, which is "
            "where wooded hillsides come from when nobody mapped the trees. "
            "Regional polygons and cut water are never planted"
        ),
        default=True,
    )

    # ---------------------------------------------------------- feature toggles
    merge_buildings_and_trees: BoolProperty(
        name="Merge Buildings and Trees",
        description=(
            "Build every building as one BUILDINGS object and every tree as one "
            "TREES object instead of one object per feature, so the outliner "
            "stays usable and post-processing is one selection. Turn off to "
            "get one object per building with its source metadata attached"
        ),
        default=True,
    )
    generate_terrain: BoolProperty(name="Terrain", default=True)
    generate_buildings: BoolProperty(name="Buildings", default=True)
    generate_roads: BoolProperty(name="Roads", default=True)
    generate_bridges: BoolProperty(name="Bridges", default=True)
    generate_water: BoolProperty(name="Water", default=True)
    generate_land_surfaces: BoolProperty(name="Parks and Land Cover", default=True)
    generate_trees: BoolProperty(name="Trees", default=True)

    # ------------------------------------------------------------------ cache
    cache_directory: StringProperty(
        name="Cache Directory",
        description="Local directory for downloaded Overture GeoJSON and manifests",
        default=_default_cache_directory(),
        subtype="DIR_PATH",
    )
    overture_python_path: StringProperty(
        name="Override",
        description=(
            "Use a different downloader Python for this scene only. Normally "
            "left blank: the add-on preference applies to every scene"
        ),
        default="",
        subtype="FILE_PATH",
    )
    force_redownload: BoolProperty(
        name="Refresh Existing Cache",
        description="Replace matching cached files with data from the current release",
        default=False,
    )
    last_status: StringProperty(name="Status", default="Ready")
    generation_running: BoolProperty(default=False, options={"SKIP_SAVE"})
    generation_phase: StringProperty(name="Generation phase", default="", options={"SKIP_SAVE"})
    generation_progress: FloatProperty(name="Progress", default=0.0, min=0.0, max=1.0,
                                       subtype="FACTOR", options={"SKIP_SAVE"})


CLASSES = (JARVIZAR_AP_preferences, JARVIZAR_PG_city_model_settings)


def register_scene_properties() -> None:
    bpy.types.Scene.jarvizar_city_model = PointerProperty(
        type=JARVIZAR_PG_city_model_settings
    )


def unregister_scene_properties() -> None:
    if hasattr(bpy.types.Scene, "jarvizar_city_model"):
        del bpy.types.Scene.jarvizar_city_model
