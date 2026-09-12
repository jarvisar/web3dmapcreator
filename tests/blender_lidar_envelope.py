"""Shared envelope cap, courtyard, crop, minimum lift and transactional fallback."""
import copy
from pathlib import Path
import sys
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT/'tests')]
import jarvizar_city_model as addon
from jarvizar_city_model.data.projection import create_fixed_scale_transform
from jarvizar_city_model.external.lidar_records import envelope_mesh, validate_records
from blender_lidar import build, Ground
from blender_lidar_surfaces import audit_shells

addon.register()
transform = create_fixed_scale_transform(-.001, -.001, .001, .001, .07)

def geographic(x, y, z=None):
    xy = list(transform.local_to_geographic(x, y)[:2])
    return xy if z is None else xy+[z]

def geometry(rings):
    return {'type': 'Polygon', 'coordinates': [[geographic(*v) for v in [*ring, ring[0]]] for ring in rings]}

for cropped in (False, True):
    x0 = -140 if cropped else -40
    for courtyard in (False, True):
        outer = [(x0, -40), (40, -40), (40, 40), (x0, 40)]
        hole = [(-20, -20), (-20, 20), (20, 20), (20, -20)]
        feature = {'id': 'envelope', 'properties': {'height': 40},
                   'geometry': geometry([outer, hole] if courtyard else [outer])}
        surfaces = []
        for x in range(x0, 40, 20):
            for y in range(-40, 40, 20):
                if courtyard and -20 <= x < 20 and -20 <= y < 20:
                    continue
                corners = [(x, y), (x+20, y), (x+20, y+20), (x, y+20)]
                for ids in ((0, 1, 2), (0, 2, 3)):
                    points = [(*corners[i], 20+.04*corners[i][0]+.05*corners[i][1]) for i in ids]
                    surfaces.append({'geometry': geometry([points])})
        low = min(v[2] for s in surfaces for v in s['geometry']['coordinates'][0])
        for surface in surfaces:
            surface['bottom_m'] = low
        base = {'height_m': low, 'tiers': [], 'method': 'faceted_roof',
                'surface_reconstruction': 'roof_envelope'}
        # The published cap is one shared vertex table; the loose polygon list
        # is what the fitter produces and what older caches hold. Both have to
        # build the same solid.
        packed = dict(base, roof_mesh=envelope_mesh(
            [s['geometry']['coordinates'][0] for s in surfaces]))
        loose = dict(base, roof_surfaces=surfaces)
        assert len(packed['roof_mesh']['vertices']) < 3*len(packed['roof_mesh']['faces']), \
            'A cap mesh must actually share its corners'
        for encoding, record in (('polygons', loose), ('mesh', packed)):
            validate_records({'envelope': record})
            for merge in (False, True):
                coll, counts = build([feature], [], transform, {'envelope': record}, 'ENVELOPE',
                                     merge, minimum_height=4, prefer_lidar=True)
                assert counts['lidar_buildings'] == 1 and counts['lidar_geometry_fallbacks'] == 0, (encoding, counts)
                obj = coll.objects[0]
                assert audit_shells(obj) == 2, 'Envelope must be a shared cap on one seated base'
                tree = BVHTree.FromObject(obj, bpy.context.evaluated_depsgraph_get())
                if courtyard:
                    assert tree.ray_cast(Vector((0, 0, 100)), Vector((0, 0, -1)))[0] is None
                probes = [(-30, -30), (30, -30), (30, 30), (-30, 30)]
                zs = []
                for x, y in probes:
                    px, py = transform.forward(*geographic(x, y))[:2]
                    hit = tree.ray_cast(Vector((px, py, 100)), Vector((0, 0, -1)))[0]
                    assert hit is not None
                    zs.append(hit.z-(20+.04*x+.05*y)*.077)
                assert max(zs)-min(zs) < 1e-4, 'Minimum lift must carry the whole roof together'
        for broken in (copy.deepcopy(loose), copy.deepcopy(packed)):
            # A cap missing a face is a hole, whichever way it was encoded.
            if 'roof_mesh' in broken:
                broken['roof_mesh']['faces'].pop()
            else:
                broken['roof_surfaces'].pop()
            _, counts = build([feature], [], transform, {'envelope': broken}, 'BROKEN', prefer_lidar=True)
            assert counts['lidar_buildings'] == 0 and counts['lidar_geometry_fallbacks'] == 1, counts

print('LIDAR_JOINED_ENVELOPE_OK')
