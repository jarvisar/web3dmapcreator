"""Cached LiDAR must not resurrect a source footprint tagged wholly underground."""
import sys
from pathlib import Path
import bpy
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT),str(ROOT/'tests')]
from blender_lidar import collection,check_closed,Ground
from jarvizar_city_model.geometry.building_generation import generate_buildings
from jarvizar_city_model.data.projection import create_fixed_scale_transform

t=create_fixed_scale_transform(-87.64,41.88,-87.63,41.89,.07)
def geometry(x,y,size):
    return {'type':'Polygon','coordinates':[[t.local_to_geographic(a,b)[:2] for a,b in
        ((x,y),(x+size,y),(x+size,y+size),(x,y+size),(x,y))]]}
parent={'id':'station','properties':{'is_underground':True,'has_parts':True},'geometry':geometry(0,0,100)}
underground={'id':'platform','properties':{'building_id':'station','is_underground':True,'height':8},'geometry':geometry(0,0,80)}
entrance={'id':'entrance','properties':{'building_id':'station','is_underground':False,'height':6},'geometry':geometry(10,10,20)}
for merge in (False,True):
    for visible in (False,True):
        for mode in ('none','full','height_only'):
            profiles={'station':{'height_m':30,'tiers':[]}} if mode=='full' else (
                {'station':{'method':'height_only','source_heights':{'station':30}}} if mode=='height_only' else {})
            c=collection('Underground')
            counts=generate_buildings([parent],[underground]+([entrance] if visible else []),t,Ground(),3,10,c,c,
                merge=merge,retain_sparse_parents=True,lidar_profiles=profiles,prefer_lidar=True)
            assert counts['buildings']==0,(merge,visible,mode,counts)
            assert counts['building_parts']==int(visible),(merge,visible,mode,counts)
            assert counts['lidar_buildings']==0,counts
            check_closed(c.objects)
            if visible and not merge:
                assert [o['overture_id'] for o in c.objects]==['entrance']
print('UNDERGROUND_BUILDINGS_OK')
