"""Checks for folders the user chooses (no bpy)."""

from __future__ import annotations

import os
from pathlib import Path


def ensure_writable(folder, create=True) -> Path:
    """Prove a directory can be made in *folder*, creating the folder if *create*.

    On Windows, tempfile.mkdtemp retries a refused folder up to TMP_MAX times
    (two billion in Python 3.10 and 3.11) while os.access still reports it
    writable, which froze Blender in folders such as Program Files. One direct
    attempt fails at once instead. Exports pass ``create=False``: a missing
    destination folder is an error there, not something to make.
    """
    folder = Path(folder)
    if not create and not folder.is_dir():
        raise FileNotFoundError(f"Folder not found: {folder}")
    probe = folder / f".jcm-write-test-{os.getpid()}"
    try:
        folder.mkdir(parents=True, exist_ok=True)
        if probe.exists():
            probe.rmdir()
        probe.mkdir()
        probe.rmdir()
    except OSError as exc:
        raise OSError(f"Cannot write to {folder}. Choose another folder.") from exc
    return folder
