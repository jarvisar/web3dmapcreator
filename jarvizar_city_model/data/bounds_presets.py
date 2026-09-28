"""Named bounding boxes for the sidebar's Presets menu (stdlib, no ``bpy``).

Built-in presets ship with the add-on. Areas the user saves ("My Areas") go to
a file of the same format outside the add-on folder, which updates replace.
"""

from __future__ import annotations

import os
from pathlib import Path

from .projection import format_degrees, parse_bounds_text

PRESETS_PATH = Path(__file__).with_name("bounds_presets.txt")
USER_PRESETS_NAME = "bounds_presets.txt"
USER_PRESETS_HEADER = (
    "# My Areas for the Jarvizar City Model Presets menu.\n"
    "# One per line: Name: west,south,east,north in WGS84 decimal degrees.\n"
)
NAME_LIMIT = 60


def parse_presets(text: str) -> list[tuple[str, str]]:
    """Read ``Name: west,south,east,north`` lines into (name, bounds text) pairs.

    The bounds text is what ``jarvizar.paste_bounds`` accepts.  Blank lines,
    ``#`` comments, lines that are not a legal box and repeated names (compared
    without case) are skipped: one bad line must not empty the whole menu.
    Sorted by name, because the file grows in the order places were tried.
    """
    presets = {}
    for line in text.splitlines():
        name, separator, coordinates = line.partition(":")
        name = name.strip()
        if not separator or not name or name.startswith("#"):
            continue
        try:
            bounds_text = normalized_bounds(coordinates)
        except ValueError:
            continue
        presets.setdefault(name.casefold(), (name, bounds_text))
    return sorted(presets.values(), key=lambda preset: preset[0].casefold())


def load_presets(path: Path = PRESETS_PATH) -> list[tuple[str, str]]:
    try:
        return parse_presets(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        return []


def normalized_bounds(text: str) -> str:
    """``west,south,east,north`` as the fields store it; raises ValueError."""
    bounds = parse_bounds_text(text)
    return ",".join(format_degrees(value)
                    for value in (bounds.west, bounds.south, bounds.east, bounds.north))


def clean_name(name: str) -> str:
    """A name the file format can hold: one line, no ``:``, not a comment."""
    text = " ".join(str(name).replace(":", " - ").split()).lstrip("#").strip()
    text = text[:NAME_LIMIT].rstrip()
    if not text:
        raise ValueError("Enter a name for the area")
    return text


def unique_name(name: str, taken) -> str:
    """``name``, or ``name 2``, ``name 3``... if a preset already uses it."""
    used = {existing.casefold() for existing in taken}
    if name.casefold() not in used:
        return name
    number = 2
    while f"{name} {number}".casefold() in used:
        number += 1
    return f"{name} {number}"


def _line_name(line: str) -> str | None:
    name, separator, _ = line.partition(":")
    name = name.strip()
    if not separator or not name or name.startswith("#"):
        return None
    return name


def _write(path: Path, lines: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text("".join(f"{line}\n" for line in lines), encoding="utf-8")
    os.replace(temporary, path)


def _read_lines(path: Path) -> list[str] | None:
    try:
        return Path(path).read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return None


def save_preset(path: Path, name: str, bounds_text: str) -> bool:
    """Add or replace one preset, keeping every other line. True if replaced."""
    name = clean_name(name)
    line = f"{name}: {normalized_bounds(bounds_text)}"
    lines = _read_lines(path)
    if lines is None:
        lines = USER_PRESETS_HEADER.splitlines()
    kept = [existing for existing in lines
            if (_line_name(existing) or "").casefold() != name.casefold()]
    _write(Path(path), [*kept, line])
    return len(kept) != len(lines)


def remove_preset(path: Path, name: str) -> bool:
    """Remove a preset by name, ignoring case. False if it was not there."""
    lines = _read_lines(path)
    if lines is None:
        return False
    target = str(name).strip().casefold()
    kept = [line for line in lines if (_line_name(line) or "").casefold() != target]
    if len(kept) == len(lines):
        return False
    _write(Path(path), kept)
    return True
