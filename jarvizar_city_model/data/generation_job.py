"""Private, offline Blender worker protocol. This module has no bpy dependency."""

import atexit
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time


PROTOCOL = 1


class GenerationCancelled(Exception):
    """Cooperative cancellation at a pipeline boundary."""


def write_json(path, payload):
    path = Path(path)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload), encoding="utf-8")
    # Windows readers can briefly hold the destination without delete sharing.
    # Keep publication atomic and retry that transient conflict in the worker.
    for attempt in range(20):
        try:
            temporary.replace(path)
            return
        except PermissionError:
            if os.name != "nt" or attempt == 19:
                raise
            time.sleep(.005)


class GenerationJob:
    """Own a background Blender until it exits, including after cancellation.

    Generation launches no downloaders or other child processes. Terminating
    this direct Blender child can interrupt even a long native Boolean call.
    Logs go to files so an unread pipe cannot stall generation.
    """

    def __init__(self, binary, settings):
        self.temporary = tempfile.TemporaryDirectory(prefix="jcm_generation_")
        self.directory = Path(self.temporary.name)
        self.progress_path = self.directory / "progress.json"
        self.result_path = self.directory / "result.json"
        self.model_path = self.directory / "model.blend"
        self.process = None
        self.cancel_requested = False
        self.cancel_started = None
        self.cleaned = False
        try:
            request = self.directory / "request.json"
            write_json(request, {"protocol": PROTOCOL, "settings": settings, "parent_pid": os.getpid()})
            helper = Path(__file__).resolve().parents[1] / "external" / "generate_model.py"
            command = [str(binary), "--background", "--factory-startup", "--disable-autoexec",
                       "--python-exit-code", "1", "--python", str(helper), "--", str(request)]
            with (self.directory / "worker.log").open("w", encoding="utf-8") as log:
                self.process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            atexit.register(self._shutdown)
        except Exception:
            self.temporary.cleanup()
            raise

    def progress(self):
        try:
            payload = json.loads(self.progress_path.read_text(encoding="utf-8"))
            fraction = float(payload["fraction"])
            phase = payload["phase"]
            if not 0 <= fraction <= 1 or not isinstance(phase, str):
                raise ValueError("Invalid progress")
            return phase, fraction
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def cancel(self):
        self.cancel_requested = True
        now = time.monotonic()
        if self.cancel_started is None:
            self.cancel_started = now
        if self.process.poll() is None:
            try:
                if now - self.cancel_started >= .5:
                    self.process.kill()
                else:
                    self.process.terminate()
            except OSError:
                if self.process.poll() is None:
                    raise

    def result(self):
        code = self.process.poll()
        if code is None:
            raise RuntimeError("The generation worker is still running")
        if self.cancel_requested:
            raise ValueError("Generation was cancelled")
        try:
            payload = json.loads(self.result_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            log = self.directory / "worker.log"
            with log.open("rb") as stream:
                stream.seek(max(0, log.stat().st_size - 2000))
                detail = stream.read().decode("utf-8", errors="replace").strip()
            raise ValueError(detail or f"Generation worker exited with code {code}")
        if not isinstance(payload, dict) or payload.get("protocol") != PROTOCOL:
            raise ValueError("Invalid generation worker result")
        if code or not payload.get("ok"):
            raise ValueError(payload.get("error") or f"Generation worker exited with code {code}")
        if not self.model_path.is_file():
            raise ValueError("Generation worker did not produce a model")
        for key in ("root", "message", "lidar_status"):
            if not isinstance(payload.get(key), str):
                raise ValueError("Incomplete generation worker result")
        return payload

    def keep_log(self, folder, keep=20):
        """Copy the worker log to *folder* as generation-<UTC>.log; keep the newest *keep*."""
        source = self.directory / "worker.log"
        if self.cleaned or not source.is_file():
            return None
        folder = Path(folder)
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / time.strftime("generation-%Y%m%dT%H%M%SZ.log", time.gmtime())
        shutil.copyfile(source, target)
        for old in sorted(folder.glob("generation-*.log"))[:-keep]:
            try:
                old.unlink()
            except OSError:
                pass
        return target

    def cleanup(self):
        if self.cleaned:
            return
        if self.process is not None and self.process.poll() is None:
            raise RuntimeError("Cannot release a running generation worker")
        self.temporary.cleanup()
        self.cleaned = True
        atexit.unregister(self._shutdown)

    def wait_or_kill(self):
        """Wait briefly for the worker to exit, killing it if it does not."""
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=2)

    def _shutdown(self):
        """Normal application exit: only OS/process operations, never bpy."""
        if self.cleaned:
            return
        self.cancel()
        self.wait_or_kill()
        self.cleanup()
