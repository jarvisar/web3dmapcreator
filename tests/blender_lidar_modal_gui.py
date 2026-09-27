"""Windowed LiDAR modal lifecycle: progress survives undo, and a file load
stops the worker and frees Prepare instead of leaving it greyed out."""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from unittest.mock import patch
import bpy
bpy.context.preferences.view.show_splash=False

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import jarvizar_city_model as addon
from jarvizar_city_model import operators
from jarvizar_city_model.data import lidar
from jarvizar_city_model.data.cache import CacheBundle,Bounds
addon.register()
work=Path(tempfile.mkdtemp(prefix='jcm_lidar_modal_'))
bundle=CacheBundle(work/'cache',Bounds(-74,40,-73.9,40.1));bundle.ensure_directory()
for name in ('building','building_part'):bundle.data_path(name).write_text('{"features":[]}')
blend=work/'other.blend'
bpy.ops.wm.save_as_mainfile(filepath=str(blend),copy=True)
original=lidar.subprocess.Popen
workers=[]
def launch(command,**kwargs):
    command=list(command)
    if len(command)>1 and str(command[1]).endswith('download_lidar.py'):
        command[1]=str(ROOT/'tests/lidar_progress_worker_fixture.py')
    process=original(command,**kwargs)
    workers.append(process)
    return process
for item in (patch.object(operators,'_cache_bundle',return_value=bundle),
             patch.object(operators,'_resolve_downloader',return_value=ROOT/'.venv-overture/Scripts/python.exe'),
             patch.object(operators,'reusable_prepared',return_value=None),
             patch.object(lidar.subprocess,'Popen',launch)):
    item.start()
Prepare=operators.JARVIZAR_OT_prepare_lidar
state={'started':time.monotonic(),'step':'dismiss','progress':[]}

def tick():
    try:
        assert time.monotonic()-state['started']<40,f"GUI test timeout at step {state['step']}"
        settings=bpy.context.scene.jarvizar_city_model
        step=state['step']
        if step=='dismiss':
            bpy.context.window.event_simulate(type='ESC',value='PRESS')
            state['step']='launch'
        elif step=='launch':
            bpy.ops.ed.undo_push(message='before LiDAR')
            assert bpy.ops.jarvizar.prepare_lidar()=={'RUNNING_MODAL'}
            assert Prepare._running and settings.lidar_preparing
            state['step']='undo'
        elif step=='undo':
            if settings.lidar_progress>=.1:
                bpy.context.scene.frame_current+=1
                bpy.ops.ed.undo_push(message='edit while preparing')
                bpy.ops.ed.undo()
                state['undone']=settings.lidar_progress
                state['step']='after_undo'
        elif step=='after_undo':
            # Undo replaced the scene the operator started in; its progress
            # must keep reaching the live scene rather than a removed one.
            state['progress'].append(float(settings.lidar_progress))
            if settings.lidar_progress>=state['undone']+.2:
                assert Prepare._running and settings.lidar_preparing
                state['step']='load'
        elif step=='load':
            bpy.ops.wm.open_mainfile(filepath=str(blend))
            state['step']='loaded'
        elif step=='loaded':
            assert not Prepare._running,'Prepare stayed running after a file load'
            assert workers and workers[-1].poll() is not None,'LiDAR worker left running after a file load'
            assert not bpy.context.scene.jarvizar_city_model.lidar_preparing
            assert Prepare.poll(bpy.context) and operators.JARVIZAR_OT_generate_model.poll(bpy.context)
            (work/'result.json').write_text(json.dumps(state,indent=2))
            print('LIDAR_MODAL_UNDO_OK',flush=True)
            print('LIDAR_MODAL_FILE_LOAD_OK',flush=True)
            bpy.ops.wm.quit_blender()
            return None
        return .15
    except Exception:
        import traceback
        traceback.print_exc()
        for process in workers:
            if process.poll() is None:process.kill()
        sys.stdout.flush();sys.stderr.flush()
        os._exit(1)
bpy.app.timers.register(tick,first_interval=1,persistent=True)
