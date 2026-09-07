"""Check real low-abutment meshes and unchanged normal pier placement."""

import sys
from pathlib import Path

from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jarvizar_city_model.blender.mesh_utils import MeshBuilder
from jarvizar_city_model.geometry.bridges import add_bridge_deck, add_bridge_supports
from jarvizar_city_model.geometry.deck_profile import support_stations


def check(length, gap, ground=lambda x, y: 0.0, **kwargs):
    points = [(0.0, 0.0), (length, 0.0)]
    heights = [gap+0.6, gap+0.6]
    deck, piers = MeshBuilder('deck'), MeshBuilder('piers')
    assert add_bridge_deck(deck, points, 0.35, heights, 0.6)
    count = add_bridge_supports(
        piers, points, heights, ground, 0.35, 0.6,
        2.1, 0.84, 0.4, 0.15, minimum_size=0.6, **kwargs,
    )
    tree = BVHTree.FromPolygons(deck.vertices, deck.faces)
    centers = []
    for offset in range(0, len(piers.vertices), 8):
        vertices = piers.vertices[offset:offset+8]
        x, y = (sum(v[axis] for v in vertices)/8 for axis in (0, 1))
        centers.append(x)
        assert min(v[2] for v in vertices) < ground(x, y), 'Support misses its foundation'
        top = max(v[2] for v in vertices)
        hit, normal, _, _ = tree.ray_cast(Vector((x, y, top)), Vector((0, 0, 1)))
        assert hit is not None and normal.z > 0, 'Support top is outside its deck'
        if gap < 0.4:
            assert abs(max(v[1] for v in vertices)-min(v[1] for v in vertices)-0.7) < 1e-6
    usage = {}
    for face in piers.faces:
        for a, b in zip(face, face[1:]+face[:1]):
            edge = tuple(sorted((a, b)))
            usage[edge] = usage.get(edge, 0)+1
    assert all(count == 2 for count in usage.values()), 'Open support mesh'
    return count, centers


count, centers = check(8, 0.2)
assert 0 < count <= 3
intervals = [(0, 0)] + [(x-0.3, x+0.3) for x in centers] + [(8, 8)]
assert all(b[0]-a[1] <= 2.1 for a, b in zip(intervals, intervals[1:]))
assert check(2.6, 0.2)[0] == 1
assert check(8, 0.0)[0] == 0
assert check(8, 0.2, is_void=lambda x, y: True)[0] == 0
_, centers = check(8, 0.2, is_obstructed=lambda t: abs(t*8-4) < 1)
assert centers and all(abs(x-4) >= 1 for x in centers)
count, centers = check(20, 1.0, ground=lambda x, y: 1.0 if x<1 or x>19 else 0.0)
expected = [t*20 for t in support_stations([(0, 0), (20, 0)], 2.1, 0.84)]
assert len(centers) == len(expected) and all(abs(a-b) < 1e-6 for a, b in zip(centers, expected))
print('SHORT_BRIDGES_OK: gap coverage, low abutments, deck/foundation contact, road opening, normal piers')
