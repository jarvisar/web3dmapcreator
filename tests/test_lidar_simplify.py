"""Edge collapse on a height raster: straight walls, exact flat roofs, a valid cap."""
import unittest

try:
    import numpy as np
    from jarvizar_city_model.external.lidar_simplify import MIN_GAP, collapse
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


def grid(heights, pitch=.5):
    """Triangulate a height array on its grid, diagonal between the closest corners."""
    nx, ny = heights.shape
    gx, gy = np.meshgrid(np.arange(nx)*pitch, np.arange(ny)*pitch, indexing='ij')
    index = np.arange(nx*ny).reshape(nx, ny)
    i, j = np.nonzero(np.ones((nx-1, ny-1), dtype=bool))
    a, b, c, d = index[i, j], index[i+1, j], index[i+1, j+1], index[i, j+1]
    first = np.abs(heights[i+1, j]-heights[i, j+1]) < np.abs(heights[i, j]-heights[i+1, j+1])
    faces = np.concatenate((np.where(first[:, None], np.stack((a, b, d), 1), np.stack((a, b, c), 1)),
                            np.where(first[:, None], np.stack((b, c, d), 1), np.stack((a, c, d), 1))))
    return np.column_stack((gx.ravel(), gy.ravel(), heights.ravel())), faces


def block(angle_deg, pitch=.5, size=60, top=60.):
    """A tall block turned `angle_deg` to the grid on a flat plaza."""
    n = int(size/pitch)+1
    gx, gy = np.meshgrid(np.arange(n)*pitch, np.arange(n)*pitch, indexing='ij')
    x, y = gx-size/2, gy-size/2
    angle = np.radians(angle_deg)
    u, v = x*np.cos(angle)+y*np.sin(angle), -x*np.sin(angle)+y*np.cos(angle)
    return np.where((np.abs(u) < 15) & (np.abs(v) < 10), top, 0.)


def height(vertices, faces, x, y):
    """The cap's height over one plan point."""
    for a, b, c in faces:
        (x1, y1, z1), (x2, y2, z2), (x3, y3, z3) = vertices[a], vertices[b], vertices[c]
        det = (y2-y3)*(x1-x3)+(x3-x2)*(y1-y3)
        u, v = ((y2-y3)*(x-x3)+(x3-x2)*(y-y3))/det, ((y3-y1)*(x-x3)+(x1-x3)*(y-y3))/det
        if min(u, v, 1-u-v) >= -1e-9:
            return u*z1+v*z2+(1-u-v)*z3
    raise AssertionError('point outside the cap')


def walls(vertices, faces, tall=30):
    """Azimuth changes between neighbouring wall facets, and their plan widths."""
    tri = vertices[faces]
    n = np.cross(tri[:, 1]-tri[:, 0], tri[:, 2]-tri[:, 0])
    n /= np.maximum(np.linalg.norm(n, axis=1), 1e-12)[:, None]
    steep = (np.abs(n[:, 2]) < .5) & (tri[:, :, 2].max(1)-tri[:, :, 2].min(1) > tall)
    w = tri[steep]
    width = np.array([np.hypot(*(w[:, (k+1) % 3, :2]-w[:, k, :2]).T) for k in range(3)]).max(0)
    azimuth = np.degrees(np.arctan2(n[steep, 1], n[steep, 0]))
    centre = w[:, :, :2].mean(1)
    order = np.argsort(np.arctan2(centre[:, 1]-30, centre[:, 0]-30))
    change = np.abs((np.diff(azimuth[order])+180) % 360-180)
    return change, width


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class CollapseTests(unittest.TestCase):
    def check_cap(self, vertices, faces):
        tri = vertices[faces]
        plan = ((tri[:, 1, 0]-tri[:, 0, 0])*(tri[:, 2, 1]-tri[:, 0, 1])
                - (tri[:, 1, 1]-tri[:, 0, 1])*(tri[:, 2, 0]-tri[:, 0, 0]))
        self.assertGreater(plan.min(), 0, 'every face must keep its plan orientation')
        # No face thinner than the vertex gap: that thin it is float32 noise
        # once printed, and folds when a corner is snapped to the outline.
        longest = np.array([np.hypot(*(tri[:, (k+1) % 3, :2]-tri[:, k, :2]).T) for k in range(3)]).max(0)
        self.assertGreaterEqual((plan/longest).min(), MIN_GAP*.999)
        order = np.lexsort((vertices[:, 1], vertices[:, 0]))
        xy = vertices[order, :2]
        self.assertGreaterEqual(np.hypot(*(xy[1:]-xy[:-1]).T).min(), MIN_GAP*.999)

    def test_grid_staircase_becomes_straight_facets(self):
        vertices, faces = grid(block(30))
        before, _ = walls(vertices, faces)
        self.assertGreater(np.mean(before > 20), .3, 'the raster wall really is a staircase')
        self.assertGreater(len(before), 300)
        collapsed, kept = collapse(vertices, faces, 8., 10**6)
        self.check_cap(collapsed, kept)
        change, width = walls(collapsed, kept)
        self.assertLess(len(kept), len(faces)*.05)
        # A few wide facets per side, all within a cell of the true walls.
        self.assertLess(len(change), 40)
        self.assertGreater(np.median(width), 2.)
        angle = np.radians(30)
        x, y = collapsed[:, 0]-30, collapsed[:, 1]-30
        u, v = x*np.cos(angle)+y*np.sin(angle), -x*np.sin(angle)+y*np.cos(angle)
        rim = collapsed[:, 2] > 59
        outside = np.maximum(np.abs(u[rim])-15, np.abs(v[rim])-10)
        self.assertLess(np.abs(outside).max(), .5)
        # A wall aligned with the grid is already straight and stays so.
        aligned, faces = grid(block(0))
        collapsed, kept = collapse(aligned, faces, 8., 10**6)
        change, _ = walls(collapsed, kept)
        self.assertLess(np.sort(change)[-5], 1., 'only the four corners turn')

    def test_flat_roof_stays_exact_and_features_survive(self):
        heights = block(30)
        heights[58:64, 58:64] = 63.   # a 3 m plant room on the roof
        vertices, faces = grid(heights)
        # Without a bound on how far a vertex may leave the faces it replaces,
        # the plant room is lowered corner by corner: once its top is one face,
        # a corner has one plane above and several below, and the quadric sum
        # of lowering it is small.
        eroded, _ = collapse(vertices, faces, 8., 10**6)
        self.assertFalse(np.any(np.abs(eroded[:, 2]-63.) < .1))
        collapsed, kept = collapse(vertices, faces, 8., 10**6, deviation=1.)
        self.check_cap(collapsed, kept)
        z = collapsed[:, 2]
        # Moves within a plane cost nothing, so a flat roof and its plant room
        # keep their heights; a rim corner compromising between several steep
        # faces may sit a few centimetres off.
        self.assertLess(np.abs(z[z > 1]-np.where(z[z > 1] > 61.5, 63., 60.)).max(), .1)
        self.assertTrue(np.any(np.abs(z-63.) < .1))
        # The plaza and the roof each collapse to a handful of faces.
        self.assertLess(np.sum(np.abs(collapsed[kept][:, :, 2].max(1)-60) < 1e-9), 60)

    def test_fine_vertices_keep_slender_towers(self):
        tops = (30., 38., 26.)
        for width in (4, 5):
            heights, centres = np.full((61, 41), 10.), []
            for k, top in enumerate(tops):
                start = 12+k*(width+3)
                heights[start:start+width, 18:18+width] = top
                centres.append(((start+(width-1)/2)*.5, (18+(width-1)/2)*.5))
            vertices, faces = grid(heights)

            def measured(fine):
                collapsed, kept = collapse(vertices, faces, 8., 10**6, deviation=1., fine=fine)
                self.check_cap(collapsed, kept)
                return [height(collapsed, kept, x, y) for x, y in centres]
            # A wall may wander the whole bound at every merge, and these
            # towers are only two bounds across: one of them is cut down.
            self.assertGreater(np.abs(np.subtract(measured(()), tops)).max(), 2.)
            np.testing.assert_allclose(measured(np.flatnonzero(heights.ravel() > 20)), tops, atol=.1)

    def test_budget_rim_and_determinism(self):
        vertices, faces = grid(np.zeros((21, 21)))
        # The 80 rim edges each keep a face, so the budget binds above that.
        collapsed, kept = collapse(vertices, faces, 0., 100)
        self.assertLessEqual(len(kept), 100)
        self.check_cap(collapsed, kept)
        rim = {tuple(v) for v in vertices if v[0] in (0., 10.) or v[1] in (0., 10.)}
        self.assertTrue(rim <= {tuple(v) for v in collapsed}, 'rim vertices never move')
        again = collapse(vertices, faces, 0., 100)
        np.testing.assert_array_equal(again[0], collapsed)
        np.testing.assert_array_equal(again[1], kept)
        # Under a threshold a plane collapses to its rim fan whatever the budget.
        collapsed, kept = collapse(vertices, faces, 1e-9, 10**6)
        self.assertLess(len(kept), 200)


if __name__ == '__main__':
    unittest.main()
