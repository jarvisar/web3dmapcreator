"""N-panel user interface for the Jarvizar miniature workflow.

The main panel is the workflow in the order it is used: area, scale, the
download/generate/export actions, then the last result.  Settings chosen once
or rarely sit in closed sub-panels below it.  A feature's switch is its
sub-panel's header checkbox, so the closed headers double as the feature list.
"""

from __future__ import annotations

import math
import os
from pathlib import Path
import textwrap

import bpy
from bpy.types import Menu, Panel

from .data.bounds_presets import load_presets
from .data.projection import WGS84Bounds
from .blender.generation_modal import active_session, is_generating


def _wrapped(layout, text, region_width, limit=0, icon="NONE"):
    """Draw text as tightly spaced wrapped labels, at most ``limit`` lines.

    Status and offer messages grow with the selection; an uncapped message
    pushes every control beneath it off the screen.
    """
    width = max(25, int(region_width / 7) - 6)
    lines = [line for paragraph in text.splitlines()
             for line in textwrap.wrap(paragraph, width=width)]
    if limit and len(lines) > limit:
        lines = lines[:limit]
        lines[-1] = lines[-1][:width - 3] + "..."
    column = layout.column(align=True)
    column.scale_y = 0.8
    for index, line in enumerate(lines):
        column.label(text=line, icon=icon if index == 0 else "NONE")


def _heading(layout, text):
    layout.separator()
    layout.label(text=text)


def _labelled(layout, data, name, text=""):
    """A path, URL or choice under its own label; sharing a row truncates both."""
    column = layout.column(align=True)
    column.label(text=text or data.bl_rna.properties[name].name)
    column.prop(data, name, text="")


def _lidar_progress(layout, settings, region_width):
    box = layout.box()
    box.label(text='Preparing LiDAR', icon='TIME')
    box.label(text=settings.lidar_progress_stage)
    if settings.lidar_progress_known:
        row = box.row()
        row.enabled = False
        row.prop(settings, 'lidar_progress', text='Current survey', slider=True)
    for message in (settings.lidar_progress_scope, settings.lidar_progress_source,
                    settings.lidar_preparation_status, settings.lidar_progress_reuse):
        _wrapped(box, message, region_width, limit=4)
    elapsed = settings.lidar_elapsed_seconds
    box.label(text=f'Elapsed {elapsed//60}:{elapsed%60:02d}')
    if settings.lidar_update_seconds >= 5:
        box.label(text=f'Last worker update: {settings.lidar_update_seconds}s ago')
    box.operator('jarvizar.cancel_lidar', icon='CANCEL')


def _scale_summary(settings):
    """Describe what the chosen scale means before anything is generated.

    The consequences of a print scale are not obvious from the number itself:
    it decides the finished size and, more importantly, how much real street
    the minimum printable ribbon width consumes.
    """
    scale = float(settings.mm_per_metre)
    if scale <= 0.0:
        return ["Scale must be greater than zero"]
    # Each line fits the narrowest sidebar; longer ones are cut mid-number.
    ratio = f"1:{1000.0 / scale:,.0f}"
    roads = [
        f"{settings.minimum_road_width_mm:.2f} mm road = "
        f"{settings.minimum_road_width_mm / scale:.1f} m real",
        f"{settings.maximum_road_width_mm:.2f} mm cap = "
        f"{settings.maximum_road_width_mm / scale:.1f} m real",
    ]
    try:
        bounds = WGS84Bounds(
            west=float(settings.west),
            south=float(settings.south),
            east=float(settings.east),
            north=float(settings.north),
        )
    except (TypeError, ValueError):
        return [f"Ratio {ratio}", "Bounding box is not valid decimal degrees", *roads]

    latitude = math.radians(bounds.center_latitude)
    width_m = math.radians(bounds.width_degrees) * 6_378_137.0 * math.cos(latitude)
    height_m = math.radians(bounds.height_degrees) * 6_378_137.0
    return [f"{width_m * scale:.0f} x {height_m * scale:.0f} mm at {ratio}", *roads]


def _python_configured(settings):
    from .config import preferred_python_path

    return bool(settings.overture_python_path.strip() or preferred_python_path().strip()
                or os.environ.get("JARVIZAR_OVERTURE_PYTHON", "").strip())


def _offer_detail_lines(details, areas=3):
    """Offer details with each survey's area list cut to its first entries.

    Everything else in an offer is a fixed handful of lines; the areas are one
    line per building cluster, without a bound.
    """
    lines, run = [], 0
    for line in details.splitlines():
        if line.startswith("Area W/S/E/N"):
            run += 1
            if run > areas:
                continue
        else:
            if run > areas:
                lines.append(f"... and {run - areas} more areas")
            run = 0
        lines.append(line)
    return lines


class JARVIZAR_MT_bounds_presets(Menu):
    bl_label = "Bounding Box Presets"
    bl_idname = "JARVIZAR_MT_bounds_presets"

    def draw(self, context):
        presets = load_presets()
        for name, bounds in presets:
            self.layout.operator("jarvizar.paste_bounds", text=name).text = bounds
        if not presets:
            self.layout.label(text="No presets in data/bounds_presets.txt")


class JARVIZAR_PT_city_model(Panel):
    bl_label = "Jarvizar City Model"
    bl_idname = "JARVIZAR_PT_city_model"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "City Model"

    def draw(self, context):
        layout = self.layout
        settings = context.scene.jarvizar_city_model
        width = context.region.width

        if settings.lidar_preparing:
            _lidar_progress(layout, settings, width)

        session = active_session()
        if session is not None:
            box = layout.box()
            box.label(text=session.phase, icon="TIME")
            box.label(text=f"{session.fraction * 100:.0f}% complete")
            box.label(text="Previous model retained")
            box.operator("jarvizar.cancel_generation", icon="CANCEL")
            box.label(text="Esc also cancels")
            return

        box = layout.box()
        row = box.row()
        row.label(text="Area", icon="WORLD")
        row.menu("JARVIZAR_MT_bounds_presets", text="Presets")
        # One field per row, in the order every bbox source writes them: two
        # to a row showed "-8..." at the default sidebar width.
        column = box.column(align=True)
        for name in ("west", "south", "east", "north"):
            column.prop(settings, name)
        # blender-osm copies "west,south,east,north" as one line; pasting that
        # whole line beats editing four fields by hand.  The button gets its
        # own row: at the default sidebar width the heading row only has room
        # for the short Presets menu.
        box.operator("jarvizar.paste_bounds", text="Paste Coordinates", icon="PASTEDOWN")

        box = layout.box()
        box.label(text="Print Scale", icon="DRIVER_DISTANCE")
        box.prop(settings, "scale_mode", text="")
        if settings.scale_mode == "FIXED":
            box.prop(settings, "mm_per_metre", text="mm per metre")
            _wrapped(box, "\n".join(_scale_summary(settings)), width)
        else:
            column = box.column(align=True)
            column.prop(settings, "target_width_mm")
            column.prop(settings, "target_height_mm")
            box.prop(settings, "preserve_aspect_ratio")

        # The workflow, top to bottom.  Generate is the one button pressed on
        # every iteration, so it is the largest target.
        column = layout.column()
        if not _python_configured(settings):
            row = column.row()
            row.alert = True
            _wrapped(row, "Overture Python not set; see Setup and Cache", width, icon="ERROR")
        row = column.row()
        row.scale_y = 1.2
        row.operator("jarvizar.download_cache", icon="IMPORT")
        if settings.use_lidar_buildings:
            row = column.row()
            row.scale_y = 1.2
            row.operator("jarvizar.prepare_lidar", icon="IMPORT")
            if settings.lidar_laz_offer_token:
                _wrapped(column, "Optional tiles offered; see LiDAR Buildings", width, icon="INFO")
        column.prop(settings, "force_redownload")
        row = column.row()
        row.scale_y = 1.6
        row.operator("jarvizar.generate_model", icon="MESH_CUBE")

        box = layout.box()
        box.prop(settings, "bambu_printer", text="Printer")
        box.prop(settings, "multi_plate_export")
        if settings.multi_plate_export:
            column = box.column(align=True)
            column.prop(settings, "section_width_mm")
            column.prop(settings, "section_height_mm")
        row = box.row()
        row.scale_y = 1.2
        row.operator("jarvizar.export_3mf", icon="EXPORT")

        _wrapped(layout.box(), settings.last_status, width, limit=4, icon="INFO")
        layout.operator("jarvizar.clear_model", icon="TRASH")


def _panel(panel, context, feature=""):
    """Layout and settings of a sub-panel: locked while a model generates and
    greyed, though still editable, while its header feature is switched off."""
    layout = panel.layout
    settings = context.scene.jarvizar_city_model
    layout.enabled = not is_generating()
    if feature:
        layout.active = getattr(settings, feature)
    return layout, settings


class _SubPanel:
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "City Model"
    bl_parent_id = "JARVIZAR_PT_city_model"
    bl_options = {"DEFAULT_CLOSED"}
    feature = ""

    def draw_header(self, context):
        if self.feature:
            self.layout.enabled = not is_generating()
            self.layout.prop(context.scene.jarvizar_city_model, self.feature, text="")


class JARVIZAR_PT_terrain(_SubPanel, Panel):
    bl_label = "Terrain"
    bl_idname = "JARVIZAR_PT_terrain"
    feature = "generate_terrain"

    def draw(self, context):
        layout, settings = _panel(self, context, "generate_terrain")
        layout.prop(settings, "terrain_source")
        layout.prop(settings, "terrain_resolution")
        layout.prop(settings, "terrain_smoothing")
        row = layout.row()
        row.enabled = settings.terrain_source == "DEM"
        row.prop(settings, "terrain_exaggeration")
        layout.prop(settings, "base_thickness_mm")
        layout.separator()
        layout.prop(settings, "generate_border_rim")
        column = layout.column(align=True)
        column.enabled = settings.generate_border_rim
        column.prop(settings, "border_rim_height_mm")
        column.prop(settings, "border_rim_width_mm")


class JARVIZAR_PT_surfaces(_SubPanel, Panel):
    bl_label = "Parks and Land Cover"
    bl_idname = "JARVIZAR_PT_surfaces"
    feature = "generate_land_surfaces"

    def draw(self, context):
        layout, settings = _panel(self, context, "generate_land_surfaces")
        column = layout.column(align=True)
        column.prop(settings, "surface_rise_mm")
        column.prop(settings, "surface_embed_mm")
        layout.prop(settings, "taper_beaches")
        row = layout.row()
        row.enabled = settings.taper_beaches
        row.prop(settings, "beach_taper_width_mm")
        box = layout.box()
        box.label(text="Surface Priority (highest first)")
        order = settings.surface_order()
        for index, category in enumerate(order):
            row = box.row(align=True)
            row.label(text="Greens" if category == "green" else category.title())
            for direction, icon in ((-1, "TRIA_UP"), (1, "TRIA_DOWN")):
                button = row.row(align=True)
                button.enabled = 0 <= index + direction < len(order)
                move = button.operator("jarvizar.move_surface_priority", text="", icon=icon)
                move.index, move.direction = index, direction


class JARVIZAR_PT_water(_SubPanel, Panel):
    bl_label = "Water"
    bl_idname = "JARVIZAR_PT_water"
    feature = "generate_water"

    def draw(self, context):
        # The header switches the water fill only: terrain cuts and basin
        # recesses remain without it, so their settings are never greyed.
        layout, settings = _panel(self, context)
        row = layout.row()
        row.active = settings.generate_water
        row.prop(settings, "water_thickness_mm")
        layout.prop(settings, "cut_water_from_terrain")
        row = layout.row()
        row.enabled = settings.cut_water_from_terrain
        row.prop(settings, "minimum_water_cut_area_m2")
        row = layout.row()
        recessing = settings.recess_ponds_and_fountains and not settings.skip_ponds_and_fountains
        row.enabled = settings.generate_terrain and (settings.cut_water_from_terrain or recessing)
        row.prop(settings, "support_structures_over_water")
        _heading(layout, "Ponds, Fountains and Basins")
        layout.prop(settings, "skip_ponds_and_fountains")
        row = layout.row()
        row.enabled = not settings.skip_ponds_and_fountains
        row.prop(settings, "recess_ponds_and_fountains")
        column = layout.column(align=True)
        column.enabled = recessing and settings.generate_terrain
        column.prop(settings, "pond_recess_depth_mm")
        column.prop(settings, "pond_water_thickness_mm")
        gap = settings.pond_recess_depth_mm - settings.pond_water_thickness_mm
        row = column.row()
        row.alert = gap < -1e-6
        row.label(text=(f"Water below bank: {max(0.0, gap):.2f} mm" if gap >= -1e-6
                        else "Water thickness must not exceed depth"))
        if recessing and not settings.generate_terrain:
            layout.label(text="Enable Terrain to build basins")


class JARVIZAR_PT_transport(_SubPanel, Panel):
    bl_label = "Roads"
    bl_idname = "JARVIZAR_PT_transport"
    feature = "generate_roads"

    def draw(self, context):
        layout, settings = _panel(self, context, "generate_roads")
        column = layout.column(align=True)
        column.prop(settings, "road_thickness_mm")
        column.prop(settings, "minimum_road_width_mm")
        column.prop(settings, "maximum_road_width_mm")
        layout.prop(settings, "include_minor_roads")
        row = layout.row()
        row.enabled = settings.include_minor_roads
        row.prop(settings, "skip_sidepaths")
        layout.prop(settings, "include_rail")
        layout.prop(settings, "tidy_road_network")
        row = layout.row()
        row.enabled = settings.tidy_road_network
        row.prop(settings, "road_gap_mm")


class JARVIZAR_PT_bridges(_SubPanel, Panel):
    bl_label = "Bridges"
    bl_idname = "JARVIZAR_PT_bridges"
    feature = "generate_bridges"

    def draw(self, context):
        layout, settings = _panel(self, context, "generate_bridges")
        column = layout.column(align=True)
        column.prop(settings, "bridge_deck_thickness_mm")
        column.prop(settings, "bridge_clearance_mm")
        column.prop(settings, "bridge_maximum_grade")
        column.prop(settings, "bridge_minimum_lift_mm")
        column = layout.column(align=True)
        column.prop(settings, "bridge_support_spacing_m")
        column.prop(settings, "bridge_support_minimum_size_mm")
        column.prop(settings, "bridge_causeway_margin_mm")


class JARVIZAR_PT_trees(_SubPanel, Panel):
    bl_label = "Trees"
    bl_idname = "JARVIZAR_PT_trees"
    feature = "generate_trees"

    def draw(self, context):
        layout, settings = _panel(self, context, "generate_trees")
        layout.prop(settings, "tree_avoid_roads")
        layout.prop(settings, "include_mapped_trees")
        layout.prop(settings, "include_forest_scatter")
        layout.prop(settings, "include_land_cover_scatter")
        column = layout.column(align=True)
        column.prop(settings, "tree_spacing_m")
        column.prop(settings, "tree_size_variation")
        column.prop(settings, "maximum_trees")
        column = layout.column(align=True)
        column.prop(settings, "tree_minimum_height_mm")
        column.prop(settings, "tree_minimum_width_mm")
        layout.prop(settings, "merge_buildings_and_trees")


class JARVIZAR_PT_buildings(_SubPanel, Panel):
    bl_label = "Buildings"
    bl_idname = "JARVIZAR_PT_buildings"
    feature = "generate_buildings"

    def draw(self, context):
        layout, settings = _panel(self, context, "generate_buildings")
        column = layout.column(align=True)
        column.prop(settings, "default_building_height_m")
        column.prop(settings, "floor_height_m")
        column.prop(settings, "building_height_scale")
        layout.prop(settings, "generate_roof_shapes")
        layout.prop(settings, "retain_sparse_building_parents")
        layout.prop(settings, "merge_buildings_and_trees")
        _heading(layout, "Printability")
        column = layout.column(align=True)
        column.prop(settings, "minimum_building_height_mm")
        column.prop(settings, "minimum_height_footprint_mm")
        column = layout.column(align=True)
        column.prop(settings, "minimum_building_width_mm")
        column.prop(settings, "maximum_building_slenderness")
        column.prop(settings, "slenderness_exempt_width_mm")


class JARVIZAR_PT_lidar(_SubPanel, Panel):
    bl_label = "LiDAR Buildings"
    bl_idname = "JARVIZAR_PT_lidar"
    feature = "use_lidar_buildings"

    def draw(self, context):
        # Never greyed by its header: preparing comes first and a successful
        # preparation switches Use Prepared LiDAR on by itself.
        layout, settings = _panel(self, context)
        width = context.region.width
        row = layout.row()
        row.scale_y = 1.2
        row.operator("jarvizar.prepare_lidar", icon="IMPORT")
        if settings.lidar_preparing:
            layout.label(text='Preparing in background; Esc cancels', icon='TIME')
        else:
            layout.label(text="Prepare after caching buildings")

        if settings.lidar_laz_offer_token:
            offer = layout.box()
            _wrapped(offer, 'LAZ / LAS gaps or upgrades available', width, icon='INFO')
            _wrapped(offer, settings.lidar_laz_offer_summary
                     or settings.lidar_laz_offer_details.split('\n', 1)[0], width, limit=8)
            row = offer.row()
            row.enabled = not settings.lidar_preparing
            row.operator('jarvizar.prepare_lidar', text='Download Offered Tiles', icon='IMPORT').laz_approval = settings.lidar_laz_offer_token
            _wrapped(offer, 'Optional; recovery is not guaranteed. Skip to keep current streamed coverage.', width)
            shown = settings.show_laz_offer_details
            offer.prop(settings, 'show_laz_offer_details', emboss=False,
                       icon='TRIA_DOWN' if shown else 'TRIA_RIGHT')
            if shown:
                _wrapped(offer, '\n'.join(_offer_detail_lines(settings.lidar_laz_offer_details)), width)

        layout.prop(settings, "lidar_minimum_footprint_area_mm2", text="Min Footprint (mm²)")
        layout.prop(settings, "lidar_height_only")
        layout.prop(settings, "lidar_prefer_measured")
        rock_row = layout.row()
        rock_row.enabled = not settings.lidar_height_only
        rock_row.prop(settings, "lidar_rock_surfaces", text="Mapped Rock Surfaces")
        roof_row = layout.row()
        roof_row.enabled = settings.generate_roof_shapes and not settings.lidar_height_only
        roof_row.prop(settings, "lidar_roof_mode", text="Roofs")
        if settings.lidar_height_only:
            layout.label(text="Preserves shapes; skips roof reconstruction")
        elif settings.lidar_roof_mode == 'TERRACES':
            column = layout.column(align=True)
            column.prop(settings, "lidar_minimum_width_mm")
            column.prop(settings, "lidar_minimum_step_mm")

        for title, message in (('Last preparation', settings.lidar_preparation_status),
                               ('Last generation', settings.lidar_generation_status)):
            if message:
                _heading(layout, title)
                _wrapped(layout, message, width, limit=10)


class JARVIZAR_PT_lidar_sources(_SubPanel, Panel):
    bl_label = "Sources and Downloads"
    bl_idname = "JARVIZAR_PT_lidar_sources"
    bl_parent_id = "JARVIZAR_PT_lidar"

    def draw(self, context):
        layout, settings = _panel(self, context)
        _wrapped(layout, 'EPT / COPC stream automatically\nLAZ / LAS downloads require your choice',
                 context.region.width)
        layout.prop(settings, "lidar_international", text="International Discovery")
        for name in ("lidar_source_url", "lidar_stac_urls", "lidar_manifest_url", "lidar_vertical_units"):
            _labelled(layout, settings, name)
        row = layout.row()
        row.enabled = not settings.lidar_preparing
        row.prop(settings, "lidar_download_workers")


class JARVIZAR_PT_setup(_SubPanel, Panel):
    bl_label = "Setup and Cache"
    bl_idname = "JARVIZAR_PT_setup"

    def draw(self, context):
        from .config import preferred_python_path

        layout, settings = _panel(self, context)
        _labelled(layout, settings, "cache_directory")

        _heading(layout, "Overture Python")
        stored = preferred_python_path().strip()
        # An empty override box reads as "nothing is configured" unless the
        # panel says plainly what will actually be used, so it always does.
        if stored:
            tail = Path(stored)
            layout.label(text=f"...{Path(tail.parent.parent.name) / tail.parent.name / tail.name}",
                         icon="CHECKMARK")
        else:
            _wrapped(layout, "Not set in Preferences > Add-ons", context.region.width, icon="ERROR")
        _labelled(layout, settings, "overture_python_path", text="Override for this scene")

        _heading(layout, "LiDAR Storage")
        addon = context.preferences.addons.get(__package__)
        if addon:
            column = layout.column(align=True)
            column.prop(addon.preferences, 'lidar_cache_gib')
            column.prop(addon.preferences, 'lidar_free_gib')
        layout.operator('jarvizar.cache_storage', text='Review Cache Cleanup', icon='DISK_DRIVE')

        _heading(layout, "Scene")
        layout.prop(settings, "set_scene_units")


CLASSES = (
    JARVIZAR_MT_bounds_presets,
    JARVIZAR_PT_city_model,
    JARVIZAR_PT_terrain,
    JARVIZAR_PT_surfaces,
    JARVIZAR_PT_water,
    JARVIZAR_PT_transport,
    JARVIZAR_PT_bridges,
    JARVIZAR_PT_trees,
    JARVIZAR_PT_buildings,
    JARVIZAR_PT_lidar,
    JARVIZAR_PT_lidar_sources,
    JARVIZAR_PT_setup,
)
