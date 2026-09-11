"""Windowed disposable progress UI and real-worker Cancel-button check."""
import json
from pathlib import Path
import sys
import time
from unittest.mock import patch
import bpy
bpy.context.preferences.view.show_splash=False

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import jarvizar_city_model as addon
from jarvizar_city_model import operators, ui
from jarvizar_city_model.data import lidar
from jarvizar_city_model.data.cache import CacheBundle,Bounds
addon.register()
OUT=ROOT/'scratchpad/lidar-workflow'
OUT.mkdir(parents=True,exist_ok=True)
bundle=CacheBundle(OUT/'gui-cache',Bounds(-74,40,-73.9,40.1));bundle.ensure_directory()
for name in ('building','building_part'):bundle.data_path(name).write_text('{"features":[]}')

# Draw the production progress widget on the initially active Tool tab so the
# screenshot is independent of persisted sidebar category state.
class ProgressPreview(bpy.types.Panel):
    bl_idname='JARVIZAR_PT_test_lidar_progress'
    bl_label='LiDAR progress verification'
    bl_space_type='VIEW_3D'
    bl_region_type='UI'
    bl_category='Tool'
    def draw(self,context):
        ui._lidar_progress(self.layout,context.scene.jarvizar_city_model,context.region.width)
        state['widget_drawn']=True
bpy.utils.register_class(ProgressPreview)
original=lidar.subprocess.Popen
def launch(command,**kwargs):
    command=list(command)
    if len(command)>1 and str(command[1]).endswith('download_lidar.py'):
        command[1]=str(ROOT/'tests/lidar_progress_worker_fixture.py')
    return original(command,**kwargs)
patches=[patch.object(operators,'_cache_bundle',return_value=bundle),
         patch.object(operators,'_resolve_downloader',return_value=ROOT/'.venv-overture/Scripts/python.exe'),
         patch.object(operators,'reusable_prepared',return_value=None),
         patch.object(lidar.subprocess,'Popen',launch)]
for item in patches:item.start()
state={'started':time.monotonic(),'launched':False,'ticks':0,'cancelled':False,'progress':[], 'dismissed':False,'widget_drawn':False}

def tick():
    try:
        assert time.monotonic()-state['started']<35,'GUI test timeout'
        state['ticks']+=1
        settings=bpy.context.scene.jarvizar_city_model
        area=next(a for a in bpy.context.screen.areas if a.type=='VIEW_3D')
        area.spaces.active.show_region_ui=True
        if not state['dismissed']:
            bpy.context.window.event_simulate(type='ESC',value='PRESS')
            state['dismissed']=True
            return .3
        if not state['launched']:
            for obj in list(bpy.data.objects):bpy.data.objects.remove(obj,do_unlink=True)
            assert bpy.ops.jarvizar.prepare_lidar()=={'RUNNING_MODAL'}
            state['launched']=True
        elif not state['cancelled']:
            state['progress'].append(float(settings.lidar_progress))
            if settings.lidar_progress>=.3:
                assert state['widget_drawn'],'Progress widget was not drawn'
                assert settings.lidar_progress_known
                assert settings.lidar_elapsed_seconds>=2
                assert '3 building checks' in settings.lidar_progress_reuse
                bpy.ops.screen.screenshot(filepath=str(OUT/'progress-ui.png'))
                assert bpy.ops.jarvizar.cancel_lidar()=={'FINISHED'}
                state['cancelled']=True
        elif not settings.lidar_preparing:
            assert not operators.JARVIZAR_OT_prepare_lidar._running
            assert 'Cancelled' in settings.lidar_preparation_status
            assert state['ticks']>10 and max(state['progress'])>min(state['progress'])
            (OUT/'gui-result.json').write_text(json.dumps(state,indent=2))
            print('LIDAR_PROGRESS_GUI_OK',flush=True)
            bpy.ops.wm.quit_blender()
            return None
        return .15
    except Exception:
        import traceback
        traceback.print_exc()
        sys.stdout.flush();sys.stderr.flush()
        import os
        os._exit(1)
bpy.app.timers.register(tick,first_interval=1)
