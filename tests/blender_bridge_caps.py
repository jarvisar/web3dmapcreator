"""Run the cached live model and probe deck stations and pier/deck contact.

Run in background Blender with --cache <cache-root>. Optionally pass
--audit-output <json-path> to retain each deck's profile and measured error.
The tight-curve fallback is measured but exempt from the station assertion:
its overlapping turns can legitimately cover a lower station with an upper one.
"""

import json
import runpy
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
from jarvizar_city_model.geometry import roads
from jarvizar_city_model.blender.mesh_utils import MeshBuilder
from jarvizar_city_model.geometry.planar import offset_is_safe

original = roads.add_bridge_deck
records = []
current_deck = None
pier_checks = []
original_supports = roads.add_bridge_supports

def audit_supports(builder, *args, **kwargs):
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    capture = MeshBuilder('piers')
    result = original_supports(capture, *args, **kwargs)
    tree = BVHTree.FromPolygons(current_deck.vertices, current_deck.faces)
    for offset in range(0, len(capture.vertices), 8):
        vertices = capture.vertices[offset:offset+8]
        origin = Vector((sum(v[0] for v in vertices)/8,
                         sum(v[1] for v in vertices)/8, max(v[2] for v in vertices)))
        balance = 0
        for _ in range(100):
            hit, normal, index, distance = tree.ray_cast(origin, Vector((0, 0, 1)))
            if hit is None:
                break
            balance += 1 if normal.z > 0 else -1
            origin = hit + Vector((0, 0, 1e-5))
        pier_checks.append(balance > 0)
    builder.add_raw(capture.vertices, capture.faces)
    return result

def audit(builder, points, width, heights, thickness):
    global current_deck
    capture = MeshBuilder('audit')
    result = original(capture, points, width, heights, thickness)
    current_deck = capture
    errors = []
    for (x, y), expected in zip(points, heights):
        hits = []
        for face in capture.faces:
            if len(face) != 3:
                continue
            a, b, c = [capture.vertices[i] for i in face]
            area = (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
            if area <= 1e-10:
                continue
            u = ((x-a[0])*(c[1]-a[1])-(y-a[1])*(c[0]-a[0]))/area
            v = ((b[0]-a[0])*(y-a[1])-(b[1]-a[1])*(x-a[0]))/area
            if min(u, v, 1-u-v) >= -1e-7:
                hits.append(a[2]+u*(b[2]-a[2])+v*(c[2]-a[2]))
        if hits:
            errors.append(abs(max(hits)-expected))
    records.append(dict(points=points, heights=heights, width=width, thickness=thickness,
                        safe=offset_is_safe(points, width), error=max(errors, default=0)))
    builder.add_raw(capture.vertices, capture.faces)
    return result

roads.add_bridge_deck = audit
roads.add_bridge_supports = audit_supports
try:
    runpy.run_path(str(root/'tests/blender_live_full.py'), run_name='__main__')
finally:
    if '--audit-output' in sys.argv:
        output = sys.argv[sys.argv.index('--audit-output')+1]
        Path(output).write_text(json.dumps(records))
    print('CAP_AUDIT', len(records), 'decks;', sum(r['error'] > .01 for r in records),
          'off profile >0.01mm; max', max(r['error'] for r in records))
    print('PIER_CONTACT', sum(pier_checks), '/', len(pier_checks))
    assert records, 'No decks checked'
    assert all(r['error'] < 1e-6 for r in records if r['safe']), 'Deck cap skips profile stations'
    assert pier_checks and all(pier_checks), 'Pier tops outside their decks'
