"""Area tools in background Blender: Find Place, Resize, map links, My Areas and size hints.

Place search is stubbed and urlopen refuses every call, so nothing touches the
network. My Areas are written to a temporary folder. Prints
JARVIZAR_AREA_TOOLS_OK on success.
"""

from pathlib import Path
import sys
import tempfile
import urllib.request

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import jarvizar_city_model as addon
from jarvizar_city_model import operators, operators_area, ui
from jarvizar_city_model.blender import generation_modal
from jarvizar_city_model.data import area, geocode
from jarvizar_city_model.data.projection import create_fixed_scale_transform


def refuse_network(*args, **kwargs):
    raise AssertionError("tests must not use the network")


urllib.request.urlopen = refuse_network
addon.register()
folder = tempfile.TemporaryDirectory()
presets_path = Path(folder.name) / "config" / "bounds_presets.txt"
operators_area.user_presets_path = lambda: presets_path
opened = []
operators_area._open_url = opened.append
settings = bpy.context.scene.jarvizar_city_model


def fields():
    return [float(value) for value in (settings.west, settings.south, settings.east, settings.north)]


def centre():
    west, south, east, north = fields()
    return (south + north) / 2.0, (west + east) / 2.0


def model_mm():
    transform = create_fixed_scale_transform(*fields(), settings.mm_per_metre)
    return transform.model_bounds.width_mm, transform.model_bounds.height_mm


def real_m():
    west, south, east, north = fields()
    return area.real_size_m(area.WGS84Bounds(west, south, east, north))


def close(actual, expected, tolerance=0.001):
    return abs(actual - expected) / expected < tolerance


def assert_size(expected_mm):
    actual = model_mm()
    assert all(close(a, e) for a, e in zip(actual, expected_mm)), (actual, expected_mm)


def refused(call, message):
    """An operator error report raises in a script; check it and the status line."""
    try:
        result = call()
    except RuntimeError as exc:
        assert message in str(exc), exc
        assert message in settings.last_status, settings.last_status
        return
    raise AssertionError(f"expected a refusal, got {result}")


# Typed coordinates at a chosen print size; the panel shows the size generated.
assert bpy.ops.jarvizar.area_from_place(query="41.8781, -87.6298", width_mm=230.0,
                                        height_mm=150.0) == {"FINISHED"}
assert all(abs(a - b) < 1e-6 for a, b in zip(centre(), (41.8781, -87.6298))), centre()
assert_size((230.0, 150.0))
assert ui._scale_summary(settings)[0] == "230 x 150 mm at 1:14,286", ui._scale_summary(settings)
assert settings.last_status == ("Area set around 41.8781, -87.6298: 3.29 x 2.14 km, "
                                "230 x 150 mm at 1:14,286"), settings.last_status

# The default size fits the selected printer's bed with a margin.
assert bpy.ops.jarvizar.area_from_place(query="-33.8568 151.2153") == {"FINISHED"}
assert_size((200.0, 200.0))
settings.bambu_printer = "A1M"
bpy.ops.jarvizar.area_from_place(query="-33.8568 151.2153")
assert_size((120.0, 120.0))
settings.bambu_printer = "P1S"

# The equator, 60 N and the southern hemisphere all generate at the size shown.
for query in ("0.0, 10.0", "60.17, 24.94", "-54.8, -68.3"):
    bpy.ops.jarvizar.area_from_place(query=query, width_mm=200.0, height_mm=180.0)
    assert_size((200.0, 180.0))
    assert ui._scale_summary(settings)[0].startswith("200 x 180 mm"), (query, ui._scale_summary(settings))

# Refusals leave the area alone.
before = fields()
refused(lambda: bpy.ops.jarvizar.area_from_place(query="-122.4194, 37.7749"), "first number is the latitude")
refused(lambda: bpy.ops.jarvizar.area_from_place(query="  "), "Enter a place")
operators_area._online = lambda: False
refused(lambda: bpy.ops.jarvizar.area_from_place(query="Eiffel Tower"),
        "Online access is off: enable it in Edit > Preferences > System > Network")
assert fields() == before

# Place search results: a script gets the first; the choice applies another.
operators_area._online = lambda: True
places = [
    geocode.Place("Springfield", "Springfield, Sangamon County, Illinois, United States", 39.7990, -89.6440),
    geocode.Place("Springfield", "Springfield, Hampden County, Massachusetts, United States", 42.1015, -72.5898),
    geocode.Place("Springfield", "Springfield, Greene County, Missouri, United States", 37.2090, -93.2923),
]
searches = []


def fake_search(query, **options):
    searches.append((query, options))
    return list(places)


geocode.search = fake_search
assert bpy.ops.jarvizar.area_from_place(query="Springfield", width_mm=200.0, height_mm=200.0) == {"FINISHED"}
assert all(abs(a - b) < 1e-6 for a, b in zip(centre(), (39.7990, -89.6440))), centre()
assert searches[0][0] == "Springfield"
assert searches[0][1]["version"] == ".".join(map(str, addon.bl_info["version"])), searches
assert settings.last_status.startswith("Area set around Springfield: 2.86 x 2.86 km"), settings.last_status
assert operators_area._suggested_name(settings) == "Springfield"
operators_area._offer(places)
assert [item[0] for item in operators_area._place_items] == ["0", "1", "2"]
assert bpy.ops.jarvizar.area_pick_place(place="2", width_m=1000.0, height_m=500.0) == {"FINISHED"}
assert all(abs(a - b) < 1e-6 for a, b in zip(centre(), (37.2090, -93.2923))), centre()
# The fields hold seven decimals, about a centimetre.
assert all(close(a, e, 1e-4) for a, e in zip(real_m(), (1000.0, 500.0))), real_m()
geocode.search = lambda query, **options: []
refused(lambda: bpy.ops.jarvizar.area_from_place(query="Nowhere at all"), "No place found for Nowhere at all")
geocode.search = fake_search

# Fit to Size takes the real size in km.
settings.scale_mode = "FIT"
assert bpy.ops.jarvizar.area_from_place(query="51.5007, -0.1246", width_km=3.0, height_km=2.0) == {"FINISHED"}
assert all(close(a, e) for a, e in zip(real_m(), (3000.0, 2000.0))), real_m()
assert bpy.ops.jarvizar.resize_area(width_km=1.5, height_km=1.5) == {"FINISHED"}
assert all(close(a, 1500.0) for a in real_m()), real_m()
refused(lambda: bpy.ops.jarvizar.resize_area(fit_bed=True), "Fit Printer Bed applies to Fixed Print Scale")
settings.scale_mode = "FIXED"

# Resize keeps the centre; Fit Printer Bed uses the bed size with a margin.
middle = centre()
assert bpy.ops.jarvizar.resize_area(width_mm=100.0, height_mm=80.0) == {"FINISHED"}
assert_size((100.0, 80.0))
assert all(abs(a - b) < 1e-7 for a, b in zip(centre(), middle)), (centre(), middle)
assert settings.last_status == "Area resized: 1.43 x 1.14 km, 100 x 80 mm at 1:14,286", settings.last_status
assert bpy.ops.jarvizar.resize_area(fit_bed=True) == {"FINISHED"}
assert_size((200.0, 200.0))
assert operators_area._suggested_name(settings) == "My Area"

# Map links open the browser at the current area.
assert bpy.ops.jarvizar.view_area_on_map() == {"FINISHED"}
assert opened[-1] == area.osm_url(area.WGS84Bounds(*fields())), opened
assert bpy.ops.jarvizar.draw_area_in_browser() == {"FINISHED"}
assert opened[-1] == area.bboxfinder_url(area.WGS84Bounds(*fields())), opened

# My Areas: saved outside the add-on, replaced by name, listed, removed.
assert bpy.ops.jarvizar.save_area_preset(name="Test: Area") == {"FINISHED"}
line = f"Test - Area: {settings.west},{settings.south},{settings.east},{settings.north}"
assert presets_path.read_text(encoding="utf-8").splitlines()[-1] == line, presets_path.read_text()
assert settings.last_status == "Saved Test - Area in My Areas", settings.last_status
bpy.ops.jarvizar.area_from_place(query="37.8199, -122.4783")
assert bpy.ops.jarvizar.save_area_preset(name="test - area") == {"FINISHED"}
assert settings.last_status == "Updated test - area in My Areas", settings.last_status
assert [name for name, _ in operators_area._user_presets()] == ["test - area"]
assert operators_area._suggested_name(settings) == "37.8199, -122.4783"


class Recorder:
    """Enough of UILayout to record what a draw function shows."""

    def __init__(self, log):
        self.log = log

    def label(self, text="", icon="NONE"):
        self.log.append(("label", text, icon))

    def operator(self, idname, text="", icon="NONE"):
        self.log.append(("operator", idname, text))
        return type("Properties", (), {})()

    def prop(self, *args, **kwargs):
        pass

    def separator(self, **kwargs):
        pass

    def menu(self, idname, **kwargs):
        self.log.append(("menu", idname, kwargs.get("text", "")))

    def __getattr__(self, name):
        if name in {"box", "row", "column"}:
            return lambda *args, **kwargs: Recorder(self.log)
        raise AttributeError(name)


log = []
ui.JARVIZAR_MT_bounds_presets.draw(type("Menu", (), {"layout": Recorder(log)})(), bpy.context)
texts = [entry[2] for entry in log if entry[0] == "operator"]
assert "Chicago - The Loop" in texts and "Paris - Eiffel Tower" in texts, texts
assert ("label", "My Areas", "NONE") in log
assert texts[-2:] == ["test - area", "Save Current Area..."], texts[-2:]
assert log[-1] == ("menu", "JARVIZAR_MT_remove_area_preset", ""), log[-1]
log.clear()
operators_area.JARVIZAR_MT_remove_area_preset.draw(type("Menu", (), {"layout": Recorder(log)})(), bpy.context)
assert log == [("operator", "jarvizar.remove_area_preset", "test - area")], log

assert bpy.ops.jarvizar.remove_area_preset(name="TEST - AREA") == {"FINISHED"}
assert operators_area._user_presets() == []
refused(lambda: bpy.ops.jarvizar.remove_area_preset(name="Missing"), "Missing is not in My Areas")

# Size hints in the sidebar.
settings.west, settings.south, settings.east, settings.north = "-74.07978", "40.66423", "-73.90366", "40.82212"
context = type("Context", (), {"scene": bpy.context.scene, "region": type("Region", (), {"width": 180})()})()
summary = operators_area._summary(context)
assert summary.size_line == "14.9 x 17.5 km, 261 km²", summary.size_line
assert summary.notes[0] == ("ERROR", "Larger than the P1S bed: use a cutout frame and/or Multi-Plate "
                                     "Export, or a smaller area or scale"), summary.notes
assert summary.notes[1][1].startswith("Large area"), summary.notes
settings.multi_plate_export = True
assert operators_area._summary(context).notes[0][1].endswith("Multi-Plate Export needs a cutout frame")
cutout = bpy.data.objects.new("cutout", bpy.data.meshes.new("cutout"))
bpy.context.scene.collection.objects.link(cutout)
assert operators_area._summary(context).notes[0][1].startswith("Large area"), operators_area._summary(context)
bpy.data.objects.remove(cutout)
settings.multi_plate_export = False
log.clear()
ui.JARVIZAR_PT_city_model.draw(type("Panel", (), {"layout": Recorder(log)})(), context)
labels = [entry[1] for entry in log if entry[0] == "label"]
assert "14.9 x 17.5 km, 261 km²" in labels, labels
assert any(entry[1] == "jarvizar.area_from_place" for entry in log if entry[0] == "operator")
assert ("label", "Larger than the P1S bed:", "ERROR") in log, labels
settings.scale_mode = "FIT"
log.clear()
ui.JARVIZAR_PT_city_model.draw(type("Panel", (), {"layout": Recorder(log)})(), context)
labels = [entry[1] for entry in log if entry[0] == "label"]
fitted = area.model_size_mm(*real_m(), target_mm=(settings.target_width_mm, settings.target_height_mm))
assert area.print_line(*fitted) in labels, (area.print_line(*fitted), labels)
settings.scale_mode = "FIXED"

# Nothing that changes the area runs while a model generates or LiDAR prepares.
for owner, attribute, value in ((generation_modal, "_active", object()),
                                (operators.JARVIZAR_OT_prepare_lidar, "_running", True)):
    original = getattr(owner, attribute)
    setattr(owner, attribute, value)
    try:
        for call in (lambda: bpy.ops.jarvizar.resize_area(fit_bed=True),
                     lambda: bpy.ops.jarvizar.area_from_place(query="1, 2")):
            try:
                call()
            except RuntimeError as exc:
                assert "poll()" in str(exc), exc
            else:
                raise AssertionError("area changed while busy")
    finally:
        setattr(owner, attribute, original)

addon.unregister()
folder.cleanup()
print("JARVIZAR_AREA_TOOLS_OK")
