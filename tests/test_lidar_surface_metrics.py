import unittest

try:
    from shapely.geometry import box
    from lidar_surface_metrics import analyze
    AVAILABLE=True
except ImportError:
    AVAILABLE=False


@unittest.skipUnless(AVAILABLE,'optional LiDAR dependencies not installed')
class RoofMetricTests(unittest.TestCase):
    def roof(self,ring):
        return {'geometry':{'type':'Polygon','coordinates':[ring+[ring[0]]]}}

    def test_linear_wall_integral_and_numerical_gaps(self):
        for gap in (0.,1e-8,1e-6):
            record={'height_m':20.,'tiers':[],'roof_surfaces':[
                self.roof([[-10,0,20],[0,0,20],[0,30,23],[-10,30,23]]),
                self.roof([[gap,0,20],[10,0,20],[10,30,20],[gap,30,20]])]}
            result=analyze(record,box(-10,0,10,30))
            self.assertAlmostEqual(result['minor_step_length_m'],19.5,delta=.001)
            self.assertAlmostEqual(result['major_step_length_m'],10.,delta=.001)
            self.assertAlmostEqual(result['minor_wall_area_m2'],19.9875,delta=.001)

    def test_triangulating_a_slope_does_not_create_roof_steps(self):
        record={'height_m':20.,'tiers':[],'roof_surfaces':[
            self.roof([[0,0,20],[30,0,29],[0,24,20]]),
            self.roof([[30,0,29],[30,24,29],[0,24,20]])]}
        result=analyze(record,box(0,0,30,24))
        self.assertAlmostEqual(result['minor_step_length_m'],0.)
        self.assertAlmostEqual(result['major_step_length_m'],0.)
