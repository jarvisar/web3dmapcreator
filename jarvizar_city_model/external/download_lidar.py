"""Acquire bounded LiDAR for the selected buildings and atomically cache measurements.

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
from contextlib import ExitStack
try:
    from .lidar_rock import rock_features
    from .lidar_footprint import select_footprints
except ImportError:
    from lidar_rock import rock_features
    from lidar_footprint import select_footprints
try:
    from .lidar_records import ALGORITHM_VERSION, RESULT_FILE, RESULT_FORMAT_VERSION, validate_records, finite_number
    from .lidar_downloads import prefetch_source, DEFAULT_DOWNLOAD_WORKERS, MAX_DOWNLOAD_WORKERS, validate_download_workers
    from .lidar_worker import cache_owner, watch_parent
    from .lidar_progress import ProgressReporter
    from .lidar_offer import approved_offers, offer_token
    from .lidar_reuse import reusable_prepared, summarize_prepared, source_generation, batch_identity, atomic_json
    from .lidar_point_cache import PointBatchCache
    from .lidar_storage import CacheStorage, DEFAULT_CACHE_GIB, DEFAULT_FREE_GIB
except ImportError:
    from lidar_records import ALGORITHM_VERSION, RESULT_FILE, RESULT_FORMAT_VERSION, validate_records, finite_number
    from lidar_downloads import prefetch_source, DEFAULT_DOWNLOAD_WORKERS, MAX_DOWNLOAD_WORKERS, validate_download_workers
    from lidar_worker import cache_owner, watch_parent
    from lidar_progress import ProgressReporter
    from lidar_offer import approved_offers, offer_token
    from lidar_reuse import reusable_prepared, summarize_prepared, source_generation, batch_identity, atomic_json
    from lidar_point_cache import PointBatchCache
    from lidar_storage import CacheStorage, DEFAULT_CACHE_GIB, DEFAULT_FREE_GIB


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


def prepare(bundle, request, refresh=False, progress_path=None, download_workers=DEFAULT_DOWNLOAD_WORKERS, laz_approval='', cache_gib=DEFAULT_CACHE_GIB, free_gib=DEFAULT_FREE_GIB, measure_workers=1):
    download_workers = validate_download_workers(download_workers)
    with cache_owner(bundle.parent), ExitStack() as resources:
        storage = CacheStorage(bundle.parent, cache_gib, free_gib)
        return _prepare(bundle, request, refresh, progress_path, download_workers, laz_approval, resources, storage,
                        measure_workers=measure_workers)


def _prepare(bundle, request, refresh, progress_path, download_workers, laz_approval='', resources=None, storage=None, measure_workers=1):
    reporter = ProgressReporter(progress_path)
    reporter('Checking prepared results and input settings', stage='Checking cache', completed=0, total=0, force=True)
    # Imported here, not at the top: the native dependencies stay optional
    # until a preparation runs, and tests patch these modules' functions,
    # which a module-level import would have bound before the patch.
    from pyproj import CRS, Transformer
    from shapely.geometry import box, shape
    from shapely.ops import transform as map_geometry
    from lidar_ept import Fetcher, CATALOG_URL, BudgetExceeded
    from lidar_acquisition import (discover_sources, read_source, source_audit,
                                   building_tile_plan, batch_source, tile_audit)
    from lidar_ranking import AcquisitionPlan, ACQUISITION_VERSION, FALLBACK_POLICY_VERSION, selection_thresholds
    from lidar_tiles import shared_tile_features, SELECTION_HALO_M
    from lidar_batches import building_batches, batch_bounds, split_batch
    from lidar_measurements import (measure_features, default_measure_workers, validate_measure_workers,
                                    close_measurement_pool)
    # None means automatic: reconstruction is CPU-bound Python, so the worker
    # process spreads buildings over spare cores. Results are order-identical.
    measure_workers = default_measure_workers() if measure_workers is None else validate_measure_workers(measure_workers)
    if resources is not None:
        resources.callback(close_measurement_pool)
    from lidar_selection import choose_measurement, project_year, POLICY, CONTRADICTIONS
    from shapely import STRtree
    from lidar_candidates import staged, SOURCE_FIELDS, discovery_settings

    if request["algorithm"] != ALGORITHM_VERSION:
        raise ValueError("Unsupported LiDAR algorithm version")
    if request.get('roof_mode', 'TERRACES') not in ('TERRACES', 'FACETED', 'HEIGHT_ONLY'):
        raise ValueError('Unknown LiDAR roof reconstruction mode')
    if request.get('acquisition') != ACQUISITION_VERSION:
        raise ValueError('Unsupported LiDAR acquisition version; prepare with the updated add-on')
    if request.get('fallback_policy') != FALLBACK_POLICY_VERSION:
        raise ValueError('Unsupported LiDAR fallback policy; prepare with the updated add-on')
    approved = {o['url']: o for o in approved_offers(bundle, request, laz_approval)}
    laz_offers = []
    # Fallback admission changes public result identity, not independent survey
    # measurements. Preserve matching pre-policy checkpoints without new reads.
    checkpoint_request = {key: value for key, value in request.items() if key != 'fallback_policy'}
    thresholds = selection_thresholds(request.get('acquisition_thresholds'))
    for name, expected in request["footprint_sha256"].items():
        if name not in ("building", "building_part", "land"):
            raise ValueError("Invalid footprint file")
        if hashlib.sha256((bundle / (name + ".geojson")).read_bytes()).hexdigest() != expected:
            raise ValueError("Footprint cache changed during LiDAR preparation")
    if not refresh and not laz_approval:
        reusable = reusable_prepared(bundle, request)
        if reusable is not None:
            reporter('Reused valid prepared LiDAR; no downloads or reconstruction needed',
                     stage='Complete', completed=1, total=1, force=True)
            return summarize_prepared(reusable, reused=True)
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
    halo = selected.buffer(SELECTION_HALO_M)
    query = map_geometry(to_geographic, halo).bounds
    if storage:
        storage.trim()
    fetch = Fetcher(bundle.parent / "lidar_tiles", refresh=refresh)
    fetch.storage = storage
    if storage:
        fetch.decoded_cache.free_reserve = storage.reserve
    fetch.download_workers = download_workers
    if resources is not None:
        resources.callback(fetch.decoded_cache.close)
    features = json.loads((bundle / "building.geojson").read_text(encoding="utf-8"))["features"]
    if request.get('rock_surfaces'):
        if 'land' not in request['footprint_sha256']:
            raise ValueError('Mapped rock surfaces require a signed land cache')
        features.extend(rock_features(json.loads((bundle/'land.geojson').read_text(encoding='utf-8'))['features']))
    for feature in features:
        feature['id'] = str(feature.get('id') or feature.get('properties', {}).get('id') or '')
    geometries = {f['id']: map_geometry(to_metric, shape(f['geometry'])) for f in features}
    geometry_ids = list(geometries)
    tree = STRtree(list(geometries.values()))
    # Keep every footprint in the neighbor index: skipped houses still exclude
    # roof returns from ground fitting for an adjacent eligible building.
    features = [f for f in features if shape(f['geometry']).intersects(box(*bbox))]
    total_candidates = len(features)
    features, footprint_rejected = select_footprints(
        features, geometries, request.get('min_footprint_area_m2', 0.0))
    neighbors_by_id = {key:[geometries[geometry_ids[i]] for i in tree.query(geometry.buffer(30), predicate='intersects')
                            if geometry_ids[i] != key]
                       for key, geometry in ((f['id'], geometries[f['id']]) for f in features)}
    parts_by_parent = {}
    source_parts_by_parent = {}
    for part in json.loads((bundle / 'building_part.geojson').read_text(encoding='utf-8'))['features']:
        parent = str((part.get('properties') or {}).get('building_id') or '')
        if parent and not (part.get('properties') or {}).get('is_underground'):
            geometry = map_geometry(to_metric, shape(part['geometry']))
            parts_by_parent.setdefault(parent, []).append(geometry)
            source_parts_by_parent.setdefault(parent, []).append((part, geometry))
    for feature in features:
        if feature['properties'].get('lidar_surface_kind') != 'rock':
            continue
        domain = geometries[feature['id']]
        feature['properties']['covered_buildings'] = sorted(
            geometry_ids[i] for i in tree.query(domain, predicate='covers')
            if not geometry_ids[i].startswith('rock:') and
            all(domain.covers(g) for g in parts_by_parent.get(geometry_ids[i], ())))
    measured, provenance, failures = {}, [], []
    rejected = dict(footprint_rejected)
    counts = Counter(rejected.values())
    alternatives, observations, resolved = {}, {}, set()
    geographic_geometries = {f['id']: shape(f['geometry']) for f in features}
    def collect(records, evidence, source, info):
        for identifier, record in records.items():
            record['source_metadata'] = {k: source[k] for k in SOURCE_FIELDS if k in source}
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
    cache_stats = {'checkpoint_batches': 0, 'cached_buildings': 0, 'point_batches': 0, 'measured_batches': 0}
    dependencies = []
    def progress(message, **fields):
        reporter(message, accepted=len(resolved), candidates=total_candidates, **cache_stats, **fields)
    fetch.progress = progress
    progress(f'{len(features)}/{total_candidates} eligible; {len(footprint_rejected)} below minimum footprint',
             stage='Selecting buildings', completed=0, total=0, force=True)
    sources, discovery_failures = [], []
    if features:
        progress('Finding available surveys and checking source metadata', stage='Finding surveys', completed=0, total=0, force=True)
        sources, discovery_failures = discover_sources(fetch, query, request['source_url'],
            request.get('manifest_url', ''), progress, thresholds=thresholds,
            discovery=request.get('discovery'), vertical_units=request.get('vertical_units', ''))
    failures.extend(discovery_failures)
    plan = AcquisitionPlan(sources, [f for f in features if geographic_geometries[f['id']].intersects(box(*bbox))],
                           geographic_geometries, thresholds,
                           reviewed={url: set(offer['buildings']) for url, offer in approved.items()})
    def eligible_staged(feature):
        geometry = geometries[feature['id']]
        return (geometry.is_valid and geometry.area >= 4
            and geometry.area >= (request['min_width_mm']/request['xy_scale'])**2
            and halo.covers(geometry.buffer(25))
            and not any((feature.get('properties') or {}).get(k)
                        for k in ('is_underground', 'min_height', 'min_floor')))

    pending_offers = {}
    settings = discovery_settings(**{k: v for k, v in request.get('discovery', {}).items() if k != 'version'})
    phase = 'STREAM'
    while True:
        work = plan.next(resolved, source_format=phase, pending=pending_offers)
        if work is None and phase == 'STREAM':
            phase = 'STAGED'
            progress('EPT / COPC complete; checking optional LAZ / LAS gaps and material upgrades',
                     stage='Checking optional sources', source='', completed=0, total=0, force=True)
            work = plan.next(resolved, source_format=phase, pending=pending_offers)
        for candidate in sources:
            skipped = dict(Counter(plan.skipped.get(candidate['url'], {}).values()))
            if skipped and skipped != candidate.get('skipped_fallback_reasons'):
                candidate['skipped_fallback_reasons'] = skipped
                progress(f"Avoided {candidate['format']} fallback for {sum(skipped.values())} buildings in "
                         f"{candidate['name']}: " + '; '.join(f'{count} {reason}' for reason, count in sorted(skipped.items())))
        if work is None:
            break
        source, candidates, reason = work
        if staged(source):
            # Match the existing measurement preflight and ignore unprintable
            # slivers. A building gap, not empty map acreage, warrants an offer.
            candidates = [f for f in candidates if eligible_staged(f)]
            if not candidates:
                continue
            tiles = building_tile_plan(source, candidates, geometries, to_geographic, selected)
            extras = [f for identifier, f in plan.features.items()
                if not plan.pending_preferred(identifier, source, pending_offers) and source['url'] not in plan.tried[identifier]
                and any(s['url'] == source['url'] for s, _ in plan.orders[identifier])
                and eligible_staged(f) and plan.admission(identifier, source, shared_tiles=True)[0]]
            extras = shared_tile_features(source, extras, tiles, geometries, to_geographic, selected)
            for feature in extras:
                identifier = feature['id']
                plan.tried[identifier].add(source['url'])
                plan.selection_reasons[identifier, source['url']] = plan.admission(identifier, source, shared_tiles=True)[1]
            if extras:
                candidates.extend(extras)
                tiles = building_tile_plan(source, candidates, geometries, to_geographic, selected)
            audit = tile_audit(tiles, candidates,
                {f['id']: plan.selection_reasons[f['id'], source['url']] for f in candidates})
            if not audit:
                continue
            offer = {**{k: source[k] for k in SOURCE_FIELDS if k in source}, 'url': source['url'], 'name': source['name'], 'format': source['format'],
                'fingerprint': source.get('fingerprint', ''),
                'metadata_fingerprint': source.get('metadata_fingerprint', ''),
                'survey_metadata': source.get('survey_metadata', {}),
                'project_year_hint': source.get('project_year_hint'),
                'buildings': sorted(f['id'] for f in candidates), 'tiles': audit,
                'reasons': sorted({plan.selection_reasons[f['id'], source['url']] for f in candidates}),
                'areas': [{'bbox': list(map_geometry(to_geographic, box(*batch_bounds(batch, geometries, selected))).bounds),
                           'buildings': len(batch)} for batch in building_batches(candidates, geometries)]}
            consent = approved.get(source['url'])
            if not (consent and all(consent.get(k) == offer.get(k) for k in
                    ('fingerprint', 'metadata_fingerprint', 'survey_metadata', 'project_year_hint'))
                    and set(offer['buildings']).issubset(consent['buildings'])
                    and set(tiles).issubset(t['url'] for t in consent['tiles'])):
                laz_offers.append(offer)
                for feature in candidates:
                    pending_offers.setdefault(feature['id'], []).append(source)
                progress(f"Optional LAZ available: {len(candidates)} building comparisons, {len(audit)} tiles in {source['name']}; awaiting explicit download choice")
                continue
        source.setdefault('acquisition_reasons', []).append(reason)
        dependency = source_generation(bundle.parent, source, refresh)
        dependencies.append(dependency)
        source_total = len(candidates)
        completed = set()
        progress(f"Selected {source.get('provider', 'LiDAR')} {source['format']} {source['name']}: {len(candidates)} building comparisons; {reason}",
                 stage='Checking survey cache', source=source['name'], completed=0, total=source_total, force=True)
        def batch_job(batch):
            batch_query = map_geometry(to_geographic, box(*batch_bounds(batch, geometries, selected))).bounds
            legacy_key = hashlib.sha256(json.dumps([checkpoint_request, source['url'], source.get('fingerprint', ''),
                source.get('metadata_fingerprint', ''), source.get('survey_metadata', {}),
                sorted(f['id'] for f in batch)], sort_keys=True).encode()).hexdigest()
            job_key = batch_identity(request, source, dependency, batch, batch_query,
                                     parts_by_parent, neighbors_by_id, source_parts_by_parent)
            checkpoint = checkpoints / (job_key+'.json')
            cached = None
            compatible = [checkpoint]
            if dependency['generation'] == 'initial':
                compatible.append(checkpoints / (legacy_key+'.json'))
            for candidate_path in compatible if not refresh else ():
                try:
                    candidate_cache = json.loads(candidate_path.read_text(encoding='utf-8'))
                    identifiers = {f['id'] for f in batch}
                    if (valid_checkpoint(candidate_cache, identifiers, source['url']) and
                            set(candidate_cache['records']) | set(candidate_cache['rejected']) == identifiers):
                        cached = candidate_cache
                        if candidate_path != checkpoint:
                            atomic_json(checkpoint, cached)
                        break
                except (OSError, ValueError, TypeError):
                    pass
            return batch, batch_query, checkpoint, cached

        jobs = [batch_job(batch) for batch in building_batches(candidates, geometries)]
        tiles = building_tile_plan(source, candidates, geometries, to_geographic, selected) if 'tiles' in source else {}
        # Reuse checkpoint evidence before authorizing any new point downloads.
        jobs.sort(key=lambda job: job[3] is None)
        attempted = set()
        trial = {'batches_evaluated': 0, 'recovered_buildings': 0}
        if staged(source):
            source['incremental_acquisition'] = trial
        def evaluate_batch(batch, before):
            completed.update(f['id'] for f in batch)
            progress(f"Checked {len(completed)}/{source_total} buildings in this survey", completed=len(completed), total=source_total)
            if not staged(source):
                return
            trial['batches_evaluated'] += 1
            gained = {f['id'] for f in batch} & (resolved - before)
            trial['recovered_buildings'] += len(gained)
            progress(f"LAZ batch evaluated: {len(gained)}/{len(batch)} newly resolved buildings")
        while jobs:
            if storage:
                storage.release_inputs()
            batch, batch_query, checkpoint, cached = jobs.pop(0)
            attempted.update(f['id'] for f in batch)
            before = set(resolved)
            progress(f"{len(jobs)+1} batches remaining; checking {len(batch)} buildings",
                     stage='Reusing measurements' if cached is not None else 'Loading points',
                     completed=len(completed), total=source_total, force=True)
            batch_roi = map_geometry(to_metric, box(*batch_query))
            if cached is not None:
                cache_stats['checkpoint_batches'] += 1
                cache_stats['cached_buildings'] += len(batch)
                plan.observe(source, batch, cached['records'], cached['rejected'], cached['info'])
                collect(cached['records'], cached['observations'], source, cached['info'])
                counts.update(cached['reasons'])
                rejected.update(cached['rejected'])
                provenance.append(cached['info'])
                evaluate_batch(batch, before)
                continue
            selected_source = batch_source(source, batch, tiles)
            if staged(source):
                audit = tile_audit(tiles, batch, {f['id']: plan.selection_reasons[f['id'], source['url']] for f in batch})
                source.setdefault('selected_tiles', []).extend(audit)
                progress(f"LAZ incremental batch: {len(audit)}/{len(source['tiles'])} tiles for {len(batch)} buildings")
                for entry in audit:
                    progress(f"Selected LAZ tile {entry['url']}: {len(entry['footprints'])} footprints, "
                             f"{len(entry['ground_halos'])} ground halos; " + '; '.join(entry['reasons']))
            try:
                point_cache = PointBatchCache(bundle.parent, selected_source, dependency, batch_query, ACQUISITION_VERSION, storage=storage)
                decoded = point_cache.load() if not refresh else None
                if decoded is not None:
                    points, info = decoded
                    cache_stats['point_batches'] += 1
                    progress(f'Reused {len(points):,} decoded points; preparing roof reconstruction', force=True)
                else:
                    with prefetch_source(fetch, selected_source, [batch_query], workers=download_workers) as source_fetch:
                        points, info = read_source(source_fetch, selected_source, batch_query)
                    if not point_cache.save(points, info):
                        progress('Decoded-point cache could not be saved; preparation continues')
            except BudgetExceeded as exc:
                split = split_batch(batch, geometries)
                # Spatial subdivision can resolve point/node limits, but
                # cannot manufacture more total download budget.
                if split and 'byte' not in str(exc).lower() and 'response' not in str(exc).lower():
                    jobs[0:0] = [batch_job(child) for child in split]
                    continue
                evaluate_batch(batch, before)
                failures.append({'source': source['name'], 'reason': str(exc), 'buildings': len(batch)})
                if 'byte' in str(exc).lower():
                    break
                continue
            except (ValueError, OSError, RuntimeError, KeyError, TypeError, IndexError, AttributeError) as exc:
                evaluate_batch(batch, before)
                failures.append({'source': source['name'], 'reason': str(exc), 'buildings': len(batch)})
                continue
            if len(points):
                points[:, 0], points[:, 1] = to_metric(points[:, 0].copy(), points[:, 1].copy())
            evidence = {}
            cache_stats['measured_batches'] += 1
            def building_progress(position, total, name):
                height_only = request.get('roof_mode') == 'HEIGHT_ONLY'
                action = 'Measuring height' if height_only else 'Reconstructing building'
                message = f'{action} {position+1}/{total}: {name}' if position < total else 'Building batch measured'
                progress(message, stage='Measuring heights' if height_only else 'Reconstructing roofs', completed=len(completed)+position,
                         total=source_total, force=position == total)
            records, reasons, rejected_features = measure_features(batch, points, to_metric, to_geographic,
                request["min_width_mm"] / request["xy_scale"],
                max(0.25, request["min_step_mm"] / request["z_scale"]), batch_roi,
                roof_planes=request.get('roof_planes', True), parts_by_parent=parts_by_parent,
                roof_mode=request.get('roof_mode', 'TERRACES'),
                surface_scale=((request['xy_scale'], request['z_scale'])
                               if request.get('roof_mode') == 'FACETED' else None),
                source_parts_by_parent=source_parts_by_parent,
                observations_out=evidence, neighbors_by_id=neighbors_by_id,
                prefer_lidar=request.get('prefer_lidar', True), progress_callback=building_progress,
                workers=measure_workers)
            grid_recovered = sum('coverage_grid_offset' in record for record in records.values())
            if grid_recovered:
                progress(f"Recovered {grid_recovered} roof measurements with shifted sampling grids; "
                         "unchanged point support, coverage and consistency requirements")
            faceted = sum(r.get('method') == 'faceted_roof' for r in records.values())
            if request.get('roof_mode') == 'FACETED':
                retained = dict(Counter(r['faceted_fallback'] for r in records.values() if r.get('faceted_fallback')))
                progress(f"Detailed roof surfaces: {faceted} fitted; retained existing envelopes: {retained}")
            plan.observe(source, batch, records, rejected_features, info)
            collect(records, evidence, source, info)
            evaluate_batch(batch, before)
            counts.update(reasons)
            rejected.update(rejected_features)
            info = {**info, "name": source["name"], "accepted": len(records), 'bbox': list(batch_query)}
            provenance.append(info)
            checkpoint_data = json.dumps({'records': records, 'reasons': reasons,
                'rejected': rejected_features, 'info': info, 'observations':evidence}, allow_nan=False).encode('utf-8')
            if storage:
                storage.write_bytes(checkpoint, checkpoint_data, managed=False)
            else:
                temporary = checkpoint.with_suffix('.partial')
                temporary.write_bytes(checkpoint_data)
                temporary.replace(checkpoint)
            del points
        source['acquired_buildings'] = len(attempted)
    for source in sources:
        if not source.get('acquired_buildings'):
            progress(f"Skipped {source['format']} {source['name']}: no unresolved buildings requiring this source")
    if failures and not provenance and not laz_offers:
        raise ValueError("; ".join(item["reason"] for item in failures))
    progress('Comparing survey evidence and saving prepared buildings', stage='Saving results', source='', completed=0, total=0, force=True)
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
    payload = {"format": RESULT_FORMAT_VERSION, "request": request, "buildings": measured,
               'cache_stats': cache_stats, 'cache_dependencies': dependencies,
               'laz_offers': laz_offers,
               'laz_offer_token': offer_token(request, laz_offers) if laz_offers else '',
               "sources": provenance, "failures": failures, "counts": dict(counts),
               "rejected": rejected, 'rejection_counts': rejection_counts,
               "prepared_at_utc": datetime.now(timezone.utc).isoformat(),
               "catalog": CATALOG_URL, "catalogs": settings,
               'discovered_sources': source_audit(sources), "source_selection": POLICY,
               'acquisition_selection': {'version': ACQUISITION_VERSION, 'thresholds': thresholds,
                   'fallback_policy': FALLBACK_POLICY_VERSION,
                   'policy': 'automatic EPT/COPC spatial reads; explicit request-bound consent for LAZ/LAS gaps or material upgrades; same-survey staged data only for delivery gaps'},
               'selection':selection, 'observations':observations,
               'compared_sources':len({item['url'] for item in provenance}),
               'conflict_buildings':conflict_buildings,
               "bytes_read": fetch.bytes, "network_requests": fetch.requests}
    payload['candidate_buildings'] = total_candidates
    destination = bundle / RESULT_FILE
    result_data = json.dumps(payload, allow_nan=False).encode('utf-8')
    if storage:
        storage.write_bytes(destination, result_data, managed=False)
    else:
        temporary = destination.with_suffix('.json.partial')
        temporary.write_bytes(result_data)
        temporary.replace(destination)
    progress(f'Prepared {len(measured)} buildings; cached work is ready to reuse', stage='Complete', completed=1, total=1, force=True)
    return summarize_prepared(payload)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument('--progress', type=Path)
    parser.add_argument('--parent-pid', type=int)
    parser.add_argument('--cache-gib', type=int, default=DEFAULT_CACHE_GIB)
    parser.add_argument('--free-gib', type=int, default=DEFAULT_FREE_GIB)
    parser.add_argument('--laz-approval', default='', help='Token from the reviewed gap offer; never enables unrestricted LAZ')
    parser.add_argument('--download-workers', type=int, choices=range(1, MAX_DOWNLOAD_WORKERS+1),
                        default=DEFAULT_DOWNLOAD_WORKERS, metavar=f'1-{MAX_DOWNLOAD_WORKERS}')
    parser.add_argument('--measure-workers', type=int, default=None, metavar='N',
                        help='Reconstruction processes; default uses spare cores (JARVIZAR_LIDAR_MEASURE_WORKERS overrides), 1 is serial')
    args = parser.parse_args()
    try:
        if args.parent_pid:
            watch_parent(args.parent_pid)
        result = prepare(args.bundle, json.loads(args.request.read_text(encoding="utf-8")),
                         args.refresh, args.progress, args.download_workers, args.laz_approval, args.cache_gib, args.free_gib,
                         measure_workers=args.measure_workers)
    except ImportError as exc:
        result = {"ok": False, "detail": f"Install requirements-lidar.txt in the external downloader environment: {exc}"}
    except Exception as exc:
        result = {"ok": False, "detail": str(exc)}
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
