"""Plain-text support report for Copy Support Info.

The Blender operator gathers the values; everything here is pure formatting
and file inspection, with no bpy dependency. Paths inside the user's home
folder are written as ``~`` so a report can be pasted into a public post.
"""

from __future__ import annotations

import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Tuple

from .environment import FAIL, INFO, OK, ValidationResult

TITLE = "Jarvizar City Model support information"
REPORT_FOLDER = "support"
LOG_LIMIT = 5
COUNTS_LIMIT = 6000
TEXT_LIMIT = 2000

Section = Tuple[str, List[str]]


def format_value(value) -> str:
    if isinstance(value, bool):
        return "on" if value else "off"
    if isinstance(value, float):
        return f"{value:.6g}"
    if isinstance(value, (set, frozenset)):
        value = sorted(value, key=str)
    if isinstance(value, (tuple, list)):
        return ", ".join(format_value(item) for item in value) or "(none)"
    text = str(value)
    return text if text.strip() else "(blank)"


def values_differ(value, default) -> bool:
    if isinstance(value, float) or isinstance(default, float):
        try:
            return abs(float(value) - float(default)) > 1e-6 * max(1.0, abs(float(default)))
        except (TypeError, ValueError):
            return value != default
    return value != default


def setting_changes(settings: Iterable[Tuple[str, object, object]]) -> List[str]:
    """``name: value (default x)`` for each (name, value, default) that differs."""
    return [f"{name}: {format_value(value)} (default {format_value(default)})"
            for name, value, default in settings if values_differ(value, default)]


def truncate(text: str, limit: int) -> str:
    text = str(text)
    if len(text) <= limit:
        return text
    return f"{text[:limit]} ... ({len(text) - limit} more characters)"


def size_text(size: float) -> str:
    for unit in ("bytes", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "bytes" else f"{size:.1f} {unit}"
        size /= 1024.0
    return f"{size:.1f} GB"


def _writable(folder: Path) -> bool:
    try:
        with tempfile.NamedTemporaryFile(dir=str(folder), prefix=".jcm-write-test-"):
            return True
    except OSError:
        return False


def cache_lines(path) -> List[str]:
    """Where the cache is, whether it exists and is writable, and free space."""
    if not str(path or "").strip():
        return ["Folder: (blank)"]
    folder = Path(path)
    lines = [f"Folder: {folder}"]
    existing = folder
    while not existing.exists() and existing.parent != existing:
        existing = existing.parent
    if not folder.exists():
        lines.append("Exists: no (created by the first download)")
    elif not folder.is_dir():
        lines.append("Exists: yes, but it is not a folder")
    else:
        lines.append(f"Exists: yes; writable: {'yes' if _writable(folder) else 'no'}")
    try:
        lines.append(f"Free space: {size_text(shutil.disk_usage(str(existing)).free)}")
    except OSError as exc:
        lines.append(f"Free space: unknown ({exc})")
    return lines


def manifest_lines(manifest) -> List[str]:
    """Release, client, feature counts and elevation grid of a cache bundle."""
    if not isinstance(manifest, dict) or not manifest:
        return ["No manifest"]
    lines = []
    for key, label in (("release", "Overture release"), ("client_version", "Client"),
                       ("downloaded_at_utc", "Downloaded")):
        if manifest.get(key):
            lines.append(f"{label}: {manifest[key]}")
    counts = manifest.get("feature_counts")
    if isinstance(counts, dict) and counts:
        lines.append("Features: " + ", ".join(f"{name} {counts[name]}" for name in sorted(counts)))
    dem = manifest.get("dem")
    if isinstance(dem, dict) and dem:
        parts = []
        if dem.get("columns") and dem.get("rows"):
            parts.append(f"{dem['columns']}x{dem['rows']}")
        low, high = dem.get("min_m"), dem.get("max_m")
        if isinstance(low, (int, float)) and isinstance(high, (int, float)):
            parts.append(f"{low:.0f} to {high:.0f} m")
        if dem.get("zoom") is not None:
            parts.append(f"zoom {dem['zoom']}")
        if dem.get("tiles_missing"):
            parts.append(f"{dem['tiles_missing']} tiles missing")
        if dem.get("source"):
            parts.append(str(dem["source"]))
        lines.append("Elevation: " + (", ".join(parts) or "present"))
    if manifest.get("dem_downloaded_at_utc"):
        lines.append(f"Elevation downloaded: {manifest['dem_downloaded_at_utc']}")
    lidar = manifest.get("lidar")
    if isinstance(lidar, dict):
        lines.append(f"LiDAR prepared: {lidar.get('buildings', '?')} buildings")
    return lines or ["Manifest has no download details"]


def bundle_file_lines(folder) -> List[str]:
    folder = Path(folder)
    if not folder.is_dir():
        return ["Not downloaded yet"]
    lines = []
    for path in sorted(folder.iterdir(), key=lambda item: item.name):
        if path.is_file() and path.suffix in {".geojson", ".json", ".f32"}:
            lines.append(f"{path.name} ({size_text(path.stat().st_size)})")
    return lines or ["No data files"]


def recent_logs(cache_root, limit: int = LOG_LIMIT) -> List[str]:
    """The newest ``logs/*.log`` files of the cache, newest first."""
    folder = Path(cache_root) / "logs"
    if not str(cache_root or "").strip() or not folder.is_dir():
        return ["No logs folder"]
    entries = []
    for path in folder.glob("*.log"):
        try:
            stat = path.stat()
        except OSError:
            continue
        entries.append((stat.st_mtime, path.name, stat.st_size))
    entries.sort(reverse=True)
    lines = [f"{name} ({size_text(size)}, {datetime.fromtimestamp(mtime):%Y-%m-%d %H:%M})"
             for mtime, name, size in entries[:limit]]
    if len(entries) > limit:
        lines.append(f"{len(entries) - limit} older logs not listed")
    return lines or ["No logs"]


def validation_lines(result: Optional[ValidationResult]) -> List[str]:
    if result is None:
        return ["Not checked"]
    marks = {OK: "[ok]", FAIL: "[failed]", INFO: "[note]"}
    lines = [f"{marks[state]} {text}" for text, state in result.checklist()]
    if result.executable:
        lines.append(f"Runs: {result.executable}")
    for module in ([result.downloader] if result.downloader else []) + result.lidar:
        detail = module.version or "no version"
        if not module.ok:
            detail += f"; {truncate(module.error or 'does not import', 300)}"
        lines.append(f"{module.name}: {detail}")
    if result.timed_out:
        lines.append("The check timed out")
    return lines


def home_notes(home=None) -> str:
    """Whether the home path has spaces or non-ASCII characters, both of
    which some tools mishandle; the report hides the path itself."""
    home = str(home or Path.home())
    notes = []
    if " " in home:
        notes.append("contains spaces")
    if not home.isascii():
        notes.append("contains non-ASCII characters")
    return "Home folder: " + ("; ".join(notes) if notes else "ASCII, no spaces")


def redact_home(text: str, home=None, ignore_case: Optional[bool] = None) -> str:
    home = str(home or Path.home()).rstrip("\\/")
    if len(home) < 4:
        return text
    if ignore_case is None:
        ignore_case = os.name == "nt"
    flags = re.IGNORECASE if ignore_case else 0
    for variant in sorted({home, home.replace("\\", "/")}, key=len, reverse=True):
        text = re.sub(re.escape(variant) + r"(?=[\\/\s'\"),;]|$)", "~", text, flags=flags)
    return text


def build_report(sections: Sequence[Section], created: Optional[datetime] = None,
                 home=None, ignore_case: Optional[bool] = None) -> str:
    created = created or datetime.now(timezone.utc)
    lines = [TITLE, f"Created: {created:%Y-%m-%d %H:%M:%S} UTC", ""]
    for title, body in sections:
        lines.append(f"[{title}]")
        lines.extend(body or ["(none)"])
        lines.append("")
    return redact_home("\n".join(lines).rstrip() + "\n", home, ignore_case)


def save_report(cache_root, text: str, created: Optional[datetime] = None) -> Path:
    """Write the report to ``<cache>/support/support-<UTC time>.txt``."""
    created = created or datetime.now(timezone.utc)
    path = Path(cache_root) / REPORT_FOLDER / f"support-{created:%Y%m%d-%H%M%S}.txt"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path
