"""Blender operators for caching, generating, and clearing city models."""

from __future__ import annotations

import json
from pathlib import Path

import bpy
import mathutils
from bpy.types import Operator
from bpy_extras.io_utils import ExportHelper

from .blender.collections import (
    clear_generated,
    create_city_hierarchy,
    generated_objects,
)
from .blender.materials import model_materials
from .data.cache import (
    ALL_TYPES,
    BUILDING_TYPES,
    Bounds,
    CacheBundle,
    INFRASTRUCTURE_TYPES,
    LAND_TYPES,
    ROAD_TYPES,
    WATER_TYPES,
)
from .data.dem import DEMTerrain, ElevationGrid, ElevationGridError
from .data.geojson import load_feature_collection, polygon_features
from .config import preferred_python_path
from .data.overture import (
    OvertureDownloadError,
    download_dem_to_cache,
    download_to_cache,
    resolve_python,
)
from .data.projection import (
    BOUNDS_TEXT_EXAMPLE,
    create_fixed_scale_transform,
    create_miniature_transform,
    format_degrees,
    parse_bounds_text,
)
from .geometry.building_generation import generate_buildings
from .geometry.dem_terrain import generate_border_rim, generate_terrain_solid
from .geometry.heightfield import ModelHeightField
from .geometry.roads import RoadSettings, generate_roads
from .geometry.support import SupportBuilder
from .geometry.surfaces import (
    SurfaceSettings,
    cut_water_from_terrain,
    flatten_terrain_under_water,
    generate_land_surfaces,
    generate_water,
    solve_water_bodies,
)
from .geometry.vegetation import TreeSettings, generate_trees


def _bounds_from_settings(settings) -> Bounds:
    try:
        values = tuple(
            float(value.strip())
            for value in (settings.west, settings.south, settings.east, settings.north)
        )
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError("Bounding-box fields must contain decimal degrees") from exc
    return Bounds(*values).validate()


def _cache_bundle(settings) -> CacheBundle:
    cache_root = Path(bpy.path.abspath(settings.cache_directory)).expanduser()
    return CacheBundle(cache_root, _bounds_from_settings(settings))


def _needs_water_data(settings) -> bool:
    """Whether the source water layer is needed, for a slab or for the cut."""
    return bool(settings.generate_water) or bool(
        settings.cut_water_from_terrain and settings.generate_terrain
    )


def _cuts_water(settings) -> bool:
    return bool(settings.cut_water_from_terrain and settings.generate_terrain)


def _required_types(settings) -> tuple:
    """Return the Overture types the current feature selection actually needs."""
    required = []
    if settings.generate_buildings:
        required.extend(BUILDING_TYPES)
    if settings.generate_roads or settings.generate_bridges:
        required.extend(ROAD_TYPES)
    if _needs_water_data(settings):
        required.extend(WATER_TYPES)
    if settings.generate_land_surfaces or settings.generate_trees:
        required.extend(LAND_TYPES)
    if _cuts_water(settings):
        # Piers, quays, and breakwaters are mapped here; the cut needs them to
        # know which ground out over the water is real.
        required.extend(INFRASTRUCTURE_TYPES)
    ordered = []
    for item in ALL_TYPES:
        if item in required and item not in ordered:
            ordered.append(item)
    return tuple(ordered)


def _essential_types(settings) -> tuple:
    """The types generation refuses to run without.

    Infrastructure only refines the water cut, so a cache made before it was
    downloaded still generates; the download operator fetches it next time.
    """
    return tuple(
        item for item in _required_types(settings) if item not in INFRASTRUCTURE_TYPES
    )


def _load_polygons(bundle: CacheBundle, feature_type: str):
    path = bundle.data_path(feature_type)
    if not path.is_file():
        return []
    return list(polygon_features(load_feature_collection(path)))


def _resolve_downloader(context, settings):
    """Find the downloader interpreter, then remember one that worked.

    Filling the path in once and never again is the whole point of keeping it
    in preferences, so a scene-level path that resolves is promoted there when
    nothing is stored yet.
    """
    scene_path = bpy.path.abspath(settings.overture_python_path or "")
    stored = preferred_python_path()
    resolved = resolve_python(scene_path, bpy.path.abspath(stored) if stored else "")
    if not stored.strip() and scene_path.strip():
        addon = context.preferences.addons.get(__package__)
        if addon is not None and hasattr(addon.preferences, "overture_python_path"):
            addon.preferences.overture_python_path = str(resolved)
    return resolved


def _load_features(bundle: CacheBundle, feature_type: str):
    path = bundle.data_path(feature_type)
    if not path.is_file():
        return []
    return load_feature_collection(path)


class JARVIZAR_OT_paste_bounds(Operator):
    bl_idname = "jarvizar.paste_bounds"
    bl_label = "Paste Bounding Box"
    bl_description = (
        "Fill all four bounding-box fields from one line of decimal degrees, "
        "west,south,east,north -- the format the Copy button on "
        "prochitecture.com/blender-osm puts on the clipboard. Reads the "
        "clipboard directly; asks for the text if the clipboard does not hold "
        "a box"
    )
    bl_options = {"REGISTER", "UNDO"}

    # Kept short: the prefill only exists so a nearly-right clipboard can be
    # corrected in place, and a whole pasted document in a dialog field is
    # worse than an empty one.
    PREFILL_LIMIT = 200

    # SKIP_SAVE matters: Blender remembers an operator's properties between
    # runs, so without it the second click of the button would silently reapply
    # the text typed into the dialog on the first instead of reading the
    # clipboard again.
    text: bpy.props.StringProperty(
        name="Coordinates",
        description="west,south,east,north in WGS84 decimal degrees",
        default="",
        options={"SKIP_SAVE"},
    )

    def invoke(self, context, event):
        if self.text.strip():
            # Text passed in by a caller is the answer; only a bare click has
            # to go looking for one.
            return self.execute(context)
        clipboard = str(getattr(context.window_manager, "clipboard", "") or "")
        try:
            parse_bounds_text(clipboard)
        except ValueError:
            # One click is the whole point when the clipboard is good; only a
            # clipboard that cannot answer earns a dialog, prefilled with
            # whatever is there so a typo can be fixed rather than retyped.
            first_line = clipboard.strip().splitlines()
            self.text = first_line[0][: self.PREFILL_LIMIT] if first_line else ""
            return context.window_manager.invoke_props_dialog(self, width=420)
        self.text = clipboard
        return self.execute(context)

    def draw(self, context):
        layout = self.layout
        layout.label(text="Paste west,south,east,north in decimal degrees")
        layout.label(text=f"Example: {BOUNDS_TEXT_EXAMPLE}")
        layout.prop(self, "text", text="")

    def execute(self, context):
        settings = context.scene.jarvizar_city_model
        try:
            bounds = parse_bounds_text(self.text)
        except ValueError as exc:
            settings.last_status = f"Paste failed: {exc}"
            self.report({"ERROR"}, settings.last_status)
            return {"CANCELLED"}
        settings.west = format_degrees(bounds.west)
        settings.south = format_degrees(bounds.south)
        settings.east = format_degrees(bounds.east)
        settings.north = format_degrees(bounds.north)
        settings.last_status = (
            f"Bounding box set to {settings.west},{settings.south},"
            f"{settings.east},{settings.north}"
        )
        self.report({"INFO"}, settings.last_status)
        return {"FINISHED"}


class JARVIZAR_OT_download_cache(Operator):
    bl_idname = "jarvizar.download_cache"
    bl_label = "Download / Cache Data"
    bl_description = (
        "Download the source data the enabled features need, with the official "
        "Overture client and the public elevation tile service"
    )
    bl_options = {"REGISTER"}

    def execute(self, context):
        settings = context.scene.jarvizar_city_model
        try:
            if hasattr(bpy.app, "online_access") and not bpy.app.online_access:
                raise OvertureDownloadError(
                    "Blender online access is disabled; enable it before downloading"
                )
            bundle = _cache_bundle(settings)
            required = _required_types(settings)
            needs_dem = settings.terrain_source == "DEM" and settings.generate_terrain

            missing = (
                required
                if settings.force_redownload
                else bundle.missing_types(required)
            )
            dem_missing = needs_dem and (
                settings.force_redownload or not bundle.has_dem()
            )
            if not missing and not dem_missing:
                manifest = bundle.read_manifest()
                counts = manifest.get("feature_counts", {})
                message = "Using cache: " + ", ".join(
                    f"{counts.get(item, '?')} {item}" for item in required
                )
                settings.last_status = message
                self.report({"INFO"}, message)
                return {"FINISHED"}

            python_path = _resolve_downloader(context, settings)
            context.window_manager.progress_begin(0, 100)
            manifest = bundle.read_manifest()
            if missing:
                settings.last_status = f"Downloading {', '.join(missing)}..."
                manifest = download_to_cache(python_path, bundle, missing)
                context.window_manager.progress_update(70)
            if dem_missing:
                settings.last_status = "Downloading elevation tiles..."
                manifest = download_dem_to_cache(
                    python_path,
                    bundle,
                    columns=max(64, int(settings.terrain_resolution) * 2),
                )
                context.window_manager.progress_update(100)

            counts = manifest.get("feature_counts", {})
            parts = [f"{counts.get(item, 0)} {item}" for item in required]
            if bundle.has_dem():
                dem = manifest.get("dem", {}) or {}
                parts.append(
                    f"DEM {dem.get('columns', '?')}x{dem.get('rows', '?')} "
                    f"({dem.get('min_m', 0):.0f}-{dem.get('max_m', 0):.0f} m)"
                )
            message = f"Cached release {manifest.get('release', 'unknown')}: " + ", ".join(
                parts
            )
            settings.last_status = message
            self.report({"INFO"}, message)
            return {"FINISHED"}
        except (ValueError, OSError, OvertureDownloadError) as exc:
            settings.last_status = f"Download failed: {exc}"
            self.report({"ERROR"}, str(exc))
            return {"CANCELLED"}
        finally:
            context.window_manager.progress_end()


class JARVIZAR_OT_generate_model(Operator):
    bl_idname = "jarvizar.generate_model"
    bl_label = "Generate Model"
    bl_description = "Generate the enabled terrain, surface, and feature geometry"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        settings = context.scene.jarvizar_city_model
        hierarchy = None
        window_manager = context.window_manager
        try:
            bounds = _bounds_from_settings(settings)
            bundle = _cache_bundle(settings)
            required = _essential_types(settings)
            missing = bundle.missing_types(required)
            if missing:
                raise ValueError(
                    "No cached "
                    + ", ".join(missing)
                    + ". Run Download / Cache Data first."
                )

            if settings.scale_mode == "FIXED":
                transform = create_fixed_scale_transform(
                    *bounds.as_tuple(), mm_per_metre=settings.mm_per_metre
                )
            else:
                transform = create_miniature_transform(
                    *bounds.as_tuple(),
                    target_width_mm=settings.target_width_mm,
                    target_height_mm=settings.target_height_mm,
                    preserve_aspect=settings.preserve_aspect_ratio,
                )
            if settings.set_scene_units:
                context.scene.unit_settings.system = "METRIC"
                context.scene.unit_settings.scale_length = 0.001
                context.scene.unit_settings.length_unit = "MILLIMETERS"

            window_manager.progress_begin(0, 1000)

            def progress(fraction: float) -> None:
                window_manager.progress_update(int(max(0.0, min(1.0, fraction)) * 1000))

            # ------------------------------------------------ terrain surface
            terrain_metadata = {}
            if settings.terrain_source == "DEM" and settings.generate_terrain:
                if not bundle.has_dem():
                    raise ValueError(
                        "No cached elevation grid. Run Download / Cache Data, or "
                        "set Terrain to Flat Base."
                    )
                try:
                    grid = ElevationGrid.load(bundle.path)
                except ElevationGridError as exc:
                    raise ValueError(str(exc)) from exc
                if not grid.matches(*bounds.as_tuple()):
                    raise ValueError(
                        "Cached elevation grid does not cover this bounding box; "
                        "enable Refresh Existing Cache and download again"
                    )
                sampler = DEMTerrain(
                    grid, exaggeration=settings.terrain_exaggeration
                )
                terrain_metadata["dem_source"] = sampler.describe()
                heightfield = ModelHeightField.build(
                    transform,
                    sampler,
                    settings.terrain_resolution,
                    smoothing=settings.terrain_smoothing,
                )
            else:
                # A cut can only follow the grid it is rasterised onto, so a
                # flat base that has to lose its rivers still needs a real one.
                heightfield = ModelHeightField.flat(
                    transform,
                    resolution=(
                        settings.terrain_resolution if _cuts_water(settings) else 2
                    ),
                )
                terrain_metadata["dem_source"] = "flat"
            progress(0.05)

            clear_generated(context.scene)
            hierarchy = create_city_hierarchy(context.scene)
            materials = model_materials()
            root = hierarchy["root"]
            root["source"] = "Overture Maps"
            root["bbox_wgs84"] = bounds.canonical()
            root["coordinate_system"] = "WGS84 to local ENU to miniature millimetres"
            root["transform_json"] = json.dumps(transform.bounds_metadata, sort_keys=True)
            manifest = bundle.read_manifest()
            if manifest.get("release"):
                root["overture_release"] = str(manifest["release"])
            if manifest.get("client_version"):
                root["overture_client_version"] = str(manifest["client_version"])

            counts = dict(terrain_metadata)

            surface_settings = SurfaceSettings(
                surface_rise_mm=settings.surface_rise_mm,
                surface_embed_mm=settings.surface_embed_mm,
                water_thickness_mm=settings.water_thickness_mm,
                cut_from_terrain=settings.cut_water_from_terrain,
                minimum_cut_area_m2=settings.minimum_water_cut_area_m2,
            )

            # Water is solved before anything else reads the height field.  The
            # elevation dataset is noisy over open water, so the terrain under
            # each body is carved down to its solved surface first; otherwise
            # islands of DEM noise poke up through the river, and every road,
            # slab, and foundation nearby would align to that noise.
            #
            # Cutting the river out is a property of the terrain, not of the
            # water slab, so the source is read whenever either one wants it.
            # Tying them together would refill the river the moment someone
            # turned the blue part off.
            water_bodies = []
            if _needs_water_data(settings):
                water_bodies, water_counts = solve_water_bodies(
                    _load_polygons(bundle, "water"),
                    transform,
                    heightfield,
                    surface_settings,
                )
                counts.update(water_counts)
                counts["terrain_nodes_flattened_to_water"] = (
                    flatten_terrain_under_water(heightfield, water_bodies)
                )
                # The cut is decided before the terrain is built, and before
                # roads and piers ask the height field for ground, so every
                # later stage agrees about where there is no longer any.
                counts.update(
                    cut_water_from_terrain(
                        heightfield,
                        water_bodies,
                        (
                            ("infrastructure", _load_polygons(bundle, "infrastructure")),
                            ("land", _load_polygons(bundle, "land")),
                            ("land_use", _load_polygons(bundle, "land_use")),
                        ),
                        transform,
                        footprints=(
                            _load_polygons(bundle, "building")
                            if settings.generate_buildings
                            else ()
                        ),
                    )
                )
                if not bundle.data_path("infrastructure").is_file():
                    counts["infrastructure"] = (
                        "not cached; run Download to add piers and quays"
                    )

            terrain_bottom_mm = (
                heightfield.printed_minimum_mm - settings.base_thickness_mm
            )
            if settings.generate_terrain:
                counts.update(
                    generate_terrain_solid(
                        heightfield,
                        settings.base_thickness_mm,
                        hierarchy["terrain"],
                        materials["terrain"],
                    )
                )
                # The terrain measured its own surface, so a water plug and the
                # rim use the underside the terrain actually has.
                terrain_bottom_mm = counts["terrain_bottom_z_mm"]
                if settings.generate_border_rim:
                    counts.update(
                        generate_border_rim(
                            heightfield,
                            terrain_bottom_mm,
                            settings.border_rim_height_mm,
                            settings.border_rim_width_mm,
                            hierarchy["terrain"],
                            materials["rim"],
                        )
                    )
            # Ground is kept under anything the cut left standing over the
            # opening: mapped decks now, bridges and buildings as they are
            # generated.  The supports share the terrain's own underside, so
            # they can only be sized once that is known.
            ground_support = None
            if (
                settings.support_structures_over_water
                and heightfield.void_mask is not None
            ):
                ground_support = SupportBuilder(
                    heightfield,
                    terrain_bottom_mm,
                    drape_spacing_mm=surface_settings.drape_spacing_mm,
                )
                for rings in heightfield.restored_footprints:
                    ground_support.footprint(rings, "mapped_deck")
            progress(0.10)

            if settings.generate_land_surfaces:
                counts.update(
                    generate_land_surfaces(
                        [
                            ("land_cover", _load_polygons(bundle, "land_cover")),
                            ("land", _load_polygons(bundle, "land")),
                            ("land_use", _load_polygons(bundle, "land_use")),
                        ],
                        transform,
                        heightfield,
                        hierarchy["land_surfaces"],
                        materials,
                        surface_settings,
                        bounds=bounds.as_tuple(),
                        progress_callback=lambda f: progress(0.10 + f * 0.10),
                    )
                )
            progress(0.20)

            if settings.generate_water:
                counts.update(
                    generate_water(
                        water_bodies,
                        hierarchy["water"],
                        materials["water"],
                        surface_settings,
                        terrain_bottom_mm=terrain_bottom_mm,
                        progress_callback=lambda f: progress(0.20 + f * 0.05),
                    )
                )
            progress(0.25)

            if settings.generate_roads or settings.generate_bridges:
                road_settings = RoadSettings(
                    road_thickness_mm=settings.road_thickness_mm,
                    road_embed_mm=settings.surface_embed_mm,
                    minimum_width_mm=settings.minimum_road_width_mm,
                    maximum_width_mm=settings.maximum_road_width_mm,
                    include_minor_roads=settings.include_minor_roads,
                    skip_sidepaths=settings.skip_sidepaths,
                    include_rail=settings.include_rail,
                    include_bridges=settings.generate_bridges,
                    bridge_deck_thickness_mm=settings.bridge_deck_thickness_mm,
                    bridge_clearance_mm=settings.bridge_clearance_mm,
                    bridge_maximum_grade=settings.bridge_maximum_grade,
                    bridge_minimum_lift_mm=settings.bridge_minimum_lift_mm,
                    bridge_support_spacing_m=settings.bridge_support_spacing_m,
                    bridge_support_minimum_size_mm=settings.bridge_support_minimum_size_mm,
                    support_over_water=settings.support_structures_over_water,
                    causeway_margin_mm=settings.bridge_causeway_margin_mm,
                    # The bank can sit up to a cell away from where the mask
                    # says, so the causeway runs at least that far onto land.
                    causeway_overlap_mm=max(1.5, heightfield.cell_size_mm * 0.8),
                )
                counts.update(
                    generate_roads(
                        _load_features(bundle, "segment"),
                        transform,
                        heightfield,
                        hierarchy["surface_roads"],
                        hierarchy["bridges"],
                        hierarchy["bridge_supports"],
                        materials,
                        road_settings,
                        progress_callback=lambda f: progress(0.25 + f * 0.30),
                        ground_support=ground_support,
                    )
                )
            progress(0.55)

            if settings.generate_trees:
                counts.update(
                    generate_trees(
                        _load_features(bundle, "land"),
                        _load_polygons(bundle, "land_cover"),
                        transform,
                        heightfield,
                        hierarchy["vegetation"],
                        materials["tree"],
                        TreeSettings(
                            scatter_spacing_m=settings.tree_spacing_m,
                            minimum_height_mm=settings.tree_minimum_height_mm,
                            maximum_trees=settings.maximum_trees,
                            include_mapped_points=settings.include_mapped_trees,
                            include_forest_scatter=settings.include_forest_scatter,
                            include_land_cover=settings.include_land_cover_scatter,
                        ),
                        bounds=bounds.as_tuple(),
                        progress_callback=lambda f: progress(0.55 + f * 0.15),
                        merge=settings.merge_buildings_and_trees,
                    )
                )
            progress(0.70)

            if settings.generate_buildings:
                counts.update(
                    generate_buildings(
                        _load_polygons(bundle, "building"),
                        _load_polygons(bundle, "building_part"),
                        transform,
                        heightfield,
                        floor_height_m=settings.floor_height_m,
                        default_height_m=settings.default_building_height_m,
                        building_collection=hierarchy["buildings"],
                        part_collection=hierarchy["building_parts"],
                        building_material=materials["building"],
                        part_material=materials["building_part"],
                        embed_mm=settings.surface_embed_mm,
                        drape_spacing_mm=surface_settings.drape_spacing_mm,
                        minimum_width_mm=settings.minimum_building_width_mm,
                        maximum_slenderness=settings.maximum_building_slenderness,
                        progress_callback=lambda f: progress(0.70 + f * 0.30),
                        ground_support=ground_support,
                        generate_roofs=settings.generate_roof_shapes,
                        slenderness_exempt_width_mm=settings.slenderness_exempt_width_mm,
                        merge=settings.merge_buildings_and_trees,
                    )
                )

            if ground_support is not None:
                ground_support.build(hierarchy["terrain_supports"], materials["terrain"])
                counts.update(ground_support.summary())

            model = transform.model_bounds
            counts["scale_mm_per_m"] = round(transform.scale_x_mm_per_m, 6)
            counts["scale_ratio"] = round(transform.scale_ratio)
            counts["model_size_mm"] = (
                f"{model.width_mm:.1f} x {model.height_mm:.1f}"
            )
            counts["minimum_road_width_real_m"] = round(
                transform.real_metres_for_model_mm(settings.minimum_road_width_mm), 2
            )
            root["scale_mm_per_m"] = float(transform.scale_x_mm_per_m)
            root["scale_ratio"] = f"1:{transform.scale_ratio:,.0f}"
            root["model_size_mm"] = counts["model_size_mm"]
            root["generation_counts_json"] = json.dumps(
                counts, sort_keys=True, default=str
            )
            message = (
                f"{model.width_mm:.1f} x {model.height_mm:.1f} mm at "
                f"1:{transform.scale_ratio:,.0f} | "
                f"{counts.get('buildings', 0)} buildings, "
                f"{counts.get('surface_roads', 0)} roads, "
                f"{counts.get('bridge_decks', 0)} bridge decks, "
                f"{counts.get('trees', 0)} trees, "
                f"{counts.get('water_bodies', 0)} water bodies, "
                f"{counts.get('terrain_supports', 0)} supports"
            )
            settings.last_status = message
            self.report({"INFO"}, message)
            return {"FINISHED"}
        except Exception as exc:
            if hierarchy is not None:
                clear_generated(context.scene)
            settings.last_status = f"Generation failed: {exc}"
            self.report({"ERROR"}, str(exc))
            return {"CANCELLED"}
        finally:
            window_manager.progress_end()


# io_mesh_3mf multiplies the scene's ``scale_length`` by the metre value of the
# *display* unit as well, so a scene set to millimetres at 0.001 exports a
# thousandth of the model.  Mirroring its own table lets the export ask for
# exactly the compensating factor instead of hard-coding one that only holds
# for one unit setting.
_BLENDER_TO_METRE = {
    "THOU": 0.0000254,
    "INCHES": 0.0254,
    "FEET": 0.3048,
    "YARDS": 0.9144,
    "CHAINS": 20.1168,
    "FURLONGS": 201.168,
    "MILES": 1609.344,
    "MICROMETERS": 0.000001,
    "MILLIMETERS": 0.001,
    "CENTIMETERS": 0.01,
    "DECIMETERS": 0.1,
    "METERS": 1.0,
    "ADAPTIVE": 1.0,
    "DEKAMETERS": 10.0,
    "HECTOMETERS": 100.0,
    "KILOMETERS": 1000.0,
}


def _millimetre_export_scale(scene) -> float:
    """The ``Scale`` io_mesh_3mf needs so one Blender unit lands as one mm.

    The add-on builds its geometry in model millimetres, so the exported file
    must carry the vertex coordinates unchanged.  The exporter applies
    ``scale_length / 0.001 * blender_to_metre[length_unit]``; this returns its
    reciprocal, reading the table from the exporter itself when it is
    importable so the two cannot drift apart.
    """
    try:
        from io_mesh_3mf.unit_conversions import blender_to_metre
    except Exception:
        blender_to_metre = _BLENDER_TO_METRE
    units = scene.unit_settings
    scale_length = units.scale_length or 1.0
    display = blender_to_metre.get(units.length_unit, 1.0) or 1.0
    return 0.001 / (scale_length * display)


class JARVIZAR_OT_export_3mf(Operator, ExportHelper):
    bl_idname = "jarvizar.export_3mf"
    bl_label = "Export 3MF for Bambu"
    bl_description = (
        "Write every generated object to one 3MF object so Bambu Studio keeps "
        "them aligned, at true millimetres. Needs the io_mesh_3mf add-on"
    )
    bl_options = {"REGISTER"}

    filename_ext = ".3mf"
    filter_glob: bpy.props.StringProperty(default="*.3mf", options={"HIDDEN"})

    def execute(self, context):
        scene = context.scene
        settings = scene.jarvizar_city_model
        if not hasattr(bpy.ops.export_mesh, "threemf"):
            settings.last_status = (
                "3MF export needs the io_mesh_3mf add-on enabled"
            )
            self.report({"ERROR"}, settings.last_status)
            return {"CANCELLED"}

        objects = generated_objects(scene)
        if not objects:
            settings.last_status = "Nothing to export: generate a model first"
            self.report({"ERROR"}, settings.last_status)
            return {"CANCELLED"}

        # Bambu Studio treats every top-level 3MF build item as its own
        # printable object: it re-centres each one on its own bounding box,
        # drops it to the bed and may rotate it onto another plate.  Parenting
        # the lot to one empty makes the exporter write them as components of a
        # single object instead, which arrives as one object with one part per
        # collection and every relative height intact.
        holder = bpy.data.objects.new("CITY_MODEL_EXPORT", None)
        scene.collection.objects.link(holder)
        holder.matrix_world = mathutils.Matrix.Identity(4)

        previous_parents = [(obj, obj.parent, obj.matrix_parent_inverse.copy()) for obj in objects]
        previous_selection = [obj for obj in scene.objects if obj.select_get()]
        previous_active = context.view_layer.objects.active
        scale = _millimetre_export_scale(scene)
        try:
            for obj in objects:
                obj.parent = holder
                obj.matrix_parent_inverse = mathutils.Matrix.Identity(4)
            for obj in scene.objects:
                obj.select_set(False)
            # Children are written recursively, but the material writer only
            # looks at what is selected, so select them too or the parts lose
            # their colours.
            for obj in objects:
                obj.select_set(True)
            holder.select_set(True)
            context.view_layer.objects.active = holder
            bpy.ops.export_mesh.threemf(
                filepath=self.filepath,
                use_selection=True,
                global_scale=scale,
            )
        except Exception as exc:  # noqa: BLE001 - reported to the user
            settings.last_status = f"3MF export failed: {exc}"
            self.report({"ERROR"}, str(exc))
            return {"CANCELLED"}
        finally:
            for obj, parent, inverse in previous_parents:
                obj.parent = parent
                obj.matrix_parent_inverse = inverse
            bpy.data.objects.remove(holder, do_unlink=True)
            for obj in scene.objects:
                obj.select_set(obj in previous_selection)
            context.view_layer.objects.active = previous_active

        settings.last_status = (
            f"Exported {len(objects)} parts as one 3MF object "
            f"(scale {scale:g}) to {Path(self.filepath).name}"
        )
        self.report({"INFO"}, settings.last_status)
        return {"FINISHED"}


class JARVIZAR_OT_clear_model(Operator):
    bl_idname = "jarvizar.clear_model"
    bl_label = "Clear Generated Model"
    bl_description = "Remove only collections and objects generated by this add-on"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        removed = clear_generated(context.scene)
        settings = context.scene.jarvizar_city_model
        settings.last_status = f"Cleared {removed} generated objects"
        self.report({"INFO"}, settings.last_status)
        return {"FINISHED"}


CLASSES = (
    JARVIZAR_OT_paste_bounds,
    JARVIZAR_OT_download_cache,
    JARVIZAR_OT_generate_model,
    JARVIZAR_OT_export_3mf,
    JARVIZAR_OT_clear_model,
)
