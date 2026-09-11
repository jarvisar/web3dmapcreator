"""LiDAR modal lifecycle checks without opening or changing a user window."""
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import bpy
import jarvizar_city_model as addon
from jarvizar_city_model import operators as module
addon.register()
operator=module.JARVIZAR_OT_prepare_lidar

class Driver:
    _running=False
    execute=operator.execute
    modal=operator.modal
    finish=operator.finish
    cleanup=operator.cleanup
    report=Mock()

settings=bpy.context.scene.jarvizar_city_model
settings.lidar_download_workers=8
context=SimpleNamespace(scene=bpy.context.scene,window=object(),screen=SimpleNamespace(areas=[]),window_manager=Mock())
summary={'buildings':10,'candidate_buildings':20,'tiered_buildings':3,'roof_plane_buildings':2,'failures':[],
         'conflict_buildings':7, 'rejection_counts':{'footprint_roof_mismatch':3,
             'observed_ground_in_footprint':2,'roof_extends_outside_footprint':1,'source_height_conflict':1}}
fake_bpy=SimpleNamespace(app=SimpleNamespace(background=False,online_access=True))
with patch.object(module,'bpy',fake_bpy),patch.object(module,'_cache_bundle',return_value=Mock()), \
     patch.object(module,'_lidar_signature',return_value={'algorithm':2}), \
     patch.object(module,'_resolve_downloader',return_value='python'), \
     patch.object(module,'reusable_prepared',return_value=None), \
     patch.object(module,'LidarPreparation') as job_type:
    for cancel in (False,True,'button'):
        job=job_type.return_value;job.reset_mock();job.process.poll.return_value=None;job.result.return_value=summary
        driver=Driver()
        assert driver.execute(context)=={'RUNNING_MODAL'}
        assert job_type.call_args.kwargs['download_workers']==8
        assert settings.lidar_preparing and Driver._running
        job.status.return_value={'message':'Measuring test batch','stage':'Reconstructing roofs','completed':3,'total':10,'elapsed':12,'cached_buildings':2}
        assert driver.modal(context,SimpleNamespace(type='TIMER'))=={'PASS_THROUGH'}
        assert settings.lidar_preparation_status=='Measuring test batch'
        assert abs(settings.lidar_progress-.3)<1e-6
        assert settings.lidar_progress_known and settings.lidar_elapsed_seconds==12
        assert '3/10' in settings.lidar_progress_scope
        context.window_manager.progress_update.assert_called()
        if cancel:
            event = 'ESC'
            if cancel == 'button':
                with patch.object(module,'JARVIZAR_OT_prepare_lidar',Driver):
                    assert module.JARVIZAR_OT_cancel_lidar.execute(None,context)=={'FINISHED'}
                event = 'TIMER'
            assert driver.modal(context,SimpleNamespace(type=event))=={'CANCELLED'}
            job.cancel.assert_called_once()
        else:
            job.process.poll.return_value=0
            assert driver.modal(context,SimpleNamespace(type='TIMER'))=={'FINISHED'}
            assert settings.use_lidar_buildings
            assert '10/20' in settings.lidar_preparation_status
            assert '7 consistency skips' in settings.lidar_preparation_status
            assert '3 roof coverage, 2 ground inside footprints, 1 outside roofs, 1 source/survey conflicts' in settings.lidar_preparation_status
        assert not settings.lidar_preparing and not Driver._running
        context.window_manager.progress_end.assert_called()
    driver=Driver();job.process.poll.return_value=None
    assert driver.execute(context)=={'RUNNING_MODAL'}
    job.process.poll.return_value=0
    with patch.object(module,'_lidar_signature',return_value={'algorithm':3}):
        assert driver.modal(context,SimpleNamespace(type='TIMER'))=={'FINISHED'}
        assert 'previous selection' in settings.lidar_preparation_status
print('LIDAR_MODAL_LIFECYCLE_OK')

# A successfully downloaded legacy tile can still lack CRS metadata. Report
# the actual source problem instead of calling every rejection a download failure.
issue_summary = {**summary, 'failures': [{'source': 'legacy', 'reason': 'LAS header lacks a supported horizontal CRS'}]}
assert operator.finish(Driver(), context, issue_summary) == {'FINISHED'}
assert 'source issues: LAS header lacks a supported horizontal CRS' in settings.lidar_preparation_status
assert 'incomplete downloads' not in settings.lidar_preparation_status

# A failed termination keeps the worker owned and polled until it exits.
with patch.object(module,'bpy',fake_bpy),patch.object(module,'_cache_bundle',return_value=Mock()), \
     patch.object(module,'_lidar_signature',return_value={'algorithm':3}), \
     patch.object(module,'_resolve_downloader',return_value='python'), \
     patch.object(module,'reusable_prepared',return_value=None), \
     patch.object(module,'LidarPreparation') as job_type:
    job=job_type.return_value
    job.process.poll.return_value=None
    driver=Driver()
    assert driver.execute(context)=={'RUNNING_MODAL'}
    job.cancel.side_effect=OSError('worker termination failed')
    assert driver.modal(context,SimpleNamespace(type='ESC'))=={'RUNNING_MODAL'}
    assert settings.lidar_preparing and Driver._running
    assert 'Cancellation failed' in settings.lidar_preparation_status
    job.process.poll.return_value=0
    job.result.return_value=summary
    assert driver.modal(context,SimpleNamespace(type='TIMER'))=={'FINISHED'}
    assert not settings.lidar_preparing and not Driver._running
print('LIDAR_CANCEL_FAILURE_RECOVERY_OK')

# The optional download button carries a reviewed token, bypasses the EPT
# result shortcut, validates current settings, and reuses healthy checkpoints.
settings.force_redownload = True
with patch.object(module, 'bpy', fake_bpy), patch.object(module, '_cache_bundle', return_value=Mock()), \
     patch.object(module, '_lidar_signature', return_value={'algorithm': 9}), \
     patch.object(module, '_resolve_downloader', return_value='python'), \
     patch.object(module, 'approved_offers') as approval, \
     patch.object(module, 'reusable_prepared', return_value=None), \
     patch.object(module, 'LidarPreparation') as job_type:
    driver = Driver()
    driver.laz_approval = 'reviewed-token'
    assert driver.execute(context) == {'RUNNING_MODAL'}
    approval.assert_called_once()
    assert job_type.call_args.kwargs['laz_approval'] == 'reviewed-token'
    assert not job_type.call_args.args[3]  # Refresh must not re-download EPT on consent.
    job_type.return_value.process.poll.return_value = 0
    job_type.return_value.result.return_value = summary
    assert driver.modal(context, SimpleNamespace(type='TIMER')) == {'FINISHED'}
    job_type.reset_mock()
    approval.side_effect = ValueError('LAZ offer changed or is stale')
    assert driver.execute(context) == {'CANCELLED'}
    job_type.assert_not_called()
settings.force_redownload = False
print('LIDAR_EXPLICIT_CONSENT_OK')

# A matching prepared result is usable offline, including unrelated catalog warnings.
payload={'buildings':{'one':{'height_m':30,'tiers':[]}},'candidate_buildings':1,
         'failures':[{'reason':'other provider unavailable','buildings':0}]}
offline_bpy=SimpleNamespace(app=SimpleNamespace(background=False,online_access=False))
with patch.object(module,'bpy',offline_bpy), patch.object(module,'_cache_bundle',return_value=Mock()), \
     patch.object(module,'_lidar_signature',return_value={}), \
     patch.object(module,'reusable_prepared',return_value=payload), \
     patch.object(module,'_resolve_downloader') as downloader, patch.object(module,'LidarPreparation') as job:
    assert Driver().execute(context)=={'FINISHED'}
    assert 'Reused prepared 1/1' in settings.lidar_preparation_status
    downloader.assert_not_called()
    job.assert_not_called()
print('LIDAR_OFFLINE_PREPARED_REUSE_OK')

with patch.object(module,'bpy',fake_bpy),patch.object(module,'_cache_bundle',return_value=Mock()), \
     patch.object(module,'_lidar_signature',return_value={}),patch.object(module,'reusable_prepared',return_value=None), \
     patch.object(module,'_resolve_downloader',return_value='python'),patch.object(module,'LidarPreparation') as job_type:
    driver=Driver()
    assert driver.execute(context)=={'RUNNING_MODAL'}
    job_type.return_value.process.poll.return_value=1
    job_type.return_value.result.side_effect=module.OvertureDownloadError('worker returned no result')
    assert driver.modal(context,SimpleNamespace(type='TIMER'))=={'CANCELLED'}
    assert not settings.lidar_preparing and not Driver._running
    assert 'worker returned no result' in settings.lidar_preparation_status
print('LIDAR_FAILED_WORKER_STATUS_OK')
