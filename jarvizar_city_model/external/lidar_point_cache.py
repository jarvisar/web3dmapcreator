"""Reusable decoded, normalized geographic point batches, never pickled objects."""
import hashlib
import json
from pathlib import Path
import numpy as np
from contextlib import nullcontext

try:
    from .lidar_storage import StorageFull
    from .lidar_reuse import REUSE_VERSION, atomic_json, digest, source_identity
except ImportError:
    from lidar_storage import StorageFull
    from lidar_reuse import REUSE_VERSION, atomic_json, digest, source_identity


class PointBatchCache:
    def __init__(self, root, source, dependency, query, acquisition_version, storage=None):
        self.storage = storage
        self.identity = json.loads(json.dumps([REUSE_VERSION, acquisition_version,
                                    source_identity(source), dependency, list(query)], allow_nan=False))
        self.directory = Path(root)/'lidar_derived'/dependency['source']/'points'
        self.path = self.directory/(digest(self.identity)+'.npy')
        self.metadata = self.path.with_suffix('.json')

    def load(self):
        if self.storage:
            self.storage.touch(self.path)
        try:
            meta = json.loads(self.metadata.read_text(encoding='utf-8'))
            size = self.path.stat().st_size
            if meta['identity'] != self.identity or size != meta['bytes'] or size > 8_000_000*7*8+4096:
                return None
            # mmap avoids retaining both serialized and decoded copies. Copy
            # before the caller projects XY in place; geographic cache is immutable.
            points = np.load(self.path, mmap_mode='r', allow_pickle=False)
            if points.dtype != np.dtype('float64') or points.ndim != 2 or points.shape[1] != 7:
                return None
            if hashlib.sha256(memoryview(points.reshape(-1)).cast('B')).hexdigest() != meta['sha256']:
                return None
            if (not np.isfinite(points).all() or not isinstance(meta['info'], dict)
                    or meta['info'].get('url') != self.identity[2]['url']):
                return None
            return np.array(points), meta['info']
        except (OSError, ValueError, TypeError, KeyError, EOFError):
            return None

    def save(self, points, info):
        points = np.ascontiguousarray(points, dtype=np.float64)
        if points.ndim != 2 or points.shape[1] != 7 or not np.isfinite(points).all():
            return False
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix('.partial')
            with self.storage.writing(self.path) if self.storage else nullcontext(None) as ensure:
                if ensure:
                    # Keep caching optional when the current job fills the budget.
                    try:
                        ensure(points.nbytes + 1024**2)
                    except StorageFull:
                        return False
                try:
                    with temporary.open('wb') as output:
                        np.save(output, points, allow_pickle=False)
                    temporary.replace(self.path)
                    atomic_json(self.metadata, {'identity':self.identity, 'bytes':self.path.stat().st_size,
                        'sha256':hashlib.sha256(memoryview(points.reshape(-1)).cast('B')).hexdigest(), 'info':info})
                finally:
                    temporary.unlink(missing_ok=True)
            return True
        except (OSError, ValueError, TypeError):
            # Optional optimization; required measurement/public writes still fail loudly.
            return False
