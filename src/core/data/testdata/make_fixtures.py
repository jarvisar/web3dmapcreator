# Writes the small Parquet files the offline data layer tests read. They copy
# the layout of real Overture files (struct bbox, WKB geometry with GeoParquet
# metadata, names struct, MAP source_tags, list-of-struct rules, zstd) at a
# few rows each. The test area is lon 0..1, lat 0..1.
#
# Needs pyarrow. Run from this folder: python make_fixtures.py

import json
import struct
from datetime import datetime, timezone

import pyarrow as pa
import pyarrow.parquet as pq

BASE = "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/test"


def ring(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]


def wkb_polygon(rings):
    out = struct.pack("<BII", 1, 3, len(rings))
    for r in rings:
        out += struct.pack("<I", len(r))
        for x, y in r:
            out += struct.pack("<dd", x, y)
    return out


def wkb_multipolygon(polygons):
    out = struct.pack("<BII", 1, 6, len(polygons))
    for rings in polygons:
        out += wkb_polygon(rings)
    return out


def wkb_line(points):
    out = struct.pack("<BII", 1, 2, len(points))
    for x, y in points:
        out += struct.pack("<dd", x, y)
    return out


def box(x0, y0, x1, y1):
    return {"xmin": x0, "xmax": x1, "ymin": y0, "ymax": y1}


GEO = json.dumps({
    "version": "1.1.0",
    "primary_column": "geometry",
    "columns": {"geometry": {"encoding": "WKB", "geometry_types": [],
                             "covering": {"bbox": {"xmin": ["bbox", "xmin"], "ymin": ["bbox", "ymin"],
                                                   "xmax": ["bbox", "xmax"], "ymax": ["bbox", "ymax"]}}}},
})

BBOX = pa.struct([("xmin", pa.float64()), ("xmax", pa.float64()), ("ymin", pa.float64()), ("ymax", pa.float64())])
NAMES = pa.struct([
    ("primary", pa.string()),
    ("common", pa.map_(pa.string(), pa.string())),
    ("rules", pa.list_(pa.struct([("variant", pa.string()), ("value", pa.string())]))),
])
SOURCES = pa.list_(pa.struct([("dataset", pa.string()), ("record_id", pa.string())]))
RULE = pa.list_(pa.struct([("value", pa.string()), ("between", pa.list_(pa.float64()))]))
FLAGS = pa.list_(pa.struct([("values", pa.list_(pa.string())), ("between", pa.list_(pa.float64()))]))


def write(name, schema, rows, row_group_size):
    schema = schema.with_metadata({"geo": GEO})
    table = pa.Table.from_pylist(rows, schema=schema)
    # One row per page, and a dictionary that gives up after its first value:
    # Overture's geometry chunks in miniature (a dictionary page, one page of
    # dictionary indices, then plain pages).
    pq.write_table(table, name, compression="zstd", row_group_size=row_group_size,
                   data_page_size=1, write_batch_size=1, dictionary_pagesize_limit=100)


def building(id, x0, y0, x1, y1, **props):
    row = {"id": id, "geometry": wkb_polygon([ring(x0, y0, x1, y1)]), "bbox": box(x0, y0, x1, y1),
           "sources": [{"dataset": "OpenStreetMap", "record_id": "w1"}]}
    row.update(props)
    return row


BUILDING = pa.schema([
    ("id", pa.string()), ("names", NAMES), ("sources", SOURCES), ("level", pa.int32()),
    ("height", pa.float64()), ("min_height", pa.float64()), ("is_underground", pa.bool_()),
    ("num_floors", pa.int32()), ("min_floor", pa.int64()), ("subtype", pa.string()), ("class", pa.string()),
    ("facade_color", pa.string()), ("roof_shape", pa.string()), ("roof_direction", pa.float64()),
    ("roof_height", pa.float64()), ("geometry", pa.binary()), ("has_parts", pa.bool_()),
    ("version", pa.int32()), ("bbox", BBOX),
])

bad = building("bad", 0.1, 0.8, 0.2, 0.9)
bad["geometry"] = wkb_polygon([ring(0.1, 0.8, 0.2, 0.9)])[:20]
nogeom = building("nogeom", 0.3, 0.3, 0.4, 0.4)
nogeom["geometry"] = None
multi = {"id": "multi", "geometry": wkb_multipolygon([[ring(0.05, 0.05, 0.1, 0.1)], [ring(0.12, 0.05, 0.15, 0.1)]]),
         "bbox": box(0.05, 0.05, 0.15, 0.1), "height": 9.0}

write("building-a.parquet", BUILDING, [
    # Row group 0 lies wholly outside the area and must never be read.
    building("far1", 5, 5, 5.1, 5.1), building("far2", 5.2, 5.2, 5.3, 5.3), building("far3", 6, 6, 6.1, 6.1),
    building("inside", 0.2, 0.2, 0.3, 0.3, height=12.0),
    building("outside", 2, 2, 2.1, 2.1),
    building("straddle", 0.9, 0.9, 1.5, 1.5, num_floors=3),
    building("tower", 0.4, 0.4, 0.5, 0.5, height=120.5, min_floor=2, roof_shape="flat", has_parts=True,
             subtype="commercial", **{"class": "office"},
             names={"primary": "Tower", "common": [("fr", "Tour")], "rules": [{"variant": "common", "value": "Tower"}]}),
    nogeom,
    building("dup", 0.6, 0.6, 0.7, 0.7, height=30.0),
    bad, multi, building("west", -3, -3, -2.9, -2.9),
], 3)

write("building-b.parquet", BUILDING, [
    building("dup", 0.6, 0.6, 0.7, 0.7, height=31.0),
    building("second", 0.75, 0.1, 0.8, 0.15, is_underground=False, level=1),
], 3)

WATER = pa.schema([
    ("id", pa.string()), ("names", NAMES), ("subtype", pa.string()), ("class", pa.string()),
    ("source_tags", pa.map_(pa.string(), pa.string())), ("level", pa.int32()), ("is_intermittent", pa.bool_()),
    ("is_salt", pa.bool_()), ("geometry", pa.binary()), ("bbox", BBOX),
])
write("water.parquet", WATER, [
    {"id": "pond", "geometry": wkb_polygon([ring(0.1, 0.1, 0.3, 0.3), ring(0.15, 0.15, 0.2, 0.2)[::-1]]),
     "bbox": box(0.1, 0.1, 0.3, 0.3), "subtype": "water", "class": "pond", "is_salt": False, "level": 0,
     "source_tags": [("natural", "water"), ("water", "pond")]},
    {"id": "stream", "geometry": wkb_line([(0.5, 0.5), (0.8, 0.9)]), "bbox": box(0.5, 0.5, 0.8, 0.9),
     "subtype": "stream", "class": "stream", "is_intermittent": True},
    {"id": "lake", "geometry": wkb_polygon([ring(3, 3, 4, 4)]), "bbox": box(3, 3, 4, 4), "subtype": "lake"},
], 10)

SEGMENT = pa.schema([
    ("id", pa.string()), ("names", NAMES), ("subtype", pa.string()), ("class", pa.string()),
    ("subclass", pa.string()), ("subclass_rules", RULE), ("road_flags", FLAGS), ("rail_flags", FLAGS),
    ("width_rules", pa.list_(pa.struct([("value", pa.float64()), ("between", pa.list_(pa.float64()))]))),
    ("level_rules", pa.list_(pa.struct([("value", pa.int32()), ("between", pa.list_(pa.float64()))]))),
    ("geometry", pa.binary()), ("bbox", BBOX),
])
write("segment.parquet", SEGMENT, [
    {"id": "bridge", "geometry": wkb_line([(0.1, 0.5), (0.9, 0.5)]), "bbox": box(0.1, 0.5, 0.9, 0.5),
     "subtype": "road", "class": "primary",
     "road_flags": [{"values": ["is_bridge"], "between": [0.2, 0.8]}],
     "level_rules": [{"value": 1, "between": [0.2, 0.8]}], "width_rules": [{"value": 12.5, "between": None}]},
    {"id": "rail", "geometry": wkb_line([(0.5, 0.1), (0.5, 0.9)]), "bbox": box(0.5, 0.1, 0.5, 0.9),
     "subtype": "rail", "class": "standard_gauge", "rail_flags": [{"values": ["is_tunnel"], "between": None}]},
], 10)

sizes = {name: len(open(name, "rb").read()) for name in
         ["building-a.parquet", "building-b.parquet", "water.parquet", "segment.parquet"]}


def item(theme, type, part, bbox, size, rows, groups):
    href = f"{BASE}/theme={theme}/type={type}/{part}"
    return {
        "type": "Feature",
        "id": part,
        "assets": {
            "aws": {"href": href, "file:size": size,
                    "alternate": {"s3": {"href": href.replace(
                        "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/", "s3://overturemaps-us-west-2/")}}},
            "azure": {"href": href.replace("https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com",
                                           "https://overturemapswestus2.blob.core.windows.net"), "file:size": size},
        },
        "collection": None,
        "datetime": datetime(2026, 1, 1, tzinfo=timezone.utc),
        "num_rows": rows,
        "num_row_groups": groups,
        "bbox": {"xmin": bbox[0], "ymin": bbox[1], "xmax": bbox[2], "ymax": bbox[3]},
    }


ASSET = pa.struct([("href", pa.string()), ("file:size", pa.int64())])
INDEX = pa.schema([
    ("type", pa.string()), ("id", pa.string()),
    ("assets", pa.struct([
        ("aws", pa.struct([("href", pa.string()), ("file:size", pa.int64()),
                           ("alternate", pa.struct([("s3", pa.struct([("href", pa.string())]))]))])),
        ("azure", ASSET),
    ])),
    ("collection", pa.null()),
    ("datetime", pa.timestamp("ms", tz="UTC")),
    ("num_rows", pa.int64()), ("num_row_groups", pa.int64()),
    ("bbox", pa.struct([("xmin", pa.float64()), ("ymin", pa.float64()), ("xmax", pa.float64()), ("ymax", pa.float64())])),
])
index = pa.Table.from_pylist([
    item("buildings", "building", "building-a.parquet", (-3, -3, 6.1, 6.1), sizes["building-a.parquet"], 12, 4),
    item("buildings", "building", "building-b.parquet", (0.6, 0.1, 0.8, 0.7), sizes["building-b.parquet"], 2, 1),
    # Far from the area, and not served by the tests: reading it is a failure.
    item("buildings", "building", "building-far.parquet", (50, 50, 51, 51), 1000, 10, 1),
    item("base", "water", "water.parquet", (0.1, 0.1, 4, 4), sizes["water.parquet"], 3, 1),
    item("transportation", "segment", "segment.parquet", (0.1, 0.1, 0.9, 0.9), sizes["segment.parquet"], 2, 1),
    item("base", "land_use", "land_use-far.parquet", (50, 50, 51, 51), 1000, 10, 1),
], schema=INDEX)
pq.write_table(index, "index.parquet", compression="zstd")
print("wrote", sizes)
