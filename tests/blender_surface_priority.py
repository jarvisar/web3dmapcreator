"""Surface ownership, holes, material preservation and configurable order."""

import sys
from pathlib import Path
from types import SimpleNamespace

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jarvizar_city_model.blender.mesh_utils import MeshBuilder
from jarvizar_city_model.blender.materials import model_materials
from jarvizar_city_model.data.land import DEFAULT_SURFACE_PRIORITY
from jarvizar_city_model.geometry.footprint_cut import area_xy
from jarvizar_city_model.geometry.planar import EPSILON, faces_are_consistent
from jarvizar_city_model.geometry.surface_priority import cut_surface_overlaps, _top_triangles
from jarvizar_city_model.geometry.surfaces import SurfaceSettings, generate_land_surfaces


def rectangle(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def snapshot(obj):
    return ([tuple(v.co) for v in obj.data.vertices],
            [tuple(p.vertices) for p in obj.data.polygons])


def top_area(obj):
    return sum(area_xy(t) for t in _top_triangles(obj.data))


def assert_closed(obj):
    faces = [tuple(p.vertices) for p in obj.data.polygons]
    assert faces_are_consistent(faces), obj.name
    uses = {}
    for face in obj.data.polygons:
        for edge in face.edge_keys:
            uses[edge] = uses.get(edge, 0)+1
    assert all(count == 2 for count in uses.values()), obj.name


def make(collection, category, outer, holes=()):
    builder = MeshBuilder(category)
    levels = lambda ring: [(x, y, 2+x*.1+y*.2-.55, 2+x*.1+y*.2) for x, y in ring]
    assert builder.add_prism([levels(outer)] + [levels(hole) for hole in holes])
    obj = builder.build(collection, model_materials()['surface_'+category])
    obj['feature_type'] = 'land_surface'
    obj['surface_category'] = category
    return obj


def main():
    collection = bpy.data.collections.new('surface_priority_test')
    # Insert in reverse order to prove collection iteration does not choose ownership.
    objects = {}
    for index, category in reversed(list(enumerate(DEFAULT_SURFACE_PRIORITY))):
        objects[category] = make(collection, category, rectangle(0, 0, (index+1)*2, 10))
    highest = snapshot(objects['paved'])
    materials = {category: obj.data.materials[0] for category, obj in objects.items()}
    progress = []
    counts = cut_surface_overlaps(collection, .55, progress_callback=progress.append)
    assert counts['land_surface_overlap_cut_objects'] == 4, counts
    assert abs(counts['land_surface_overlap_cut_area_mm2']-(200+40*EPSILON)) < 1e-5, counts
    assert progress[-1] == 1 and progress == sorted(progress)
    assert snapshot(objects['paved']) == highest
    for index, category in enumerate(DEFAULT_SURFACE_PRIORITY):
        obj = objects[category]
        assert_closed(obj)
        assert obj.data.materials[0] == materials[category]
        expected_area = 20 if index == 0 else 20-10*EPSILON
        assert abs(top_area(obj)-expected_area) < 1e-5, (category, top_area(obj))
        for triangle in _top_triangles(obj.data):
            for x, y, z in triangle:
                assert index*2-1e-5 <= x <= (index+1)*2+1e-5, (category, x)
                assert abs(z-(2+x*.1+y*.2)) < 1e-5, 'Drape height changed'
        for x, y, z in (tuple(v.co) for v in obj.data.vertices):
            assert min(abs(z-(2+x*.1+y*.2)), abs(z-(2+x*.1+y*.2-.55))) < 1e-5
    areas = [top_area(obj) for obj in collection.objects]
    second = cut_surface_overlaps(collection, .55)
    assert second['land_surface_overlap_cut_area_mm2'] < 1e-5, second
    assert all(abs(top_area(obj)-area) < 1e-5 for obj, area in zip(collection.objects, areas))

    # A high-priority hole remains available to lower-priority material.
    holes = bpy.data.collections.new('surface_priority_holes')
    paved = make(holes, 'paved', rectangle(2, 2, 8, 8), [list(reversed(rectangle(4, 4, 6, 6)))])
    green = make(holes, 'green', rectangle(0, 0, 10, 10))
    cut_surface_overlaps(holes, .55)
    assert abs(top_area(paved)-32) < 1e-5
    assert abs(top_area(green)-(68-32*EPSILON)) < 1e-5
    assert_closed(green)
    hole_area = sum(area_xy(t) for t in _top_triangles(green.data)
                    if all(4-1e-5 <= p[0] <= 6+1e-5 and 4-1e-5 <= p[1] <= 6+1e-5 for p in t))
    assert abs(hole_area-(2-2*EPSILON)**2) < 1e-5, hole_area

    # Fully covered objects disappear; disjoint and non-surface objects stay exact.
    disjoint = make(holes, 'rock', rectangle(20, 20, 21, 21))
    covered = make(holes, 'sand', rectangle(2.5, 2.5, 3.5, 3.5))
    protected = make(holes, 'forest', rectangle(2.5, 2.5, 3.5, 3.5))
    protected['feature_type'] = 'terrain'
    saved = [snapshot(disjoint), snapshot(protected)]
    covered_name = covered.name
    cut_surface_overlaps(holes, .55)
    assert covered_name not in bpy.data.objects
    assert saved == [snapshot(disjoint), snapshot(protected)]

    # Exercise the actual surface generator with a custom order and no roads.
    class Transform:
        model_bounds = SimpleNamespace(min_x_mm=0, min_y_mm=0, max_x_mm=10, max_y_mm=10)
        def geographic_to_model(self, x, y, z=0):
            return x, y, 0
    geometry = {'type': 'Polygon', 'coordinates': [rectangle(0, 0, 10, 10)]}
    features = [('land', [{'geometry': geometry, 'properties': {'class': 'forest'}}]),
                ('land_use', [{'geometry': geometry, 'properties': {'class': 'pedestrian'}}])]
    for order in (DEFAULT_SURFACE_PRIORITY, tuple(reversed(DEFAULT_SURFACE_PRIORITY))):
        output = bpy.data.collections.new('generated_priority')
        counts = generate_land_surfaces(features, Transform(),
            SimpleNamespace(void_mask=None, height_mm=lambda x, y: 0,
                            sample_ring=lambda ring: [(x, y, 0) for x, y in ring]), output,
            model_materials(), SurfaceSettings(priority_order=order))
        assert len(output.objects) == 1
        assert output.objects[0]['surface_category'] == order[0], order
        assert counts['land_surface_priority'] == list(order)
        assert_closed(output.objects[0])
    print('JARVIZAR_SURFACE_PRIORITY_OK: ownership, holes, slopes, thickness, materials, custom order')


main()
