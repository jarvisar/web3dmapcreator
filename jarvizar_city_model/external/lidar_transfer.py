"""Stream and resume staged tiles without changing acquisition/measurements."""
import json
import re
import time
import urllib.request
from urllib.error import HTTPError
from concurrent.futures import CancelledError
from urllib.parse import unquote, urlparse


class BudgetExceeded(ValueError):
    pass


def stream_tile(url, temporary, limit, progress, cancel=None, validate_prefix=None):
    metadata = temporary.with_suffix('.partial.json')
    resumable = False

    def check_cancelled():
        if cancel is not None and cancel.is_set():
            raise CancelledError('LAZ download cancelled')

    def discard():
        temporary.unlink(missing_ok=True)
        metadata.unlink(missing_ok=True)

    name = unquote(urlparse(url).path.rsplit('/', 1)[-1])
    try:
        for attempt in range(3):
            check_cancelled()
            offset, saved = 0, {}
            try:
                saved = json.loads(metadata.read_text())
                offset = temporary.stat().st_size
                if (saved['url'] != url or not isinstance(saved['etag'], str)
                        or not saved['etag'].startswith('"') or not saved['etag'].endswith('"')
                        or type(saved['total']) is not int or not 0 < offset < saved['total'] <= limit):
                    offset = 0
                if offset and validate_prefix:
                    with temporary.open('rb') as prefix:
                        validate_prefix(prefix, limit)
            except (OSError, ValueError, KeyError, TypeError):
                offset = 0
            if not offset:
                discard()
            resumable = bool(offset)
            request = urllib.request.Request(url, headers={
                'Range': f'bytes={offset}-', 'If-Range': saved['etag'],
                'Accept-Encoding': 'identity'}) if offset else url
            try:
                started = last_progress = time.monotonic()
                progress(f'{"Resuming" if offset else "Connecting to"} LAZ tile: {name}')
                with urllib.request.urlopen(request, timeout=45) as response:
                    expected = response.headers.get('Content-Length')
                    etag = response.headers.get('ETag', '')
                    if offset and response.status == 206:
                        match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('Content-Range', ''))
                        if (not match or tuple(map(int, match.groups())) != (offset, saved['total']-1, saved['total'])
                                or etag != saved['etag'] or (expected and int(expected) != saved['total']-offset)):
                            resumable = False
                            discard()
                            raise OSError('Invalid resumed LAZ response; restarting transfer')
                        total = saved['total']
                    else:
                        if offset and response.status != 200:
                            resumable = False
                            discard()
                            raise OSError('Server refused LAZ resume')
                        offset = 0  # A changed resource / ignored Range is a new full response.
                        total = int(expected) if expected else None
                    if total is not None and (total < 0 or total > limit):
                        resumable = False
                        raise BudgetExceeded('LiDAR tile exceeds byte budget')
                    if not offset:
                        resumable = False
                        discard()
                    with temporary.open('ab' if offset else 'wb') as output:
                        size = offset
                        if not offset and validate_prefix:
                            prefix = validate_prefix(response, limit)
                            output.write(prefix)
                            size += len(prefix)
                        resumable = bool(total and etag.startswith('"') and etag.endswith('"'))
                        if resumable:
                            metadata.write_text(json.dumps({'url': url, 'etag': etag, 'total': total}))
                        while True:
                            check_cancelled()
                            data = response.read(min(64*1024, max(1, limit-size+1)))
                            if not data:
                                break
                            size += len(data)
                            if size > limit or (total is not None and size > total):
                                resumable = False
                                raise BudgetExceeded('LiDAR tile exceeds byte budget or declared size')
                            output.write(data)
                            now = time.monotonic()
                            if now-last_progress >= 5:
                                rate = (size-offset)/1024**2/max(now-started, .001)
                                extent = f'/{total/1024**2:.1f}' if total else ''
                                progress(f'Downloading LAZ: {size/1024**2:.1f}{extent} MiB, {rate:.2f} MiB/s — {name}')
                                last_progress = now
                        if total is not None and size != total:
                            raise OSError('Incomplete LiDAR tile download')
                check_cancelled()
                # Keep partial+validator until caller atomically promotes the file.
                return size
            except OSError as exc:
                if isinstance(exc, HTTPError) and exc.code == 416:
                    resumable = False
                    discard()
                if attempt == 2:
                    raise
                if cancel is None:
                    time.sleep(attempt+1)
                elif cancel.wait(attempt+1):
                    check_cancelled()
    finally:
        if not resumable:
            # Unvalidated partials cannot safely be appended to on a later job.
            metadata.unlink(missing_ok=True)
            # Successful transfers without ETag are still promoted by caller.
            import sys
            if sys.exc_info()[0] is not None:
                temporary.unlink(missing_ok=True)
