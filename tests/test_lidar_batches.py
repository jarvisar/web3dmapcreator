"""Acquisition bounds, subdivision, resumption and cancellation contracts."""
import importlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from jarvizar_city_model.data.cache import Bounds, CacheBundle
from jarvizar_city_model.data.lidar import request_signature, LidarPreparation

try:
    import numpy as np
    from shapely.geometry import box, mapping
    from jarvizar_city_model.external.lidar_batches import building_batches, batch_bounds, split_batch
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'optional LiDAR dependencies not installed')
class BatchTests(unittest.TestCase):
    def test_whole_building_ownership_and_bounded_halo(self):
        features = [{'id':str(i)} for i in range(4)]
        geometries = {str(i):box(i*390,0,i*390+60,60) for i in range(4)}
        groups = building_batches(features, geometries)
        self.assertEqual(sorted(f['id'] for group in groups for f in group), ['0','1','2','3'])
        selection = box(0,0,1400,80)
        for group in groups:
            bounds = box(*batch_bounds(group, geometries, selection))
            self.assertTrue(all(bounds.covers(geometries[f['id']].buffer(25)) for f in group))
            self.assertLess(bounds.area, selection.buffer(75).area)
        children = split_batch(features, geometries)
        self.assertEqual([len(c) for c in children], [2,2])
        self.assertFalse(split_batch(features[:1], geometries))

    def test_large_selection_checkpoints_resume_without_cloud_reads(self):
        external = str(Path(__file__).resolve().parents[1]/'jarvizar_city_model/external')
        with patch.object(sys, 'path', [external]+sys.path):
            worker = importlib.import_module('download_lidar')
            ept = importlib.import_module('lidar_ept')
            importlib.import_module('lidar_acquisition')
            measurements = importlib.import_module('lidar_measurements')
            importlib.import_module('lidar_batches')
        with tempfile.TemporaryDirectory() as temp:
            bundle = CacheBundle(Path(temp), Bounds(-74,40,-73.9,40.1))
            bundle.ensure_directory()
            features = [{'id':str(i), 'properties':{}, 'geometry':mapping(box(-73.995+i*.025,40.02,-73.994+i*.025,40.021))} for i in range(4)]
            bundle.data_path('building').write_text(json.dumps({'features':features}))
            bundle.data_path('building_part').write_text('{"features":[]}')
            request = request_signature(bundle,.07,.077,source_url='https://example.com/test/ept.json')
            calls = []
            def read(fetch,url,bbox):
                calls.append(bbox)
                self.assertLess(bbox[2]-bbox[0], .003)
                return np.empty((0,5)), {'url':url,'points':0}
            def measure(features,*args,**kwargs):
                return {f['id']:{'height_m':30,'tiers':[]} for f in features}, {'height_only':len(features)}, {}
            with patch.object(ept,'read_ept',side_effect=read), patch.object(measurements,'measure_features',side_effect=measure):
                first = worker.prepare(bundle.path,request)
                second = worker.prepare(bundle.path,request)
                checkpoint = next((bundle.path/'lidar_jobs').glob('*.json'))
                broken = json.loads(checkpoint.read_text())
                broken['records'] = []
                checkpoint.write_text(json.dumps(broken))
                repaired = worker.prepare(bundle.path,request)
            self.assertEqual(first['buildings'],4)
            self.assertEqual(second['buildings'],4)
            self.assertEqual(repaired['buildings'],4)
            self.assertEqual(len(calls),5)

    def test_refresh_fetches_shared_ancestors_only_once(self):
        import io
        from jarvizar_city_model.external.lidar_ept import Fetcher
        with tempfile.TemporaryDirectory() as temp:
            fetch=Fetcher(Path(temp), refresh=True, max_bytes=4)
            with patch('urllib.request.urlopen',return_value=io.BytesIO(b'roof')) as request:
                self.assertEqual(fetch.get('https://example.com/ancestor'), b'roof')
                self.assertEqual(fetch.get('https://example.com/ancestor'), b'roof')
            self.assertEqual(request.call_count,1)
            self.assertEqual(fetch.bytes,4)

    def test_all_overlapping_surveys_compared_and_best_survives_resume(self):
        external=str(Path(__file__).resolve().parents[1]/'jarvizar_city_model/external')
        with patch.object(sys,'path',[external]+sys.path):
            worker=importlib.import_module('download_lidar')
            ept=importlib.import_module('lidar_ept')
            importlib.import_module('lidar_acquisition')
            measurements=importlib.import_module('lidar_measurements')
            importlib.import_module('lidar_batches')
        with tempfile.TemporaryDirectory() as temp:
            bundle=CacheBundle(Path(temp),Bounds(-74,40,-73.99,40.01));bundle.ensure_directory()
            feature={'id':'one','properties':{},'geometry':mapping(box(-73.999,40.002,-73.998,40.003))}
            bundle.data_path('building').write_text(json.dumps({'features':[feature]}))
            bundle.data_path('building_part').write_text('{"features":[]}')
            request=request_signature(bundle,.07,.077)
            catalog={'features':[{'properties':{'name':f'Project_{i}','url':f'https://example.com/{i}/ept.json'},
                      'geometry':mapping(box(-75,39,-73,41))} for i in range(5)]}
            current=[]
            def read(fetch,url,bbox):
                current.append(int(url.split('/')[-2]))
                return np.empty((0,5)),{'url':url,'points':0}
            def measure(*args,**kwargs):
                i=current[-1]
                if i == 0:
                    return {}, {'footprint_roof_mismatch':1}, {'one':'footprint_roof_mismatch'}
                return {'one':{'height_m':30,'tiers':[],'capture_year':2010+i,'coverage':1,
                               'roof_support_density_m2':2,'explained_fraction':1}}, {'height_only':1}, {}
            with patch.object(ept.Fetcher,'json',side_effect=lambda url, **kw: catalog if url == ept.CATALOG_URL else {'items':[], 'total':0}),patch.object(ept,'read_ept',side_effect=read),\
                 patch.object(measurements,'measure_features',side_effect=measure):
                worker.prepare(bundle.path,request)
                first=json.loads((bundle.path/'lidar_buildings.json').read_text())
                worker.prepare(bundle.path,request)
                second=json.loads((bundle.path/'lidar_buildings.json').read_text())
            self.assertEqual(sorted(current),list(range(5)))
            self.assertEqual(first['compared_sources'],5)
            self.assertEqual(first['buildings']['one']['source'],'Project_4')
            self.assertEqual(first['buildings'],second['buildings'])
            # One survey's rejection is not a skipped building once a usable
            # survey is selected; the resumed result must report the same.
            self.assertEqual(first['counts']['footprint_roof_mismatch'],1)
            for payload in (first,second):
                self.assertEqual(payload['rejected'],{})
                self.assertEqual(payload['rejection_counts'],{})
                self.assertEqual(payload['conflict_buildings'],0)

    def test_malformed_source_does_not_abort_later_surveys(self):
        external=str(Path(__file__).resolve().parents[1]/'jarvizar_city_model/external')
        with patch.object(sys,'path',[external]+sys.path):
            worker=importlib.import_module('download_lidar')
            ept=importlib.import_module('lidar_ept')
            importlib.import_module('lidar_acquisition')
            measurements=importlib.import_module('lidar_measurements')
            importlib.import_module('lidar_batches')
        with tempfile.TemporaryDirectory() as temp:
            bundle=CacheBundle(Path(temp),Bounds(-74,40,-73.99,40.01));bundle.ensure_directory()
            feature={'id':'one','properties':{},'geometry':mapping(box(-73.999,40.002,-73.998,40.003))}
            bundle.data_path('building').write_text(json.dumps({'features':[feature]}))
            bundle.data_path('building_part').write_text('{"features":[]}')
            catalog={'features':[{'properties':{'name':name,'url':f'https://example.com/{name}/ept.json'},
                      'geometry':mapping(box(-75,39,-73,41))} for name in ('2022_broken','2014_good')]}
            def read(fetch,url,bbox):
                if 'broken' in url:raise KeyError('bounds')
                return np.empty((0,5)),{'url':url,'points':0}
            with patch.object(ept.Fetcher,'json',side_effect=lambda url, **kw: catalog if url == ept.CATALOG_URL else {'items':[], 'total':0}),patch.object(ept,'read_ept',side_effect=read),\
                 patch.object(measurements,'measure_features',return_value=({'one':{'height_m':30,'tiers':[]}}, {'height_only':1}, {})):
                result=worker.prepare(bundle.path,request_signature(bundle,.07,.077))
            self.assertEqual(result['buildings'],1)
            self.assertEqual(len(result['failures']),1)
            self.assertEqual(result['failures'][0]['source'],'2022_broken')


class JobTests(unittest.TestCase):
    def test_cancel_preserves_previous_output_and_completed_checkpoints(self):
        with tempfile.TemporaryDirectory() as temp:
            bundle=CacheBundle(Path(temp),Bounds(-74,40,-73,41));bundle.ensure_directory()
            previous=bundle.path/'lidar_buildings.json';previous.write_text('previous')
            checkpoint=bundle.path/'lidar_jobs';checkpoint.mkdir();(checkpoint/'one.json').write_text('completed')
            with patch('subprocess.Popen') as process:
                process.return_value.poll.return_value=None
                job=LidarPreparation('python',bundle,{'algorithm':2})
                temporary=Path(job.temporary.name)
                job.cancel()
                process.return_value.terminate.assert_called_once()
            self.assertFalse(temporary.exists())
            self.assertEqual(previous.read_text(),'previous')
            self.assertEqual((checkpoint/'one.json').read_text(),'completed')

    def test_cancel_reaps_worker_that_does_not_terminate_promptly(self):
        import subprocess
        with tempfile.TemporaryDirectory() as temp:
            bundle=CacheBundle(Path(temp),Bounds(-74,40,-73,41));bundle.ensure_directory()
            with patch('subprocess.Popen') as process:
                process.return_value.poll.return_value=None
                process.return_value.wait.side_effect=[subprocess.TimeoutExpired('worker',10),0]
                job=LidarPreparation('python',bundle,{'algorithm':3})
                directory=Path(job.temporary.name)
                job.cancel()
                process.return_value.kill.assert_called_once()
                self.assertEqual(process.return_value.wait.call_count,2)
            self.assertFalse(directory.exists())
