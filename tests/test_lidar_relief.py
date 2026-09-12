"""Nonplanar ground alignment and explicitly mapped rock remain evidence-based."""
import copy
import importlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

try:
    import numpy as np
    from shapely.geometry import box, mapping, MultiPolygon
    from jarvizar_city_model.external.lidar_ground import ground_anchor
    from jarvizar_city_model.external.lidar_measurements import PointIndex, measure_building, ground_reference, measure_features
    from jarvizar_city_model.external.lidar_rock import rock_features, measure_rock_surface
    from jarvizar_city_model.external.lidar_ranking import AcquisitionPlan
    from jarvizar_city_model.external.lidar_records import validate_records
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class ReliefTests(unittest.TestCase):
    def cloud(self, kind='building', datum=100):
        rows = []
        for x in np.arange(-24.75, 45, .5):
            for y in np.arange(-24.75, 45, .5):
                inside = 0 < x < 20 and 0 < y < 20
                z = datum + 4*np.sin(x/8) + .12*y
                cls = 2
                if inside:
                    z = datum+25 if kind == 'building' else datum+10+8*np.sin(x/7)*np.sin(y/7)
                    cls = 6 if kind == 'building' else 2
                rows.append((x, y, z, cls, 1, 2023, 1))
        return np.array(rows)

    def test_nonplanar_ground_keeps_explicit_anchor_and_same_survey_height_differences(self):
        footprint = box(0, 0, 20, 20)
        records = []
        for datum in (100, 1700):
            points = self.cloud(datum=datum)
            self.assertIsNone(ground_reference(footprint, PointIndex(points)))
            record, reason = measure_building(footprint, PointIndex(points), 1.4, .65,
                                              roof_mode='FACETED')
            self.assertEqual(reason, 'faceted_roof')
            self.assertEqual(record['ground_reference'], 'surrounding_ground_anchor')
            elevations = [v[2]+record['ground_m'] for s in record['roof_surfaces'] for ring in s['geometry']['coordinates'] for v in ring]
            self.assertAlmostEqual(min(elevations), datum+25, places=3)
            self.assertAlmostEqual(max(elevations), datum+25, places=3)
            records.append(record)
        np.testing.assert_allclose(records[0]['ground_anchor'], records[1]['ground_anchor'])
        self.assertAlmostEqual(records[0]['height_m'], records[1]['height_m'], places=4)

    def test_planar_ground_keeps_existing_reference_and_one_sided_ground_stays_rejected(self):
        points = self.cloud()
        points[points[:, 3] == 2, 2] = 100
        record, _ = measure_building(box(0,0,20,20), PointIndex(points), 1.4, .65, roof_mode='FACETED')
        self.assertNotIn('ground_anchor', record)
        self.assertAlmostEqual(record['height_m'], 25, places=4)
        one_side = points[(points[:, 3] != 2) | (points[:, 0] < -5)]
        self.assertIsNone(ground_anchor(box(0,0,20,20), PointIndex(one_side)))
        self.assertEqual(measure_building(box(0,0,20,20), PointIndex(one_side),1.4,.65)[1], 'insufficient_ground')

    def test_ground_class_rock_is_relief_and_vegetation_cannot_lift_it(self):
        points = self.cloud('rock')
        footprint = box(0,0,20,20)
        record, reason = measure_rock_surface(footprint, PointIndex(points))
        self.assertEqual(reason, 'faceted_roof')
        canopy = points[(points[:,0]>0)&(points[:,0]<20)&(points[:,1]>0)&(points[:,1]<20)].copy()
        canopy[:,2] += 80; canopy[:,3] = 5
        with_canopy, _ = measure_rock_surface(footprint, PointIndex(np.concatenate((points, canopy))))
        self.assertEqual(record, with_canopy)
        absent = points.copy()
        inside = (absent[:,0]>0)&(absent[:,0]<20)&(absent[:,1]>0)&(absent[:,1]<20)
        absent[inside,3] = 5
        self.assertIsNone(measure_rock_surface(footprint, PointIndex(absent))[0])

    def test_rock_domains_use_only_valid_mapped_polygons_merge_overlap_and_keep_holes(self):
        shapes = [box(0,0,10,10).difference(box(3,3,5,5)), box(9,0,20,10)]
        features = [{'id':str(i),'properties':{'class':'bare_rock'},'geometry':mapping(g)} for i,g in enumerate(shapes)]
        features += [{'id':'park','properties':{'class':'theme_park'},'geometry':mapping(box(-5,-5,25,25))},
                     {'id':'peak','properties':{'class':'bare_rock'},'geometry':{'type':'Point','coordinates':[4,4]}}]
        result = rock_features(features)
        self.assertEqual(len(result), 1)
        self.assertEqual(len(result[0]['geometry']['coordinates']), 2)
        self.assertEqual(result, rock_features(list(reversed(features))))
        self.assertEqual(result[0]['properties']['source_land_ids'], ['0','1'])

    def test_rock_publication_converts_anchor_and_validates_its_geometry(self):
        feature = {'id':'rock:one','properties':{'lidar_surface_kind':'rock','source_land_ids':['mapped']},
                   'geometry':mapping(box(0,0,.02,.02))}
        records, _, rejected = measure_features([feature], self.cloud('rock'), lambda x,y:(np.asarray(x)*1000,np.asarray(y)*1000),
            lambda x,y:(x/1000,y/1000),1.4,.65,box(-30,-30,50,50),prefer_lidar=True)
        self.assertFalse(rejected)
        validate_records(records)
        self.assertLess(abs(records['rock:one']['ground_anchor'][0]), .03)
        invalid = copy.deepcopy(records)
        invalid['rock:one']['ground_anchor'][0] = 181
        with self.assertRaisesRegex(ValueError, 'anchor'):
            validate_records(invalid)

    def test_rock_cannot_fill_an_unobserved_component_from_an_adjacent_cell(self):
        footprint = MultiPolygon([box(0,0,20,20),box(20.1,0,20.2,20)])
        points = self.cloud('rock')
        missing = (points[:,0]>20)&(points[:,0]<20.3)&(points[:,1]>0)&(points[:,1]<20)
        points = points[~missing]
        self.assertEqual(measure_rock_surface(footprint,PointIndex(points))[1], 'footprint_roof_mismatch')

    def test_automatic_gaps_are_finite_and_preserve_independent_rejections(self):
        ept={'url':'https://example.com/ept/ept.json','name':'stream','format':'EPT','coverage':box(0,0,1,1)}
        laz={'url':'https://example.com/laz/','name':'other epoch','format':'LAZ','coverage':box(0,0,1,1)}
        features=[{'id':str(i)} for i in range(4)]
        geometries={f['id']:box(.1,.1,.2,.2) for f in features}
        plan=AcquisitionPlan([ept,laz],features,geometries)
        plan.next(set(),source_format='STREAM')
        reasons={'1':'footprint_roof_mismatch','2':'insufficient_ground','3':'invalid_or_small_footprint'}
        plan.observe(ept,features,{'0':{}},reasons)
        work=plan.next({'0'},source_format='STAGED')
        self.assertEqual({f['id'] for f in work[1]}, {'1','2'})
        self.assertTrue(plan.admission('0',laz,shared_tiles=True)[0])
        self.assertFalse(plan.admission('3',laz,shared_tiles=True)[0])
        self.assertIsNone(plan.next({'0'},source_format='STAGED'))

    def test_land_choice_enters_public_request_identity_without_manual_survey(self):
        from jarvizar_city_model.data.cache import Bounds, CacheBundle
        from jarvizar_city_model.data.lidar import request_signature
        with tempfile.TemporaryDirectory() as temp:
            bundle=CacheBundle(Path(temp),Bounds(-1,-1,1,1));bundle.ensure_directory()
            for name in ('building','building_part','land'):
                bundle.data_path(name).write_text('{"features": []}')
            default=request_signature(bundle,.07,.077)
            rock=request_signature(bundle,.07,.077,rock_surfaces=True)
            self.assertNotEqual(default,rock)
            self.assertIn('land',rock['footprint_sha256'])
            self.assertNotIn('comparison_url',default)

    def test_worker_publishes_signed_mapped_rock_and_complete_contained_buildings(self):
        from pyproj import CRS, Transformer
        from shapely.ops import transform
        from jarvizar_city_model.data.cache import Bounds, CacheBundle
        from jarvizar_city_model.data.lidar import request_signature, load_measurements
        metric=CRS.from_proj4('+proj=aeqd +lat_0=0 +lon_0=0 +datum=WGS84 +units=m')
        to_geo=Transformer.from_crs(metric,4326,always_xy=True).transform
        points=self.cloud('rock');points[:,0],points[:,1]=to_geo(points[:,0],points[:,1])
        external=str(Path(__file__).resolve().parents[1]/'jarvizar_city_model/external')
        with tempfile.TemporaryDirectory() as temp, patch.object(sys,'path',[external]+sys.path):
            worker=importlib.import_module('download_lidar')
            acquisition=importlib.import_module('lidar_acquisition')
            bundle=CacheBundle(Path(temp),Bounds(-.001,-.001,.001,.001));bundle.ensure_directory()
            rock={'id':'mapped','properties':{'class':'bare_rock'},'geometry':mapping(transform(to_geo,box(0,0,20,20)))}
            building={'id':'contained','properties':{},'geometry':mapping(transform(to_geo,box(5,5,10,10)))}
            for name,features in [('building',[building]),('building_part',[]),('land',[rock])]:
                bundle.data_path(name).write_text(json.dumps({'features':features}))
            request=request_signature(bundle,.07,.077,rock_surfaces=True)
            source={'url':'https://example.com/ept/ept.json','name':'measured relief','format':'EPT','coverage':box(-1,-1,1,1)}
            with patch.object(acquisition,'discover_sources',return_value=([source],[])), \
                 patch.object(acquisition,'read_source',side_effect=lambda *a:(points.copy(),{'url':source['url'],'points':len(points),'nodes':1})):
                worker.prepare(bundle.path,request)
            records,status=load_measurements(bundle,request)
            rocks=[r for r in records.values() if r.get('surface_kind')=='rock']
            self.assertEqual(len(rocks),1,status)
            self.assertEqual(rocks[0]['covered_buildings'],['contained'])
            self.assertEqual(rocks[0]['capture_year'],2023)
