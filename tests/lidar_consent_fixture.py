"""Exercise the explicit two-step workflow in existing acquisition regressions."""
from unittest.mock import patch


def prepare_reviewed_laz(worker, bundle, request, **kwargs):
    original = worker.prefetch_source
    def ept_only(fetch, source, *args, **options):
        assert source['format'] == 'EPT', 'LAZ acquisition before user consent'
        return original(fetch, source, *args, **options)
    with patch.object(worker, 'prefetch_source', side_effect=ept_only):
        proposal = worker.prepare(bundle, request, **kwargs)
    if proposal['laz_offers']:
        return worker.prepare(bundle, request, laz_approval=proposal['laz_offer_token'], **kwargs)
    return proposal
