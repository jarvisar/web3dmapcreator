"""Detailed measured roofs use the existing closed-solid builder in Blender."""
import copy
from pathlib import Path
import sys

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parent)]
import jarvizar_city_model as addon
from jarvizar_city_model.data.projection import create_fixed_scale_transform
from jarvizar_city_model.external.lidar_records import validate_records
from blender_lidar import build, Ground

addon.register()
assert bpy.context.scene.jarvizar_city_model.lidar_roof_mode == 'FACETED'
transform = create_fixed_scale_transform(-87.64,41.875,-87.63,41.885,.07)
def geographic(x,y,z=None):
    xy = list(transform.local_to_geographic(x,y)[:2])
    return xy if z is None else xy+[z]
outline = [[-20,-20],[20,-20],[20,20],[-20,20],[-20,-20]]
feature = {'id':'curved', 'properties':{'height':45}, 'geometry':{
    'type':'Polygon', 'coordinates':[[geographic(x,y) for x,y in outline]]}}
surfaces=[]
for x in range(-20,20,5):
    def z(x):return 30+15*(1-(x/20)**2)
    corners = [(x,-20,z(x)),(x+5,-20,z(x+5)),(x+5,20,z(x+5)),(x,20,z(x))]
    for ids in ((0,1,2),(0,2,3)):
        ring = [geographic(*corners[i]) for i in (*ids,ids[0])]
        surfaces.append({'bottom_m':30, 'geometry':{'type':'Polygon','coordinates':[ring]}})
record = {'height_m':30, 'tiers':[], 'method':'faceted_roof', 'roof_surfaces':surfaces}
validate_records({'curved':record})
for merge in (False,True):
    collection, counts=build([feature],[],transform,{'curved':record},'FACETS',merge,minimum_height=.8,prefer_lidar=True)
    assert counts['lidar_buildings']==1 and counts['lidar_faceted_roof_buildings']==1,counts
    assert counts['lidar_roof_plane_buildings']==0 and counts['lidar_geometry_fallbacks']==0,counts
    assert len(collection.objects)==1
    obj=collection.objects[0]
    tree=BVHTree.FromObject(obj,bpy.context.evaluated_depsgraph_get())
    local=[transform.forward(*geographic(x,y))[:2] for x,y in outline]
    base=Ground().minimum_over(local)
    for x in (-15,-5,0,5,15):
        px,py=transform.forward(*geographic(x,0))[:2]
        hit=tree.ray_cast(Vector((px,py,100)),Vector((0,0,-1)))[0]
        assert hit and abs(hit.z-(base+(30+15*(1-(x/20)**2))*.077))<1e-4,(x,hit)
broken=copy.deepcopy(record);broken['roof_surfaces'].pop()
_,counts=build([feature],[],transform,{'curved':broken},'INCOMPLETE',prefer_lidar=True)
assert counts['lidar_buildings']==0 and counts['lidar_geometry_fallbacks']==1,counts
print('LIDAR_FACETED_SURFACES_OK')
