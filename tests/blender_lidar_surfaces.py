"""Audit and render end-to-end roof measurements produced by external Python.

Run Blender with --python-exit-code 1 --python tests/blender_lidar_surfaces.py
-- --fixtures <json> [--report <json>] [--render-directory <directory>].

The fixture file contains ``cases`` with name, metric-XY footprint GeoJSON,
before/after measurement records, optional top probes (xy, height_m,
tolerance_m), and optional void_probes. Roof Z remains ground-relative metres.
Using serialized real measurement outputs keeps native GIS dependencies out of
Blender and exercises the same record/projection/prism path used by the add-on.
"""
import argparse
import copy
import json
import math
from pathlib import Path
import sys

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'tests')]
from blender_lidar import build
from jarvizar_city_model.data.projection import create_fixed_scale_transform
from jarvizar_city_model.external.lidar_records import validate_records
from jarvizar_city_model.geometry.lidar_buildings import surface_height


def coordinates(value):
    if value and isinstance(value[0], (float, int)):
        yield value
    else:
        for child in value:
            yield from coordinates(child)


def geographic_geometry(geometry, transform):
    result = copy.deepcopy(geometry)
    for vertex in coordinates(result['coordinates']):
        vertex[:2] = transform.local_to_geographic(*vertex[:2])[:2]
    return result


def geographic_record(record, transform):
    result = copy.deepcopy(record)
    for item in result['tiers'] + result.get('roof_surfaces', []):
        item['geometry'] = geographic_geometry(item['geometry'], transform)
    if result.get('infill_geometry'):
        result['infill_geometry'] = geographic_geometry(result['infill_geometry'], transform)
    return result


def audit_shells(obj):
    """Check each independently closed prism, not just aggregate volume."""
    mesh = obj.data
    edge_faces = {}
    for face in mesh.polygons:
        ids = list(face.vertices)
        for a, b in zip(ids, ids[1:] + ids[:1]):
            edge_faces.setdefault(tuple(sorted((a, b))), []).append((face.index, a, b))
    adjacent = [set() for _ in mesh.polygons]
    for uses in edge_faces.values():
        assert len(uses) == 2, (obj.name, 'open or nonmanifold edge', uses)
        a, b = uses
        assert a[1:] == tuple(reversed(b[1:])), (obj.name, 'inconsistent winding', uses)
        adjacent[a[0]].add(b[0]); adjacent[b[0]].add(a[0])
    remaining = set(range(len(mesh.polygons)))
    count = 0
    while remaining:
        stack = [remaining.pop()]
        faces = []
        while stack:
            face_id = stack.pop()
            faces.append(face_id)
            for neighbor in adjacent[face_id] & remaining:
                remaining.remove(neighbor)
                stack.append(neighbor)
        volume = 0.0
        origin = mesh.vertices[mesh.polygons[faces[0]].vertices[0]].co.copy()
        for face_id in faces:
            # Subtract a shell-local origin before cross products: tiny roof
            # prisms can sit 100 mm from the map origin, where float32 volume
            # cancellation otherwise looks like an inverted shell.
            verts = [mesh.vertices[i].co - origin for i in mesh.polygons[face_id].vertices]
            for i in range(1, len(verts) - 1):
                volume += verts[0].dot(verts[i].cross(verts[i + 1])) / 6
        assert volume > 0, (obj.name, 'inverted or empty shell', volume)
        count += 1
    return count


def project_xy(xy, transform):
    return transform.forward(*transform.local_to_geographic(*xy)[:2])[:2]


def validate_case(case, transform):
    feature = {'id': case['name'], 'properties': {},
               'geometry': geographic_geometry(case['footprint'], transform)}
    output, visible = {}, []
    for version in ('before', 'after'):
        record = geographic_record(case[version], transform)
        validate_records({case['name']: record})
        generated = []
        for merge in (False, True):
            coll, counts = build([feature], [], transform, {case['name']: record},
                                 case['name'] + '_' + version, merge=merge,
                                 minimum_height=.8, prefer_lidar=True)
            assert counts['lidar_buildings'] == 1 and counts['lidar_geometry_fallbacks'] == 0, (case['name'], version, counts)
            assert len(coll.objects) == 1
            obj = coll.objects[0]
            shells = audit_shells(obj)
            generated.append([tuple(v.co) for v in obj.data.vertices])
            if merge:
                coll.hide_render = True
                continue
            visible.append((version, coll, obj))
            assert not any(p.use_smooth for p in obj.data.polygons), 'Geometry comparisons must use flat shading'
            tree = BVHTree.FromObject(obj, bpy.context.evaluated_depsgraph_get())
            z_start = max(v.co.z for v in obj.data.vertices) + 10
            base = obj['terrain_base_mm'] + obj['minimum_height_lift_mm']
            errors = []
            for probe in case.get('probes', []):
                x, y = project_xy(probe['xy'], transform)
                hit = tree.ray_cast(Vector((x, y, z_start)), Vector((0, 0, -1)))[0]
                assert hit is not None, (case['name'], version, 'missing roof', probe)
                error = abs((hit.z - base) / .077 - probe['height_m'])
                errors.append(error)
                if version == 'after':
                    assert error <= probe.get('tolerance_m', 1.0), (case['name'], probe, error)
            for xy in case.get('void_probes', []):
                x, y = project_xy(xy, transform)
                assert tree.ray_cast(Vector((x, y, z_start)), Vector((0, 0, -1)))[0] is None, (case['name'], version, 'bridged courtyard', xy)
            footprint_xy = [project_xy(v[:2], transform) for v in coordinates(case['footprint']['coordinates'])]
            for axis in (0, 1):
                expected = [v[axis] for v in footprint_xy]
                actual = [v.co[axis] for v in obj.data.vertices]
                assert abs(min(expected) - min(actual)) < 2e-4
                assert abs(max(expected) - max(actual)) < 2e-4
            roof_slopes, roof_spans = [], []
            for surface in record.get('roof_surfaces', []):
                height = surface_height(surface, transform)
                roof_slopes.append(math.hypot(height(1, 0) - height(0, 0),
                                               height(0, 1) - height(0, 0)) * .07)
                zs = [v[2] for v in coordinates(surface['geometry']['coordinates'])]
                roof_spans.append(max(zs) - min(zs))
            output[version] = {'vertices': len(obj.data.vertices), 'faces': len(obj.data.polygons),
                               'shells': shells, 'roof_surfaces': len(record.get('roof_surfaces', [])),
                               'maximum_roof_slope': max(roof_slopes, default=0.0),
                               'maximum_facet_span_m': max(roof_spans, default=0.0),
                               'probe_count': len(errors),
                               'maximum_probe_error_m': max(errors) if errors else None,
                               'mean_probe_error_m': sum(errors) / len(errors) if errors else None}
        assert generated[0] == generated[1], (case['name'], version, 'merged geometry changed')
    if case.get('compare_probe_error'):
        assert output['after']['maximum_probe_error_m'] <= output['before']['maximum_probe_error_m'] + 1e-3, (case['name'], output)
    return output, visible


def render_case(case, visible, directory):
    """Render the same geometry/camera/light with flat shading, side by side."""
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    shading = scene.display.shading
    shading.light = 'STUDIO'
    shading.studiolight_rotate_z = .5
    shading.color_type = 'SINGLE'
    shading.single_color = (.72, .75, .79)
    shading.show_shadows = True
    shading.show_cavity = True
    shading.cavity_type = 'BOTH'
    shading.background_type = 'WORLD'
    scene.world.color = (.055, .06, .075)
    for coll in bpy.data.collections:
        coll.hide_render = True
    presentation = bpy.data.collections.new(case['name'] + '_presentation')
    scene.collection.children.link(presentation)
    xs, ys, zs = [], [], []
    for _, _, obj in visible:
        xs.extend(v.co.x for v in obj.data.vertices)
        ys.extend(v.co.y for v in obj.data.vertices)
        zs.extend(v.co.z for v in obj.data.vertices)
    cx, cy, cz = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, (min(zs) + max(zs)) / 2
    span = max(max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs))
    bpy.ops.object.camera_add(location=(span * 1.3, -span * 1.9, span * 1.5))
    camera = bpy.context.object
    camera.rotation_euler = (-camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = span * 3.1
    camera.data.clip_end = 1000
    scene.camera = camera
    right = camera.rotation_euler.to_quaternion() @ Vector((1, 0, 0))
    up = camera.rotation_euler.to_quaternion() @ Vector((0, 1, 0))
    labels = []
    for index, (version, coll, obj) in enumerate(visible):
        coll.hide_render = False
        offset = right * ((index - .5) * span * 1.5)
        obj.location = Vector((-cx, -cy, -cz)) + offset
        bpy.ops.object.text_add(location=offset + up * span * .65)
        label = bpy.context.object
        label.rotation_euler = camera.rotation_euler
        label.data.body = version.upper()
        label.data.align_x = 'CENTER'
        label.data.size = span * .07
        for owner in list(label.users_collection):
            owner.objects.unlink(label)
        presentation.objects.link(label)
        labels.append(label)
    scene.render.resolution_x = 1800
    scene.render.resolution_y = 1000
    scene.render.resolution_percentage = 100
    scene.render.filepath = str((directory / (case['name'] + '.png')).resolve())
    bpy.ops.render.render(write_still=True)
    for obj in labels + [camera]:
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.collections.remove(presentation)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--report', type=Path)
    parser.add_argument('--render-directory', type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    cases = json.loads(args.fixtures.read_text(encoding='utf-8'))['cases']
    transform = create_fixed_scale_transform(-.015, -.015, .015, .015, .07)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    if args.render_directory:
        args.render_directory.mkdir(parents=True, exist_ok=True)
    report = {}
    for case in cases:
        report[case['name']], visible = validate_case(case, transform)
        if args.render_directory:
            render_case(case, visible, args.render_directory)
    if args.report:
        args.report.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print('LIDAR_MEASURED_SURFACES_OK', json.dumps(report, sort_keys=True))


if __name__ == '__main__':
    main()
