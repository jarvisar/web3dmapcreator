"""Metadata-only acquisition policy. Safe to import in Blender (stdlib only).

Thresholds are deliberately substantial: EPT wins unknown or marginal
comparisons. Dates are reported acquisitions, never publication dates or name hints.
See docs/LIDAR_BUILDINGS.md for units, defaults and request configuration.
"""
from datetime import date
import math
try:
    from .lidar_identity import same_survey
    from .lidar_candidates import streamable, staged
except ImportError:
    from lidar_identity import same_survey
    from lidar_candidates import streamable, staged

ACQUISITION_VERSION = 5
FALLBACK_POLICY_VERSION = 5
# Stop speculative support-gap acquisition after one batch yields no adopted
# measurements. Coverage/delivery gaps and material upgrades remain independent.
MAX_UNPRODUCTIVE_LAZ_BATCHES = 1
# These describe absent support/failed acquisition, not failed reconstruction.
# Unknown rejection reasons conservatively do not justify staged LAZ downloads.
DELIVERY_GAPS = frozenset({'source_read_failed', 'empty_ept_query', 'ept_coverage_gap'})
DATA_GAPS = DELIVERY_GAPS | frozenset({'insufficient_ground',
                      'insufficient_roof_points', 'insufficient_coverage'})
SOURCE_INDEPENDENT_REJECTIONS = frozenset({'invalid_or_small_footprint',
    'elevated_or_underground', 'incomplete_footprint_or_ground_halo'})
DEFAULT_THRESHOLDS = {
    'adequate_coverage': .98,
    'age_difference_years': 5.0,
    'spacing_ratio': 1.5,
    'spacing_difference_m': .25,
    'density_ratio': 2.0,
    'density_difference_m2': 2.0,
    'accuracy_ratio': 2.0,
    'accuracy_difference_m': .10,
    'classification_difference': .25,
}


def selection_thresholds(overrides=None):
    values = dict(DEFAULT_THRESHOLDS)
    if overrides is not None:
        if not isinstance(overrides, dict) or set(overrides) - values.keys():
            raise ValueError('Unknown LiDAR selection threshold')
        values.update(overrides)
    for key, value in values.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f'Invalid LiDAR selection threshold: {key}')
        if value <= 0 or (key.endswith('_ratio') and value <= 1):
            raise ValueError(f'LiDAR selection threshold must be positive (ratios > 1): {key}')
        if key in ('adequate_coverage', 'classification_difference') and value > 1:
            raise ValueError(f'LiDAR selection fraction exceeds 1: {key}')
    return values


def usable(source):
    meta = source.get('survey_metadata', {})
    return not source.get('unusable_reason') and meta.get('ground_class') is not False


def material_advantages(candidate, ept, thresholds):
    """Evidence required to pay for LAZ; like-for-like known metrics only."""
    a, b = candidate.get('survey_metadata', {}), ept.get('survey_metadata', {})
    reasons = []
    if a.get('acquisition_start') and b.get('acquisition_end'):
        gap = (date.fromisoformat(a['acquisition_start']) - date.fromisoformat(b['acquisition_end'])).days
        if gap >= thresholds['age_difference_years'] * 365.25:
            reasons.append('substantially newer acquisition')
    for key, ratio, delta, higher in (
        ('point_spacing_m', 'spacing_ratio', 'spacing_difference_m', False),
        ('point_density_m2', 'density_ratio', 'density_difference_m2', True),
        ('horizontal_rmse_m', 'accuracy_ratio', 'accuracy_difference_m', False),
        ('vertical_rmse_m', 'accuracy_ratio', 'accuracy_difference_m', False),
        ('horizontal_accuracy_m', 'accuracy_ratio', 'accuracy_difference_m', False),
        ('vertical_accuracy_m', 'accuracy_ratio', 'accuracy_difference_m', False),
    ):
        av, bv = a.get(key), b.get(key)
        if av is None or bv is None:
            continue
        # Accuracy at different/unspecified confidence levels is not comparable.
        if 'accuracy' in key:
            basis = key.replace('_m', '_basis')
            if not a.get(basis) or a.get(basis) != b.get(basis):
                continue
        better, worse = (bv, av) if higher else (av, bv)
        if worse >= better * thresholds[ratio] and worse - better >= thresholds[delta]:
            reasons.append(f'materially better {key}')
    if (a.get('ground_class') is True and a.get('building_class') is True
            and (b.get('ground_class') is False or b.get('building_class') is False)):
        reasons.append('ground and building classifications available')
    av, bv = a.get('classification_quality'), b.get('classification_quality')
    if (av is not None and bv is not None and a.get('classification_basis')
            and a.get('classification_basis') == b.get('classification_basis')
            and av - bv >= thresholds['classification_difference']):
        reasons.append('materially better reported classification quality')
    return reasons


def metadata_order(source, thresholds, accuracy_fields):
    """Total deterministic order within a practicality tier; no pairwise cycles."""
    meta = source.get('survey_metadata', {})
    coverage = source.get('catalog_coverage', 0)
    acquisition = meta.get('acquisition_start') or meta.get('acquisition_end') or ''
    ordinal = date.fromisoformat(acquisition).toordinal() if acquisition else 0
    # Resolution is distinct from positional accuracy. Unknowns earn no bonus.
    density, spacing = meta.get('point_density_m2'), meta.get('point_spacing_m')
    # Put nominal spacing and areal density on a consistent bounded scale:
    # spacing s and density 1/s² have equal resolution scores. This is only
    # an ordering score, not an invented reported metric. When both are
    # supplied, the weaker evidence limits the score.
    resolution_scores = []
    if spacing is not None:
        resolution_scores.append(1 / (1 + spacing * spacing))
    if density is not None:
        resolution_scores.append(density / (1 + density))
    resolution = min(resolution_scores, default=0)
    accuracy = sum(1 / (1 + meta[key]) for key in accuracy_fields if key in meta)
    classified = sum(meta.get(key) is True for key in ('ground_class', 'building_class'))
    return (not usable(source), coverage < thresholds['adequate_coverage'],
            -ordinal, -resolution, -accuracy, -classified, -meta.get('classification_quality', 0), -coverage,
            {'EPT': 0, 'COPC': 1}.get(source['format'], 2),
            not source.get('authoritative', False),
            source.get('estimated_bytes') or float('inf'), source['url'])


def rank_sources(sources, thresholds=None, geometry=None):
    """Rank the eligible set, retaining lower ranks only as gap/failure fallbacks.

    Call with sources covering an entire building for local decisions. A partial
    high-quality survey can then win its own area without displacing EPT elsewhere.
    """
    thresholds = selection_thresholds(thresholds)
    # Shared evidence permits comparable within-tier accuracy ordering too.
    # Missing values or mismatched confidence levels do not create a winner.
    metadata = [s.get('survey_metadata', {}) for s in sources if usable(s)]
    accuracy_fields = []
    for key in ('horizontal_rmse_m', 'vertical_rmse_m', 'horizontal_accuracy_m', 'vertical_accuracy_m'):
        if not metadata or not all(key in m for m in metadata):
            continue
        if 'accuracy' in key:
            bases = {m.get(key.replace('_m', '_basis')) for m in metadata}
            if len(bases) != 1 or None in bases:
                continue
        accuracy_fields.append(key)
    ordered = sorted(sources, key=lambda s: metadata_order(s, thresholds, accuracy_fields))
    epts = [s for s in ordered if streamable(s) and usable(s)]
    preferred = epts[0] if epts else None
    def priority(source):
        if not usable(source):
            return 3, source.get('unusable_reason') or 'no ground classification'
        if streamable(source):
            return 1, f"{source['format']} preferred for efficient spatial acquisition"
        if preferred is None:
            return 0, 'no suitable EPT coverage (or COPC)'
        equivalent = next((ept for ept in epts if same_survey(source, ept, geometry)), None)
        if equivalent is not None:
            return 2, f"same survey as {equivalent['format']} ({same_survey(source, equivalent, geometry)}); delivery-gap fallback only"
        reasons = material_advantages(source, preferred, thresholds)
        return (0, '; '.join(reasons)) if reasons else (2, f"{preferred['format']} preferred; staged data reserved for unresolved gaps")
    ordered.sort(key=lambda s: priority(s)[0])  # stable within each tier
    return [(source, priority(source)[1] + ('; official original source (quality ties)' if source.get('authoritative') else '')) for source in ordered]


class AcquisitionPlan:
    """Whole-building ownership with lazy, unresolved-only fallback acquisition.

    Each next() call observes the caller's resolved set. Successful buildings
    never enter another source's batches or LAZ prefetch. Failed attempts advance
    deterministically, even when checkpoints supplied the results.
    """
    def __init__(self, sources, features, geometries, thresholds=None):
        self.sources = {s['url']: s for s in sources}
        self.features = {f['id']: f for f in features}
        self.geometries = geometries
        self.orders, self.tried = {}, {}
        self.thresholds = selection_thresholds(thresholds)
        self.outcomes, self.skipped, self.selection_reasons = {}, {}, {}
        rankings = {}
        for identifier in self.features:
            eligible = tuple(s['url'] for s in sources if usable(s) and s['coverage'].covers(geometries[identifier]))
            # Partial provenance verifies only the covered building, never all
            # buildings sharing a catalog eligibility tuple.
            local_matches = tuple((a, b) for a in eligible for b in eligible
                if staged(self.sources[a]) and streamable(self.sources[b])
                and same_survey(self.sources[a], self.sources[b], geometries[identifier]))
            key = eligible, local_matches
            if key not in rankings:
                rankings[key] = rank_sources([self.sources[url] for url in eligible], thresholds, geometries[identifier])
            self.orders[identifier] = rankings[key]
            self.tried[identifier] = set()

    def observe(self, source, features, records, rejected, info=None):
        """Retain the same rejection evidence for live reads and checkpoint replay."""
        for feature in features:
            identifier = feature['id']
            reason = (
                'measurement_available' if identifier in records
                else rejected.get(identifier) or 'unknown_rejection')
            # Zero retained roof/ground points alone can be a property of the
            # survey. Require an empty EPT hierarchy query to establish a
            # delivery coverage gap, rather than repeating filtered returns.
            if (streamable(source) and reason in DATA_GAPS
                    and (info or {}).get('points') == 0 and (info or {}).get('nodes') == 0):
                reason = 'empty_ept_query'
            elif streamable(source) and reason == 'insufficient_coverage' and (info or {}).get('ept_delivery_gap') is True:
                reason = 'ept_coverage_gap'
            self.outcomes[identifier, source['url']] = reason

    def admission(self, identifier, candidate):
        outcomes = [(source, self.outcomes[identifier, source['url']])
                    for source, _ in self.orders[identifier]
                    if (identifier, source['url']) in self.outcomes]
        for _, reason in outcomes:
            if reason in SOURCE_INDEPENDENT_REJECTIONS:
                return False, f'source-independent rejection: {reason}'
        if not staged(candidate):
            for source, reason in outcomes:
                if (same_survey(candidate, source, self.geometries[identifier])
                        and reason not in DELIVERY_GAPS
                        and not material_advantages(candidate, source, self.thresholds)):
                    return False, 'redundant streamed survey already read successfully; no material upgrade'
            return True, None
        # All attempted EPT deliveries matter, including a lower-ranked mirror.
        # Sparse ground/roof support in successfully read survey returns does not
        # justify downloading those same returns in another container.
        equivalents = [(s, reason) for s, reason in outcomes
                       if streamable(s) and same_survey(candidate, s, self.geometries[identifier])]
        for source, reason in equivalents:
            if reason not in DELIVERY_GAPS:
                return False, f'redundant survey {same_survey(candidate, source, self.geometries[identifier])} already read as {source["format"]}'
        if equivalents:
            return True, 'same-survey streamed delivery gap: ' + ', '.join(sorted({r for _, r in equivalents}))
        # The preferred EPT's evidence governs fallback. A poorer/older EPT
        # returning fewer points cannot turn its predecessor's roof-fit rejection
        # into a coverage gap and thereby unlock every LAZ survey.
        ept = next(((s, reason) for s, reason in outcomes if streamable(s)), None)
        if ept is None:
            return True, None
        source, reason = ept
        advantages = material_advantages(candidate, source, self.thresholds)
        if advantages:
            return True, 'optional material upgrade: ' + '; '.join(advantages)
        if reason in DATA_GAPS:
            return True, f"{source['format']} data gap: {reason}"
        return False, f"{source['format']} rejection is not a data gap: {reason}"

    def upgrade(self, identifier, candidate):
        if not staged(candidate):
            return False
        successes = [s for s, _ in self.orders[identifier]
                     if self.outcomes.get((identifier, s['url'])) == 'measurement_available']
        # Never reopen a building already successfully measured from staged data.
        return bool(successes) and all(streamable(s)
            and not same_survey(candidate, s, self.geometries[identifier])
            and material_advantages(candidate, s, self.thresholds) for s in successes)

    def speculative(self, identifier, candidate):
        """A sparse-support trial has no independent evidence of a delivery gap."""
        if not staged(candidate):
            return False
        ept = next((s for s, _ in self.orders[identifier] if streamable(s)
                    and (identifier, s['url']) in self.outcomes), None)
        if ept is None or material_advantages(candidate, ept, self.thresholds):
            return False
        return self.outcomes[identifier, ept['url']] in DATA_GAPS - DELIVERY_GAPS

    def defer(self, source, features):
        for feature in features:
            identifier = feature['id']
            self.outcomes[identifier, source['url']] = 'speculative_trial_stopped'
            self.skipped.setdefault(source['url'], {})[identifier] = 'LAZ trial produced no adopted measurements; further speculative downloads deferred'

    def next(self, resolved, source_format=None):
        groups, reasons = {}, {}
        for identifier, order in self.orders.items():
            for source, reason in order:
                if identifier in resolved and not self.upgrade(identifier, source):
                    continue
                if source_format and not (
                        (source_format == 'STREAM' and streamable(source)) or
                        (source_format == 'STAGED' and staged(source)) or source['format'] == source_format):
                    continue
                url = source['url']
                if url not in self.tried[identifier]:
                    admitted, explanation = self.admission(identifier, source)
                    if not admitted:
                        self.skipped.setdefault(url, {})[identifier] = explanation
                        continue
                    groups.setdefault(url, []).append(self.features[identifier])
                    selected_reason = explanation or (reason if not self.tried[identifier] else 'fallback after prior source')
                    self.selection_reasons[identifier, url] = selected_reason
                    reasons.setdefault(url, set()).add(selected_reason)
                    break
        if not groups:
            return None
        # Process efficient EPT work before fallback LAZ in disjoint areas.
        url = min(groups, key=lambda u: (not streamable(self.sources[u]),
                                       self.sources[u].get('rank', 0), u))
        for feature in groups[url]:
            self.tried[feature['id']].add(url)
            # If reading fails or its budget prevents completion, acquisition
            # fallback remains available. Completed batches replace this reason.
            self.outcomes[feature['id'], url] = 'source_read_failed'
        return self.sources[url], groups[url], '; '.join(sorted(reasons[url]))
