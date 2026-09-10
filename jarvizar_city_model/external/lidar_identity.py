"""Conservative survey identity across delivery formats (stdlib only).

Use scoped dataset/project identifiers and verified original assets, never
generic tile filenames, overlapping bounds, titles, or publication dates. Keep
years and subprojects in identifiers; a parent programme is not a survey.
"""
import re
from urllib.parse import parse_qs, unquote, urlparse


def project_key(value):
    return re.sub(r'[\s-]+', '_', str(value).strip().casefold())


def original_asset_id(authority, name):
    """Recognized official acquisition identifiers retained by delivery mirrors.

    These schemas include a survey/lot and capture interval/year, not only a
    reusable map-grid name. Callers must verify the publishing authority.
    """
    name = name.removesuffix('.copc.laz') + '.laz' if name.endswith('.copc.laz') else name
    patterns = {
        'ea': r'[A-Z]{2}\d{4}_P_\d+(?:_\d+)*_\d{8}_\d{8}\.laz',
        'pnoa': r'PNOA_\d{4}_.+_\d+-\d+_ORT-CLA-(?:RGB|CIR|COL)\.laz',
    }
    if authority in patterns and re.fullmatch(patterns[authority], name, re.I):
        return authority + ':' + name.casefold()
    return None


def usgs_project(url):
    """Read the survey key from known USGS delivery/metadata namespaces."""
    parsed = urlparse(url)
    if parsed.scheme == 's3' and parsed.netloc == 'usgs-lidar':
        # An EPT provenance location, not a URL to manufacture or download.
        parts = unquote(parsed.path).strip('/').split('/')
        if len(parts) >= 4 and parts[0] == 'Projects' and parts[-2].lower() in ('laz', 'las'):
            return project_key(parts[-3])
    if parsed.scheme != 'https':
        return None
    host = parsed.hostname or ''
    parts = unquote(parsed.path).strip('/').split('/')
    if host in ('s3-us-west-2.amazonaws.com', 's3.us-west-2.amazonaws.com', 's3.amazonaws.com'):
        if len(parts) == 3 and parts[0] == 'usgs-lidar-public' and parts[-1] == 'ept.json':
            return project_key(parts[1])
    if host in ('usgs-lidar-public.s3.amazonaws.com', 'usgs-lidar-public.s3.us-west-2.amazonaws.com'):
        if len(parts) == 2 and parts[-1] == 'ept.json':
            return project_key(parts[0])
    if host == 'prd-tnm.s3.amazonaws.com' and parsed.path == '/index.html':
        prefix = parse_qs(parsed.query).get('prefix', [''])[0].rstrip('/')
        if prefix.startswith('StagedProducts/Elevation/metadata/'):
            return project_key(prefix.rsplit('/', 1)[-1])
    if host.endswith('.usgs.gov') or host == 'prd-tnm.s3.amazonaws.com':
        lower = [p.casefold() for p in parts]
        for i, part in enumerate(lower):
            if part in ('laz', 'las') and i >= 2 and 'projects' in lower[:i-1]:
                return project_key(parts[i-1])
    return None


def merge_identities(*identities):
    return {key: sorted({value for identity in identities if isinstance(identity, dict)
                        for value in (identity.get(key) if isinstance(identity.get(key), list) else [])
                        if isinstance(value, str) and value})
            for key in ('projects', 'datasets', 'evidence')}


def metadata_identity(data):
    """Explicit JSON identifiers require an authority; tile sourceId is excluded."""
    if not isinstance(data, dict):
        return {}
    result = merge_identities(data.get('survey_identity') or {})
    for key in ('survey_metadata', 'metadata'):
        result = merge_identities(result, metadata_identity(data.get(key)))
    authority = data.get('identity_authority') or data.get('provider')
    if isinstance(authority, str) and authority.strip() and not data.get('identity_is_delivery'):
        authority = project_key(authority)
        for category, aliases in (
                ('projects', ('project_id', 'projectId', 'project_identifier')),
                ('datasets', ('dataset_id', 'datasetId', 'survey_id', 'surveyId'))):
            for alias in aliases:
                value = data.get(alias)
                if isinstance(value, str) and value.strip():
                    result[category].append(f'{authority}:{project_key(value)}')
                    result['evidence'].append(f'{authority} {alias}={value}')
    for key in ('url', 'downloadURL', 'metadata_url', 'vendorMetaUrl', 'path'):
        url = data.get(key)
        if isinstance(url, str):
            project = usgs_project(url)
            if project:
                result['projects'].append('usgs:' + project)
                # Project-level locations are evidence; discard tile filenames.
                evidence = url.rsplit('/', 1)[0] + '/' if urlparse(url).path.lower().endswith(('.laz', '.las')) else url
                result['evidence'].append(evidence)
    return merge_identities(result)


def common_identity(members):
    """Do not promote one identified tile to an unidentified/mixed survey."""
    if not members:
        return {}
    result = merge_identities(*members)
    for key in ('projects', 'datasets'):
        result[key] = sorted(set.intersection(*(set(m.get(key, [])) for m in members)))
    return result


def possible_duplicate(a, b):
    """Naming hint only. Never supplies confirmed identity or acquisition dates."""
    def tokens(source):
        keys = (source.get('survey_identity') or {}).get('projects', [])
        return [set(re.findall(r'[a-z0-9]+', key.casefold())) - {'usgs', 'lpc', 'las', 'laz', 'ept'} for key in keys]
    return any(len(x & y) >= 3 and (x <= y or y <= x) for x in tokens(a) for y in tokens(b))


def same_survey(a, b, geometry=None):
    """Return matching identity evidence, or None when identity is uncertain.

    Known disjoint acquisition periods or different explicit dataset editions
    defeat a project match. Missing quality/date fields cannot establish identity.
    """
    left, right = merge_identities(a.get('survey_identity')), merge_identities(b.get('survey_identity'))
    am, bm = a.get('survey_metadata', {}), b.get('survey_metadata', {})
    for first, second in ((am, bm), (bm, am)):
        if first.get('acquisition_end') and second.get('acquisition_start'):
            if first['acquisition_end'] < second['acquisition_start']:
                return None
    ld, rd = set(left.get('datasets', [])), set(right.get('datasets', []))
    if ld and rd:
        match = next(iter(sorted(ld & rd)), None)
        if match:
            return match
    # Different explicit editions defeat a project-name match, but independent
    # catalogs can still explicitly reference exactly the same original asset.
    match = None if ld and rd else next(iter(sorted(set(left.get('projects', [])) & set(right.get('projects', [])))), None)
    if match:
        return match
    if geometry is not None:
        for source, other in ((a, b), (b, a)):
            coverage = source.get('provenance_coverage', {}).get(other['url'])
            if coverage is not None and coverage.covers(geometry):
                return 'verified original point-cloud asset/input metadata'
    return None
