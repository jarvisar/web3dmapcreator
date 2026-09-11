"""Versioned reuse identities; standard library only, including Blender callers."""
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import uuid

try:
    from .lidar_records import validate_records
    from .lidar_candidates import SOURCE_FIELDS
except ImportError:
    from lidar_records import validate_records
    from lidar_candidates import SOURCE_FIELDS

REUSE_VERSION = 1
PREPARED_MAX_AGE_SECONDS = 24 * 60 * 60
MEASUREMENT_FIELDS = ('algorithm', 'acquisition', 'bbox', 'xy_scale', 'z_scale', 'min_width_mm',
                      'min_step_mm', 'roof_planes', 'roof_mode', 'prefer_lidar', 'vertical_units')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False,
                                     separators=(',', ':')).encode()).hexdigest()


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.partial')
    temporary.write_text(json.dumps(value, allow_nan=False), encoding='utf-8')
    temporary.replace(path)


def source_identity(source):
    # Keep normalization and provenance, omit mutable ranking/runtime counters.
    keys = (*SOURCE_FIELDS, 'url', 'format', 'fingerprint', 'metadata_fingerprint',
            'tiles', 'point_allowlists', 'fallback_vertical_units')
    return {key: source[key] for key in keys if key in source}


def source_generation(cache_root, source, refresh=False):
    key = digest([source['url'], source['format']])
    path = Path(cache_root)/'lidar_derived'/key/'generation.json'
    if refresh:
        atomic_json(path, {'generation': uuid.uuid4().hex})
    if path.exists():
        try:
            generation = json.loads(path.read_text(encoding='utf-8'))['generation']
            if not isinstance(generation, str) or not generation:
                raise ValueError('Invalid LiDAR derived-cache generation')
        except (OSError, ValueError, KeyError, TypeError):
            generation = uuid.uuid4().hex
            atomic_json(path, {'generation': generation})
    else:
        generation = 'initial'
    return {'source': key, 'generation': generation}


def batch_identity(request, source, dependency, batch, query, parts, neighbors, source_parts):
    """Only this batch's observations/semantics and reconstruction settings."""
    context = []
    for feature in sorted(batch, key=lambda f: f['id']):
        key = feature['id']
        context.append([feature,
            sorted(g.wkb_hex for g in parts.get(key, ())),
            sorted(g.wkb_hex for g in neighbors.get(key, ())),
            sorted(([f, g.wkb_hex] for f, g in source_parts.get(key, ())), key=digest)])
    return digest([REUSE_VERSION, {k: request.get(k) for k in MEASUREMENT_FIELDS},
                   source_identity(source), dependency, list(query), context])


def reusable_prepared(bundle_path, signature, now=None):
    """Prepare shortcut, not the offline generation validity policy.

    Recheck discovery daily. Retry actual failed building reads immediately;
    unrelated provider warnings do not invalidate a completed local survey.
    """
    bundle_path = Path(bundle_path)
    path = bundle_path/'lidar_buildings.json'
    try:
        if path.stat().st_size > 128 * 1024 * 1024:
            return None
        payload = json.loads(path.read_text(encoding='utf-8'))
        if payload.get('format') != 1 or payload.get('request') != signature:
            return None
        validate_records(payload['buildings'])
        prepared = datetime.fromisoformat(payload['prepared_at_utc'])
        age = ((now or datetime.now(timezone.utc)) - prepared).total_seconds()
        if not 0 <= age < PREPARED_MAX_AGE_SECONDS:
            return None
        if any(f.get('buildings') != 0 for f in payload.get('failures', [])):
            return None
        for dependency in payload.get('cache_dependencies', []):
            key = dependency['source']
            if not isinstance(key, str) or len(key) != 64 or any(c not in '0123456789abcdef' for c in key):
                return None
            revision = bundle_path.parent/'lidar_derived'/key/'generation.json'
            generation = (json.loads(revision.read_text(encoding='utf-8'))['generation']
                          if revision.exists() else 'initial')
            if generation != dependency['generation']:
                return None
        return payload
    except (OSError, ValueError, KeyError, TypeError, AttributeError, IndexError):
        return None


def summarize_prepared(payload, reused=False):
    records = payload['buildings']
    return {'ok': True, 'buildings': len(records),
            'candidate_buildings': payload.get('candidate_buildings', len(records)),
            'infill_buildings': sum(bool(r.get('infill_geometry')) for r in records.values()),
            'part_heights': sum(len(r.get('part_heights', {})) for r in records.values()),
            'estimated_heights_corrected': sum(r.get('source_height_decision', r.get('height_decision')) == 'corrected_estimated_height' for r in records.values()),
            'tiered_buildings': sum(bool(r['tiers']) for r in records.values()),
            'roof_plane_buildings': sum(bool(r.get('roof_surfaces')) and r.get('method') != 'faceted_roof' for r in records.values()),
            'faceted_roof_buildings': sum(r.get('method') == 'faceted_roof' for r in records.values()),
            'compared_sources': payload.get('compared_sources', 0),
            'conflict_buildings': payload.get('conflict_buildings', 0),
            'laz_offers': payload.get('laz_offers', []), 'laz_offer_token': payload.get('laz_offer_token', ''),
            'rejection_counts': dict(Counter(reason for key, reason in payload.get('rejected', {}).items() if key not in records)),
            'failures': payload.get('failures', []), 'counts': payload.get('counts', {}),
            'sources': payload.get('sources', []), 'cache_stats': payload.get('cache_stats', {}),
            'reused_prepared': reused, 'bytes_read': 0 if reused else payload.get('bytes_read', 0),
            'prepared_at_utc': payload.get('prepared_at_utc')}
