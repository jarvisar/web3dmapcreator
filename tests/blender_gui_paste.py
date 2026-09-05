"""Windowed Blender check that Paste Coordinates reads the real clipboard.

Background Blender has no GHOST window, so ``window_manager.clipboard`` always
reads back empty there and the one-click path cannot be exercised by any of the
``--background`` tests.  This one opens a real window, waits for it to come up,
runs the operator through ``INVOKE_DEFAULT`` with no text -- exactly what the
button does -- and quits.

Put the coordinates on the clipboard first, then run::

    powershell -c "Set-Clipboard -Value '-84.53576,39.08541,-84.48473,39.11475'"
    "C:/Program Files/Blender Foundation/Blender 3.6/blender.exe" \
        --factory-startup --python tests/blender_gui_paste.py

It prints ``JARVIZAR_GUI_PASTE_OK`` on success.  The parsing itself is covered
by the unit tests in ``tests/test_projection.py``; this only covers the wiring
between the button, the clipboard, and the scene fields.
"""

from __future__ import annotations

from pathlib import Path
import sys

import bpy

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import jarvizar_city_model
from jarvizar_city_model.data.projection import parse_bounds_text

CLIPBOARD_HINT = "west,south,east,north on the clipboard, e.g. -84.5,39.0,-84.4,39.1"

jarvizar_city_model.register()


def check() -> None:
    failures = []
    settings = bpy.context.scene.jarvizar_city_model
    settings.west = settings.south = settings.east = settings.north = ""

    clipboard = bpy.context.window_manager.clipboard
    print(f"clipboard: {clipboard!r}")
    try:
        expected = parse_bounds_text(clipboard)
    except ValueError as exc:
        print(f"JARVIZAR_GUI_PASTE_SKIPPED: {exc}. Put {CLIPBOARD_HINT}")
        bpy.ops.wm.quit_blender()
        return

    result = bpy.ops.jarvizar.paste_bounds("INVOKE_DEFAULT")
    if result != {"FINISHED"}:
        failures.append(f"operator returned {result}")

    written = (settings.west, settings.south, settings.east, settings.north)
    print(f"fields: {written}")
    try:
        numbers = tuple(float(value) for value in written)
    except ValueError:
        failures.append(f"fields are not numbers: {written}")
        numbers = ()
    if numbers and numbers != (
        expected.west,
        expected.south,
        expected.east,
        expected.north,
    ):
        failures.append(f"fields {numbers} do not match the clipboard {expected}")
    print(f"status: {settings.last_status}")

    if failures:
        print("JARVIZAR_GUI_PASTE_FAILED: " + "; ".join(failures))
    else:
        print("JARVIZAR_GUI_PASTE_OK")
    bpy.ops.wm.quit_blender()


# The window is not up when a --python script runs, and the clipboard needs it.
bpy.app.timers.register(check, first_interval=1.5)
