"""Optional external tests: run with .venv-overture after requirements-lidar."""
import unittest

try:
    import numpy as np
    from shapely.geometry import box, shape
    from jarvizar_city_model.external.lidar_measurements import PointIndex, measure_building
    from jarvizar_city_model.external.lidar_ept import collect_nodes, node_intersects, BudgetExceeded
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, "optional LiDAR dependencies not installed")
class MeasurementsTests(unittest.TestCase):
    def cloud(self, roof, class_id=6, ground=200):
        rows = []
        for x in np.arange(-20.5, 81, 1):
            for y in np.arange(-20.5, 81, 1):
                if 0 < x < 60 and 0 < y < 60:
                    rows.append((x, y, ground + roof(x,y), class_id, 1))
                else:
                    rows.append((x, y, ground, 2, 1))
        return np.array(rows)

    def test_three_tiers_inside_clean_footprint_and_datum_cancels(self):
        def roof(x,y):
            if 20 < x < 40 and 20 < y < 40: return 90
            if 10 < x < 50 and 10 < y < 50: return 60
            return 30
        for datum in (200, 1700):
            result, reason = measure_building(box(0,0,60,60), PointIndex(self.cloud(roof,ground=datum)), 6, 3)
            self.assertEqual(reason, "tiers")
            self.assertAlmostEqual(result["height_m"], 30)
            self.assertEqual([round(t["top_m"]) for t in result["tiers"]], [60,90])
            support = box(0,0,60,60)
            lower = 30
            for tier in result["tiers"]:
                geometry = shape(tier["geometry"])
                self.assertTrue(support.covers(geometry))
                self.assertAlmostEqual(tier["bottom_m"], lower)
                support, lower = geometry, tier["top_m"]

    def test_rooftop_noise_and_thin_spire_are_not_tiers(self):
        cloud = self.cloud(lambda x,y: 100 if 28<x<31 and 28<y<31 else 30)
        result, _ = measure_building(box(0,0,60,60), PointIndex(cloud), 6, 3)
        self.assertAlmostEqual(result["height_m"], 30)
        self.assertFalse(result["tiers"])

    def test_sloped_roof_does_not_become_fake_staircase(self):
        result, reason = measure_building(box(0,0,60,60), PointIndex(self.cloud(lambda x,y: 30+x*.3)), 6, 3)
        self.assertEqual(reason, "roof_planes")
        self.assertFalse(result["tiers"])
        self.assertEqual(len(result['roof_surfaces']), 1)
        for x,y,z in result['roof_surfaces'][0]['geometry']['coordinates'][0]:
            self.assertAlmostEqual(z, 30+x*.3, places=5)

    def test_gable_hip_and_rotated_roofs_keep_measured_planes(self):
        from shapely.affinity import rotate
        for roof, expected in ((lambda x,y: 45-abs(x-30)*.5, 2),
                               (lambda x,y: 45-max(abs(x-30),abs(y-30))*.5, 4)):
            points = self.cloud(roof, class_id=1)
            angle = .37
            rotation = np.array([[np.cos(angle), -np.sin(angle)],[np.sin(angle),np.cos(angle)]])
            points[:, :2] = points[:, :2] @ rotation.T
            footprint = rotate(box(0,0,60,60), angle, origin=(0,0), use_radians=True)
            result, reason = measure_building(footprint, PointIndex(points), 6, 3)
            self.assertEqual(reason, 'roof_planes')
            self.assertEqual(len(result['roof_surfaces']), expected)
            from shapely.ops import unary_union
            outlines = [shape(p['geometry']) for p in result['roof_surfaces']]
            self.assertLess(unary_union(outlines).symmetric_difference(footprint).area, 1e-5)
            self.assertAlmostEqual(result['height_m'], 30, delta=.2)
            self.assertAlmostEqual(max(v[2] for s in result['roof_surfaces'] for r in s['geometry']['coordinates'] for v in r), 45, delta=.2)

    def test_planes_disabled_and_irregular_surface_do_not_invent_roofs(self):
        result, reason = measure_building(box(0,0,60,60), PointIndex(self.cloud(lambda x,y:30+x*.3)), 6, 3, roof_planes=False)
        self.assertEqual(reason, 'height_only')
        self.assertNotIn('roof_surfaces', result)
        points = self.cloud(lambda x,y:30+8*np.sin(x*.3)+8*np.cos(y*.3), class_id=1)
        result, _ = measure_building(box(0,0,60,60), PointIndex(points), 6, 3)
        self.assertFalse(result and result.get('roof_surfaces'))

    def test_part_boundary_only_used_when_it_agrees_with_measured_tier(self):
        points = self.cloud(lambda x,y:60 if 10<x<50 and 10<y<50 else 30)
        part = box(10,10,50,50)
        result, _ = measure_building(box(0,0,60,60), PointIndex(points), 6, 3, part_footprints=[part])
        self.assertEqual(result.get('part_boundaries_used'), 1)
        self.assertLess(shape(result['tiers'][0]['geometry']).symmetric_difference(part).area, 1e-5)

    def test_rejected_upper_mass_never_becomes_podium_only(self):
        # A long thin, tall upper region has enough area to enter the level
        # detector but cannot survive the physical width test.
        result, reason = measure_building(box(0,0,60,60), PointIndex(self.cloud(
            lambda x,y: 190 if 26<x<30 else 19)), 8.6, 3)
        self.assertIsNone(result)
        self.assertEqual(reason, 'unprintable_major_tier')

    def test_old_survey_low_roof_conflict_keeps_source_building(self):
        from jarvizar_city_model.external.lidar_measurements import measure_features
        from shapely.geometry import mapping
        feature = {'id':'tower', 'properties':{'height':190}, 'geometry':mapping(box(0,0,60,60))}
        records, counts, _ = measure_features([feature], self.cloud(lambda x,y:19),
            lambda x,y:(x,y), lambda x,y:(x,y), 6,3,box(-100,-100,100,100))
        self.assertFalse(records)
        self.assertEqual(counts, {'source_height_conflict':1})

    def test_new_tall_lidar_building_does_not_morph_old_short_source(self):
        from jarvizar_city_model.external.lidar_measurements import measure_features
        from shapely.geometry import mapping
        feature={'id':'tower','properties':{'height':19},'geometry':mapping(box(0,0,60,60))}
        records,counts,_=measure_features([feature],self.cloud(lambda x,y:190),
            lambda x,y:(x,y),lambda x,y:(x,y),6,3,box(-100,-100,100,100))
        self.assertFalse(records);self.assertEqual(counts,{'source_height_conflict':1})

    def test_podium_height_does_not_constrain_heightless_tower_part(self):
        from jarvizar_city_model.external.lidar_measurements import measure_features
        from shapely.geometry import mapping
        from test_lidar_source import estimated
        footprint=box(0,0,60,60)
        feature={'id':'tower','properties':estimated(22.5,has_parts=True),'geometry':mapping(footprint)}
        podium=({'id':'podium','properties':{'height':30}},box(0,0,20,60))
        tower=({'id':'shaft','properties':{}},box(20,0,60,60))
        cloud=self.cloud(lambda x,y:30 if x<20 else 207)
        cloud=np.concatenate([cloud+np.array([dx,dy,0,0,0]) for dx,dy in ((0,0),(.2,0),(0,.2),(.2,.2))])
        records,_,rejected=measure_features([feature],cloud,
            lambda x,y:(x,y),lambda x,y:(x,y),6,3,box(-100,-100,100,100),
            parts_by_parent={'tower':[podium[1],tower[1]]},source_parts_by_parent={'tower':[podium,tower]})
        self.assertFalse(rejected)
        self.assertEqual(records['tower']['height_decision'],'corrected_estimated_height')
        self.assertAlmostEqual(records['tower']['tiers'][-1]['top_m'],207)
        tower[0]['properties']['height']=20
        records,_,rejected=measure_features([feature],cloud,
            lambda x,y:(x,y),lambda x,y:(x,y),6,3,box(-100,-100,100,100),
            source_parts_by_parent={'tower':[podium,tower]})
        self.assertFalse(records)
        self.assertEqual(rejected['tower'],'source_height_conflict')

    def test_incomplete_assembly_restores_only_missing_footprint_and_measures_parts(self):
        from jarvizar_city_model.external.lidar_measurements import measure_features
        from shapely.geometry import mapping
        footprint=box(0,0,60,60)
        feature={'id':'mart','properties':{'has_parts':True,'num_floors':18},'geometry':mapping(footprint)}
        roof=box(20,20,40,40)
        part={'id':'crown','properties':{'building_id':'mart','num_floors':20,'roof_shape':'pyramidal'},'geometry':mapping(roof)}
        records,_,_=measure_features([feature],self.cloud(lambda x,y:90 if 20<x<40 and 20<y<40 else 76),
            lambda x,y:(x,y),lambda x,y:(x,y),6,3,box(-100,-100,100,100),
            parts_by_parent={'mart':[roof]},source_parts_by_parent={'mart':[(part,roof)]})
        result=records['mart']
        self.assertEqual(result['method'],'source_parts')
        self.assertAlmostEqual(result['part_heights']['crown'],90)
        self.assertAlmostEqual(result['height_m'],76)
        infill=shape(result['infill_geometry'])
        self.assertLess(infill.intersection(roof).area,1e-5)
        self.assertLess(infill.union(roof).symmetric_difference(footprint).area,1e-5)
        self.assertNotIn('height',part['properties'])

    def test_retained_podium_with_heightless_detail_can_prepare_lidar(self):
        from jarvizar_city_model.external.lidar_measurements import measure_features
        from jarvizar_city_model.external.lidar_selection import top_height
        from jarvizar_city_model.geometry.buildings import select_building_geometry
        from shapely.geometry import mapping
        import json
        footprint = box(0, 0, 60, 60)
        parent = {'id': 'parent', 'properties': {'height': 10, 'num_floors': 2,
                  'has_parts': True}, 'geometry': mapping(footprint)}
        parts = [({'id': identifier, 'properties': {'building_id': 'parent', **props},
                   'geometry': mapping(geometry)}, geometry)
                 for identifier, geometry, props in (
                     ('west', box(0, 0, 20, 60), {'height': 90}),
                     ('east', box(40, 0, 60, 60), {'height': 70}),
                     ('detail', box(25, 20, 35, 40), {}))]
        # Selection consumes decoded GeoJSON lists, not Shapely's tuples.
        source_parent, source_parts = json.loads(json.dumps([parent, [p for p, _ in parts]]))
        self.assertEqual(select_building_geometry([source_parent], source_parts).buildings,
                         (source_parent,))
        cloud = self.cloud(lambda x, y: 90 if x < 20 else 70 if x > 40 else
                           16 if 25 < x < 35 and 20 < y < 40 else 10)
        cloud = np.concatenate([cloud + np.array([dx, dy, 0, 0, 0])
                                for dx, dy in ((0, 0), (.2, 0), (0, .2), (.2, .2))])
        for mode in ('TERRACES', 'FACETED'):
            with self.subTest(mode=mode):
                records, _, rejected = measure_features([parent], cloud,
                    lambda x, y: (x, y), lambda x, y: (x, y), 6, 3,
                    box(-100, -100, 100, 100),
                    parts_by_parent={'parent': [g for _, g in parts]},
                    source_parts_by_parent={'parent': parts},
                    prefer_lidar=True, roof_mode=mode)
                self.assertFalse(rejected)
                self.assertAlmostEqual(top_height(records['parent']), 90, delta=.5)
                self.assertEqual(records['parent']['height_decision'], 'lidar_preferred')
                self.assertEqual(records['parent']['method'],
                                 'faceted_roof' if mode == 'FACETED' else 'flat_regions')
        self.assertNotIn('height', parts[-1][0]['properties'])

    def test_tower_above_full_footprint_podium_uses_exposed_source_roofs(self):
        from jarvizar_city_model.external.lidar_source import check_source
        from shapely.geometry import mapping
        footprint=box(0,0,60,60)
        upper=box(10,10,50,50)
        record={'height_m':30,'tiers':[{'bottom_m':30,'top_m':207,'geometry':mapping(upper)}]}
        parts=[({'properties':{'height':30}},footprint),({'properties':{'height':207}},upper)]
        from test_lidar_source import estimated
        self.assertEqual(check_source({'properties':estimated(22.5)},parts,record,footprint), 'corrected_estimated_height')
        parts[1][0]['properties']['height']=20
        self.assertEqual(check_source({'properties':estimated(22.5)},parts,record,footprint), 'source_height_conflict')

    def test_complex_height_cannot_flatten_a_large_hidden_upper_roof(self):
        points=self.cloud(lambda x,y:190 if 26<x<30 else 19)
        result,reason=measure_building(box(0,0,60,60),PointIndex(points),8.6,3,allow_complex_height=True)
        self.assertIsNone(result)
        self.assertEqual(reason,'unprintable_major_tier')

    def test_observed_demolition_and_partial_replacement_fall_back(self):
        for removed in (lambda x:True,lambda x:x>40):
            points=self.cloud(lambda x,y:30)
            for row in points:
                if row[3]==6 and removed(row[0]):row[2:4]=[200,2]
            result,reason=measure_building(box(0,0,60,60),PointIndex(points),6,3)
            self.assertIsNone(result);self.assertEqual(reason,'observed_ground_in_footprint')

    def test_missing_roof_does_not_fill_entire_footprint(self):
        points=self.cloud(lambda x,y:30)
        points=points[~((points[:,3]==6)&(points[:,0]>45))]
        result,reason=measure_building(box(0,0,60,60),PointIndex(points),6,3)
        self.assertIsNone(result);self.assertEqual(reason,'footprint_roof_mismatch')

    def test_partial_boundary_cells_use_supported_footprint_area(self):
        from shapely.affinity import rotate, translate
        # A densely observed flat roof with narrow unsampled edges. Partial
        # boundary cells outnumber their actual share of this small footprint.
        points = np.array([(x,y,30,6,1) for x in np.arange(.65,8.9,.3)
                           for y in np.arange(.65,8.9,.3)])
        for angle in (0, .37):
            rotation = np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]])
            moved = points.copy()
            moved[:,:2] = moved[:,:2] @ rotation.T + [103.2,-27.4]
            footprint = translate(rotate(box(0,0,9.5,9.5), angle, origin=(0,0), use_radians=True), 103.2,-27.4)
            result, reason = measure_building(footprint, PointIndex(moved), 1.43, .65, ground_m=0)
            self.assertIsNotNone(result, reason)
            self.assertAlmostEqual(result['height_m'], 30)
            self.assertEqual(result['coverage_basis'], 'footprint_area')
            self.assertGreaterEqual(result['coverage'], .85)
            self.assertFalse(result['tiers'])
        # Removing substantial interior roof evidence still cannot pass.
        points = points[points[:,0] < 6.5]
        result, reason = measure_building(box(0,0,9.5,9.5), PointIndex(points), 1.43, .65, ground_m=0)
        self.assertIsNone(result)
        self.assertIn(reason, ('footprint_roof_mismatch', 'sparse_or_noisy_roof'))

    def test_area_recovery_requires_every_footprint_component(self):
        from shapely.geometry import MultiPolygon
        points = np.array([(x,y,30,6,1) for x in np.arange(.65,8.9,.3)
                           for y in np.arange(.65,8.9,.3)])
        # The unobserved small component is only ~9% of the total footprint.
        footprint = MultiPolygon([box(0,0,9.5,9.5), box(12,0,15,3)])
        result, reason = measure_building(footprint, PointIndex(points), 1.43, .65, ground_m=0)
        self.assertIsNone(result)
        self.assertEqual(reason, 'footprint_roof_mismatch')

    def test_ground_boundary_slivers_are_not_whole_empty_squares(self):
        from jarvizar_city_model.external.lidar_measurements import observed_empty_area
        footprint = box(1.4,1.4,31.6,31.6)
        points = np.array([(x,y,0,2,1) for edge in (2.95,30.05)
                           for pos in np.arange(3.3,30,.8)
                           for x,y in ((edge,pos),(pos,edge))])
        self.assertFalse(observed_empty_area(footprint, points, 0))
        # Broad interior ground is still positive evidence of absence.
        ground = np.array([(x,y,0,2,1) for x in np.arange(9.2,24,.8)
                           for y in np.arange(9.2,24,.8)])
        self.assertTrue(observed_empty_area(footprint, ground, 0))

    def test_outside_roof_boundary_slivers_do_not_imply_a_broad_extension(self):
        points = self.cloud(lambda x,y:30)
        outside = np.array([(x,y,230,6,1) for edge in (-2.2,62.2)
                            for pos in np.arange(.2,60,1)
                            for x,y in ((edge,pos),(pos,edge))])
        result, reason = measure_building(box(0,0,60,60), PointIndex(np.concatenate((points,outside))), 6,3)
        self.assertIsNotNone(result, reason)
        self.assertAlmostEqual(result['height_m'],30)
        self.assertFalse(result['tiers'])

    def test_expanded_roof_rejected_but_mapped_neighbor_is_allowed(self):
        points=self.cloud(lambda x,y:30)
        # Two full sides exceed both area thresholds after excluding the 2 m
        # registration margin. One side is only 240 m2, below the 288 m2 gate;
        # full-cell overcounting previously misrepresented it as 360 m2.
        mask=(((points[:,0]>60)&(points[:,0]<66)&(points[:,1]>0)&(points[:,1]<60)) |
              ((points[:,1]>60)&(points[:,1]<66)&(points[:,0]>0)&(points[:,0]<60)))
        points[mask,2:4]=[230,6]
        result,reason=measure_building(box(0,0,60,60),PointIndex(points),6,3)
        self.assertIsNone(result);self.assertEqual(reason,'roof_extends_outside_footprint')
        result,_=measure_building(box(0,0,60,60),PointIndex(points),6,3,
                                  neighboring_footprints=[box(60,0,70,60),box(0,60,60,70)])
        self.assertIsNotNone(result)

    def test_capture_epoch_and_explicit_construction_date(self):
        from jarvizar_city_model.external.lidar_measurements import measure_features
        from shapely.geometry import mapping
        feature={'id':'one','properties':{},'geometry':mapping(box(0,0,60,60))}
        base=self.cloud(lambda x,y:30)
        points=np.column_stack((base,np.full(len(base),2014),np.ones(len(base))))
        def measure(cloud):
            evidence={}
            records,counts,rejected=measure_features([feature],cloud,lambda x,y:(x,y),lambda x,y:(x,y),
                6,3,box(-100,-100,100,100),observations_out=evidence)
            return records,rejected,evidence
        records,_,_=measure(points)
        self.assertEqual(records['one']['capture_year'],2014)
        feature['properties']['start_date']='2020'
        self.assertEqual(measure(points)[1]['one'],'predates_building')
        feature['properties']={'sources':[{'update_time':'2026-01-01'}]}
        self.assertIn('one',measure(points)[0])
        points[points[:,0]>30,5]=2022
        self.assertEqual(measure(points)[1]['one'],'mixed_capture_epochs')

    def test_sparse_ground_vegetation_and_sparse_roofs_fall_back(self):
        for cloud in (self.cloud(lambda x,y:30,class_id=5),
                      self.cloud(lambda x,y:30)[::30],
                      self.cloud(lambda x,y:30)[self.cloud(lambda x,y:30)[:,3] != 2]):
            result, _ = measure_building(box(0,0,60,60), PointIndex(cloud), 6, 3)
            self.assertIsNone(result)

    def test_unclassified_planar_roof_can_be_measured(self):
        result, _ = measure_building(box(0,0,60,60), PointIndex(self.cloud(lambda x,y:30,class_id=1)), 6, 3)
        self.assertAlmostEqual(result["height_m"], 30)

    def test_classified_podium_does_not_hide_unclassified_upper_roof(self):
        cloud = self.cloud(lambda x,y:90,class_id=1)
        low = cloud[cloud[:,3] == 1].copy()
        low[:,2], low[:,3] = 210, 6
        result, _ = measure_building(box(0,0,60,60), PointIndex(np.concatenate((cloud,low))), 6, 3)
        self.assertAlmostEqual(result["height_m"], 90)


@unittest.skipUnless(AVAILABLE, "optional LiDAR dependencies not installed")
class EptTraversalTests(unittest.TestCase):
    def test_corrupt_laz_node_becomes_recoverable_source_failure(self):
        from jarvizar_city_model.external.lidar_ept import read_ept
        class Fetch:
            def json(self, url):
                if url.endswith('ept.json'):
                    return {'dataType':'laszip','hierarchyType':'json','span':128,
                            'srs':{'authority':'EPSG','horizontal':3857},
                            'bounds':[-1000,-1000,-100,1000,1000,100]}
                return {'0-0-0-0':1}
            def get(self, url):
                return b'This is not a LAS/LAZ header'
        with self.assertRaisesRegex(ValueError, 'Unreadable LiDAR node'):
            read_ept(Fetch(),'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/test/ept.json',
                     [-.001,-.001,.001,.001])

    def test_ancestors_and_hierarchy_pages_are_included_once(self):
        class Fetch:
            def json(self, url):
                if url.endswith("0-0-0-0.json"):
                    return {"0-0-0-0": 20, "1-0-0-0": -1, "1-1-1-1": 5}
                return {"1-0-0-0": 10, "2-0-0-0": 10}
        nodes = collect_nodes(Fetch(), "https://test/", {"bounds": [0,0,0,100,100,100]}, [1,1,20,20])
        self.assertEqual(nodes, ["0-0-0-0", "1-0-0-0", "2-0-0-0"])
        with self.assertRaises(BudgetExceeded):
            collect_nodes(Fetch(), "https://test/", {"bounds": [0,0,0,100,100,100]}, [1,1,20,20], max_points=25)

    def test_bounds_are_not_confused_with_geographic_degrees(self):
        self.assertFalse(node_intersects("1-1-1-0", [1000,2000,-50,1100,2100,50], [1000,2000,1040,2040]))
