"""Windowed download lifecycle; use --factory-startup --enable-event-simulate.

A fake helper blocks until it is stopped. Foreground timer heartbeats must
continue while it runs, undo must not disturb it, and real Esc, the Cancel
button and a file load must each stop the whole helper tree and leave the
cache unchanged. Then a download succeeds, Generate with missing data offers
a download instead of starting, and the confirmed offer downloads and then
generates in the real worker. Only this disposable test process is closed;
no user file or preferences are saved.
"""

import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
from unittest.mock import patch

import bpy

bpy.context.preferences.view.show_splash = False
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
import jarvizar_city_model as addon
from jarvizar_city_model import operators
from jarvizar_city_model.blender import download_modal, generation_modal
from jarvizar_city_model.blender.collections import generated_roots
from jarvizar_city_model.data import download_job
from test_download_job import alive

addon.register()
work = Path(tempfile.mkdtemp(prefix="jcm_download_gui_"))
control = work / "control"
control.mkdir()
scenario_path = work / "scenario.json"
os.environ["JCM_FAKE_DOWNLOAD"] = str(scenario_path)
patch.object(download_job, "_external_script",
             lambda name: ROOT / "tests" / "download_helper_fixture.py").start()
blend = work / "other.blend"
ROUNDS = ("ESC", "BUTTON", "LOAD", "SUCCESS")
state = {"round": 0, "step": "setup", "started": time.monotonic(), "ticks": 0, "gaps": [],
         "previous": None, "pids": []}


def scenario(**modes):
    for path in control.iterdir():
        path.unlink()
    scenario_path.write_text(json.dumps({**modes, "control": str(control)}), encoding="utf-8")


def configure(settings):
    settings.cache_directory = str(work / "cache")
    settings.overture_python_path = sys.executable
    for name in ("generate_roads", "generate_bridges", "generate_water", "generate_land_surfaces",
                 "generate_trees", "cut_water_from_terrain", "recess_ponds_and_fountains"):
        setattr(settings, name, False)


def cache_state():
    cache = work / "cache"
    return sorted(str(path.relative_to(cache)) for path in cache.rglob("*")
                  if "logs" not in path.parts) if cache.exists() else []


def start_round():
    name = ROUNDS[state["round"]]
    scenario(**({"overture": "success", "dem": "success"} if name == "SUCCESS" else {"overture": "hang"}))
    state.update(step="running", ticks=0, sent=False, undone=False)
    settings = bpy.context.scene.jarvizar_city_model
    assert settings.cache_directory == str(work / "cache"), settings.cache_directory
    assert operators.JARVIZAR_OT_download_cache.poll(bpy.context)
    result = bpy.ops.jarvizar.download_cache("INVOKE_DEFAULT")
    assert result == {"RUNNING_MODAL"}, result
    assert download_modal.is_downloading()


def helpers_stopped():
    pids = json.loads((control / "overture-pids.json").read_text(encoding="utf-8"))
    grandchild = int((control / "overture-grandchild.pid").read_text(encoding="utf-8"))
    state["pids"] = [pids["helper"], pids["launcher"], grandchild]
    return not any(alive(pid) for pid in state["pids"])


def tick():
    try:
        now = time.monotonic()
        assert now - state["started"] < 90, f"Windowed download test timed out at {state}"
        if state["previous"] is not None and state["step"] == "running":
            state["gaps"].append(now - state["previous"])
        state["previous"] = now
        settings = bpy.context.scene.jarvizar_city_model
        name = ROUNDS[state["round"]] if state["round"] < len(ROUNDS) else ""
        if state["step"] == "setup":
            configure(settings)
            # Undo during the first round returns here, not to factory settings.
            bpy.ops.ed.undo_push(message="configured")
            bpy.ops.wm.save_as_mainfile(filepath=str(blend), copy=True)
            state["cache"] = cache_state()
            start_round()
            return 0.05
        if state["step"] == "running":
            session = download_modal.active_download()
            if name == "SUCCESS":
                if session is None:
                    assert settings.last_status.startswith("Cached release 2026-01-01.0: 1 building"), \
                        settings.last_status
                    print("GUI_DOWNLOAD_OK SUCCESS", flush=True)
                    state["step"] = "offer"
                return 0.05
            if not state["sent"]:
                assert session is not None and not session.done, settings.last_status
                if not (control / "overture-pids.json").exists():
                    return 0.05
                state["ticks"] += 1
                if name == "ESC" and not state["undone"]:
                    # Undo replaces every ID; the download must carry on.
                    bpy.context.scene.frame_current += 1
                    bpy.ops.ed.undo_push(message="edit while downloading")
                    bpy.ops.ed.undo()
                    state["undone"] = True
                    return 0.05
                if state["ticks"] < 8:
                    return 0.05
                assert session.status()["message"] == "Downloading building (1/2)", session.status()
                if name == "ESC":
                    bpy.context.window.event_simulate(type="ESC", value="PRESS")
                    bpy.context.window.event_simulate(type="ESC", value="RELEASE")
                elif name == "BUTTON":
                    assert bpy.ops.jarvizar.cancel_download() == {"FINISHED"}
                else:
                    bpy.ops.wm.open_mainfile(filepath=str(blend))
                state["sent"] = True
                return 0.05
            if session is not None:
                return 0.05
            deadline = time.monotonic() + 10
            while not helpers_stopped():
                assert time.monotonic() < deadline, f"Helpers still running after {name}"
                time.sleep(0.05)
            assert not list((work / "cache").glob("jarvizar_download_*")), "temporary folder left"
            assert cache_state() == state["cache"], "cancelled download changed the cache"
            if name != "LOAD":
                assert settings.last_status == "Download cancelled; cache unchanged", settings.last_status
            else:
                configure(bpy.context.scene.jarvizar_city_model)
            assert operators.JARVIZAR_OT_download_cache.poll(bpy.context)
            assert operators.JARVIZAR_OT_generate_model.poll(bpy.context)
            print("GUI_DOWNLOAD_OK", name, "heartbeats", state["ticks"], flush=True)
            state["round"] += 1
            start_round()
            return 0.05
        if state["step"] == "offer":
            # Missing data: Generate shows the offer instead of failing or starting.
            settings.cache_directory = str(work / "offer-cache")
            assert operators._download_offer(bpy.context) == ["building", "building_part", "elevation"]
            assert bpy.ops.jarvizar.generate_model("INVOKE_DEFAULT") == {"CANCELLED"}
            assert not generation_modal.is_generating() and not download_modal.is_downloading()
            bpy.context.window.event_simulate(type="ESC", value="PRESS")
            bpy.context.window.event_simulate(type="ESC", value="RELEASE")
            state["step"] = "offer_accept"
            return 0.3
        if state["step"] == "offer_accept":
            assert not generation_modal.is_generating() and not download_modal.is_downloading()
            scenario(overture="success", dem="success")
            assert bpy.ops.jarvizar.download_then_generate("EXEC_DEFAULT") == {"FINISHED"}
            assert download_modal.is_downloading()
            state.update(step="offer_download", generation_seen=False)
            return 0.05
        if state["step"] == "offer_download":
            if download_modal.is_downloading():
                return 0.05
            if generation_modal.is_generating():
                state["generation_seen"] = True
                return 0.1
            if not state["generation_seen"]:
                assert settings.last_status.startswith("Cached release"), settings.last_status
                return 0.05
            assert " mm at 1:" in settings.last_status, settings.last_status
            assert generated_roots(bpy.context.scene), "No model after download and generate"
            print("GUI_DOWNLOAD_OK OFFER", settings.last_status, flush=True)
            state["step"] = "done"
            return 0.05
        print("JARVIZAR_DOWNLOAD_GUI_OK", "max_heartbeat_gap_seconds",
              round(max(state["gaps"] or [0.0]), 4), flush=True)
        addon.unregister()
        shutil.rmtree(work, ignore_errors=True)
        bpy.ops.wm.quit_blender()
        return None
    except Exception:
        import traceback
        traceback.print_exc()
        session = download_modal.active_download()
        if session is not None:
            session.job.abort(10)
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(1)


bpy.app.timers.register(tick, first_interval=0.5, persistent=True)
