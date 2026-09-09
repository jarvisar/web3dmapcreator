"""Export crop regression; run with Blender 3.6 --background --factory-startup.

Uses the installed io_mesh_3mf writer for the archive round trip.
"""
import hashlib
import math
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
import zipfile

import bpy
import bmesh
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import jarvizar_city_model as addon
from jarvizar_city_model.blender.collections import create_city_hierarchy, GENERATED_KEY
from jarvizar_city_model.blender.mesh_utils import _prism_geometry
from jarvizar_city_model.blender.export_cutout import Opening, export_geometry, CutoutError


def rectangle(w, h, x=0, y=0):
    return [(x-w/2,y-h/2), (x+w/2,y-h/2), (x+w/2,y+h/2), (x-w/2,y+h/2)]


def mesh_object(name, rings, bottom=-1, top=1, collection=None):
    vertices, faces = _prism_geometry([[(x,y,bottom,top) for x,y in r] for r in rings])
    assert faces, name
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    obj = bpy.data.objects.new(name, mesh)
    (collection or bpy.context.scene.collection).objects.link(obj)
    return obj


def frame(ring=None):
    return mesh_object('cutout', [rectangle(220,160), list(reversed(ring or rectangle(170.5,119.5)))], -2, 2)


def fingerprint(obj):
    return (obj.data.as_pointer(), hashlib.sha256(repr((
        [v.co[:] for v in obj.data.vertices],
        [(p.vertices[:], p.material_index) for p in obj.data.polygons])).encode()).hexdigest(),
        obj.matrix_world.copy(), obj.parent, obj.matrix_parent_inverse.copy(),
        obj.select_get(), obj.hide_get(), [(m.name,m.type) for m in obj.modifiers])


def audit(mesh):
    bm = bmesh.new()
    try:
        bm.from_mesh(mesh)
        bad = sum(not e.is_manifold or not e.is_contiguous for e in bm.edges)
        assert bad == 0, ('bad edges', bad)
        assert bm.calc_volume(signed=True) > 0
        return bm.calc_volume(signed=True)
    finally:
        bm.free()


class CutoutTests(unittest.TestCase):
    def setUp(self):
        for obj in list(bpy.data.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        for col in list(bpy.data.collections):
            bpy.data.collections.remove(col)
        self.collections = create_city_hierarchy(bpy.context.scene)

    def source(self, name, ring, bottom=-1, top=1):
        obj = mesh_object(name, [ring], bottom, top, self.collections['buildings'])
        obj[GENERATED_KEY] = True
        return obj

    def crop(self, sources, callback):
        bpy.context.view_layer.update()
        before = [fingerprint(o) for o in sources]
        objects, meshes = set(bpy.data.objects), set(bpy.data.meshes)
        with export_geometry(bpy.context, sources) as (parts, stats, opening):
            for part in parts:
                audit(part.data)
                if opening:
                    self.assertTrue(all(opening.contains(opening.inverse @ part.matrix_world @ v.co)
                                        for v in part.data.vertices), part.name)
            callback(parts, stats, opening)
        self.assertEqual(set(bpy.data.objects), objects)
        self.assertEqual(set(bpy.data.meshes), meshes)
        for obj, original in zip(sources, before):
            self.assertEqual(fingerprint(obj), original)

    def test_rectangle_dimensions_fast_paths_and_materials(self):
        cutout = frame()
        cutout[GENERATED_KEY] = True
        inside = self.source('inside', rectangle(2,3))
        outside = self.source('outside', rectangle(5,5,150))
        crossing = self.source('terrain', rectangle(250,180))
        material = bpy.data.materials.new('crop white')
        crossing.data.materials.append(material)
        def check(parts, stats, opening):
            self.assertEqual(len(parts), 2)
            self.assertEqual(stats['inside_objects'], 1)
            self.assertEqual(stats['outside_objects'], 1)
            self.assertEqual(stats['crossing_shells'], 1)
            self.assertIs(parts[0].data, inside.data)
            self.assertEqual(list(parts[1].data.materials), [material])
            points = [v.co for v in parts[1].data.vertices]
            self.assertAlmostEqual(max(v.x for v in points)-min(v.x for v in points),170.5, places=4)
            self.assertAlmostEqual(max(v.y for v in points)-min(v.y for v in points),119.5, places=4)
            self.assertAlmostEqual(audit(parts[1].data),170.5*119.5*2, places=2)
        self.crop([inside,outside,crossing,cutout], check)

    def test_merged_overlapping_and_nested_independent_solids(self):
        frame(rectangle(10,10))
        obj = self.source('merged', rectangle(4,4,4))
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        for size, x in [(2,4), (2,0), (1,30), (4,-4)]:
            other = self.source('shell', rectangle(size,size,x))
            bm.from_mesh(other.data)
        bm.to_mesh(obj.data)
        bm.free()
        def check(parts, stats, opening):
            self.assertEqual(stats['outside_shells'],1)
            self.assertEqual(stats['inside_shells'],2)
            self.assertEqual(stats['crossing_shells'],2)
            self.assertAlmostEqual(audit(parts[0].data),64, places=4)
        self.crop([obj], check)

    def test_through_hole_in_new_cap(self):
        frame(rectangle(10,10))
        # A tube along X makes nested section loops on the crop plane.
        obj = mesh_object('tube', [rectangle(4,4),list(reversed(rectangle(2,2)))], -8,8,
                          self.collections['buildings'])
        obj.data.transform(Matrix.Rotation(math.pi/2,4,'Y'))
        def check(parts, stats, opening):
            self.assertAlmostEqual(audit(parts[0].data),120, places=3)
        self.crop([obj], check)

    def test_transformed_frame_and_parented_modified_objects(self):
        cutout = frame(rectangle(14,8))
        cutout.matrix_world = Matrix.Translation((17,-11,4)) @ Matrix.Rotation(0.35,4,'Z') @ Matrix.Rotation(0.12,4,'X') @ Matrix.Diagonal((-1.4,0.6,1.2,1))
        parent = bpy.data.objects.new('parent',None)
        bpy.context.scene.collection.objects.link(parent)
        parent.matrix_world = cutout.matrix_world
        obj = self.source('modified', rectangle(22,16))
        obj.parent = parent
        modifier = obj.modifiers.new('thicker', 'SOLIDIFY')
        # Use a bevel instead of a topology-changing shell with overlapping walls.
        obj.modifiers.remove(modifier)
        modifier = obj.modifiers.new('bevel', 'BEVEL')
        modifier.width = 0.2
        modifier.segments = 2
        def check(parts, stats, opening):
            self.assertEqual(stats['crossing_shells'],1)
            self.assertEqual(len(parts[0].modifiers),0)
            self.assertGreater(len(parts[0].data.polygons),6)
        self.crop([obj], check)

    def test_applied_rotation_triangulated_frame(self):
        cutout = frame(rectangle(20,10))
        transform = Matrix.Rotation(0.42,4,'Z')
        cutout.data.transform(transform)
        bm=bmesh.new();bm.from_mesh(cutout.data)
        bmesh.ops.triangulate(bm,faces=list(bm.faces))
        bm.to_mesh(cutout.data);bm.free()
        obj=self.source('terrain',rectangle(100,100))
        self.crop([obj],lambda p,s,o:self.assertAlmostEqual(audit(p[0].data),400,places=2))

    def test_convex_nonrectangle(self):
        ring=[(7*math.cos(i*math.tau/12),5*math.sin(i*math.tau/12)) for i in range(12)]
        frame(ring)
        obj=self.source('terrain',rectangle(30,30))
        self.crop([obj],lambda p,s,o:self.assertAlmostEqual(audit(p[0].data),210,places=2))

    def test_concave_opening(self):
        ring=[(-5,-5),(5,-5),(5,-1),(0,-1),(0,5),(-5,5)]
        frame(ring)
        obj=self.source('terrain',rectangle(30,30))
        self.crop([obj],lambda p,s,o:self.assertAlmostEqual(audit(p[0].data),140,places=3))

    def test_concave_notch_crosses_faces_with_all_corners_inside(self):
        frame([(-5,-5),(5,-5),(5,5),(1,5),(1,0),(-1,0),(-1,5),(-5,5)])
        obj=self.source('notch',rectangle(8,8))
        self.crop([obj],lambda p,s,o:self.assertAlmostEqual(audit(p[0].data),112,places=3))

    def test_bevelled_frame_and_unwelded_stl(self):
        cutout=frame(rectangle(20,10))
        mod=cutout.modifiers.new('bevel','BEVEL');mod.width=0.5;mod.segments=3
        obj=self.source('terrain',rectangle(100,100))
        # Bevels also round the inner corners: retain that actual shape.
        from jarvizar_city_model.geometry.planar import signed_area
        self.crop([obj],lambda p,s,o:self.assertAlmostEqual(audit(p[0].data),2*signed_area(o.ring),places=3))
        cutout.modifiers.clear()
        cutout.data.calc_loop_triangles()
        vertices=[cutout.data.vertices[i].co[:] for t in cutout.data.loop_triangles for i in t.vertices]
        mesh=bpy.data.meshes.new('stl');mesh.from_pydata(vertices,[],[tuple(range(i,i+3)) for i in range(0,len(vertices),3)])
        cutout.data=mesh
        self.crop([obj],lambda p,s,o:self.assertAlmostEqual(audit(p[0].data),400,places=3))

    def test_no_cutout_and_inside_geometry_stay_shared(self):
        obj=self.source('inside',rectangle(2,2))
        parent=bpy.data.objects.new('parent',None);bpy.context.scene.collection.objects.link(parent)
        parent.location=(3,4,5);obj.parent=parent
        mod=obj.modifiers.new('bevel','BEVEL');mod.width=0.1
        def check(parts,stats,opening):
            self.assertIsNone(opening)
            self.assertIs(parts[0].data,obj.data)
            self.assertEqual(parts[0].matrix_world,obj.matrix_world)
            self.assertEqual(len(parts[0].modifiers),1)
        self.crop([obj],check)

    def test_boundary_material_slots_survive(self):
        frame(rectangle(10,10))
        obj=self.source('two colors',rectangle(20,20))
        red=bpy.data.materials.new('red');blue=bpy.data.materials.new('blue')
        obj.data.materials.append(red);obj.data.materials.append(blue)
        override=bpy.data.materials.new('object-linked override')
        obj.material_slots[0].link='OBJECT';obj.material_slots[0].material=override
        for face in obj.data.polygons:
            face.material_index=int(face.normal.z>0.5)
        def check(parts,stats,opening):
            self.assertEqual([slot.material for slot in parts[0].material_slots],[override,blue])
            self.assertTrue(all(f.material_index==1 for f in parts[0].data.polygons if f.normal.z>0.5))
            self.assertTrue(all(f.material_index==0 for f in parts[0].data.polygons if f.normal.z< -0.5))
        self.crop([obj],check)

    def test_tangent_outside_and_on_boundary(self):
        frame(rectangle(10,10))
        tangent=self.source('tangent',rectangle(2,2,6))
        exact=self.source('exact',rectangle(10,10))
        self.crop([tangent,exact],lambda p,s,o:self.assertEqual(len(p),1))

    def test_invalid_frame_and_failure_cleanup(self):
        obj=self.source('source',rectangle(50,50))
        mesh_object('cutout',[rectangle(10,10)])
        with self.assertRaisesRegex(CutoutError,'exactly one'):
            with export_geometry(bpy.context,[obj]):pass
        bpy.data.objects.remove(bpy.data.objects['cutout'],do_unlink=True)
        frame(rectangle(10,10))
        objects,meshes=set(bpy.data.objects),set(bpy.data.meshes)
        with patch('jarvizar_city_model.blender.export_cutout._clip_convex',side_effect=CutoutError('injected cap failure')):
            with self.assertRaisesRegex(CutoutError,'injected'):
                with export_geometry(bpy.context,[obj]):pass
        self.assertEqual(set(bpy.data.objects),objects)
        self.assertEqual(set(bpy.data.meshes),meshes)

    def test_real_3mf_assembly_materials_units_and_scene_restoration(self):
        frame(rectangle(17,11))
        obj=self.source('terrain',rectangle(25,25))
        extra=self.source('inside',rectangle(2,2),2,4)
        for o,color in [(obj,(0.3,0.4,0.5,1)),(extra,(1,1,1,1))]:
            mat=bpy.data.materials.new(o.name+' material');mat.diffuse_color=color
            o.data.materials.append(mat)
        obj.select_set(True)
        bpy.context.view_layer.objects.active=obj
        bpy.ops.preferences.addon_enable(module='io_mesh_3mf')
        folder=Path(__file__).resolve().parents[1]/'scratchpad'/'export-cutout'
        folder.mkdir(parents=True,exist_ok=True)
        for units,scale,display in [('NONE',1,'ADAPTIVE'),('METRIC',0.001,'MILLIMETERS')]:
            bpy.context.scene.unit_settings.system=units
            bpy.context.scene.unit_settings.scale_length=scale
            bpy.context.scene.unit_settings.length_unit=display
            bpy.context.view_layer.update()
            before=[fingerprint(o) for o in (obj,extra)]
            counts=(len(bpy.data.objects),len(bpy.data.meshes))
            output=folder/(units+'.3mf')
            self.assertEqual(bpy.ops.jarvizar.export_3mf(filepath=str(output)),{'FINISHED'})
            self.assertEqual(counts,(len(bpy.data.objects),len(bpy.data.meshes)))
            self.assertEqual(before,[fingerprint(o) for o in (obj,extra)])
            self.assertIs(bpy.context.view_layer.objects.active,obj)
            with zipfile.ZipFile(output) as archive:
                root=ET.fromstring(archive.read('3D/3dmodel.model'))
            ns={'m':root.tag.split('}')[0][1:]}
            self.assertEqual(len(root.findall('m:build/m:item',ns)),1)
            self.assertEqual(len(root.findall('.//m:component',ns)),2)
            self.assertEqual(len(root.findall('.//m:base',ns)),2)
            points=[(float(v.get('x')),float(v.get('y')),float(v.get('z'))) for v in root.findall('.//m:vertex',ns)]
            self.assertAlmostEqual(max(p[0] for p in points)-min(p[0] for p in points),17)
            self.assertAlmostEqual(max(p[1] for p in points)-min(p[1] for p in points),11)

    def test_writer_cancellation_restores_scene(self):
        frame(rectangle(10,10))
        obj=self.source('terrain',rectangle(20,20))
        obj.select_set(True);bpy.context.view_layer.objects.active=obj
        bpy.context.view_layer.update()
        before=fingerprint(obj)
        counts=(len(bpy.data.objects),len(bpy.data.meshes))
        bpy.ops.preferences.addon_enable(module='io_mesh_3mf')
        path=Path(__file__).resolve().parents[1]/'scratchpad'/'export-cutout'/'missing-directory'/'failed.3mf'
        self.assertFalse(path.parent.exists())
        with self.assertRaisesRegex(RuntimeError,'cancelled'):
            bpy.ops.jarvizar.export_3mf(filepath=str(path))
        self.assertEqual(before,fingerprint(obj))
        self.assertEqual(counts,(len(bpy.data.objects),len(bpy.data.meshes)))
        self.assertIs(bpy.context.view_layer.objects.active,obj)
        self.assertFalse(path.exists())


addon.register()
suite=unittest.defaultTestLoader.loadTestsFromTestCase(CutoutTests)
result=unittest.TextTestRunner(verbosity=2).run(suite)
if not result.wasSuccessful():
    raise SystemExit(1)
print('EXPORT_CUTOUT_OK',result.testsRun)
