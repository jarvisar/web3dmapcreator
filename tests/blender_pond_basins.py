"""Finite-depth pond/fountain geometry and UI settings, inside Blender."""

import sys
import tempfile
from pathlib import Path

import bpy
from unittest.mock import patch
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'tests'))

from jarvizar_city_model.geometry.basins import recess_terrain_basins, cut_water_land_surfaces, _closed
from jarvizar_city_model.geometry.dem_terrain import generate_terrain_solid
from jarvizar_city_model.geometry.heightfield import ModelHeightField
from jarvizar_city_model.geometry.support import CUT_WATER_DROP_MM
from jarvizar_city_model.geometry.surfaces import (
    SurfaceSettings, solve_water_bodies, flatten_terrain_under_water,
    cut_water_from_terrain, generate_water, generate_land_surfaces,
)
from jarvizar_city_model.data.projection import ModelBounds


class Transform:
    model_bounds = ModelBounds(0, 20, 0, 20)
    scale_x_mm_per_m = scale_y_mm_per_m = 0.07
    def geographic_to_model(self, x, y, z):
        return x, y, z


def rectangle(a, b, c, d):
    return [(a,b),(c,b),(c,d),(a,d),(a,b)]


def feature(kind, *rings):
    return {'type': 'Feature', 'properties': {'class': kind, 'subtype': kind},
            'geometry': {'type': 'Polygon', 'coordinates': list(rings)}}


def collection(name):
    result = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(result)
    return result


def hits(obj, x, y):
    tree = BVHTree.FromPolygons([v.co[:] for v in obj.data.vertices], [p.vertices[:] for p in obj.data.polygons])
    return tree.ray_cast((x, y, 100), (0, 0, -1))[0]


def near(actual, expected):
    assert abs(actual - expected) < 1e-4, (actual, expected)


def test_basins():
    settings = SurfaceSettings()
    # Every basin is smaller than one cell of this deliberately coarse grid.
    field = ModelHeightField(0, 0, 20, 20, 3, 3, [0] * 9)
    pond = feature('pond', rectangle(2,2,5,5), rectangle(3,3,4,4))
    fountain = feature('fountain', rectangle(7,2,8,3))
    clipped = feature('pond', rectangle(-2,7,2,9))
    river = feature('river', rectangle(12,-2,24,22))
    bodies, stats = solve_water_bodies([pond, fountain, clipped, river], Transform(), field, settings)
    assert len(bodies) == 4 and stats['water_basins'] == 3, stats
    assert bodies[-1].cut and all(not b.cut for b in bodies[:-1])
    flatten_terrain_under_water(field, bodies)
    cut_water_from_terrain(field, bodies)
    terrain = collection('basin_terrain')
    counts = generate_terrain_solid(field, 1.3, terrain)
    counts.update(recess_terrain_basins(field, bodies, terrain, 1.3))
    obj = terrain.objects[0]
    assert _closed(obj.data)
    near(counts['terrain_bottom_z_mm'], -2.3)
    for point in ((2.5,2.5), (7.5,2.5), (1,8)):
        near(hits(obj, *point).z, -1)
        near(field.height_mm(*point), -1)
    for point in ((3.5,3.5), (6,2.5), (9,9)):
        near(hits(obj, *point).z, 0)
        near(field.height_mm(*point), 0)
    assert hits(obj, 14, 10) is None
    water = collection('basin_water')
    counts.update(generate_water(bodies, water, None, settings, counts['terrain_bottom_z_mm']))
    assert counts['water_basin_surfaces'] == 3 and counts['water_full_depth_plugs'] == 1
    assert len(water.objects) == 2
    water_obj = next(obj for obj in water.objects if obj.get('water_recessed'))
    ordinary = next(obj for obj in water.objects if not obj.get('water_recessed'))
    assert water_obj.name.startswith('WATER_RECESSED')
    assert ordinary.name.startswith('WATER_SURFACE')
    assert water_obj['water_model'] == 'recessed_basin_fill'
    assert water_obj['feature_type'] == ordinary['feature_type'] == 'water_surface'
    assert water_obj['solid_count'] == 3 and ordinary['solid_count'] == 1
    assert _closed(water_obj.data)
    assert _closed(ordinary.data)
    for point in ((2.5,2.5), (7.5,2.5), (1,8)):
        near(hits(water_obj, *point).z, -.2)
    # Cut water sits below its bank; the bank (and bed) is the flat 0 grade.
    near(hits(ordinary, 14,10).z, -CUT_WATER_DROP_MM)
    assert hits(water_obj, 14,10) is None
    assert hits(ordinary, 2.5,2.5) is None
    assert hits(water_obj, 3.5,3.5) is None
    for body in bodies[:3]:
        near(body.top_mm - body.bed_mm, .8)
    park = collection('basin_park')
    generate_land_surfaces([('land_use', [feature('park', rectangle(0,0,10,10))])],
                           Transform(), field, park, {}, settings)
    counts.update(cut_water_land_surfaces(park, bodies, .55))
    assert counts['land_surface_water_cuts'] == 1
    for obj in park.objects:
        assert _closed(obj.data)
        assert hits(obj, 2.5,2.5) is None and hits(obj, 7.5,2.5) is None
        near(hits(obj, 5.1,2.5).z, .4)
    return terrain, water


def test_disabled_and_parameters():
    field = ModelHeightField(0,0,20,20,3,3,[0]*9)
    pond = feature('pond', rectangle(1,1,10,10))
    fountain = feature('fountain', rectangle(11,1,14,4))
    settings = SurfaceSettings(recess_ponds_and_fountains=False)
    bodies, counts = solve_water_bodies([pond, fountain], Transform(), field, settings)
    assert len(bodies) == 1 and bodies[0].cut and not bodies[0].basin_kind, counts
    custom = SurfaceSettings(pond_recess_depth_mm=1.7, pond_water_thickness_mm=1.1)
    bodies, _ = solve_water_bodies([pond], Transform(), field, custom)
    near(bodies[0].bed_mm,-1.7)
    near(bodies[0].top_mm,-.6)
    invalid = SurfaceSettings(pond_recess_depth_mm=.5, pond_water_thickness_mm=.8)
    try:
        solve_water_bodies([pond], Transform(), field, invalid)
        raise AssertionError('Invalid dimensions accepted')
    except ValueError as exc:
        assert 'Basin Water Thickness' in str(exc), exc
    # An area without a basin never uses the recess dimensions.
    bodies, _ = solve_water_bodies([feature('river', rectangle(12,-2,24,22))], Transform(), field, invalid)
    assert len(bodies) == 1 and not bodies[0].basin_kind


def test_skipped_basins_leave_no_trace():
    field = ModelHeightField(0,0,20,20,3,3,[0,1,2]*3)
    before = list(field.values)
    untyped = feature('water', rectangle(2,7,5,9))
    untyped['properties'] = {'subtype': 'water', 'class': 'water'}
    features = [feature('pond', rectangle(2,2,5,5)), feature('fountain', rectangle(7,2,8,3)),
                untyped, feature('river', rectangle(12,-2,24,22))]
    recessed, _ = solve_water_bodies(features, Transform(), field)
    # Skipping wins over the recess, whose dimensions then no longer matter.
    settings = SurfaceSettings(skip_ponds_and_fountains=True,
                               pond_recess_depth_mm=.5, pond_water_thickness_mm=.8)
    bodies, stats = solve_water_bodies(features, Transform(), field, settings)
    assert stats['water_basins_skipped'] == sum(bool(b.basin_kind) for b in recessed) > 0, stats
    assert len(bodies) == 1 and bodies[0].cut and stats['water_basins'] == 0, stats
    assert stats['water_rejected'] == 0, stats
    only_river, _ = solve_water_bodies(features[-1:], Transform(), field, settings)
    flatten_terrain_under_water(field, bodies)
    cut_water_from_terrain(field, bodies)
    reference = ModelHeightField(0,0,20,20,3,3,before)
    flatten_terrain_under_water(reference, only_river)
    cut_water_from_terrain(reference, only_river)
    assert list(field.values) == list(reference.values)
    target, water = collection('skipped_basin_terrain'), collection('skipped_basin_water')
    expected = collection('skipped_basin_reference')
    counts = generate_terrain_solid(field, 1.3, target)
    generate_terrain_solid(reference, 1.3, expected)
    stats = recess_terrain_basins(field, bodies, target, 1.3)
    assert not stats['water_recesses_built'] and not field.basins
    # The terrain is the one the river alone produces, vertex for vertex.
    assert ([v.co[:] for v in target.objects[0].data.vertices]
            == [v.co[:] for v in expected.objects[0].data.vertices])
    assert hits(target.objects[0],3,3) is not None and hits(target.objects[0],14,10) is None
    generate_water(bodies, water, None, settings, counts['terrain_bottom_z_mm'])
    assert len(water.objects) == 1 and hits(water.objects[0],3,3) is None


def test_slopes_and_duplicate_basins():
    field = ModelHeightField(0,0,20,20,3,3,[0,1,2]*3)
    pond = feature('pond', rectangle(2,2,5,5))
    duplicate = feature('fountain', rectangle(2,2,5,5))
    bodies, stats = solve_water_bodies([pond, duplicate], Transform(), field)
    assert len(bodies) == 1 and stats['water_basin_duplicates'] == 1, stats
    near(bodies[0].bed_mm, -.8)  # lowest bank at x=2: .2 mm
    near(bodies[0].top_mm, 0)
    target = collection('sloped_basin_terrain')
    generate_terrain_solid(field, 1.3, target)
    recess_terrain_basins(field, bodies, target, 1.3)
    near(hits(target.objects[0],3,3).z, -.8)
    near(hits(target.objects[0],5.1,3).z, .51)


def test_recess_keeps_the_terrain_material_slots():
    # Each slot exports as a filament; Blender 5 adds one for a cutter without the terrain's material.
    field = ModelHeightField(0,0,20,20,3,3,[0]*9)
    bodies, _ = solve_water_bodies([feature('pond', rectangle(2,2,5,5))], Transform(), field)
    target = collection('material_basin_terrain')
    material = bpy.data.materials.new('basin terrain material')
    generate_terrain_solid(field, 1.3, target, material)
    recess_terrain_basins(field, bodies, target, 1.3)
    assert [slot.material for slot in target.objects[0].material_slots] == [material]


def test_failure_keeps_original_terrain():
    field = ModelHeightField(0,0,20,20,3,3,[0]*9)
    bodies, _ = solve_water_bodies([feature('pond', rectangle(2,2,5,5))], Transform(), field)
    target = collection('failed_basin_terrain')
    generate_terrain_solid(field, 1.3, target)
    original = target.objects[0].data
    with patch('jarvizar_city_model.geometry.basins._floors_match', return_value=False):
        try:
            recess_terrain_basins(field, bodies, target, 1.3)
            raise AssertionError('Failed cutter accepted')
        except ValueError:
            pass
    assert target.objects[0].data == original and not field.basins
    assert len(target.objects) == 1


def test_mapped_water_basins_recess_instead_of_ordinary_water_slabs():
    # Both sub-cell and cut-sized basins used to take the raised-water path.
    field = ModelHeightField(0,0,20,20,3,3,[0,1,2]*3)
    small = feature('basin', rectangle(2,2,3,3))
    large = feature('basin', rectangle(5,5,15,15), rectangle(8,8,10,10))
    for body in (small, large):
        body['properties'].update(subtype='reservoir', is_intermittent=True,
                                  source_tags=[['natural','water'],['water','basin']])
    bodies, _ = solve_water_bodies([small, large], Transform(), field)
    assert len(bodies) == 2 and all(b.basin_kind == 'basin' and not b.cut for b in bodies)
    near(flatten_terrain_under_water(field, bodies), 0)
    cut_water_from_terrain(field, bodies)
    target, water = collection('mapped_basin_terrain'), collection('mapped_basin_water')
    generate_terrain_solid(field, 1.3, target)
    stats = recess_terrain_basins(field, bodies, target, 1.3)
    assert stats['water_recesses_built'] == 2 and field.void_mask is None
    generate_water(bodies, water, None, terrain_bottom_mm=stats['terrain_bottom_z_mm'])
    assert _closed(target.objects[0].data) and _closed(water.objects[0].data)
    for x, y, bank in ((2.5,2.5,.2), (6,6,.5)):
        near(hits(target.objects[0],x,y).z, bank - 1)
        near(hits(water.objects[0],x,y).z, bank - .2)
        near(field.height_mm(x,y), bank - 1)
    near(hits(target.objects[0],9,9).z, .9)
    assert hits(water.objects[0],9,9) is None
    ordinary, _ = solve_water_bodies([small,large], Transform(), field,
                                    SurfaceSettings(recess_ponds_and_fountains=False))
    assert len(ordinary) == 2 and all(not b.basin_kind for b in ordinary)
    assert not ordinary[0].cut and ordinary[1].cut


def test_overlapping_parts_share_a_level_and_river_overlap_is_skipped():
    field = ModelHeightField(0,0,20,20,3,3,[0,1,2]*3)
    bodies, _ = solve_water_bodies([
        feature('pond', rectangle(2,2,5,5)),
        feature('fountain', rectangle(4,2,7,5)),
        feature('river', rectangle(12,-1,21,21)),
        feature('pond', rectangle(11,2,14,5)),
    ], Transform(), field)
    cut_water_from_terrain(field, bodies)
    target = collection('overlap_basin_terrain')
    generate_terrain_solid(field, 1.3, target)
    stats = recess_terrain_basins(field, bodies, target, 1.3)
    assert stats['water_basin_groups'] == 1 and stats['water_basin_other_water_skipped'] == 1
    assert len(bodies) == 3
    near(bodies[0].bed_mm, bodies[1].bed_mm)
    near(hits(target.objects[0],4.5,3).z, -.8)
    assert hits(target.objects[0],14,10) is None


def test_settings_persist_and_water_toggle_keeps_recess():
    import jarvizar_city_model
    from jarvizar_city_model.operators import _needs_water_data, _required_types
    jarvizar_city_model.register()
    settings = bpy.context.scene.jarvizar_city_model
    assert settings.recess_ponds_and_fountains
    near(settings.pond_recess_depth_mm, 1)
    near(settings.pond_water_thickness_mm, .8)
    settings.generate_water = False
    settings.cut_water_from_terrain = False
    assert _needs_water_data(settings)
    assert 'water' in _required_types(settings) and 'infrastructure' in _required_types(settings)
    assert not settings.skip_ponds_and_fountains
    settings.skip_ponds_and_fountains = True
    assert not _needs_water_data(settings)
    settings.skip_ponds_and_fountains = False
    settings.recess_ponds_and_fountains = False
    assert not _needs_water_data(settings)
    settings.pond_recess_depth_mm = 1.7
    settings.pond_water_thickness_mm = 1.1
    with tempfile.TemporaryDirectory(prefix='jcm_pond_settings_') as directory:
        path = Path(directory)/'settings.blend'
        bpy.ops.wm.save_as_mainfile(filepath=str(path), compress=True)
        settings.recess_ponds_and_fountains = True
        settings.pond_recess_depth_mm = 1
        bpy.ops.wm.open_mainfile(filepath=str(path))
        settings = bpy.context.scene.jarvizar_city_model
        assert not settings.recess_ponds_and_fountains
        near(settings.pond_recess_depth_mm, 1.7)
        near(settings.pond_water_thickness_mm, 1.1)


test_basins()
test_disabled_and_parameters()
test_skipped_basins_leave_no_trace()
test_slopes_and_duplicate_basins()
test_recess_keeps_the_terrain_material_slots()
test_failure_keeps_original_terrain()
test_mapped_water_basins_recess_instead_of_ordinary_water_slabs()
test_overlapping_parts_share_a_level_and_river_overlap_is_skipped()
test_settings_persist_and_water_toggle_keeps_recess()
print('JARVIZAR_POND_BASINS_OK')
