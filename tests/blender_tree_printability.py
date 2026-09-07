"""Print-size floors, simple cone solids and actual surface seating in Blender."""
import math
import struct
import sys
from pathlib import Path
from types import SimpleNamespace

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jarvizar_city_model.blender.mesh_utils import MeshBuilder, tree_solid_geometry, tree_mesh_datablock
from jarvizar_city_model.geometry.vegetation import TreeSettings, _tree_dimensions, _tree_scale, _ground_sampler
from jarvizar_city_model.geometry.planar import faces_are_consistent


def closed(vertices, faces):
    assert faces_are_consistent(faces)
    edges = {}
    for face in faces:
        for a, b in zip(face, face[1:]+face[:1]):
            key = tuple(sorted((a,b)))
            edges[key] = edges.get(key, 0)+1
    assert all(n == 2 for n in edges.values())
    mesh = bpy.data.meshes.new('check')
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    assert all(p.area > 0 for p in mesh.polygons)
    bpy.data.meshes.remove(mesh)


def main():
    settings = TreeSettings()
    for scale in (.005, .07, .3):
        transform = SimpleNamespace(scale_x_mm_per_m=scale,
                                    vertical_meters_to_model_mm=lambda h: h*scale)
        for variation in (0, .28, .8):
            settings.size_variation = variation
            radius, height, _ = _tree_dimensions(transform, settings)
            for size in (0, .25, .5, .99):
                factor = _tree_scale(size, radius, height, settings)
                assert height*factor >= settings.minimum_height_mm-1e-9
                assert 2*radius*math.cos(math.pi/6)*factor >= settings.minimum_canopy_diameter_mm-1e-9
                for embed in (0, .15):
                    vertices, faces = tree_solid_geometry(radius, height, embed_mm=embed)
                    closed(vertices, faces)
                    assert len(vertices) == (13 if embed else 7)
                    assert min(v[2] for v in vertices) == -embed
                    assert max(v[2] for v in vertices) == height
    first = tree_mesh_datablock('shape-test', 1, 2)
    assert tree_mesh_datablock('shape-test', 1, 2) == first
    assert tree_mesh_datablock('shape-test', 2, 3) != first

    # Raised slab with a real hole: seat on its cap only where it exists.
    collection = bpy.data.collections.new('tree-ground-test')
    bpy.context.scene.collection.children.link(collection)
    builder = MeshBuilder('slab')
    levels = lambda ring: [(x,y,.85,1.4+x*.02) for x,y in ring]
    builder.add_prism([levels([(0,0),(10,0),(10,10),(0,10)]),
                       levels([(4,4),(4,6),(6,6),(6,4)])])
    slab = builder.build(collection, None)
    sampler = _ground_sampler(SimpleNamespace(height_mm=lambda x,y:1), [slab])
    assert abs(sampler(2,2)-1.44) < 1e-6
    assert sampler(5,5) == 1  # Hole must not lift the tree into empty space.
    assert sampler(12,5) == 1

    # A small, reproducible slicing coupon: nine minimum-size cones, seated on
    # three surface levels (including offsets from the layer grid).
    builder = MeshBuilder('tree-print-coupon')
    for row, ground in enumerate((1., 1.4, 1.65)):
        y = row*5
        builder.add_prism([[(0,y,0,ground),(15,y,0,ground),
                            (15,y+5,0,ground),(0,y+5,0,ground)]])
        for x in (2.5, 7.5, 12.5):
            vertices, faces = tree_solid_geometry(1.2/(2*math.cos(math.pi/6)), 2, embed_mm=.15)
            builder.add_raw([(x+vx,y+2.5+vy,ground+vz) for vx,vy,vz in vertices], faces)
    coupon = builder.build(collection, None)
    coupon.data.calc_loop_triangles()
    target = Path(__file__).resolve().parents[1]/'scratchpad/tree-printability.stl'
    with target.open('wb') as stream:
        stream.write(b'JCM minimum cone trees: 1.2 mm wide, 2 mm high'.ljust(80,b'\0'))
        stream.write(struct.pack('<I',len(coupon.data.loop_triangles)))
        for tri in coupon.data.loop_triangles:
            coords = [coupon.data.vertices[i].co for i in tri.vertices]
            stream.write(struct.pack('<12fH', *tri.normal, *coords[0], *coords[1], *coords[2], 0))
    print('TREE_PRINTABILITY_OK: dimensions, manifold cones, mesh cache, slab/hole seating; coupon', target)


if __name__ == '__main__':
    main()
