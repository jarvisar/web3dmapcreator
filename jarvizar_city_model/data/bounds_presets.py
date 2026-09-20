"""Named bounding boxes for the sidebar's Presets menu (stdlib, no ``bpy``)."""

from __future__ import annotations

from pathlib import Path

from .projection import format_degrees, parse_bounds_text

PRESETS_PATH = Path(__file__).with_name("bounds_presets.txt")


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
            bounds = parse_bounds_text(coordinates)
        except ValueError:
            continue
        presets.setdefault(name.casefold(), (name, ",".join(
            format_degrees(value) for value in (bounds.west, bounds.south, bounds.east, bounds.north))))
    return sorted(presets.values(), key=lambda preset: preset[0].casefold())


def load_presets(path: Path = PRESETS_PATH) -> list[tuple[str, str]]:
    try:
        return parse_presets(Path(path).read_text(encoding="utf-8"))
    except OSError:
        return []
