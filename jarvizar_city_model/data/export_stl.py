"""Binary STL export for slicers other than Bambu Studio (no bpy; numpy ships with Blender).

A binary STL is an 80-byte header, a little-endian uint32 triangle count and
50 bytes per triangle: its normal and three vertices as float32 and a zero
uint16 attribute. Triangles are written as they arrive and the count is
filled in when a file is closed, so memory is bounded by the largest part.

``StlSet`` writes one export: a file per colour, or one combined file, for
each section. The files of a section share one coordinate frame, so a slicer
importing them together as one multipart object keeps them aligned.
"""

from collections import Counter, defaultdict
from dataclasses import dataclass
import os
from pathlib import Path
import re
import shutil
import struct
import tempfile

import numpy as np


HEADER = "Jarvizar City Model - (c) OpenStreetMap contributors, Overture Maps Foundation"
_SIGNATURE = HEADER.split(" - ")[0].encode("ascii")
MAX_TRIANGLES = 0xFFFFFFFF
_RECORD = np.dtype([("normal", "<f4", (3,)), ("vertices", "<f4", (3, 3)), ("attribute", "<u2")])
_CHUNK = 65536
_COLOUR = re.compile(r"^#[0-9A-F]{6}$")
_INVALID_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def header_bytes(text=HEADER):
    """The 80-byte header: ASCII, NUL padded, never starting with "solid"."""
    data = text.encode("ascii")
    if len(data) > 80:
        raise ValueError("An STL header holds at most 80 bytes")
    if data[:5].lower() == b"solid":
        raise ValueError('A binary STL header must not start with "solid"')
    return data.ljust(80, b"\0")


def mesh_arrays(vertices, triangles):
    """Validated float64 (N, 3) points and int64 (M, 3) vertex indices."""
    points = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    faces = np.asarray(triangles, dtype=np.int64).reshape(-1, 3)
    if not np.isfinite(points).all():
        raise ValueError("Nonfinite mesh coordinates")
    if len(faces) and (faces.min() < 0 or faces.max() >= len(points)):
        raise ValueError("A triangle references a missing vertex")
    return points, faces


class StlWriter:
    """One binary STL, streamed; ``close`` writes the triangle count."""

    def __init__(self, path, header=HEADER):
        self.path = Path(path)
        self.triangles = 0
        prefix = header_bytes(header) + struct.pack("<I", 0)
        self._file = open(self.path, "wb")
        try:
            self._file.write(prefix)
        except BaseException:
            self._file.close()
            raise

    def __enter__(self):
        return self

    def __exit__(self, kind, value, traceback):
        if kind is None:
            self.close()
        else:
            self.discard()
        return False

    def add(self, points, faces):
        """Append triangles, rows of three indices into (x, y, z) *points*."""
        points, faces = mesh_arrays(points, faces)
        if self.triangles + len(faces) > MAX_TRIANGLES:
            raise ValueError("A binary STL holds at most 4,294,967,295 triangles")
        for start in range(0, len(faces), _CHUNK):
            corners = points[faces[start:start + _CHUNK]]
            normals = np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0])
            lengths = np.linalg.norm(normals, axis=1)[:, None]
            # Zero-area triangles get a zero normal; slicers recompute it.
            normals = np.divide(normals, lengths, out=np.zeros_like(normals), where=lengths > 0)
            records = np.zeros(len(corners), dtype=_RECORD)
            records["normal"] = normals
            records["vertices"] = corners
            self._file.write(records.tobytes())
        self.triangles += len(faces)

    def close(self):
        if self._file.closed:
            return
        self._file.seek(80)
        self._file.write(struct.pack("<I", self.triangles))
        self._file.close()

    def discard(self):
        """Close without finishing; the caller removes the file."""
        self._file.close()


def shell_groups(triangles, groups, vertex_count):
    """Give each connected shell the group of most of its triangles.

    A solid split between files would leave each file an open surface. Ties
    keep the lowest group. Returns (per-triangle groups, number of shells
    that mixed groups).
    """
    faces = np.asarray(triangles, dtype=np.int64).reshape(-1, 3)
    groups = np.asarray(groups, dtype=np.int64).reshape(-1)
    if not len(faces):
        return groups, 0
    # Union-find by hooking roots to the smallest root of each triangle,
    # then full path compression, until every triangle has one root.
    parent = np.arange(vertex_count, dtype=np.int64)
    a, b, c = faces.T
    while True:
        roots = parent[a], parent[b], parent[c]
        lowest = np.minimum(np.minimum(roots[0], roots[1]), roots[2])
        changed = False
        for root in roots:
            higher = lowest < root
            if higher.any():
                np.minimum.at(parent, root[higher], lowest[higher])
                changed = True
        while True:
            grandparent = parent[parent]
            if np.array_equal(grandparent, parent):
                break
            parent = grandparent
        if not changed:
            break
    shells = parent[a]
    width = int(groups.max()) + 1
    keys, counts = np.unique(shells * width + groups, return_counts=True)
    key_shells, key_groups = keys // width, keys % width
    order = np.lexsort((key_groups, -counts, key_shells))
    first = np.ones(len(order), dtype=bool)
    first[1:] = key_shells[order][1:] != key_shells[order][:-1]
    winners = order[first]
    shell_ids = key_shells[winners]
    assigned = key_groups[winners][np.searchsorted(shell_ids, shells)]
    mixed = int(np.count_nonzero(np.bincount(np.searchsorted(shell_ids, key_shells)) > 1))
    return assigned, mixed


def slug(label):
    """A file-name fragment: lowercase letters, digits and hyphens."""
    text = re.sub(r"[^a-z0-9]+", "-", str(label).lower()).strip("-")[:24].strip("-")
    return text or "part"


@dataclass(frozen=True)
class StlFile:
    path: Path          # the staged file
    name: str           # its published name
    section: object     # e.g. "R1C1", or None for a single section
    colour: object      # "#RRGGBB", or None for a combined file
    triangles: int


class StlSet:
    """The STL files of one export, staged in *folder*.

    Colours are numbered in order of first use across every section, so a
    colour has the same number in each section's file names:
    ``<base>[_R1C1]_<number>_<label>_<RRGGBB>.stl``, or ``<base>[_R1C1].stl``
    combined. A label is the part or material name with most triangles of
    that colour.
    """

    def __init__(self, folder, base, *, combined=False, header=HEADER):
        if not base or base != base.strip() or _INVALID_NAME.search(base):
            raise ValueError("Choose a valid file name")
        header_bytes(header)
        self.folder = Path(folder)
        self.base = base
        self.combined = combined
        self.header = header
        self.palette = []
        self.parts = 0
        self.triangles = 0
        self.mixed_shells = 0
        self._numbers = {}
        self._labels = defaultdict(Counter)
        self._sections = []
        self._writers = {}
        self._finished = []

    def _number(self, colour):
        if colour not in self._numbers:
            self._numbers[colour] = len(self.palette)
            self.palette.append(colour)
        return self._numbers[colour]

    def add_part(self, vertices, triangles, materials, colors, labels=(), *, section=None,
                 origin=(0.0, 0.0, 0.0)):
        """Write one part, its coordinates relative to *origin*.

        ``materials`` has one index per triangle into ``colors``, which are
        "#RRGGBB" strings or (colour, filament line) pairs; ``labels`` names
        each of those materials for the file names.
        """
        points, faces = mesh_arrays(vertices, triangles)
        materials = np.asarray(materials, dtype=np.int64).reshape(-1)
        if len(materials) != len(faces):
            raise ValueError("One material index per triangle is required")
        colours = [colour if isinstance(colour, str) else colour[0] for colour in colors]
        if not colours:
            raise ValueError("A part needs at least one material colour")
        for colour in colours:
            if not isinstance(colour, str) or not _COLOUR.match(colour):
                raise ValueError(f"Colours must be #RRGGBB: {colour!r}")
        if not len(faces):
            return
        if materials.min() < 0 or materials.max() >= len(colours):
            raise ValueError("Material index without a colour")
        labels = [str(label) for label in labels][:len(colours)]
        labels += [""] * (len(colours) - len(labels))
        # Distinct colours of this part in slot order; numbered once written.
        distinct = list(dict.fromkeys(colours))
        local = np.array([distinct.index(colour) for colour in colours], dtype=np.int64)
        groups = local[materials]
        if not self.combined and len(np.unique(groups)) > 1:
            groups, mixed = shell_groups(faces, groups, len(points))
            self.mixed_shells += mixed
        numbers = np.zeros(len(distinct), dtype=np.int64)
        for group in np.unique(groups).tolist():
            numbers[group] = self._number(distinct[group])
        groups = numbers[groups]
        keys, counts = np.unique(groups * len(colours) + materials, return_counts=True)
        for key, count in zip(keys.tolist(), counts.tolist()):
            label = labels[key % len(colours)]
            if label:
                self._labels[key // len(colours)][label] += count
        if section not in self._sections:
            self._sections.append(section)
        relative = points - np.asarray(origin, dtype=np.float64)
        for group in np.unique(groups).tolist():
            key = (section, None if self.combined else group)
            writer = self._writers.get(key)
            if writer is None:
                writer = self._writers[key] = StlWriter(
                    self.folder / f"{len(self._writers) + len(self._finished)}.stl", self.header)
            writer.add(relative, faces[groups == group])
        self.parts += 1
        self.triangles += len(faces)

    def close_section(self, section=None):
        """Finish the files of *section*; later parts of it start new files."""
        for key in [key for key in self._writers if key[0] == section]:
            writer = self._writers.pop(key)
            writer.close()
            self._finished.append((key, writer))

    def close(self):
        """Finish every file; return them as StlFile records in name order."""
        for section in list(dict.fromkeys(key[0] for key in self._writers)):
            self.close_section(section)
        digits = len(str(len(self.palette)))
        files = []
        for (section, group), writer in self._finished:
            stem = self.base if section is None else f"{self.base}_{section}"
            if group is None:
                name, colour = f"{stem}.stl", None
            else:
                colour = self.palette[group]
                label = self._labels[group].most_common(1)[0][0] if self._labels[group] else ""
                name = f"{stem}_{group + 1:0{digits}d}_{slug(label)}_{colour[1:]}.stl"
            files.append((self._sections.index(section), -1 if group is None else group,
                          StlFile(writer.path, name, section, colour, writer.triangles)))
        return [record for _, _, record in sorted(files, key=lambda item: item[:2])]

    def discard(self):
        """Close every open file without finishing it."""
        for writer in self._writers.values():
            writer.discard()
        self._writers.clear()


def previous_files(folder, base):
    """Files in *folder* from an earlier STL export named *base*: our names and header."""
    pattern = re.compile(rf"{re.escape(base)}(?:_R\d+C\d+)?(?:_\d+_[a-z0-9-]+_[0-9A-F]{{6}})?\.stl",
                         re.IGNORECASE)
    found = []
    for entry in os.scandir(folder):
        if entry.is_file() and pattern.fullmatch(entry.name):
            try:
                with open(entry.path, "rb") as handle:
                    if handle.read(len(_SIGNATURE)) == _SIGNATURE:
                        found.append(Path(entry.path))
            except OSError:
                continue
    return found


def publish(files, folder, base):
    """Move staged files into *folder* as one set; return how many earlier files were removed.

    Files of the same names are replaced, and files of an earlier export
    named *base* that this one does not replace are removed, so the folder
    never mixes two exports. On failure every file is put back as it was.
    """
    folder = Path(folder)
    names = {record.name.casefold() for record in files}
    replaced = [folder / record.name for record in files if (folder / record.name).exists()]
    stale = [path for path in previous_files(folder, base) if path.name.casefold() not in names]
    backup = Path(tempfile.mkdtemp(prefix=".jcm-stl-previous-", dir=folder))
    moved, placed = [], []
    try:
        for index, path in enumerate(replaced + stale):
            kept = backup / f"{index}.stl"
            os.replace(path, kept)
            moved.append((kept, path))
        for record in files:
            os.replace(record.path, folder / record.name)
            placed.append(folder / record.name)
    except BaseException:
        restored = True
        for record, path in zip(files, placed):
            try:
                os.replace(path, record.path)
            except OSError:
                restored = False
        for kept, path in reversed(moved):
            try:
                os.replace(kept, path)
            except OSError:
                restored = False
        if restored:
            shutil.rmtree(backup, ignore_errors=True)
        else:
            raise OSError(f"Could not restore earlier files; they are in {backup}")
        raise
    shutil.rmtree(backup, ignore_errors=True)
    return len(stale)
