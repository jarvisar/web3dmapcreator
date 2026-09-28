"""Download operator: background synchronous path and the modal lifecycle.

Blender's own Python runs tests/download_helper_fixture.py in place of the
real downloaders, so no network or downloader environment is needed.
"""

import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
from types import SimpleNamespace
from unittest.mock import Mock, patch

import bpy

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
import jarvizar_city_model as addon
from jarvizar_city_model import operators
from jarvizar_city_model.blender import download_modal
from jarvizar_city_model.data import download_job
from test_download_job import alive

FIXTURE = ROOT / "tests" / "download_helper_fixture.py"
addon.register()
work = Path(tempfile.mkdtemp(prefix="jcm_download_operator_"))
control = work / "control"
control.mkdir()
scenario_path = work / "scenario.json"
os.environ["JCM_FAKE_DOWNLOAD"] = str(scenario_path)
patch.object(download_job, "_external_script", lambda name: FIXTURE).start()
# Blender 4.2+ starts offline under --factory-startup; offline cases patch this again.
patch.object(operators, "_offline", return_value=False).start()


def scenario(**modes):
    for path in control.iterdir():
        path.unlink()
    scenario_path.write_text(json.dumps({**modes, "control": str(control)}), encoding="utf-8")


settings = bpy.context.scene.jarvizar_city_model
settings.cache_directory = str(work / "cache")
settings.overture_python_path = sys.executable
for name in ("generate_roads", "generate_bridges", "generate_water", "generate_land_surfaces",
             "generate_trees", "cut_water_from_terrain", "recess_ponds_and_fountains"):
    setattr(settings, name, False)
bundle = operators._cache_bundle(settings)


def cached_files():
    if not bundle.path.exists():
        return {}
    return {path.name: path.read_bytes() for path in sorted(bundle.path.iterdir())}


def download_reporting_error():
    """bpy.ops raises when an operator reports an error."""
    try:
        bpy.ops.jarvizar.download_cache()
    except RuntimeError as exc:
        return str(exc)
    raise AssertionError(f"Download did not fail: {settings.last_status}")


# ---------------------------------------------------------------- background
scenario(overture="success", dem="success")
assert bpy.ops.jarvizar.download_cache() == {"FINISHED"}, settings.last_status
assert settings.last_status == ("Cached release 2026-01-01.0: 1 building, 1 building_part, "
                                "DEM 4x4 (100-115 m)"), settings.last_status
assert bundle.has_dem() and not bundle.missing_types(("building", "building_part"))
assert len(list((bundle.cache_root / "logs").glob("download-*.log"))) == 1
assert bpy.ops.jarvizar.download_cache() == {"FINISHED"}
assert settings.last_status == "Using cache: 1 building, 1 building_part", settings.last_status
before = cached_files()

settings.force_redownload = True
scenario(overture="network")
assert "getaddrinfo failed" in download_reporting_error()
assert settings.last_status.startswith(
    "Download failed: Could not reach the Overture servers; check internet, VPN, firewall or proxy"), \
    settings.last_status
assert "getaddrinfo failed" in settings.last_status
assert cached_files() == before
assert not list(bundle.cache_root.glob("jarvizar_download_*"))

with patch.object(operators, "_offline", return_value=True):
    assert "Allow Online Access" in download_reporting_error()
    assert "Allow Online Access" in settings.last_status, settings.last_status
    settings.force_redownload = False
    # Everything is cached, so no network access is needed.
    assert bpy.ops.jarvizar.download_cache() == {"FINISHED"}
    assert settings.last_status.startswith("Using cache"), settings.last_status
print("DOWNLOAD_BACKGROUND_OK")

# --------------------------------------------------------------------- modal
settings.force_redownload = True
fake_bpy = SimpleNamespace(app=SimpleNamespace(background=False, online_access=True),
                           path=bpy.path, data=bpy.data)


class Driver:
    execute = operators.JARVIZAR_OT_download_cache.execute
    modal = operators.JARVIZAR_OT_download_cache.modal
    cancel = operators.JARVIZAR_OT_download_cache.cancel

    def __init__(self, then_generate=False):
        self.report = Mock()
        self.then_generate = then_generate


def context():
    return SimpleNamespace(scene=bpy.context.scene, window=None, window_manager=Mock(),
                           preferences=bpy.context.preferences, screen=None)


def drive(driver, ctx, limit=30.0):
    deadline = time.monotonic() + limit
    while True:
        result = driver.modal(ctx, SimpleNamespace(type="TIMER"))
        if result != {"RUNNING_MODAL"}:
            return result
        assert time.monotonic() < deadline, driver._session.status()
        time.sleep(0.05)


def start_hanging(driver, ctx):
    scenario(overture="hang")
    assert driver.execute(ctx) == {"RUNNING_MODAL"}
    ctx.window_manager.modal_handler_add.assert_called_once()
    deadline = time.monotonic() + 30
    while not (control / "overture-pids.json").exists():
        assert time.monotonic() < deadline, "The fake helper never started"
        assert driver.modal(ctx, SimpleNamespace(type="TIMER")) == {"RUNNING_MODAL"}
        time.sleep(0.05)
    # The helper reports progress before it records its process ids.
    assert driver.modal(ctx, SimpleNamespace(type="TIMER")) == {"RUNNING_MODAL"}
    assert driver.modal(ctx, SimpleNamespace(type="MOUSEMOVE")) == {"PASS_THROUGH"}
    assert download_modal.is_downloading()
    blocked = (operators.JARVIZAR_OT_download_cache, operators.JARVIZAR_OT_generate_model,
               operators.JARVIZAR_OT_prepare_lidar, operators.JARVIZAR_OT_export_3mf,
               operators.JARVIZAR_OT_clear_model, operators.JARVIZAR_OT_cache_storage)
    for operator in blocked:
        assert not operator.poll(bpy.context), operator.bl_idname
    assert operators.JARVIZAR_OT_cancel_download.poll(bpy.context)
    status = download_modal.active_download().status()
    assert status["title"] == "Downloading data" and status["stage"] == "Overture data", status
    assert status["message"] == "Downloading building (1/2)", status


def assert_stopped(driver, ctx):
    pids = json.loads((control / "overture-pids.json").read_text(encoding="utf-8"))
    grandchild = int((control / "overture-grandchild.pid").read_text(encoding="utf-8"))
    deadline = time.monotonic() + 10
    while any(alive(pid) for pid in (pids["helper"], pids["launcher"], grandchild)):
        assert time.monotonic() < deadline, "Download helpers are still running"
        time.sleep(0.05)
    job = driver._session.job
    assert job.state == "cancelled" and job._steps[job._index].process.poll() is not None
    assert not download_modal.is_downloading()
    assert not list(bundle.cache_root.glob("jarvizar_download_*"))
    assert cached_files() == before
    for operator in (operators.JARVIZAR_OT_download_cache, operators.JARVIZAR_OT_generate_model,
                     operators.JARVIZAR_OT_clear_model):
        assert operator.poll(bpy.context), operator.bl_idname
    assert not operators.JARVIZAR_OT_cancel_download.poll(bpy.context)
    ctx.window_manager.progress_end.assert_called_once()
    ctx.window_manager.event_timer_remove.assert_called_once()


with patch.object(operators, "bpy", fake_bpy):
    for how in ("ESC", "button", "detach", "shutdown"):
        driver, ctx = Driver(), context()
        start_hanging(driver, ctx)
        started = time.monotonic()
        if how == "ESC":
            assert driver.modal(ctx, SimpleNamespace(type="ESC")) == {"RUNNING_MODAL"}
            assert download_modal.active_download().status()["title"] == "Stopping download"
            assert drive(driver, ctx) == {"CANCELLED"}
            driver.report.assert_called_with({"INFO"}, "Download cancelled; cache unchanged")
        elif how == "button":
            assert bpy.ops.jarvizar.cancel_download() == {"FINISHED"}
            assert drive(driver, ctx) == {"CANCELLED"}
        elif how == "detach":
            # File load or window closure: Blender calls cancel() and no more events.
            driver.cancel(ctx)
            assert driver.modal(ctx, SimpleNamespace(type="TIMER")) == {"CANCELLED"}
        else:
            download_modal.shutdown_download()
        assert time.monotonic() - started < 10
        assert settings.last_status == "Download cancelled; cache unchanged", settings.last_status
        assert_stopped(driver, ctx)
        print("DOWNLOAD_CANCEL_OK", how)

    driver, ctx = Driver(), context()
    scenario(overture="network")
    assert driver.execute(ctx) == {"RUNNING_MODAL"}
    assert drive(driver, ctx) == {"CANCELLED"}
    assert settings.last_status.startswith("Download failed: Could not reach the Overture servers")
    driver.report.assert_called_with({"ERROR"}, settings.last_status)
    assert cached_files() == before

    driver, ctx = Driver(), context()
    scenario(overture="success", dem="success")
    assert driver.execute(ctx) == {"RUNNING_MODAL"}
    assert settings.last_status == "Downloading building, building_part, elevation tiles..."
    assert drive(driver, ctx) == {"FINISHED"}
    assert settings.last_status.startswith("Cached release 2026-01-01.0: 1 building"), settings.last_status
    driver.report.assert_called_with({"INFO"}, settings.last_status)
    assert not download_modal.is_downloading()

    # A failure to start the timer must not leave the helper running.
    driver, ctx = Driver(), context()
    scenario(overture="hang")
    ctx.window_manager.event_timer_add.side_effect = RuntimeError("timer setup failed")
    assert driver.execute(ctx) == {"CANCELLED"}
    assert "Could not start the download: timer setup failed" in settings.last_status
    assert not download_modal.is_downloading()
    assert not list(bundle.cache_root.glob("jarvizar_download_*"))

    # Generate's offer: generation follows only a successful download.
    with patch.object(operators, "_generate_after_download") as generate_later:
        for modes, expected in (({"overture": "network"}, 0), ({"overture": "success", "dem": "success"}, 1)):
            driver, ctx = Driver(then_generate=True), context()
            scenario(**modes)
            assert driver.execute(ctx) == {"RUNNING_MODAL"}
            drive(driver, ctx)
            assert generate_later.call_count == expected, (modes, settings.last_status)
        driver, ctx = Driver(then_generate=True), context()
        start_hanging(driver, ctx)
        assert driver.modal(ctx, SimpleNamespace(type="ESC")) == {"RUNNING_MODAL"}
        assert drive(driver, ctx) == {"CANCELLED"}
        assert generate_later.call_count == 1
        settings.force_redownload = False
        assert Driver(then_generate=True).execute(context()) == {"FINISHED"}
        assert settings.last_status.startswith("Using cache"), settings.last_status
        assert generate_later.call_count == 2
        settings.force_redownload = True
print("DOWNLOAD_THEN_GENERATE_OK")

# Generate offers a download only for missing data it can actually fetch.
settings.cache_directory = str(work / "empty-cache")
with patch.object(operators, "_offline", return_value=False):
    assert operators._download_offer(bpy.context) == ["building", "building_part", "elevation"]
    settings.terrain_source = "FLAT"
    assert operators._download_offer(bpy.context) == ["building", "building_part"]
    settings.terrain_source = "DEM"
    settings.overture_python_path = str(work / "no-such-python.exe")
    assert operators._download_offer(bpy.context) == []
    settings.overture_python_path = sys.executable
with patch.object(operators, "_offline", return_value=True):
    assert operators._download_offer(bpy.context) == []
settings.cache_directory = str(work / "cache")
with patch.object(operators, "_offline", return_value=False):
    assert operators._download_offer(bpy.context) == []  # everything is cached
print("DOWNLOAD_OFFER_OK")

# Download waits for generation and LiDAR preparation.
with patch.object(operators, "is_generating", return_value=True):
    assert not operators.JARVIZAR_OT_download_cache.poll(bpy.context)
operators.JARVIZAR_OT_prepare_lidar._running = True
assert not operators.JARVIZAR_OT_download_cache.poll(bpy.context)
operators.JARVIZAR_OT_prepare_lidar._running = False
assert operators.JARVIZAR_OT_download_cache.poll(bpy.context)
print("DOWNLOAD_MODAL_OK")

addon.unregister()
shutil.rmtree(work, ignore_errors=True)
print("JARVIZAR_DOWNLOAD_OPERATOR_OK")
