"""Process ownership and cache exclusion; standard library only."""
from contextlib import contextmanager
import os
from pathlib import Path
import threading


@contextmanager
def cache_owner(directory):
    """OS releases this lock even if Blender or the downloader is killed."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / '.lidar-worker.lock').open('a+b') as lock:
        lock.seek(0)
        if os.name == 'nt':
            import msvcrt
            acquire = lambda: msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            release = lambda: msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            acquire = lambda: fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            release = lambda: fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        try:
            acquire()
        except OSError as exc:
            raise ValueError('Another LiDAR preparation is using this cache; cancel it before starting another') from exc
        try:
            yield
        finally:
            lock.seek(0)
            release()


def watch_parent(pid):
    """Stop the actual worker when its owning Blender process exits.

    Windows venv python.exe is a launcher; killing that launcher alone does
    not stop its real Python child. Watch Blender itself, not os.getppid().
    """
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not handle:
            raise OSError('Cannot monitor the owning Blender process')
        def monitor():
            if kernel.WaitForSingleObject(handle, 0xFFFFFFFF) == 0:
                os._exit(1)
    else:
        import time
        def monitor():
            while True:
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    os._exit(1)
                time.sleep(.5)
    threading.Thread(target=monitor, name='lidar-parent', daemon=True).start()
