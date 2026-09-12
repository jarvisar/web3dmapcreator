"""Conservative storage policy for disposable LiDAR acceleration files only.

Callers hold cache_owner for the lifetime of a manager. Never walk arbitrary
cache trees or remove directories: bundles and source generation markers stay.
"""
from contextlib import contextmanager
from pathlib import Path
import os
import re
import shutil
import stat
import threading
import time

GIB = 1024 ** 3
DEFAULT_CACHE_GIB = 30
DEFAULT_FREE_GIB = 10
PARTIAL_MAX_AGE = 7 * 86400
HEX = re.compile(r'^[0-9a-f]{64}$')


class StorageFull(Exception):
    """Abort preparation, rather than publishing storage failures as survey gaps."""


def plain(path, directory=False):
    try:
        info = path.lstat()
        return (not stat.S_ISLNK(info.st_mode)
                and not getattr(info, 'st_file_attributes', 0) & 0x400
                and (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)))
    except OSError:
        return False


def inventory(root):
    """Return recognized file groups; links/junctions and unknown files are ignored."""
    root = Path(root)
    entries = []
    locations = []
    tiles = root / 'lidar_tiles'
    if plain(tiles, True):
        locations.append((tiles, 'tiles'))
    derived = root / 'lidar_derived'
    if plain(derived, True):
        for source in derived.iterdir():
            points = source / 'points'
            if HEX.fullmatch(source.name) and plain(source, True) and plain(points, True):
                locations.append((points, 'points'))
    for directory, category in locations:
        pinned = (directory / '.keep').exists()
        for path in directory.iterdir():
            if not plain(path):
                continue
            stem = path.name.split('.')[0]
            if not HEX.fullmatch(stem):
                continue
            partial = path.name in (stem + '.partial', stem + '.extracting')
            complete = path.name == stem + ('.npy' if category == 'points' else '')
            if not (partial or complete):
                continue
            entries.append(file_entry(path, category, partial, pinned))
    return entries


def file_entry(path, category, partial=False, pinned=False):
    companions = [path]
    sidecar = path.with_suffix('.partial.json' if partial else '.json')
    if (partial or category == 'points') and plain(sidecar):
        companions.append(sidecar)
    infos = [p.stat() for p in companions]
    return {'path': path, 'files': companions, 'bytes': sum(s.st_size for s in infos),
            'used': max(max(s.st_atime, s.st_mtime) for s in infos),
            'stale': partial and time.time() - max(s.st_mtime for s in infos) > PARTIAL_MAX_AGE,
            'partial': partial, 'category': category, 'pinned': pinned}


class CacheStorage:
    def __init__(self, root, cache_gib=DEFAULT_CACHE_GIB, free_gib=DEFAULT_FREE_GIB):
        if not (0 < cache_gib <= 100000 and 0 <= free_gib <= 100000):
            raise ValueError('Invalid LiDAR storage limits')
        self.root = Path(root).expanduser().resolve()
        self.limit, self.reserve = int(cache_gib * GIB), int(free_gib * GIB)
        self.lock = threading.RLock()
        self.pins = set()
        self.accessed = {}
        self.reservations = {}
        self.entries = inventory(self.root)

    def touch(self, path):
        with self.lock:
            path = Path(path).resolve()
            self.pins.add(path)
            self.pins.add(path.with_suffix('.partial'))
            self.pins.add(path.with_suffix('.extracting'))
            self.accessed[path] = time.time()
            try:
                info = path.stat()
                os.utime(path, (time.time(), info.st_mtime))  # preserve provider TTL
            except OSError:
                pass

    def plan(self, extra=0):
        used = sum(e['bytes'] for e in self.entries)
        free = shutil.disk_usage(self.root).free
        needed = max(0, used + extra - self.limit, self.reserve + extra - free)
        chosen = []
        reclaimed = 0
        for entry in sorted(self.entries, key=lambda e: (not e['stale'], e['category'] != 'points', max(e['used'], self.accessed.get(e['path'], 0)))):
            if entry['pinned'] or entry['path'] in self.pins or (entry['partial'] and not entry['stale']):
                continue
            if reclaimed < needed or entry['stale']:
                chosen.append(entry)
                reclaimed += entry['bytes']
        return {'used': used, 'free': free, 'remove': chosen, 'reclaim': reclaimed,
                'shortfall': max(0, needed - reclaimed)}

    def release_inputs(self):
        """Only at batch boundaries, after readers and download futures exit."""
        with self.lock:
            if self.reservations:
                raise RuntimeError('Cannot release active cache writes')
            self.pins.clear()

    def trim(self, extra=0):
        """Deletion failures leave entries accounted for and cannot hide shortages."""
        with self.lock:
            plan = self.plan(extra)
            if plan['shortfall']:
                raise StorageFull('LiDAR storage limit reached; active or protected data cannot be removed. Increase the limit, free disk space, or prepare a smaller area. Previous prepared results are preserved.')
            removed = 0
            for entry in plan['remove']:
                # Revalidate known ancestry and regular files immediately before deletion.
                if any(not plain(p, True) for p in entry['path'].parents if p != self.root and self.root in p.parents):
                    continue
                for path in entry['files']:
                    if plain(path):
                        try:
                            size = path.stat().st_size
                            path.unlink()
                            removed += size
                        except OSError:
                            break
            # Other threads may be midway through staged writes. Keep their
            # original accounting plus reservations; rescanning partial sizes
            # here would count those bytes twice.
            selected = {e['path'] for e in plan['remove']}
            remaining = []
            for entry in self.entries:
                if entry['path'] not in selected:
                    remaining.append(entry)
                elif plain(entry['path']):
                    remaining.append(file_entry(entry['path'], entry['category'], entry['partial'], entry['pinned']))
            self.entries = remaining
            used = sum(e['bytes'] for e in self.entries)
            if used + extra > self.limit or shutil.disk_usage(self.root).free < self.reserve + extra:
                raise StorageFull('LiDAR storage limit reached. Increase the cache limit, free disk space, or prepare a smaller area. Previous prepared results are preserved.')
            return removed

    @contextmanager
    def writing(self, path, managed=True):
        """Reserve concurrent staged writes; pin all inputs until this job exits."""
        path = Path(path).resolve()
        self.touch(path)
        token = object()
        with self.lock:
            self.reservations[token] = 0
        def ensure(size):
            with self.lock:
                if size <= self.reservations[token]:
                    return
                # 8 MiB increments avoid rescanning on each 64 KiB network chunk.
                size = ((size + 8 * 1024**2 - 1) // (8 * 1024**2)) * 8 * 1024**2
                extra = size + sum(v for k, v in self.reservations.items() if k is not token)
                used = sum(e['bytes'] for e in self.entries)
                if used + extra > self.limit or shutil.disk_usage(self.root).free < self.reserve + extra:
                    self.trim(extra)
                self.reservations[token] = size
        try:
            yield ensure
        finally:
            with self.lock:
                self.reservations.pop(token, None)
                paths = {path, path.with_suffix('.partial'), path.with_suffix('.extracting')} if managed else set()
                self.entries = [e for e in self.entries if e['path'] not in paths]
                category = 'tiles' if path.parent == self.root / 'lidar_tiles' else 'points'
                for item in paths:
                    if plain(item):
                        self.entries.append(file_entry(item, category, item != path, (item.parent / '.keep').exists()))

    def write_bytes(self, path, data, managed=True):
        with self.writing(path, managed) as ensure:
            ensure(len(data))
            temporary = path.with_suffix('.partial')
            try:
                temporary.write_bytes(data)
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
