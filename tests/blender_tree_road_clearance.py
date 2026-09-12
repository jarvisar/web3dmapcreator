"""Road/path crown trimming at default print scale, in both output modes."""
import json
import math
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from blender_tree_printability import closed, collection, point, forest
from jarvizar_city_model.blender.mesh_utils import MeshBuilder, tree_solid_geometry
from jarvizar_city_model.geometry.tree_road_cut import TreeRoadCutter
from jarvizar_city_model.geometry.planar import shell_volume
from jarvizar_city_model.geometry.vegetation import TreeSettings, generate_trees
from jarvizar_city_model.geometry.footprint_cut import FootprintIndex, area_xy
from jarvizar_city_model.geometry.surface_priority import _road_outline_triangles


def snapshot(obj):
    return ([tuple(v.co) for v in obj.data.vertices],
            [tuple(p.vertices) for p in obj.data.polygons])


def make_road(roads, name, ring, kind='surface_road'):
    builder = MeshBuilder(name)
    assert builder.add_prism([[(x, y, x*.02-.15, x*.02+.6) for x, y in ring]],
                             refine=(.2, lambda x, y: (x*.02-.15, x*.02+.6)))
    obj = builder.build(roads)
    obj['feature_type'] = kind
    return obj


def compare_plane_cuts_with_boolean():
    checked = 0
    for translation in (0, 1250):
        for angle in (0, .63):
            roads = collection('oracle-roads')
            co, si = math.cos(angle), math.sin(angle)
            def xy(x, y):
                return translation+x*co-y*si, translation+x*si+y*co
            b = MeshBuilder('oracle-road')
            b.add_flat_prism([xy(x, y) for x, y in [(-3,-.3),(3,-.3),(3,.3),(-3,.3)]], -.15, .6)
            obj = b.build(roads)
            obj['feature_type'] = 'surface_road'
            cutter = TreeRoadCutter(roads)
            for sides in (4, 6, 8):
                for offset in (.35, .5, .62):
                    vertices, faces = tree_solid_geometry(.72, 1.6, sides=sides, embed_mm=.15)
                    vertices = [(*xy(x, y+offset), z) for x, y, z in vertices]
                    optimized = cutter.trim(vertices, faces, .4)
                    with patch.object(cutter, '_clip_planes', return_value=None):
                        exact = cutter.trim(vertices, faces, .4)
                    assert bool(optimized[1]) == bool(exact[1])
                    if optimized[1]:
                        closed(*optimized[:2])
                        expected = shell_volume(*exact[:2])
                        assert abs(shell_volume(*optimized[:2])-expected) < max(2e-5, expected*2e-4)
                    checked += 1
    print('TREE_PLANE_BOOLEAN_COMPARISON_OK', checked)


def main():
    transform = SimpleNamespace(
        scale_x_mm_per_m=.07, vertical_meters_to_model_mm=lambda h: h*.07,
        geographic_to_model=lambda x, y, z: (x, y, z),
        model_bounds=SimpleNamespace(min_x_mm=0, min_y_mm=0, max_x_mm=40, max_y_mm=30))
    field = SimpleNamespace(height_mm=lambda x, y: x*.02, over_open_water=lambda x, y: False)
    roads = collection('roads')
    make_road(roads, 'street', [(0,4.7),(40,4.7),(40,5.3),(0,5.3)])
    make_road(roads, 'footway', [(14.775,0),(15.225,0),(15.225,30),(14.775,30)])
    make_road(roads, 'bend', [(20,8),(25,8),(25,12),(24.55,12),(24.55,8.45),(20,8.45)])
    make_road(roads, 'covered', [(29,1),(33,1),(33,4),(29,4)])
    # A high deck must not erase ground trees under it.
    make_road(roads, 'bridge', [(34,1),(36,1),(36,4),(34,4)], 'bridge_deck')
    originals = [snapshot(obj) for obj in roads.objects]
    features = [point('edge', 3, 5.5), point('center', 7, 5),
                point('touch', 11, 6.2), point('junction', 15.4, 5.5),
                point('path', 15.5, 10), point('bend', 24.5, 8.5),
                point('covered', 31, 2), point('under-bridge', 35, 2),
                point('untouched', 3, 2), forest('wood', 14, 29)]
    settings = TreeSettings()
    mask = FootprintIndex(clearance=0)
    for obj in roads.objects:
        if obj.get('feature_type') == 'surface_road':
            for triangle in _road_outline_triangles(obj.data):
                mask.add(triangle)
    results = []
    for merge in (False, True):
        trees = collection('trees')
        counts = generate_trees(features, [], transform, field, trees, None, settings,
                                merge=merge, road_collection=roads)
        bpy.context.view_layer.update()
        assert counts['trees_road_trimmed'] >= 4, counts
        assert counts['trees_mapped'] >= 6, counts
        assert counts['trees_skipped_roads'] >= 1, counts
        geometry = []
        for obj in trees.objects:
            vertices = [tuple(obj.matrix_world @ v.co) for v in obj.data.vertices]
            faces = [tuple(p.vertices) for p in obj.data.polygons]
            closed(vertices, faces)
            if not merge:
                # Every disconnected remnant must reach the original embedded
                # base. A closed floating upper tier is still unprintable.
                neighbors = {i: set() for i in range(len(vertices))}
                for face in faces:
                    for a, b in zip(face, face[1:] + face[:1]):
                        neighbors[a].add(b)
                        neighbors[b].add(a)
                pending = set(neighbors)
                while pending:
                    seed = pending.pop()
                    shell, stack = {seed}, [seed]
                    while stack:
                        for other in neighbors[stack.pop()] & pending:
                            pending.remove(other)
                            shell.add(other)
                            stack.append(other)
                    assert min(vertices[i][2] for i in shell) < obj.location.z
            obj.data.calc_loop_triangles()
            for tri in obj.data.loop_triangles:
                polygon = [vertices[i] for i in tri.vertices]
                if area_xy(polygon) < 0:
                    polygon.reverse()
                if area_xy(polygon) > 1e-10:
                    overlap = area_xy(polygon)-sum(area_xy(p) for p in mask.difference(polygon))
                    assert overlap < 1e-7, (obj.name, overlap, polygon)
            geometry.extend(vertices)
        results.append((counts, sorted(geometry)))
        assert [snapshot(obj) for obj in roads.objects] == originals
    assert results[0][0] == results[1][0]
    assert len(results[0][1]) == len(results[1][1])
    assert max(math.dist(a, b) for a, b in zip(results[0][1], results[1][1])) < 1e-5
    assert not any(obj.name.startswith('_TREE_ROAD_') for obj in bpy.data.objects)
    assert not any(mesh.name.startswith('_TREE_ROAD_') for mesh in bpy.data.meshes)
    compare_plane_cuts_with_boolean()
    # A near-tangent cut produced a sub-micron wall that rounded to zero area.
    # Keep this small geometry fixture independent of the originating map cache.
    fixture = json.loads((Path(__file__).parent/'fixtures/tree_road_tangent.json').read_text())
    cutter = TreeRoadCutter(None)
    for box, planes in fixture['cutters']:
        index = len(cutter.mask.cutters)
        cutter.mask.cutters.append((box, planes))
        for cell in cutter.mask._cells(box):
            cutter.mask.cells[cell].append(index)
    vertices, faces, changed = cutter.trim(fixture['vertices'], fixture['faces'], fixture['width'])
    assert changed and faces
    closed(vertices, faces)
    assert not any(scene.name.startswith('_TREE_ROAD_') for scene in bpy.data.scenes)
    print('TREE_ROAD_CLEARANCE_OK', results[0][0])


main()
