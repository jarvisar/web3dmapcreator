"""Test-only worker: pause inside an arbitrary phase until the owner stops it."""

import importlib
import importlib.util
from pathlib import Path
import sys
import time


request = Path(sys.argv[sys.argv.index("--") + 1])
phase = (request.parent / "pause-phase.txt").read_text(encoding="utf-8")
helper = Path(__file__).resolve().parents[1] / "jarvizar_city_model/external/generate_model.py"
spec = importlib.util.spec_from_file_location("_generation_worker_fixture", helper)
entry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entry)
original_import = importlib.import_module


def instrument(name, package=None):
    module = original_import(name, package)
    if name == "_jcm_generation_addon.data.generation_job":
        original_write = module.write_json
        def write(path, payload):
            original_write(path, payload)
            if payload.get("phase") == phase:
                # No Blender UI event can run here. The foreground must stay
                # responsive and terminate this isolated process independently.
                time.sleep(120)
        module.write_json = write
    return module


importlib.import_module = instrument
entry.run(request)
