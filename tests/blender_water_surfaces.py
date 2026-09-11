"""Every validated water footprint clears all land-cover slab categories."""

import sys
from pathlib import Path

import bpy
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from jarvizar_city_model.blender.mesh_utils import MeshBuilder
from jarvizar_city_model.data.projection import ModelBounds
from jarvizar_city_model.geometry.basins import cut_water_land_surfaces, _closed
from jarvizar_city_model.geometry.heightfield import ModelHeightField
from jarvizar_city_model.geometry.surfaces import SurfaceSettings, solve_water_bodies, generate_land_surfaces


class Transform:
    model_bounds = ModelBounds(0,20,0,20)
    scale_x_mm_per_m = scale_y_mm_per_m = .07

    def geographic_to_model(self,x,y,z):
        return x,y,z


def rectangle(a,b,c,d):
    return [(a,b),(c,b),(c,d),(a,d)]


def feature(kind,*rings):
    return {'properties':{'class':kind},'geometry':{'type':'Polygon','coordinates':[r+[r[0]] for r in rings]}}


def collection():
    target=bpy.data.collections.new('water_surface_test')
    bpy.context.scene.collection.children.link(target)
    return target


def slab(target,category,rings):
    builder=MeshBuilder(category)
    assert builder.add_prism([[(x,y,1+x*.1+y*.2-.55,1+x*.1+y*.2) for x,y in r] for r in rings])
    material=bpy.data.materials.new(category)
    obj=builder.build(target,material)
    obj['feature_type']='land_surface'
    obj['surface_category']=category
    return obj


def tree(obj):
    return BVHTree.FromPolygons([v.co[:] for v in obj.data.vertices], [p.vertices[:] for p in obj.data.polygons])


def hit(bvh,x,y):
    return bvh.ray_cast((x,y,100),(0,0,-1))[0]


def test_all_water_and_all_surface_categories():
    field=ModelHeightField(0,0,20,20,3,3,[0]*9)
    waters=[feature('lake',rectangle(2,2,5,5),rectangle(3,3,4,4)),
            feature('fountain',rectangle(7,2,8,3)),
            feature('river',rectangle(12,-1,24,21))]
    bodies,_=solve_water_bodies(waters,Transform(),field)
    assert len(bodies)==3 and not bodies[0].cut and bodies[-1].cut
    assert bodies[1].basin_kind=='fountain'
    target=collection()
    objects=[slab(target,category,[rectangle(0,0,20,20),list(reversed(rectangle(9,9,11,11)))])
             for category in ('forest','green','paved','sand','rock')]
    materials=[o.data.materials[0] for o in objects]
    protected=slab(target,'green',[rectangle(2,2,5,5)])
    protected['feature_type']='terrain_support'
    protected_mesh=protected.data
    disjoint=slab(target,'green',[rectangle(30,30,31,31)])
    disjoint_mesh=disjoint.data
    covered=slab(target,'forest',[rectangle(2.1,2.1,2.9,2.9)])
    covered_name=covered.name
    # No water mesh exists: exclusions must also survive hiding the water fill.
    cut_water_land_surfaces(target,bodies,.55)
    for obj,material in zip(objects,materials):
        assert _closed(obj.data),obj.name
        assert obj.data.materials[0]==material
        bvh=tree(obj)
        for x,y in ((2.5,2.5),(7.5,2.5),(13,5),(19.9,19.9)):
            assert hit(bvh,x,y) is None, (obj.name,'water still covered',x,y)
        for x,y in ((3.5,3.5),(5.1,2.5),(11.9,5),(1,15)):
            p=hit(bvh,x,y)
            assert p is not None and abs(p.z-(1+x*.1+y*.2))<1e-4,(obj.name,x,y,p)
        assert hit(bvh,10,10) is None, 'Surface hole was filled'
        for v in obj.data.vertices:
            x,y,z=v.co
            assert min(abs(z-(1+x*.1+y*.2)),abs(z-(1+x*.1+y*.2-.55)))<1e-4
    assert covered_name not in bpy.data.objects
    assert protected.data==protected_mesh and disjoint.data==disjoint_mesh


def test_generated_forest_and_green_with_recess_disabled():
    field=ModelHeightField(0,0,20,20,3,3,[0]*9)
    settings=SurfaceSettings(recess_ponds_and_fountains=False,cut_from_terrain=False)
    bodies,_=solve_water_bodies([feature('pond',rectangle(2,2,5,5))],Transform(),field,settings)
    assert len(bodies)==1 and not bodies[0].basin_kind and not bodies[0].cut
    for layer,kind in (('land','forest'),('land_use','park')):
        target=collection()
        generate_land_surfaces([(layer,[feature(kind,rectangle(0,0,8,8))])],
                               Transform(),field,target,{},settings)
        assert len(target.objects)==1
        cut_water_land_surfaces(target,bodies,.55)
        obj=target.objects[0]
        assert _closed(obj.data)
        assert hit(tree(obj),3,3) is None, (kind,'ordinary pond covered')
        assert abs(hit(tree(obj),6,6).z-.4)<1e-4


test_all_water_and_all_surface_categories()
test_generated_forest_and_green_with_recess_disabled()
print('JARVIZAR_WATER_SURFACES_OK')
