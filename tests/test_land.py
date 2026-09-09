"""Tests for base land, land use, land cover, and water classification policy."""

from __future__ import annotations

import unittest

from jarvizar_city_model.data.land import (
    FOREST,
    GREEN,
    PAVED,
    ROCK,
    SAND,
    TREE_BEARING_CATEGORIES,
    classify_surface,
    extent_ratio,
    geometry_extent,
    is_printable_water,
    is_regional_feature,
    is_tree_point,
    is_water_deck,
    recessed_water_kind,
    surface_priority,
    tree_point_coordinates,
)


BOUNDS = (-84.5337, 39.08554, -84.47422, 39.11094)


def polygon(west, south, east, north, **properties):
    return {
        "type": "Feature",
        "properties": properties,
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [[west, south], [east, south], [east, north], [west, north], [west, south]]
            ],
        },
    }


class ClassificationTests(unittest.TestCase):
    def test_land_use_park_and_grass_are_green(self):
        self.assertEqual(classify_surface("land_use", polygon(0, 0, 1, 1, **{"class": "park"})), GREEN)
        self.assertEqual(classify_surface("land_use", polygon(0, 0, 1, 1, **{"class": "grass"})), GREEN)

    def test_land_wood_is_forest(self):
        feature = polygon(0, 0, 1, 1, subtype="forest", **{"class": "wood"})
        self.assertEqual(classify_surface("land", feature), FOREST)

    def test_land_cover_uses_subtype(self):
        feature = polygon(0, 0, 1, 1, subtype="forest")
        self.assertEqual(classify_surface("land_cover", feature), FOREST)

    def test_land_cover_urban_is_not_a_surface(self):
        # Accepting it would blanket the whole selection in one flat slab.
        self.assertIsNone(classify_surface("land_cover", polygon(0, 0, 1, 1, subtype="urban")))

    def test_pedestrian_land_use_is_paved(self):
        self.assertEqual(
            classify_surface("land_use", polygon(0, 0, 1, 1, **{"class": "pedestrian"})), PAVED
        )

    def test_sand_and_beach_are_sand(self):
        self.assertEqual(classify_surface("land", polygon(0, 0, 1, 1, **{"class": "sand"})), SAND)
        self.assertEqual(classify_surface("land", polygon(0, 0, 1, 1, **{"class": "beach"})), SAND)

    def test_unknown_class_produces_no_surface(self):
        self.assertIsNone(classify_surface("land_use", polygon(0, 0, 1, 1, **{"class": "wat"})))
        self.assertIsNone(classify_surface("nonsense_type", polygon(0, 0, 1, 1, **{"class": "park"})))

    def test_generic_landmass_is_not_a_surface(self):
        self.assertIsNone(classify_surface("land", polygon(0, 0, 1, 1, subtype="land", **{"class": "land"})))

    def test_only_forest_bears_scattered_trees(self):
        self.assertIn(FOREST, TREE_BEARING_CATEGORIES)
        self.assertNotIn(GREEN, TREE_BEARING_CATEGORIES)

    def test_surface_priority_order(self):
        order = [FOREST, GREEN, ROCK, SAND, PAVED]
        self.assertTrue(all(surface_priority(a) < surface_priority(b) for a, b in zip(order, order[1:])))


class TreePointTests(unittest.TestCase):
    def test_recognizes_a_mapped_tree(self):
        feature = {
            "type": "Feature",
            "properties": {"subtype": "tree", "class": "tree"},
            "geometry": {"type": "Point", "coordinates": [-84.5, 39.1]},
        }
        self.assertTrue(is_tree_point(feature))
        self.assertEqual(tree_point_coordinates(feature), (-84.5, 39.1))

    def test_polygon_forest_is_not_a_tree_point(self):
        self.assertFalse(is_tree_point(polygon(0, 0, 1, 1, subtype="forest")))

    def test_missing_coordinates_return_none(self):
        self.assertIsNone(
            tree_point_coordinates({"geometry": {"type": "Point", "coordinates": []}})
        )


class WaterTests(unittest.TestCase):
    def test_river_polygon_is_printable(self):
        self.assertTrue(is_printable_water(polygon(0, 0, 1, 1, subtype="river", **{"class": "river"})))

    def test_swimming_pool_is_excluded(self):
        self.assertFalse(
            is_printable_water(polygon(0, 0, 1, 1, subtype="human_made", **{"class": "swimming_pool"}))
        )

    def test_water_centerlines_are_excluded(self):
        feature = {
            "type": "Feature",
            "properties": {"class": "river"},
            "geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
        }
        self.assertFalse(is_printable_water(feature))


class RecessedWaterTests(unittest.TestCase):
    def test_osm_pond_and_fountain_tags(self):
        for field in ('source_tags', 'tags'):
            for tags, expected in (({'natural': 'water', 'water': 'pond'}, 'pond'),
                                   ({'amenity': 'fountain'}, 'fountain')):
                for representation in (tags, list(tags.items()),
                                       [{'key': k, 'value': v} for k, v in tags.items()]):
                    with self.subTest(field=field, tags=representation):
                        self.assertEqual(recessed_water_kind(polygon(0,0,1,1, **{field: representation})), expected)
        self.assertEqual(recessed_water_kind(polygon(0,0,1,1, natural='water', water='pond')), 'pond')
        self.assertEqual(recessed_water_kind(polygon(0,0,1,1, amenity='fountain')), 'fountain')

    def test_normalized_importer_class_and_subtype(self):
        for kind in ('pond', 'fountain'):
            for props in ({'class': kind}, {'subtype': kind}, {'class': 'water', 'subtype': kind}):
                self.assertEqual(recessed_water_kind(polygon(0,0,1,1, **props)), kind)

    def test_other_water_types_are_never_selected_by_size_or_name(self):
        for kind in ('river', 'stream', 'lake', 'reservoir', 'canal', 'ocean', 'bay',
                     'sea', 'coastline', 'strait', 'drain', 'ditch', 'swimming_pool', 'water'):
            self.assertIsNone(recessed_water_kind(polygon(0,0,.001,.001, **{
                'class': kind, 'subtype': kind, 'names': {'primary': 'Fountain Pond'},
            })))

    def test_explicit_osm_type_overrides_fallback(self):
        self.assertIsNone(recessed_water_kind(polygon(0,0,1,1, **{
            'class': 'pond', 'source_tags': [['natural','water'],['water','lake']],
        })))
        self.assertIsNone(recessed_water_kind(polygon(0,0,1,1, **{
            'class': 'fountain', 'source_tags': [['waterway','river']],
        })))
        self.assertEqual(recessed_water_kind(polygon(0,0,1,1, **{
            'class': 'water', 'source_tags': [['natural','water'],['water','pond']],
        })), 'pond')

    def test_fountain_points_and_lines_have_no_invented_basin(self):
        for kind in ('Point', 'LineString'):
            self.assertIsNone(recessed_water_kind({'properties': {'amenity': 'fountain'},
                                                 'geometry': {'type': kind, 'coordinates': []}}))


class WaterDeckTests(unittest.TestCase):
    def test_marina_area_does_not_restore_a_harbor_as_ground(self):
        for feature_type in ("infrastructure", "land", "land_use"):
            for properties in ({"class": "marina", "subtype": "recreation"},
                               {"subtype": "marina"}):
                with self.subTest(feature_type=feature_type, properties=properties):
                    self.assertFalse(is_water_deck(feature_type, polygon(0, 0, 1, 1, **properties)))

    def test_physical_water_structures_still_keep_their_ground(self):
        for deck in ("pier", "breakwater", "quay", "dam", "weir", "boardwalk", "groyne"):
            for properties in ({"class": deck, "subtype": "water"}, {"subtype": deck}):
                with self.subTest(deck=deck, properties=properties):
                    self.assertTrue(is_water_deck("infrastructure", polygon(0, 0, 1, 1, **properties)))

    def test_unmapped_extents_and_non_polygon_structures_are_not_decks(self):
        self.assertFalse(is_water_deck("land_use", polygon(0, 0, 1, 1, **{"class": "harbour"})))
        self.assertFalse(is_water_deck("water", polygon(0, 0, 1, 1, **{"class": "pier"})))
        self.assertFalse(is_water_deck("infrastructure", {
            "properties": {"class": "pier"},
            "geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
        }))


class ExtentGuardTests(unittest.TestCase):
    def test_local_polygon_has_a_small_ratio(self):
        feature = polygon(-84.52, 39.09, -84.50, 39.10)
        self.assertLess(extent_ratio(feature["geometry"], BOUNDS), 1.0)
        self.assertFalse(is_regional_feature(feature["geometry"], BOUNDS))

    def test_continental_polygon_is_rejected(self):
        # The shape of the observed land_cover polygon that blanketed the model.
        feature = polygon(-90.0, 35.0, -80.0, 42.0)
        self.assertGreater(extent_ratio(feature["geometry"], BOUNDS), 1000.0)
        self.assertTrue(is_regional_feature(feature["geometry"], BOUNDS))

    def test_a_polygon_slightly_larger_than_the_selection_is_kept(self):
        feature = polygon(-84.55, 39.08, -84.46, 39.12)
        self.assertFalse(is_regional_feature(feature["geometry"], BOUNDS))

    def test_extent_uses_unclipped_source_geometry(self):
        extent = geometry_extent(polygon(-90.0, 35.0, -80.0, 42.0)["geometry"])
        self.assertAlmostEqual(extent[0], 10.0)
        self.assertAlmostEqual(extent[1], 7.0)

    def test_non_polygon_geometry_has_no_extent(self):
        self.assertIsNone(geometry_extent({"type": "Point", "coordinates": [0, 0]}))
        self.assertEqual(extent_ratio({"type": "Point", "coordinates": [0, 0]}, BOUNDS), 0.0)


if __name__ == "__main__":
    unittest.main()
