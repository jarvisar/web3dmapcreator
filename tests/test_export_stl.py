"""Binary STL writer, per-colour file sets and cutout frame outlines, without Blender."""
from collections import Counter
import math
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

try:
    import numpy as np
except ImportError:  # numpy ships with Blender; the pure suite reports the skip.
    np = None

from jarvizar_city_model.data.export_frame import (
    SHAPES, circle_segments, frame_geometry, offset_ring, opening_ring,
)

if np is not None:
    from jarvizar_city_model.data import export_stl
    from jarvizar_city_model.data.export_stl import (
        StlSet, StlWriter, header_bytes, previous_files, publish, shell_groups,
    )


def box(x, y, z, width, depth, height):
    """A closed, outward-wound box: (vertices, triangles)."""
    corners = [(x, y, z), (x + width, y, z), (x + width, y + depth, z), (x, y + depth, z),
               (x, y, z + height), (x + width, y, z + height),
               (x + width, y + depth, z + height), (x, y + depth, z + height)]
    triangles = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4),
                 (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    return corners, triangles


def merged(*solids):
    """Independent solids in one mesh, never welded."""
    vertices, triangles = [], []
    for points, faces in solids:
        offset = len(vertices)
        vertices.extend(points)
        triangles.extend(tuple(i + offset for i in face) for face in faces)
    return vertices, triangles


def read_stl(path):
    data = Path(path).read_bytes()
    count = struct.unpack_from('<I', data, 80)[0]
    records = np.frombuffer(data, dtype=export_stl._RECORD, count=count, offset=84)
    return data[:80], count, records, len(data)


def signed_volume(corners):
    a, b, c = corners[:, 0].astype(float), corners[:, 1].astype(float), corners[:, 2].astype(float)
    return float(np.einsum('ij,ij->i', a, np.cross(b, c)).sum() / 6)


@unittest.skipIf(np is None, 'numpy is not installed')
class StlWriterTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='jcm-stl-test-')
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)

    def test_header_layout_count_and_normals(self):
        header = header_bytes()
        self.assertEqual(len(header), 80)
        self.assertFalse(header.lower().startswith(b'solid'))
        self.assertTrue(header.startswith(b'Jarvizar City Model'))
        self.assertIn(b'OpenStreetMap contributors', header)
        for bad in ('solid city', 'x' * 81, 'café'):
            with self.assertRaises(ValueError):
                header_bytes(bad)
        path = self.folder / 'box.stl'
        vertices, triangles = box(0, 0, 0, 10, 20, 30)
        with StlWriter(path) as writer:
            writer.add(vertices, triangles[:5])
            writer.add(vertices, triangles[5:])
        head, count, records, size = read_stl(path)
        self.assertEqual(head, header)
        self.assertEqual(count, 12)
        self.assertEqual(size, 84 + 50 * 12)
        self.assertEqual(export_stl._RECORD.itemsize, 50)
        self.assertTrue((records['attribute'] == 0).all())
        np.testing.assert_allclose(records['vertices'], np.asarray(vertices)[np.asarray(triangles)])
        # Unit facet normals point out of the box.
        centre = records['vertices'].mean(axis=1) - (5, 10, 15)
        np.testing.assert_allclose(np.linalg.norm(records['normal'], axis=1), 1, atol=1e-6)
        self.assertTrue((np.einsum('ij,ij->i', records['normal'], centre) > 0).all())
        self.assertAlmostEqual(signed_volume(records['vertices']), 6000, places=3)

    def test_empty_degenerate_chunked_and_invalid(self):
        path = self.folder / 'empty.stl'
        with StlWriter(path):
            pass
        head, count, records, size = read_stl(path)
        self.assertEqual((count, len(records), size), (0, 0, 84))
        path = self.folder / 'flat.stl'
        with StlWriter(path) as writer:
            writer.add([(0, 0, 0), (1, 0, 0), (2, 0, 0)], [(0, 1, 2)])
        self.assertEqual(read_stl(path)[2]['normal'].tolist(), [[0, 0, 0]])
        # Many parts stream in chunks; the count is patched once at the end.
        path = self.folder / 'chunks.stl'
        with patch.object(export_stl, '_CHUNK', 5):
            with StlWriter(path) as writer:
                for i in range(7):
                    writer.add(*box(i * 2, 0, 0, 1, 1, 1))
        head, count, records, size = read_stl(path)
        self.assertEqual((count, size), (84, 84 + 50 * 84))
        self.assertAlmostEqual(signed_volume(records['vertices']), 7, places=4)
        vertices, triangles = box(0, 0, 0, 1, 1, 1)
        with StlWriter(self.folder / 'bad.stl') as writer:
            with self.assertRaises(ValueError):
                writer.add(vertices[:-1] + [(0, 0, float('nan'))], triangles)
            with self.assertRaises(ValueError):
                writer.add(vertices, triangles + [(0, 1, 8)])
            with patch.object(export_stl, 'MAX_TRIANGLES', 11):
                with self.assertRaises(ValueError):
                    writer.add(vertices, triangles)
        # A failure inside the context leaves the file unfinished for removal.
        with self.assertRaises(RuntimeError):
            with StlWriter(self.folder / 'aborted.stl') as writer:
                writer.add(vertices, triangles)
                raise RuntimeError('injected')
        self.assertEqual(read_stl(self.folder / 'aborted.stl')[1], 0)

    def test_shell_groups_keep_solids_whole(self):
        a, b, c = box(0, 0, 0, 1, 1, 1), box(5, 0, 0, 1, 1, 1), box(9, 0, 0, 1, 1, 1)
        vertices, triangles = merged(a, b, c)
        groups = [0] * 12 + [1] * 12 + [2] * 12
        assigned, mixed = shell_groups(triangles, groups, len(vertices))
        self.assertEqual(assigned.tolist(), groups)
        self.assertEqual(mixed, 0)
        # A solid mostly of group 2 with some faces of 0 goes whole to 2;
        # a tie keeps the lowest group.
        groups = [0] * 12 + [2] * 9 + [0] * 3 + [1] * 6 + [0] * 6
        assigned, mixed = shell_groups(triangles, groups, len(vertices))
        self.assertEqual(assigned.tolist(), [0] * 12 + [2] * 12 + [0] * 12)
        self.assertEqual(mixed, 2)
        # Shells are found through shared vertices whatever their order.
        order = np.random.default_rng(3).permutation(len(vertices))
        inverse = np.argsort(order)
        shuffled = [vertices[i] for i in order]
        remapped = [tuple(int(inverse[i]) for i in t) for t in triangles]
        assigned, _ = shell_groups(remapped, groups, len(shuffled))
        self.assertEqual(assigned.tolist(), [0] * 12 + [2] * 12 + [0] * 12)

    def stage(self, base='city', **kwargs):
        folder = Path(tempfile.mkdtemp(prefix='stage-', dir=self.folder))
        return StlSet(folder, base, **kwargs)

    def test_per_colour_files_share_one_frame(self):
        stl = self.stage()
        terrain = box(-50, -40, -3, 100, 80, 3)
        buildings = merged(box(-10, -10, 0, 5, 5, 20), box(10, 10, 0, 4, 4, 8), box(20, -5, 0, 3, 3, 3))
        roads = box(-50, -1, 0, 100, 2, 0.6)
        origin = (1.0, 2.0, -3.0)
        stl.add_part(*terrain, [0] * 12, [('#FFFFFF', 'PLA Matte')], ['Terrain'], origin=origin)
        # Merged buildings: slots of two colours, one per solid.
        stl.add_part(*buildings, [0] * 12 + [1] * 12 + [0] * 12,
                     [('#AE835B', 'PLA Matte'), '#8C6338'], ['Buildings', 'Rock'], origin=origin)
        stl.add_part(*roads, [0] * 12, ['#545454'], ['Roads'], origin=origin)
        # A second terrain-coloured part joins the first colour's file.
        stl.add_part(*box(40, 30, 0, 2, 2, 2), [0] * 12, ['#FFFFFF'], ['Terrain Supports'], origin=origin)
        files = stl.close()
        self.assertEqual(stl.palette, ['#FFFFFF', '#AE835B', '#8C6338', '#545454'])
        self.assertEqual([f.name for f in files], [
            'city_1_terrain_FFFFFF.stl', 'city_2_buildings_AE835B.stl',
            'city_3_rock_8C6338.stl', 'city_4_roads_545454.stl'])
        self.assertEqual([f.triangles for f in files], [24, 24, 12, 12])
        self.assertEqual((stl.parts, stl.triangles, stl.mixed_shells), (4, 72, 0))
        records = {f.colour: read_stl(f.path) for f in files}
        self.assertEqual({c: r[1] for c, r in records.items()}, {f.colour: f.triangles for f in files})
        # Every file in the same frame: coordinates relative to the origin.
        terrain_points = records['#FFFFFF'][2]['vertices'][:12].reshape(-1, 3)
        self.assertEqual(terrain_points.min(axis=0).tolist(), [-51, -42, 0])
        rock = records['#8C6338'][2]['vertices'].reshape(-1, 3)
        self.assertEqual(rock.min(axis=0).tolist(), [9, 8, 3])
        self.assertAlmostEqual(sum(signed_volume(r[2]['vertices']) for r in records.values()),
                               100 * 80 * 3 + 500 + 128 + 27 + 100 * 2 * 0.6 + 8, places=2)

    def test_mixed_solid_sections_combined_and_labels(self):
        stl = self.stage()
        painted = box(0, 0, 0, 10, 10, 10)
        # Two faces of another colour on one solid: kept whole in its main colour.
        stl.add_part(*painted, [0] * 10 + [1] * 2, ['#FFFFFF', '#FF0000'], ['Terrain', 'Paint'],
                     section='R1C1', origin=(5, 5, 0))
        stl.add_part(*box(0, 0, 0, 1, 1, 1), [0] * 12, ['#00AE42'], section='R1C1')
        stl.close_section('R1C1')
        stl.add_part(*box(20, 0, 0, 10, 10, 10), [0] * 12, ['#00AE42'], ['Greenery'],
                     section='R1C2', origin=(25, 5, 0))
        files = stl.close()
        self.assertEqual(stl.mixed_shells, 1)
        # Numbers follow first use across sections. Red was never written, so
        # it takes no number; an unlabelled part does not name a file.
        self.assertEqual(stl.palette, ['#FFFFFF', '#00AE42'])
        self.assertEqual([f.name for f in files], ['city_R1C1_1_terrain_FFFFFF.stl',
                                                   'city_R1C1_2_greenery_00AE42.stl',
                                                   'city_R1C2_2_greenery_00AE42.stl'])
        self.assertEqual([f.triangles for f in files], [12, 12, 12])
        for record in files:
            points = read_stl(record.path)[2]['vertices'].reshape(-1, 3)
            self.assertTrue((np.abs(points[:, :2]) <= 5 + 1e-6).all(), record.name)
        combined = self.stage('map', combined=True)
        for section in ('R1C1', 'R1C2', None):
            combined.add_part(*painted, [0] * 10 + [1] * 2, ['#FFFFFF', '#FF0000'], section=section)
        files = combined.close()
        self.assertEqual([f.name for f in files], ['map_R1C1.stl', 'map_R1C2.stl', 'map.stl'])
        self.assertEqual([f.colour for f in files], [None] * 3)
        self.assertEqual(combined.mixed_shells, 0)
        # Ten or more colours pad their numbers so names sort in order.
        many = self.stage()
        for i in range(10):
            many.add_part(*box(i, 0, 0, 1, 1, 1), [0] * 12, [f'#0000{i:02X}'], [f'Layer {i}'])
        names = [f.name for f in many.close()]
        self.assertEqual(names[0], 'city_01_layer-0_000000.stl')
        self.assertEqual(names, sorted(names))

    def test_rejects_invalid_parts(self):
        vertices, triangles = box(0, 0, 0, 1, 1, 1)
        stl = self.stage()
        for args in [(vertices, triangles, [0] * 11, ['#FFFFFF']),
                     (vertices, triangles, [0] * 11 + [1], ['#FFFFFF']),
                     (vertices, triangles, [0] * 12, ['#fff']),
                     (vertices, triangles, [0] * 12, []),
                     (vertices[:-1] + [(0, float('inf'), 0)], triangles, [0] * 12, ['#FFFFFF'])]:
            with self.assertRaises(ValueError):
                stl.add_part(*args)
        stl.add_part(vertices, [], [], ['#FFFFFF'])
        self.assertEqual((stl.parts, stl.close()), (0, []))
        for base in ('', ' city', 'a/b', 'a:b'):
            with self.assertRaises(ValueError):
                StlSet(self.folder, base)

    def test_publish_replaces_the_previous_set_and_rolls_back(self):
        destination = self.folder / 'out'
        destination.mkdir()
        stl = self.stage()
        stl.add_part(*box(0, 0, 0, 1, 1, 1), [0] * 12, ['#FFFFFF'], ['Terrain'])
        stl.add_part(*box(0, 0, 0, 1, 1, 1), [0] * 12, ['#545454'], ['Roads'])
        files = stl.close()
        # An earlier export of this name, a user file of a matching name, and
        # another export's file.
        (destination / 'city_1_terrain_FFFFFF.stl').write_bytes(header_bytes() + b'old')
        (destination / 'city_R2C1_3_trees_0F2E14.stl').write_bytes(header_bytes() + b'old')
        (destination / 'city.stl').write_bytes(header_bytes() + b'old combined')
        (destination / 'city_1_mine_123456.stl').write_bytes(b'solid mine')
        (destination / 'other_1_terrain_FFFFFF.stl').write_bytes(header_bytes())
        self.assertEqual({p.name for p in previous_files(destination, 'city')},
                         {'city_1_terrain_FFFFFF.stl', 'city_R2C1_3_trees_0F2E14.stl', 'city.stl'})
        before = {p.name: p.read_bytes() for p in destination.iterdir()}
        staged = {f.path: f.path.read_bytes() for f in files}
        # A failing move restores every file and leaves nothing behind.
        real = export_stl.os.replace
        calls = []

        def failing(source, target):
            calls.append(target)
            if len(calls) == 5:
                raise PermissionError('injected: file in use')
            return real(source, target)

        with patch.object(export_stl.os, 'replace', failing):
            with self.assertRaises(PermissionError):
                publish(files, destination, 'city')
        self.assertEqual({p.name: p.read_bytes() for p in destination.iterdir()}, before)
        self.assertEqual({f.path: f.path.read_bytes() for f in files}, staged)
        removed = publish(files, destination, 'city')
        self.assertEqual(removed, 2)
        self.assertEqual(sorted(p.name for p in destination.iterdir()), sorted([
            'city_1_terrain_FFFFFF.stl', 'city_2_roads_545454.stl',
            'city_1_mine_123456.stl', 'other_1_terrain_FFFFFF.stl']))
        self.assertEqual(read_stl(destination / 'city_1_terrain_FFFFFF.stl')[1], 12)
        self.assertEqual((destination / 'city_1_mine_123456.stl').read_bytes(), b'solid mine')


class FrameOutlineTests(unittest.TestCase):
    def test_shapes_fit_their_box_counter_clockwise_and_convex(self):
        for shape in SHAPES:
            for width, height in [(216, 216), (300, 120), (80, 190)]:
                with self.subTest(shape=shape, size=(width, height)):
                    ring = opening_ring(shape, width, height, 12)
                    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
                    self.assertLessEqual(max(xs) - min(xs), width + 1e-9)
                    self.assertLessEqual(max(ys) - min(ys), height + 1e-9)
                    # Centred: a regular or symmetric outline spans +-half each way.
                    self.assertAlmostEqual(max(xs) + min(xs), 0, places=9)
                    self.assertAlmostEqual(max(ys) + min(ys), 0, places=9)
                    self.assertTrue(math.isclose(max(xs) - min(xs), width) or
                                    math.isclose(max(ys) - min(ys), height))
                    for a, b, c in zip(ring, ring[1:] + ring[:1], ring[2:] + ring[:2]):
                        cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
                        self.assertGreater(cross, 0)
                        self.assertGreater(math.dist(a, b), 1e-6)

    def test_curves_hexagon_and_rounded_corners(self):
        ring = opening_ring('CIRCLE', 200, 150)
        self.assertEqual(len(ring) % 4, 0)
        self.assertLessEqual(75 * (1 - math.cos(math.pi / len(ring))), 0.1)
        self.assertEqual(circle_segments(1e-3), 32)
        self.assertEqual(circle_segments(1e6), 192)
        hexagon = opening_ring('HEXAGON', 200, 150)
        top = [p for p in hexagon if p[1] > 1e-9]
        self.assertEqual(len(top), 2)
        self.assertAlmostEqual(top[0][1], top[1][1])
        self.assertAlmostEqual(max(p[1] for p in hexagon) * 2, 150)
        # Fully rounded short sides meet at one point rather than twice.
        stadium = opening_ring('ROUNDED', 100, 40, 50)
        self.assertEqual(len(stadium), len({(round(x, 9), round(y, 9)) for x, y in stadium}))
        self.assertAlmostEqual(max(p[1] for p in stadium), 20)
        self.assertEqual(len(opening_ring('ROUNDED', 100, 40, 0)), 4)
        for bad in [('RECTANGLE', 0, 10), ('CIRCLE', 10, float('nan')), ('STAR', 10, 10)]:
            with self.assertRaises(ValueError):
                opening_ring(*bad)

    def test_frame_is_a_closed_outward_ring(self):
        for shape in SHAPES:
            with self.subTest(shape=shape):
                ring = opening_ring(shape, 120, 90, 15)
                outer = offset_ring(ring, 6)
                # Every outer edge lies 6 mm outside its inner edge.
                for (a, b), (c, _) in zip(zip(ring, ring[1:] + ring[:1]), zip(outer, outer[1:] + outer[:1])):
                    nx, ny = b[1] - a[1], a[0] - b[0]
                    length = math.hypot(nx, ny)
                    self.assertAlmostEqual(((c[0] - a[0]) * nx + (c[1] - a[1]) * ny) / length, 6, places=9)
                vertices, faces = frame_geometry(ring, 6, 2)
                edges = Counter((f[i], f[(i + 1) % len(f)]) for f in faces for i in range(len(f)))
                self.assertTrue(all(count == 1 and edges[(b, a)] == 1 for (a, b), count in edges.items()))
                volume = 0.0
                for face in faces:
                    a = vertices[face[0]]
                    for b, c in zip((vertices[i] for i in face[1:-1]), (vertices[i] for i in face[2:])):
                        volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2])
                                   + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6
                area = lambda r: sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(r, r[1:] + r[:1])) / 2
                self.assertAlmostEqual(volume, 2 * (area(outer) - area(ring)), places=6)
        with self.assertRaises(ValueError):
            frame_geometry(opening_ring('RECTANGLE', 10, 10), 0, 2)


if __name__ == '__main__':
    unittest.main()
