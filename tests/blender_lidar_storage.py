"""Blender storage preferences and the reviewed manual cleanup flow."""
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import jarvizar_city_model
from jarvizar_city_model import operators
from jarvizar_city_model.external.lidar_storage import GIB

bpy.ops.preferences.addon_enable(module='jarvizar_city_model')
preferences = bpy.context.preferences.addons['jarvizar_city_model'].preferences
assert preferences.lidar_cache_gib == 30
assert preferences.lidar_free_gib == 10

class Driver:
    invoke = operators.JARVIZAR_OT_cache_storage.invoke
    execute = operators.JARVIZAR_OT_cache_storage.execute
    report = Mock()

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    bpy.context.scene.jarvizar_city_model.cache_directory = str(root)
    points = root/'lidar_derived'/('a'*64)/'points'
    points.mkdir(parents=True)
    first, second = (points/(c*64+'.npy') for c in ('b', 'c'))
    first.write_bytes(b'x'*10)
    second.write_bytes(b'x'*10)
    published = root/'bbox_example'/'lidar_buildings.json'
    published.parent.mkdir()
    published.write_bytes(b'published results')
    context = SimpleNamespace(scene=bpy.context.scene,
        window_manager=SimpleNamespace(invoke_props_dialog=Mock(return_value={'RUNNING_MODAL'})))
    with patch.object(operators, 'storage_limits', return_value=(15/GIB, 0)):
        driver = Driver()
        assert driver.invoke(context, None) == {'RUNNING_MODAL'}
        assert first.exists() and second.exists()
        assert driver._preview['reclaim'] == 10
        assert driver.execute(context) == {'FINISHED'}
        assert sum(p.stat().st_size for p in points.glob('*.npy')) == 10
        assert published.read_bytes() == b'published results'
        driver = Driver()
        assert driver.invoke(context, None) == {'RUNNING_MODAL'}
        (points/('d'*64+'.npy')).write_bytes(b'x'*10)
        assert driver.execute(context) == {'CANCELLED'}  # changed cache needs review
        assert sum(p.stat().st_size for p in points.glob('*.npy')) == 20
        assert Driver().execute(context) == {'CANCELLED'}  # cannot bypass preview

print('JARVIZAR_LIDAR_STORAGE_OK')
