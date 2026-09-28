"""Export crop regression; run with Blender 3.6 --background --factory-startup.

Writes real Bambu project archives for the archive round trip.
"""
import hashlib
import json
import math
import shutil
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
import zipfile

import bpy
import bmesh
from mathutils import Euler, Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import jarvizar_city_model as addon
from jarvizar_city_model.blender.collections import create_city_hierarchy, GENERATED_KEY
from jarvizar_city_model.blender.mesh_utils import _prism_geometry
from jarvizar_city_model.blender.export_cutout import Opening, export_geometry, CutoutError
from jarvizar_city_model.blender import export_cutout as cutter
from jarvizar_city_model.data.export_3mf import MODEL, SETTINGS, NS
from jarvizar_city_model.data.export_plates import PROJECT


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


def oriented(mesh):
    """Faces with a normal. Zero-area faces get a zero normal in 3.6 and +Z in Blender 5."""
    return [f for f in mesh.polygons if f.area > 1e-9]


def within_opening(opening, part):
    """Every vertex inside the opening, allowing two float32 steps at the part's largest coordinate.

    A tilted frame puts crop corners hundreds of millimetres from the origin,
    where float32 spacing exceeds the frame's own tolerance; Blender 5 rounds
    those corners differently from 3.6.
    """
    points = [part.matrix_world @ v.co for v in part.data.vertices]
    slack = max((abs(c) for p in points for c in p), default=0) * 2 ** -22
    relaxed = Opening(opening.ring, opening.matrix_world, opening.tolerance + slack)
    return all(relaxed.contains(relaxed.inverse @ p) for p in points)


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
                    self.assertTrue(within_opening(opening, part), part.name)
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

    def test_tall_frames_sizes_and_independent_transforms(self):
        # Wall area outranks annular cap area in these frames. The opening's
        # topology must identify its axis, including after applying transforms.
        for width,height,depth in [(40,25,90),(170.5,119.5,40),(240,150,100)]:
            for angles in [(0,0,0),(0,0,37),(0,0,90),(0,0,180),(12,25,41),(90,0,0),(0,90,0)]:
                for applied in (False,True):
                    with self.subTest(size=(width,height,depth),angles=angles,applied=applied):
                        cutout=mesh_object('cutout',[rectangle(width+40,height+40),list(reversed(rectangle(width,height)))],0,depth)
                        transform=Matrix.Translation((17,-11,4)) @ Euler(tuple(math.radians(a) for a in angles)).to_matrix().to_4x4() @ Matrix.Diagonal((-1.3,0.7,1.15,1))
                        if applied:
                            cutout.data.transform(transform)
                        else:
                            cutout.matrix_world=transform
                        obj=self.source('stationary map',rectangle(1200,1200),-600,600)
                        def check(parts,stats,opening):
                            self.assertEqual(len(parts),1)
                            # Independent expected coordinates, not the detected
                            # frame basis (which is exactly what regressed).
                            points=[transform.inverted() @ parts[0].matrix_world @ v.co for v in parts[0].data.vertices]
                            for axis,size in [(0,width),(1,height)]:
                                self.assertAlmostEqual(min(p[axis] for p in points),-size/2,delta=0.001)
                                self.assertAlmostEqual(max(p[axis] for p in points),size/2,delta=0.001)
                        self.crop([obj],check)
                        bpy.data.objects.remove(cutout,do_unlink=True)
                        bpy.data.objects.remove(obj,do_unlink=True)

    def test_current_edit_mode_opening(self):
        cutout=frame(rectangle(20,10))
        bpy.context.view_layer.objects.active=cutout;cutout.select_set(True)
        bpy.ops.object.mode_set(mode='EDIT')
        try:
            bm=bmesh.from_edit_mesh(cutout.data)
            for v in bm.verts:v.co.x*=1.5
            bmesh.update_edit_mesh(cutout.data)
            opening=Opening.from_object(cutout,bpy.context.evaluated_depsgraph_get())
            self.assertAlmostEqual(max(p[0] for p in opening.ring)-min(p[0] for p in opening.ring),30,places=3)
        finally:
            bpy.ops.object.mode_set(mode='OBJECT')

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
            self.assertTrue(all(f.material_index==1 for f in oriented(parts[0].data) if f.normal.z>0.5))
            self.assertTrue(all(f.material_index==0 for f in oriented(parts[0].data) if f.normal.z< -0.5))
        self.crop([obj],check)

    def test_tangent_outside_and_on_boundary(self):
        frame(rectangle(10,10))
        tangent=self.source('tangent',rectangle(2,2,6))
        exact=self.source('exact',rectangle(10,10))
        self.crop([tangent,exact],lambda p,s,o:self.assertEqual(len(p),1))

    def test_nearby_cut_contours_remain_separate(self):
        # A connected road doubles back across the cut. Its two retained arms
        # are closer than the numerical cleanup tolerance, but must not weld.
        gap = 0.00002
        frame(rectangle(170, 100)).location.x = 85
        ring = [(-3,-2),(3,-2),(3,-gap),(-1,-gap),(-1,gap),(3,gap),(3,2),(-3,2)]
        obj = self.source('hairpin road', ring, 0, .6)
        def check(parts, stats, opening):
            self.assertAlmostEqual(audit(parts[0].data), 2*3*(2-gap)*.6, places=5)
            bm = bmesh.new()
            try:
                bm.from_mesh(parts[0].data)
                shells = list(cutter._shells(bm))
                self.assertEqual(len(shells), 2)
                for vertices, edges, faces in shells:
                    self.assertTrue(all(v.co.y >= gap*.99 for v in vertices) or
                                    all(v.co.y <= -gap*.99 for v in vertices))
            finally:
                bm.free()
        self.crop([obj], check)

    def test_draped_cut_slivers(self):
        # Small isolated closed shells captured before a failing cut; no city
        # data or saved Blender scene is needed to exercise these intersections.
        fixtures = Path(__file__).with_name('fixtures') / 'export_cut_slivers.json'
        for data in json.loads(fixtures.read_text()):
            with self.subTest(case=data['case']):
                opening = Opening(data['ring'], Matrix.Identity(4), data['tolerance'])
                mesh = bpy.data.meshes.new('sliver regression')
                mesh.from_pydata(data['vertices'], [], data['faces'])
                try:
                    stats = cutter.defaultdict(int)
                    cutter.clip_mesh(mesh, Matrix(data['transform']), opening,
                                     bpy.context.scene.collection, stats)
                    self.assertAlmostEqual(audit(mesh), data['volume'], delta=data['volume']*2e-6)
                    self.assertTrue(all(opening.contains(Matrix(data['transform']) @ v.co)
                                        for v in mesh.vertices))
                finally:
                    bpy.data.meshes.remove(mesh)

    def test_failed_scan_fill_retries_without_changing_walls_or_materials(self):
        frame(rectangle(10,10))
        obj = self.source('terrain', rectangle(20,20))
        materials = [bpy.data.materials.new('bottom'), bpy.data.materials.new('top')]
        for material in materials:
            obj.data.materials.append(material)
        for face in obj.data.polygons:
            face.material_index = int(face.normal.z > .5)
        original = cutter._scan_fill_section
        def failed_fill(bm, edges, normal):
            original(bm, edges, normal)
            raise CutoutError('scan fill left invalid triangles')
        def check(parts, stats, opening):
            self.assertAlmostEqual(audit(parts[0].data), 200, places=4)
            self.assertTrue(all(f.material_index == int(f.normal.z > .5)
                                for f in oriented(parts[0].data)))
        with patch.object(cutter, '_scan_fill_section', side_effect=failed_fill):
            self.crop([obj], check)

    def test_scan_fill_using_only_one_contour_vertex_retries(self):
        bm = bmesh.new()
        try:
            bmesh.ops.create_cube(bm, size=2)
            bm.normal_update()
            top = next(f for f in bm.faces if f.normal.z > .9)
            boundary = list(top.edges)
            anchor = top.verts[0]
            bm.faces.remove(top)
            retained = set(bm.faces)
            bottom = [v for v in bm.verts if v.co.z < 0]
            def incomplete_fill(bm, **kwargs):
                # Model a scan fill which used one contour vertex and skipped
                # its whole loop. The repair walk returns to the same BMVert.
                return {'geom': [bm.faces.new((anchor, bottom[0], bottom[1]))]}
            fake = SimpleNamespace(types=bmesh.types,
                                   ops=SimpleNamespace(triangle_fill=incomplete_fill))
            with patch.object(cutter, 'bmesh', fake):
                caps = cutter._fill_section(bm, boundary, Vector((0,0,1)))
            self.assertEqual(set(bm.faces)-retained, set(caps))
            self.assertTrue(all(e.is_manifold and e.is_contiguous for e in bm.edges))
            self.assertAlmostEqual(bm.calc_volume(signed=True), 8)
        finally:
            bm.free()

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
        obj['feature_type']='terrain'
        extra['feature_type']='buildings'
        for o,color in [(obj,(0.3,0.4,0.5,1)),(extra,(1,1,1,1))]:
            mat=bpy.data.materials.new(o.name+' material');mat.diffuse_color=color
            o.data.materials.append(mat)
        obj.select_set(True)
        bpy.context.view_layer.objects.active=obj
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
                root=ET.fromstring(archive.read(MODEL))
                config=ET.fromstring(archive.read(SETTINGS))
                project=json.loads(archive.read(PROJECT))
            self.assertEqual(config.find('object/metadata').get('value'),'Map')
            # Each part is assigned its own filament, not a colour to map on import.
            parts={p.find('metadata').get('value'):p.find("metadata[@key='extruder']").get('value')
                   for p in config.findall('object/part')}
            self.assertEqual(set(parts),{'Terrain','Buildings'})
            self.assertEqual(set(parts.values()),{'1','2'})
            self.assertEqual(len(project['filament_colour']),2)
            self.assertEqual(project['filament_colour'][int(parts['Buildings'])-1],'#FFFFFF')
            ns={'m':root.tag.split('}')[0][1:]}
            self.assertEqual(len(root.findall('m:build/m:item',ns)),1)
            self.assertEqual(len(root.findall('.//m:component',ns)),2)
            points=[(float(v.get('x')),float(v.get('y')),float(v.get('z'))) for v in root.findall('.//m:vertex',ns)]
            self.assertAlmostEqual(max(p[0] for p in points)-min(p[0] for p in points),17)
            self.assertAlmostEqual(max(p[1] for p in points)-min(p[1] for p in points),11)

    def test_filament_colour_is_the_shader_colour_else_the_viewport_colour(self):
        viewport=bpy.data.materials.new('viewport only')
        viewport.diffuse_color=(1,0,0,1)
        self.assertEqual(cutter.material_color(viewport),'#FF0000')
        shader=bpy.data.materials.new('shader')
        if bpy.app.version < (5, 0, 0):
            shader.use_nodes=True
        shader.diffuse_color=(1,0,0,1)
        shader.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(0,0,1,1)
        self.assertEqual(cutter.material_color(shader),'#0000FF')
        if bpy.app.version >= (5, 0, 0):
            # Pre-5.0 materials without nodes open with an added EEVEE output.
            tree=shader.node_tree
            output=tree.nodes.new('ShaderNodeOutputMaterial')
            output.target='EEVEE'
            principled=tree.nodes.new('ShaderNodeBsdfPrincipled')
            principled.inputs['Base Color'].default_value=(0,1,0,1)
            tree.links.new(principled.outputs['BSDF'],output.inputs['Surface'])
            self.assertEqual(cutter.material_color(shader),'#00FF00')

    def test_invalid_destination_restores_scene(self):
        frame(rectangle(10,10))
        obj=self.source('terrain',rectangle(20,20))
        obj.select_set(True);bpy.context.view_layer.objects.active=obj
        bpy.context.view_layer.update()
        before=fingerprint(obj)
        counts=(len(bpy.data.objects),len(bpy.data.meshes))
        path=Path(__file__).resolve().parents[1]/'scratchpad'/'export-cutout'/'missing-directory'/'failed.3mf'
        self.assertFalse(path.parent.exists())
        with self.assertRaises(RuntimeError):
            bpy.ops.jarvizar.export_3mf(filepath=str(path))
        self.assertEqual(before,fingerprint(obj))
        self.assertEqual(counts,(len(bpy.data.objects),len(bpy.data.meshes)))
        self.assertIs(bpy.context.view_layer.objects.active,obj)
        self.assertFalse(path.exists())

    def test_semantic_parts_and_atomic_failure(self):
        folder=Path(__file__).resolve().parents[1]/'scratchpad'/'3mf-names'
        folder.mkdir(parents=True,exist_ok=True)
        output=folder/'semantic.3mf'
        existing_staging=set(folder.glob('.jcm-3mf-*'))
        tags=[('terrain',{}),('buildings',{}),('building_part',{}),
              ('surface_road',{'road_class':'residential'}),
              ('surface_road',{'road_class':'footway'}),
              ('surface_road',{'road_class':'rail'}),
              ('bridge_deck',{'road_class':'primary'}),
              ('water_surface',{}),('trees',{}),('labels',{})]
        tags += [('land_surface',{'surface_category':s}) for s in ('green','forest','paved','sand','rock')]
        tags += [('buildings',{})]
        materials=[]
        for i,color in enumerate(((0.2,0.3,0.4,1),(1,1,1,1))):
            mat=bpy.data.materials.new(f'semantic material {i}')
            if bpy.app.version < (5, 0, 0):  # Blender 5 materials always use nodes.
                mat.use_nodes=True
            mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=color
            materials.append(mat)
        sources=[]
        for i,(kind,extra) in enumerate(tags):
            obj=self.source(f'arbitrary {len(tags)-i:03}',rectangle(2,2),0,2)
            obj['feature_type']=kind
            for key,value in extra.items():obj[key]=value
            obj.location=(i%4*4,i//4*4,i*0.1)
            obj.rotation_euler.z=i*0.02
            for mat in materials:obj.data.materials.append(mat)
            for p in obj.data.polygons:p.material_index=(p.index+i)%2
            sources.append(obj)
        bpy.context.view_layer.update()
        before=[fingerprint(o) for o in sources]
        counts=(len(bpy.data.objects),len(bpy.data.meshes))
        self.assertEqual(bpy.ops.jarvizar.export_3mf(filepath=str(output)),{'FINISHED'})
        with zipfile.ZipFile(output) as archive:
            config=ET.fromstring(archive.read(SETTINGS))
            root=ET.fromstring(archive.read(MODEL))
            project=json.loads(archive.read(PROJECT))
        expected={'Terrain','Buildings 1','Buildings 2','Building Parts','Roads (Residential)',
                  'Paths (Footway)','Railways','Bridges (Primary)','Water','Trees','Labels',
                  'Greenery','Forest','Paved','Sand','Rock'}
        self.assertEqual({p.find('metadata').get('value') for p in config.findall('object/part')},expected)
        self.assertEqual({o.get('name') for o in root.findall('m:resources/m:object',NS)},expected|{'Map'})
        # Two colours alternate across every part's faces: one filament each,
        # every part assigned one of them, its other faces painted with the other.
        self.assertEqual(len(project['filament_colour']),2)
        self.assertIn('#FFFFFF',project['filament_colour'])
        self.assertEqual({p.find("metadata[@key='extruder']").get('value') for p in config.findall('object/part')}<={'1','2'},True)
        self.assertTrue(root.findall('.//m:triangle[@paint_color]',NS))
        saved=output.read_bytes()
        with patch('jarvizar_city_model.data.export_plates.PlateWriter.close',side_effect=ValueError('injected naming failure')):
            with self.assertRaisesRegex(RuntimeError,'injected naming failure'):
                bpy.ops.jarvizar.export_3mf(filepath=str(output))
        self.assertEqual(output.read_bytes(),saved)
        self.assertFalse(set(folder.glob('.jcm-3mf-*'))-existing_staging)
        self.assertEqual([fingerprint(o) for o in sources],before)
        self.assertEqual((len(bpy.data.objects),len(bpy.data.meshes)),counts)


if __name__ == '__main__':
    addon.register()
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(CutoutTests)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful():
        raise SystemExit(1)
    print('EXPORT_CUTOUT_OK',result.testsRun)
