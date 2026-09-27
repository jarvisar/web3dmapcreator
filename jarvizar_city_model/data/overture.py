"""Out-of-process adapter for the official Overture Maps Python client."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable

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
    headless and CI route.
    """
    value = (
        configured_path.strip()
        or fallback_path.strip()
        or os.environ.get("JARVIZAR_OVERTURE_PYTHON", "")
    )
    if not value:
        raise OvertureDownloadError(
            "Set 'Overture Python' to the separate environment's Python executable, "
            "in Preferences > Add-ons > Jarvizar City Model. "
            "See README.md under Downloader setup."
        )
    path = Path(value).expanduser()
    if not path.is_file():
        raise OvertureDownloadError(f"Overture Python does not exist: {path}")
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


def _run_helper(command, timeout: int, failure: str = "") -> Dict[str, Any]:
    """Run a downloader script and return its final JSON result line."""
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        check=False,
        timeout=timeout,
    )
    payload = last_json_line(result.stdout)
    if result.returncode or not payload.get("ok"):
        detail = payload.get("detail") or result.stderr.strip() or "unknown error"
        raise OvertureDownloadError(f"{failure}{detail}")
    return payload


def download_to_cache(
    python_path: Path,
    bundle: CacheBundle,
    feature_types: Iterable[str] = BUILDING_TYPES,
) -> Dict[str, Any]:
    """Atomically replace a cache bundle after all downloads succeed."""
    feature_types = tuple(feature_types)
    bundle.cache_root.mkdir(parents=True, exist_ok=True)
    helper = _external_script("download_overture.py")
    with tempfile.TemporaryDirectory(
        prefix="jarvizar_download_", dir=str(bundle.cache_root)
    ) as temporary_name:
        temporary = Path(temporary_name)
        command = [
            str(python_path),
            str(helper),
            "--bbox",
            *(f"{value:.8f}" for value in bundle.bounds.as_tuple()),
            "--output-dir",
            str(temporary),
            "--types",
            *feature_types,
        ]
        payload = _run_helper(command, timeout=1800)
        for feature_type in feature_types:
            source = temporary / f"{feature_type}.geojson"
            if not source.is_file():
                raise OvertureDownloadError(
                    f"Downloader did not create {feature_type}.geojson"
                )

        bundle.ensure_directory()
        for feature_type in feature_types:
            os.replace(
                str(temporary / f"{feature_type}.geojson"),
                str(bundle.data_path(feature_type)),
            )
        manifest = {
            "source": "Overture Maps",
            "client": "overturemaps",
            "client_version": payload.get("client_version"),
            "release": payload.get("release"),
            "downloaded_at_utc": datetime.now(timezone.utc).isoformat(),
            "feature_counts": payload.get("counts", {}),
            "observed_fields": payload.get("fields", {}),
            "feature_types": list(feature_types),
        }
        return bundle.merge_manifest(manifest)


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
    bundle.ensure_directory()
    command = [
        str(python_path),
        str(_external_script("download_dem.py")),
        "--bbox",
        *(f"{value:.8f}" for value in bundle.bounds.as_tuple()),
        "--output-dir",
        str(bundle.path),
        "--columns",
        str(int(columns)),
        "--target-spacing-m",
        f"{float(target_spacing_m):.4f}",
    ]
    payload = _run_helper(command, timeout=timeout, failure="Elevation download failed: ")
    if not bundle.has_dem():
        raise OvertureDownloadError("Elevation downloader did not write a terrain grid")
    return bundle.merge_manifest(
        {
            "dem": {
                key: payload.get(key)
                for key in (
                    "source",
                    "zoom",
                    "columns",
                    "rows",
                    "min_m",
                    "max_m",
                    "tiles_used",
                    "tiles_missing",
                    "ground_resolution_m",
                    "vertical_datum",
                )
            },
            "dem_downloaded_at_utc": datetime.now(timezone.utc).isoformat(),
        }
    )
