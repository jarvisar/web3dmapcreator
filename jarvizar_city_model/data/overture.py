"""Out-of-process adapter for the official Overture Maps Python client."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Iterable

from . import environment
from .cache import BUILDING_TYPES, CacheBundle


class OvertureDownloadError(RuntimeError):
    pass


def _external_script(name: str) -> Path:
    """Path of a script in the add-on's ``external`` directory."""
    return Path(__file__).resolve().parent.parent / "external" / name


def resolve_python(configured_path: str, fallback_path: str = "") -> Path:
    """Resolve the downloader interpreter from scene, preference, then env.

    A scene may override the interpreter, but almost never wants to: where the
    downloader lives is a property of the machine.  The add-on preference is
    therefore the normal source, and the environment variable stays as the
    headless and CI route.  With none of them set, the environment the
    packaged setup script creates is used if it exists.
    """
    value = environment.interpreter_path(
        configured_path.strip()
        or fallback_path.strip()
        or os.environ.get("JARVIZAR_OVERTURE_PYTHON", "").strip()
    )
    if not value:
        default = environment.default_venv_python()
        if default.is_file():
            return default
        raise OvertureDownloadError(
            "The downloader is not set up. Click Set Up Downloader in the City "
            "Model sidebar (Setup and Cache), or set 'Overture Python' in "
            "Preferences > Add-ons > Jarvizar City Model."
        )
    path = Path(value).expanduser()
    if not path.is_file():
        raise OvertureDownloadError(
            f"Overture Python does not exist: {path}. Click Set Up Downloader "
            "in Setup and Cache to find or reinstall it."
        )
    return path


def last_json_line(stdout: str) -> Dict[str, Any]:
    for line in reversed(stdout.splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise OvertureDownloadError("Downloader returned no machine-readable result")


def download_to_cache(
    python_path: Path,
    bundle: CacheBundle,
    feature_types: Iterable[str] = BUILDING_TYPES,
) -> Dict[str, Any]:
    """Download Overture types and replace them in the bundle only on success.

    Blocks until the helper exits. Interactive Blender polls a
    :class:`~.download_job.DownloadJob` instead.
    """
    from .download_job import DownloadJob

    return DownloadJob(python_path, bundle, tuple(feature_types)).run()


def download_dem_to_cache(
    python_path: Path,
    bundle: CacheBundle,
    columns: int = 256,
    target_spacing_m: float = 25.0,
    timeout: int = 900,
) -> Dict[str, Any]:
    """Download and cache an elevation grid covering the bundle's bounds.

    The DEM helper depends only on the standard library, but it is still run
    out of process so that Blender never performs the network request or the
    PNG decode on its own interpreter.
    """
    from .download_job import DownloadJob

    return DownloadJob(python_path, bundle, (), dem_columns=columns,
                       dem_spacing_m=target_spacing_m, dem_timeout=timeout).run()
