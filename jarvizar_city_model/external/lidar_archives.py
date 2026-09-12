"""Acquire a named LAS/LAZ member from a provider's minimum ZIP delivery tile.

Called only by the admitted staged-download path. Archives share the ordinary
resumable download cache; extraction never writes publisher-supplied paths.
"""
import hashlib
import zipfile
import zlib
from pathlib import PurePosixPath
from contextlib import nullcontext


def fetch_tile(fetch, tile, *, cancel=None, validate_prefix=None):
    try:
        return _fetch_tile(fetch, tile, cancel=cancel, validate_prefix=validate_prefix)
    except (zipfile.BadZipFile, zipfile.LargeZipFile, zlib.error, EOFError) as exc:
        # Match the shared worker's recoverable source-read error boundary.
        raise ValueError(f'Invalid point-cloud ZIP delivery; use Refresh to retry: {exc}') from exc


def _fetch_tile(fetch, tile, *, cancel=None, validate_prefix=None):
    if not tile.get('archive_url'):
        return fetch.download(tile['url'], revision=tile.get('updated') or '',
                              cancel=cancel, validate_prefix=validate_prefix)
    from concurrent.futures import CancelledError
    try:
        from .lidar_laz import validate_download_prefix
    except ImportError:
        from lidar_laz import validate_download_prefix
    revision = tile.get('updated') or ''
    key = tile['url'] + '#extracted=' + str(revision)
    target = fetch.cache / hashlib.sha256(key.encode()).hexdigest()
    storage = getattr(fetch, 'storage', None)
    if storage:
        storage.touch(target)
    if target.is_file() and not fetch.refresh:
        return target
    def zip_prefix(stream, limit):
        prefix = stream.read(4)
        if prefix != b'PK\x03\x04':
            raise ValueError('Point-cloud delivery is not a ZIP archive')
        return prefix
    archive_path = fetch.download(tile['archive_url'], revision=revision, cancel=cancel,
                                  validate_prefix=zip_prefix)
    with storage.writing(target) if storage else nullcontext(None) as ensure, zipfile.ZipFile(archive_path) as archive:
        if len(archive.infolist()) > 10000:
            raise ValueError('Point-cloud archive contains too many members')
        names = [info for info in archive.infolist()
                 if PurePosixPath(info.filename.replace('\\', '/')).name == tile['archive_member']]
        if len(names) != 1 or names[0].is_dir() or names[0].flag_bits & 1:
            raise ValueError('Point-cloud archive lacks one unambiguous, unencrypted requested tile')
        info = names[0]
        if not 227 <= info.file_size <= 4 * 1024**3:
            raise ValueError('Expanded point-cloud tile exceeds size budget')
        if ensure:
            ensure(info.file_size)
        temporary = target.with_suffix('.extracting')
        try:
            with archive.open(info) as src, temporary.open('wb') as out:
                # Validate CRS before expanding the rest of a large tile.
                prefix = validate_download_prefix(src, info.file_size, tile)
                out.write(prefix)
                written = len(prefix)
                while True:
                    if cancel is not None and cancel.is_set():
                        raise CancelledError('Point-cloud extraction cancelled')
                    chunk = src.read(1024**2)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > info.file_size:
                        raise ValueError('Expanded tile exceeds declared size')
                    out.write(chunk)
            if written != info.file_size:
                raise ValueError('Incomplete point-cloud archive member')
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    return target
