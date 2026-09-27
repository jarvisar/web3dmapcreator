"""Measure how every generated solid sits against the terrain it is draped on.

A diagnostic, not a test.  It generates the sample bbox from a cache inside
Blender, captures the very height field the generator aligned to, and samples
every cap face of roads, slabs, buildings, piers, and supports against it:

    blender --background --factory-startup --python tests/blender_embed_probe.py \\
        -- --cache <cache-root> [--rise mm] [--terrain-resolution n]

It reports, per collection, how deep undersides sit below the terrain and how
high tops stand above it (percentiles, extremes, and where), how many samples
lie over cut-out water, and the worst offenders by location.  Zero-area cap
faces are skipped: they carry no volume, and Blender's float32 storage can
flip their winding, which would otherwise read as a floating underside.
"""
from __future__ import annotations

import json
import sys
import time
from collections import defaultdict
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _argument(name, default=""):
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv):
            return argv[i + 1]
    return default


def pct(values, q):
    if not values:
        return float("nan")
    s = sorted(values)
    return s[min(len(s) - 1, int(q * (len(s) - 1)))]


def main():
    import jarvizar_city_model
    from jarvizar_city_model import operators
    from jarvizar_city_model.geometry.heightfield import ModelHeightField

    captured = {}

    class Capturing(ModelHeightField):
        @classmethod
        def build(cls, *args, **kwargs):
            hf = ModelHeightField.build(*args, **kwargs)
            captured["hf"] = hf
            return hf

    operators.ModelHeightField = Capturing
    jarvizar_city_model.register()

    settings = bpy.context.scene.jarvizar_city_model
    settings.cache_directory = _argument("--cache")
    settings.west, settings.south = "-84.53370", "39.08554"
    settings.east, settings.north = "-84.47422", "39.11094"
    settings.terrain_source = "DEM"
    settings.terrain_resolution = int(_argument("--terrain-resolution", "192"))
    settings.generate_border_rim = True
    settings.generate_bridges = True
    settings.generate_trees = True
    settings.tidy_road_network = True
    settings.scale_mode = "FIXED"
    settings.mm_per_metre = 0.07
    rise = float(_argument("--rise", "0"))
    if rise > 0:
        settings.surface_rise_mm = rise

    t0 = time.perf_counter()
    result = bpy.ops.jarvizar.generate_model()
    print(f"generated in {time.perf_counter() - t0:.1f}s: {result} {settings.last_status}")
    hf = captured["hf"]
    counts = json.loads(bpy.data.collections["CITY_MODEL"]["generation_counts_json"])
    bottom_z = counts["terrain_bottom_z_mm"]
    print(f"terrain bottom {bottom_z:.3f}; cell {hf.cell_size_mm:.3f} mm; grid {hf.columns}x{hf.rows}")

    categories = {
        "SURFACE_ROADS": "roads",
        "LAND_SURFACES": "slabs",
        "BUILDINGS": "buildings",
        "BUILDING_PARTS": "parts",
        "BRIDGE_SUPPORTS": "piers",
        "TERRAIN_SUPPORTS": "supports",
    }
    stats = {}
    for coll_name, label in categories.items():
        coll = bpy.data.collections.get(coll_name)
        if coll is None:
            continue
        bottoms = []  # (depth, x, y, objname): depth = terrain - z, positive is embedded
        tops = []  # (lift, x, y, objname): lift = z - terrain
        bottom_void = 0
        top_void = 0
        faces = 0
        samples = 0
        degenerate = 0
        for obj in coll.objects:
            if obj.type != "MESH":
                continue
            mesh = obj.data
            verts = mesh.vertices
            mw = obj.matrix_world
            is_identity = mw.to_translation().length < 1e-9 and abs(mw.to_scale().x - 1) < 1e-9
            for poly in mesh.polygons:
                nz = poly.normal.z
                if abs(nz) < 0.5:
                    continue
                if poly.area < 1.0e-6:
                    degenerate += 1
                    continue
                faces += 1
                pts = [verts[i].co for i in poly.vertices]
                if not is_identity:
                    pts = [mw @ p for p in pts]
                centre = sum(pts, Vector()) / len(pts)
                probe = [centre] + [(centre + p) * 0.5 for p in pts]
                for p in probe:
                    samples += 1
                    x, y, z = p.x, p.y, p.z
                    if hf.over_open_water(x, y):
                        if nz < 0:
                            bottom_void += 1
                        else:
                            top_void += 1
                        continue
                    t = hf.height_mm(x, y)
                    if nz < 0:
                        bottoms.append((t - z, x, y, obj.name))
                    else:
                        tops.append((z - t, x, y, obj.name))

        depths = [d for d, *_ in bottoms]
        lifts = [l for l, *_ in tops]
        print(f"\n=== {coll_name} ({label}): {faces} cap faces, {samples} samples, {degenerate} zero-area faces skipped ===")
        print(f"  bottom samples over void: {bottom_void}   top samples over void: {top_void}")
        if depths:
            print(
                f"  bottom depth (terrain - z): p01 {pct(depths,0.01):.3f} p10 {pct(depths,0.1):.3f} "
                f"p50 {pct(depths,0.5):.3f} p90 {pct(depths,0.9):.3f} p99 {pct(depths,0.99):.3f} "
                f"max {max(depths):.3f} min {min(depths):.3f}"
            )
            gaps = sum(1 for d in depths if d < -0.05)
            deep1 = sum(1 for d in depths if d > 1.0)
            deep05 = sum(1 for d in depths if d > 0.5)
            print(f"  bottoms floating > 0.05 mm above terrain: {gaps} of {len(depths)} ({100*gaps/len(depths):.2f}%)")
            print(f"  bottoms embedded > 0.5 mm: {deep05} ({100*deep05/len(depths):.2f}%), > 1.0 mm: {deep1} ({100*deep1/len(depths):.2f}%)")
        if lifts:
            print(
                f"  top lift (z - terrain): p01 {pct(lifts,0.01):.3f} p10 {pct(lifts,0.1):.3f} "
                f"p50 {pct(lifts,0.5):.3f} p90 {pct(lifts,0.9):.3f} p99 {pct(lifts,0.99):.3f} "
                f"max {max(lifts):.3f} min {min(lifts):.3f}"
            )
            buried = sum(1 for l in lifts if l < 0.0)
            print(f"  tops below terrain (buried): {buried} of {len(lifts)} ({100*buried/len(lifts):.2f}%)")
        worst_deep = sorted(bottoms, reverse=True)[:6]
        worst_float = sorted(bottoms)[:6]
        worst_buried = sorted(tops)[:6]
        print("  deepest bottoms:", [(round(d, 2), round(x, 1), round(y, 1), n) for d, x, y, n in worst_deep])
        print("  most floating bottoms:", [(round(d, 2), round(x, 1), round(y, 1), n) for d, x, y, n in worst_float])
        print("  most buried tops:", [(round(l, 2), round(x, 1), round(y, 1), n) for l, x, y, n in worst_buried])
        stats[label] = {"bottom_void": bottom_void, "top_void": top_void, "bottoms": bottoms, "tops": tops}

    for coll_name, title in (("LAND_SURFACES", "slab"), ("SURFACE_ROADS", "road")):
        void_faces = defaultdict(list)
        coll = bpy.data.collections.get(coll_name)
        for obj in coll.objects:
            for poly in obj.data.polygons:
                if poly.normal.z > -0.5:
                    continue
                c = poly.center
                if hf.over_open_water(c.x, c.y):
                    void_faces[obj.name].append((round(c.x, 1), round(c.y, 1)))
        print(f"\n=== {title} bottom-face centres over open water, by object ===")
        for name, pts in void_faces.items():
            print(f"  {name}: {len(pts)} faces, e.g. {pts[:5]}")

    roads = stats.get("roads", {}).get("bottoms", [])
    clusters = defaultdict(list)
    for d, x, y, n in roads:
        if d < -0.15:
            clusters[(int(x // 5) * 5, int(y // 5) * 5)].append(d)
    print("\n=== road bottoms floating > 0.15 mm, clustered by 5 mm cell (worst 15) ===")
    for key, ds in sorted(clusters.items(), key=lambda kv: min(kv[1]))[:15]:
        print(f"  cell {key}: {len(ds)} samples, min {min(ds):.2f}")
    clusters = defaultdict(list)
    for d, x, y, n in roads:
        if d > 0.8:
            clusters[(int(x // 5) * 5, int(y // 5) * 5)].append(d)
    print("\n=== road bottoms embedded > 0.8 mm, clustered by 5 mm cell (worst 15) ===")
    for key, ds in sorted(clusters.items(), key=lambda kv: -max(kv[1]))[:15]:
        print(f"  cell {key}: {len(ds)} samples, max {max(ds):.2f}")

    slabs = stats.get("slabs", {}).get("bottoms", [])
    clusters = defaultdict(list)
    for d, x, y, n in slabs:
        if d < -0.15:
            clusters[(int(x // 5) * 5, int(y // 5) * 5)].append(d)
    print("\n=== slab bottoms floating > 0.15 mm, clustered by 5 mm cell (worst 15) ===")
    for key, ds in sorted(clusters.items(), key=lambda kv: min(kv[1]))[:15]:
        print(f"  cell {key}: {len(ds)} samples, min {min(ds):.2f}")
    print("PROBE_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
