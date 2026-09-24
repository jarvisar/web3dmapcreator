"""Download Overture data with the official client in an external interpreter.

This file intentionally has no Blender imports.  Keeping PyArrow, Shapely and
their native libraries outside Blender avoids ABI and NumPy conflicts.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import sys
from pathlib import Path


def _empty_feature_collection(path: Path) -> None:
    path.write_text(
        '{"type":"FeatureCollection","features":[]}\n', encoding="utf-8"
    )


_STAC_INDEXES = {}


def _stac_index(release):
    import io
    from urllib.request import urlopen

    import pyarrow.parquet as pq

    if release not in _STAC_INDEXES:
        url = f"https://stac.overturemaps.org/{release}/collections.parquet"
        with urlopen(url, timeout=120) as response:
            table = pq.read_table(io.BytesIO(response.read()), columns=["assets", "bbox"])
        _STAC_INDEXES[release] = table.to_pylist()
    return _STAC_INDEXES[release]


def _intersecting_files(feature_type, bbox, release):
    """Return the S3 files of one type whose index bbox meets ``bbox``.

    Items are selected by their S3 path, not by the index's ``collection``
    value: release 2026-09-23.0 published every collection as null, and the
    client's own STAC selection then found no files for any type.  A type
    absent from the whole index is an error, never an empty layer.
    """
    from overturemaps.core import _dataset_path

    prefix = _dataset_path(feature_type, release)
    xmin, ymin, xmax, ymax = bbox
    listed = 0
    files = []
    for item in _stac_index(release):
        href = item["assets"]["aws"]["alternate"]["s3"]["href"]
        if not href.startswith("s3://" + prefix):
            continue
        listed += 1
        box = item["bbox"]
        if box["xmin"] < xmax and box["xmax"] > xmin and box["ymin"] < ymax and box["ymax"] > ymin:
            files.append(href[len("s3://"):])
    if not listed:
        raise RuntimeError(f"Overture release {release} STAC index lists no {feature_type} files")
    return files


def _download_one(feature_type, bbox, release, output_path):
    import pyarrow.compute as pc
    import pyarrow.dataset as ds
    import pyarrow.fs as fs
    from overturemaps.core import _record_batch_reader_from_dataset
    from overturemaps.writers import get_writer

    files = _intersecting_files(feature_type, bbox, release)
    if not files:
        _empty_feature_collection(output_path)
        return 0, []
    xmin, ymin, xmax, ymax = bbox
    filter_expr = (
        (pc.field("bbox", "xmin") < xmax)
        & (pc.field("bbox", "xmax") > xmin)
        & (pc.field("bbox", "ymin") < ymax)
        & (pc.field("bbox", "ymax") > ymin)
    )
    dataset = ds.dataset(
        files,
        filesystem=fs.S3FileSystem(
            anonymous=True, region="us-west-2", connect_timeout=10, request_timeout=120
        ),
    )
    reader = _record_batch_reader_from_dataset(dataset, filter_expr=filter_expr)
    if reader is None:
        raise RuntimeError(f"Could not read Overture {feature_type} data for release {release}")

    fields = list(reader.schema.names)
    count = 0
    with get_writer("geojson", str(output_path), schema=reader.schema) as writer:
        while True:
            try:
                batch = reader.read_next_batch()
            except StopIteration:
                break
            if batch.num_rows:
                writer.write_batch(batch)
                count += batch.num_rows
    return count, fields


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--bbox", nargs=4, type=float)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--types", nargs="+", default=["building", "building_part"])
    args = parser.parse_args(argv)

    try:
        client_version = importlib.metadata.version("overturemaps")
        from overturemaps.core import get_latest_release
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "Could not import the official overturemaps client",
                    "detail": str(exc),
                }
            )
        )
        return 2

    if args.probe:
        print(json.dumps({"ok": True, "client_version": client_version}))
        return 0
    if args.bbox is None or args.output_dir is None:
        parser.error("--bbox and --output-dir are required unless --probe is used")

    try:
        release = get_latest_release()
        args.output_dir.mkdir(parents=True, exist_ok=True)
        counts = {}
        schemas = {}
        for feature_type in args.types:
            output = args.output_dir / f"{feature_type}.geojson"
            count, fields = _download_one(feature_type, tuple(args.bbox), release, output)
            counts[feature_type] = count
            schemas[feature_type] = fields
        print(
            json.dumps(
                {
                    "ok": True,
                    "client_version": client_version,
                    "release": release,
                    "counts": counts,
                    "fields": schemas,
                }
            )
        )
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": type(exc).__name__, "detail": str(exc)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())

