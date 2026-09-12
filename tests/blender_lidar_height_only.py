"""Scalar correction keeps source topology, courtyards, roof parts and seating."""
import copy
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch
import bpy
sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parent)]
import jarvizar_city_model as addon
from blender_lidar import build, check_closed
from jarvizar_city_model.data.projection import create_fixed_scale_transform
from jarvizar_city_model.data.cache import Bounds, CacheBundle
from jarvizar_city_model.operators import _lidar_signature

addon.register()
settings = bpy.context.scene.jarvizar_city_model
assert not settings.lidar_height_only
with tempfile.TemporaryDirectory() as directory:
    bundle = CacheBundle(Path(directory), Bounds(-87.64,41.875,-87.63,41.885))
    bundle.ensure_directory()
    for kind in ('building','building_part'):
        bundle.data_path(kind).write_text('{"features":[]}')
    normal = _lidar_signature(settings,bundle)
    settings.lidar_height_only = True
    settings.lidar_rock_surfaces = True
    scalar = _lidar_signature(settings,bundle)
    assert scalar['roof_mode']=='HEIGHT_ONLY' and not scalar['rock_surfaces']
    assert not scalar['roof_planes'] and scalar != normal

transform = create_fixed_scale_transform(-87.64,41.875,-87.63,41.885,.07)
def geometry(size, hole=0):
    ring = lambda s: [transform.local_to_geographic(x,y)[:2] for x,y in
                     ((-s,-s),(s,-s),(s,s),(-s,s),(-s,-s))]
    return {'type':'Polygon','coordinates':[ring(size)]+([list(reversed(ring(hole)))] if hole else [])}

parent = {'id':'parent','properties':{'height':20,'has_parts':True},'geometry':geometry(30,8)}
tower = {'id':'tower','properties':{'building_id':'parent','height':80},'geometry':geometry(15,8)}
crown = {'id':'crown','properties':{'building_id':'parent','height':100,'min_height':80,
         'roof_shape':'pyramidal','roof_height':20},'geometry':geometry(6)}
record = {'height_m':150,'tiers':[],'method':'height_only',
          'source_heights':{'parent':30,'tower':120,'crown':150}}
original = copy.deepcopy([parent,tower,crown])
for merge in (False,True):
    source, before = build([parent],[tower,crown],transform,{},'Source',merge=merge)
    with patch('jarvizar_city_model.geometry.lidar_buildings.measured_builder',side_effect=AssertionError('sculpted')):
        result, after = build([parent],[tower,crown],transform,{'parent':record},'Scalar',merge=merge)
    assert after['lidar_height_only_buildings']==3 and after['lidar_buildings']==3, after
    assert before['buildings']==after['buildings'] and before['building_parts']==after['building_parts']
    assert after['lidar_infill_buildings']==after['lidar_tier_solids']==0
    assert len(source.objects)==len(result.objects)
    for old, new in zip(source.objects,result.objects):
        assert [tuple(f.vertices) for f in old.data.polygons]==[tuple(f.vertices) for f in new.data.polygons]
        assert [tuple(v.co[:2]) for v in old.data.vertices]==[tuple(v.co[:2]) for v in new.data.vertices]
        if not merge:
            assert old['roof_geometry']==new['roof_geometry']
            assert new['height_source']=='lidar:height_only'
            assert abs(new['lidar_height_ratio']-1.5)<1e-5
            assert abs(new['height_m']-old['height_m']*1.5)<1e-5
            # Grounded bottom faces stay exactly seated. Elevated crown bottom
            # moves from the tower's old top to the tower's corrected top.
            base = old['terrain_base_mm']
            grounded = old['underside']=='draped_to_terrain'
            for a,b in zip(old.data.vertices,new.data.vertices):
                if grounded and a.co.z <= old['terrain_top_mm']:
                    assert abs(a.co.z-b.co.z)<1e-6
                else:
                    assert abs(b.co.z-(base+(a.co.z-base)*1.5))<1e-4
    check_closed(result.objects)
assert [parent,tower,crown]==original

# Slight differences are measurement noise, not a reason to modify a model.
source, _ = build([parent],[tower,crown],transform,{},'CloseSource')
unchanged, counts = build([parent],[tower,crown],transform,
    {'parent':{'height_m':105,'tiers':[],'method':'height_only','source_heights':{'crown':105}}},'CloseMeasured')
assert counts['lidar_height_only_buildings']==0
for old,new in zip(source.objects,unchanged.objects):
    assert [tuple(v.co) for v in old.data.vertices]==[tuple(v.co) for v in new.data.vertices]

# Retain the existing print minimum when a measurement lowers a short mass.
short = {'id':'short','properties':{'height':20},'geometry':geometry(20,8)}
coll, counts = build([short],[],transform,{'short':{'height_m':3,'tiers':[],'method':'height_only','source_heights':{'short':3}}},
                     'Minimum',minimum_height=.8)
obj = coll.objects[0]
assert abs(max(v.co.z for v in obj.data.vertices)-obj['terrain_top_mm']-.8)<1e-5
assert abs(obj['height_m']-3)<1e-5
check_closed(coll.objects)

# A genuinely heightless retained footprint uses its measured height rather
# than remaining at the generic 10 m fallback.
unknown = {'id':'unknown','properties':{},'geometry':geometry(20,8)}
coll, counts = build([unknown],[],transform,
    {'unknown':{'height_m':25,'tiers':[],'method':'height_only','source_heights':{'unknown':25}}},'Heightless',minimum_height=.8)
assert abs(coll.objects[0]['height_m']-25)<1e-5
assert counts['lidar_height_only_buildings']==1
assert unknown['properties']=={}

# The rejected narrow spire must not set the scale of the restored main mass.
parent = {'id':'parent','properties':{'height':57.8,'has_parts':True,
          'sources':[{'property':'/properties/height','dataset':'USGS Lidar'}]},'geometry':geometry(20)}
spire = {'id':'spire','properties':{'building_id':'parent','height':69},'geometry':geometry(.1)}
coll, counts = build([parent],[spire],transform,{'parent':{'height_m':15,'tiers':[],'method':'height_only','source_heights':{'parent':15}}},'Restored')
assert counts['building_parents_restored']==1 and counts['building_parts']==0, counts
assert abs(coll.objects[0]['lidar_height_ratio']-15/57.8)<1e-6
assert abs(coll.objects[0]['height_m']-15)<1e-5

# Regression: an explicit low podium must not be mistaken for its heightless tower.
podium={'id':'podium','properties':{'building_id':'family','height':30},'geometry':geometry(10,5)}
tower={'id':'tower','properties':{'building_id':'family'},'geometry':geometry(5)}
family={'id':'family','properties':{'has_parts':True},'geometry':geometry(10)}
coll,counts=build([family],[podium,tower],transform,{'family':{'method':'height_only','height_m':208,
    'tiers':[],'source_heights':{'podium':33,'tower':208}}},'RightMass')
objects={o['overture_id']:o for o in coll.objects}
assert objects['podium']['height_m']==30
assert objects['podium']['height_source']=='height'
assert abs(objects['tower']['height_m']-208)<1e-5
print('LIDAR_HEIGHT_ONLY_OK')
