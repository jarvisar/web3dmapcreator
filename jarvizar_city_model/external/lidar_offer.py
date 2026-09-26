"""Request-bound, explicit consent for a finite set of LAS/LAZ gap or upgrade tiles (stdlib)."""
import hashlib
import json

try:
    from .lidar_records import RESULT_FILE
except ImportError:
    from lidar_records import RESULT_FILE


def offer_token(request, offers):
    return hashlib.sha256(json.dumps([request, offers], sort_keys=True,
                                    allow_nan=False).encode()).hexdigest()


def approved_offers(bundle, request, token):
    if not token:
        return []
    try:
        payload = json.loads((bundle / RESULT_FILE).read_text(encoding='utf-8'))
        offers = payload['laz_offers']
        if (payload['request'] == request and offers
                and token == offer_token(request, offers)):
            return offers
    except (OSError, ValueError, KeyError, TypeError):
        pass
    raise ValueError('LAZ offer changed or is stale; prepare EPT again and review the current gaps')


def _tiles_and_size(offer):
    sizes = [t.get('size_bytes') for t in offer['tiles']]
    known = [s for s in sizes if isinstance(s, (int, float)) and s > 0]
    size = f"{sum(known)/1024**2:.1f} MiB" if known else 'size unknown'
    if known and len(known) != len(sizes):
        size += ' + unknown sizes'
    return len(sizes), size


def offer_summary(offers):
    """One line per offered survey, with what the download costs; ``offer_details`` has the rest."""
    lines = []
    for offer in offers:
        tiles, size = _tiles_and_size(offer)
        lines.append(f"{offer.get('provider', 'LiDAR')} / {offer['name']}: "
                     f"{len(offer['buildings'])} buildings, {tiles} tiles, {size}")
        if offer.get('delivery_note'):
            lines.append(offer['delivery_note'])
    return '\n'.join(lines)


def offer_details(offers):
    """Readable areas and known catalog information; never imply guaranteed recovery."""
    lines = []
    for offer in offers:
        lines.append(f"{offer.get('provider', 'LiDAR')} / {offer['name']}: may improve {len(offer['buildings'])} buildings")
        for area in offer['areas']:
            w, s, e, n = area['bbox']
            lines.append(f"Area W/S/E/N: {w:.5f}, {s:.5f}, {e:.5f}, {n:.5f} ({area['buildings']} buildings)")
        lines.append('; '.join(offer['reasons']).replace('_', ' '))
        tiles, size = _tiles_and_size(offer)
        lines.append(f"{tiles} tiles; {size}")
        if offer.get('delivery_note'):
            lines.append(offer['delivery_note'])
        meta = offer.get('survey_metadata', {})
        lines.append('Acquired: ' + str(meta.get('acquisition_start', 'unknown')) +
                     ' to ' + str(meta.get('acquisition_end', 'unknown')))
        if offer.get('project_year_hint') and not meta.get('acquisition_start'):
            lines.append(f"Project year hint: {offer['project_year_hint']} (capture date unverified)")
        for key, label in (('point_spacing_m', 'Spacing (m)'), ('point_density_m2', 'Density (pts/m²)'),
                           ('vertical_rmse_m', 'Vertical RMSE (m)')):
            if key in meta:
                lines.append(f'{label}: {meta[key]}')
        lines.append(offer['url'])
        for key in ('license', 'attribution', 'vertical_datum'):
            if offer.get(key):
                lines.append(f'{key.replace("_", " ").capitalize()}: {offer[key]}')
    return '\n'.join(lines)
