"""Preparation-local reuse of raw LAS records, before survey normalization.

Small EPT nodes use a bounded RAM LRU. Whole LAZ tiles use delete-on-close
temporary files and read-only mappings, never a full-tile RAM allocation.
Cache misses, large tiles and unavailable temporary storage retain streaming.
Readers remain sequential; download threads never access these caches.
"""
from collections import OrderedDict
from contextlib import closing, nullcontext
import tempfile
import shutil

import laspy
import numpy as np


class DecodedPointCache:
    def __init__(self, memory_limit=64 * 1024**2, disk_limit=1024**3,
                 tile_limit=512 * 1024**2):
        self.memory_limit, self.disk_limit, self.tile_limit = memory_limit, disk_limit, tile_limit
        self.free_reserve = 0
        self.nodes, self.tiles = OrderedDict(), OrderedDict()
        self.memory_bytes = self.disk_bytes = 0

    def node(self, key):
        value = self.nodes.get(key)
        if value is not None:
            self.nodes.move_to_end(key)
        return value

    def store_node(self, key, points):
        size = points.points.array.nbytes
        if size > self.memory_limit or key in self.nodes:
            return
        while self.nodes and self.memory_bytes + size > self.memory_limit:
            _, previous = self.nodes.popitem(last=False)
            self.memory_bytes -= previous.points.array.nbytes
        points.points.array.flags.writeable = False
        self.nodes[key] = points
        self.memory_bytes += size

    def _drop_tile(self):
        _, (array, temporary) = self.tiles.popitem(last=False)
        self.disk_bytes -= array.nbytes
        array._mmap.close()
        temporary.close()

    def close(self):
        self.nodes.clear()
        self.memory_bytes = 0
        while self.tiles:
            self._drop_tile()

    def __del__(self):
        self.close()

    @staticmethod
    def _file_key(path):
        stat = path.stat()
        return str(path.resolve()), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns

    def tile_chunks(self, reader, path, chunk_size):
        """Keep original point order/fields; apply the caller's crop every time."""
        key = self._file_key(path)
        count = reader.header.point_count
        dtype = reader.header.point_format.dtype()
        size = count * dtype.itemsize
        cached = self.tiles.get(key)
        if cached is not None:
            self.tiles.move_to_end(key)
            array = cached[0]
            for start in range(0, count, chunk_size):
                yield laspy.ScaleAwarePointRecord(array[start:start + chunk_size],
                    reader.header.point_format, reader.header.scales, reader.header.offsets)
            return
        temporary = None
        if 0 < size <= min(self.tile_limit, self.disk_limit):
            while self.tiles and self.disk_bytes + size > self.disk_limit:
                self._drop_tile()
            try:
                if shutil.disk_usage(tempfile.gettempdir()).free >= self.free_reserve + size:
                    temporary = tempfile.TemporaryFile(buffering=0)
            except OSError:
                pass
        try:
            for chunk in reader.chunk_iterator(chunk_size):
                if temporary is not None:
                    try:
                        raw = memoryview(chunk.array).cast('B')
                        if shutil.disk_usage(tempfile.gettempdir()).free < self.free_reserve + len(raw):
                            raise OSError('Preserving temporary disk space')
                        if temporary.write(raw) != len(raw):
                            raise OSError('Incomplete temporary point cache write')
                    except OSError:
                        temporary.close()
                        temporary = None
                yield chunk
            if temporary is not None and temporary.tell() == size and self._file_key(path) == key:
                try:
                    temporary.flush()
                    array = np.memmap(temporary, mode='r', dtype=dtype, shape=(count,))
                except (OSError, ValueError, MemoryError):
                    pass
                else:
                    self.tiles[key] = array, temporary
                    self.disk_bytes += size
                    temporary = None
        finally:
            if temporary is not None:
                temporary.close()


def tile_chunks(fetch, reader, path, chunk_size):
    """Also support simple/custom fetchers without optional decode caching."""
    cache = getattr(fetch, 'decoded_cache', None)
    if isinstance(cache, DecodedPointCache):
        return closing(cache.tile_chunks(reader, path, chunk_size))
    return nullcontext(reader.chunk_iterator(chunk_size))
