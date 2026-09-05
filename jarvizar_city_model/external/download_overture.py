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


def _download_one(feature_type, bbox, release, output_path):
    from overturemaps.core import record_batch_reader
    from overturemaps.writers import get_writer

    reader = record_batch_reader(
        feature_type,
        bbox=bbox,
        release=release,
        connect_timeout=10,
        request_timeout=120,
        stac=True,
    )
    if reader is None:
        _empty_feature_collection(output_path)
        return 0, []

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

