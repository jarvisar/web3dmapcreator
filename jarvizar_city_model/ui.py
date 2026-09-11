"""N-panel user interface for the Jarvizar miniature workflow."""

from __future__ import annotations

from pathlib import Path
import textwrap

import bpy
from bpy.types import Panel

from .data.projection import WGS84Bounds
from .blender.generation_modal import active_session, is_generating


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
        for line in textwrap.wrap(message, width=max(25, int(region_width/7)-6)):
            box.label(text=line)
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
    lines = [f"Ratio 1:{1000.0 / scale:,.0f}"]
    try:
        bounds = WGS84Bounds(
            west=float(settings.west),
            south=float(settings.south),
            east=float(settings.east),
            north=float(settings.north),
        )
    except (TypeError, ValueError):
        return lines + ["Bounding box is not valid decimal degrees"]

    import math

    latitude = math.radians(bounds.center_latitude)
    width_m = math.radians(bounds.width_degrees) * 6_378_137.0 * math.cos(latitude)
    height_m = math.radians(bounds.height_degrees) * 6_378_137.0
    lines.append(f"Model about {width_m * scale:.0f} x {height_m * scale:.0f} mm")
    lines.append(
        f"{settings.minimum_road_width_mm:.2f} mm road = "
        f"{settings.minimum_road_width_mm / scale:.1f} m real"
    )
    lines.append(
        f"{settings.maximum_road_width_mm:.2f} mm cap = "
        f"{settings.maximum_road_width_mm / scale:.1f} m real"
    )
    return lines


class JARVIZAR_PT_city_model(Panel):
    bl_label = "Jarvizar City Model"
    bl_idname = "JARVIZAR_PT_city_model"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "City Model"

    def draw(self, context):
        layout = self.layout
        settings = context.scene.jarvizar_city_model

        if settings.lidar_preparing:
            _lidar_progress(layout, settings, context.region.width)

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
        box.label(text="WGS84 Bounding Box")
        grid = box.grid_flow(columns=2, align=True)
        grid.prop(settings, "west")
        grid.prop(settings, "east")
        grid.prop(settings, "south")
        grid.prop(settings, "north")
        # blender-osm copies "west,south,east,north" as one line; pasting that
        # whole line beats editing four fields by hand.  The button gets its
        # own row because at the default sidebar width a shared row truncates
        # the heading to "WGS84 Boun...".
        box.operator("jarvizar.paste_bounds", text="Paste Coordinates", icon="PASTEDOWN")

        box = layout.box()
        box.label(text="Print Scale")
        box.prop(settings, "scale_mode", text="")
        if settings.scale_mode == "FIXED":
            box.prop(settings, "mm_per_metre")
            for line in _scale_summary(settings):
                box.label(text=line)
        else:
            box.prop(settings, "target_width_mm")
            box.prop(settings, "target_height_mm")
            box.prop(settings, "preserve_aspect_ratio")
        box.prop(settings, "set_scene_units")

        box = layout.box()
        box.label(text="Features", icon="OUTLINER")
        column = box.column(align=True)
        column.prop(settings, "generate_terrain")
        column.prop(settings, "generate_land_surfaces")
        column.prop(settings, "generate_water")
        column.prop(settings, "generate_roads")
        column.prop(settings, "generate_bridges")
        column.prop(settings, "generate_trees")
        column.prop(settings, "generate_buildings")
        box.prop(settings, "merge_buildings_and_trees")

        box = layout.box()
        box.label(text="Overture Cache", icon="IMPORT")
        box.prop(settings, "cache_directory")
        from .config import preferred_python_path

        stored = preferred_python_path().strip()
        # An empty override box reads as "nothing is configured" unless the
        # panel says plainly what will actually be used, so it always does.
        if stored:
            box.label(text="Overture Python is set", icon="CHECKMARK")
            tail = Path(stored)
            box.label(text=f"...{Path(tail.parent.parent.name) / tail.parent.name / tail.name}")
        else:
            box.label(text="No Overture Python set", icon="ERROR")
            box.label(text="Add it in Preferences > Add-ons")
        box.prop(settings, "overture_python_path")
        box.prop(settings, "force_redownload")
        box.operator("jarvizar.download_cache", icon="IMPORT")

        layout.operator("jarvizar.generate_model", icon="MESH_CUBE")
        box = layout.box()
        box.prop(settings, "multi_plate_export")
        if settings.multi_plate_export:
            box.prop(settings, "section_width_mm")
            box.prop(settings, "section_height_mm")
        box.operator("jarvizar.export_3mf", icon="EXPORT")
        layout.operator("jarvizar.clear_model", icon="TRASH")
        status = layout.box()
        status.label(text=settings.last_status, icon="INFO")


class JARVIZAR_PT_terrain(Panel):
    bl_label = "Terrain"
    bl_idname = "JARVIZAR_PT_terrain"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "City Model"
    bl_parent_id = "JARVIZAR_PT_city_model"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        layout = self.layout
        layout.enabled = not is_generating()
        settings = context.scene.jarvizar_city_model
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


class JARVIZAR_PT_surfaces(Panel):
    bl_label = "Ground Surfaces"
    bl_idname = "JARVIZAR_PT_surfaces"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "City Model"
    bl_parent_id = "JARVIZAR_PT_city_model"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        layout = self.layout
        layout.enabled = not is_generating()
        settings = context.scene.jarvizar_city_model
        layout.prop(settings, "surface_rise_mm")
        layout.prop(settings, "surface_embed_mm")
        box = layout.box()
        box.label(text="Surface Priority")
        box.label(text="Highest priority first")
        order = settings.surface_order()
        for index, category in enumerate(order):
            row = box.row(align=True)
            row.label(text="Greens" if category == "green" else category.title())
            for direction, icon in ((-1, "TRIA_UP"), (1, "TRIA_DOWN")):
                button = row.row(align=True)
                button.enabled = 0 <= index + direction < len(order)
                move = button.operator("jarvizar.move_surface_priority", text="", icon=icon)
                move.index, move.direction = index, direction
        layout.prop(settings, "cut_water_from_terrain")
        column = layout.column(align=True)
        column.enabled = settings.cut_water_from_terrain
        column.prop(settings, "minimum_water_cut_area_m2")
        column = layout.column(align=True)
        column.enabled = settings.generate_terrain and (
            settings.cut_water_from_terrain or settings.recess_ponds_and_fountains)
        column.prop(settings, "support_structures_over_water")
        layout.prop(settings, "water_thickness_mm")
        box = layout.box()
        box.label(text="Ponds, Fountains and Basins")
        box.prop(settings, "recess_ponds_and_fountains")
        column = box.column(align=True)
        column.enabled = settings.recess_ponds_and_fountains and settings.generate_terrain
        column.prop(settings, "pond_recess_depth_mm")
        column.prop(settings, "pond_water_thickness_mm")
        gap = settings.pond_recess_depth_mm - settings.pond_water_thickness_mm
        row = column.row()
        row.alert = gap < -1e-6
        row.label(text=(f"Water below bank: {max(0.0, gap):.2f} mm" if gap >= -1e-6
                        else "Water thickness must not exceed depth"))
        if settings.recess_ponds_and_fountains and not settings.generate_terrain:
            box.label(text="Enable Terrain to build basins")
        layout.separator()
        layout.label(text="Trees")
        layout.prop(settings, "include_mapped_trees")
        layout.prop(settings, "include_forest_scatter")
        layout.prop(settings, "include_land_cover_scatter")
        layout.prop(settings, "tree_spacing_m")
        layout.prop(settings, "tree_minimum_height_mm")
        layout.prop(settings, "tree_minimum_width_mm")
        layout.prop(settings, "tree_size_variation")
        layout.prop(settings, "maximum_trees")


class JARVIZAR_PT_transport(Panel):
    bl_label = "Roads and Bridges"
    bl_idname = "JARVIZAR_PT_transport"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "City Model"
    bl_parent_id = "JARVIZAR_PT_city_model"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        layout = self.layout
        layout.enabled = not is_generating()
        settings = context.scene.jarvizar_city_model
        layout.prop(settings, "road_thickness_mm")
        layout.prop(settings, "minimum_road_width_mm")
        layout.prop(settings, "maximum_road_width_mm")
        layout.prop(settings, "include_minor_roads")
        row = layout.row()
        row.enabled = settings.include_minor_roads
        row.prop(settings, "skip_sidepaths")
        layout.prop(settings, "include_rail")
        layout.separator()
        column = layout.column(align=True)
        column.enabled = settings.generate_bridges
        column.prop(settings, "bridge_deck_thickness_mm")
        column.prop(settings, "bridge_clearance_mm")
        column.prop(settings, "bridge_maximum_grade")
        column.prop(settings, "bridge_minimum_lift_mm")
        column.prop(settings, "bridge_support_spacing_m")
        column.prop(settings, "bridge_support_minimum_size_mm")
        column.prop(settings, "bridge_causeway_margin_mm")


class JARVIZAR_PT_buildings(Panel):
    bl_label = "Buildings"
    bl_idname = "JARVIZAR_PT_buildings"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "City Model"
    bl_parent_id = "JARVIZAR_PT_city_model"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        layout = self.layout
        layout.enabled = not is_generating()
        settings = context.scene.jarvizar_city_model
        layout.prop(settings, "default_building_height_m")
        layout.prop(settings, "floor_height_m")
        layout.prop(settings, "building_height_scale")
        layout.prop(settings, "minimum_building_height_mm")
        layout.prop(settings, "minimum_height_footprint_mm")
        layout.prop(settings, "generate_roof_shapes")
        box = layout.box()
        box.label(text="LiDAR Buildings")
        box.prop(settings, "use_lidar_buildings")
        box.prop(settings, "lidar_prefer_measured")
        roof_row = box.row()
        roof_row.enabled = settings.generate_roof_shapes
        roof_row.prop(settings, "lidar_roof_mode")
        if settings.lidar_roof_mode == 'TERRACES':
            box.prop(settings, "lidar_minimum_width_mm")
            box.prop(settings, "lidar_minimum_step_mm")
        box.prop(settings, "lidar_source_url")
        box.prop(settings, "lidar_international")
        box.prop(settings, "lidar_stac_urls")
        box.prop(settings, "lidar_vertical_units")
        box.prop(settings, "lidar_manifest_url")
        download_row = box.row()
        download_row.enabled = not settings.lidar_preparing
        download_row.prop(settings, "lidar_download_workers")
        box.operator("jarvizar.prepare_lidar", icon="IMPORT")
        box.label(text='EPT / COPC stream automatically')
        box.label(text='LAZ / LAS downloads require your choice')
        if settings.lidar_laz_offer_token:
            offer = box.box()
            offer.label(text='LAZ / LAS gaps or upgrades available', icon='INFO')
            offer.label(text='Potential improvements; recovery is not guaranteed')
            for paragraph in settings.lidar_laz_offer_details.splitlines():
                for line in textwrap.wrap(paragraph, width=max(25, int(context.region.width/7)-6)):
                    offer.label(text=line)
            row = offer.row()
            row.enabled = not settings.lidar_preparing
            row.operator('jarvizar.prepare_lidar', text='Download and Use Offered Tiles', icon='IMPORT').laz_approval = settings.lidar_laz_offer_token
            offer.label(text='Optional: keep current streamed coverage')
        if settings.lidar_preparing:
            box.label(text='Preparing in background; Esc cancels', icon='TIME')
        else:
            box.label(text="Prepare after caching buildings")
        for title, message in (('Preparation', settings.lidar_preparation_status),
                               ('Last generation', settings.lidar_generation_status)):
            if message:
                box.label(text=title+':')
                for line in textwrap.wrap(message, width=max(25, int(context.region.width/7)-6)):
                    box.label(text=line)
        layout.separator()
        layout.label(text="Printability")
        layout.prop(settings, "minimum_building_width_mm")
        layout.prop(settings, "maximum_building_slenderness")
        layout.prop(settings, "slenderness_exempt_width_mm")


CLASSES = (
    JARVIZAR_PT_city_model,
    JARVIZAR_PT_terrain,
    JARVIZAR_PT_surfaces,
    JARVIZAR_PT_transport,
    JARVIZAR_PT_buildings,
)
