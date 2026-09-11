"""Advisory worker status, safe under Windows reader locks and parallel downloads."""
import json
from pathlib import Path
import sys
from threading import Lock
import time


class ProgressReporter:
    """Keep full stderr logs, but publish the sidebar status at most five times/s.

    Blender's ordinary file reads can briefly prevent atomic replacement on
    Windows. Retry permission conflicts for at most 10 ms, then leave the last
    complete status in place and try again on a later update. Neither a locked
    temporary file nor a failed replacement may abort acquisition. This policy
    applies only to progress, never checkpoints or the public measurement cache.
    """
    MIN_INTERVAL_SECONDS = .2
    REPLACE_ATTEMPTS = 3
    RETRY_SECONDS = .005

    def __init__(self, path=None):
        self.path = Path(path) if path is not None else None
        self.lock = Lock()
        self.last_attempt = None
        self.warned = False
        self.state = {}

    def __call__(self, message, accepted=0, candidates=0, force=False, **fields):
        with self.lock:
            self.state.update(fields)
            print(message, file=sys.stderr, flush=True)
            now = time.monotonic()
            if self.path is None or (not force and self.last_attempt is not None
                    and now - self.last_attempt < self.MIN_INTERVAL_SECONDS):
                return False
            self.last_attempt = now
            temporary = self.path.with_suffix('.partial')
            data = json.dumps({'message': message, 'accepted': accepted, 'candidates': candidates,
                               **self.state, **({'updated_at': time.time()} if self.state else {})})
            for attempt in range(self.REPLACE_ATTEMPTS):
                try:
                    temporary.write_text(data, encoding='utf-8')
                    temporary.replace(self.path)
                    return True
                except OSError as exc:
                    if isinstance(exc, PermissionError) and attempt + 1 < self.REPLACE_ATTEMPTS:
                        time.sleep(self.RETRY_SECONDS)
                        continue
                    if not self.warned:
                        print(f'LiDAR progress display update unavailable; preparation continues: {exc}',
                              file=sys.stderr, flush=True)
                        self.warned = True
                    return False
