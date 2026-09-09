"""Bounded LAZ download lookahead, independent of point/building processing."""
from concurrent.futures import ThreadPoolExecutor
from threading import Event

DEFAULT_DOWNLOAD_WORKERS = 4
MAX_DOWNLOAD_WORKERS = 16


def validate_download_workers(value):
    if type(value) is not int or not 1 <= value <= MAX_DOWNLOAD_WORKERS:
        raise ValueError(f'LAZ parallel downloads must be an integer from 1 to {MAX_DOWNLOAD_WORKERS}')
    return value


class TileDownloads:
    """Fetch upcoming required tiles while the caller decodes/measures in order.

    The transfer limit is configurable. Futures hold disk paths, never point arrays.
    Failures surface when their tile is consumed, preserving per-group recovery.
    Blender's Cancel terminates the owning worker process and all its threads.
    """
    def __init__(self, fetch, tiles, workers=DEFAULT_DOWNLOAD_WORKERS, validate_prefix=None):
        self.fetch = fetch
        self.progress = fetch.progress
        self.validate_prefix = validate_prefix
        self.tiles = tiles
        self.workers = validate_download_workers(workers)
        self.cancel = Event()
        self.futures = {}

    def __enter__(self):
        self.pool = ThreadPoolExecutor(max_workers=self.workers, thread_name_prefix='laz')
        try:
            for tile in self.tiles:
                key = (tile['url'], tile.get('updated') or '')
                if key not in self.futures:
                    self.futures[key] = self.pool.submit(
                        self.fetch.download, key[0], revision=key[1], cancel=self.cancel,
                        validate_prefix=self.validate_prefix)
        except BaseException:
            self.__exit__(None, None, None)
            raise
        return self

    def download(self, url, revision=''):
        future = self.futures.get((url, revision))
        if future is not None:
            return future.result()
        return self.fetch.download(url, revision=revision)

    def __exit__(self, *exc):
        self.cancel.set()
        self.pool.shutdown(wait=True, cancel_futures=True)


def prefetch_source(fetch, source, queries, workers=DEFAULT_DOWNLOAD_WORKERS):
    """Prefetch only tiles intersecting groups without reusable checkpoints."""
    from contextlib import nullcontext
    if source['format'] != 'LAZ':
        return nullcontext(fetch)
    from shapely.geometry import box
    from shapely import STRtree
    try:
        from .lidar_laz import validate_download_prefix
    except ImportError:
        from lidar_laz import validate_download_prefix
    tiles = source['tiles']
    tree = STRtree([box(*tile['bbox']) for tile in tiles])
    ordered = {}
    for query in queries:
        for i in sorted(tree.query(box(*query), predicate='intersects')):
            ordered.setdefault(int(i), tiles[i])
    return TileDownloads(fetch, list(ordered.values()), workers=workers,
                         validate_prefix=validate_download_prefix)
