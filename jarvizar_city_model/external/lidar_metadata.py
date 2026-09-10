"""Bounded survey metadata reads; no point-cloud downloads or date guessing.

Accept explicit, unit-bearing JSON fields and FGDC acquisition/quality fields.
Unknown units, confidence levels, ambiguous prose and publication dates stay
unknown. EPT octree span, coordinate quantization and total returns are not
nominal point spacing, accuracy or ground-sampling density.
"""
from calendar import monthrange
from datetime import date
import hashlib
import json
import math
import re
from urllib.parse import parse_qs, quote, urlencode, urlparse
from xml.etree import ElementTree as ET
from xml.parsers import expat

try:
    from .lidar_identity import metadata_identity, merge_identities, common_identity
except ImportError:
    from lidar_identity import metadata_identity, merge_identities, common_identity

METADATA_LIMIT = 4 * 1024 ** 2
MAX_REPORTS = 8
NUMBER_FIELDS = {
    'point_spacing_m': ('point_spacing_m', 'nominal_point_spacing_m', 'point_spacing', 'nominal_point_spacing', 'nominalPulseSpacing', 'pointSpacing'),
    'point_density_m2': ('point_density_m2', 'point_density', 'nominal_point_density', 'pointDensity', 'nominalPulseDensity'),
    'horizontal_rmse_m': ('horizontal_rmse_m', 'rmse_horizontal_m', 'rmseh_m', 'horizontal_rmse'),
    'vertical_rmse_m': ('vertical_rmse_m', 'rmse_vertical_m', 'rmsez_m', 'vertical_rmse'),
    'horizontal_accuracy_m': ('horizontal_accuracy_m', 'horizontal_accuracy'),
    'vertical_accuracy_m': ('vertical_accuracy_m', 'vertical_accuracy'),
    'classification_quality': ('classification_quality',),
}
UNITS = {'m': 1, 'meter': 1, 'meters': 1, 'metre': 1, 'metres': 1,
         'cm': .01, 'centimeters': .01, 'centimetres': .01,
         'ft': .3048, 'feet': .3048, 'foot': .3048,
         'us survey feet': 1200 / 3937}


def positive(value):
    if isinstance(value, bool):
        return None
    try:
        value = float(value)
        return value if math.isfinite(value) and value > 0 else None
    except (TypeError, ValueError):
        return None


def date_interval(value):
    """Preserve year/month precision as bounds, so uncertain years cannot age data."""
    if isinstance(value, bool):
        return None
    match = re.fullmatch(r'(\d{4})(?:-?(\d{2})(?:-?(\d{2}))?)?(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?', str(value).strip())
    if not match:
        return None
    year, month, day = (int(v) if v else None for v in match.groups())
    if not 1990 <= year <= date.today().year:
        return None
    try:
        return (date(year, month or 1, day or 1).isoformat(),
                date(year, month or 12, day or monthrange(year, month or 12)[1]).isoformat())
    except ValueError:
        return None


def normalized_metadata(data):
    if not isinstance(data, dict):
        return {}
    result = {}
    nested = data.get('survey_metadata') or data.get('metadata')
    if isinstance(nested, dict):
        result.update(normalized_metadata(nested))
    for key, aliases in NUMBER_FIELDS.items():
        for alias in aliases:
            raw = data.get(alias)
            if isinstance(raw, dict):
                value = positive(raw.get('value'))
                unit = str(raw.get('unit', '')).lower()
                factor = (1 if unit in ('points/m2', 'points/m^2', 'pts/m2', 'pulses/m2')
                          and key == 'point_density_m2' else UNITS.get(unit) if key.endswith('_m') else None)
                value = value * factor if value is not None and factor is not None else None
                if value is not None and raw.get('basis'):
                    result[key.replace('_m', '_basis')] = str(raw['basis']).lower()
            else:
                # Bare quantities must carry their unit in the field name.
                value = positive(raw) if alias.endswith(('_m', '_m2')) or key == 'classification_quality' else None
                if key == 'classification_quality' and type(raw) in (int, float) and raw == 0:
                    value = 0.0
            if value is not None and (key != 'classification_quality' or value <= 1):
                result[key] = value
                break
    for key in ('horizontal_accuracy_basis', 'vertical_accuracy_basis', 'classification_basis'):
        if isinstance(data.get(key), str) and data[key].strip():
            result[key] = data[key].strip().lower()
    for key in ('ground_class', 'building_class'):
        if isinstance(data.get(key), bool):
            result[key] = data[key]
    classes = data.get('classifications')
    if isinstance(classes, list) and classes:
        try:
            codes = {int(c) for c in classes}
            result.update(ground_class=2 in codes, building_class=6 in codes)
        except (ValueError, TypeError):
            pass
    start = end = None
    for key in ('acquisition_date', 'acquisitionDate', 'acquisition_year', 'capture_date', 'capture_year'):
        interval = date_interval(data.get(key))
        if interval:
            start, end = interval
            break
    first = date_interval(data.get('acquisition_start') or data.get('acquisitionStartDate') or data.get('acquisition_start_date'))
    last = date_interval(data.get('acquisition_end') or data.get('acquisitionEndDate') or data.get('acquisition_end_date'))
    if first and last:
        start, end = first[0], last[1]
    if start and end and start <= end:
        result.update(acquisition_start=start, acquisition_end=end, date_basis='reported acquisition')
    elif last and not first and not start:
        # A reported collection end is useful for recency, but cannot establish
        # a newer acquisition's lower bound or date all individual returns.
        result.update(acquisition_end=last[1], date_basis='reported acquisition end only')
    return result


def aggregate_metadata(records):
    """Use the worst known resolution/quality and the full date range.

    A field is known for a survey only if every contributing report/tile knows
    it. No best-tile claim is promoted to the whole survey.
    """
    if not records:
        return {}
    common = set.intersection(*(set(r) for r in records))
    result = {}
    for key in common:
        values = [r[key] for r in records]
        if key in ('acquisition_start', 'point_density_m2', 'classification_quality', 'ground_class', 'building_class'):
            result[key] = min(values)
        elif key in NUMBER_FIELDS or key == 'acquisition_end':
            result[key] = max(values)
        elif all(v == values[0] for v in values):
            result[key] = values[0]
    return result


def xml_root(data):
    """Accept FGDC's external DTD declaration without resolving any entities.

    Parse declarations before building the tree, including UTF-16 input. A byte
    substring check both rejected harmless DOCTYPEs and missed encoded entities.
    Expat never retrieves the external DTD; custom/parameter entities are refused
    before expansion. Predefined escapes such as &amp; remain ordinary XML text.
    """
    def reject_entity(*args):
        raise ValueError('Survey metadata must not declare or reference custom XML entities')
    def inspect_tag(token):
        # Expat can silently omit undefined attribute entities when a DTD is
        # skipped. Its default handler retains the original start-tag text.
        if token.startswith('<') and not token.startswith(('<!', '<?', '</')):
            for name in re.findall(r'&([^;]+);', token):
                if name not in ('amp', 'lt', 'gt', 'apos', 'quot') and not name.startswith('#'):
                    reject_entity()
    guard = expat.ParserCreate()
    guard.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)
    guard.EntityDeclHandler = reject_entity
    guard.ExternalEntityRefHandler = reject_entity
    guard.SkippedEntityHandler = reject_entity
    guard.DefaultHandler = inspect_tag
    guard.CharacterDataHandler = lambda text: None  # CDATA/text is not markup.
    try:
        guard.Parse(data, True)
    except expat.ExpatError as exc:
        raise ET.ParseError(str(exc)) from exc
    root = ET.fromstring(data)
    for node in root.iter():
        node.tag = node.tag.rsplit('}', 1)[-1]
    return root


def fgdc_metadata(data):
    root = xml_root(data)
    result = {}
    # Dataset time of content is acquisition only when explicitly ground-based.
    period = root.find('idinfo/timeperd')
    if period is not None and re.search(r'ground|acquisition|collection', period.findtext('current', ''), re.I):
        starts = [date_interval(n.text) for n in period.findall('.//begdate') + period.findall('.//caldate')]
        ends = [date_interval(n.text) for n in period.findall('.//enddate') + period.findall('.//caldate')]
        if starts and ends and all(starts) and all(ends):
            result.update(acquisition_start=min(v[0] for v in starts),
                          acquisition_end=max(v[1] for v in ends), date_basis='reported acquisition')
    abstract = root.findtext('idinfo/descript/abstract', '')
    unit_pattern = r'(us survey feet|metres|meters|meter|metre|cm|ft|feet|m)\b'
    # Explicit nominal survey resolution; no arbitrary prose numbers/QL inference.
    match = re.search(r'nominal (?:point|pulse) spacing(?:\s*\(NPS\))?\s*(?:of|is|:|=)?\s*(?:1 point every\s*)?([\d.]+)\s*' + unit_pattern, abstract, re.I)
    if match and positive(match[1]):
        result['point_spacing_m'] = float(match[1]) * UNITS[match[2].lower()]
    match = re.search(r'(?:nominal (?:point|pulse) density|point density)\s*(?:of|is|:|=)?\s*([\d.]+)\s*(?:points|pulses)\s*(?:per|/)\s*(?:square met(?:er|re)|m2|m\^2)', abstract, re.I)
    if match and positive(match[1]):
        result['point_density_m2'] = float(match[1])
    for axis, prefix in (('horizontal', 'horiz'), ('vertical', 'vert')):
        records = []
        for quant in root.findall(f'dataqual/posacc/{prefix}acc/q{prefix}pa'):
            value = positive(quant.findtext(f'{prefix}accv'))
            explanation = quant.findtext(f'{prefix}acce', '')
            # Require the unit attached to this quantitative value; never read
            # units from the map CRS or mistake a specification for a result.
            match = re.search(r'([\d.]+)\s*' + unit_pattern, explanation, re.I)
            if not value or not match or positive(match[1]) != value:
                continue
            value *= UNITS[match[2].lower()]
            confidence = re.search(r'(\d+(?:\.\d+)?)\s*%\s*(?:confidence|confidence level)', explanation, re.I)
            if confidence:
                records.append({f'{axis}_accuracy_m': value, f'{axis}_accuracy_basis': f'{confidence[1]}% confidence'})
            elif re.search(r'\bRMSE\b|root mean square', explanation, re.I):
                records.append({f'{axis}_rmse_m': value})
        result.update(aggregate_metadata(records))
    for attr in root.findall('eainfo/detailed/attr'):
        if attr.findtext('attrlabl', '').strip().lower() == 'classification':
            codes = [n.text for n in attr.findall('attrdomv/edom/edomv')]
            result.update(normalized_metadata({'classifications': codes}))
    return result


def read_report(fetch, url, remaining=None, identities=None):
    """Read direct JSON/XML or TNM's designated S3 best_use_xml directory.

    The directory is listed through S3's API; no LAZ mirror or filename is
    manufactured. Other landing pages remain unknown (no arbitrary crawling).
    """
    parsed = urlparse(url)
    if remaining is None:
        remaining = [MAX_REPORTS]
    if parsed.scheme != 'https':
        raise ValueError('Survey metadata requires HTTPS')
    prefix = parse_qs(parsed.query).get('prefix', [''])[0]
    if parsed.hostname == 'prd-tnm.s3.amazonaws.com' and parsed.path == '/index.html' and prefix:
        prefix = prefix.rstrip('/') + '/best_use_xml/'
        listing = 'https://prd-tnm.s3.amazonaws.com/?' + urlencode({'list-type': 2, 'prefix': prefix, 'max-keys': MAX_REPORTS + 1})
        root = xml_root(fetch.get(listing, limit=METADATA_LIMIT, fresh=True))
        keys = [n.text for n in root.findall('Contents/Key') if n.text and n.text.lower().endswith('.xml')]
        if root.findtext('IsTruncated') == 'true' or len(keys) > MAX_REPORTS:
            raise ValueError('Survey metadata listing exceeds bounded report limit')
        report_urls = ['https://prd-tnm.s3.amazonaws.com/' + quote(key, safe='/') for key in sorted(keys)]
        records = [read_report(fetch, child, remaining, identities) for child in report_urls]
        if identities is not None:
            identities[url] = common_identity([identities.get(child, {}) for child in report_urls])
        return aggregate_metadata(records)
    if not parsed.path.lower().endswith(('.xml', '.json')):
        return {}
    if remaining[0] <= 0:
        raise ValueError('Survey metadata exceeds bounded report limit')
    remaining[0] -= 1
    data = fetch.get(url, limit=METADATA_LIMIT, fresh=True)
    if parsed.path.lower().endswith('.json'):
        document = json.loads(data)
        if identities is not None:
            identities[url] = metadata_identity(document)
        return normalized_metadata(document)
    if identities is not None:
        # Citation links identify this dataset; lineage links may describe other surveys.
        links = xml_root(data).findall('idinfo/citation/citeinfo/onlink')
        identities[url] = merge_identities(*(metadata_identity({'url': n.text or ''}) for n in links))
    return fgdc_metadata(data)


def enrich_sources(fetch, sources, failures, progress):
    """Read small metadata documents once, before any LAZ transfer is scheduled."""
    reports, report_identities = {}, {}
    for source in sources:
        progress(f"Reading {source['format']} survey metadata: {source['name']}")
        members = source.get('tiles', [source])
        urls = sorted({m.get('metadata_url') or m.get('vendorMetaUrl') or '' for m in members} - {''})
        remaining = [MAX_REPORTS]
        for url in urls[:MAX_REPORTS]:
            if url not in reports:
                try:
                    reports[url] = read_report(fetch, url, remaining, report_identities)
                except (ValueError, OSError, RuntimeError, TypeError, KeyError, ET.ParseError) as exc:
                    reports[url] = {}
                    failures.append({'source': url, 'reason': f'Survey metadata unavailable: {exc}', 'buildings': 0})
        records, identities = [], []
        for member in members:
            url = member.get('metadata_url') or member.get('vendorMetaUrl') or ''
            records.append({**reports.get(url, {}), **normalized_metadata(member)})
            identities.append(merge_identities(metadata_identity(member), report_identities.get(url, {})))
        source['survey_metadata'] = {**source.get('survey_metadata', {}), **aggregate_metadata(records)}
        source['survey_identity'] = merge_identities(metadata_identity(source), common_identity(identities))
        if len(urls) > MAX_REPORTS:
            source['metadata_note'] = f'Only {MAX_REPORTS} distinct reports read; incomplete fields remain unknown'
        if source['format'] != 'EPT':
            continue
        meta = None
        try:
            # EPT JSON is reused by read_ept; no hierarchy or LAZ nodes here.
            from pyproj import Transformer
            from shapely.geometry import box
            try:
                from .lidar_ept import ept_coordinate_system
            except ImportError:
                from lidar_ept import ept_coordinate_system
            meta = fetch.json(source['url'], limit=METADATA_LIMIT)
            crs, _, _ = ept_coordinate_system(meta, source['url'], source)
            bounds = meta.get('boundsConforming', meta['bounds'])
            if len(bounds) != 6 or not all(math.isfinite(v) for v in bounds) or bounds[0] >= bounds[3] or bounds[1] >= bounds[4]:
                raise ValueError('Invalid EPT metadata bounds')
            extent = Transformer.from_crs(crs, 4326, always_xy=True).transform_bounds(bounds[0], bounds[1], bounds[3], bounds[4], densify_pts=21)
            if not all(math.isfinite(v) for v in extent):
                raise ValueError('Invalid geographic EPT extent')
            source['coverage'] = source['coverage'].intersection(box(*extent))
            source['horizontal_crs'] = crs.to_string()
            source.setdefault('vertical_datum', meta.get('srs', {}).get('vertical') or 'unknown')
            source['survey_metadata'].update(normalized_metadata(meta))
            source['survey_identity'] = merge_identities(source['survey_identity'], metadata_identity(meta))
            # Dimension presence does not prove that class 2/6 returns exist.
            schema = meta.get('schema', [])
            if schema and 'Classification' not in {d.get('name') for d in schema}:
                source['unusable_reason'] = 'EPT lacks classification dimension'
            source['metadata_fingerprint'] = hashlib.sha256(json.dumps(meta, sort_keys=True).encode()).hexdigest()
        except (ValueError, OSError, RuntimeError, TypeError, KeyError, IndexError, AttributeError) as exc:
            # Failed metadata reads are not evidence that usable points cannot
            # be read. Keep a deterministic fallback, with the failure visible.
            source['metadata_note'] = f'EPT metadata unavailable: {exc}'
            if isinstance(meta, dict) and meta.get('dataType'):
                source['unusable_reason'] = str(exc)
            progress(source['metadata_note'])
