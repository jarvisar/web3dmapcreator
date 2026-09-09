"""UI preference, source-detail override and transactional geometry fallback."""
import copy
from pathlib import Path
import sys

import bpy
sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parent)]
import jarvizar_city_model as addon
from blender_lidar import build
from jarvizar_city_model.data.projection import create_fixed_scale_transform

addon.register()
settings = bpy.context.scene.jarvizar_city_model
assert settings.lidar_prefer_measured is True
settings.lidar_minimum_width_mm = .01
assert abs(settings.lidar_minimum_width_mm-.01) < 1e-6
assert abs(settings.lidar_minimum_step_mm-.05) < 1e-6
transform = create_fixed_scale_transform(-87.64,41.875,-87.63,41.885,.07)
def geometry(size):
    return {'type':'Polygon','coordinates':[[transform.local_to_geographic(x,y)[:2]
        for x,y in ((-size,-size),(size,-size),(size,size),(-size,size),(-size,-size))]]}
parent = {'id':'parent', 'properties':{'height':90, 'has_parts':True}, 'geometry':geometry(30)}
crown = {'id':'crown', 'properties':{'building_id':'parent', 'height':90, 'roof_shape':'pyramidal', 'roof_height':20},
         'geometry':geometry(30)}
record = {'height_m':30, 'tiers':[{'bottom_m':30, 'top_m':75, 'geometry':geometry(15)}]}
for merge in (False, True):
    _, counts = build([parent],[crown],transform,{'parent':record},'Conservative',merge=merge)
    assert counts['lidar_source_detail_preserved']==1 and counts['building_parts']==1, counts
    _, counts = build([parent],[crown],transform,{'parent':record},'Preferred',merge=merge,prefer_lidar=True)
    assert counts['lidar_buildings']==1 and counts['building_parts']==0, counts
    assert counts['lidar_source_detail_preserved']==0, counts
    broken = copy.deepcopy(record)
    broken['tiers'][0]['geometry'] = {'type':'Point','coordinates':[0,0]}
    _, counts = build([parent],[crown],transform,{'parent':broken},'Broken',merge=merge,prefer_lidar=True)
    assert counts['lidar_geometry_fallbacks']==1 and counts['building_parts']==1, counts
print('LIDAR_PREFERENCE_OK')

# A retained source parent must not swallow a preferred measured infill.
parent['properties']['height'] = 50
crown['properties'] = {'building_id':'parent', 'height':80}
crown['geometry'] = geometry(10)
infill = geometry(30)
infill['coordinates'].append(list(reversed(geometry(10)['coordinates'][0])))
supplement = {'height_m':30, 'tiers':[], 'method':'source_parts',
              'infill_geometry':infill, 'part_heights':{'crown':70}}
_, counts = build([parent],[crown],transform,{'parent':supplement},'RetainedParent')
assert counts['buildings']==1 and counts['lidar_buildings']==0, counts
coll, counts = build([parent],[crown],transform,{'parent':supplement},'PreferredInfill',prefer_lidar=True)
assert counts['buildings']==1 and counts['lidar_infill_buildings']==1, counts
assert counts['building_parts']==1 and len(coll.objects)==2, counts
main = next(o for o in coll.objects if o.get('feature_type')=='building')
assert main['height_m']==30 and main['roof_geometry']=='lidar_infill'
broken = copy.deepcopy(supplement)
broken['infill_geometry'] = {'type':'Point','coordinates':[0,0]}
coll, counts = build([parent],[crown],transform,{'parent':broken},'RetainedFallback',prefer_lidar=True)
assert counts['buildings']==1 and counts['lidar_geometry_fallbacks']==1, counts
assert sorted(o['height_m'] for o in coll.objects)==[50,80]
print('LIDAR_RETAINED_PARENT_INFILL_OK')
