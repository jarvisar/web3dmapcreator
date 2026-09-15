"""Compare complete cached map fingerprints with LiDAR off/on and export.

--bundle <bbox-dir> --output <json> [--addon-root <package-parent>] [--lidar]
--export <3mf> optionally exercises the Bambu project exporter.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys

import bpy
import bmesh

parser=argparse.ArgumentParser()
parser.add_argument('--bundle',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
parser.add_argument('--addon-root',type=Path,default=Path(__file__).resolve().parents[1])
parser.add_argument('--lidar',action='store_true')
parser.add_argument('--export',type=Path)
args=parser.parse_args(sys.argv[sys.argv.index('--')+1:])
sys.path.insert(0,str(args.addon_root.resolve()))
import jarvizar_city_model as addon
addon.register()
s=bpy.context.scene.jarvizar_city_model
data=json.loads((args.bundle/'lidar_buildings.json').read_text(encoding='utf-8'))
for key,value in zip(('west','south','east','north'),data['request']['bbox']):setattr(s,key,str(value))
s.cache_directory=str(args.bundle.resolve().parent)
s.terrain_source='DEM';s.terrain_resolution=192
s.use_lidar_buildings=args.lidar
s.lidar_minimum_width_mm=data['request']['min_width_mm']
s.lidar_minimum_step_mm=data['request']['min_step_mm']
s.lidar_prefer_measured=data['request'].get('prefer_lidar', True)
s.lidar_source_url=data['request']['source_url']
s.lidar_manifest_url=data['request'].get('manifest_url', '')
s.generate_roof_shapes=data['request'].get('roof_planes', True)
if hasattr(s, 'lidar_roof_mode'):
    s.lidar_roof_mode=data['request'].get('roof_mode', 'TERRACES')
assert bpy.ops.jarvizar.generate_model()=={'FINISHED'}
root=bpy.data.collections['CITY_MODEL']
counts=json.loads(root['generation_counts_json'])
meshes={}
for obj in root.all_objects:
    if obj.type!='MESH':continue
    mesh=bmesh.new();mesh.from_mesh(obj.data)
    bad=sum(not e.is_manifold or not e.is_contiguous for e in mesh.edges)
    assert bad==0,(obj.name,bad)
    mesh.free()
    digest=hashlib.sha256()
    for vertex in obj.data.vertices:digest.update(struct.pack('<3d',*vertex.co))
    for face in obj.data.polygons:
        digest.update(struct.pack('<I',len(face.vertices)))
        digest.update(struct.pack('<'+'I'*len(face.vertices),*face.vertices))
        digest.update(struct.pack('<I',face.material_index))
    meshes[obj.name]={'sha256':digest.hexdigest(),'vertices':len(obj.data.vertices),'faces':len(obj.data.polygons)}
if args.lidar:
    assert counts['lidar_buildings']>0,counts
    assert 'Used LiDAR' in s.lidar_generation_status,s.lidar_generation_status
if args.export:
    assert bpy.ops.jarvizar.export_3mf(filepath=str(args.export.resolve()))=={'FINISHED'}
args.output.write_text(json.dumps({'addon':addon.__file__,'counts':counts,'meshes':meshes},indent=2),encoding='utf-8')
print('LIDAR_FULL_REGRESSION_OK',len(meshes),'meshes',sum(v['faces'] for v in meshes.values()),'faces')
