"""Whole-survey choice and changes in the physical building, not edit dates."""
import unittest
from itertools import permutations
from jarvizar_city_model.external.lidar_selection import (
    choose_measurement, construction_year, gps_capture_years, project_year)


def record(source, year=None, height=30, coverage=.95, density=2, explained=.95):
    return dict(source=source, capture_year=year, height_m=height, tiers=[],
                coverage=coverage, roof_support_density_m2=density, explained_fraction=explained)


class SelectionTests(unittest.TestCase):
    def test_recent_comparable_survey_wins_regardless_of_catalog_order(self):
        older, newer = record('old',2014), record('new',2022)
        for candidates in permutations([older,newer]):
            selected, audit = choose_measurement(candidates)
            self.assertIs(selected,newer)
            self.assertEqual(audit['candidates'],2)

    def test_supported_detail_can_outweigh_age_but_never_mix_records(self):
        old = record('dense',2018,coverage=1,density=5,explained=1)
        old['tiers'] = [{'top_m':40,'bottom_m':30,'geometry':{'type':'Polygon','coordinates':[]}}]
        new = record('sparse',2022,coverage=.85,density=.3,explained=.6)
        selected, _ = choose_measurement([new,old])
        self.assertIs(selected,old)
        self.assertEqual(selected['tiers'],old['tiers'])

    def test_changed_building_does_not_prefer_dense_old_scan(self):
        old = record('old',2014,height=190,coverage=1,density=5,explained=1)
        new = record('new',2022,height=30,coverage=.85,density=.3,explained=.6)
        self.assertIsNone(choose_measurement([old,new])[0])
        self.assertEqual(choose_measurement([record('old',2014,height=190),record('new',2022,height=30)])[0]['capture_year'],2022)

    def test_unknown_or_same_year_conflicting_heights_use_source_fallback(self):
        for years in ((None,None),(2014,2014),(None,2022)):
            self.assertIsNone(choose_measurement([record('a',years[0],190),record('b',years[1],30)])[0])

    def test_new_observed_absence_blocks_old_building_sparse_scan_does_not(self):
        old=record('old',2014)
        for year in (2022,2014,None):
            self.assertIsNone(choose_measurement([old],[{'reason':'observed_ground_in_footprint','capture_year':year}])[0])
        self.assertIs(choose_measurement([old],[{'reason':'sparse_or_noisy_roof','capture_year':2022}])[0],old)
        self.assertIs(choose_measurement([old],[{'reason':'observed_ground_in_footprint','capture_year':2010}])[0],old)

    def test_project_publication_and_osm_edit_dates_are_not_construction(self):
        self.assertEqual(project_year('NJ_SdL5_2014_LAS_2015'),2014)
        self.assertIsNone(construction_year({'sources':[{'update_time':'2025-01-01'}],'version':2026}))
        self.assertEqual(construction_year({'start_date':'2020-04'}),2020)
        self.assertIsNone(construction_year({'start_date':'circa 2020'}))

    def test_same_top_but_changed_tower_position_is_not_averaged(self):
        try:
            from shapely.geometry import box,mapping
        except ImportError:
            self.skipTest('optional Shapely dependency not installed')
        a,b=record('left',2014),record('right',2014)
        for candidate, outline in ((a,box(0,0,40,60)),(b,box(20,0,60,60))):
            candidate['tiers']=[{'bottom_m':30,'top_m':90,'geometry':mapping(outline)}]
        self.assertIsNone(choose_measurement([a,b],footprint=box(0,0,60,60))[0])
        b['capture_year']=2022
        self.assertIs(choose_measurement([a,b],footprint=box(0,0,60,60))[0],b)

    def test_gps_encoding_unknown_week_and_inferred_mirror_dates(self):
        try:
            import numpy as np
        except ImportError:
            self.skipTest('optional NumPy dependency not installed')
        seconds=(np.datetime64('2022-07-01')-np.datetime64('1980-01-06'))/np.timedelta64(1,'s')-1e9
        years,basis=gps_capture_years([seconds,0,float('nan')],1)
        self.assertEqual(list(years),[2022,0,0]);self.assertEqual(basis,'gps_declared')
        self.assertEqual(list(gps_capture_years([12345],0,True)[0]),[0])
        self.assertEqual(list(gps_capture_years([seconds],0,False)[0]),[0])
        self.assertEqual(gps_capture_years([seconds],0,True)[1],'gps_inferred_ept')
