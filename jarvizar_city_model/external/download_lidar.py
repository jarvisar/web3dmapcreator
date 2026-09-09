"""Acquire a bounded USGS 3DEP crop and atomically cache building measurements.

Run with the optional requirements-lidar.txt environment, never Blender's
Python. --request is the signature written by data/lidar.py.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
try:
    from .lidar_records import validate_records, finite_number
except ImportError:
    from lidar_records import validate_records, finite_number


def valid_checkpoint(cached, identifiers, source_url):
    """A damaged checkpoint is disposable; unaffected batches still resume."""
    if not isinstance(cached, dict) or not all(isinstance(cached.get(key), dict)
            for key in ('records', 'reasons', 'rejected', 'info', 'observations')):
        return False
    if cached['info'].get('url') != source_url:
        return False
    if any(not set(cached[key]).issubset(identifiers) for key in ('records', 'rejected', 'observations')):
        return False
    try:
        validate_records(cached['records'])
    except (ValueError, TypeError, KeyError):
        return False
    if any(not isinstance(reason, str) or not isinstance(count, int) or isinstance(count, bool) or count < 0
           for reason, count in cached['reasons'].items()):
        return False
    if any(not isinstance(reason, str) for reason in cached['rejected'].values()):
        return False
    for observation in cached['observations'].values():
        if not isinstance(observation, dict) or not isinstance(observation.get('reason'), str):
            return False
        year = observation.get('capture_year')
        if year is not None and (not finite_number(year) or int(year) != year):
            return False
    return True


def prepare(bundle, request, refresh=False, progress_path=None):
    from pyproj import CRS, Transformer
    from shapely.geometry import box, shape
    from shapely.ops import transform as map_geometry
    from lidar_ept import Fetcher, CATALOG_URL, read_ept, BudgetExceeded
    from lidar_batches import building_batches, batch_bounds, split_batch
    from lidar_measurements import measure_features
    from lidar_selection import choose_measurement, project_year, POLICY, CONTRADICTIONS
    from shapely import STRtree

    if request["algorithm"] != 6:
        raise ValueError("Unsupported LiDAR algorithm version")
    for name, expected in request["footprint_sha256"].items():
        if name not in ("building", "building_part"):
            raise ValueError("Invalid footprint file")
        if hashlib.sha256((bundle / (name + ".geojson")).read_bytes()).hexdigest() != expected:
            raise ValueError("Footprint cache changed during LiDAR preparation")
    bbox = request["bbox"]
    west, south, east, north = bbox
    if not (-180 <= west < east <= 180 and -85 < south < north < 85):
        raise ValueError("Invalid LiDAR bounding box")
    # Local metric CRS for segmentation/ground fitting only. Cache outlines in
    # WGS84 so Blender still uses its existing ENU transform for all geometry.
    metric = CRS.from_proj4(f"+proj=aeqd +lat_0={(south+north)/2} +lon_0={(west+east)/2} +datum=WGS84 +units=m")
    to_metric = Transformer.from_crs(4326, metric, always_xy=True).transform
    to_geographic = Transformer.from_crs(metric, 4326, always_xy=True).transform
    selected = map_geometry(to_metric, box(*bbox))
    halo = selected.buffer(75)
    query = map_geometry(to_geographic, halo).bounds
    fetch = Fetcher(bundle.parent / "lidar_tiles", refresh=refresh)
    if request["source_url"]:
        sources = [{"url": request["source_url"], "name": request["source_url"].split("/")[-2], "coverage": box(*query)}]
    else:
        catalog = fetch.json(CATALOG_URL)
        sources = []
        for feature in catalog["features"]:
            coverage = shape(feature["geometry"])
            if coverage.intersects(box(*bbox)):
                sources.append({**feature["properties"], "coverage": coverage})
        # Scheduling hint only. Every overlapping survey is compared; project
        # publication years never become measured acquisition dates.
        sources.sort(key=lambda s:(project_year(s['name']) or 0,s['name']), reverse=True)
        sources = list({s['url']:s for s in sources}.values())
    features = json.loads((bundle / "building.geojson").read_text(encoding="utf-8"))["features"]
    for feature in features:
        feature['id'] = str(feature.get('id') or feature.get('properties', {}).get('id') or '')
    geometries = {f['id']: map_geometry(to_metric, shape(f['geometry'])) for f in features}
    geometry_ids = list(geometries)
    tree = STRtree(list(geometries.values()))
    neighbors_by_id = {key:[geometries[geometry_ids[i]] for i in tree.query(geometry.buffer(7), predicate='intersects')
                            if geometry_ids[i] != key] for key,geometry in geometries.items()}
    parts_by_parent = {}
    source_parts_by_parent = {}
    for part in json.loads((bundle / 'building_part.geojson').read_text(encoding='utf-8'))['features']:
        parent = str((part.get('properties') or {}).get('building_id') or '')
        if parent and not (part.get('properties') or {}).get('is_underground'):
            geometry = map_geometry(to_metric, shape(part['geometry']))
            parts_by_parent.setdefault(parent, []).append(geometry)
            source_parts_by_parent.setdefault(parent, []).append((part, geometry))
    measured, provenance, failures, counts, rejected = {}, [], [], Counter(), {}
    alternatives, observations = {}, {}
    def collect(records, evidence, source):
        for identifier, record in records.items():
            record.update(source=source['name'], source_url=source['url'],
                          project_year_hint=project_year(source['name']))
            alternatives.setdefault(identifier, []).append(record)
        for identifier, observation in evidence.items():
            observations.setdefault(identifier, []).append({**observation, 'source':source['name']})
    checkpoints = bundle / 'lidar_jobs'
    checkpoints.mkdir(exist_ok=True)
    total_candidates = sum(shape(f['geometry']).intersects(box(*bbox)) for f in features)
    def progress(message):
        print(message, file=sys.stderr, flush=True)
        if progress_path:
            temporary = progress_path.with_suffix('.partial')
            temporary.write_text(json.dumps({'message': message, 'accepted': len(alternatives),
                                            'candidates': total_candidates}), encoding='utf-8')
            temporary.replace(progress_path)
    for source in sources:
        candidates = [f for f in features if shape(f["geometry"]).intersects(box(*bbox))
                      and source["coverage"].covers(shape(f["geometry"]))]
        if not candidates:
            continue
        progress(f"Measuring {source['name']}: {len(candidates)} candidate buildings")
        batches = building_batches(candidates, geometries)
        while batches:
            batch = batches.pop(0)
            progress(f"Comparing {len(alternatives)} measured buildings; {len(batches)+1} groups left in {source['name']}")
            batch_query = map_geometry(to_geographic, box(*batch_bounds(batch, geometries, selected))).bounds
            batch_roi = map_geometry(to_metric, box(*batch_query))
            job_key = hashlib.sha256(json.dumps([request, source['url'], sorted(f['id'] for f in batch)], sort_keys=True).encode()).hexdigest()
            checkpoint = checkpoints / (job_key+'.json')
            cached = None
            if checkpoint.is_file() and not refresh:
                try:
                    cached = json.loads(checkpoint.read_text(encoding='utf-8'))
                    if not valid_checkpoint(cached, {f['id'] for f in batch}, source['url']):
                        cached = None
                except (OSError, ValueError, TypeError):
                    cached = None
            if cached is not None:
                collect(cached['records'], cached['observations'], source)
                counts.update(cached['reasons'])
                rejected.update(cached['rejected'])
                provenance.append(cached['info'])
                continue
            try:
                points, info = read_ept(fetch, source["url"], batch_query)
            except BudgetExceeded as exc:
                split = split_batch(batch, geometries)
                # Spatial subdivision can resolve point/node limits, but
                # cannot manufacture more total download budget.
                if split and 'byte' not in str(exc).lower() and 'response' not in str(exc).lower():
                    batches[0:0] = split
                    continue
                failures.append({'source': source['name'], 'reason': str(exc), 'buildings': len(batch)})
                if 'byte' in str(exc).lower():
                    break
                continue
            except (ValueError, OSError, RuntimeError, KeyError, TypeError, IndexError, AttributeError) as exc:
                failures.append({'source': source['name'], 'reason': str(exc), 'buildings': len(batch)})
                continue
            if len(points):
                points[:, 0], points[:, 1] = to_metric(points[:, 0].copy(), points[:, 1].copy())
            evidence = {}
            records, reasons, rejected_features = measure_features(batch, points, to_metric, to_geographic,
                request["min_width_mm"] / request["xy_scale"],
                max(0.25, request["min_step_mm"] / request["z_scale"]), batch_roi,
                roof_planes=request.get('roof_planes', True), parts_by_parent=parts_by_parent,
                source_parts_by_parent=source_parts_by_parent,
                observations_out=evidence, neighbors_by_id=neighbors_by_id,
                prefer_lidar=request.get('prefer_lidar', True))
            collect(records, evidence, source)
            counts.update(reasons)
            rejected.update(rejected_features)
            info = {**info, "name": source["name"], "accepted": len(records), 'bbox': list(batch_query)}
            provenance.append(info)
            temporary = checkpoint.with_suffix('.partial')
            temporary.write_text(json.dumps({'records': records, 'reasons': reasons,
                'rejected': rejected_features, 'info': info, 'observations':evidence}, allow_nan=False), encoding='utf-8')
            temporary.replace(checkpoint)
            del points
    if failures and not provenance:
        raise ValueError("; ".join(item["reason"] for item in failures))
    selection = {}
    geographic_geometries = {f['id']:shape(f['geometry']) for f in features}
    for identifier, candidates in alternatives.items():
        record, audit = choose_measurement(candidates, observations.get(identifier, ()), geographic_geometries[identifier],
                                          prefer_lidar=request.get('prefer_lidar', True))
        selection[identifier] = audit
        if record:
            measured[identifier] = {**record, 'selection':audit}
        else:
            rejected[identifier] = audit['reason']
            counts[audit['reason']] += 1
    conflict_buildings = sum(key not in measured and
        (reason in CONTRADICTIONS or reason in ('newer_or_same_age_conflict',
         'conflicting_surveys_unknown_order', 'newer_survey_building_changed'))
        for key,reason in rejected.items())
    validate_records(measured)
    payload = {"format": 1, "request": request, "buildings": measured,
               "sources": provenance, "failures": failures, "counts": dict(counts),
               "rejected": {key: value for key, value in rejected.items() if key not in measured},
               "prepared_at_utc": datetime.now(timezone.utc).isoformat(),
               "catalog": CATALOG_URL, "source_selection": POLICY,
               'selection':selection, 'observations':observations,
               'compared_sources':len({item['url'] for item in provenance}),
               'conflict_buildings':conflict_buildings,
               "bytes_read": fetch.bytes, "network_requests": fetch.requests}
    payload['candidate_buildings'] = sum(shape(f['geometry']).intersects(box(*bbox)) for f in features)
    destination = bundle / "lidar_buildings.json"
    temporary = destination.with_suffix(".json.partial")
    temporary.write_text(json.dumps(payload, allow_nan=False), encoding="utf-8")
    temporary.replace(destination)
    return {"ok": True, "buildings": len(measured), "tiered_buildings": sum(bool(r["tiers"]) for r in measured.values()),
            'infill_buildings': sum(bool(r.get('infill_geometry')) for r in measured.values()),
            'part_heights': sum(len(r.get('part_heights', {})) for r in measured.values()),
            'estimated_heights_corrected': sum(r.get('source_height_decision', r.get('height_decision')) == 'corrected_estimated_height' for r in measured.values()),
            'roof_plane_buildings': sum(bool(r.get('roof_surfaces')) for r in measured.values()),
            "candidate_buildings": payload['candidate_buildings'],
            'compared_sources':payload['compared_sources'], 'conflict_buildings':conflict_buildings,
            "sources": provenance, "counts": dict(counts), "failures": failures,
            "bytes_read": fetch.bytes, "prepared_at_utc": payload["prepared_at_utc"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument('--progress', type=Path)
    args = parser.parse_args()
    try:
        result = prepare(args.bundle, json.loads(args.request.read_text(encoding="utf-8")), args.refresh, args.progress)
    except ImportError as exc:
        result = {"ok": False, "detail": f"Install requirements-lidar.txt in the external downloader environment: {exc}"}
    except Exception as exc:
        result = {"ok": False, "detail": str(exc)}
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
