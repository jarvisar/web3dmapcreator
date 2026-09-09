"""Headless LiDAR geometry regression and optional real-cache comparison render.

blender --background --factory-startup --python-exit-code 1 --python tests/blender_lidar.py
Append -- --bundle <bbox-directory> --output <png> for a real-data comparison.
"""
import argparse
import copy
import json
from pathlib import Path
import sys

import bpy
import bmesh
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from jarvizar_city_model.data.projection import create_fixed_scale_transform
from jarvizar_city_model.geometry.building_generation import generate_buildings


class Ground:
    void_mask = None
    def height_mm(self, x, y):
        return 5 + x * .02 + y * .01
    def minimum_over(self, ring):
        return min(self.height_mm(x,y) for x,y in ring)
    def maximum_over(self, ring):
        return max(self.height_mm(x,y) for x,y in ring)


def collection(name):
    result = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(result)
    return result


def check_closed(objects):
    polygons = 0
    for obj in objects:
        if obj.type != "MESH":
            continue
        mesh = bmesh.new()
        mesh.from_mesh(obj.data)
        bad = [e for e in mesh.edges if not e.is_manifold or not e.is_contiguous]
        assert not bad, (obj.name, len(bad))
        assert mesh.calc_volume(signed=True) > 0, obj.name
        polygons += len(mesh.faces)
        mesh.free()
    return polygons


def build(buildings, parts, transform, profiles, name, merge=False, minimum_height=0, prefer_lidar=False):
    coll = collection(name)
    counts = generate_buildings(buildings, parts, transform, Ground(), 3, 10,
        coll, coll, height_scale=1.1, merge=merge, lidar_profiles=profiles,
        minimum_height_mm=minimum_height, minimum_height_footprint_mm=.6, prefer_lidar=prefer_lidar)
    check_closed(coll.objects)
    return coll, counts


def synthetic():
    transform = create_fixed_scale_transform(-87.64,41.875,-87.63,41.885,.07)
    def geometry(size):
        ring = [transform.local_to_geographic(x,y)[:2] for x,y in
                ((-size,-size),(size,-size),(size,size),(-size,size),(-size,-size))]
        return {"type":"Polygon", "coordinates":[ring]}
    parent = {"id":"parent", "properties":{"height":400, "has_parts":True}, "geometry":geometry(30)}
    part = {"id":"part", "properties":{"height":250, "building_id":"parent"}, "geometry":geometry(30)}
    profile = {"height_m":30, "tiers":[
        {"bottom_m":30, "top_m":60, "geometry":geometry(20)},
        {"bottom_m":60, "top_m":90, "geometry":geometry(10)}]}
    for merge in (False,True):
        coll, counts = build([parent],[part],transform,{"parent":profile},"Measured",merge)
        assert counts["lidar_buildings"] == 1 and counts["building_parts"] == 0, counts
        assert counts["lidar_tier_solids"] == 2, counts
        assert len(coll.objects) == 1
        obj = coll.objects[0]
        ring = [transform.forward(*p)[:2] for p in parent["geometry"]["coordinates"][0]]
        base = Ground().minimum_over(ring)
        assert abs(max(v.co.z for v in obj.data.vertices) - (base + 90 * .077)) < 1e-4
    broken = copy.deepcopy(profile)
    broken["tiers"][0]["geometry"] = {"type":"Point", "coordinates":[0,0]}
    _, counts = build([parent],[part],transform,{"parent":broken},"Fallback")
    assert counts["lidar_buildings"] == 0 and counts["building_parts"] == 1, counts
    assert counts["lidar_geometry_fallbacks"] == 1
    invalid = {"id":"invalid", "properties":{"height":5,"min_height":900}, "geometry":geometry(5)}
    _, counts = build([invalid],[],transform,{},"Invalid")
    assert counts["buildings_invalid_vertical_interval"] == 1 and counts["buildings"] == 0
    crown=copy.deepcopy(part);crown['properties'].update(height=90,min_height=70,roof_shape='pyramidal',roof_height=20)
    _,counts=build([parent],[crown],transform,{'parent':profile},'PreserveCrown')
    assert counts['lidar_source_detail_preserved']==1 and counts['building_parts']==1,counts
    source_parts=[]
    for i in range(5):
        p=copy.deepcopy(part);p['id']='section'+str(i);p['properties']['height']=20+i*10;p['geometry']=geometry(30-i*3)
        source_parts.append(p)
    original,_=build([parent],source_parts,transform,{},'OriginalDetail',merge=True)
    retained,counts=build([parent],source_parts,transform,{'parent':profile},'RetainDetail',merge=True)
    assert counts['lidar_source_detail_preserved']==1,counts
    assert [tuple(v.co) for v in original.objects[0].data.vertices]==[tuple(v.co) for v in retained.objects[0].data.vertices]
    # Partial OSM assemblies retain their roof geometry and share the parent's
    # ground while a measured missing main mass fills only the remaining area.
    partial = copy.deepcopy(parent)
    partial['properties'] = {'num_floors':18, 'has_parts':True}
    crown = copy.deepcopy(part)
    crown['geometry'] = geometry(10)
    crown['properties'] = {'building_id':'parent', 'num_floors':20, 'roof_shape':'pyramidal'}
    infill = geometry(30)
    infill['coordinates'].append(list(reversed(geometry(10)['coordinates'][0])))
    supplement = {'height_m':76, 'tiers':[], 'method':'source_parts',
                  'infill_geometry':infill, 'part_heights':{'part':90}}
    for merge in (False, True):
        coll, counts = build([partial],[crown],transform,{'parent':supplement},'PartialAssembly',merge)
        assert counts['lidar_infill_buildings']==1 and counts['lidar_part_heights']==1, counts
        assert counts['building_parts']==1 and counts['roofs_built']['pyramid']==1, counts
        assert counts['lidar_buildings']==1, counts
        if not merge:
            obj=next(o for o in coll.objects if o.get('feature_type')=='building_part')
            assert obj['height_source']=='lidar:source_part' and obj['height_m']==90
            assert obj['terrain_base_source']=='parent_footprint'
    assert 'height' not in crown['properties']
    broken=copy.deepcopy(supplement)
    broken['infill_geometry']={'type':'Point','coordinates':[0,0]}
    original,_=build([partial],[crown],transform,{},'OriginalPartial',merge=True)
    fallback,counts=build([partial],[crown],transform,{'parent':broken},'BrokenInfill',merge=True)
    assert counts['lidar_geometry_fallbacks']==1 and counts['lidar_part_heights']==0, counts
    assert [tuple(v.co) for v in original.objects[0].data.vertices]==[tuple(v.co) for v in fallback.objects[0].data.vertices]
    heights_only=copy.deepcopy(supplement);del heights_only['infill_geometry']
    _,counts=build([partial],[crown],transform,{'parent':heights_only},'PartHeightOnly')
    assert counts['lidar_buildings']==1 and counts['lidar_part_heights']==1 and counts['lidar_infill_buildings']==0,counts
    print("LIDAR_SYNTHETIC_OK")


def roof_planes():
    transform = create_fixed_scale_transform(-87.64,41.875,-87.63,41.885,.07)
    def geo(rings):
        return {'type':'Polygon','coordinates':[
            [[*transform.local_to_geographic(x,y)[:2],z] for x,y,z in ring] for ring in rings]}
    outline = [(-30,-20,0),(30,-20,0),(30,20,0),(-30,20,0),(-30,-20,0)]
    parent = {'id':'roof', 'properties':{'height':25}, 'geometry':geo([outline])}
    roof = {'height_m':20, 'tiers':[], 'roof_surfaces':[
        {'bottom_m':20, 'geometry':geo([[(-30,-20,20),(0,-20,35),(0,20,35),(-30,20,20),(-30,-20,20)]])},
        {'bottom_m':20, 'geometry':geo([[(0,-20,35),(30,-20,20),(30,20,20),(0,20,35),(0,-20,35)]])}]}
    for merge in (True,False):
        coll,counts=build([parent],[],transform,{'roof':roof},'Planes',merge)
        assert counts['lidar_roof_plane_buildings']==1 and counts['lidar_roof_plane_solids']==2,counts
        obj=coll.objects[0]
        ring=[transform.forward(v[0],v[1])[:2] for v in parent['geometry']['coordinates'][0]]
        base=Ground().minimum_over(ring)
        assert abs(max(v.co.z for v in obj.data.vertices)-(base+35*.077))<1e-4
        from mathutils.bvhtree import BVHTree
        tree=BVHTree.FromObject(obj,bpy.context.evaluated_depsgraph_get())
        for x in (-25,-10,0,10,25):
            lon,lat=transform.local_to_geographic(x,0)[:2];px,py=transform.forward(lon,lat)[:2]
            hit=tree.ray_cast(Vector((px,py,100)),Vector((0,0,-1)))[0]
            expected=base+(35-abs(x)*.5)*.077
            assert hit and abs(hit.z-expected)<1e-4,(x,hit,expected)
    broken=copy.deepcopy(roof);broken['roof_surfaces'].pop()
    _,counts=build([parent],[],transform,{'roof':broken},'IncompletePlane')
    assert counts['lidar_buildings']==0 and counts['buildings']==1,counts
    # Cropping interpolates height on the original fitted plane.
    crop=create_fixed_scale_transform(-87.635,41.875,-87.63,41.885,.07)
    _,counts=build([parent],[],crop,{'roof':roof},'CroppedPlanes')
    assert counts['lidar_buildings']==1,counts
    print('LIDAR_ROOF_PLANES_OK')


def render_comparison(bundle, output, selected_id=None):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    buildings = json.loads((bundle/"building.geojson").read_text(encoding="utf-8"))["features"]
    parts = json.loads((bundle/"building_part.geojson").read_text(encoding="utf-8"))["features"]
    data = json.loads((bundle/"lidar_buildings.json").read_text(encoding="utf-8"))
    transform = create_fixed_scale_transform(*data["request"]["bbox"], .07)
    # Focus on one tower whose measured setbacks can be compared clearly.
    chosen = next((f for f in buildings if "Willis Tower" == (f.get("properties",{}).get("names") or {}).get("primary")), buildings[0])
    if selected_id:
        chosen = next(f for f in buildings if f['id'] == selected_id)
    identifier = chosen["id"]
    if identifier not in data["buildings"]:
        identifier = max(data["buildings"], key=lambda key: len(data["buildings"][key]["tiers"]))
        chosen = next(f for f in buildings if f["id"] == identifier)
    associated = [f for f in parts if f["properties"].get("building_id") == identifier]
    material = bpy.data.materials.new("Ivory")
    material.diffuse_color = (.77,.79,.82,1)
    groups = []
    for index, profiles in enumerate(({}, data["buildings"])):
        coll, counts = build([chosen], associated, transform, profiles, "Source" if index == 0 else "LiDAR",
                             prefer_lidar=data['request'].get('prefer_lidar', False))
        objects = list(coll.objects)
        coords = [v.co for obj in objects for v in obj.data.vertices]
        cx = (min(v.x for v in coords)+max(v.x for v in coords))/2
        cy = (min(v.y for v in coords)+max(v.y for v in coords))/2
        for obj in objects:
            obj.location.x = (-11 if index == 0 else 11)-cx
            obj.location.y = -cy
            obj.data.materials.append(material)
        groups.append(objects)
        print("LIDAR_COMPARISON", index, json.dumps(counts, sort_keys=True), "polygons", check_closed(objects))
    # Ground pedestals are presentation only, independent of model tests.
    for x, label in ((-11,"SOURCE"),(11,"LIDAR")):
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x,0,3.8))
        obj=bpy.context.object;obj.scale=(17,17,1);obj.data.materials.append(material)
        bpy.ops.object.text_add(location=(x-5,-10,4.4))
        obj=bpy.context.object;obj.data.body=label;obj.data.size=1.8
    scene=bpy.context.scene
    scene.render.engine="BLENDER_EEVEE"
    scene.eevee.use_gtao=True
    scene.eevee.gtao_distance=3
    scene.eevee.gtao_factor=1.2
    scene.world.color=(.35,.35,.35)
    bpy.ops.object.light_add(type="AREA",location=(0,-20,70))
    light=bpy.context.object;light.data.energy=22000;light.data.size=50
    bpy.ops.object.camera_add(location=(40,-80,65))
    z_top=max(v.co.z for group in groups for obj in group for v in obj.data.vertices)
    cam=bpy.context.object;cam.rotation_euler=(Vector((0,0,(z_top+3.3)/2))-cam.location).to_track_quat('-Z','Y').to_euler()
    cam.data.type="ORTHO";cam.data.ortho_scale=max(46,z_top*1.9);cam.data.clip_end=1000
    scene.camera=cam
    scene.render.resolution_x=1400;scene.render.resolution_y=1100;scene.render.resolution_percentage=100
    scene.render.filepath=str(output.resolve())
    bpy.ops.render.render(write_still=True)
    print("LIDAR_RENDER", identifier, str(output))


def main():
    synthetic()
    roof_planes()
    parser=argparse.ArgumentParser()
    parser.add_argument("--bundle",type=Path)
    parser.add_argument("--output",type=Path)
    parser.add_argument('--building-id')
    args=parser.parse_args(sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else [])
    if args.bundle:
        buildings=json.loads((args.bundle/"building.geojson").read_text(encoding="utf-8"))["features"]
        parts=json.loads((args.bundle/"building_part.geojson").read_text(encoding="utf-8"))["features"]
        data=json.loads((args.bundle/"lidar_buildings.json").read_text(encoding="utf-8"))
        transform=create_fixed_scale_transform(*data["request"]["bbox"],.07)
        coll,counts=build(buildings,parts,transform,data["buildings"],"Live",merge=True,
                         prefer_lidar=data['request'].get('prefer_lidar', False))
        print("LIDAR_LIVE_OK",json.dumps(counts,sort_keys=True),"polygons",check_closed(coll.objects))
        if args.output:
            render_comparison(args.bundle,args.output,args.building_id)


if __name__ == "__main__":
    main()
