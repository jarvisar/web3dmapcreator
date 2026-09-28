"""Run the existing geometry pipeline on a background Blender's main thread."""

import importlib.util
import json
from pathlib import Path
import sys
import time
from types import SimpleNamespace


def run(request_path):
    import bpy

    package = Path(__file__).resolve().parents[1]
    # Load this exact checkout/installed extension, independent of preferences,
    # other installed versions, the current directory, and extension namespaces.
    name = "_jcm_generation_addon"
    spec = importlib.util.spec_from_file_location(name, package / "__init__.py",
                                                submodule_search_locations=[str(package)])
    addon = importlib.util.module_from_spec(spec)
    sys.modules[name] = addon
    spec.loader.exec_module(addon)
    protocol = importlib.import_module(name + ".data.generation_job")
    ownership = importlib.import_module(name + ".external.lidar_worker")
    request_path = Path(request_path)
    directory = request_path.parent
    request = json.loads(request_path.read_text(encoding="utf-8"))
    if request.get("protocol") != protocol.PROTOCOL:
        raise ValueError("Unsupported generation worker protocol")
    ownership.watch_parent(int(request["parent_pid"]))
    addon.register()
    operators = importlib.import_module(name + ".operators")
    collections = importlib.import_module(name + ".blender.collections")
    settings = bpy.context.scene.jarvizar_city_model
    phase_name = "Starting generation"
    last_write = 0.0

    def progress(phase, fraction):
        nonlocal phase_name, last_write
        now = time.monotonic()
        if phase != phase_name or now - last_write >= .1 or fraction == 1:
            try:
                protocol.write_json(directory / "progress.json", {"phase": phase, "fraction": fraction})
            except OSError:
                # Progress is advisory. Result/model publication below remains
                # mandatory and any failure there prevents foreground commit.
                pass
            phase_name, last_write = phase, now

    try:
        for key, value in request["settings"].items():
            setattr(settings, key, value)
        driver = SimpleNamespace(report=lambda *args: None, _generation_progress=progress)
        if operators.JARVIZAR_OT_generate_model.execute_sync(driver, bpy.context) != {"FINISHED"}:
            # The foreground adds its own "Generation failed:" prefix.
            raise ValueError(settings.last_status.removeprefix("Generation failed: "))
        root = collections.generated_roots(bpy.context.scene)[0]
        progress("Writing finished model", 1.0)
        bpy.data.libraries.write(str(directory / "model.blend"), {root}, fake_user=False, compress=False)
        protocol.write_json(directory / "result.json", {"protocol": protocol.PROTOCOL, "ok": True,
            "root": root.name, "message": settings.last_status, "lidar_status": settings.lidar_generation_status})
    except Exception as exc:
        # The phase goes to the worker log; the status shows only the cause.
        print(f"Generation failed during {phase_name}: {exc}", flush=True)
        protocol.write_json(directory / "result.json", {"protocol": protocol.PROTOCOL, "ok": False,
            "error": str(exc)})
        raise
    finally:
        addon.unregister()


if __name__ == "__main__":
    run(sys.argv[sys.argv.index("--") + 1])
