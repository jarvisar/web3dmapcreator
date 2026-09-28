"""Test-only stand-in for download_overture.py and download_dem.py.

JCM_FAKE_DOWNLOAD names a JSON file: {"overture": mode, "dem": mode,
"control": folder}. Modes: success, gate (wait for control/release), hang
(start a grandchild, record process ids, sleep), network, no_module, crash,
disk_full, missing_output.
"""

import argparse
import array
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def progress(text):
    print(f"progress: {text}", file=sys.stderr, flush=True)


def result(payload, code=0):
    print(json.dumps(payload), flush=True)
    sys.exit(code)


parser = argparse.ArgumentParser()
parser.add_argument("--bbox", nargs=4, type=float)
parser.add_argument("--output-dir", type=Path)
parser.add_argument("--types", nargs="+")
parser.add_argument("--columns", type=int)
parser.add_argument("--target-spacing-m", type=float)
parser.add_argument("--parent-pid", type=int)
args = parser.parse_args()
stage = "overture" if args.types else "dem"
scenario = json.loads(Path(os.environ["JCM_FAKE_DOWNLOAD"]).read_text(encoding="utf-8"))
mode = scenario.get(stage, "success")
control = Path(scenario["control"])

print("WARNING: unrelated library noise", file=sys.stderr, flush=True)
if stage == "overture":
    progress("Finding the latest Overture release")
    progress("Overture release 2026-01-01.0")
    progress(f"Downloading {args.types[0]} ({1}/{len(args.types)})")
else:
    progress("Downloading elevation tiles (1/4)")

if mode == "gate":
    if stage == "overture" and len(args.types) > 1:
        progress(f"Downloading {args.types[1]} (2/{len(args.types)}): 1,234 features")
    else:
        progress("Downloading elevation tiles (3/4)")
    deadline = time.monotonic() + 60
    while not (control / "release").exists() and time.monotonic() < deadline:
        time.sleep(0.05)
elif mode == "hang":
    marker = control / f"{stage}-grandchild.pid"
    child = subprocess.Popen([sys.executable, "-c",
                              "import os, sys, time; open(sys.argv[1], 'w').write(str(os.getpid())); "
                              "time.sleep(120)", str(marker)])
    deadline = time.monotonic() + 30
    while not marker.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    (control / f"{stage}-pids.json").write_text(
        json.dumps({"helper": os.getpid(), "launcher": child.pid}), encoding="utf-8")
    time.sleep(120)
    sys.exit(9)
elif mode == "network":
    result({"ok": False, "error": "URLError",
            "detail": "<urlopen error [Errno 11001] getaddrinfo failed>"}, 1)
elif mode == "no_module":
    result({"ok": False, "error": "Could not import the official overturemaps client",
            "detail": "No module named 'overturemaps'"}, 2)
elif mode == "disk_full":
    result({"ok": False, "error": "OSError", "detail": "[Errno 28] No space left on device"}, 1)
elif mode == "crash":
    print("Traceback (most recent call last):\nRuntimeError: injected helper crash",
          file=sys.stderr, flush=True)
    sys.exit(3)

args.output_dir.mkdir(parents=True, exist_ok=True)
if stage == "overture":
    if mode != "missing_output":
        for name in args.types:
            (args.output_dir / f"{name}.geojson").write_text(
                json.dumps({"type": "FeatureCollection", "features": [
                    {"type": "Feature", "properties": {"id": f"{name}-1"},
                     "geometry": {"type": "Point", "coordinates": args.bbox[:2]}}]}),
                encoding="utf-8")
    result({"ok": True, "client_version": "0.0-test", "release": "2026-01-01.0",
            "counts": {name: 1 for name in args.types},
            "fields": {name: ["id", "geometry"] for name in args.types}})

columns = rows = 4
west, south, east, north = args.bbox
with (args.output_dir / "terrain.f32").open("wb") as handle:
    array.array("f", [100.0 + index for index in range(columns * rows)]).tofile(handle)
header = {"format": "jcm_elevation_grid", "version": 1, "west": west, "south": south,
          "east": east, "north": north, "columns": columns, "rows": rows, "min_m": 100.0,
          "max_m": 115.0, "zoom": 12, "tiles_used": 4, "tiles_missing": 0,
          "source": "test tiles", "vertical_datum": "test", "ground_resolution_m": 30.0}
(args.output_dir / "terrain.json").write_text(json.dumps(header), encoding="utf-8")
result({"ok": True, **header})
