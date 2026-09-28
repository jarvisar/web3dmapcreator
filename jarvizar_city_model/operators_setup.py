"""Downloader setup assistant, support report and settings reset.

The add-on never installs packages. The assistant copies the command that
runs the packaged setup script, then finds and checks the environment it
creates. Checks run only when a button is pressed; drawing reads the results
remembered in ``data.environment``.
"""

from __future__ import annotations

from contextlib import contextmanager
import platform
import re
import sys
import textwrap
from pathlib import Path

import bpy
from bpy.props import BoolProperty
from bpy.types import Operator

from .blender.collections import generated_roots
from .blender.generation_modal import _RUNTIME, active_session, is_generating
from .config import preferred_python_path
from .data import environment, support
from .operators import (
    JARVIZAR_OT_prepare_lidar,
    _bounds_from_settings,
    _cache_bundle,
    _cache_root,
    _transform_from_settings,
)


# Dialog widths scale with the interface, so a fixed line length fits.
DIALOG_WIDTH = 460
DIALOG_CHARS = 72
# Never reset: the area and this machine's paths.
KEPT_SETTINGS = frozenset({"west", "south", "east", "north", "cache_directory", "overture_python_path"})
ICONS = {environment.OK: "CHECKMARK", environment.FAIL: "CANCEL", environment.INFO: "INFO"}
OFFLINE_TEXT = "Online Access is off: Edit > Preferences > System > Network"
# Assistant state for this session; never saved.
_STATE = {"system_pythons": None, "message": ""}


def _busy() -> bool:
    return is_generating() or JARVIZAR_OT_prepare_lidar._running


def _is_windows() -> bool:
    return sys.platform.startswith("win")


def _abspath(value) -> str:
    value = (value or "").strip()
    return bpy.path.abspath(value) if value else ""


def _addon_preferences(context):
    addon = context.preferences.addons.get(__package__)
    if addon is None or not hasattr(addon.preferences, "overture_python_path"):
        return None
    return addon.preferences


def _candidates(context):
    settings = getattr(getattr(context, "scene", None), "jarvizar_city_model", None)
    scene_path = _abspath(settings.overture_python_path) if settings is not None else ""
    return environment.candidates(scene_path, _abspath(preferred_python_path()))


def _validate(path):
    """Check an interpreter, rejecting Blender's own, and remember the result."""
    result = environment.validate_interpreter(path, blender_paths=(sys.executable, bpy.app.binary_path))
    return environment.remember(result)


@contextmanager
def _waiting(context):
    window = getattr(context, "window", None)
    if window is not None:
        window.cursor_modal_set("WAIT")
    try:
        yield
    finally:
        if window is not None:
            window.cursor_modal_restore()


def _redraw(context):
    manager = getattr(context, "window_manager", None)
    for window in manager.windows if manager is not None else ():
        for area in window.screen.areas:
            area.tag_redraw()


def _offline_note() -> str:
    if getattr(bpy.app, "online_access", True):
        return ""
    if getattr(bpy.app, "online_access_override", False):
        return "Online access is off: Blender was started with --offline-mode"
    return OFFLINE_TEXT


def _dialog(context, operator, width, **options):
    """invoke_props_dialog with the options this Blender version supports."""
    parameters = bpy.types.WindowManager.bl_rna.functions["invoke_props_dialog"].parameters
    options = {key: value for key, value in options.items() if key in parameters}
    return context.window_manager.invoke_props_dialog(operator, width=width, **options)


def _sidebar_chars(context) -> int:
    """Characters per line for the region, as the panels in ui.py wrap them."""
    width = getattr(getattr(context, "region", None), "width", 0) or 300
    return max(25, int(width / 7) - 6)


def _lines(layout, text, chars, limit=0, icon="NONE"):
    """Labels wrapped at ``chars`` characters, at most ``limit`` lines."""
    lines = [line for paragraph in str(text).splitlines() for line in textwrap.wrap(paragraph, chars)]
    if limit and len(lines) > limit:
        lines = lines[:limit]
        lines[-1] = lines[-1][:chars - 3] + "..."
    column = layout.column(align=True)
    column.scale_y = 0.8
    for index, line in enumerate(lines):
        column.label(text=line, icon=icon if index == 0 else "NONE")


def _path_tail(path) -> str:
    path = Path(path)
    return f"...{Path(path.parent.parent.name) / path.parent.name / path.name}"


def _python_hint() -> str:
    if _is_windows():
        return ("Install Python 3.11, 3.12 or 3.13 from python.org. In the installer, tick "
                "\"Add python.exe to PATH\". Then copy and run the setup command.")
    if sys.platform == "darwin":
        return "Install Python 3.11, 3.12 or 3.13 from python.org, then copy and run the setup command."
    return ("Install python3 and python3-venv with your package manager, then copy and run "
            "the setup command.")


def _terminal_hint() -> str:
    finish = "Setup takes a few minutes and ends by printing the interpreter path."
    if _is_windows():
        return ("Press Start, type PowerShell and press Enter. Paste the command with Ctrl+V "
                f"and press Enter. {finish} Or double-click setup_downloader.cmd in the setup folder.")
    if sys.platform == "darwin":
        return f"Open Terminal (Applications > Utilities), paste the command with Cmd+V and press Return. {finish}"
    return f"Open a terminal, paste the command with Ctrl+Shift+V and press Enter. {finish}"


def _status(candidate):
    """(state, text) for an interpreter from what was last checked."""
    if not Path(candidate.path).is_file():
        return environment.FAIL, "Interpreter not found"
    result = environment.cached_result(candidate.path)
    if result is None:
        return environment.INFO, "Not tested yet"
    return (environment.OK if result.ok else environment.FAIL), result.summary()


# -------------------------------------------------------------- UI drawing
def draw_first_run(layout, context):
    """Main panel box until a downloader is set up and not known to fail,
    or while LiDAR is on and the last check found its packages missing."""
    candidate = environment.effective_candidate(_candidates(context))
    if candidate is None:
        title, detail = "First-time setup needed", "Map downloads need a separate Python environment."
    elif not Path(candidate.path).is_file():
        title, detail = "Downloader not found", candidate.path
    else:
        result = environment.cached_result(candidate.path)
        if result is None:
            return
        if result.ok:
            settings = getattr(getattr(context, "scene", None), "jarvizar_city_model", None)
            if (settings is None or not settings.use_lidar_buildings
                    or result.lidar_ok or result.note):
                return
            title, detail = "LiDAR packages missing", "Run the setup command with LiDAR packages."
        else:
            title, detail = "Downloader not working", result.error
    box = layout.box()
    row = box.row()
    row.alert = True
    row.label(text=title, icon="ERROR")
    _lines(box, detail, _sidebar_chars(context), limit=3)
    row = box.row()
    row.scale_y = 1.2
    row.operator("jarvizar.setup_downloader", text="Set Up Downloader", icon="PREFERENCES")


def draw_downloader_status(layout, context, preferences=False):
    """The interpreter downloads use, its last check, and Detect/Test.

    In the preferences the field above already shows the preference path.
    """
    chars = _sidebar_chars(context)
    candidate = environment.effective_candidate(_candidates(context))
    column = layout.column(align=True)
    if candidate is None:
        column.label(text="Not set up", icon="ERROR")
    else:
        if not (preferences and candidate.source == environment.PREFERENCE):
            column.label(text=f"{candidate.source}:")
            column.label(text=_path_tail(candidate.path))
        state, text = _status(candidate)
        _lines(layout, text, chars, limit=3, icon=ICONS[state])
    note = _offline_note()
    if note:
        _lines(layout, note, chars, icon="ERROR")
    row = layout.row(align=True)
    row.operator("jarvizar.detect_downloader", text="Detect", icon="VIEWZOOM")
    row.operator("jarvizar.test_downloader", text="Test", icon="PLAY")
    if preferences:
        layout.operator("jarvizar.setup_downloader", text="Set Up Downloader", icon="PREFERENCES")


def draw_help(layout):
    layout.separator()
    layout.label(text="Help")
    column = layout.column(align=True)
    column.operator("jarvizar.setup_downloader", text="Set Up Downloader", icon="PREFERENCES")
    column.operator("jarvizar.copy_support_info", text="Copy Support Info", icon="COPYDOWN")
    column.operator("jarvizar.reset_settings", text="Reset Settings", icon="LOOP_BACK")


def _draw_check(layout, context):
    box = layout.box()
    box.label(text="Status")
    candidate = environment.effective_candidate(_candidates(context))
    if candidate is None:
        box.label(text="No downloader set up yet", icon="ERROR")
    else:
        _lines(box, f"{candidate.source}: {candidate.path}", DIALOG_CHARS)
        result = environment.cached_result(candidate.path)
        if not Path(candidate.path).is_file():
            box.label(text="Interpreter not found", icon=ICONS[environment.FAIL])
        elif result is None:
            box.label(text="Not tested yet", icon=ICONS[environment.INFO])
        else:
            for text, state in result.checklist():
                _lines(box, text, DIALOG_CHARS, icon=ICONS[state])
    note = _offline_note()
    if note:
        _lines(box, f"{note}. Downloads need it.", DIALOG_CHARS, icon="ERROR")


# --------------------------------------------------------------- operators
class JARVIZAR_OT_setup_downloader(Operator):
    bl_idname = "jarvizar.setup_downloader"
    bl_label = "Downloader Setup"
    bl_description = "Set up the separate Python environment that downloads map data, step by step"

    def invoke(self, context, event):
        candidate = environment.effective_candidate(_candidates(context))
        result = environment.cached_result(candidate.path) if candidate is not None else None
        if _STATE["system_pythons"] is None and not (result is not None and result.ok):
            _STATE["system_pythons"] = environment.find_system_pythons()
        return _dialog(context, self, DIALOG_WIDTH, confirm_text="Close")

    def execute(self, context):
        return {"FINISHED"}

    def draw(self, context):
        layout = self.layout
        _lines(layout, "Map data downloads run in a separate Python environment, set up once on "
                       "each computer. Blender's own Python is not changed.", DIALOG_CHARS)
        found = _STATE["system_pythons"]
        candidate = environment.effective_candidate(_candidates(context))
        result = environment.cached_result(candidate.path) if candidate is not None else None
        working = result is not None and result.ok
        if found is not None and not environment.has_usable_python(found) and not working:
            box = layout.box()
            box.label(text="Python 3.10 or newer was not found", icon="ERROR")
            _lines(box, _python_hint(), DIALOG_CHARS)
            box.operator("wm.url_open", text="Get Python from python.org",
                         icon="URL").url = environment.PYTHON_DOWNLOAD_URL

        column = layout.column()
        column.label(text="1. Copy the setup command")
        row = column.row(align=True)
        row.operator("jarvizar.copy_setup_command", text="Copy Setup Command",
                     icon="COPYDOWN").with_lidar = False
        row.operator("jarvizar.copy_setup_command", text="Copy with LiDAR",
                     icon="COPYDOWN").with_lidar = True
        _lines(column, "The LiDAR packages are only needed for LiDAR buildings.", DIALOG_CHARS)
        column.separator()
        column.label(text="2. Run it in a terminal")
        _lines(column, _terminal_hint(), DIALOG_CHARS)
        column.operator("wm.path_open", text="Open Setup Folder",
                        icon="FILE_FOLDER").filepath = str(environment.SETUP_DIR)
        column.separator()
        column.label(text="3. Find the new environment")
        column.operator("jarvizar.detect_downloader", text="Detect", icon="VIEWZOOM")
        column.separator()
        column.label(text="4. Check it")
        column.operator("jarvizar.test_downloader", text="Test Downloader", icon="PLAY")
        if _STATE["message"]:
            _lines(layout, _STATE["message"], DIALOG_CHARS, limit=5, icon="INFO")
        _draw_check(layout, context)


class JARVIZAR_OT_copy_setup_command(Operator):
    bl_idname = "jarvizar.copy_setup_command"
    bl_label = "Copy Setup Command"
    bl_description = "Copy the command that creates the downloader environment, to paste into a terminal"

    with_lidar: BoolProperty(
        name="With LiDAR", default=False, options={"SKIP_SAVE"},
        description="Also install the optional LiDAR building packages",
    )

    @classmethod
    def description(cls, context, properties):
        if properties.with_lidar:
            return "Copy the setup command that also installs the optional LiDAR building packages"
        return cls.bl_description

    def execute(self, context):
        script = environment.setup_script()
        if not script.is_file():
            self.report({"ERROR"}, f"Setup files are missing from {script.parent}; reinstall the add-on")
            return {"CANCELLED"}
        context.window_manager.clipboard = environment.setup_command(with_lidar=self.with_lidar)
        _STATE["message"] = ("Setup command copied. Paste it into "
                             + ("PowerShell." if _is_windows() else "a terminal."))
        self.report({"INFO"}, _STATE["message"])
        return {"FINISHED"}


class JARVIZAR_OT_detect_downloader(Operator):
    bl_idname = "jarvizar.detect_downloader"
    bl_label = "Detect Downloader"
    bl_description = (
        "Find a working downloader environment and save its path in the add-on "
        "preferences. Runs each candidate Python briefly"
    )

    def execute(self, context):
        preferences = _addon_preferences(context)
        if preferences is None:
            self.report({"ERROR"}, "Enable the add-on in Preferences > Add-ons first")
            return {"CANCELLED"}
        with _waiting(context):
            chosen, checked = environment.detect(_candidates(context), _validate)
            _STATE["system_pythons"] = environment.find_system_pythons() if chosen is None else None
        if chosen is None:
            level = {"WARNING"}
            message = "No working downloader found. Run the setup command, then click Detect again."
            failed = [(candidate, result) for candidate, result in checked if result.exists]
            if failed:
                message += f" {failed[0][0].source}: {failed[0][1].error}."
        else:
            level = {"INFO"}
            if chosen.source == environment.PREFERENCE:
                message = "The downloader in the add-on preferences works."
            else:
                preferences.overture_python_path = chosen.path
                message = f"Found the downloader ({chosen.source}) and saved it in the add-on preferences."
                if not context.preferences.use_preferences_save:
                    message += " Save Preferences to keep it."
        scene = next((result for candidate, result in checked
                      if candidate.source == environment.SCENE), None)
        if scene is not None and not scene.ok:
            level = {"WARNING"}
            message += " This scene's Overture Python override does not work; clear it in Setup and Cache."
        _STATE["message"] = message
        self.report(level, message)
        _redraw(context)
        return {"FINISHED"}


class JARVIZAR_OT_test_downloader(Operator):
    bl_idname = "jarvizar.test_downloader"
    bl_label = "Test Downloader"
    bl_description = "Run the downloader's Python and check its version and packages"

    def execute(self, context):
        candidate = environment.effective_candidate(_candidates(context))
        if candidate is None:
            _STATE["message"] = "No downloader is set up. Copy and run the setup command, then click Detect."
            self.report({"ERROR"}, _STATE["message"])
            return {"CANCELLED"}
        with _waiting(context):
            result = _validate(candidate.path)
        _STATE["message"] = f"{candidate.source}: {result.summary()}"
        self.report({"INFO"} if result.ok else {"ERROR"}, _STATE["message"])
        _redraw(context)
        return {"FINISHED"}


# ---------------------------------------------------------------- settings
def _settings_properties(settings):
    """Generation, print and export settings: not the area, machine paths,
    status messages, offers or progress."""
    for prop in settings.bl_rna.properties:
        name = prop.identifier
        if (prop.is_readonly or prop.type not in {"BOOLEAN", "INT", "FLOAT", "STRING", "ENUM"}
                or name in _RUNTIME or name in KEPT_SETTINGS or prop.is_skip_save
                or name.startswith("lidar_laz_offer_") or name.endswith("_status")):
            continue
        yield prop


def _value(settings, prop):
    value = getattr(settings, prop.identifier)
    if prop.type == "ENUM" and prop.is_enum_flag:
        return set(value)
    return tuple(value) if getattr(prop, "is_array", False) else value


def _default(prop):
    if prop.type == "ENUM":
        return set(prop.default_flag) if prop.is_enum_flag else prop.default
    return tuple(prop.default_array) if getattr(prop, "is_array", False) else prop.default


class JARVIZAR_OT_reset_settings(Operator):
    bl_idname = "jarvizar.reset_settings"
    bl_label = "Reset Settings"
    bl_description = (
        "Reset every generation, print and export setting to its default. Keeps "
        "the area, cache folder and downloader path"
    )
    bl_options = {"REGISTER", "UNDO"}

    @classmethod
    def poll(cls, context):
        return not _busy()

    def invoke(self, context, event):
        return _dialog(context, self, 360, confirm_text="Reset")

    def draw(self, context):
        _lines(self.layout, "Reset every generation, print and export setting to its default?", 56)
        _lines(self.layout, "Kept: the area, cache folder and downloader path.", 56)

    def execute(self, context):
        settings = context.scene.jarvizar_city_model
        names = [prop.identifier for prop in _settings_properties(settings)]
        for name in names:
            settings.property_unset(name)
        settings.last_status = "Settings reset to defaults; area, cache folder and downloader kept"
        self.report({"INFO"}, settings.last_status)
        return {"FINISHED"}


# ------------------------------------------------------------ support info
def _safe(build, *args):
    try:
        return build(*args)
    except Exception as exc:  # noqa: BLE001 - a report section must not stop the report
        return [f"Could not read: {type(exc).__name__}: {exc}"]


def _addon_lines():
    folder = Path(__file__).resolve().parent
    manifest = folder / "blender_manifest.toml"
    version = "unknown"
    if manifest.is_file():
        match = re.search(r'^version\s*=\s*"([^"]+)"', manifest.read_text(encoding="utf-8"), re.MULTILINE)
        version = match.group(1) if match else version
    info = getattr(sys.modules.get(__package__), "bl_info", {}) or {}
    if info.get("version"):
        declared = ".".join(str(part) for part in info["version"])
        if declared != version:
            version += f" (bl_info {declared})"
    install = "extension" if __package__.startswith("bl_ext.") else "classic add-on"
    setup = "present" if environment.setup_script().is_file() else "missing"
    return [f"Version: {version}", f"Package: {__package__} ({install})", f"Folder: {folder}",
            f"Setup scripts: {setup}"]


def _system_lines():
    build = bpy.app.build_hash
    build = build.decode(errors="replace") if isinstance(build, bytes) else str(build)
    lines = [f"Blender: {bpy.app.version_string} ({build})",
             f"Blender Python: {platform.python_version()}",
             f"System: {platform.platform()} ({platform.machine()})"]
    if hasattr(bpy.app, "online_access"):
        lines.append(f"Online access: {'on' if bpy.app.online_access else 'off'}")
    lines.append(support.home_notes())
    return lines


def _downloader_lines(context):
    found = _candidates(context)
    candidate = environment.effective_candidate(found)
    lines = []
    for item in found:
        exists = Path(item.path).is_file()
        if item.source == environment.DEVELOPER and not exists:
            continue
        used = "; used for downloads" if item == candidate else ""
        lines.append(f"{item.source}: {item.path} ({'found' if exists else 'missing'}{used})")
    if candidate is None:
        return lines + ["Downloads use: nothing is set up"]
    return lines + support.validation_lines(_validate(candidate.path))


def _cache_folder(settings) -> str:
    try:
        return str(_cache_root(settings))
    except ValueError as exc:
        # The report still says why the folder cannot be used.
        return f"{settings.cache_directory} ({exc})" if settings.cache_directory.strip() else ""


def _area_lines(settings):
    lines = [f"Bounds (W,S,E,N): {settings.west},{settings.south},{settings.east},{settings.north}"]
    try:
        bounds = _bounds_from_settings(settings)
    except ValueError as exc:
        return lines + [f"Bounds are not valid: {exc}"]
    transform = _transform_from_settings(settings, bounds)
    model = transform.model_bounds
    return lines + [
        f"Scale mode: {settings.scale_mode}; {transform.scale_x_mm_per_m:.4g} mm per metre "
        f"(1:{transform.scale_ratio:,.0f})",
        f"Model size: {model.width_mm:.1f} x {model.height_mm:.1f} mm",
    ]


def _status_lines(settings):
    session = active_session()
    lines = [f"Last status: {support.truncate(settings.last_status, support.TEXT_LIMIT)}",
             f"Generating: {'yes, ' + session.phase if session is not None else 'no'}",
             f"Use prepared LiDAR: {support.format_value(settings.use_lidar_buildings)}",
             f"LiDAR preparation running: {'yes' if JARVIZAR_OT_prepare_lidar._running else 'no'}"]
    for label, text in (("Last LiDAR preparation", settings.lidar_preparation_status),
                        ("Last LiDAR generation", settings.lidar_generation_status)):
        if text:
            lines.append(f"{label}: {support.truncate(text, support.TEXT_LIMIT)}")
    if settings.lidar_laz_offer_token:
        lines.append(f"LiDAR tile offer: {settings.lidar_laz_offer_summary or 'pending'}")
    return lines


def _model_lines(scene):
    roots = generated_roots(scene)
    if not roots:
        return ["No generated model in this scene"]
    lines = []
    for root in roots:
        lines.append(f"{root.name}: {len(root.all_objects)} objects")
        for key in ("bbox_wgs84", "overture_release", "scale_ratio", "model_size_mm"):
            if root.get(key) is not None:
                lines.append(f"{key}: {root.get(key)}")
        counts = root.get("generation_counts_json")
        if counts:
            lines.append("Counts: " + support.truncate(counts, support.COUNTS_LIMIT))
    return lines


def _bundle_lines(settings):
    bundle = _cache_bundle(settings)
    return ([f"Folder: {bundle.path}"] + support.manifest_lines(bundle.read_manifest())
            + support.bundle_file_lines(bundle.path))


def support_sections(context):
    """Report sections; each is read independently so one failure is reported
    in place instead of stopping the report."""
    scene = context.scene
    settings = scene.jarvizar_city_model
    cache = _safe(_cache_folder, settings)
    cache = cache if isinstance(cache, str) else ""
    changes = _safe(lambda: support.setting_changes(
        (prop.identifier, _value(settings, prop), _default(prop))
        for prop in _settings_properties(settings)))
    return [
        ("Add-on", _safe(_addon_lines)),
        ("Blender and system", _safe(_system_lines)),
        ("Downloader", _safe(_downloader_lines, context)),
        ("Cache", _safe(support.cache_lines, cache)),
        ("Area and scale", _safe(_area_lines, settings)),
        ("Settings changed from defaults", changes or ["None"]),
        ("Status", _safe(_status_lines, settings)),
        ("Generated model", _safe(_model_lines, scene)),
        ("Cache bundle", _safe(_bundle_lines, settings)),
        ("Recent logs", _safe(support.recent_logs, cache)),
    ]


class JARVIZAR_OT_copy_support_info(Operator):
    bl_idname = "jarvizar.copy_support_info"
    bl_label = "Copy Support Info"
    bl_description = (
        "Copy a plain-text report for a support request: versions, the downloader "
        "check, changed settings and the last messages. Also saved in the cache folder"
    )

    def execute(self, context):
        settings = context.scene.jarvizar_city_model
        with _waiting(context):
            text = support.build_report(support_sections(context))
        context.window_manager.clipboard = text
        if not settings.cache_directory.strip():
            self.report({"WARNING"}, "Support info copied; set a cache folder to also save it as a file")
            return {"FINISHED"}
        try:
            path = support.save_report(_cache_root(settings), text)
        except (OSError, ValueError) as exc:
            self.report({"WARNING"}, f"Support info copied; could not save it: {exc}")
            return {"FINISHED"}
        self.report({"INFO"}, f"Support info copied and saved to {path}")
        return {"FINISHED"}


CLASSES = (
    JARVIZAR_OT_setup_downloader,
    JARVIZAR_OT_copy_setup_command,
    JARVIZAR_OT_detect_downloader,
    JARVIZAR_OT_test_downloader,
    JARVIZAR_OT_reset_settings,
    JARVIZAR_OT_copy_support_info,
)
