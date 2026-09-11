"""Blender operators for caching, generating, and clearing city models."""

from __future__ import annotations

import json
import time
import subprocess
import tempfile
from pathlib import Path

import bpy
import mathutils
from bpy.types import Operator
from bpy.props import IntProperty, StringProperty
from bpy_extras.io_utils import ExportHelper

from .blender.collections import (
    clear_generated,
    generated_objects,
)
from .blender.generation import GenerationTransaction
from .data.generation_job import GenerationCancelled
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
from .data.lidar import request_signature, load_measurements, prepare_lidar, LidarPreparation
from .external.lidar_reuse import reusable_prepared, summarize_prepared
from .external.lidar_offer import approved_offers, offer_details
from .data.geojson import load_feature_collection, polygon_features, first_osm_id
from .data.land import recessed_water_kind
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
from .geometry.surface_priority import cut_road_footprints
from .geometry.surfaces import (
    SurfaceSettings,
    cut_water_from_terrain,
    flatten_terrain_under_water,
    generate_land_surfaces,
    generate_water,
    solve_water_bodies,
)
from .geometry.vegetation import TreeSettings, generate_trees
from .geometry.basins import recess_terrain_basins, cut_water_land_surfaces


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
        (settings.cut_water_from_terrain or settings.recess_ponds_and_fountains) and settings.generate_terrain
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
    if _cuts_water(settings) or (settings.recess_ponds_and_fountains and settings.generate_terrain):
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

    @classmethod
    def poll(cls, context):
        from .blender.generation_modal import is_generating
        return not is_generating()

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


def _lidar_signature(settings, bundle, transform=None):
    if transform is None:
        if settings.scale_mode == "FIXED":
            transform = create_fixed_scale_transform(*bundle.bounds.as_tuple(), mm_per_metre=settings.mm_per_metre)
        else:
            transform = create_miniature_transform(*bundle.bounds.as_tuple(),
                target_width_mm=settings.target_width_mm, target_height_mm=settings.target_height_mm,
                preserve_aspect=settings.preserve_aspect_ratio)
    return request_signature(bundle, min(transform.scale_x_mm_per_m, transform.scale_y_mm_per_m),
        transform.scale_z_mm_per_m * settings.building_height_scale,
        settings.lidar_minimum_width_mm, settings.lidar_minimum_step_mm, settings.lidar_source_url,
        settings.generate_roof_shapes, settings.lidar_prefer_measured, settings.lidar_manifest_url,
        roof_mode=settings.lidar_roof_mode,
        providers=None if settings.lidar_international else ('usgs',),
        stac_urls=settings.lidar_stac_urls.split(),
        vertical_units='' if settings.lidar_vertical_units == 'AUTO' else settings.lidar_vertical_units)


class JARVIZAR_OT_prepare_lidar(Operator):
    bl_idname = "jarvizar.prepare_lidar"
    bl_label = "Prepare LiDAR Buildings"
    bl_description = "Reuse valid LiDAR or prepare buildings with progress; Cancel or Esc keeps completed work"
    _running = False
    _cancel_requested = False
    laz_approval: StringProperty(default='', options={'HIDDEN', 'SKIP_SAVE'})

    @classmethod
    def poll(cls, context):
        from .blender.generation_modal import is_generating
        return not cls._running and not is_generating()

    def finish(self, context, result):
        settings = context.scene.jarvizar_city_model
        action = 'Reused prepared' if result.get('reused_prepared') else 'Prepared'
        message = (f"{action} {result['buildings']}/{result.get('candidate_buildings', result['buildings'])} buildings; "
                   f"{result['tiered_buildings']} tiered, {result.get('roof_plane_buildings', 0)} with roof planes")
        if result.get('faceted_roof_buildings'):
            message += f"; {result['faceted_roof_buildings']} detailed roof surfaces"
        reused = result.get('cache_stats', {})
        if not result.get('reused_prepared') and (reused.get('cached_buildings') or reused.get('point_batches')):
            message += f"; reused {reused.get('cached_buildings', 0)} building checks and {reused.get('point_batches', 0)} decoded point batches"
        settings.lidar_progress = 1.
        if result.get('infill_buildings') or result.get('part_heights'):
            message += f"; {result.get('infill_buildings', 0)} main masses restored, {result.get('part_heights', 0)} part heights"
        if result.get('compared_sources'):
            message += f"; compared {result['compared_sources']} surveys"
        selected = sorted({f"{s.get('provider', 'LiDAR')} {s.get('format', '')}: {s.get('name', '')}"
                           for s in result.get('sources', []) if s.get('accepted')})
        if selected:
            message += '; sources: ' + ', '.join(selected)
        if result.get('conflict_buildings'):
            reasons = result.get('rejection_counts', {})
            labels = {'footprint_roof_mismatch': 'roof coverage',
                      'observed_ground_in_footprint': 'ground inside footprints',
                      'roof_extends_outside_footprint': 'outside roofs'}
            details = [f"{reasons[key]} {label}" for key, label in labels.items() if reasons.get(key)]
            other = result['conflict_buildings'] - sum(reasons.get(key, 0) for key in labels)
            if other > 0:
                details.append(f"{other} source/survey conflicts")
            message += f"; {result['conflict_buildings']} consistency skips ({', '.join(details)})"
        if result.get('failures'):
            message += f"; {len(result['failures'])} source issues: {result['failures'][0]['reason']}"
        elif not result['buildings']:
            message += '; no reliable measurements for this selection'
        offers = result.get('laz_offers', [])
        settings.lidar_laz_offer_token = result.get('laz_offer_token', '')
        settings.lidar_laz_offer_details = offer_details(offers)
        if offers:
            gaps = len({identifier for o in offers for identifier in o['buildings']})
            message += f'; optional LAZ/LAS gaps or upgrades for {gaps} buildings'
        settings.lidar_preparation_status = settings.last_status = message
        settings.use_lidar_buildings = True
        self.report({'WARNING'} if result.get('failures') or not result['buildings'] else {'INFO'}, message)
        return {'FINISHED'}

    def cleanup(self, context):
        try:
            context.window_manager.event_timer_remove(self._timer)
        finally:
            type(self)._running = False
            type(self)._cancel_requested = False
            self._settings.lidar_preparing = False
            context.window_manager.progress_end()

    def modal(self, context, event):
        settings = self._settings
        if event.type == 'ESC' or type(self)._cancel_requested:
            type(self)._cancel_requested = False
            try:
                self._job.cancel()
            except (OSError, subprocess.TimeoutExpired) as exc:
                settings.lidar_preparation_status = f'Cancellation failed: {exc}'
                self.report({'ERROR'}, settings.lidar_preparation_status)
                # Keep polling a worker we could not stop. Releasing ownership
                # here would allow a second job to write the same cache.
                if self._job.process.poll() is None:
                    return {'RUNNING_MODAL'}
                self.cleanup(context)
                return {'CANCELLED'}
            self.cleanup(context)
            settings.lidar_preparation_status = 'Cancelled; Prepare again to resume completed work'
            return {'CANCELLED'}
        if event.type != 'TIMER':
            return {'PASS_THROUGH'}
        if self._job.process.poll() is None:
            status = self._job.status()
            settings.lidar_preparation_status = status.get('message', 'Preparing LiDAR')
            total = max(0, int(status.get('total', 0)))
            completed = max(0, min(total, int(status.get('completed', 0))))
            settings.lidar_progress = completed/total if total else 0.
            settings.lidar_progress_known = bool(total)
            settings.lidar_progress_stage = status.get('stage', 'Preparing LiDAR')
            settings.lidar_progress_scope = f'Current survey: {completed}/{total} buildings checked' if total else 'Waiting for survey or transfer details'
            settings.lidar_progress_source = status.get('source', '')
            settings.lidar_progress_reuse = f"Reused: {status.get('cached_buildings', 0)} building checks, {status.get('point_batches', 0)} point batches"
            settings.lidar_elapsed_seconds = int(status.get('elapsed', 0))
            settings.lidar_update_seconds = int(max(0., time.time()-status.get('updated_at', time.time())))
            context.window_manager.progress_update(settings.lidar_progress*1000)
            for area in context.screen.areas if context.screen else ():
                if area.type == 'VIEW_3D':
                    area.tag_redraw()
            return {'PASS_THROUGH'}
        self.cleanup(context)
        try:
            result = self._job.result()
            # Settings may have changed while the worker ran. Its cache stays
            # valid for the original request, never silently for a new area.
            if context.scene != self._scene or _lidar_signature(settings, _cache_bundle(settings)) != self._signature:
                settings.lidar_preparation_status = 'Prepared previous selection/settings; prepare again for current settings'
                self.report({'WARNING'}, settings.lidar_preparation_status)
                return {'FINISHED'}
            return self.finish(context, result)
        except (ValueError, OSError, OvertureDownloadError) as exc:
            settings.lidar_preparation_status = settings.last_status = f'LiDAR unavailable: {exc}'
            self.report({'ERROR'}, settings.last_status)
            return {'CANCELLED'}

    def execute(self, context):
        settings = context.scene.jarvizar_city_model
        try:
            bundle = _cache_bundle(settings)
            signature = _lidar_signature(settings, bundle)
            laz_approval = getattr(self, 'laz_approval', '')
            if laz_approval:
                approved_offers(bundle.path, signature, laz_approval)
            if not laz_approval and not settings.force_redownload:
                cached = reusable_prepared(bundle.path, signature)
                if cached is not None:
                    return self.finish(context, summarize_prepared(cached, reused=True))
            if hasattr(bpy.app, "online_access") and not bpy.app.online_access:
                raise ValueError("Blender online access is disabled; no current prepared result matches these settings")
            settings.lidar_preparation_status = 'Preparing LiDAR buildings... (Esc to cancel)'
            settings.lidar_progress = 0.
            settings.lidar_progress_known = False
            settings.lidar_progress_stage = 'Checking cache'
            settings.lidar_progress_scope = 'Checking prepared results and input settings'
            settings.lidar_progress_source = settings.lidar_progress_reuse = ''
            settings.lidar_elapsed_seconds = settings.lidar_update_seconds = 0
            python_path = _resolve_downloader(context, settings)
            if bpy.app.background:
                return self.finish(context, prepare_lidar(python_path, bundle, signature, settings.force_redownload and not laz_approval,
                                   download_workers=settings.lidar_download_workers, laz_approval=laz_approval))
            self._signature = signature
            self._settings, self._scene = settings, context.scene
            self._job = LidarPreparation(python_path, bundle, signature, settings.force_redownload and not laz_approval,
                                         download_workers=settings.lidar_download_workers, laz_approval=laz_approval)
            self._timer = context.window_manager.event_timer_add(0.5, window=context.window)
            context.window_manager.modal_handler_add(self)
            settings.lidar_preparing = True
            context.window_manager.progress_begin(0, 1000)
            type(self)._cancel_requested = False
            type(self)._running = True
            return {'RUNNING_MODAL'}
        except (ValueError, OSError, OvertureDownloadError) as exc:
            settings.last_status = f"LiDAR unavailable: {exc}. Source generation remains available."
            settings.lidar_preparation_status = settings.last_status
            self.report({"ERROR"}, settings.last_status)
            return {"CANCELLED"}


class JARVIZAR_OT_cancel_lidar(Operator):
    bl_idname = 'jarvizar.cancel_lidar'
    bl_label = 'Cancel LiDAR Preparation'
    bl_description = 'Stop preparation and retain completed downloads and building checkpoints'

    @classmethod
    def poll(cls, context):
        return JARVIZAR_OT_prepare_lidar._running

    def execute(self, context):
        JARVIZAR_OT_prepare_lidar._cancel_requested = True
        return {'FINISHED'}


class JARVIZAR_OT_cancel_generation(Operator):
    bl_idname = "jarvizar.cancel_generation"
    bl_label = "Cancel Generation"
    bl_description = "Stop generation and keep the previous model"

    @classmethod
    def poll(cls, context):
        from .blender.generation_modal import is_generating
        return is_generating()

    def execute(self, context):
        from .blender.generation_modal import active_session
        session = active_session()
        if session is not None:
            session.request_cancel()
        return {"FINISHED"}


class JARVIZAR_OT_move_surface_priority(Operator):
    bl_idname = "jarvizar.move_surface_priority"
    bl_label = "Move Surface Priority"
    bl_description = "Move this surface up or down; the higher surface wins overlaps"
    bl_options = {"UNDO"}

    index: IntProperty(options={"HIDDEN"})
    direction: IntProperty(default=1, min=-1, max=1, options={"HIDDEN"})

    def execute(self, context):
        settings = context.scene.jarvizar_city_model
        order = list(settings.surface_order())
        destination = self.index + self.direction
        if not (0 <= self.index < len(order) and 0 <= destination < len(order)):
            return {"CANCELLED"}
        order[self.index], order[destination] = order[destination], order[self.index]
        settings.surface_priority_order = ",".join(order)
        return {"FINISHED"}


class JARVIZAR_OT_generate_model(Operator):
    bl_idname = "jarvizar.generate_model"
    bl_label = "Generate Model"
    bl_description = "Generate the model with phase progress; Esc or Cancel keeps the previous model"
    bl_options = {"REGISTER", "UNDO"}

    @classmethod
    def poll(cls, context):
        from .blender.generation_modal import is_generating
        return not is_generating() and not JARVIZAR_OT_prepare_lidar._running

    def execute(self, context):
        if bpy.app.background:
            return JARVIZAR_OT_generate_model.execute_sync(self, context)
        from .blender.generation_modal import GenerationSession
        try:
            self._session = GenerationSession(context)
            self._session.start()
            context.window_manager.modal_handler_add(self)
            return {"RUNNING_MODAL"}
        except Exception as exc:
            session = getattr(self, "_session", None)
            if session is not None:
                session.error = True
                session.message = f"Could not start generation: {exc}"
                session.detach()
            self.report({"ERROR"}, f"Could not start generation: {exc}")
            return {"CANCELLED"}

    def modal(self, context, event):
        session = self._session
        if session.done:
            return {"CANCELLED"}
        if event.type == "ESC":
            session.request_cancel()
            return {"RUNNING_MODAL"}
        if event.type == "TIMER":
            result = session.advance(context)
            if result != {"RUNNING_MODAL"}:
                self.report({"INFO"} if not session.error else {"ERROR"}, session.message)
            return result
        if event.type == "Z" and event.ctrl:
            return {"RUNNING_MODAL"}
        if session.transaction is not None:
            # Permit clicks on the sidebar's Cancel button even when they were
            # queued during append. Consume viewport edits before publication.
            if event.type in {"LEFTMOUSE", "MOUSEMOVE", "INBETWEEN_MOUSEMOVE"}:
                for area in context.screen.areas if context.screen else ():
                    for region in area.regions if area.type == "VIEW_3D" else ():
                        if (region.type == "UI" and region.x <= event.mouse_x < region.x + region.width
                                and region.y <= event.mouse_y < region.y + region.height):
                            return {"PASS_THROUGH"}
            return {"RUNNING_MODAL"}
        # Navigation and the Cancel button remain available while building.
        return {"PASS_THROUGH"}

    def cancel(self, context):
        session = getattr(self, "_session", None)
        if session is not None:
            session.detach()

    def execute_sync(self, context):
        settings = context.scene.jarvizar_city_model
        transaction = None
        window_manager = context.window_manager
        phase_name = "Checking cached data"

        def progress(fraction, phase=None):
            nonlocal phase_name
            if phase is not None:
                phase_name = phase
            window_manager.progress_update(int(max(0.0, min(1.0, fraction)) * 1000))
            callback = getattr(self, "_generation_progress", None)
            if callback is not None:
                callback(phase_name, fraction)

        try:
            window_manager.progress_begin(0, 1000)
            progress(0.0)
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
            # ------------------------------------------------ terrain surface
            progress(0.01, "Preparing terrain heights")
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
            progress(0.05, "Creating staging collections")

            transaction = GenerationTransaction(context)
            hierarchy, materials = transaction.begin()
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
                priority_order=settings.surface_order(),
                surface_rise_mm=settings.surface_rise_mm,
                surface_embed_mm=settings.surface_embed_mm,
                water_thickness_mm=settings.water_thickness_mm,
                cut_from_terrain=settings.cut_water_from_terrain,
                minimum_cut_area_m2=settings.minimum_water_cut_area_m2,
                recess_ponds_and_fountains=(settings.recess_ponds_and_fountains and settings.generate_terrain),
                pond_recess_depth_mm=settings.pond_recess_depth_mm,
                pond_water_thickness_mm=settings.pond_water_thickness_mm,
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
            progress(.05, "Solving water")
            water_bodies = []
            if _needs_water_data(settings):
                water_features = _load_polygons(bundle, "water")
                if surface_settings.recess_ponds_and_fountains:
                    known = {first_osm_id(f.get("properties") or {}) for f in water_features}
                    for feature in _load_polygons(bundle, "infrastructure"):
                        osm = first_osm_id(feature.get("properties") or {})
                        if recessed_water_kind(feature) and (not osm or osm not in known):
                            water_features.append(feature)
                            if osm:
                                known.add(osm)
                water_bodies, water_counts = solve_water_bodies(
                    water_features,
                    transform,
                    heightfield,
                    surface_settings,
                )
                counts.update(water_counts)
                progress(.06, "Flattening water terrain")
                counts["terrain_nodes_flattened_to_water"] = (
                    flatten_terrain_under_water(heightfield, water_bodies)
                )
                # The cut is decided before the terrain is built, and before
                # roads and piers ask the height field for ground, so every
                # later stage agrees about where there is no longer any.
                progress(.07, "Cutting water from terrain")
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
            progress(.08, "Building terrain")
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
                progress(.085, "Recessing ponds and fountains")
                counts.update(recess_terrain_basins(
                    heightfield, water_bodies, hierarchy["terrain"], settings.base_thickness_mm,
                ))
                terrain_bottom_mm = counts.get("terrain_bottom_z_mm", terrain_bottom_mm)
                progress(.09, "Building border rim")
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
            progress(.095, "Preparing ground supports")
            ground_support = None
            if (
                settings.support_structures_over_water
                and water_bodies
            ):
                ground_support = SupportBuilder(
                    heightfield,
                    terrain_bottom_mm,
                    drape_spacing_mm=surface_settings.drape_spacing_mm,
                    water_bodies=water_bodies,
                )
                for rings in heightfield.restored_footprints:
                    ground_support.footprint(rings, "mapped_deck")
            progress(0.10, "Building land surfaces")

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
                        ground_support=ground_support,
                    )
                )
            progress(0.20, "Clearing land surfaces from water")

            counts.update(cut_water_land_surfaces(
                hierarchy["land_surfaces"], water_bodies,
                surface_settings.surface_rise_mm + surface_settings.surface_embed_mm,
                preserve_paved=ground_support is not None,
            ))
            if ground_support is not None:
                counts.update(ground_support.support_paved_surfaces(
                    hierarchy['land_surfaces'], surface_settings.surface_rise_mm,
                    surface_settings.surface_embed_mm,
                ))

            progress(.20, "Building water")
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
            progress(0.25, "Building roads and bridges")

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
                        progress_callback=lambda f: progress(0.25 + f * 0.25),
                        ground_support=ground_support,
                    )
                )
                if settings.generate_land_surfaces:
                    progress(.50, "Cutting road footprints")
                    counts.update(cut_road_footprints(
                        hierarchy["land_surfaces"], hierarchy["surface_roads"],
                        surface_settings.surface_rise_mm + surface_settings.surface_embed_mm,
                        progress_callback=lambda f: progress(0.50 + f * 0.05),
                    ))
            progress(0.55, "Placing trees")

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
                            minimum_canopy_diameter_mm=settings.tree_minimum_width_mm,
                            size_variation=settings.tree_size_variation,
                            embed_mm=settings.surface_embed_mm,
                            maximum_trees=settings.maximum_trees,
                            include_mapped_points=settings.include_mapped_trees,
                            include_forest_scatter=settings.include_forest_scatter,
                            include_land_cover=settings.include_land_cover_scatter,
                        ),
                        bounds=bounds.as_tuple(),
                        progress_callback=lambda f: progress(0.55 + f * 0.15),
                        merge=settings.merge_buildings_and_trees,
                        reuse_mesh=False,
                    )
                )
            progress(0.70, "Loading LiDAR measurements")

            lidar_generation_status = 'LiDAR disabled' if not settings.use_lidar_buildings else 'Buildings disabled'
            if settings.generate_buildings:
                lidar_profiles = {}
                if settings.use_lidar_buildings:
                    lidar_profiles, lidar_status = load_measurements(bundle, _lidar_signature(settings, bundle, transform))
                    counts["lidar_status"] = lidar_status
                    if not lidar_profiles:
                        self.report({"WARNING"}, lidar_status)
                progress(.70, "Building buildings")
                counts.update(
                    generate_buildings(
                        _load_polygons(bundle, "building"),
                        _load_polygons(bundle, "building_part"),
                        transform,
                        heightfield,
                        floor_height_m=settings.floor_height_m,
                        default_height_m=settings.default_building_height_m,
                        height_scale=settings.building_height_scale,
                        minimum_height_mm=settings.minimum_building_height_mm,
                        minimum_height_footprint_mm=settings.minimum_height_footprint_mm,
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
                        lidar_profiles=lidar_profiles,
                        prefer_lidar=settings.lidar_prefer_measured,
                    )
                )
                if settings.use_lidar_buildings:
                    if not lidar_profiles:
                        lidar_generation_status = lidar_status
                    else:
                        lidar_generation_status = (
                            f"Used LiDAR on {counts.get('lidar_buildings', 0)} buildings: "
                            f"{counts.get('lidar_tier_solids', 0)} tier sections, "
                            f"{counts.get('lidar_roof_plane_buildings', 0)} sloped roofs, "
                            f"{counts.get('lidar_faceted_roof_buildings', 0)} detailed surfaces; "
                            f"{counts.get('lidar_infill_buildings', 0)} main masses restored, "
                            f"{counts.get('lidar_part_heights', 0)} part heights; "
                            f"{counts.get('lidar_source_detail_preserved', 0)} richer source buildings kept; "
                            f"{counts.get('lidar_geometry_fallbacks', 0)} geometry fallbacks")

            progress(1.0, "Building terrain supports")
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
            if settings.use_lidar_buildings:
                message += ' | ' + lidar_generation_status
            progress(1.0, "Validating model")
            transaction.commit(message=message, lidar_status=lidar_generation_status,
                               set_scene_units=settings.set_scene_units)
        except Exception as exc:
            if transaction is not None:
                transaction.rollback()
            cancelled = isinstance(exc, GenerationCancelled)
            settings.last_status = ("Generation cancelled; previous model kept" if cancelled
                                    else f"Generation failed: {exc}")
            self.report({"INFO"} if cancelled else {"ERROR"}, str(exc))
            return {"CANCELLED"}
        finally:
            window_manager.progress_end()
        self.report({"INFO"}, settings.last_status)
        return {"FINISHED"}


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


def _write_3mf_parts(context, parts, raw, named, scale, *, section=False):
    """The same writer/semantic annotation path for a map or one section."""
    from .data.export_3mf import name_3mf, part_name_map

    holder = bpy.data.objects.new("CITY_MODEL_EXPORT", None)
    try:
        context.scene.collection.objects.link(holder)
        holder.matrix_world = mathutils.Matrix.Identity(4)
        for obj in parts:
            world = obj.matrix_world.copy()
            obj.parent = holder
            obj.matrix_parent_inverse = mathutils.Matrix.Identity(4)
            obj.matrix_world = world
        for obj in context.view_layer.objects:
            obj.select_set(False)
        # Children are recursive, but materials are selection-only.
        for obj in parts:
            obj.select_set(True)
        holder.select_set(True)
        context.view_layer.objects.active = holder
        context.view_layer.update()
        options = {"coordinate_precision": 9} if section else {}
        result = bpy.ops.export_mesh.threemf(
            filepath=str(raw), use_selection=True, global_scale=scale, **options)
        if 'FINISHED' not in result:
            raise RuntimeError("The 3MF writer cancelled the export")
        name_3mf(raw, named, part_name_map(parts))
    finally:
        bpy.data.objects.remove(holder, do_unlink=True)


class JARVIZAR_OT_export_3mf(Operator, ExportHelper):
    bl_idname = "jarvizar.export_3mf"
    bl_label = "Export 3MF for Bambu"
    bl_description = (
        "Export generated geometry inside cutout's inner opening at true millimetres, "
        "optionally divided across Bambu plates. Needs the io_mesh_3mf add-on"
    )
    bl_options = {"REGISTER"}

    filename_ext = ".3mf"
    filter_glob: bpy.props.StringProperty(default="*.3mf", options={"HIDDEN"})

    @classmethod
    def poll(cls, context):
        from .blender.generation_modal import is_generating
        return not is_generating()

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
        # single object instead, with every relative height intact.
        from .blender.export_cutout import export_geometry, export_grid, export_section

        previous_selection = [obj for obj in context.view_layer.objects if obj.select_get()]
        previous_active = context.view_layer.objects.active
        scale = _millimetre_export_scale(scene)
        try:
            with export_geometry(context, objects) as (parts, stats, opening):
                if not parts:
                    raise ValueError("Nothing to export inside cutout's inner opening")
                # Publish only after the writer and Bambu naming both succeed.
                # Staging alongside the destination keeps replacement atomic.
                destination = Path(self.filepath)
                with tempfile.TemporaryDirectory(prefix=".jcm-3mf-", dir=destination.parent) as folder:
                    raw = Path(folder) / "raw.3mf"
                    named = Path(folder) / "named.3mf"
                    if settings.multi_plate_export:
                        from .data.export_plates import combine_plates

                        grid = export_grid(context, parts, opening, settings.section_width_mm,
                                           settings.section_height_mm)
                        section_files = []
                        part_count = 0
                        for section in grid:
                            with export_section(context, parts, section) as section_parts:
                                if not section_parts:
                                    continue
                                path = Path(folder) / f"r{section.row}-c{section.column}.3mf"
                                _write_3mf_parts(context, section_parts, raw, path, scale, section=True)
                                section_files.append((section, path))
                                part_count += len(section_parts)
                        combine_plates(section_files, named)
                        export_status = f"{len(section_files)} Bambu plates"
                    else:
                        _write_3mf_parts(context, parts, raw, named, scale)
                        part_count = len(parts)
                        export_status = "one 3MF object"
                    named.replace(destination)
                crop_status = ""
                if opening:
                    crop_status = (f"; cutout: {stats['inside_objects']} inside objects, "
                                   f"{stats['outside_objects']} outside objects skipped, "
                                   f"{stats['crossing_shells']} crossing solids clipped")
                    print(f"3MF cutout: {dict(stats)}")
        except Exception as exc:  # noqa: BLE001 - reported to the user
            settings.last_status = f"3MF export failed: {exc}"
            self.report({"ERROR"}, str(exc))
            return {"CANCELLED"}
        finally:
            for obj in context.view_layer.objects:
                obj.select_set(obj in previous_selection)
            context.view_layer.objects.active = previous_active

        settings.last_status = (
            f"Exported {part_count} parts as {export_status} "
            f"(scale {scale:g}) to {Path(self.filepath).name}{crop_status}"
        )
        self.report({"INFO"}, settings.last_status)
        return {"FINISHED"}


class JARVIZAR_OT_clear_model(Operator):
    bl_idname = "jarvizar.clear_model"
    bl_label = "Clear Generated Model"
    bl_description = "Remove only collections and objects generated by this add-on"
    bl_options = {"REGISTER", "UNDO"}

    @classmethod
    def poll(cls, context):
        from .blender.generation_modal import is_generating
        return not is_generating()

    def execute(self, context):
        removed = clear_generated(context.scene)
        settings = context.scene.jarvizar_city_model
        settings.last_status = f"Cleared {removed} generated objects"
        self.report({"INFO"}, settings.last_status)
        return {"FINISHED"}


CLASSES = (
    JARVIZAR_OT_cancel_lidar,
    JARVIZAR_OT_cancel_generation,
    JARVIZAR_OT_move_surface_priority,
    JARVIZAR_OT_paste_bounds,
    JARVIZAR_OT_download_cache,
    JARVIZAR_OT_prepare_lidar,
    JARVIZAR_OT_generate_model,
    JARVIZAR_OT_export_3mf,
    JARVIZAR_OT_clear_model,
)
