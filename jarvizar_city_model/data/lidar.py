"""Small, versioned LiDAR building cache and external-process adapter.

This module is standard-library-only and safe to import inside Blender.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import subprocess
import tempfile
import time
from pathlib import Path
from ..external.lidar_records import (
    ALGORITHM_VERSION, MAX_RESULT_BYTES, RESULT_FILE, RESULT_FORMAT_VERSION, validate_records,
)
from ..external.lidar_downloads import DEFAULT_DOWNLOAD_WORKERS, validate_download_workers
from ..external.lidar_storage import DEFAULT_CACHE_GIB, DEFAULT_FREE_GIB
from ..external.lidar_ranking import ACQUISITION_VERSION, FALLBACK_POLICY_VERSION, selection_thresholds
from ..external.lidar_candidates import discovery_settings
from ..external.lidar_footprint import DEFAULT_MINIMUM_FOOTPRINT_AREA_MM2, minimum_footprint_area_m2


def request_signature(bundle, xy_scale, z_scale, min_width_mm=0.1, min_step_mm=0.05, source_url="", roof_planes=True, prefer_lidar=True, manifest_url="", acquisition_thresholds=None, roof_mode='FACETED', providers=None, stac_urls=(), vertical_units='', rock_surfaces=False, min_footprint_area_mm2=DEFAULT_MINIMUM_FOOTPRINT_AREA_MM2, xy_area_scale=None):
    footprint_area_m2 = minimum_footprint_area_m2(min_footprint_area_mm2,
        xy_scale ** 2 if xy_area_scale is None else xy_area_scale)
    if roof_mode not in ('TERRACES', 'FACETED', 'HEIGHT_ONLY'):
        raise ValueError('Unknown LiDAR roof reconstruction mode')
    if vertical_units not in ('', 'm', 'ft', 'us-ft'):
        raise ValueError('Unknown fallback LiDAR vertical units')
    if roof_mode in ('FACETED', 'HEIGHT_ONLY'):
        # Detailed reconstruction derives its tolerances from model scale and
        # measured support. Keep canonical legacy fields for the acquisition
        # and conservative fallback contract, never saved terrace sliders.
        min_width_mm, min_step_mm = 0.1, 0.05
    if roof_mode == 'HEIGHT_ONLY':
        # Height sampling is in real metres, independent of print/roof detail.
        # Measurements remain reusable; footprint admission above uses the
        # actual print scale and still changes the public selection identity.
        xy_scale, z_scale = .07, .077
        roof_planes, rock_surfaces = False, False
    files = {}
    for name in ("building", "building_part"):
        path = bundle.data_path(name)
        if not path.is_file():
            raise ValueError("Cache buildings and building parts before preparing LiDAR")
        files[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    if rock_surfaces:
        path = bundle.data_path('land')
        if not path.is_file():
            raise ValueError('Cache land data before preparing mapped rock surfaces')
        files['land'] = hashlib.sha256(path.read_bytes()).hexdigest()
    return {"algorithm": ALGORITHM_VERSION, "acquisition": ACQUISITION_VERSION, "bbox": list(bundle.bounds.as_tuple()),
            "footprint_sha256": files, "xy_scale": round(float(xy_scale), 10),
            "z_scale": round(float(z_scale), 10), "min_width_mm": round(float(min_width_mm), 6),
            "min_step_mm": round(float(min_step_mm), 6), "source_url": source_url.strip(),
            'roof_planes': bool(roof_planes), 'prefer_lidar': bool(prefer_lidar),
            'roof_mode': roof_mode,
            'min_footprint_area_m2': footprint_area_m2,
            'rock_surfaces': bool(rock_surfaces),
            'manifest_url': manifest_url.strip(), 'acquisition_thresholds': selection_thresholds(acquisition_thresholds),
            'fallback_policy': FALLBACK_POLICY_VERSION,
            'discovery': discovery_settings(providers, stac_urls), 'vertical_units': vertical_units}


def load_measurements(bundle, signature):
    path = bundle.path / RESULT_FILE
    if not path.is_file():
        return {}, "No prepared LiDAR; using source buildings"
    try:
        if path.stat().st_size > MAX_RESULT_BYTES:
            raise ValueError("LiDAR measurement cache is oversized")
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("Invalid LiDAR cache document")
        if payload.get("format") != RESULT_FORMAT_VERSION or payload.get("request") != signature:
            return {}, "LiDAR cache is stale; prepare again for these footprints/print settings"
        buildings = payload["buildings"]
        validate_records(buildings)
        return buildings, f"LiDAR measurements: {len(buildings)} buildings"
    except (OSError, ValueError, TypeError, KeyError, IndexError) as exc:
        return {}, f"Unreadable LiDAR cache; using source buildings ({exc})"


class LidarPreparation:
    """External job polled by Blender's modal operator, with resumable output.

    Log files avoid pipe-buffer deadlocks. There is no whole-map time limit;
    individual HTTP requests still have a timeout. Cancel preserves completed
    tile and measurement checkpoints and the previous public result.
    """
    def __init__(self, python_path, bundle, signature, refresh=False, download_workers=DEFAULT_DOWNLOAD_WORKERS, laz_approval='', cache_gib=DEFAULT_CACHE_GIB, free_gib=DEFAULT_FREE_GIB):
        download_workers = validate_download_workers(download_workers)
        self.bundle = bundle
        self.started = time.monotonic()
        self.last_progress = {'message': 'Checking prepared LiDAR cache...', 'stage': 'Checking cache'}
        bundle.ensure_directory()
        self.temporary = tempfile.TemporaryDirectory(prefix='lidar_job_', dir=str(bundle.path))
        directory = Path(self.temporary.name)
        self.progress_path = directory / 'progress.json'
        self.stdout_path, self.stderr_path = directory/'stdout.log', directory/'stderr.log'
        request = directory/'request.json'
        request.write_text(json.dumps(signature), encoding='utf-8')
        helper = Path(__file__).resolve().parents[1] / 'external' / 'download_lidar.py'
        command = [str(python_path), str(helper), '--bundle', str(bundle.path),
                   '--request', str(request), '--progress', str(self.progress_path),
                   '--download-workers', str(download_workers), '--parent-pid', str(os.getpid())]
        command.extend(['--cache-gib', str(cache_gib), '--free-gib', str(free_gib)])
        if refresh:
            command.append('--refresh')
        if laz_approval:
            command.extend(['--laz-approval', laz_approval])
        try:
            with self.stdout_path.open('w', encoding='utf-8') as output, self.stderr_path.open('w', encoding='utf-8') as errors:
                self.process = subprocess.Popen(command, stdout=output, stderr=errors,
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        except Exception:
            self.temporary.cleanup()
            raise

    def progress(self):
        return self.status()['message']

    def status(self):
        try:
            payload = json.loads(self.progress_path.read_text(encoding='utf-8'))
            valid = isinstance(payload, dict) and isinstance(payload.get('message'), str)
            if valid:
                valid = all(isinstance(payload.get(k, 0), int) and payload.get(k, 0) >= 0
                            for k in ('completed','total','cached_buildings','point_batches'))
                valid = valid and all(isinstance(payload.get(k, ''), str) for k in ('stage','source'))
                updated = payload.get('updated_at', 0)
                valid = valid and isinstance(updated, (float,int)) and math.isfinite(updated)
            if valid:
                self.last_progress = payload
        except (OSError, ValueError, OverflowError):
            pass
        return {**self.last_progress, 'elapsed': max(0., time.monotonic()-self.started)}

    def result(self):
        from .overture import _last_json_line
        try:
            code = self.process.wait()
            payload = _last_json_line(self.stdout_path.read_text(encoding='utf-8', errors='replace'))
            if code or not payload.get('ok'):
                raise ValueError(payload.get('detail') or self.stderr_path.read_text(encoding='utf-8', errors='replace')[-1000:] or 'LiDAR preparation failed')
            self.bundle.merge_manifest({'lidar': payload})
            return payload
        finally:
            self.temporary.cleanup()

    def cancel(self):
        if self.process.poll() is None:
            if os.name == 'nt':
                # A Windows venv launcher has a separate real Python child.
                try:
                    result = subprocess.run(['taskkill', '/PID', str(self.process.pid), '/T', '/F'],
                        capture_output=True, timeout=10,
                        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                except subprocess.TimeoutExpired as exc:
                    raise OSError('Timed out stopping the LiDAR process tree') from exc
                if result.returncode and self.process.poll() is None:
                    raise OSError('Could not terminate the LiDAR process tree')
            else:
                self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=10)
        self.temporary.cleanup()


def prepare_lidar(python_path, bundle, signature, refresh=False, download_workers=DEFAULT_DOWNLOAD_WORKERS, laz_approval='', cache_gib=DEFAULT_CACHE_GIB, free_gib=DEFAULT_FREE_GIB):
    return LidarPreparation(python_path, bundle, signature, refresh=refresh, download_workers=download_workers,
                            laz_approval=laz_approval, cache_gib=cache_gib, free_gib=free_gib).result()
