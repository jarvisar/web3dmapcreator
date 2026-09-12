"""Cache reuse must save work without accepting changed or damaged inputs."""
import copy
from datetime import datetime, timedelta, timezone
import importlib
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from jarvizar_city_model.data.cache import Bounds, CacheBundle
from jarvizar_city_model.data.lidar import request_signature
from jarvizar_city_model.external.lidar_reuse import reusable_prepared, source_generation, batch_identity

try:
    import numpy as np
    from shapely.geometry import box, mapping
    from jarvizar_city_model.external.lidar_point_cache import PointBatchCache
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


class PreparedReuseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle = self.root/'bbox'
        self.bundle.mkdir()
        self.now = datetime.now(timezone.utc)
        self.signature = {'algorithm':13, 'xy_scale':.07}
        self.payload = {'format':1, 'request':self.signature, 'buildings':{},
                        'prepared_at_utc':self.now.isoformat(), 'failures':[]}

    def reusable(self):
        (self.bundle/'lidar_buildings.json').write_text(json.dumps(self.payload))
        return reusable_prepared(self.bundle, self.signature, self.now)

    def test_warnings_do_not_repeat_completed_work_but_failed_reads_retry(self):
        self.payload['failures'] = [{'source':'unavailable catalog', 'reason':'timeout', 'buildings':0}]
        self.assertIsNotNone(self.reusable())  # Zero accepted buildings is a valid completed result too.
        for issue in ({'buildings':1}, {'reason':'unknown failure'}):
            self.payload['failures'] = [issue]
            self.assertIsNone(self.reusable())

    def test_age_changed_settings_and_invalid_records_require_work(self):
        for change in ({'prepared_at_utc':(self.now-timedelta(days=2)).isoformat()},
                       {'prepared_at_utc':(self.now+timedelta(hours=1)).isoformat()},
                       {'request':{'algorithm':13,'xy_scale':.14}},
                       {'buildings':{'bad':{'height_m':float('nan'),'tiers':[]}}}):
            previous = self.payload.copy()
            self.payload.update(change)
            self.assertIsNone(self.reusable())
            self.payload = previous
        self.assertIsNotNone(self.reusable())

    def test_refresh_invalidates_older_derived_results_and_corrupt_generation_recovers(self):
        source = {'url':'https://example.org/ept.json', 'format':'EPT'}
        dependency = source_generation(self.root, source)
        self.payload['cache_dependencies'] = [dependency]
        self.assertIsNotNone(self.reusable())
        refreshed = source_generation(self.root, source, refresh=True)
        self.assertNotEqual(dependency, refreshed)
        self.assertIsNone(self.reusable())
        path = self.root/'lidar_derived'/dependency['source']/'generation.json'
        path.write_text('broken')
        repaired = source_generation(self.root, source)
        self.assertNotEqual(repaired, refreshed)


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class DerivedReuseTests(unittest.TestCase):
    def test_measurement_progress_counts_rejections_as_processed_work(self):
        from jarvizar_city_model.external.lidar_measurements import measure_features
        features=[{'id':'one','properties':{'is_underground':True},'geometry':mapping(box(0,0,20,20))},
                  {'id':'two','properties':{'names':'nonstandard name'},'geometry':mapping(box(50,0,70,20))}]
        updates=[]
        result=measure_features(features,np.empty((0,7)),lambda x,y:(x,y),lambda x,y:(x,y),
            1.,.5,box(-100,-100,200,200),progress_callback=lambda *args:updates.append(args))
        self.assertEqual([u[0] for u in updates],[0,1,2])
        self.assertEqual([u[1] for u in updates],[2,2,2])
        self.assertEqual(len(result[2]),2)

    def test_decoded_cache_is_geographic_revision_bound_and_recovers_from_damage(self):
        with tempfile.TemporaryDirectory() as temp:
            source = {'url':'https://example.org/ept.json','format':'EPT','survey_metadata':{'vertical_units':'m'}}
            dependency = source_generation(temp, source)
            cache = PointBatchCache(temp, source, dependency, (-74,40,-73,41), 4)
            for points in (np.empty((0,7)), np.array([[-73.9,40.1,25,6,1,2020,1.]], dtype=float)):
                self.assertTrue(cache.save(points, {'url':source['url']}))
                loaded, info = cache.load()
                np.testing.assert_array_equal(points, loaded)
                loaded[:,0] = 1000  # Caller projection cannot mutate stored geographic XY.
                np.testing.assert_array_equal(points, cache.load()[0])
            changed = PointBatchCache(temp, {**source,'fingerprint':'new'}, dependency, (-74,40,-73,41), 4)
            self.assertIsNone(changed.load())
            payload = bytearray(cache.path.read_bytes()); payload[-1] ^= 1
            cache.path.write_bytes(payload)
            self.assertIsNone(cache.load())
            self.assertTrue(cache.save(points, {'url':source['url']}))
            cache.metadata.write_text('broken')
            self.assertIsNone(cache.load())

    def test_batch_identity_tracks_local_semantics_not_global_discovery_options(self):
        source = {'url':'https://example.org/ept.json','format':'EPT'}
        feature = {'id':'one','properties':{},'geometry':mapping(box(0,0,20,20))}
        request = {'algorithm':13,'bbox':[0,0,1,1],'xy_scale':.07,'footprint_sha256':{'building':'old'}}
        def key(request=request, feature=feature, parts=None, neighbors=None, source=source):
            return batch_identity(request,source,{'generation':'initial'},[feature],(0,0,1,1),parts or {},neighbors or {},{})
        original = key()
        self.assertEqual(original,key({**request,'footprint_sha256':{'building':'other'},'discovery':{'providers':['new']},'fallback_policy':99}))
        self.assertNotEqual(original,key({**request,'xy_scale':.14}))
        self.assertNotEqual(original,key({**request,'algorithm':14}))
        self.assertNotEqual(original,key({**request,'acquisition':999}))
        self.assertNotEqual(original,key(feature={**feature,'properties':{'height':90}}))
        self.assertNotEqual(original,key(parts={'one':[box(1,1,5,5)]}))
        self.assertNotEqual(original,key(neighbors={'one':[box(20,0,30,20)]}))
        self.assertNotEqual(original,key(source={**source,'vertical_units':'ft'}))


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class WorkerReuseTests(unittest.TestCase):
    def test_worker_reuses_results_batches_and_points_at_the_right_layer(self):
        external = str(Path(__file__).resolve().parents[1]/'jarvizar_city_model/external')
        with patch.object(sys, 'path', [external]+sys.path):
            worker = importlib.import_module('download_lidar')
            acquisition = importlib.import_module('lidar_acquisition')
            measurements = importlib.import_module('lidar_measurements')
            importlib.import_module('lidar_batches')
        with tempfile.TemporaryDirectory() as temp, patch('sys.stderr', io.StringIO()):
            bundle = CacheBundle(Path(temp), Bounds(-74,40,-73.9,40.1))
            bundle.ensure_directory()
            features = [{'id':str(i),'properties':{},'geometry':mapping(box(x,40.04,x+.001,40.041))}
                        for i,x in enumerate((-73.99,-73.92))]
            def write_features():
                bundle.data_path('building').write_text(json.dumps({'features':features}))
            write_features()
            bundle.data_path('building_part').write_text('{"features":[]}')
            source = {'url':'https://example.org/ept.json','name':'survey','format':'EPT','coverage':box(-74,40,-73.9,40.1)}
            points = np.array([[-73.99,40.04,30,6,1,2020,1]],dtype=float)
            progress = []
            def measure(batch, *args, **kwargs):
                callback = kwargs['progress_callback']
                callback(0,len(batch),'roof')
                callback(len(batch),len(batch),'')
                for f in batch:
                    kwargs['observations_out'][f['id']] = {'reason':'height_only','capture_year':2020}
                return {f['id']:{'height_m':30.,'tiers':[]} for f in batch}, {'height_only':len(batch)}, {}
            original_reporter = worker.ProgressReporter.__call__
            def report(reporter, message, **kwargs):
                progress.append(kwargs.copy())
                return original_reporter(reporter,message,**kwargs)
            def stale():
                path = bundle.path/'lidar_buildings.json'
                payload=json.loads(path.read_text());payload['prepared_at_utc']='2000-01-01T00:00:00+00:00'
                path.write_text(json.dumps(payload))
            with patch.object(acquisition,'discover_sources',side_effect=lambda *a,**k:([copy.deepcopy(source)],[{'source':'elsewhere','reason':'unavailable','buildings':0}])) as discover, \
                 patch.object(acquisition,'read_source',side_effect=lambda *a,**k:(points.copy(),{'url':source['url']})) as read, \
                 patch.object(measurements,'measure_features',side_effect=measure) as fit, \
                 patch.object(worker.ProgressReporter,'__call__',report):
                request = request_signature(bundle,.07,.077)
                first = worker.prepare(bundle.path,request)
                self.assertEqual((first['buildings'],read.call_count,fit.call_count),(2,2,2))
                self.assertTrue(worker.prepare(bundle.path,request)['reused_prepared'])
                self.assertEqual(discover.call_count,1)
                # Existing installs only have whole-request checkpoint names.
                # Move the fixture to that schema and require migration/reuse.
                for path in (bundle.path/'lidar_jobs').glob('*.json'):
                    record=json.loads(path.read_text())
                    old_request={k:v for k,v in request.items() if k!='fallback_policy'}
                    key=hashlib.sha256(json.dumps([old_request,source['url'],'','',{},sorted(record['records'])],sort_keys=True).encode()).hexdigest()
                    path.rename(path.with_name(key+'.json'))
                stale()
                replay = worker.prepare(bundle.path,request)
                self.assertEqual(replay['cache_stats']['checkpoint_batches'],2)
                self.assertEqual((read.call_count,fit.call_count),(2,2))
                scaled = request_signature(bundle,.14,.154)
                result = worker.prepare(bundle.path,scaled)
                self.assertEqual(result['cache_stats']['point_batches'],2)
                self.assertEqual((read.call_count,fit.call_count),(2,4))
                features[0]['properties']['height']=40
                write_features()
                edited = request_signature(bundle,.14,.154)
                result = worker.prepare(bundle.path,edited)
                self.assertEqual(result['cache_stats']['checkpoint_batches'],1)
                self.assertEqual((read.call_count,fit.call_count),(2,5))
                worker.prepare(bundle.path,edited,refresh=True)
                self.assertEqual((read.call_count,fit.call_count),(4,7))
                # Switching back cannot resurrect measurements from before Refresh.
                result = worker.prepare(bundle.path,request_signature(bundle,.07,.077))
                self.assertEqual(result['cache_stats']['point_batches'],2)
                self.assertEqual((read.call_count,fit.call_count),(4,9))
                # Height-only preparation reuses acquisitions, but cannot
                # mistake sculpted checkpoints for scalar measurements.
                scalar = request_signature(bundle,.07,.077,roof_mode='HEIGHT_ONLY')
                result = worker.prepare(bundle.path,scalar)
                self.assertEqual(result['cache_stats']['point_batches'],2)
                self.assertEqual((read.call_count,fit.call_count),(4,11))
                self.assertEqual(fit.call_args.kwargs['roof_mode'],'HEIGHT_ONLY')
                self.assertFalse(fit.call_args.kwargs['roof_planes'])
                self.assertTrue(worker.prepare(bundle.path,request_signature(bundle,.14,.154,
                    roof_mode='HEIGHT_ONLY',roof_planes=False))['reused_prepared'])
                self.assertEqual((read.call_count,fit.call_count),(4,11))
            stages = {p.get('stage') for p in progress}
            self.assertTrue({'Finding surveys','Reusing measurements','Reconstructing roofs','Complete'} <= stages)
            self.assertTrue(any(p.get('completed')==p.get('total')==2 for p in progress))
