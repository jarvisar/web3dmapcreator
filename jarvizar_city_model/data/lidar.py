"""Small, versioned LiDAR building cache and external-process adapter.

This module is standard-library-only and safe to import inside Blender.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
from collections import Counter
from pathlib import Path
from ..external.lidar_records import validate_records

FORMAT_VERSION = 1
ALGORITHM_VERSION = 7
ACQUISITION_VERSION = 1


def request_signature(bundle, xy_scale, z_scale, min_width_mm=0.1, min_step_mm=0.05, source_url="", roof_planes=True, prefer_lidar=True, manifest_url=""):
    files = {}
    for name in ("building", "building_part"):
        path = bundle.data_path(name)
        if not path.is_file():
            raise ValueError("Cache buildings and building parts before preparing LiDAR")
        files[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return {"algorithm": ALGORITHM_VERSION, "acquisition": ACQUISITION_VERSION, "bbox": list(bundle.bounds.as_tuple()),
            "footprint_sha256": files, "xy_scale": round(float(xy_scale), 10),
            "z_scale": round(float(z_scale), 10), "min_width_mm": round(float(min_width_mm), 6),
            "min_step_mm": round(float(min_step_mm), 6), "source_url": source_url.strip(),
            'roof_planes': bool(roof_planes), 'prefer_lidar': bool(prefer_lidar),
            'manifest_url': manifest_url.strip()}


def load_measurements(bundle, signature):
    path = bundle.path / "lidar_buildings.json"
    if not path.is_file():
        return {}, "No prepared LiDAR; using source buildings"
    try:
        if path.stat().st_size > 32 * 1024 * 1024:
            raise ValueError("LiDAR measurement cache is oversized")
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("Invalid LiDAR cache document")
        if payload.get("format") != FORMAT_VERSION or payload.get("request") != signature:
            return {}, "LiDAR cache is stale; prepare again for these footprints/print settings"
        buildings = payload["buildings"]
        validate_records(buildings)
        return buildings, f"LiDAR measurements: {len(buildings)} buildings"
    except (OSError, ValueError, TypeError, KeyError, IndexError) as exc:
        return {}, f"Unreadable LiDAR cache; using source buildings ({exc})"


def measurement_summary(bundle):
    """Small user-facing summary of the last prepared result, not a readiness check."""
    payload = json.loads((bundle.path / 'lidar_buildings.json').read_text(encoding='utf-8'))
    records = payload['buildings']
    return {'buildings': len(records), 'candidate_buildings': payload.get('candidate_buildings', len(records)),
            'infill_buildings': sum(bool(r.get('infill_geometry')) for r in records.values()),
            'part_heights': sum(len(r.get('part_heights', {})) for r in records.values()),
            'estimated_heights_corrected': sum(r.get('source_height_decision', r.get('height_decision')) == 'corrected_estimated_height' for r in records.values()),
            'tiered_buildings': sum(bool(r['tiers']) for r in records.values()),
            'roof_plane_buildings': sum(bool(r.get('roof_surfaces')) for r in records.values()),
            'compared_sources': payload.get('compared_sources', 0),
            'conflict_buildings': payload.get('conflict_buildings', 0),
            'rejection_counts': dict(Counter(reason for key, reason in payload.get('rejected', {}).items()
                                            if key not in records)),
            'failures': payload.get('failures', []), 'counts': payload.get('counts', {})}


class LidarPreparation:
    """External job polled by Blender's modal operator, with resumable output.

    Log files avoid pipe-buffer deadlocks. There is no whole-map time limit;
    individual HTTP requests still have a timeout. Cancel preserves completed
    tile and measurement checkpoints and the previous public result.
    """
    def __init__(self, python_path, bundle, signature, refresh=False):
        self.bundle = bundle
        bundle.ensure_directory()
        self.temporary = tempfile.TemporaryDirectory(prefix='lidar_job_', dir=str(bundle.path))
        directory = Path(self.temporary.name)
        self.progress_path = directory / 'progress.json'
        self.stdout_path, self.stderr_path = directory/'stdout.log', directory/'stderr.log'
        request = directory/'request.json'
        request.write_text(json.dumps(signature), encoding='utf-8')
        helper = Path(__file__).resolve().parents[1] / 'external' / 'download_lidar.py'
        command = [str(python_path), str(helper), '--bundle', str(bundle.path),
                   '--request', str(request), '--progress', str(self.progress_path)]
        if refresh:
            command.append('--refresh')
        try:
            with self.stdout_path.open('w', encoding='utf-8') as output, self.stderr_path.open('w', encoding='utf-8') as errors:
                self.process = subprocess.Popen(command, stdout=output, stderr=errors,
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        except Exception:
            self.temporary.cleanup()
            raise

    def progress(self):
        try:
            return json.loads(self.progress_path.read_text(encoding='utf-8')).get('message', '')
        except (OSError, ValueError, AttributeError):
            return 'Finding LiDAR coverage...'

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
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=10)
        self.temporary.cleanup()


def prepare_lidar(python_path, bundle, signature, refresh=False):
    return LidarPreparation(python_path, bundle, signature, refresh).result()
