"""Restoring a parent must preserve its source parts, including enclosed roofs."""
import sys
from pathlib import Path
import bpy
ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT),str(ROOT/'tests')]
from blender_lidar import collection,check_closed,Ground
from jarvizar_city_model.geometry.building_generation import generate_buildings
from jarvizar_city_model.data.projection import create_fixed_scale_transform

t=create_fixed_scale_transform(-87.64,41.88,-87.63,41.89,.07)
def shape(points):
    return {'type':'Polygon','coordinates':[[t.local_to_geographic(x*10,y*10)[:2] for x,y in points]]}
parent={'id':'body','properties':{'has_parts':True},'geometry':shape([(0,0),(10,0),(10,10),(0,10),(0,0)])}
part={'id':'dome','properties':{'building_id':'body','height':6,'roof_shape':'dome','roof_height':3},
      'geometry':shape([(1,1),(3,1),(3,3),(1,3),(1,1)])}
def fingerprint(obj):
    return (tuple(tuple(v.co) for v in obj.data.vertices),tuple(tuple(p.vertices) for p in obj.data.polygons))
for merge in (False,True):
    built=[]
    for enabled in (False,True):
        c=collection('Restoration')
        counts=generate_buildings([parent],[part],t,Ground(),3,14,c,c,merge=merge,
            height_scale=1.1,minimum_height_mm=.8,minimum_height_footprint_mm=.6,
            retain_sparse_parents=enabled)
        assert counts['buildings']==int(enabled),counts
        assert counts['building_parts']==1,counts
        check_closed(c.objects)
        built.append(list(c.objects))
    if not merge:
        old=built[0][0];new=next(o for o in built[1] if o['overture_id']=='dome')
        assert fingerprint(old)==fingerprint(new)
        assert new['roof_shape']=='dome'
        main=next(o for o in built[1] if o['overture_id']=='body')
        assert main['height_m']==14,'Configured fallback must be honored'
        assert max(v.co.z for v in main.data.vertices)>max(v.co.z for v in new.data.vertices)
    else:
        # Independent merged shells retain every original face, even when enclosed.
        def faces(objects):
            from collections import Counter
            return Counter(tuple(sorted(tuple(o.data.vertices[i].co) for i in p.vertices))
                for o in objects for p in o.data.polygons)
        assert not (faces(built[0])-faces(built[1]))
print('MAIN_BODY_RESTORATION_OK')
