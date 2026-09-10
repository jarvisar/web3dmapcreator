"""Layered tree dimensions, terrain seating, urban/forest clearance and batching."""
import math
import struct
import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jarvizar_city_model.blender.mesh_utils import MeshBuilder, tree_solid_geometry, tree_mesh_datablock
from jarvizar_city_model.geometry.vegetation import (
    TreeSettings, _tree_dimensions, _tree_scale, generate_trees, scatter_points_in_polygon,
)
from jarvizar_city_model.geometry.planar import faces_are_consistent, shell_volume


def closed(vertices, faces):
    assert faces_are_consistent(faces)
    assert shell_volume(vertices, faces) > 0
    edges = {}
    for face in faces:
        for a, b in zip(face, face[1:] + face[:1]):
            key = tuple(sorted((a, b)))
            edges[key] = edges.get(key, 0) + 1
    assert all(n == 2 for n in edges.values())
    mesh = bpy.data.meshes.new('check')
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    assert all(p.area > 0 for p in mesh.polygons)
    bpy.data.meshes.remove(mesh)


def collection(name):
    result = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(result)
    return result


def point(identifier, x, y):
    return dict(id=identifier, properties={'class': 'tree'},
                geometry=dict(type='Point', coordinates=[x, y]))


def forest(identifier, x0=14, x1=39):
    return dict(id=identifier, properties={'class': 'forest'},
                geometry=dict(type='Polygon', coordinates=[[
                    [x0, 5], [x1, 5], [x1, 28], [x0, 28], [x0, 5]],
                    [[23, 13], [23, 17], [27, 17], [27, 13], [23, 13]]]))


def placements(settings):
    transform = SimpleNamespace(
        scale_x_mm_per_m=.07, vertical_meters_to_model_mm=lambda h: h * .07,
        geographic_to_model=lambda x, y, z: (x, y, z),
        model_bounds=SimpleNamespace(min_x_mm=0, min_y_mm=0, max_x_mm=40, max_y_mm=30))
    field = SimpleNamespace(height_mm=lambda x, y: 1 + x * .025,
                            over_open_water=lambda x, y: x >= 36)
    sparse = [point('street-a', 2, 2), point('duplicate', 2.05, 2),
              point('street-b', 6, 2), point('street-c', 10, 2),
              point('forest-mapped', 18, 10), point('water', 38, 2),
              point('outside', -5, 2)]
    land = sparse + [forest('mapped-wood'), forest('overlapping-wood')]
    cover = [forest('satellite-wood')]
    # Raised surfaces must never lift the tree origin off the terrain.
    surfaces = collection('raised-surfaces')
    slab_builder = MeshBuilder('raised-slab')
    slab_builder.add_prism([[(0, 0, 1, 2.5), (40, 0, 1, 2.5),
                            (40, 30, 1, 2.5), (0, 30, 1, 2.5)]])
    slab_builder.build(surfaces, None)
    unmerged = collection('tree-instances')
    counts = generate_trees(land, cover, transform, field, unmerged, None, settings)
    assert counts['trees_mapped'] == 4, counts
    assert 90 <= counts['trees_scattered'] <= 240, counts
    assert counts['trees_skipped_over_water'] > 0
    assert counts['trees_skipped_crowded'] > 100
    bpy.context.view_layer.update()
    instances = list(unmerged.objects)
    radius, _, _ = _tree_dimensions(transform, settings)
    expected_vertices = []
    for index, obj in enumerate(instances):
        x, y, z = obj.location
        assert abs(z - field.height_mm(x, y)) < 1e-6
        assert x < 36
        if index >= 4:
            assert not (23 < x < 27 and 13 < y < 17)
        for other in instances[:index]:
            separation = math.hypot(x - other.location.x, y - other.location.y)
            assert separation >= radius * (obj.scale.x + other.scale.x) + .2 - 1e-5
        world = [tuple(obj.matrix_world @ v.co) for v in obj.data.vertices]
        assert min(v[2] for v in world) < field.height_mm(x, y)
        expected_vertices.extend(world)
    assert [tuple(round(v, 4) for v in obj.location[:2]) for obj in instances[:4]] == [
        (2, 2), (6, 2), (10, 2), (18, 10)]
    for _ in range(2):
        merged = collection('tree-merged')
        assert generate_trees(land, cover, transform, field, merged, None, settings, merge=True) == counts
        mesh = merged.objects[0].data
        assert len(mesh.vertices) == len(expected_vertices)
        assert max(math.dist(v.co, expected) for v, expected in zip(mesh.vertices, expected_vertices)) < 1e-5
        closed([tuple(v.co) for v in mesh.vertices], [tuple(p.vertices) for p in mesh.polygons])
    for cap in (0, 3):
        capped = collection('tree-cap')
        result = generate_trees(land, cover, transform, field, capped, None,
                                replace(settings, maximum_trees=cap))
        assert result['trees'] == cap and result['trees_mapped'] == cap
        assert len(capped.objects) == cap
    sparse_only = collection('tree-sparse')
    sparse_counts = generate_trees(sparse, [], transform, field, sparse_only, None,
                                   replace(settings, include_forest_scatter=False))
    assert sparse_counts['trees'] == 4
    assert scatter_points_in_polygon([[(0, 0), (10, 0), (10, 10), (0, 10)]], 1, .3, 1, 0) == []
    print('TREE_PLACEMENT_OK', counts)


def main():
    settings = TreeSettings()
    for scale in (.005, .07, .3):
        transform = SimpleNamespace(scale_x_mm_per_m=scale,
                                    vertical_meters_to_model_mm=lambda h: h * scale)
        for variation in (0, .18, .8):
            varied = replace(settings, size_variation=variation)
            radius, height, _ = _tree_dimensions(transform, varied)
            for size in (0, .25, .5, .99):
                factor = _tree_scale(size, radius, height, varied)
                assert height * factor >= settings.minimum_height_mm - 1e-9
                assert 2 * radius * math.cos(math.pi / 6) * factor >= settings.minimum_canopy_diameter_mm - 1e-9
            for embed in (0, .15):
                vertices, faces = tree_solid_geometry(radius, height, embed_mm=embed)
                closed(vertices, faces)
                assert min(v[2] for v in vertices) == -embed
                assert max(v[2] for v in vertices) == height
    transform = SimpleNamespace(scale_x_mm_per_m=.07, vertical_meters_to_model_mm=lambda h: h * .07)
    radius, height, _ = _tree_dimensions(transform, settings)
    assert abs(height - 1.6) < 1e-9
    assert abs(_tree_dimensions(transform, replace(settings, minimum_canopy_diameter_mm=2))[1] - height) < 1e-9
    first = tree_mesh_datablock('shape-test', 1, 2)
    assert tree_mesh_datablock('shape-test', 1, 2) == first
    assert tree_mesh_datablock('shape-test', 2, 3) != first
    legacy = bpy.data.meshes.new('legacy-cone')
    legacy['tree_shape'] = (1, 2, 6, 0)
    assert tree_mesh_datablock('legacy-cone', 1, 2) != legacy
    placements(settings)

    builder = MeshBuilder('tree-print-coupon')
    for row, ground in enumerate((1., 1.4, 1.65)):
        y = row * 5
        builder.add_prism([[(0, y, 0, ground), (15, y, 0, ground),
                            (15, y + 5, 0, ground), (0, y + 5, 0, ground)]])
        for x in (2.5, 7.5, 12.5):
            vertices, faces = tree_solid_geometry(radius, height, embed_mm=.15)
            builder.add_raw([(x + vx, y + 2.5 + vy, ground + vz) for vx, vy, vz in vertices], faces)
    coupon = builder.build(collection('coupon'), None)
    coupon.data.calc_loop_triangles()
    target = Path(__file__).resolve().parents[1] / 'scratchpad/tree-printability.stl'
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('wb') as stream:
        stream.write(b'JCM layered trunkless trees: 1.1 mm wide, 1.6 mm high'.ljust(80, b'\0'))
        stream.write(struct.pack('<I', len(coupon.data.loop_triangles)))
        for tri in coupon.data.loop_triangles:
            coords = [coupon.data.vertices[i].co for i in tri.vertices]
            stream.write(struct.pack('<12fH', *tri.normal, *coords[0], *coords[1], *coords[2], 0))
    print('TREE_PRINTABILITY_OK: dimensions, closed/outward tiers, mesh cache, terrain seating; coupon', target)


if __name__ == '__main__':
    main()
