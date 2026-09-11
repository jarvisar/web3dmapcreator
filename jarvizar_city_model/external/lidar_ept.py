"""Bounded USGS EPT/LAZ reader, used only by the external downloader.

EPT nodes are additive: include intersecting ancestors as well as leaves.
Only JSON hierarchies and laszip nodes are supported. No regional mesh or
point cloud is ever handed to Blender. See docs/LIDAR_BUILDINGS.md.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import time
import threading
from concurrent.futures import CancelledError
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

import laspy
from laspy.errors import LaspyException
from lazrs import LazrsError
import numpy as np
from pyproj import CRS, Transformer
try:
    from .lidar_selection import gps_capture_years
    from .lidar_transfer import BudgetExceeded, stream_tile
    from .lidar_normalize import vertical_factor as declared_vertical_factor, classifications
except ImportError:
    from lidar_selection import gps_capture_years
    from lidar_transfer import BudgetExceeded, stream_tile
    from lidar_normalize import vertical_factor as declared_vertical_factor, classifications

CATALOG_URL = "https://raw.githubusercontent.com/hobuinc/usgs-lidar/master/boundaries/resources.geojson"


class Fetcher:
    def __init__(self, cache: Path, max_bytes=None, refresh=False):
        self.cache = cache
        cache.mkdir(parents=True, exist_ok=True)
        self.max_bytes = max_bytes
        self.bytes = 0
        self.requests = 0
        self.refresh = refresh
        self.seen = set()
        self.progress = lambda _: None
        self._download_state = threading.Lock()
        self._download_keys = {}
        self._download_failures = {}
        self._download_budget = threading.Lock()

    def get(self, url, limit=32 * 1024 * 1024, fresh=False, body=None,
            ttl=None, timeout=45, attempts=3, content_type='application/json'):
        if urlparse(url).scheme != "https":
            raise ValueError("LiDAR downloads require HTTPS")
        encoded = (body.encode() if isinstance(body, str) else json.dumps(body, sort_keys=True).encode()) if body is not None else None
        key = url + ('#POST=' + encoded.decode() +
                     ('#Content-Type=' + content_type if content_type != 'application/json' else '')
                     if encoded is not None else '')
        path = self.cache / hashlib.sha256(key.encode()).hexdigest()
        # Neighboring building batches share additive EPT ancestors. Count
        # each resource once per preparation, including with Refresh enabled.
        repeated = key in self.seen
        remaining = min(limit, self.max_bytes - self.bytes) if self.max_bytes is not None and not repeated else limit
        if remaining <= 0:
            raise BudgetExceeded("LiDAR byte budget reached; select a smaller area")
        # Immutable tile cache can be explicitly refreshed with the scene option.
        expired = ttl is not None and path.is_file() and time.time() - path.stat().st_mtime >= ttl
        if path.is_file() and (not (self.refresh or fresh or expired) or repeated):
            if path.stat().st_size > remaining:
                raise BudgetExceeded("LiDAR byte budget reached; select a smaller area")
            data = path.read_bytes()
        else:
            for attempt in range(attempts):
                try:
                    request = urllib.request.Request(url, data=encoded,
                        headers={'Content-Type': content_type}) if encoded is not None else url
                    with urllib.request.urlopen(request, timeout=timeout) as response:
                        data = response.read(remaining + 1)
                    break
                except OSError:
                    if attempt == attempts - 1:
                        raise
                    time.sleep(attempt + 1)
            self.requests += 1
            if len(data) > remaining:
                raise BudgetExceeded("LiDAR response exceeds byte budget; select a smaller area")
            temporary = path.with_suffix(".partial")
            temporary.write_bytes(data)
            temporary.replace(path)
        if not repeated:
            self.bytes += len(data)
        self.seen.add(key)
        return data

    def json(self, url, fresh=False, limit=32 * 1024 * 1024):
        return json.loads(self.get(url, fresh=fresh, limit=limit))

    def json_request(self, url, body):
        """STAC read-only POST Item Search, sharing bounded caching/accounting."""
        return json.loads(self.get(url, fresh=True, body=body))

    def download(self, url, limit=4 * 1024 ** 3, revision='', cancel=None, validate_prefix=None):
        """Allow independent tiles in parallel; coalesce shared cache writes.

        Explicit total byte budgets retain serial admission/accounting. Normal
        preparation has no total byte cap and keeps the per-file size guard.
        """
        from contextlib import nullcontext
        key = url + ('#revision='+str(revision) if revision else '')
        with self._download_state:
            lock = self._download_keys.setdefault(key, threading.Lock())
        with lock, (self._download_budget if self.max_bytes is not None else nullcontext()):
            # A failed shared delivery (e.g. one ZIP used by several members)
            # already exhausted its transport retries. Do not repeat them for
            # every building batch. A new preparation/Refresh can retry it.
            if key in self._download_failures:
                raise OSError('Earlier download failed in this preparation: ' + self._download_failures[key])
            try:
                return self._download(url, limit, revision, cancel, validate_prefix)
            except OSError as exc:
                self._download_failures[key] = str(exc)
                raise

    def _download(self, url, limit, revision, cancel, validate_prefix):
        """Stream a staged tile to disk; never allocate its compressed contents."""
        def check_cancelled():
            if cancel is not None and cancel.is_set():
                raise CancelledError('LAZ download cancelled')

        check_cancelled()
        if urlparse(url).scheme != 'https':
            raise ValueError('LiDAR downloads require HTTPS')
        key = url + ('#revision='+str(revision) if revision else '')
        path = self.cache / hashlib.sha256(key.encode()).hexdigest()
        repeated = key in self.seen
        remaining = min(limit, self.max_bytes-self.bytes) if self.max_bytes is not None and not repeated else limit
        if path.is_file() and (not self.refresh or repeated):
            size = path.stat().st_size
            if size > remaining:
                raise BudgetExceeded('LiDAR tile exceeds byte budget')
        else:
            temporary = path.with_suffix('.partial')
            size = stream_tile(url, temporary, remaining, self.progress, cancel, validate_prefix)
            check_cancelled()
            temporary.replace(path)
            temporary.with_suffix('.partial.json').unlink(missing_ok=True)
            with self._download_state:
                self.requests += 1
        with self._download_state:
            if not repeated:
                self.bytes += size
            self.seen.add(key)
        return path

    def range(self, url, start, size):
        """Read bounded header metadata only; a server must honor HTTP Range."""
        if urlparse(url).scheme != 'https' or start < 0 or not 0 < size <= 4 * 1024 ** 2:
            raise ValueError('Invalid LiDAR header range')
        key = f'{url}#range={start}:{size}'
        path = self.cache / hashlib.sha256(key.encode()).hexdigest()
        repeated = key in self.seen
        if self.max_bytes is not None and not repeated and self.bytes+size > self.max_bytes:
            raise BudgetExceeded('LiDAR header exceeds byte budget')
        if path.is_file() and (not self.refresh or repeated):
            if path.stat().st_size != size:
                raise ValueError('Invalid cached LiDAR header; use Refresh to retry')
            data = path.read_bytes()
        else:
            request = urllib.request.Request(url, headers={
                'Range': f'bytes={start}-{start+size-1}', 'Accept-Encoding': 'identity'})
            with urllib.request.urlopen(request, timeout=45) as response:
                content_range = response.headers.get('Content-Range', '')
                if response.status != 206 or not content_range.startswith(f'bytes {start}-{start+size-1}/'):
                    raise ValueError('Server does not support bounded LAS header requests')
                data = response.read(size+1)
                if len(data) != size:
                    raise ValueError('Incomplete LAS header range')
            temporary = path.with_suffix('.partial')
            temporary.write_bytes(data)
            temporary.replace(path)
            self.requests += 1
        if not repeated:
            self.bytes += len(data)
        self.seen.add(key)
        return data


def node_intersects(key, root_bounds, query):
    depth, ix, iy, iz = map(int, key.split("-"))
    if depth < 0 or depth > 32 or min(ix, iy, iz) < 0 or max(ix, iy, iz) >= 2 ** depth:
        raise ValueError("Invalid EPT node key")
    for axis, index in enumerate((ix, iy)):
        width = (root_bounds[axis + 3] - root_bounds[axis]) / 2 ** depth
        low = root_bounds[axis] + index * width
        if low > query[axis + 2] or low + width < query[axis]:
            return False
    return True


def collect_nodes(fetch, base, metadata, query, max_nodes=4096, max_points=40_000_000, max_depth=32):
    pending, visited, nodes = ["0-0-0-0"], set(), {}
    while pending:
        key = pending.pop()
        if key in visited:
            continue
        visited.add(key)
        if len(visited) > max_nodes:
            raise BudgetExceeded("LiDAR hierarchy budget reached")
        hierarchy = fetch.json(base + "ept-hierarchy/" + key + ".json")
        for node, count in hierarchy.items():
            if int(node.split("-", 1)[0]) > max_depth:
                continue
            if not node_intersects(node, metadata["bounds"], query):
                continue
            if count == -1:
                if node in visited:
                    raise ValueError("Cyclic/incomplete EPT hierarchy")
                pending.append(node)
            elif isinstance(count, int) and count > 0:
                nodes[node] = count
        if len(nodes) > max_nodes or sum(nodes.values()) > max_points:
            raise BudgetExceeded("LiDAR tile/point budget reached; select a smaller area")
    return sorted(nodes, key=lambda key: tuple(map(int, key.split("-"))))


def ept_coordinate_system(meta, url, source=None):
    """Validate delivery and units identically for discovery and point reads.

    The AWS USGS mirror normalizes XY to EPSG:3857 and Z to metres. For a
    declared vertical CRS use its axis conversion; absent vertical CRS is
    accepted ONLY on that known mirror. Heights are roof-minus-ground within
    one survey, never LiDAR elevation minus the unrelated terrain DEM.
    """
    if meta.get("dataType") != "laszip" or meta.get("hierarchyType") != "json":
        raise ValueError("This first LiDAR reader supports laszip/JSON EPT only")
    srs = meta.get("srs", {})
    declared = srs.get('wkt') or (f"{srs.get('authority', 'EPSG')}:{srs['horizontal']}" if srs.get('horizontal') else None)
    declared = declared or (source or {}).get('horizontal_crs')
    if not declared:
        raise ValueError('EPT lacks a horizontal CRS in source or catalog metadata')
    horizontal = CRS.from_user_input(declared)
    xy_crs = horizontal.to_2d()
    vertical_factor = None
    if srs.get("vertical"):
        vertical_factor = CRS.from_user_input(f"{srs.get('authority', 'EPSG')}:{srs['vertical']}").axis_info[0].unit_conversion_factor
    elif horizontal.is_compound:
        for crs in horizontal.sub_crs_list:
            if crs.is_vertical:
                vertical_factor = crs.axis_info[0].unit_conversion_factor
    elif len(horizontal.axis_info) == 3:
        vertical_factor = horizontal.axis_info[2].unit_conversion_factor
    if vertical_factor is None:
        vertical_factor = declared_vertical_factor({**(source or {}), **meta})
    parsed = urlparse(url)
    known_mirror = (parsed.netloc in ("s3-us-west-2.amazonaws.com", "s3.us-west-2.amazonaws.com")
                    and parsed.path.startswith("/usgs-lidar-public/")) or parsed.netloc == "usgs-lidar-public.s3.amazonaws.com"
    if vertical_factor is None:
        if not known_mirror or xy_crs.to_epsg() != 3857:
            raise ValueError("Unknown LiDAR vertical units; supply documented units or a vertical CRS")
        vertical_factor = 1.0
    return xy_crs, vertical_factor, known_mirror


def read_ept(fetch, url, bbox, max_points=8_000_000, resolution_m=0.75, source=None):
    """Return cropped lon/lat/Z/class/single-return arrays and source metadata."""
    meta = fetch.json(url)
    xy_crs, vertical_factor, known_mirror = ept_coordinate_system(meta, url, source)
    to_cloud = Transformer.from_crs(4326, xy_crs, always_xy=True)
    to_lonlat = Transformer.from_crs(xy_crs, 4326, always_xy=True)
    query = to_cloud.transform_bounds(*bbox, densify_pts=21)
    base = url.rsplit("/", 1)[0] + "/"
    # This initial miniature pass needs sub-metre sampling, not every return.
    # Web Mercator distances differ from local ground distances by sec(lat).
    # Retain all ancestors through the first depth at least this precise.
    max_depth = 32
    if xy_crs.to_epsg() == 3857 and resolution_m > 0:
        cloud_resolution = resolution_m / math.cos(math.radians((bbox[1] + bbox[3]) / 2))
        root_spacing = (meta["bounds"][3] - meta["bounds"][0]) / meta["span"]
        max_depth = max(0, math.ceil(math.log2(root_spacing / cloud_resolution)))
    progress = getattr(fetch, 'progress', lambda message: None)
    progress('Reading EPT hierarchy for this batch')
    nodes = collect_nodes(fetch, base, meta, query, max_depth=max_depth)
    pieces, retained = [], 0
    for position, key in enumerate(nodes, 1):
        progress(f'Loading and decoding EPT node {position}/{len(nodes)}; {retained:,} cropped points retained')
        data = fetch.get(base + "ept-data/" + key + ".laz")
        # Inspect before decoding, so malformed node counts cannot allocate an
        # enormous array inside laspy.
        try:
            with laspy.open(io.BytesIO(data)) as reader:
                if reader.header.point_count > 2_000_000:
                    raise BudgetExceeded("Unexpectedly large LiDAR node")
                points = reader.read()
        except (LaspyException, LazrsError) as exc:
            raise ValueError(f'Unreadable LiDAR node {key}; use Refresh to retry its cached download: {exc}') from exc
        x, y, z = np.asarray(points.x), np.asarray(points.y), np.asarray(points.z)
        cls = classifications(points, points.header, {**(source or {}), **meta})
        mask = ((x >= query[0]) & (x <= query[2]) & (y >= query[1]) & (y <= query[3])
                & np.isin(cls, [1, 2, 6]) & (np.asarray(points.withheld) == 0)
                & np.isfinite(x) & np.isfinite(y) & np.isfinite(z))
        if "overlap" in points.point_format.dimension_names:
            mask &= np.asarray(points.overlap) == 0
        if not mask.any():
            continue
        lon, lat = to_lonlat.transform(x[mask], y[mask])
        single = np.asarray(points.number_of_returns)[mask] == 1
        years, basis = np.zeros(int(mask.sum())), 'unknown'
        if 'gps_time' in points.point_format.dimension_names:
            years, basis = gps_capture_years(np.asarray(points.gps_time)[mask],
                points.header.global_encoding.gps_time_type, known_ept=known_mirror)
        confidence = np.where(years > 0, 1 if basis == 'gps_declared' else .5, 0)
        piece = np.column_stack((lon, lat, z[mask] * vertical_factor, cls[mask], single, years, confidence))
        exact = ((piece[:, 0] >= bbox[0]) & (piece[:, 0] <= bbox[2])
                 & (piece[:, 1] >= bbox[1]) & (piece[:, 1] <= bbox[3]))
        piece = piece[exact]
        retained += len(piece)
        if retained > max_points:
            raise BudgetExceeded("Cropped LiDAR point budget reached; select a smaller area")
        pieces.append(piece)
    return (np.concatenate(pieces) if pieces else np.empty((0, 7))), {
        "url": url, "nodes": len(nodes), "points": retained,
        "horizontal_crs": xy_crs.to_string(), "z_to_metres": vertical_factor,
        "requested_spacing_m": resolution_m, "max_depth": max_depth,
        "vertical_reference": "same-survey ground subtraction",
    }
