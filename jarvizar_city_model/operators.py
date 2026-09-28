"""Blender operators for caching, generating, and clearing city models."""

from __future__ import annotations

import json
import time
import subprocess
import tempfile
import textwrap
from pathlib import Path
from types import SimpleNamespace

import bpy
from bpy.types import Operator
from bpy.props import BoolProperty, IntProperty, StringProperty
from bpy_extras.io_utils import ExportHelper

from .blender.collections import (
    clear_generated,
    generated_objects,
    update_from_edit_mode,
)
from .data.folders import ensure_writable
from .blender.generation import GenerationTransaction
from .blender.generation_modal import GenerationSession, active_session, is_generating
from .blender.download_modal import DownloadSession, active_download, is_downloading
from .data.download_job import OFFLINE_MESSAGE, DownloadJob, cached_message, using_cache_message
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
from .external.lidar_offer import approved_offers, offer_details, offer_summary
from .data.geojson import (
    load_feature_collection, polygon_features, first_osm_id, feature_id, feature_properties,
)
from .data.land import has_bridge_flag, recessed_water_kind
from .config import preferred_python_path, storage_limits
from .data.overture import (
    OvertureDownloadError,
    resolve_python,
)
from .data.projection import (
    BOUNDS_TEXT_EXAMPLE,
    create_fixed_scale_transform,
    create_miniature_transform,
    format_degrees,
    normalize_minus,
    parse_bounds_text,
)
from .geometry.building_generation import generate_buildings
from .geometry.dem_terrain import generate_border_rim, generate_terrain_solid
from .geometry.heightfield import ModelHeightField
from .geometry.roads import RoadSettings, generate_roads
from .geometry.support import SupportBuilder
from .geometry.surface_priority import cut_road_footprints, defer_road_cut
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
    values = []
    for label in ("West", "South", "East", "North"):
        text = normalize_minus(str(getattr(settings, label.lower(), "") or "")).strip()
        try:
            values.append(float(text))
        except ValueError:
            hint = "; use a point for decimals" if "," in text else ""
            raise ValueError(f"{label} is not a number: {text or 'empty'}{hint}") from None
    return Bounds(*values).validate()


def _cache_root(settings) -> Path:
    value = (settings.cache_directory or "").strip()
    if not value:
        raise ValueError("Cache Directory is empty: choose a folder in Setup and Cache")
    if value.startswith("//") and not bpy.data.filepath:
        raise ValueError("Cache Directory is relative to a .blend file that is not saved: "
                         "save the file or choose a full folder path in Setup and Cache")
    return Path(bpy.path.abspath(value)).expanduser()


def _cache_bundle(settings) -> CacheBundle:
    return CacheBundle(_cache_root(settings), _bounds_from_settings(settings))


def _offline() -> bool:
    """Whether Blender's online access preference forbids network use."""
    return hasattr(bpy.app, "online_access") and not bpy.app.online_access


def _transform_from_settings(settings, bounds: Bounds):
    """The print transform for these bounds under the scene's scale mode."""
    if settings.scale_mode == "FIXED":
        return create_fixed_scale_transform(*bounds.as_tuple(), mm_per_metre=settings.mm_per_metre)
    return create_miniature_transform(
        *bounds.as_tuple(),
        target_width_mm=settings.target_width_mm,
        target_height_mm=settings.target_height_mm,
        preserve_aspect=settings.preserve_aspect_ratio,
    )


def _needs_water_data(settings) -> bool:
    """Whether the source water layer is needed, for a slab or for the cut."""
    return bool(settings.generate_water) or _cuts_water(settings) or _recesses_water(settings)


def _cuts_water(settings) -> bool:
    return bool(settings.cut_water_from_terrain and settings.generate_terrain)


def _recesses_water(settings) -> bool:
    """Whether basins are built; skipping those waters leaves nothing to recess."""
    return bool(settings.recess_ponds_and_fountains and settings.generate_terrain
                and not settings.skip_ponds_and_fountains)


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
    if _cuts_water(settings) or _recesses_water(settings) or settings.generate_roads:
        # Piers, quays, and breakwaters are mapped here; the cut needs them to
        # know which ground out over the water is real.  Runways, taxiways
        # and aprons are here too, and print with the roads.
        required.extend(INFRASTRUCTURE_TYPES)
    return tuple(item for item in ALL_TYPES if item in required)


def _essential_types(settings) -> tuple:
    """The types generation refuses to run without.

    Infrastructure only refines the model (piers and quays for the water cut,
    polygon fountains for basins, airport paving for roads), so a cache made
    before it was downloaded still generates; the download operator fetches it
    next time.
    """
    return tuple(
        item for item in _required_types(settings) if item not in INFRASTRUCTURE_TYPES
    )


def _damaged_cache(layer: str) -> str:
    return (f"The cached {layer} data is damaged. Turn on Refresh Existing Cache "
            "and click Download / Cache Data.")


def _load_features(bundle: CacheBundle, feature_type: str):
    path = bundle.data_path(feature_type)
    if not path.is_file():
        return []
    try:
        return load_feature_collection(path)
    except (KeyError, TypeError, AttributeError, ValueError) as exc:
        if isinstance(exc.__cause__, OSError):
            raise  # A locked or unreadable file, not a damaged one.
        raise ValueError(_damaged_cache(feature_type)) from exc


def _load_polygons(bundle: CacheBundle, feature_type: str):
    try:
        return list(polygon_features(_load_features(bundle, feature_type)))
    except (KeyError, TypeError, AttributeError) as exc:
        raise ValueError(_damaged_cache(feature_type)) from exc


def _bridge_lines(bundle: CacheBundle, transform):
    """Model-space centerlines of every bridge-flagged road or rail segment."""
    lines = []
    for feature in _load_features(bundle, "segment"):
        geometry = feature.get("geometry") or {}
        if geometry.get("type") == "LineString":
            parts = [geometry.get("coordinates") or []]
        elif geometry.get("type") == "MultiLineString":
            parts = geometry.get("coordinates") or []
        else:
            continue
        if parts and has_bridge_flag(feature_properties(feature)):
            lines.extend(
                [transform.geographic_to_model(point[0], point[1], 0.0)[:2] for point in line]
                for line in parts)
    return lines


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


class JARVIZAR_OT_paste_bounds(Operator):
    bl_idname = "jarvizar.paste_bounds"
    bl_label = "Paste Bounding Box"
    bl_description = (
        "Fill West, South, East and North from one line on the clipboard, for "
        "example -84.5337,39.0855,-84.4742,39.1109. Asks for the text if the "
        "clipboard does not hold four numbers"
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
    text: StringProperty(
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


def _download_offer(context):
    """The data Generate lacks when a download can be offered, else nothing."""
    settings = context.scene.jarvizar_city_model
    try:
        bundle = _cache_bundle(settings)
        missing = list(bundle.missing_types(_essential_types(settings)))
        if settings.terrain_source == "DEM" and settings.generate_terrain and not bundle.has_dem():
            missing.append("elevation")
        if not missing or _offline() or not JARVIZAR_OT_download_cache.poll(context):
            return []
        _resolve_downloader(context, settings)
    except (ValueError, OSError, OvertureDownloadError):
        return []
    return missing


def _generate_after_download():
    """Start generation once the download's modal handler has returned."""
    def start():
        if JARVIZAR_OT_generate_model.poll(bpy.context):
            bpy.ops.jarvizar.generate_model("EXEC_DEFAULT")
    bpy.app.timers.register(start, first_interval=0.1)


class JARVIZAR_OT_download_cache(Operator):
    bl_idname = "jarvizar.download_cache"
    bl_label = "Download / Cache Data"
    bl_description = (
        "Download the source data the enabled features need, with the official "
        "Overture client and the public elevation tile service. Esc or Cancel "
        "stops it and keeps the existing cache"
    )
    bl_options = {"REGISTER"}

    # Set when Generate offered the download: generate after it succeeds.
    then_generate: BoolProperty(default=False, options={"HIDDEN", "SKIP_SAVE"})

    @classmethod
    def poll(cls, context):
        return not (is_generating() or is_downloading() or JARVIZAR_OT_prepare_lidar._running)

    def execute(self, context):
        settings = context.scene.jarvizar_city_model
        try:
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
                message = using_cache_message(bundle.read_manifest(), required)
                settings.last_status = message
                self.report({"INFO"}, message)
                if self.then_generate:
                    _generate_after_download()
                return {"FINISHED"}
            if _offline():
                raise OvertureDownloadError(OFFLINE_MESSAGE)

            job = DownloadJob(
                _resolve_downloader(context, settings), bundle, missing,
                dem_columns=max(64, int(settings.terrain_resolution) * 2) if dem_missing else None,
            )
            layers = [*missing, "elevation tiles"] if dem_missing else list(missing)
            settings.last_status = f"Downloading {', '.join(layers)}..."
            if bpy.app.background:
                message = cached_message(job.run(), required, bundle.has_dem())
                settings.last_status = message
                self.report({"INFO"}, message)
                return {"FINISHED"}
            self._session = DownloadSession(
                context, job, required, on_success=_generate_after_download if self.then_generate else None)
            try:
                self._session.start()
                context.window_manager.modal_handler_add(self)
            except Exception as exc:
                self._session.detach()
                raise OvertureDownloadError(f"Could not start the download: {exc}") from exc
            return {"RUNNING_MODAL"}
        except (ValueError, OSError, OvertureDownloadError) as exc:
            settings.last_status = f"Download failed: {exc}"
            self.report({"ERROR"}, str(exc))
            return {"CANCELLED"}

    def modal(self, context, event):
        session = self._session
        if session.done:
            return {"CANCELLED"}
        if event.type == "ESC":
            session.request_cancel()
            return {"RUNNING_MODAL"}
        if event.type == "TIMER":
            result = session.advance()
            if result != {"RUNNING_MODAL"}:
                self.report({"ERROR"} if session.error else {"INFO"}, session.message)
            return result
        return {"PASS_THROUGH"}

    def cancel(self, context):
        # Blender drops the modal handler without another event when a file
        # is loaded or the window closes; stop the helper rather than orphan it.
        session = getattr(self, "_session", None)
        if session is not None:
            session.detach()


class JARVIZAR_OT_download_then_generate(Operator):
    bl_idname = "jarvizar.download_then_generate"
    bl_label = "Download Missing Data"
    bl_description = "Download the data the model needs, then generate it"
    bl_options = {"INTERNAL"}

    @classmethod
    def poll(cls, context):
        return JARVIZAR_OT_download_cache.poll(context)

    def invoke(self, context, event):
        self._missing = _download_offer(context)
        if not self._missing:
            return {"CANCELLED"}
        # Blender 3.6 has no confirm_text and shows OK.
        options = {"confirm_text": "Download and Generate"} if bpy.app.version >= (4, 2, 0) else {}
        return context.window_manager.invoke_props_dialog(self, width=320, **options)

    def draw(self, context):
        layout = self.layout
        layout.label(text="Not cached yet:")
        for line in textwrap.wrap(", ".join(getattr(self, "_missing", ())), 40):
            layout.label(text=line)
        layout.label(text="Download it now, then generate?")

    def execute(self, context):
        result = bpy.ops.jarvizar.download_cache("INVOKE_DEFAULT", then_generate=True)
        return {"FINISHED"} if result & {"RUNNING_MODAL", "FINISHED"} else {"CANCELLED"}


def _lidar_signature(settings, bundle, transform=None):
    if transform is None:
        transform = _transform_from_settings(settings, bundle.bounds)
    return request_signature(bundle, min(transform.scale_x_mm_per_m, transform.scale_y_mm_per_m),
        transform.scale_z_mm_per_m * settings.building_height_scale,
        settings.lidar_minimum_width_mm, settings.lidar_minimum_step_mm, settings.lidar_source_url,
        settings.generate_roof_shapes, settings.lidar_prefer_measured, settings.lidar_manifest_url,
        roof_mode='HEIGHT_ONLY' if settings.lidar_height_only else settings.lidar_roof_mode,
        providers=None if settings.lidar_international else ('usgs',),
        stac_urls=settings.lidar_stac_urls.split(),
        rock_surfaces=settings.lidar_rock_surfaces and not settings.lidar_height_only,
        min_footprint_area_mm2=settings.lidar_minimum_footprint_area_mm2,
        xy_area_scale=transform.scale_x_mm_per_m * transform.scale_y_mm_per_m,
        vertical_units='' if settings.lidar_vertical_units == 'AUTO' else settings.lidar_vertical_units)


def _scene_named(context, name):
    """The scene called *name*, looked up again: undo replaces every ID, so a
    scene held across events can already have been removed."""
    if context.scene is not None and context.scene.name == name:
        return context.scene
    return bpy.data.scenes.get(name)


class JARVIZAR_OT_prepare_lidar(Operator):
    bl_idname = "jarvizar.prepare_lidar"
    bl_label = "Prepare LiDAR Buildings"
    bl_description = "Reuse valid LiDAR or prepare buildings with progress; Cancel or Esc keeps completed work"
    _running = False
    _cancel_requested = False
    laz_approval: StringProperty(default='', options={'HIDDEN', 'SKIP_SAVE'})

    @classmethod
    def poll(cls, context):
        return not cls._running and not is_generating() and not is_downloading()

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
        footprint_skips = result.get('rejection_counts', {}).get('footprint_below_minimum', 0)
        if footprint_skips:
            message += f'; {footprint_skips} below minimum footprint (source buildings kept)'
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
        settings.lidar_laz_offer_summary = offer_summary(offers)
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
            scene = _scene_named(context, self._scene_name)
            if scene is not None:
                scene.jarvizar_city_model.lidar_preparing = False
            context.window_manager.progress_end()

    def cancel(self, context):
        # Blender drops the modal handler without another event when a file
        # is loaded or the window closes. Stop the worker rather than leave it
        # unowned, and release Prepare and Generate for the next file.
        try:
            self._job.cancel()
        except (OSError, subprocess.TimeoutExpired) as exc:
            print(f'LiDAR preparation could not be stopped: {exc}')
        self.cleanup(context)

    def modal(self, context, event):
        scene = _scene_named(context, self._scene_name)
        # Progress for a scene deleted or renamed meanwhile has nowhere to go.
        settings = scene.jarvizar_city_model if scene is not None else SimpleNamespace()
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
            # Undo restores the scene as it was before preparation started.
            settings.lidar_preparing = True
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
            if (scene is None or context.scene != scene
                    or _lidar_signature(settings, _cache_bundle(settings)) != self._signature):
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
            if _offline():
                raise ValueError("Blender online access is off (Edit > Preferences > System > Network) "
                                 "and no prepared result matches these settings")
            settings.lidar_preparation_status = 'Preparing LiDAR buildings... (Esc to cancel)'
            settings.lidar_progress = 0.
            settings.lidar_progress_known = False
            settings.lidar_progress_stage = 'Checking cache'
            settings.lidar_progress_scope = 'Checking prepared results and input settings'
            settings.lidar_progress_source = settings.lidar_progress_reuse = ''
            settings.lidar_elapsed_seconds = settings.lidar_update_seconds = 0
            python_path = _resolve_downloader(context, settings)
            cache_gib, free_gib = storage_limits()
            refresh = settings.force_redownload and not laz_approval
            job_options = dict(download_workers=settings.lidar_download_workers, laz_approval=laz_approval,
                               cache_gib=cache_gib, free_gib=free_gib)
            if bpy.app.background:
                return self.finish(context, prepare_lidar(python_path, bundle, signature, refresh, **job_options))
            self._signature = signature
            self._scene_name = context.scene.name
            self._job = LidarPreparation(python_path, bundle, signature, refresh, **job_options)
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
        return is_generating()

    def execute(self, context):
        session = active_session()
        if session is not None:
            session.request_cancel()
        return {"FINISHED"}


class JARVIZAR_OT_cancel_download(Operator):
    bl_idname = "jarvizar.cancel_download"
    bl_label = "Cancel Download"
    bl_description = "Stop the download and keep the existing cache"

    @classmethod
    def poll(cls, context):
        return is_downloading()

    def execute(self, context):
        session = active_download()
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
        return not is_generating() and not JARVIZAR_OT_prepare_lidar._running and not is_downloading()

    def invoke(self, context, event):
        # Missing data that a download could fetch is offered, not reported
        # as a failure; the download then starts generation itself.
        if not bpy.app.background and _download_offer(context):
            bpy.ops.jarvizar.download_then_generate("INVOKE_DEFAULT")
            return {"CANCELLED"}
        return self.execute(context)

    def execute(self, context):
        if bpy.app.background:
            return JARVIZAR_OT_generate_model.execute_sync(self, context)
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
                    "No downloaded map data for this area ("
                    + ", ".join(missing)
                    + "). Click Download / Cache Data first."
                )

            transform = _transform_from_settings(settings, bounds)
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
                except (KeyError, TypeError, ValueError) as exc:
                    raise ValueError(_damaged_cache("elevation")) from exc
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
                # The cut follows exact outlines, but whole-cell water queries
                # need a real grid, so a flat base losing its rivers gets one.
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
                recess_ponds_and_fountains=_recesses_water(settings),
                pond_recess_depth_mm=settings.pond_recess_depth_mm,
                pond_water_thickness_mm=settings.pond_water_thickness_mm,
                skip_ponds_and_fountains=settings.skip_ponds_and_fountains,
            )
            slab_thickness_mm = surface_settings.surface_rise_mm + surface_settings.surface_embed_mm

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
                    known = {first_osm_id(feature_properties(f)) for f in water_features}
                    for feature in _load_polygons(bundle, "infrastructure"):
                        osm = first_osm_id(feature_properties(feature))
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
                    embed_mm=surface_settings.surface_embed_mm,
                )
                for rings in heightfield.restored_footprints:
                    ground_support.footprint(rings, "mapped_deck")
            progress(0.10, "Building land surfaces")

            if settings.generate_land_surfaces:
                # A bridge way crossing a bridge-tagged plaza is its deck.
                bridge_lines = _bridge_lines(bundle, transform)
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
                        bridge_lines=bridge_lines,
                    )
                )
            progress(0.20, "Clearing land surfaces from water")

            counts.update(cut_water_land_surfaces(
                hierarchy["land_surfaces"], water_bodies,
                slab_thickness_mm,
                preserve_paved=ground_support is not None,
                beach_rise_mm=surface_settings.surface_rise_mm if settings.taper_beaches else 0.0,
                beach_width_mm=settings.beach_taper_width_mm,
                ground=heightfield.height_mm,
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
                    tidy_network=settings.tidy_road_network,
                    network_gap_mm=settings.road_gap_mm,
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
                        airport_features=(
                            _load_features(bundle, "infrastructure")
                            if settings.generate_roads else ()
                        ),
                    )
                )
                if settings.generate_land_surfaces and settings.cut_roads_at_export:
                    # Roads stand above the slabs, so leaving these whole looks
                    # the same, and a road deleted in Blender leaves no hole.
                    counts.update(defer_road_cut(
                        hierarchy["land_surfaces"],
                        slab_thickness_mm,
                    ))
                elif settings.generate_land_surfaces:
                    progress(.50, "Cutting road footprints")
                    counts.update(cut_road_footprints(
                        hierarchy["land_surfaces"], hierarchy["surface_roads"],
                        slab_thickness_mm,
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
                            avoid_roads=settings.tree_avoid_roads,
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
                        road_collection=hierarchy["surface_roads"],
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
                rock_covered = set()
                if lidar_profiles and settings.lidar_rock_surfaces and not settings.lidar_height_only:
                    from .geometry.lidar_rock import generate_rock_surfaces
                    rock_counts, rock_covered = generate_rock_surfaces(
                        lidar_profiles, transform, heightfield, hierarchy['land_surfaces'], materials['surface_rock'],
                        height_scale=settings.building_height_scale, embed=settings.surface_embed_mm,
                        spacing=surface_settings.drape_spacing_mm, minimum_width=settings.minimum_building_width_mm,
                        ground_support=ground_support)
                    counts.update(rock_counts)
                counts.update(
                    generate_buildings(
                        [f for f in _load_polygons(bundle, "building") if feature_id(f) not in rock_covered],
                        [f for f in _load_polygons(bundle, "building_part") if
                         str(feature_properties(f).get('building_id') or '') not in rock_covered],
                        transform,
                        heightfield,
                        floor_height_m=settings.floor_height_m,
                        default_height_m=settings.default_building_height_m,
                        height_scale=settings.building_height_scale,
                        minimum_height_mm=settings.minimum_building_height_mm,
                        retain_sparse_parents=settings.retain_sparse_building_parents,
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
                            f"{counts.get('lidar_height_only_buildings', 0)} height-only corrections; "
                            f"{counts.get('lidar_rock_surfaces', 0)} mapped rock surfaces; "
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


class JARVIZAR_OT_export_3mf(Operator, ExportHelper):
    bl_idname = "jarvizar.export_3mf"
    bl_label = "Export 3MF for Bambu"
    bl_description = (
        "Export generated geometry inside cutout's inner opening as a Bambu Studio project "
        "at true millimetres, one filament per colour, optionally divided across plates"
    )
    bl_options = {"REGISTER"}

    filename_ext = ".3mf"
    filter_glob: StringProperty(default="*.3mf", options={"HIDDEN"})

    @classmethod
    def poll(cls, context):
        return not is_generating() and not is_downloading()

    def execute(self, context):
        scene = context.scene
        settings = scene.jarvizar_city_model
        # Objects still in Edit Mode export their edits, not the mesh from before.
        update_from_edit_mode(scene)
        objects = generated_objects(scene)
        if not objects:
            settings.last_status = "Nothing to export: generate a model first"
            self.report({"ERROR"}, settings.last_status)
            return {"CANCELLED"}

        # Bambu Studio treats every top-level 3MF build item as its own
        # printable object: it re-centres each one on its own bounding box,
        # drops it to the bed and may rotate it onto another plate. Each plate
        # is therefore one multipart object with every relative height intact,
        # and each part carries its filament as Bambu's own extruder setting
        # rather than a colour left for the importer to map.
        from .blender.export_cutout import export_geometry, export_grid, export_sections, part_arrays
        from .data.area import fits_bed
        from .data.export_3mf import part_name_map
        from .data.export_plates import PRINTERS, PlateWriter

        exported = []

        def plate_parts(objects, depsgraph):
            names = part_name_map(objects)
            for obj in objects:
                arrays = part_arrays(obj, depsgraph)
                # An object whose faces were all deleted has nothing to print.
                if not arrays[1]:
                    continue
                exported.append(obj.name)
                yield (names[obj.name], *arrays)

        printer = PRINTERS[settings.bambu_printer]
        bed_status = ""
        try:
            with export_geometry(context, objects) as (parts, stats, opening):
                if not parts:
                    raise ValueError("Nothing to export inside cutout's inner opening")
                # Publish only after the whole project is written. Staging
                # alongside the destination keeps replacement atomic.
                destination = Path(self.filepath)
                ensure_writable(destination.parent, create=False)
                with tempfile.TemporaryDirectory(prefix=".jcm-3mf-", dir=destination.parent) as folder:
                    staged = Path(folder) / "project.3mf"
                    with PlateWriter(Path(folder) / "3dmodel.model", printer) as writer:
                        if settings.multi_plate_export:
                            grid = export_grid(context, parts, opening, settings.section_width_mm,
                                               settings.section_height_mm, printer)
                            with export_sections(context, parts, grid) as sections:
                                if not sections:
                                    raise ValueError("No section received geometry inside cutout's inner opening")
                                depsgraph = context.evaluated_depsgraph_get()
                                for section, section_parts in sections:
                                    writer.add_plate(section.name, plate_parts(section_parts, depsgraph),
                                                     section.bounds)
                            export_status = f"{writer.plate_count} Bambu plates"
                        else:
                            depsgraph = context.evaluated_depsgraph_get()
                            writer.add_plate("Map", plate_parts(parts, depsgraph))
                            export_status = "one Bambu plate"
                            west, south, east, north = writer.plate_bounds[-1]
                            if not fits_bed(east - west, north - south, printer.width, printer.depth):
                                bed_status = (
                                    f"; the model is {east - west:.0f} x {north - south:.0f} mm, larger "
                                    f"than the {printer.model} bed ({printer.bed}): add a cutout frame "
                                    "with Multi-Plate Export, or choose a smaller area")
                        writer.close(staged)
                    try:
                        staged.replace(destination)
                    except PermissionError as exc:
                        raise ValueError(f"Close {destination.name} in other programs "
                                         "or choose another name") from exc
                part_count = len(exported)
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

        settings.last_status = (
            f"Exported {part_count} parts as {export_status} for {printer.model} "
            f"with {len(writer.palette)} filaments to {destination.name}{bed_status}{crop_status}"
        )
        self.report({"WARNING"} if bed_status else {"INFO"}, settings.last_status)
        return {"FINISHED"}


class JARVIZAR_OT_cache_storage(Operator):
    bl_idname = 'jarvizar.cache_storage'
    bl_label = 'Review LiDAR Cache Cleanup'
    bl_description = 'Preview trimming reusable LiDAR data to the storage limits; preserve prepared models and geographic bundles'

    @classmethod
    def poll(cls, context):
        return not is_generating() and not JARVIZAR_OT_prepare_lidar._running and not is_downloading()

    def invoke(self, context, event):
        from .external.lidar_storage import CacheStorage
        try:
            self._root = _cache_root(context.scene.jarvizar_city_model).resolve()
            if not self._root.is_dir():
                raise ValueError('Cache folder does not exist yet')
            self._limits = storage_limits()
            self._preview = CacheStorage(self._root, *self._limits).plan()
        except (OSError, ValueError) as exc:
            self.report({'ERROR'}, str(exc))
            return {'CANCELLED'}
        return context.window_manager.invoke_props_dialog(self, width=460)

    def draw(self, context):
        from .external.lidar_storage import GIB
        layout = self.layout
        p = self._preview
        layout.label(text=f"Reusable data: {p['used']/GIB:.1f} GiB; limit: {self._limits[0]} GiB")
        layout.label(text=f"Disk free: {p['free']/GIB:.1f} GiB; reserve: {self._limits[1]} GiB")
        layout.label(text=f"Cleanup can reclaim approximately {p['reclaim']/GIB:.1f} GiB")
        layout.label(text='Prepared models and geographic bundles are preserved.')
        layout.label(text='Future preparation may need to download data again.')
        if p['shortfall']:
            layout.label(text='Protected data prevents meeting these limits.', icon='ERROR')
        layout.label(text='OK applies cleanup; Cancel leaves files as they are.')

    def execute(self, context):
        from .external.lidar_storage import CacheStorage, StorageFull, GIB
        from .external.lidar_worker import cache_owner
        try:
            if not hasattr(self, '_preview'):
                raise ValueError('Review the cleanup preview first')
            with cache_owner(self._root):
                storage = CacheStorage(self._root, *self._limits)
                # A changed cache needs a fresh preview, never broader deletion.
                before = {str(e['path']): e['bytes'] for e in self._preview['remove']}
                after = {str(e['path']): e['bytes'] for e in storage.plan()['remove']}
                if before != after:
                    raise ValueError('Cache changed; open the cleanup preview again')
                removed = storage.trim()
            self.report({'INFO'}, f'Reclaimed {removed/GIB:.1f} GiB of reusable LiDAR data')
            return {'FINISHED'}
        except (OSError, ValueError, StorageFull) as exc:
            self.report({'ERROR'}, str(exc))
            return {'CANCELLED'}


class JARVIZAR_OT_clear_model(Operator):
    bl_idname = "jarvizar.clear_model"
    bl_label = "Clear Generated Model"
    bl_description = "Remove only collections and objects generated by this add-on"
    bl_options = {"REGISTER", "UNDO"}

    @classmethod
    def poll(cls, context):
        return not is_generating() and not is_downloading()

    def execute(self, context):
        removed = clear_generated(context.scene)
        settings = context.scene.jarvizar_city_model
        settings.last_status = f"Cleared {removed} generated objects"
        self.report({"INFO"}, settings.last_status)
        return {"FINISHED"}


CLASSES = (
    JARVIZAR_OT_cache_storage,
    JARVIZAR_OT_cancel_lidar,
    JARVIZAR_OT_cancel_generation,
    JARVIZAR_OT_cancel_download,
    JARVIZAR_OT_move_surface_priority,
    JARVIZAR_OT_paste_bounds,
    JARVIZAR_OT_download_cache,
    JARVIZAR_OT_download_then_generate,
    JARVIZAR_OT_prepare_lidar,
    JARVIZAR_OT_generate_model,
    JARVIZAR_OT_export_3mf,
    JARVIZAR_OT_clear_model,
)
