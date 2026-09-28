"""Find and check the external Python that downloads map data.

Downloads run in a separate environment created by the scripts in the
add-on's ``setup`` folder; the add-on itself never installs packages. This
module lists the places that interpreter can be configured or installed and
checks one by running it in a subprocess. It has no bpy dependency.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence, Tuple


PACKAGE_DIR = Path(__file__).resolve().parents[1]
SETUP_DIR = PACKAGE_DIR / "setup"
PROBE_SCRIPT = PACKAGE_DIR / "external" / "probe_downloader.py"
PYTHON_DOWNLOAD_URL = "https://www.python.org/downloads/"

MINIMUM_PYTHON = (3, 10)
# Seconds; importing pyarrow for the first time can take a while.
PROBE_TIMEOUT = 30.0
PROBE_MARKER = "JARVIZAR_PROBE "
# (import name, distribution name). The downloader imports overturemaps.core.
DOWNLOADER_MODULE = ("overturemaps.core", "overturemaps")
LIDAR_MODULES = (
    ("laspy", "laspy"),
    ("lazrs", "lazrs"),
    ("pyproj", "pyproj"),
    ("shapely", "shapely"),
    ("shapefile", "pyshp"),
)

# Candidate sources, in resolve_python's order, then detection-only ones.
SCENE = "Scene override"
PREFERENCE = "Add-on preference"
ENVIRONMENT = "Environment variable"
DEFAULT = "Default location"
DEVELOPER = "Repository .venv-overture"

# Checklist states.
OK, FAIL, INFO = "ok", "fail", "info"

_PYTHON_NAME = re.compile(r"^python(\d+(\.\d+)*)?(\.exe|\.bat|\.cmd)?$", re.IGNORECASE)
_PIN = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*==\s*([^\s;]+)")
_INCLUDE = re.compile(r"^(?:-r|--requirement)(?:\s+|=)(\S+)$")


def _is_windows(platform: Optional[str]) -> bool:
    return (platform or sys.platform).startswith("win")


def _key(path: str) -> str:
    return os.path.normcase(os.path.abspath(os.path.expanduser(str(path))))


# ------------------------------------------------------------------ locations
def default_venv_dir(platform=None, environ=None, home=None) -> Path:
    """Per-user folder the packaged setup scripts create the environment in.

    It is outside the add-on folder, which Blender replaces on every update.
    """
    platform = platform or sys.platform
    environ = os.environ if environ is None else environ
    home = Path(home) if home is not None else Path.home()
    if platform.startswith("win"):
        base = environ.get("LOCALAPPDATA") or str(home / "AppData" / "Local")
        return Path(base) / "JarvizarCityModel" / "downloader-venv"
    if platform == "darwin":
        return home / "Library" / "Application Support" / "JarvizarCityModel" / "downloader-venv"
    base = environ.get("XDG_DATA_HOME") or str(home / ".local" / "share")
    return Path(base) / "jarvizar-city-model" / "downloader-venv"


def venv_python(venv_dir, platform=None) -> Path:
    parts = ("Scripts", "python.exe") if _is_windows(platform) else ("bin", "python")
    return Path(venv_dir).joinpath(*parts)


def default_venv_python(platform=None, environ=None, home=None) -> Path:
    return venv_python(default_venv_dir(platform, environ, home), platform)


def developer_venv_python(package_dir=PACKAGE_DIR, platform=None) -> Path:
    """``.venv-overture`` beside the package, as in a repository checkout."""
    return venv_python(Path(package_dir).parent / ".venv-overture", platform)


def interpreter_path(text) -> str:
    """A configured interpreter as a file path.

    Removes surrounding whitespace and quotes (Explorer's Copy as path adds
    quotes) and resolves a virtual environment folder to its python.
    """
    value = str(text or "").strip().strip("\"'").strip()
    if not value:
        return ""
    path = Path(value).expanduser()
    if path.is_dir():
        for parts in (("Scripts", "python.exe"), ("bin", "python3"), ("bin", "python")):
            inner = path.joinpath(*parts)
            if inner.is_file():
                return str(inner)
    return value


@dataclass(frozen=True)
class Candidate:
    path: str
    source: str


def candidates(scene_path="", preference_path="", environ=None, platform=None,
               home=None, package_dir=PACKAGE_DIR) -> List[Candidate]:
    """Interpreter paths in priority order, blanks and duplicates removed.

    Scene override, preference and environment variable are what
    ``resolve_python`` uses; the default location is its fallback. The
    repository venv is only offered by Detect.
    """
    environ = os.environ if environ is None else environ
    entries = (
        (SCENE, scene_path),
        (PREFERENCE, preference_path),
        (ENVIRONMENT, environ.get("JARVIZAR_OVERTURE_PYTHON", "")),
        (DEFAULT, str(default_venv_python(platform, environ, home))),
        (DEVELOPER, str(developer_venv_python(package_dir, platform))),
    )
    found, seen = [], set()
    for source, value in entries:
        value = interpreter_path(value)
        if not value or _key(value) in seen:
            continue
        seen.add(_key(value))
        found.append(Candidate(value, source))
    return found


def effective_candidate(found: Sequence[Candidate]) -> Optional[Candidate]:
    """The interpreter downloads will use, following ``resolve_python``."""
    for candidate in found:
        if candidate.source in (SCENE, PREFERENCE, ENVIRONMENT):
            return candidate
    for candidate in found:
        if candidate.source == DEFAULT and Path(candidate.path).is_file():
            return candidate
    return None


# -------------------------------------------------------------- setup files
def pinned_versions(path=None) -> Dict[str, str]:
    """Exact ``name==version`` pins of a requirements file and its includes."""
    pins: Dict[str, str] = {}
    _read_pins(Path(path) if path else SETUP_DIR / "requirements-downloader.txt", pins, set())
    return pins


def _read_pins(path: Path, pins: Dict[str, str], seen: set) -> None:
    key = _key(path)
    if key in seen:
        return
    seen.add(key)
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        line = line.split(" #", 1)[0].strip()
        if not line or line.startswith("#"):
            continue
        include = _INCLUDE.match(line)
        if include:
            _read_pins(path.parent / include.group(1), pins, seen)
            continue
        pin = _PIN.match(line)
        if pin:
            pins[re.sub(r"[-_.]+", "-", pin.group(1)).lower()] = pin.group(3)


def setup_script(platform=None, setup_dir=SETUP_DIR) -> Path:
    name = "setup_downloader.ps1" if _is_windows(platform) else "setup_downloader.sh"
    return Path(setup_dir) / name


def setup_command(with_lidar=False, platform=None, setup_dir=SETUP_DIR) -> str:
    """One line to paste into a terminal that runs the packaged setup script.

    Windows runs it through ``powershell -ExecutionPolicy Bypass`` because the
    default policy refuses script files. Double quotes work in both
    PowerShell and cmd. The shell script is started with ``sh`` because zip
    extraction does not keep its executable bit.
    """
    script = setup_script(platform, setup_dir)
    if _is_windows(platform):
        command = f'powershell -NoProfile -ExecutionPolicy Bypass -File "{script}"'
        return command + (" -WithLidar" if with_lidar else "")
    return f"sh {shlex.quote(str(script))}" + (" --with-lidar" if with_lidar else "")


# ------------------------------------------------------------ path checks
def is_windows_store_alias(path) -> bool:
    """Whether a path is a Microsoft Store app alias; the "python" alias
    without an installed Store Python only opens the Store."""
    return "windowsapps" in (part.lower() for part in Path(str(path)).parts)


def is_blender_binary(path) -> bool:
    name = Path(str(path)).name.lower()
    if name.endswith(".exe"):
        name = name[:-4]
    return name in {"blender", "blender-launcher", "blender-thumbnailer"}


def _blender_python_home(directory) -> bool:
    """Whether a folder is ``<version>/python`` inside a Blender installation."""
    directory = Path(str(directory))
    version = directory.parent
    return (directory.name.lower() == "python"
            and re.fullmatch(r"\d+\.\d+", version.name) is not None
            and (version / "scripts").is_dir())


def is_blender_python(path) -> bool:
    """Whether a path is Blender, or the Python bundled inside Blender."""
    path = Path(str(path))
    return is_blender_binary(path) or any(
        _blender_python_home(parent) for parent in list(path.parents)[:3])


def looks_like_python(path) -> bool:
    return _PYTHON_NAME.match(Path(str(path)).name) is not None


def _same_file(first, second) -> bool:
    try:
        return os.path.samefile(str(first), str(second))
    except OSError:
        return _key(first) == _key(second)


# ---------------------------------------------------------------- validation
@dataclass
class ModuleStatus:
    name: str
    ok: bool = False
    version: str = ""
    error: str = ""


@dataclass
class ValidationResult:
    path: str
    exists: bool = False
    blender_python: bool = False
    store_stub: bool = False
    ran: bool = False
    timed_out: bool = False
    python_version: Tuple[int, ...] = ()
    executable: str = ""
    downloader: Optional[ModuleStatus] = None
    lidar: List[ModuleStatus] = field(default_factory=list)
    expected_version: str = ""
    error: str = ""
    note: str = ""
    checked_at: float = 0.0

    @property
    def version_text(self) -> str:
        return ".".join(str(part) for part in self.python_version)

    @property
    def version_ok(self) -> bool:
        return tuple(self.python_version[:2]) >= MINIMUM_PYTHON

    @property
    def ok(self) -> bool:
        return bool(self.exists and not self.blender_python and not self.store_stub
                    and self.ran and self.version_ok
                    and self.downloader is not None and self.downloader.ok)

    @property
    def lidar_ok(self) -> bool:
        return len(self.lidar) == len(LIDAR_MODULES) and all(item.ok for item in self.lidar)

    @property
    def missing_lidar(self) -> List[str]:
        checked = {item.name for item in self.lidar if item.ok}
        return [name for _, name in LIDAR_MODULES if name not in checked]

    def summary(self) -> str:
        if not self.ok:
            return self.error or "Not working"
        text = f"Working: {self.downloader.name} {self.downloader.version or '(version unknown)'}"
        return text + ("; LiDAR packages installed" if self.lidar_ok else "")

    def checklist(self) -> List[Tuple[str, str]]:
        """(text, state) rows up to the first failure."""
        if not self.exists:
            return [(self.error or "Interpreter not found", FAIL)]
        rows = [("Interpreter found", OK)]
        if self.blender_python:
            return rows + [(self.error, FAIL)]
        rows.append(("Not Blender's own Python", OK))
        if self.store_stub or not self.ran:
            return rows + [(self.error or "Python did not run", FAIL)]
        if not self.version_ok:
            return rows + [(f"Python {self.version_text}: 3.10 or newer is needed", FAIL)]
        rows.append((f"Python {self.version_text}", OK))
        if self.downloader is None or not self.downloader.ok:
            return rows + [(self.error or "overturemaps is not installed", FAIL)]
        name, version = self.downloader.name, self.downloader.version
        if self.expected_version and version and version != self.expected_version:
            rows.append((f"{name} {version}; setup installs {self.expected_version}", INFO))
        else:
            rows.append((f"{name} {version or '(version unknown)'}", OK))
        if self.lidar_ok:
            rows.append(("LiDAR packages installed", OK))
        else:
            rows.append(("Optional LiDAR packages missing: " + ", ".join(self.missing_lidar), INFO))
        if self.note:
            rows.append((self.note, INFO))
        return rows


def _text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def _kill_tree(process) -> None:
    # A Windows venv python.exe is a launcher with a separate real Python
    # child, which keeps the output pipes open after the launcher dies.
    if os.name == "nt":
        try:
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except (OSError, subprocess.SubprocessError):
            pass
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except OSError:
            pass
    try:
        process.kill()
    except OSError:
        pass


def run_command(command, timeout) -> Tuple[Optional[int], str, str, bool]:
    """Run without a console window; return (code, stdout, stderr, timed_out).

    On timeout the whole process tree is killed and the output so far kept.
    """
    options = {"stdin": subprocess.DEVNULL, "stdout": subprocess.PIPE, "stderr": subprocess.PIPE}
    if os.name == "nt":
        options["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    else:
        options["start_new_session"] = True
    process = subprocess.Popen([str(part) for part in command], **options)
    try:
        stdout, stderr = process.communicate(timeout=timeout)
        return process.returncode, _text(stdout), _text(stderr), False
    except subprocess.TimeoutExpired:
        _kill_tree(process)
        try:
            stdout, stderr = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            stdout = stderr = ""
        return process.returncode, _text(stdout), _text(stderr), True


def parse_probe(stdout: str) -> List[dict]:
    records = []
    for line in stdout.splitlines():
        if not line.startswith(PROBE_MARKER):
            continue
        try:
            value = json.loads(line[len(PROBE_MARKER):])
        except ValueError:
            continue
        if isinstance(value, dict):
            records.append(value)
    return records


def _tail(text: str, limit: int = 300) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else "..." + text[-limit:]


def validate_interpreter(path, timeout=None, runner=None, blender_paths=(),
                         required=DOWNLOADER_MODULE, optional=LIDAR_MODULES,
                         expected_version=None) -> ValidationResult:
    """Check that ``path`` is a separate Python 3.10+ that imports the downloader.

    ``runner(command, timeout)`` returns ``(code, stdout, stderr, timed_out)``;
    tests replace it. ``blender_paths`` are Blender's own executables, which
    are rejected without being run.
    """
    timeout = PROBE_TIMEOUT if timeout is None else timeout
    text = interpreter_path(path)
    result = ValidationResult(path=text, checked_at=time.time())
    result.expected_version = (pinned_versions().get(required[1], "")
                               if expected_version is None else expected_version)
    candidate = Path(text).expanduser() if text else None
    if candidate is None or not candidate.is_file():
        result.error = f"Interpreter not found: {text}" if text else "No interpreter set"
        return result
    result.exists = True
    if is_blender_binary(candidate):
        result.blender_python = True
        result.error = "This is Blender itself; choose the downloader's python executable"
        return result
    if is_blender_python(candidate) or any(_same_file(candidate, other)
                                           for other in blender_paths if other):
        result.blender_python = True
        result.error = "This is Blender's own Python; use the downloader environment"
        return result
    if not looks_like_python(candidate):
        result.error = (f"{candidate.name} prints no output; use python.exe"
                        if candidate.name.lower().startswith("pythonw")
                        else f"Not a Python executable: {candidate.name}")
        return result

    specs = [f"{module}={distribution}" for module, distribution in (required, *optional)]
    try:
        code, stdout, stderr, timed_out = (runner or run_command)(
            [str(candidate), str(PROBE_SCRIPT), *specs], timeout)
    except OSError as exc:
        result.store_stub = is_windows_store_alias(candidate)
        result.error = _store_error() if result.store_stub else f"Could not run: {exc}"
        return result
    result.timed_out = timed_out
    records = parse_probe(stdout)
    base = next((record for record in records if "python" in record), None)
    if base is None:
        if is_windows_store_alias(candidate) and not timed_out:
            result.store_stub = True
            result.error = _store_error()
        elif timed_out:
            result.error = f"No response within {timeout:g} s"
        else:
            detail = _tail(stderr) or _tail(stdout)
            result.error = f"Python did not run (exit code {code})" + (f": {detail}" if detail else "")
        return result

    result.ran = True
    try:
        result.python_version = tuple(int(part) for part in base["python"][:3])
    except (TypeError, ValueError):
        result.python_version = ()
    result.executable = str(base.get("executable") or "")
    if _blender_python_home(base.get("prefix") or ""):
        result.blender_python = True
        result.error = "This is Blender's own Python; use the downloader environment"
        return result
    if not result.version_ok:
        result.error = f"Python {result.version_text or '(unknown)'} is too old; 3.10 or newer is needed"
        return result

    modules = {record.get("module"): record for record in records if "module" in record}

    def status(module, distribution):
        record = modules.get(module)
        if record is None:
            return None
        return ModuleStatus(distribution, bool(record.get("ok")),
                            str(record.get("version") or ""), str(record.get("error") or ""))

    def stopped(distribution):
        return (f"No response within {timeout:g} s while importing {distribution}" if timed_out
                else f"Python stopped while importing {distribution} (exit code {code})")

    result.downloader = status(*required)
    result.lidar = [item for item in (status(*module) for module in optional) if item is not None]
    if result.downloader is None:
        result.error = stopped(required[1])
    elif not result.downloader.ok:
        name = required[1]
        missing = "ModuleNotFoundError" in result.downloader.error and not result.downloader.version
        result.error = (f"{name} is not installed in this environment" if missing
                        else f"{name} does not import: {_tail(result.downloader.error, 200)}")
    elif not any(record.get("done") for record in records):
        pending = next((name for module, name in optional if module not in modules), "")
        if pending:
            result.note = f"LiDAR check incomplete. {stopped(pending)}"
    return result


def _store_error() -> str:
    return "This is the Microsoft Store placeholder, not Python; install Python from python.org"


# ---------------------------------------------------------- results cache
# Results by path for this Blender session, so drawing never runs Python.
_RESULTS: Dict[str, ValidationResult] = {}


def remember(result: ValidationResult) -> ValidationResult:
    if result.path:
        _RESULTS[_key(result.path)] = result
    return result


def cached_result(path) -> Optional[ValidationResult]:
    return _RESULTS.get(_key(path)) if path and str(path).strip() else None


def forget(path=None) -> None:
    if path is None:
        _RESULTS.clear()
    else:
        _RESULTS.pop(_key(path), None)


def detect(found: Sequence[Candidate], validate: Callable[[str], ValidationResult]):
    """Find a working interpreter to store in the add-on preference.

    A working preference is kept. Otherwise the first working candidate in
    priority order is chosen, so a valid scene override is promoted as
    downloads already do. The scene override is always checked because it
    takes precedence for its scene. Returns ``(chosen, [(candidate, result)])``.
    """
    results: Dict[str, ValidationResult] = {}

    def check(candidate):
        if candidate.path not in results:
            results[candidate.path] = validate(candidate.path)
        return results[candidate.path]

    by_source = {candidate.source: candidate for candidate in found}
    if SCENE in by_source:
        check(by_source[SCENE])
    chosen = None
    for source in (PREFERENCE, SCENE, ENVIRONMENT, DEFAULT, DEVELOPER):
        candidate = by_source.get(source)
        if candidate is not None and check(candidate).ok:
            chosen = candidate
            break
    return chosen, [(candidate, results[candidate.path]) for candidate in found
                    if candidate.path in results]


# ------------------------------------------------------------ system Python
def _registry_pythons() -> List[Tuple[str, Tuple[int, int]]]:
    """Interpreters registered under PEP 514 (python.org, Store, others)."""
    import winreg

    found = []
    views = (getattr(winreg, "KEY_WOW64_64KEY", 0), getattr(winreg, "KEY_WOW64_32KEY", 0))
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in views:
            try:
                root = winreg.OpenKey(hive, r"Software\Python", 0, winreg.KEY_READ | view)
            except OSError:
                continue
            for company in _subkeys(winreg, root):
                if company == "PyLauncher":
                    continue
                try:
                    company_key = winreg.OpenKey(root, company)
                except OSError:
                    continue
                for tag in _subkeys(winreg, company_key):
                    version = re.match(r"(\d+)\.(\d+)", tag)
                    try:
                        install = winreg.OpenKey(company_key, tag + r"\InstallPath")
                    except OSError:
                        continue
                    try:
                        executable = winreg.QueryValueEx(install, "ExecutablePath")[0]
                    except OSError:
                        try:
                            executable = os.path.join(winreg.QueryValue(install, None), "python.exe")
                        except OSError:
                            continue
                    if version and executable and os.path.isfile(executable):
                        found.append((executable, (int(version.group(1)), int(version.group(2)))))
    return found


def _subkeys(winreg, key) -> List[str]:
    names, index = [], 0
    while True:
        try:
            names.append(winreg.EnumKey(key, index))
        except OSError:
            return names
        index += 1


def _probe_version(executable, runner) -> Optional[Tuple[int, int]]:
    try:
        code, stdout, _, _ = runner(
            [executable, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"], 10)
    except OSError:
        return None
    match = re.search(r"(\d+)\.(\d+)", stdout) if code == 0 else None
    return (int(match.group(1)), int(match.group(2))) if match else None


def find_system_pythons(platform=None, which=shutil.which, registry=None, runner=None,
                        environ=None) -> List[Tuple[str, Optional[Tuple[int, int]]]]:
    """Installed interpreters the setup script could build the environment from.

    Versions come from the registry or the file name where possible, so
    usually nothing is run. Store aliases are skipped: without a Store
    Python they only open the Store.
    """
    platform = platform or sys.platform
    environ = os.environ if environ is None else environ
    runner = runner or run_command
    found: List[Tuple[str, Optional[Tuple[int, int]]]] = []
    if platform.startswith("win"):
        try:
            registered = (registry or _registry_pythons)()
        except (ImportError, OSError):
            registered = []
        known = set()
        for path, version in registered:
            if _key(path) not in known:
                known.add(_key(path))
                found.append((path, version))
        for name in ("python", "python3"):
            path = which(name)
            if path and _key(path) not in known and not is_windows_store_alias(path):
                known.add(_key(path))
                found.append((path, _probe_version(path, runner)))
        return found
    extra = ["/opt/homebrew/bin", "/usr/local/bin",
             "/Library/Frameworks/Python.framework/Versions/Current/bin"]
    search = os.pathsep.join([environ.get("PATH", "")] + extra)
    seen = set()
    for minor in range(20, MINIMUM_PYTHON[1] - 1, -1):
        path = which(f"python3.{minor}", path=search)
        if path and _key(path) not in seen:
            seen.add(_key(path))
            found.append((path, (3, minor)))
    if not found:
        path = which("python3", path=search)
        # Running Apple's python3 without the Xcode tools opens an install
        # dialog, so it is not probed.
        if path and not (platform == "darwin" and path == "/usr/bin/python3"):
            found.append((path, _probe_version(path, runner)))
    return found


def has_usable_python(found) -> bool:
    return any(version is not None and version >= MINIMUM_PYTHON for _, version in found)
