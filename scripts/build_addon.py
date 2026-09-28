"""Build classic and Blender 4.2+ extension ZIPs from one source package."""

from __future__ import annotations

from pathlib import Path
import time
import zipfile


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = PROJECT_ROOT / "jarvizar_city_model"
DIST_ROOT = PROJECT_ROOT / "dist"
# Setup scripts run on other systems whatever the checkout's line endings:
# sh fails on CRLF and cmd.exe expects it. Values are (line ending, mode).
SCRIPT_FORMATS = {".sh": (b"\n", 0o755), ".cmd": (b"\r\n", 0o644)}


def read_version() -> str:
    """Take the version from the extension manifest, the single source.

    It used to be a constant here, which silently rebuilt the previous
    release's zip under its own name after a version bump and destroyed the
    rollback copy.
    """
    manifest = (PACKAGE_ROOT / "blender_manifest.toml").read_text(encoding="utf-8")
    for line in manifest.splitlines():
        if line.startswith("version"):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("No version in blender_manifest.toml")


def source_files():
    for path in sorted(PACKAGE_ROOT.rglob("*")):
        if not path.is_file():
            continue
        if "__pycache__" in path.parts or path.suffix in {".pyc", ".pyo"}:
            continue
        yield path


def write_archive(path: Path, extension_layout: bool) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for source in source_files():
            relative = source.relative_to(PACKAGE_ROOT)
            archive_name = relative if extension_layout else Path(PACKAGE_ROOT.name) / relative
            script_format = SCRIPT_FORMATS.get(source.suffix)
            if script_format is None:
                archive.write(source, archive_name.as_posix())
                continue
            ending, mode = script_format
            data = source.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", ending)
            info = zipfile.ZipInfo(archive_name.as_posix(), time.localtime(source.stat().st_mtime)[:6])
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o100000 | mode) << 16
            archive.writestr(info, data)
        # The GPL requires the license text to travel with every copy.
        license_name = "LICENSE" if extension_layout else f"{PACKAGE_ROOT.name}/LICENSE"
        archive.write(PROJECT_ROOT / "LICENSE", license_name)


def main() -> None:
    if not (PACKAGE_ROOT / "__init__.py").is_file():
        raise SystemExit(f"Missing add-on package: {PACKAGE_ROOT}")
    DIST_ROOT.mkdir(parents=True, exist_ok=True)
    version = read_version()
    classic = DIST_ROOT / f"jarvizar_city_model-{version}-blender36.zip"
    extension = DIST_ROOT / f"jarvizar_city_model-{version}-extension.zip"
    write_archive(classic, extension_layout=False)
    write_archive(extension, extension_layout=True)
    print(classic)
    print(extension)


if __name__ == "__main__":
    main()

