"""Windowed event-loop check; use --factory-startup --enable-event-simulate.

The fixture pauses a real worker inside terrain generation. Foreground timer
heartbeats must continue, then real Esc and the Cancel operator must stop it.
Only this disposable test process is closed; no user file/preferences are saved.
"""

import os
from pathlib import Path
import sys
import time
from types import SimpleNamespace
from unittest.mock import patch

import bpy

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
import jarvizar_city_model as addon
from jarvizar_city_model import operators
from jarvizar_city_model.blender import generation_modal as modal
from jarvizar_city_model.data import generation_job
from blender_generation_transaction import scene_snapshot

addon.register()
state = {"round": 0, "started": time.monotonic(), "ticks": 0, "sent": False, "snapshot": None,
         "session": None, "gaps": [], "previous_tick": None, "paused_at": None}
original_popen = generation_job.subprocess.Popen


def launch(command, **kwargs):
    request = Path(command[-1])
    (request.parent / "pause-phase.txt").write_text("Building terrain", encoding="utf-8")
    command = list(command)
    command[command.index("--python") + 1] = str(ROOT / "tests/generation_worker_fixture.py")
    return original_popen(command, **kwargs)


def start_round():
    state.update(ticks=0, sent=False, paused_at=None)
    if state["round"] < 2:
        with patch.object(generation_job.subprocess, "Popen", launch):
            result = bpy.ops.jarvizar.generate_model("INVOKE_DEFAULT")
    else:
        result = bpy.ops.jarvizar.generate_model("INVOKE_DEFAULT")
    assert result == {"RUNNING_MODAL"}, result
    state["session"] = modal.active_session()


def tick():
    try:
        now = time.monotonic()
        assert now - state["started"] < 40, "Windowed generation test timed out"
        if state["previous_tick"] is not None:
            state["gaps"].append(now - state["previous_tick"])
        state["previous_tick"] = now
        if state["snapshot"] is None:
            settings = bpy.context.scene.jarvizar_city_model
            settings.terrain_source = "FLAT"
            settings.cache_directory = str(ROOT / "scratchpad/gui-generation-cache")
            for name in ("generate_buildings", "generate_trees", "generate_roads", "generate_bridges",
                         "generate_water", "generate_land_surfaces", "recess_ponds_and_fountains",
                         "cut_water_from_terrain", "generate_border_rim"):
                setattr(settings, name, False)
            driver = SimpleNamespace(report=lambda *args: None)
            assert operators.JARVIZAR_OT_generate_model.execute_sync(driver, bpy.context) == {"FINISHED"}
            bpy.context.view_layer.update()
            state["snapshot"] = scene_snapshot()
            start_round()
            return .05
        session = state["session"]
        if session.done:
            assert not session.error, session.message
            assert not session.job.directory.exists()
            if state["round"] < 2:
                assert session.cancel_requested and state["sent"]
                assert scene_snapshot() == state["snapshot"], "Cancellation changed the foreground scene"
                print("GUI_CANCEL_OK", "ESC" if state["round"] == 0 else "BUTTON", "heartbeats", state["ticks"], flush=True)
                state["round"] += 1
                start_round()
                return .05
            assert session.transaction.committed
            print("JARVIZAR_GENERATION_GUI_OK", "max_heartbeat_gap_seconds", round(max(state["gaps"]), 4), flush=True)
            bpy.ops.wm.quit_blender()
            return None
        assert not session.error, session.message
        if state["round"] < 2 and session.phase == "Building terrain" and not state["sent"]:
            assert session.job.process.poll() is None
            state["ticks"] += 1
            if state["ticks"] >= 8:
                if state["round"] == 0:
                    bpy.context.window.event_simulate(type="ESC", value="PRESS")
                    bpy.context.window.event_simulate(type="ESC", value="RELEASE")
                else:
                    assert bpy.ops.jarvizar.cancel_generation() == {"FINISHED"}
                state["sent"] = True
        return .05
    except Exception:
        import traceback
        traceback.print_exc()
        modal.shutdown_generation()
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(1)


bpy.app.timers.register(tick, first_interval=.5)
