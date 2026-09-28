"""Choosing the area: place search, resizing, map links and saved areas (My Areas).

Operators that change the bounding box are unavailable while a model is
generating or LiDAR is preparing. The sidebar helpers read only cached pure
computations; nothing here touches the network while drawing.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import bpy
from bpy.props import BoolProperty, EnumProperty, FloatProperty, StringProperty
from bpy.types import Menu, Operator

from .blender.download_modal import is_downloading
from .blender.generation_modal import is_generating
from .data import area, geocode
from .data.bounds_presets import (
    USER_PRESETS_NAME,
    clean_name,
    load_presets,
    remove_preset,
    save_preset,
    unique_name,
)
from .data.export_plates import DEFAULT_PRINTER, PRINTERS
from .data.projection import WGS84Bounds, format_degrees, normalize_minus
from .operators import JARVIZAR_OT_prepare_lidar

NETWORK_SETTING = "Edit > Preferences > System > Network"

# Results of the last search offered for choice. Blender keeps pointers into
# the enum item strings, so the item list must stay referenced here.
_places: list = []
_place_items: list = []
_NO_PLACES = [("NONE", "No results", "")]
# Fields of the last area set from a place, and the place's name.
_last_place = {"fields": None, "name": ""}
_user_cache = {"key": None, "presets": []}
_summary_cache = {"key": None, "value": None}


def user_presets_path() -> Path | None:
    """My Areas file in Blender's user config folder, which add-on updates leave alone."""
    folder = bpy.utils.user_resource("CONFIG", path="jarvizar_city_model")
    return Path(folder) / USER_PRESETS_NAME if folder else None


def _open_url(url: str) -> None:
    bpy.ops.wm.url_open(url=url)


def _online() -> bool:
    return bool(getattr(bpy.app, "online_access", True))


def _busy() -> str:
    if is_generating():
        return "Not available while a model is generating"
    if JARVIZAR_OT_prepare_lidar._running:
        return "Not available while LiDAR is preparing"
    if is_downloading():
        return "Not available while downloading"
    return ""


def _poll_idle(cls) -> bool:
    busy = _busy()
    if busy:
        cls.poll_message_set(busy)
    return not busy


def _fail(operator, settings, message: str) -> set:
    settings.last_status = message
    operator.report({"ERROR"}, message)
    return {"CANCELLED"}


def _fields(settings) -> tuple:
    return settings.west, settings.south, settings.east, settings.north


def _current_bounds(settings) -> WGS84Bounds:
    try:
        values = [float(normalize_minus(str(value)).strip()) for value in _fields(settings)]
    except ValueError:
        raise ValueError("Bounding-box fields must contain decimal degrees") from None
    return WGS84Bounds(*values)


def _write_bounds(settings, bounds: WGS84Bounds) -> None:
    settings.west = format_degrees(bounds.west)
    settings.south = format_degrees(bounds.south)
    settings.east = format_degrees(bounds.east)
    settings.north = format_degrees(bounds.north)


def _printer(settings):
    return PRINTERS.get(settings.bambu_printer) or PRINTERS[DEFAULT_PRINTER]


def _printer_name(printer) -> str:
    return printer.model.removeprefix("Bambu Lab ")


def _bed_fit(settings) -> tuple[float, float]:
    printer = _printer(settings)
    return area.bed_fit_mm(printer.width, printer.depth)


def _model_size(settings, width_m: float, height_m: float) -> tuple[float, float, float]:
    if settings.scale_mode == "FIXED":
        return area.model_size_mm(width_m, height_m, mm_per_metre=settings.mm_per_metre)
    return area.model_size_mm(width_m, height_m,
                              target_mm=(settings.target_width_mm, settings.target_height_mm),
                              preserve_aspect=settings.preserve_aspect_ratio)


def _size_text(settings) -> str:
    """Real and printed size of the area in the fields, for status lines."""
    width_m, height_m = area.real_size_m(_current_bounds(settings))
    width_mm, height_mm, scale = _model_size(settings, width_m, height_m)
    return f"{area.format_size(width_m, height_m)}, {area.print_line(width_mm, height_mm, scale)}"


def _addon_version() -> str:
    import sys
    info = getattr(sys.modules.get(__package__), "bl_info", {})
    return ".".join(str(part) for part in info.get("version", ()))


def _mm(name: str, description: str):
    return FloatProperty(name=name, description=description, default=200.0, min=10.0,
                         soft_max=2000.0, max=100000.0, precision=0, options={"SKIP_SAVE"})


def _km(name: str, description: str):
    return FloatProperty(name=name, description=description, default=3.0, min=0.01,
                         soft_max=50.0, max=area.MAX_SIDE_M / 1000.0, precision=2,
                         options={"SKIP_SAVE"})


def _set_default(operator, name: str, value: float) -> None:
    if not operator.properties.is_property_set(name):
        setattr(operator, name, value)


def _default_sizes(operator, settings, fixed_mm, fit_km) -> None:
    if settings.scale_mode == "FIXED":
        _set_default(operator, "width_mm", fixed_mm[0])
        _set_default(operator, "height_mm", fixed_mm[1])
    else:
        _set_default(operator, "width_km", fit_km[0])
        _set_default(operator, "height_km", fit_km[1])


def _current_km(settings) -> tuple[float, float]:
    try:
        width_m, height_m = area.real_size_m(_current_bounds(settings))
    except ValueError:
        return 3.0, 3.0
    return round(width_m / 1000.0, 2), round(height_m / 1000.0, 2)


def _requested_m(operator, settings, fit_bed: bool = False) -> tuple[float, float]:
    """The requested real size in metres from mm at the fixed scale, or from km."""
    if settings.scale_mode == "FIXED":
        scale = float(settings.mm_per_metre)
        if scale <= 0.0:
            raise ValueError("Scale must be greater than zero")
        width_mm, height_mm = _bed_fit(settings) if fit_bed else (operator.width_mm, operator.height_mm)
        return width_mm / scale, height_mm / scale
    if fit_bed:
        raise ValueError("Fit Printer Bed applies to Fixed Print Scale")
    return operator.width_km * 1000.0, operator.height_km * 1000.0


def _draw_size(operator, layout, settings, fit_bed: bool = False) -> None:
    column = layout.column(align=True)
    column.enabled = not fit_bed
    if settings.scale_mode == "FIXED":
        column.prop(operator, "width_mm")
        column.prop(operator, "height_mm")
    else:
        column.prop(operator, "width_km")
        column.prop(operator, "height_km")
    try:
        width_m, height_m = _requested_m(operator, settings, fit_bed)
        width_mm, height_mm, scale = _model_size(settings, width_m, height_m)
    except (ValueError, ZeroDivisionError):
        return
    if settings.scale_mode == "FIXED":
        layout.label(text=f"Real size {area.format_size(width_m, height_m)}")
    else:
        layout.label(text=area.print_line(width_mm, height_mm, scale))
    printer = _printer(settings)
    if not area.fits_bed(width_mm, height_mm, printer.width, printer.depth):
        layout.label(text=f"Larger than the {_printer_name(printer)} bed", icon="ERROR")


def _search(context, query: str) -> list:
    if not _online():
        if getattr(bpy.app, "online_access_override", False):
            raise geocode.GeocodeError("Blender was started with online access disabled")
        raise geocode.GeocodeError(f"Online access is off: enable it in {NETWORK_SETTING}")
    window = getattr(context, "window", None)
    if window is not None:
        window.cursor_set("WAIT")
    try:
        from .config import place_search_url

        return geocode.search(query, version=_addon_version(),
                              language=geocode.language_code(bpy.app.translations.locale),
                              endpoint=place_search_url())
    finally:
        if window is not None:
            window.cursor_set("DEFAULT")


def _apply_place(operator, context, place, width_m: float, height_m: float) -> set:
    settings = context.scene.jarvizar_city_model
    try:
        bounds = area.bounds_around(place.latitude, place.longitude, width_m, height_m)
    except ValueError as exc:
        return _fail(operator, settings, str(exc))
    _write_bounds(settings, bounds)
    _last_place.update(fields=_fields(settings), name=place.name)
    settings.last_status = f"Area set around {place.name}: {_size_text(settings)}"
    operator.report({"INFO"}, settings.last_status)
    return {"FINISHED"}


def _offer(places) -> None:
    def short(text, limit=64):
        return text if len(text) <= limit else text[:limit - 3].rstrip() + "..."

    _places[:] = places
    _place_items[:] = [(str(index), short(place.display_name), place.display_name)
                       for index, place in enumerate(places)]


def _place_enum(self, context):
    return _place_items or _NO_PLACES


class JARVIZAR_OT_area_from_place(Operator):
    bl_idname = "jarvizar.area_from_place"
    bl_label = "Find Place"
    bl_description = (
        "Set the area around a place, address or typed latitude, longitude at a chosen size. "
        "Place search uses OpenStreetMap Nominatim and needs online access"
    )
    bl_options = {"REGISTER", "UNDO"}

    query: StringProperty(
        name="Place",
        description="Place, address or landmark, or latitude, longitude in decimal degrees",
    )
    width_mm: _mm("Width (mm)", "Printed east-west size at the fixed print scale")
    height_mm: _mm("Height (mm)", "Printed north-south size at the fixed print scale")
    width_km: _km("Width (km)", "Real east-west size")
    height_km: _km("Height (km)", "Real north-south size")
    choose: BoolProperty(default=False, options={"HIDDEN", "SKIP_SAVE"})

    @classmethod
    def poll(cls, context):
        return _poll_idle(cls)

    def invoke(self, context, event):
        settings = context.scene.jarvizar_city_model
        _default_sizes(self, settings, _bed_fit(settings), _current_km(settings))
        self.choose = True
        return context.window_manager.invoke_props_dialog(self, width=340)

    def draw(self, context):
        settings = context.scene.jarvizar_city_model
        layout = self.layout
        layout.label(text="Place, address or latitude, longitude")
        row = layout.row()
        row.activate_init = True
        row.prop(self, "query", text="")
        _draw_size(self, layout, settings)
        layout.label(text=geocode.ATTRIBUTION)

    def execute(self, context):
        settings = context.scene.jarvizar_city_model
        busy = _busy()
        if busy:
            return _fail(self, settings, busy)
        if not self.query.strip():
            return _fail(self, settings, "Enter a place, address or latitude, longitude")
        _default_sizes(self, settings, _bed_fit(settings), _current_km(settings))
        try:
            width_m, height_m = _requested_m(self, settings)
            place = geocode.parse_coordinates(self.query)
            places = [place] if place else _search(context, self.query)
        except (ValueError, geocode.GeocodeError) as exc:
            return _fail(self, settings, str(exc))
        if not places:
            return _fail(self, settings, f"No place found for {' '.join(self.query.split())}")
        if len(places) == 1 or not self.choose:
            return _apply_place(self, context, places[0], width_m, height_m)
        _offer(places)
        bpy.ops.jarvizar.area_pick_place("INVOKE_DEFAULT", width_m=width_m, height_m=height_m)
        return {"FINISHED"}


class JARVIZAR_OT_area_pick_place(Operator):
    bl_idname = "jarvizar.area_pick_place"
    bl_label = "Choose Place"
    bl_description = "Set the area around the chosen search result"
    bl_options = {"REGISTER", "UNDO", "INTERNAL"}

    place: EnumProperty(name="Place", items=_place_enum)
    width_m: FloatProperty(default=2000.0, min=area.MIN_SIDE_M, max=area.MAX_SIDE_M,
                           options={"HIDDEN", "SKIP_SAVE"})
    height_m: FloatProperty(default=2000.0, min=area.MIN_SIDE_M, max=area.MAX_SIDE_M,
                            options={"HIDDEN", "SKIP_SAVE"})

    @classmethod
    def poll(cls, context):
        return _poll_idle(cls) and bool(_places)

    def invoke(self, context, event):
        return context.window_manager.invoke_props_dialog(self, width=440)

    def draw(self, context):
        layout = self.layout
        layout.column().prop(self, "place", expand=True)
        layout.label(text=geocode.ATTRIBUTION)

    def execute(self, context):
        settings = context.scene.jarvizar_city_model
        busy = _busy()
        if busy:
            return _fail(self, settings, busy)
        try:
            place = _places[int(self.place)]
        except (IndexError, ValueError):
            return _fail(self, settings, "Search again: the result list has changed")
        return _apply_place(self, context, place, self.width_m, self.height_m)


class JARVIZAR_OT_resize_area(Operator):
    bl_idname = "jarvizar.resize_area"
    bl_label = "Resize Area"
    bl_description = "Change the size of the area, keeping its centre"
    bl_options = {"REGISTER", "UNDO"}

    fit_bed: BoolProperty(
        name="Fit Printer Bed",
        description=(f"Use the largest size in whole centimetres that leaves {area.BED_MARGIN_MM:.0f} mm "
                     "on each side of the selected printer's bed"),
        default=False, options={"SKIP_SAVE"},
    )
    width_mm: _mm("Width (mm)", "Printed east-west size at the fixed print scale")
    height_mm: _mm("Height (mm)", "Printed north-south size at the fixed print scale")
    width_km: _km("Width (km)", "Real east-west size")
    height_km: _km("Height (km)", "Real north-south size")

    @classmethod
    def poll(cls, context):
        return _poll_idle(cls)

    def _defaults(self, settings):
        width_m, height_m = area.real_size_m(_current_bounds(settings))
        scale = max(float(settings.mm_per_metre), 1e-9)
        _default_sizes(self, settings, (round(width_m * scale), round(height_m * scale)),
                       (round(width_m / 1000.0, 2), round(height_m / 1000.0, 2)))

    def invoke(self, context, event):
        settings = context.scene.jarvizar_city_model
        try:
            self._defaults(settings)
        except ValueError as exc:
            return _fail(self, settings, str(exc))
        return context.window_manager.invoke_props_dialog(self, width=300)

    def draw(self, context):
        settings = context.scene.jarvizar_city_model
        layout = self.layout
        if settings.scale_mode == "FIXED":
            width, depth = _bed_fit(settings)
            printer = _printer_name(_printer(settings))
            layout.prop(self, "fit_bed", toggle=True, icon="FULLSCREEN_ENTER",
                        text=f"Fit {printer} Bed ({width:.0f} x {depth:.0f} mm)")
        _draw_size(self, layout, settings, self.fit_bed and settings.scale_mode == "FIXED")
        layout.label(text="Keeps the current centre")

    def execute(self, context):
        settings = context.scene.jarvizar_city_model
        busy = _busy()
        if busy:
            return _fail(self, settings, busy)
        try:
            self._defaults(settings)
            bounds = _current_bounds(settings)
            width_m, height_m = _requested_m(self, settings, self.fit_bed)
            resized = area.bounds_around(bounds.center_latitude, bounds.center_longitude,
                                         width_m, height_m)
        except ValueError as exc:
            return _fail(self, settings, str(exc))
        _write_bounds(settings, resized)
        settings.last_status = f"Area resized: {_size_text(settings)}"
        self.report({"INFO"}, settings.last_status)
        return {"FINISHED"}


class JARVIZAR_OT_view_area_on_map(Operator):
    bl_idname = "jarvizar.view_area_on_map"
    bl_label = "View Area on Map"
    bl_description = "Open openstreetmap.org at the current area in the web browser"

    def execute(self, context):
        settings = context.scene.jarvizar_city_model
        try:
            bounds = _current_bounds(settings)
        except ValueError as exc:
            return _fail(self, settings, str(exc))
        _open_url(area.osm_url(bounds))
        return {"FINISHED"}


class JARVIZAR_OT_draw_area_in_browser(Operator):
    bl_idname = "jarvizar.draw_area_in_browser"
    bl_label = "Draw Area in Browser"
    bl_description = (
        "Open bboxfinder.com to draw a new area. Copy the Box value it shows, in the default "
        "Lng / Lat order, then click Paste Coordinates"
    )

    def execute(self, context):
        try:
            bounds = _current_bounds(context.scene.jarvizar_city_model)
        except ValueError:
            bounds = None
        _open_url(area.bboxfinder_url(bounds))
        self.report({"INFO"}, "Draw a box, copy its Box value, then click Paste Coordinates")
        return {"FINISHED"}


def _user_presets() -> list[tuple[str, str]]:
    path = user_presets_path()
    try:
        stat = path.stat()
    except (AttributeError, OSError):
        return []
    key = (str(path), stat.st_mtime_ns, stat.st_size)
    if key != _user_cache["key"]:
        _user_cache.update(key=key, presets=load_presets(path))
    return _user_cache["presets"]


def _suggested_name(settings) -> str:
    base = _last_place["name"] if _last_place["fields"] == _fields(settings) else ""
    try:
        base = clean_name(base)
    except ValueError:
        base = "My Area"
    return unique_name(base, [name for name, _ in _user_presets()])


class JARVIZAR_OT_save_area_preset(Operator):
    bl_idname = "jarvizar.save_area_preset"
    bl_label = "Save Current Area"
    bl_description = (
        "Save the current area to My Areas in the Presets menu. My Areas are stored in "
        "Blender's user config folder, so add-on updates keep them"
    )

    name: StringProperty(name="Name", description="Name in the Presets menu", options={"SKIP_SAVE"})

    def invoke(self, context, event):
        settings = context.scene.jarvizar_city_model
        try:
            _current_bounds(settings)
        except ValueError as exc:
            return _fail(self, settings, str(exc))
        if not self.name.strip():
            self.name = _suggested_name(settings)
        return context.window_manager.invoke_props_dialog(self, width=300)

    def draw(self, context):
        layout = self.layout
        layout.label(text="Name in the Presets menu")
        row = layout.row()
        row.activate_init = True
        row.prop(self, "name", text="")

    def execute(self, context):
        settings = context.scene.jarvizar_city_model
        path = user_presets_path()
        if path is None:
            return _fail(self, settings, "Blender's user config folder is not available")
        try:
            name = clean_name(self.name)
            replaced = save_preset(path, name, ",".join(_fields(settings)))
        except (OSError, ValueError) as exc:
            return _fail(self, settings, f"Could not save the area: {exc}")
        finally:
            _user_cache["key"] = None
        settings.last_status = f"{'Updated' if replaced else 'Saved'} {name} in My Areas"
        self.report({"INFO"}, settings.last_status)
        return {"FINISHED"}


class JARVIZAR_OT_remove_area_preset(Operator):
    bl_idname = "jarvizar.remove_area_preset"
    bl_label = "Remove Saved Area"
    bl_description = "Remove this area from My Areas"

    name: StringProperty(name="Name", options={"HIDDEN", "SKIP_SAVE"})

    @classmethod
    def description(cls, context, properties):
        return f"Remove {properties.name} from My Areas" if properties.name else cls.bl_description

    def invoke(self, context, event):
        return context.window_manager.invoke_confirm(self, event)

    def execute(self, context):
        settings = context.scene.jarvizar_city_model
        path = user_presets_path()
        try:
            removed = path is not None and remove_preset(path, self.name)
        except OSError as exc:
            return _fail(self, settings, f"Could not remove the area: {exc}")
        finally:
            _user_cache["key"] = None
        if not removed:
            return _fail(self, settings, f"{self.name} is not in My Areas")
        settings.last_status = f"Removed {self.name} from My Areas"
        self.report({"INFO"}, settings.last_status)
        return {"FINISHED"}


class JARVIZAR_MT_remove_area_preset(Menu):
    bl_label = "Remove Saved Area"
    bl_idname = "JARVIZAR_MT_remove_area_preset"

    def draw(self, context):
        for name, _ in _user_presets():
            self.layout.operator("jarvizar.remove_area_preset", text=name).name = name


def draw_user_presets(layout) -> None:
    """The My Areas section at the end of the Presets menu."""
    presets = _user_presets()
    layout.separator()
    layout.label(text="My Areas")
    for name, bounds in presets:
        layout.operator("jarvizar.paste_bounds", text=name).text = bounds
    layout.operator("jarvizar.save_area_preset", text="Save Current Area...", icon="ADD")
    if presets:
        layout.menu("JARVIZAR_MT_remove_area_preset", icon="REMOVE")


def _summary(context):
    """Size line, printed size and hints for the current settings, cached."""
    settings = context.scene.jarvizar_city_model
    cutout = context.scene.objects.get("cutout")
    key = (*_fields(settings), settings.scale_mode, settings.mm_per_metre,
           settings.target_width_mm, settings.target_height_mm, settings.preserve_aspect_ratio,
           settings.bambu_printer, settings.multi_plate_export,
           cutout is not None and cutout.type == "MESH")
    if key == _summary_cache["key"]:
        return _summary_cache["value"]
    value = None
    try:
        width_m, height_m = area.real_size_m(_current_bounds(settings))
        width_mm, height_mm, scale = _model_size(settings, width_m, height_m)
        if scale > 0.0:
            printer = _printer(settings)
            value = SimpleNamespace(
                size_line=area.size_line(width_m, height_m),
                print_line=area.print_line(width_mm, height_mm, scale),
                notes=area.size_notes(width_m, height_m, (width_mm, height_mm),
                                      (printer.width, printer.depth), _printer_name(printer),
                                      cutout=key[-1], multi_plate=settings.multi_plate_export))
    except (ValueError, ZeroDivisionError):
        value = None
    _summary_cache.update(key=key, value=value)
    return value


def draw_area_tools(layout, context) -> None:
    """Find Place, Resize, Draw and Map buttons, then the area's real size."""
    row = layout.row(align=True)
    row.operator("jarvizar.area_from_place", text="Find Place", icon="VIEWZOOM")
    row.operator("jarvizar.resize_area", text="", icon="FULLSCREEN_ENTER")
    row.operator("jarvizar.draw_area_in_browser", text="", icon="GREASEPENCIL")
    row.operator("jarvizar.view_area_on_map", text="", icon="URL")
    summary = _summary(context)
    if summary is not None:
        layout.label(text=summary.size_line)


def draw_size_notes(layout, context) -> None:
    """Printed size in Fit to Size mode, then hints about the area's size."""
    from .ui import _wrapped

    summary = _summary(context)
    if summary is None:
        return
    if context.scene.jarvizar_city_model.scale_mode != "FIXED":
        layout.label(text=summary.print_line)
    for icon, text in summary.notes:
        _wrapped(layout, text, context.region.width, limit=4, icon=icon)


CLASSES = (
    JARVIZAR_OT_area_from_place,
    JARVIZAR_OT_area_pick_place,
    JARVIZAR_OT_resize_area,
    JARVIZAR_OT_view_area_on_map,
    JARVIZAR_OT_draw_area_in_browser,
    JARVIZAR_OT_save_area_preset,
    JARVIZAR_OT_remove_area_preset,
    JARVIZAR_MT_remove_area_preset,
)
