"""Reordering uses all five categories and persists in the saved scene."""
import sys
import tempfile
from pathlib import Path

import bpy

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
import jarvizar_city_model
from jarvizar_city_model.data.land import DEFAULT_SURFACE_PRIORITY

if not hasattr(bpy.types.Scene, 'jarvizar_city_model'):
    jarvizar_city_model.register()
settings = bpy.context.scene.jarvizar_city_model
settings.surface_priority_order = ','.join(DEFAULT_SURFACE_PRIORITY)
assert settings.surface_order() == DEFAULT_SURFACE_PRIORITY
assert bpy.ops.jarvizar.move_surface_priority(index=4, direction=-1) == {'FINISHED'}
expected = ('paved', 'sand', 'rock', 'forest', 'green')
assert settings.surface_order() == expected
assert bpy.ops.jarvizar.move_surface_priority(index=0, direction=-1) == {'CANCELLED'}
assert settings.surface_order() == expected
with tempfile.TemporaryDirectory(prefix='jcm_surface_settings_') as directory:
    path = Path(directory)/'settings.blend'
    bpy.ops.wm.save_as_mainfile(filepath=str(path), compress=True)
    settings.surface_priority_order = ','.join(DEFAULT_SURFACE_PRIORITY)
    bpy.ops.wm.open_mainfile(filepath=str(path))
    assert bpy.context.scene.jarvizar_city_model.surface_order() == expected
print('JARVIZAR_SURFACE_PRIORITY_SETTINGS_OK: reorder and scene persistence')
