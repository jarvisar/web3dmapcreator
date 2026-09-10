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
    from .lidar_downloads import prefetch_source, DEFAULT_DOWNLOAD_WORKERS, MAX_DOWNLOAD_WORKERS, validate_download_workers
    from .lidar_worker import cache_owner, watch_parent
    from .lidar_progress import ProgressReporter
except ImportError:
    from lidar_records import validate_records, finite_number
    from lidar_downloads import prefetch_source, DEFAULT_DOWNLOAD_WORKERS, MAX_DOWNLOAD_WORKERS, validate_download_workers
    from lidar_worker import cache_owner, watch_parent
    from lidar_progress import ProgressReporter


def valid_checkpoint(cached, identifiers, source_url):
    """A damaged checkpoint is disposable; unaffected batches still resume."""
    if not isinstance(cached, dict) or not all(isinstance(cached.get(key), dict)
            for key in ('records', 'reasons', 'rejected', 'info', 'observations')):
        return False
    if cached['info'].get('url') != source_url:
        return False
    classified = cached['info'].get('classified_roof_fraction', 0)
    if not finite_number(classified) or not 0 <= classified <= 1:
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


def prepare(bundle, request, refresh=False, progress_path=None, download_workers=DEFAULT_DOWNLOAD_WORKERS):
    download_workers = validate_download_workers(download_workers)
    with cache_owner(bundle.parent):
        return _prepare(bundle, request, refresh, progress_path, download_workers)


def _prepare(bundle, request, refresh, progress_path, download_workers):
    from pyproj import CRS, Transformer
    from shapely.geometry import box, shape
    from shapely.ops import transform as map_geometry
    from lidar_ept import Fetcher, CATALOG_URL, BudgetExceeded
    from lidar_acquisition import (discover_sources, read_source, source_audit, TNM_URL,
                                   building_tile_plan, batch_source, tile_audit)
    from lidar_ranking import AcquisitionPlan, ACQUISITION_VERSION, FALLBACK_POLICY_VERSION, selection_thresholds
    from lidar_batches import building_batches, batch_bounds, split_batch
    from lidar_measurements import measure_features
    from lidar_selection import choose_measurement, project_year, POLICY, CONTRADICTIONS
    from shapely import STRtree

    if request["algorithm"] != 7:
        raise ValueError("Unsupported LiDAR algorithm version")
    if request.get('acquisition') != ACQUISITION_VERSION:
        raise ValueError('Unsupported LiDAR acquisition version; prepare with the updated add-on')
    if request.get('fallback_policy') != FALLBACK_POLICY_VERSION:
        raise ValueError('Unsupported LiDAR fallback policy; prepare with the updated add-on')
    # Fallback admission changes public result identity, not independent survey
    # measurements. Preserve matching pre-policy checkpoints without new reads.
    checkpoint_request = {key: value for key, value in request.items() if key != 'fallback_policy'}
    thresholds = selection_thresholds(request.get('acquisition_thresholds'))
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
    alternatives, observations, resolved = {}, {}, set()
    geographic_geometries = {f['id']: shape(f['geometry']) for f in features}
    def collect(records, evidence, source, info):
        for identifier, record in records.items():
            record.update(source=source['name'], source_url=source['url'],
                          source_format=source['format'],
                          classified_roof_fraction=info.get('classified_roof_fraction', 0),
                          project_year_hint=project_year(source['name']))
            alternatives.setdefault(identifier, []).append(record)
        for identifier, observation in evidence.items():
            observations.setdefault(identifier, []).append({**observation, 'source':source['name']})
        for identifier in records:
            record, _ = choose_measurement(alternatives[identifier], observations.get(identifier, ()),
                geographic_geometries[identifier], prefer_lidar=request.get('prefer_lidar', True))
            if record:
                resolved.add(identifier)
    checkpoints = bundle / 'lidar_jobs'
    checkpoints.mkdir(exist_ok=True)
    total_candidates = sum(shape(f['geometry']).intersects(box(*bbox)) for f in features)
    reporter = ProgressReporter(progress_path)
    def progress(message):
        reporter(message, accepted=len(alternatives), candidates=total_candidates)
    fetch.progress = progress
    sources, discovery_failures = discover_sources(fetch, query, request['source_url'],
        request.get('manifest_url', ''), progress, thresholds=thresholds)
    failures.extend(discovery_failures)
    plan = AcquisitionPlan(sources, [f for f in features if geographic_geometries[f['id']].intersects(box(*bbox))],
                           geographic_geometries, thresholds)
    while True:
        work = plan.next(resolved)
        for candidate in sources:
            skipped = dict(Counter(plan.skipped.get(candidate['url'], {}).values()))
            if skipped and skipped != candidate.get('skipped_fallback_reasons'):
                candidate['skipped_fallback_reasons'] = skipped
                progress(f"Avoided {candidate['format']} fallback for {sum(skipped.values())} buildings in "
                         f"{candidate['name']}: " + '; '.join(f'{count} {reason}' for reason, count in sorted(skipped.items())))
        if work is None:
            break
        source, candidates, reason = work
        source['acquired_buildings'] = source.get('acquired_buildings', 0) + len(candidates)
        source.setdefault('acquisition_reasons', []).append(reason)
        progress(f"Selected {source['format']} {source['name']}: {len(candidates)} unresolved buildings; {reason}")
        def batch_job(batch):
            batch_query = map_geometry(to_geographic, box(*batch_bounds(batch, geometries, selected))).bounds
            job_key = hashlib.sha256(json.dumps([checkpoint_request, source['url'], source.get('fingerprint', ''),
                source.get('metadata_fingerprint', ''), source.get('survey_metadata', {}),
                sorted(f['id'] for f in batch)], sort_keys=True).encode()).hexdigest()
            checkpoint = checkpoints / (job_key+'.json')
            cached = None
            if checkpoint.is_file() and not refresh:
                try:
                    cached = json.loads(checkpoint.read_text(encoding='utf-8'))
                    if not valid_checkpoint(cached, {f['id'] for f in batch}, source['url']):
                        cached = None
                except (OSError, ValueError, TypeError):
                    cached = None
            return batch, batch_query, checkpoint, cached

        jobs = [batch_job(batch) for batch in building_batches(candidates, geometries)]
        tiles = building_tile_plan(source, candidates, geometries, to_geographic, selected) if source['format'] == 'LAZ' else {}
        pending = [f for job in jobs if job[3] is None for f in job[0]]
        pending_source = batch_source(source, pending, tiles)
        if source['format'] == 'LAZ':
            audit = tile_audit(tiles, pending, {f['id']: plan.selection_reasons[f['id'], source['url']] for f in pending})
            source.setdefault('selected_tiles', []).extend(audit)
            progress(f"LAZ footprint selection: {len(audit)}/{len(source['tiles'])} tiles for {len(pending)} buildings without checkpoints")
            for entry in audit:
                progress(f"Selected LAZ tile {entry['url']}: {len(entry['footprints'])} footprints, "
                         f"{len(entry['ground_halos'])} ground halos; " + '; '.join(entry['reasons']))
        with prefetch_source(fetch, pending_source, [job[1] for job in jobs if job[3] is None], workers=download_workers) as source_fetch:
            while jobs:
                batch, batch_query, checkpoint, cached = jobs.pop(0)
                progress(f"Comparing {len(alternatives)} measured buildings; {len(jobs)+1} groups left in {source['name']}")
                batch_roi = map_geometry(to_metric, box(*batch_query))
                if cached is not None:
                    plan.observe(source, batch, cached['records'], cached['rejected'], cached['info'])
                    collect(cached['records'], cached['observations'], source, cached['info'])
                    counts.update(cached['reasons'])
                    rejected.update(cached['rejected'])
                    provenance.append(cached['info'])
                    continue
                try:
                    points, info = read_source(source_fetch, batch_source(source, batch, tiles), batch_query)
                except BudgetExceeded as exc:
                    split = split_batch(batch, geometries)
                    # Spatial subdivision can resolve point/node limits, but
                    # cannot manufacture more total download budget.
                    if split and 'byte' not in str(exc).lower() and 'response' not in str(exc).lower():
                        jobs[0:0] = [batch_job(child) for child in split]
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
                plan.observe(source, batch, records, rejected_features, info)
                collect(records, evidence, source, info)
                counts.update(reasons)
                rejected.update(rejected_features)
                info = {**info, "name": source["name"], "accepted": len(records), 'bbox': list(batch_query)}
                provenance.append(info)
                temporary = checkpoint.with_suffix('.partial')
                temporary.write_text(json.dumps({'records': records, 'reasons': reasons,
                    'rejected': rejected_features, 'info': info, 'observations':evidence}, allow_nan=False), encoding='utf-8')
                temporary.replace(checkpoint)
                del points
    for source in sources:
        if not source.get('acquired_buildings'):
            progress(f"Skipped {source['format']} {source['name']}: no unresolved buildings requiring this source")
    if failures and not provenance:
        raise ValueError("; ".join(item["reason"] for item in failures))
    selection = {}
    for identifier, candidates in alternatives.items():
        record, audit = choose_measurement(candidates, observations.get(identifier, ()), geographic_geometries[identifier],
                                          prefer_lidar=request.get('prefer_lidar', True))
        selection[identifier] = audit
        if record:
            measured[identifier] = {**record, 'selection':audit}
        else:
            rejected[identifier] = audit['reason']
            counts[audit['reason']] += 1
    # Observation counts may include several surveys and buildings recovered by
    # another survey. User-facing skip counts must describe final rejections.
    rejected = {key: reason for key, reason in rejected.items() if key not in measured}
    rejection_counts = dict(Counter(rejected.values()))
    conflict_buildings = sum(
        (reason in CONTRADICTIONS or reason in ('newer_or_same_age_conflict',
         'conflicting_surveys_unknown_order', 'newer_survey_building_changed'))
        for reason in rejected.values())
    validate_records(measured)
    payload = {"format": 1, "request": request, "buildings": measured,
               "sources": provenance, "failures": failures, "counts": dict(counts),
               "rejected": rejected, 'rejection_counts': rejection_counts,
               "prepared_at_utc": datetime.now(timezone.utc).isoformat(),
               "catalog": CATALOG_URL, "catalogs": [CATALOG_URL, TNM_URL],
               'discovered_sources': source_audit(sources), "source_selection": POLICY,
               'acquisition_selection': {'version': ACQUISITION_VERSION, 'thresholds': thresholds,
                   'fallback_policy': FALLBACK_POLICY_VERSION,
                   'policy': 'practical EPT; footprint/ground-halo LAZ tiles for material advantages or data gaps; same-survey LAZ only for EPT delivery gaps'},
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
            "sources": provenance, "counts": dict(counts), 'rejection_counts': rejection_counts, "failures": failures,
            "bytes_read": fetch.bytes, "prepared_at_utc": payload["prepared_at_utc"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument('--progress', type=Path)
    parser.add_argument('--parent-pid', type=int)
    parser.add_argument('--download-workers', type=int, choices=range(1, MAX_DOWNLOAD_WORKERS+1),
                        default=DEFAULT_DOWNLOAD_WORKERS, metavar=f'1-{MAX_DOWNLOAD_WORKERS}')
    args = parser.parse_args()
    try:
        if args.parent_pid:
            watch_parent(args.parent_pid)
        result = prepare(args.bundle, json.loads(args.request.read_text(encoding="utf-8")),
                         args.refresh, args.progress, args.download_workers)
    except ImportError as exc:
        result = {"ok": False, "detail": f"Install requirements-lidar.txt in the external downloader environment: {exc}"}
    except Exception as exc:
        result = {"ok": False, "detail": str(exc)}
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
