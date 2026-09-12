"""Anchored relief has the correct height, holes and transactional fallback."""
import copy
from pathlib import Path
import sys
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT),str(ROOT/'tests')]
import jarvizar_city_model as addon
from jarvizar_city_model.data.projection import create_fixed_scale_transform
from jarvizar_city_model.external.lidar_records import envelope_mesh,validate_records
from jarvizar_city_model.geometry.lidar_rock import generate_rock_surfaces
from jarvizar_city_model.geometry.lidar_buildings import surface_height
from blender_lidar import Ground,build,collection,check_closed
from blender_lidar_surfaces import audit_shells

addon.register()
class Identity:
    def forward(self,x,y):return x,y
tiny=[[40.,30.,8.],[40.00005,30.,8.001],[40.,30.00008,8.002]]
height=surface_height({'geometry':{'type':'Polygon','coordinates':[tiny+[tiny[0]]]}},Identity())
assert all(abs(height(x,y)-z)<1e-8 for x,y,z in tiny)
try:
    surface_height({'geometry':{'type':'Polygon','coordinates':[[[0,0,1],[1,1,2],[2,2,3],[0,0,1]]]}},Identity())
except ValueError:pass
else:raise AssertionError('Collinear roof accepted')
transform=create_fixed_scale_transform(-.001,-.001,.001,.001,.07)
def geo(x,y,z=None):
    xy=list(transform.local_to_geographic(x,y)[:2])
    return xy if z is None else xy+[z]
outer=[(-20,-20),(20,-20),(20,20),(-20,20),(-20,-20)]
geometry={'type':'Polygon','coordinates':[[geo(x,y) for x,y in outer]]}
rings=[]
for x in range(-20,20,10):
    for y in range(-20,20,10):
        corners=[(x,y),(x+10,y),(x+10,y+10),(x,y+10)]
        for ids in ((0,1,2),(0,2,3)):
            ring=[geo(*corners[i],20+.1*corners[i][0]) for i in ids]
            rings.append(ring+[ring[0]])
anchor=geo(-30,-30)+[2.]
base={'height_m':18.,'tiers':[],'method':'faceted_roof','surface_reconstruction':'roof_envelope',
      'roof_mesh':envelope_mesh(rings),'ground_anchor':anchor,'coverage':1.}
feature={'id':'hill','geometry':geometry,'properties':{'height':50}}
validate_records({'hill':base})
for merge in (False,True):
    coll,counts=build([feature],[],transform,{'hill':base},'ANCHORED',merge,prefer_lidar=True)
    assert counts['lidar_buildings']==1 and counts['lidar_geometry_fallbacks']==0,counts
    obj=coll.objects[0];assert audit_shells(obj)==2
    ax,ay=transform.forward(*anchor[:2])[:2]
    expected_base=Ground().height_mm(ax,ay)-2*.077
    assert abs(max(v.co.z for v in obj.data.vertices)-(expected_base+22*.077))<1e-4
rock=dict(base,surface_kind='rock',surface_geometry=geometry,covered_buildings=['hill'])
validate_records({'rock:hill':rock})
coll=collection('ROCK')
counts,covered=generate_rock_surfaces({'rock:hill':rock},transform,Ground(),coll,None)
assert counts['lidar_rock_surfaces']==1 and covered=={'hill'},(counts,covered)
check_closed(coll.objects);assert audit_shells(coll.objects[0])==2
broken=copy.deepcopy(rock);broken['roof_mesh']['faces'].pop()
fallback=collection('ROCK_FALLBACK')
counts,covered=generate_rock_surfaces({'rock:hill':broken},transform,Ground(),fallback,None)
assert counts['lidar_rock_geometry_fallbacks']==1 and not covered and not fallback.objects
assert not hasattr(bpy.context.scene.jarvizar_city_model,'lidar_comparison_url')
assert hasattr(bpy.context.scene.jarvizar_city_model,'lidar_rock_surfaces')
assert not hasattr(bpy.types,'JARVIZAR_OT_select_lidar_survey')
print('LIDAR_RELIEF_ALIGNMENT_OK')
