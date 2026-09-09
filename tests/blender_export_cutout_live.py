"""Generate a cached city, crop, audit every exported mesh, and record timings.

blender --background --factory-startup --python-exit-code 1 --python
tests/blender_export_cutout_live.py -- --cache <cache-root> [--bbox w,s,e,n]
[--blend <existing generated blend>] [--export]
"""
import argparse
import json
import math
from pathlib import Path
import sys
import time

import bpy
import bmesh
from mathutils import Vector

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import jarvizar_city_model as addon
from jarvizar_city_model.blender.collections import generated_objects
from jarvizar_city_model.blender.export_cutout import export_geometry
from jarvizar_city_model.blender.mesh_utils import _prism_geometry

parser=argparse.ArgumentParser()
parser.add_argument('--cache')
parser.add_argument('--bbox',default='-84.53370,39.08554,-84.47422,39.11094')
parser.add_argument('--blend')
parser.add_argument('--export',action='store_true')
parser.add_argument('--save-generated')
parser.add_argument('--rotation',type=float,help='Override frame rotation in degrees')
parser.add_argument('--preview',type=Path)
args=parser.parse_args(sys.argv[sys.argv.index('--')+1:])
if args.blend:
    bpy.ops.wm.open_mainfile(filepath=str(Path(args.blend).resolve()))
addon.register()
if not args.blend:
    s=bpy.context.scene.jarvizar_city_model
    s.cache_directory=args.cache
    s.west,s.south,s.east,s.north=args.bbox.split(',')
    s.terrain_source='DEM';s.terrain_resolution=192
    assert bpy.ops.jarvizar.generate_model()=={'FINISHED'},s.last_status
    if args.save_generated:
        bpy.ops.wm.save_as_mainfile(filepath=str(Path(args.save_generated).resolve()))
cutout=bpy.context.scene.objects.get('cutout')
if cutout is None:
    vertices,faces=_prism_geometry([
        [(x,y,-2,2) for x,y in [(-100,-80),(100,-80),(100,80),(-100,80)]],
        [(x,y,-2,2) for x,y in [(-85.25,-59.75),(-85.25,59.75),(85.25,59.75),(85.25,-59.75)]]])
    mesh=bpy.data.meshes.new('cutout');mesh.from_pydata(vertices,[],faces)
    cutout=bpy.data.objects.new('cutout',mesh);bpy.context.scene.collection.objects.link(cutout)
if args.rotation is not None:
    cutout.rotation_euler.z=math.radians(args.rotation)
bpy.context.view_layer.update()
sources=generated_objects(bpy.context.scene)
before=[(o.data.as_pointer(),len(o.data.vertices),len(o.data.polygons),o.matrix_world.copy()) for o in sources]
start=time.perf_counter()
with export_geometry(bpy.context,sources) as (parts,stats,opening):
    elapsed=time.perf_counter()-start
    print('LIVE_CROP_PREPARED',elapsed,dict(stats),flush=True)
    counts=[]
    for part in parts:
        bm=bmesh.new();bm.from_mesh(part.data)
        bad=sum(not e.is_manifold or not e.is_contiguous for e in bm.edges)
        assert bad==0,(part.name,bad)
        outside=sum(not opening.contains(opening.inverse @ part.matrix_world @ v.co) for v in bm.verts)
        assert outside==0,(part.name,outside)
        counts.append((part.name,len(bm.verts),len(bm.faces)))
        bm.free()
    print('LIVE_CROP_AUDIT',json.dumps(counts),flush=True)
    if args.preview:
        scene=bpy.context.scene
        for obj in scene.objects:
            obj.hide_render=obj not in parts
        scene.render.engine='BLENDER_EEVEE'
        scene.eevee.use_gtao=True;scene.eevee.gtao_distance=3;scene.eevee.gtao_factor=1.2
        scene.eevee.taa_render_samples=64
        scene.world.color=(0.5,0.5,0.5)
        camera=bpy.data.objects.new('preview camera',bpy.data.cameras.new('preview camera'))
        scene.collection.objects.link(camera);scene.camera=camera
        camera.location=(90,-160,200)
        camera.rotation_euler=(Vector((0,0,0))-camera.location).to_track_quat('-Z','Y').to_euler()
        camera.data.type='ORTHO';camera.data.ortho_scale=235;camera.data.clip_end=1000
        sun=bpy.data.objects.new('preview sun',bpy.data.lights.new('preview sun','SUN'))
        scene.collection.objects.link(sun);sun.rotation_euler=(0.3,-0.5,-0.4);sun.data.energy=3
        scene.render.resolution_x=1200;scene.render.resolution_y=900;scene.render.resolution_percentage=100
        scene.render.image_settings.file_format='PNG';scene.render.filepath=str(args.preview.resolve())
        bpy.ops.render.render(write_still=True)
assert before==[(o.data.as_pointer(),len(o.data.vertices),len(o.data.polygons),o.matrix_world.copy()) for o in sources]
if args.export:
    bpy.ops.preferences.addon_enable(module='io_mesh_3mf')
    output=Path(__file__).resolve().parents[1]/'scratchpad'/'export-cutout'/'live.3mf'
    output.parent.mkdir(parents=True,exist_ok=True)
    start=time.perf_counter()
    assert bpy.ops.jarvizar.export_3mf(filepath=str(output))=={'FINISHED'}
    print('LIVE_EXPORT_SECONDS',time.perf_counter()-start,flush=True)
print('LIVE_EXPORT_CUTOUT_OK',len(parts),sum(c[2] for c in counts),elapsed,flush=True)
