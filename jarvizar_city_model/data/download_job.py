"""Overture and elevation downloads in the external interpreter, polled
without blocking. This module has no bpy dependency."""

from __future__ import annotations

import atexit
import os
import re
import shutil
import signal
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .cache import CacheBundle
from .folders import ensure_writable
from .overture import OvertureDownloadError, _external_script, last_json_line


OVERTURE_TIMEOUT_S = 1800
DEM_TIMEOUT_S = 900
LOG_DIRECTORY = "logs"
LOG_PATTERN = "download-*.log"
KEEP_LOGS = 20
PROGRESS_PREFIX = "progress: "
POLL_SECONDS = 0.1
# POSIX helpers get SIGTERM first and SIGKILL after this many seconds.
STOP_GRACE_S = 2.0
# Antivirus scanners can hold a file briefly after the helper exits.
CLEANUP_RETRY_S = 10.0
LOG_OUTPUT_LIMIT = 1 << 20
FOLDER_PREFIX = "jarvizar_download_"
# Far longer than both step timeouts: an older private folder has no owner.
STALE_FOLDER_S = 24 * 3600

STAGE_LABELS = {"overture": "Overture data", "dem": "Elevation"}
STAGE_NAMES = {"overture": "Overture data", "dem": "elevation"}
SERVER_NAMES = {"overture": "Overture servers", "dem": "elevation tile server"}
FINISHED = ("succeeded", "failed", "cancelled")

OFFLINE_MESSAGE = "Enable Allow Online Access in Edit > Preferences > System > Network"

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_COUNTER = re.compile(r"\((\d+)/(\d+)\)")
_MODULE = re.compile(r"No module named '([\w.]+)'|No package metadata was found for ([\w.-]+)")
_KINDS = (
    ("memory", r"memoryerror|unable to allocate|bad_alloc|out of memory"),
    ("disk_full", r"no space left on device|errno 28\]|enospc|not enough space on the disk"
                  r"|winerror 112\]|disk quota exceeded"),
    ("packages", r"no module named|no package metadata was found|could not import the official"
                 r" overturemaps client|dll load failed"),
    ("permission", r"permissionerror|permission denied|access is denied|read-only file system"),
    ("server", r"http (error )?5\d\d|slowdown|service unavailable|internal server error|bad gateway"
               r"|gateway time-?out|too many requests|http (error )?429"),
    ("network", r"getaddrinfo|name or service not known|nodename nor servname|name resolution"
                r"|resolve host|failed to resolve|network is unreachable|no route to host"
                r"|connection (refused|reset|aborted)|remotedisconnected|connectionerror"
                r"|connecttimeout|timed out|timeout was reached|network_connection|curlcode"
                r"|\bssl|certificate|\bproxy|tunnel connection failed|urlopen error|unable to connect"
                r"|connection attempt failed|winerror 100\d\d|errno 1100[1-4]|http error 407"),
)
_PYTHON = r"syntaxerror|invalid syntax|future feature|not a valid win32 application|exec format error"


def parse_progress(line: str) -> Optional[Tuple[str, Optional[float]]]:
    """Read one helper progress line: its text and the finished fraction.

    Helpers write ``progress: <text>`` lines to stderr. An ``(i/n)`` counter
    in the text means item *i* of *n* is in progress.
    """
    if not line.startswith(PROGRESS_PREFIX):
        return None
    text = line[len(PROGRESS_PREFIX):].strip()
    if not text:
        return None
    fraction = None
    match = _COUNTER.search(text)
    if match:
        index, total = int(match.group(1)), int(match.group(2))
        if 1 <= index <= total:
            fraction = (index - 1) / total
    return text, fraction


def _exit_text(code: int) -> str:
    if code < 0:
        return f"signal {-code}"
    if code >= 0x80000000:
        return f"exit code 0x{code:08X}"
    return f"exit code {code}"


def classify_failure(text: str, *, stage: str = "overture", returncode: Optional[int] = None,
                     result: bool = True, timed_out: bool = False,
                     timeout_s: float = 0.0) -> Tuple[str, str]:
    """Name the likely cause of a failed download step and the remedy.

    ``result`` is False when the helper printed no result line, i.e. it
    crashed or was stopped. Returns ``(kind, message)``; an unrecognised
    failure is ``("unknown", "")`` and callers show the raw detail instead.
    """
    name = STAGE_NAMES.get(stage, "data")
    server = SERVER_NAMES.get(stage, "download servers")
    if timed_out:
        minutes = max(1, int(round(timeout_s / 60.0)))
        return "timeout", (f"The {name} download timed out after {minutes} "
                           f"minute{'s' if minutes != 1 else ''}; select a smaller area or try again")
    text = text or ""
    lowered = text.lower()
    if not result and re.search(_PYTHON, lowered):
        return "python", ("The Overture Python cannot run the downloader (needs Python 3.10+); "
                          "run the downloader setup again")
    for kind, pattern in _KINDS:
        if not re.search(pattern, lowered):
            continue
        if kind == "memory":
            return kind, "The downloader ran out of memory; select a smaller area"
        if kind == "disk_full":
            return kind, ("Not enough disk space; free space or choose another Cache Directory "
                          "in Setup and Cache")
        if kind == "packages":
            module = _MODULE.search(text)
            name = module and (module.group(1) or module.group(2))
            missing = name.split(".")[0] if name else "required packages"
            return kind, f"The downloader Python is missing {missing}; run the downloader setup again"
        if kind == "permission":
            return kind, ("Cannot write to the cache folder; choose another Cache Directory "
                          "in Setup and Cache")
        if kind == "server":
            return kind, f"The {server} returned an error; try again later"
        return kind, f"Could not reach the {server}; check internet, VPN, firewall or proxy"
    if not result and returncode:
        if returncode == -9:
            return "killed", ("The downloader was stopped by the system (signal 9), usually for "
                              "lack of memory; select a smaller area")
        return "killed", f"The downloader stopped unexpectedly ({_exit_text(returncode)}); try again"
    return "unknown", ""


def failure_text(kind: str, message: str, detail: str, stage: str) -> str:
    """The status text for a failure: the remedy, then a short raw detail."""
    detail = _short(detail)
    if not message:
        prefix = "Elevation download failed: " if stage == "dem" else ""
        return prefix + (detail or "unknown error")
    return f"{message} ({detail})" if detail else message


def _short(detail: str, limit: int = 160) -> str:
    lines = [line.strip() for line in (detail or "").splitlines() if line.strip()]
    text = lines[-1] if lines else ""
    return text if len(text) <= limit else text[: limit - 3] + "..."


def using_cache_message(manifest: Dict[str, Any], required: Iterable[str]) -> str:
    counts = manifest.get("feature_counts", {})
    return "Using cache: " + ", ".join(f"{counts.get(item, '?')} {item}" for item in required)


def cached_message(manifest: Dict[str, Any], required: Iterable[str], has_dem: bool) -> str:
    counts = manifest.get("feature_counts", {})
    parts = [f"{counts.get(item, 0)} {item}" for item in required]
    if has_dem:
        dem = manifest.get("dem", {}) or {}
        parts.append(
            f"DEM {dem.get('columns', '?')}x{dem.get('rows', '?')} "
            f"({float(dem.get('min_m') or 0):.0f}-{float(dem.get('max_m') or 0):.0f} m)"
        )
    return f"Cached release {manifest.get('release', 'unknown')}: " + ", ".join(parts)


def cancelled_message(completed: Iterable[str]) -> str:
    completed = list(completed)
    if not completed:
        return "Download cancelled; cache unchanged"
    return f"Download cancelled; {', '.join(completed)} cached"


def rotate_logs(directory: Path, keep: int = KEEP_LOGS) -> None:
    """Delete all but the newest *keep* download logs."""
    try:
        logs = sorted(Path(directory).glob(LOG_PATTERN),
                      key=lambda path: (path.stat().st_mtime, path.name))
    except OSError:
        return
    for path in logs[: max(0, len(logs) - keep)]:
        try:
            path.unlink()
        except OSError:
            pass


def remove_stale_folders(cache_root: Path, age_s: float = STALE_FOLDER_S) -> None:
    """Remove private download folders left behind when Blender was killed."""
    cutoff = time.time() - age_s
    try:
        folders = [path for path in Path(cache_root).glob(FOLDER_PREFIX + "*") if path.is_dir()]
    except OSError:
        return
    for path in folders:
        try:
            if path.stat().st_mtime < cutoff:
                shutil.rmtree(path, ignore_errors=True)
        except OSError:
            pass


def terminate_tree(process: subprocess.Popen, force: bool = False) -> None:
    """Stop a helper and every process it started."""
    if process.poll() is not None:
        return
    if os.name == "nt":
        # A virtual environment's python.exe is a launcher with the real
        # interpreter as its child; stopping the launcher alone leaves it.
        try:
            result = subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                                    capture_output=True, timeout=10, creationflags=_NO_WINDOW)
        except FileNotFoundError:
            process.kill()
            return
        if result.returncode and process.poll() is None:
            raise OSError(f"taskkill exited with code {result.returncode}")
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
        except ProcessLookupError:
            pass


def commit_overture(bundle: CacheBundle, directory: Path, feature_types: Iterable[str],
                    payload: Dict[str, Any]) -> Dict[str, Any]:
    """Move downloaded layers into the bundle and merge their provenance."""
    feature_types = tuple(feature_types)
    for feature_type in feature_types:
        if not (directory / f"{feature_type}.geojson").is_file():
            raise OvertureDownloadError(f"Downloader did not create {feature_type}.geojson")
    bundle.ensure_directory()
    for feature_type in feature_types:
        os.replace(str(directory / f"{feature_type}.geojson"), str(bundle.data_path(feature_type)))
    return bundle.merge_manifest({
        "source": "Overture Maps",
        "client": "overturemaps",
        "client_version": payload.get("client_version"),
        "release": payload.get("release"),
        "downloaded_at_utc": datetime.now(timezone.utc).isoformat(),
        "feature_counts": payload.get("counts", {}),
        "observed_fields": payload.get("fields", {}),
        "feature_types": list(feature_types),
    })


def commit_dem(bundle: CacheBundle, directory: Path, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Move a downloaded elevation grid into the bundle and record it."""
    names = ("terrain.f32", "terrain.json")
    if not all((directory / name).is_file() for name in names):
        raise OvertureDownloadError("Elevation downloader did not write a terrain grid")
    bundle.ensure_directory()
    for name in names:
        os.replace(str(directory / name), str(bundle.path / name))
    if not bundle.has_dem():
        raise OvertureDownloadError("Elevation downloader did not write a terrain grid")
    return bundle.merge_manifest({
        "dem": {
            key: payload.get(key)
            for key in ("source", "zoom", "columns", "rows", "min_m", "max_m", "tiles_used",
                        "tiles_missing", "ground_resolution_m", "vertical_datum")
        },
        "dem_downloaded_at_utc": datetime.now(timezone.utc).isoformat(),
    })


def _utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _child_environment() -> Dict[str, str]:
    environment = dict(os.environ)
    environment["PYTHONIOENCODING"] = "utf-8"
    environment["PYTHONUNBUFFERED"] = "1"
    return environment


def _process_options() -> Dict[str, Any]:
    if os.name == "nt":
        return {"creationflags": _NO_WINDOW}
    # A new session makes the helper a process group that stops as a whole.
    return {"start_new_session": True}


def _read_text(path: Path) -> str:
    try:
        with path.open("rb") as handle:
            size = handle.seek(0, os.SEEK_END)
            handle.seek(max(0, size - LOG_OUTPUT_LIMIT))
            text = handle.read().decode("utf-8", errors="replace")
    except OSError:
        return ""
    return text.replace("\r\n", "\n")


def _stderr_tail(stderr: str, count: int = 20) -> str:
    lines = [line for line in stderr.splitlines()
             if line.strip() and not line.startswith(PROGRESS_PREFIX)]
    return "\n".join(lines[-count:])


class _Step:
    """One helper run with its private output folder and captured streams."""

    def __init__(self, name: str, command: List[str], output: Path, timeout: float) -> None:
        self.name = name
        self.label = STAGE_LABELS[name]
        self.command = command
        self.output = output
        self.timeout = float(timeout)
        self.stdout_path = output.parent / f"{name}.stdout"
        self.stderr_path = output.parent / f"{name}.stderr"
        self.process: Optional[subprocess.Popen] = None
        self.started = 0.0
        self.offset = 0
        self.partial = b""


class DownloadJob:
    """Run the Overture and elevation helpers one after another.

    Each helper writes into a private folder inside the cache root and a
    step is committed only after its helper succeeds, so cancellation or
    failure leaves the cached files as they were. A step committed before a
    later one fails stays cached. Call poll() until it returns False, or
    run() to block. Each job writes ``<cache root>/logs/download-*.log``.
    """

    def __init__(self, python_path, bundle: CacheBundle, feature_types: Iterable[str] = (),
                 dem_columns: Optional[int] = None, dem_spacing_m: float = 25.0,
                 overture_timeout: float = OVERTURE_TIMEOUT_S, dem_timeout: float = DEM_TIMEOUT_S,
                 parent_pid: Optional[int] = None) -> None:
        self.python_path = Path(python_path)
        self.bundle = bundle
        self.feature_types = tuple(feature_types)
        self.dem_columns = dem_columns
        self.dem_spacing_m = float(dem_spacing_m)
        self.overture_timeout = float(overture_timeout)
        self.dem_timeout = float(dem_timeout)
        self.parent_pid = os.getpid() if parent_pid is None else parent_pid
        self.state = "pending"
        self.manifest: Optional[Dict[str, Any]] = None
        self.kind = ""
        self.error = ""
        self.completed: List[str] = []
        self.message = "Starting the downloader"
        self.directory: Optional[Path] = None
        self.log_path: Optional[Path] = None
        self.started = self.finished = None
        self._steps: List[_Step] = []
        self._index = -1
        self._step: Optional[_Step] = None
        self._fraction = 0.0
        self._outcome = ""
        self._cancel = False
        self._timed_out = False
        self._stop_first = self._stop_last = None
        self._cleanup_deadline = None
        self._registered = False

    @property
    def done(self) -> bool:
        return self.state in FINISHED

    @property
    def elapsed(self) -> float:
        if self.started is None:
            return 0.0
        return (self.finished or time.monotonic()) - self.started

    # ------------------------------------------------------------ lifecycle
    def start(self) -> None:
        """Launch the first helper. Failures are recorded, never raised."""
        if self.state != "pending":
            return
        self.state = "running"
        self.started = time.monotonic()
        self._open_log()
        try:
            ensure_writable(self.bundle.cache_root)
            remove_stale_folders(self.bundle.cache_root)
            self.directory = Path(tempfile.mkdtemp(prefix=FOLDER_PREFIX,
                                                   dir=str(self.bundle.cache_root)))
        except OSError as exc:
            kind, message = classify_failure(str(exc), stage=self._first_stage())
            self._fail(kind, message, str(exc), self._first_stage())
            self._complete()
            return
        atexit.register(self._atexit)
        self._registered = True
        self._steps = self._plan()
        self._next_step()
        if self._step is None:
            self.poll()

    def poll(self) -> bool:
        """Advance without blocking; True while the job is still working."""
        if self.state == "pending":
            self.start()
        if self.done:
            return False
        step = self._step
        if step is not None:
            self._read_progress(step)
            code = step.process.poll()
            if code is None:
                if (not self._cancel and not self._timed_out
                        and time.monotonic() - step.started > step.timeout):
                    self._timed_out = True
                    self.message = "Stopping the timed-out download"
                    self._log(f"Timed out after {step.timeout:.0f} s")
                if self._cancel or self._timed_out:
                    self.state = "stopping"
                    self._stop(step)
                return True
            self._step = None
            self._finish_step(step, code)
            if self._step is not None:
                return True
        return self._clean()

    def cancel(self) -> None:
        """Ask the helper to stop; poll() then waits for it and cleans up."""
        if self.done or self._cancel:
            return
        self._cancel = True
        self.message = "Stopping the downloader"
        self._log("Cancel requested")
        if self.state == "pending":
            self._outcome = "cancelled"
            self.started = time.monotonic()
            self._complete()
        elif self._step is not None:
            self.state = "stopping"
            self._stop(self._step)

    def wait(self, timeout: float) -> bool:
        """Poll until finished or *timeout* seconds pass; True when finished."""
        deadline = time.monotonic() + timeout
        while self.poll():
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.05)
        return True

    def abort(self, timeout: float = 10.0) -> bool:
        self.cancel()
        return self.wait(timeout)

    def run(self) -> Dict[str, Any]:
        """Block until finished; return the merged manifest or raise."""
        try:
            while self.poll():
                time.sleep(POLL_SECONDS)
        except BaseException:
            self.abort()
            raise
        if self.state != "succeeded":
            raise OvertureDownloadError(self.error or cancelled_message(self.completed))
        return self.manifest if self.manifest is not None else self.bundle.read_manifest()

    def status(self) -> Dict[str, Any]:
        count = max(1, len(self._steps))
        index = min(max(self._index, 0), count - 1)
        label = self._steps[index].label if self._steps else ""
        fraction = 1.0 if self.state == "succeeded" else min(1.0, (index + self._fraction) / count)
        return {"state": self.state, "stage": label, "stage_index": index + 1,
                "stage_count": count, "message": self.message, "fraction": fraction,
                "elapsed": self.elapsed}

    # -------------------------------------------------------------- steps
    def _first_stage(self) -> str:
        return "overture" if self.feature_types or self.dem_columns is None else "dem"

    def _plan(self) -> List[_Step]:
        python = str(self.python_path)
        bbox = [f"{value:.8f}" for value in self.bundle.bounds.as_tuple()]
        owner = ["--parent-pid", str(self.parent_pid)] if self.parent_pid else []
        steps = []
        if self.feature_types:
            output = self.directory / "overture"
            steps.append(_Step("overture", [
                python, str(_external_script("download_overture.py")), "--bbox", *bbox,
                "--output-dir", str(output), "--types", *self.feature_types, *owner,
            ], output, self.overture_timeout))
        if self.dem_columns is not None:
            output = self.directory / "dem"
            steps.append(_Step("dem", [
                python, str(_external_script("download_dem.py")), "--bbox", *bbox,
                "--output-dir", str(output), "--columns", str(int(self.dem_columns)),
                "--target-spacing-m", f"{self.dem_spacing_m:.4f}", *owner,
            ], output, self.dem_timeout))
        return steps

    def _next_step(self) -> None:
        self._index += 1
        self._fraction = 0.0
        if self._index >= len(self._steps):
            self._outcome = "succeeded"
            return
        step = self._steps[self._index]
        self.message = "Starting the downloader"
        self._log(f"\n== {step.label} ==\nCommand: {subprocess.list2cmdline(step.command)}\n"
                  f"Started {_utc()}")
        try:
            with step.stdout_path.open("wb") as output, step.stderr_path.open("wb") as errors:
                step.process = subprocess.Popen(step.command, stdin=subprocess.DEVNULL,
                                                stdout=output, stderr=errors,
                                                env=_child_environment(), **_process_options())
        except OSError as exc:
            self._fail("launch", f"Cannot start the Overture Python {self.python_path}: {exc}",
                       "", step.name)
            return
        step.started = time.monotonic()
        self._step = step

    def _read_progress(self, step: _Step) -> None:
        try:
            with step.stderr_path.open("rb") as handle:
                handle.seek(step.offset)
                data = handle.read(LOG_OUTPUT_LIMIT)
        except OSError:
            return
        if not data:
            return
        step.offset += len(data)
        lines = (step.partial + data).split(b"\n")
        step.partial = lines.pop()[-4096:]
        for raw in lines:
            parsed = parse_progress(raw.decode("utf-8", errors="replace").rstrip("\r"))
            if parsed is None:
                continue
            if not self._cancel and not self._timed_out:
                self.message = parsed[0]
            if parsed[1] is not None:
                self._fraction = parsed[1]

    def _finish_step(self, step: _Step, code: int) -> None:
        self._read_progress(step)
        stdout, stderr = _read_text(step.stdout_path), _read_text(step.stderr_path)
        self._log(f"Exit code {code} after {time.monotonic() - step.started:.1f} s\n"
                  f"-- stdout --\n{stdout.rstrip()}\n-- stderr --\n{stderr.rstrip()}")
        if self._cancel:
            self._outcome = "cancelled"
            return
        if self._timed_out:
            kind, message = classify_failure("", stage=step.name, timed_out=True,
                                             timeout_s=step.timeout)
            self._fail(kind, message, "", step.name)
            return
        try:
            payload = last_json_line(stdout)
        except OvertureDownloadError:
            payload = None
        if payload is None or code or not payload.get("ok"):
            if payload is not None:
                detail = str(payload.get("detail") or payload.get("error") or "")
                text = f"{payload.get('error', '')}\n{payload.get('detail', '')}"
            else:
                detail = text = _stderr_tail(stderr)
            kind, message = classify_failure(text, stage=step.name, returncode=code,
                                             result=payload is not None)
            if not detail and not message:
                detail = f"Downloader returned no result ({_exit_text(code)})"
            self._fail(kind, message, detail, step.name)
            return
        try:
            if step.name == "overture":
                self.manifest = commit_overture(self.bundle, step.output, self.feature_types, payload)
            else:
                self.manifest = commit_dem(self.bundle, step.output, payload)
        except (OSError, OvertureDownloadError) as exc:
            kind, message = classify_failure(str(exc), stage=step.name)
            self._fail(kind, message, str(exc), step.name)
            return
        self.completed.append(step.label)
        self._log(f"Cached {step.label} in {self.bundle.path}")
        self._next_step()

    def _stop(self, step: _Step) -> None:
        now = time.monotonic()
        if self._stop_last is not None and now - self._stop_last < 1.0:
            return
        if self._stop_first is None:
            self._stop_first = now
        force = now - self._stop_first >= STOP_GRACE_S
        self._stop_last = now
        try:
            terminate_tree(step.process, force=force)
        except (OSError, subprocess.SubprocessError) as exc:
            # Keep polling: the job stays owned until the helper has exited.
            self._log(f"Stop attempt failed: {exc}")

    def _clean(self) -> bool:
        if self.state != "cleaning":
            self.state = "cleaning"
            self._cleanup_deadline = time.monotonic() + CLEANUP_RETRY_S
        if self.directory is not None and self.directory.exists():
            shutil.rmtree(self.directory, ignore_errors=True)
            if self.directory.exists():
                if time.monotonic() < self._cleanup_deadline:
                    return True
                self._log(f"Could not remove {self.directory}")
        self._complete()
        return False

    def _fail(self, kind: str, message: str, detail: str, stage: str) -> None:
        self.kind = kind
        self.error = failure_text(kind, message, detail, stage)
        self._outcome = "failed"

    def _complete(self) -> None:
        self.state = self._outcome or "failed"
        self.finished = time.monotonic()
        if self.state == "succeeded":
            self.message = "Download complete"
            self._log(f"\nResult: succeeded after {self.elapsed:.1f} s")
        elif self.state == "cancelled":
            self._log(f"\nResult: cancelled after {self.elapsed:.1f} s; "
                      f"cached: {', '.join(self.completed) or 'nothing'}")
        else:
            self._log(f"\nResult: failed ({self.kind}) after {self.elapsed:.1f} s: {self.error}")
        if self._registered:
            atexit.unregister(self._atexit)
            self._registered = False

    def _atexit(self) -> None:
        """Blender is exiting: stop the helpers and remove private files."""
        try:
            self.abort(5.0)
        except Exception:
            pass

    # ---------------------------------------------------------------- log
    def _open_log(self) -> None:
        directory = self.bundle.cache_root / LOG_DIRECTORY
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        try:
            directory.mkdir(parents=True, exist_ok=True)
            for attempt in range(1, 100):
                suffix = "" if attempt == 1 else f"-{attempt}"
                path = directory / f"download-{stamp}{suffix}.log"
                try:
                    with path.open("x", encoding="utf-8") as handle:
                        handle.write(
                            "Jarvizar City Model download\n"
                            f"Started {_utc()}\n"
                            f"Area (W,S,E,N): {self.bundle.bounds.canonical()}\n"
                            f"Bundle: {self.bundle.path}\n"
                            f"Python: {self.python_path}\n"
                            f"Overture types: {', '.join(self.feature_types) or 'none'}\n"
                            f"Elevation columns: {self.dem_columns or 'none'}\n")
                except FileExistsError:
                    continue
                self.log_path = path
                break
            rotate_logs(directory)
        except OSError:
            self.log_path = None

    def _log(self, text: str) -> None:
        if self.log_path is None:
            return
        try:
            with self.log_path.open("a", encoding="utf-8", errors="replace") as handle:
                handle.write(text.rstrip("\n") + "\n")
        except OSError:
            pass
