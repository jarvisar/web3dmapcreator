"""Downloader setup assistant, support report and settings reset in Blender.

Needs a working downloader interpreter, such as the repository's
.venv-overture, given after ``--`` or in JARVIZAR_TEST_DOWNLOADER_PYTHON::

    blender --background --factory-startup --python-exit-code 1 --python tests/blender_setup_tools.py -- .venv-overture/Scripts/python.exe

Nothing is installed and nothing is downloaded. Prints JARVIZAR_SETUP_TOOLS_OK.
"""

import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from unittest import mock

import bpy

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
DOWNLOADER = os.path.abspath(arguments[0] if arguments else os.environ.get("JARVIZAR_TEST_DOWNLOADER_PYTHON", ""))
assert Path(DOWNLOADER).is_file(), f"Pass a working downloader python after --, not {DOWNLOADER!r}"
os.environ.pop("JARVIZAR_OVERTURE_PYTHON", None)

bpy.ops.preferences.addon_enable(module="jarvizar_city_model")
import jarvizar_city_model  # noqa: E402
from jarvizar_city_model import config, operators, operators_setup, ui  # noqa: E402
from jarvizar_city_model.data import environment, support  # noqa: E402
from jarvizar_city_model.data.cache import Bounds, CacheBundle  # noqa: E402
from jarvizar_city_model.blender.collections import GENERATED_KEY, ROOT_KEY  # noqa: E402

assert Path(jarvizar_city_model.__file__).resolve().parent == ROOT / "jarvizar_city_model"
environment.PROBE_TIMEOUT = 180.0  # a busy machine can be slow to import pyarrow
preferences = bpy.context.preferences.addons["jarvizar_city_model"].preferences
settings = bpy.context.scene.jarvizar_city_model
ICONS = set(bpy.types.UILayout.bl_rna.functions["label"].parameters["icon"].enum_items.keys())


class Layout:
    """Records what a draw function shows, checking names like Blender would."""

    def __init__(self, record):
        self.record = record

    def label(self, text="", icon="NONE", **_):
        assert icon in ICONS, icon
        self.record.append(("label", text, icon))

    def prop(self, data, name, icon="NONE", **_):
        assert name in data.bl_rna.properties, name
        assert icon in ICONS, icon
        self.record.append(("prop", name, icon))

    def operator(self, idname, icon="NONE", **_):
        assert icon in ICONS, icon
        module, name = idname.split(".")
        getattr(getattr(bpy.ops, module), name).get_rna_type()
        self.record.append(("operator", idname, icon))
        return SimpleNamespace()

    def separator(self, **_):
        pass

    def menu(self, *args, **_):
        pass

    def box(self):
        return Layout(self.record)

    row = column = split = lambda self, **_: Layout(self.record)


def run(operator, *args, **kwargs):
    """Operator result, or the message of the error it reported."""
    try:
        return operator(*args, **kwargs)
    except RuntimeError as exc:
        return str(exc)


def draw(function, *args, **kwargs):
    record = []
    function(Layout(record), *args, **kwargs)
    return record


def labels(record):
    return [text for kind, text, _ in record if kind == "label"]


def main_panel():
    record = []
    ui.JARVIZAR_PT_city_model.draw(SimpleNamespace(layout=Layout(record)), context)
    return record


context = SimpleNamespace(scene=bpy.context.scene, region=SimpleNamespace(width=180),
                          preferences=bpy.context.preferences, window=None,
                          window_manager=bpy.context.window_manager)

with tempfile.TemporaryDirectory() as folder:
    folder = Path(folder)
    missing_default = folder / "no-default" / "python.exe"
    with mock.patch.object(environment, "default_venv_python", return_value=missing_default), \
            mock.patch.object(environment, "developer_venv_python", return_value=folder / "no-repo"):
        # ------------------------------------------------ nothing set up yet
        preferences.overture_python_path = ""
        settings.overture_python_path = ""
        shown = labels(main_panel())
        assert "First-time setup needed" in shown, shown
        assert "No downloader is set up" in run(bpy.ops.jarvizar.test_downloader)
        assert "No downloader is set up" in operators_setup._STATE["message"]
        assert bpy.ops.jarvizar.copy_setup_command(with_lidar=True) == {"FINISHED"}
        assert operators_setup._STATE["message"].startswith("Setup command copied")
        operators_setup._STATE["system_pythons"] = []
        record = []
        operators_setup.JARVIZAR_OT_setup_downloader.draw(SimpleNamespace(layout=Layout(record)), context)
        assert ("operator", "wm.url_open", "URL") in record, record
        assert ("operator", "jarvizar.detect_downloader", "VIEWZOOM") in record
        assert "No downloader set up yet" in labels(record)
        print("SETUP_NOT_CONFIGURED_OK")

        # ------------------------------------ Detect finds and stores one
        os.environ["JARVIZAR_OVERTURE_PYTHON"] = DOWNLOADER
        assert bpy.ops.jarvizar.detect_downloader() == {"FINISHED"}
        del os.environ["JARVIZAR_OVERTURE_PYTHON"]
        assert os.path.samefile(preferences.overture_python_path, DOWNLOADER), preferences.overture_python_path
        assert "saved it in the add-on preferences" in operators_setup._STATE["message"]
        assert bpy.ops.jarvizar.test_downloader() == {"FINISHED"}
        result = environment.cached_result(preferences.overture_python_path)
        assert result is not None and result.ok, result
        assert result.downloader.version == environment.pinned_versions()["overturemaps"]
        assert operators_setup._STATE["message"].startswith("Add-on preference: Working: overturemaps")
        assert not [row for row in main_panel() if row[1] in {"First-time setup needed", "Downloader not working"}]
        # With LiDAR on, a check that found its packages missing says so.
        environment.remember(environment.ValidationResult(
            path=preferences.overture_python_path, exists=True, ran=True, python_version=(3, 11, 5),
            downloader=environment.ModuleStatus("overturemaps", True, "1.0.2")))
        assert "LiDAR packages missing" not in labels(main_panel())
        settings.use_lidar_buildings = True
        assert "LiDAR packages missing" in labels(main_panel())
        settings.use_lidar_buildings = False
        environment.remember(result)
        status = labels(draw(operators_setup.draw_downloader_status, context))
        assert status[0] == "Add-on preference:" and any(text.startswith("Working") for text in status), status
        record = []
        config.JARVIZAR_AP_preferences.draw(
            SimpleNamespace(layout=Layout(record), bl_rna=preferences.bl_rna), context)
        assert ("operator", "jarvizar.setup_downloader", "PREFERENCES") in record, record
        print("SETUP_DETECT_AND_TEST_OK")

        # --------------------------------------- Blender's Python is refused
        own = operators_setup._validate(sys.executable)
        assert own.blender_python and not own.ok, own
        binary = operators_setup._validate(bpy.app.binary_path)
        assert binary.blender_python and not binary.ok, binary
        preferences.overture_python_path = sys.executable
        assert "Blender's own Python" in run(bpy.ops.jarvizar.test_downloader)
        assert "Downloader not working" in labels(main_panel())
        assert run(bpy.ops.jarvizar.detect_downloader) == {"FINISHED"}
        assert preferences.overture_python_path == sys.executable, "nothing better to store"
        assert operators_setup._STATE["message"].startswith("No working downloader found")
        preferences.overture_python_path = DOWNLOADER

        # A broken scene override takes precedence, so Detect reports it.
        settings.overture_python_path = str(folder / "missing" / "python.exe")
        assert "Downloader not found" in labels(main_panel())
        assert bpy.ops.jarvizar.detect_downloader() == {"FINISHED"}
        assert "override does not work" in operators_setup._STATE["message"]
        assert os.path.samefile(preferences.overture_python_path, DOWNLOADER)
        settings.overture_python_path = ""
        print("SETUP_REJECTIONS_OK")

        # ------------------------------------------------ support report
        cache = folder / "cache"
        settings.cache_directory = str(cache)
        bounds = operators._bounds_from_settings(settings)
        bundle = CacheBundle(cache, Bounds(*bounds.as_tuple()))
        bundle.write_manifest({"release": "TEST-RELEASE", "client_version": "1.0.2",
                               "feature_counts": {"building": 12}})
        bundle.data_path("building").write_text('{"type":"FeatureCollection","features":[]}', encoding="utf-8")
        logs = cache / "logs"
        logs.mkdir()
        for index in range(7):
            path = logs / f"download-{index}.log"
            path.write_text("log", encoding="utf-8")
            os.utime(path, (1_700_000_000 + index, 1_700_000_000 + index))
        root = bpy.data.collections.new("CITY_MODEL")
        bpy.context.scene.collection.children.link(root)
        root[ROOT_KEY] = True
        root[GENERATED_KEY] = True
        root["generation_counts_json"] = json.dumps({f"count_{index}": index for index in range(2000)})
        settings.generate_trees = True
        settings.mm_per_metre = 0.1
        settings.last_status = "Download failed: test failure"
        settings.lidar_preparation_status = "Prepared 3/4 buildings"
        assert bpy.ops.jarvizar.copy_support_info() == {"FINISHED"}
        reports = list((cache / "support").glob("support-*.txt"))
        assert len(reports) == 1, reports
        text = reports[0].read_text(encoding="utf-8")
        sections = {}
        for block in text.split("\n\n")[1:]:
            title, _, body = block.partition("\n")
            sections[title.strip("[]")] = body
        assert list(sections) == ["Add-on", "Blender and system", "Downloader", "Cache", "Area and scale",
                                  "Settings changed from defaults", "Status", "Generated model",
                                  "Cache bundle", "Recent logs"], list(sections)
        assert "Package: jarvizar_city_model (classic add-on)" in sections["Add-on"]
        assert "Setup scripts: present" in sections["Add-on"]
        assert "(found; used for downloads)" in sections["Downloader"], sections["Downloader"]
        assert "[ok] overturemaps " in sections["Downloader"], sections["Downloader"]
        assert "Exists: yes; writable: yes" in sections["Cache"]
        changed = sections["Settings changed from defaults"].splitlines()
        assert "generate_trees: on (default off)" in changed, changed
        assert "mm_per_metre: 0.1 (default 0.07)" in changed, changed
        assert not [line for line in changed if line.split(":")[0] in
                    {"west", "cache_directory", "last_status", "lidar_preparation_status"}], changed
        assert "Last status: Download failed: test failure" in sections["Status"]
        assert "Last LiDAR preparation: Prepared 3/4 buildings" in sections["Status"]
        assert "more characters)" in sections["Generated model"]
        assert "Overture release: TEST-RELEASE" in sections["Cache bundle"]
        assert "building.geojson" in sections["Cache bundle"]
        assert sections["Recent logs"].splitlines()[0].startswith("download-6.log")
        assert sections["Recent logs"].splitlines()[-1] == "2 older logs not listed"
        home = str(Path.home())
        assert home.lower() not in text.lower() or len(home) < 4, "home folder must be hidden"
        assert settings.last_status == "Download failed: test failure", "the report leaves the status alone"
        bpy.data.collections.remove(root)
        print("SETUP_SUPPORT_INFO_OK")

        # ------------------------------------------------- reset settings
        settings.west, settings.south, settings.east, settings.north = "12.4", "41.8", "12.6", "41.95"
        settings.overture_python_path = "C:/elsewhere/python.exe"
        settings.lidar_preparation_status = "kept preparation"
        settings.lidar_generation_status = "kept generation"
        settings.lidar_laz_offer_token = "token"
        settings.lidar_laz_offer_details = "details"
        settings.lidar_laz_offer_summary = "summary"
        settings.show_laz_offer_details = True
        changes = dict(scale_mode="FIT", generate_bridges=True, road_gap_mm=0.9, lidar_roof_mode="TERRACES",
                       use_lidar_buildings=True, force_redownload=True, set_scene_units=False,
                       multi_plate_export=True, bambu_printer="A1M", section_width_mm=150.0,
                       terrain_resolution=300, lidar_stac_urls="https://example.test/stac")
        for name, value in changes.items():
            setattr(settings, name, value)
        assert bpy.ops.jarvizar.move_surface_priority(index=0, direction=1) == {"FINISHED"}
        kept = {name: getattr(settings, name) for name in (
            "west", "south", "east", "north", "cache_directory", "overture_python_path",
            "lidar_preparation_status", "lidar_generation_status", "lidar_laz_offer_token",
            "lidar_laz_offer_details", "lidar_laz_offer_summary", "show_laz_offer_details")}
        resettable = [prop.identifier for prop in operators_setup._settings_properties(settings)]
        assert set(changes) | {"surface_priority_order", "generate_trees", "mm_per_metre"} <= set(resettable)
        assert not set(kept) & set(resettable)

        operators.JARVIZAR_OT_prepare_lidar._running = True
        assert not bpy.ops.jarvizar.reset_settings.poll()
        operators.JARVIZAR_OT_prepare_lidar._running = False
        assert bpy.ops.jarvizar.reset_settings.poll()
        record = []
        operators_setup.JARVIZAR_OT_reset_settings.draw(SimpleNamespace(layout=Layout(record)), context)
        assert any("Kept: the area" in text for text in labels(record))
        assert bpy.ops.jarvizar.reset_settings("EXEC_DEFAULT") == {"FINISHED"}
        differing = [prop.identifier for prop in operators_setup._settings_properties(settings)
                     if support.values_differ(operators_setup._value(settings, prop),
                                              operators_setup._default(prop))]
        assert not differing, differing
        assert settings.surface_priority_order == settings.bl_rna.properties["surface_priority_order"].default
        assert {name: getattr(settings, name) for name in kept} == kept
        assert settings.last_status.startswith("Settings reset to defaults")
        print("SETUP_RESET_OK")

        # ------------------------------------- panels draw in every state
        environment.forget()
        for panel in ui.CLASSES:
            if hasattr(panel, "draw") and panel.__name__.startswith("JARVIZAR_PT"):
                panel.draw(SimpleNamespace(layout=Layout([]), feature=getattr(panel, "feature", "")), context)
        help_rows = draw(operators_setup.draw_help)
        assert [row[1] for row in help_rows if row[0] == "operator"] == [
            "jarvizar.setup_downloader", "jarvizar.copy_support_info", "jarvizar.reset_settings"]

bpy.ops.preferences.addon_disable(module="jarvizar_city_model")
print("JARVIZAR_SETUP_TOOLS_OK")
