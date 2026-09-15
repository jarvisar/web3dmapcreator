"""Airport runways, taxiways and aprons print as road-thick paving in their own object.

Run: blender --background --factory-startup --python-exit-code 1
             --python tests/blender_airport_paving.py
"""

import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from blender_ground_support import assert_closed, collection, rectangle, top, tree, FixtureTransform
from jarvizar_city_model.blender.mesh_utils import MeshBuilder
from jarvizar_city_model.geometry.heightfield import ModelHeightField
from jarvizar_city_model.geometry.planar import faces_are_consistent
from jarvizar_city_model.geometry.roads import RoadSettings, generate_roads
from jarvizar_city_model.geometry.surface_priority import cut_road_footprints

SCALE = 0.07


class Transform(FixtureTransform):
    """Model millimetres double as "degrees"; one metre is SCALE mm."""

    metric_bounds = SimpleNamespace(min_east_m=0, min_north_m=0,
                                   max_east_m=20 / SCALE, max_north_m=20 / SCALE)
    projection = SimpleNamespace(
        forward=lambda x, y, z: (x / SCALE, y / SCALE, z),
        inverse=lambda east, north, up: (east * SCALE, north * SCALE, up),
    )


def line(class_name, points, **tags):
    return {"type": "Feature", "id": class_name,
            "properties": {"subtype": "airport", "class": class_name,
                           "source_tags": [[key, value] for key, value in tags.items()]},
            "geometry": {"type": "LineString", "coordinates": [list(p) for p in points]}}


def area(class_name, ring):
    return {"type": "Feature", "id": class_name,
            "properties": {"subtype": "airport", "class": class_name},
            "geometry": {"type": "Polygon", "coordinates": [[list(p) for p in ring + [ring[0]]]]}}


def main():
    field = ModelHeightField(0, 0, 20, 20, 11, 11,
                             [1.0 + 0.1 * x for y in range(0, 21, 2) for x in range(0, 21, 2)])
    features = [
        line("runway", [(3, 2), (3, 18)], width="46"),          # 3.22 mm wide, square ends
        line("taxiway", [(3, 10), (12, 10)]),                   # 23 m default, 1.61 mm
        area("apron", rectangle(10, 4, 16, 8)),
        area("helipad", rectangle(17, 17, 17.2, 17.2)),         # 0.04 mm2: too small
        area("international_airport", rectangle(0, 0, 20, 20)),  # grounds, not paving
        {"type": "Feature", "properties": {"subtype": "airport", "class": "airport_gate"},
         "geometry": {"type": "Point", "coordinates": [14, 6]}},
    ]
    roads = collection("airport_roads")
    counts = generate_roads([], Transform(), field, roads, collection("airport_decks"),
                            collection("airport_piers"), {}, RoadSettings(include_bridges=False),
                            airport_features=features)
    assert counts["airport_surfaces"] == 3, counts
    assert counts["airport_rejected"] == 1, counts
    assert counts["surface_roads"] == 0, counts
    assert len(roads.objects) == 1, list(roads.objects)
    obj = roads.objects[0]
    assert obj["feature_type"] == "surface_road" and obj["road_class"] == "airport", dict(obj)
    assert_closed(obj)
    assert faces_are_consistent([tuple(p.vertices) for p in obj.data.polygons])

    bvh = tree(obj)
    thickness = RoadSettings().road_thickness_mm

    def paved(x, y):
        z = top(bvh, x, y)
        if z is None:
            return False
        assert abs(z - (field.height_mm(x, y) + thickness)) < 0.02, (x, y, z)
        return True

    # Runway: its full mapped width, square at the ends.
    assert paved(3, 5) and paved(4.5, 5) and paved(1.5, 5)
    assert not paved(4.9, 5) and not paved(1.1, 5)
    assert not paved(3, 1.8) and paved(3, 2.2)
    # Taxiway: default width, round end reaching past its last vertex.
    assert paved(8, 10) and paved(8, 10.7) and not paved(8, 11.0)
    assert paved(12.6, 10)
    # Apron: the whole polygon.  The airport grounds around it: not paved.
    assert paved(13, 6) and paved(10.2, 4.2)
    assert not paved(13, 14) and not paved(17.1, 17.1)

    # Land cover beneath the paving is cut away like under any ground road.
    surfaces = collection("airport_surfaces")
    grass = MeshBuilder("grass")
    assert grass.add_flat_prism(rectangle(0, 0, 20, 20), 0.5, 1.2)
    grass_obj = grass.build(surfaces)
    grass_obj["feature_type"] = "land_surface"
    cut = cut_road_footprints(surfaces, roads, 0.55)
    assert cut["land_surface_road_cut_objects"] == 1, cut
    runway_area = 3.22 * 16
    assert cut["land_surface_road_cut_area_mm2"] > runway_area + 6 * 4, cut

    # Disabled: nothing is built.
    none = collection("airport_disabled")
    counts = generate_roads([], Transform(), field, none, collection("d2"), collection("p2"), {},
                            RoadSettings(include_bridges=False, include_airports=False),
                            airport_features=features)
    assert counts["airport_surfaces"] == 0 and len(none.objects) == 0, counts
    print("JARVIZAR_AIRPORT_PAVING_OK")


main()
